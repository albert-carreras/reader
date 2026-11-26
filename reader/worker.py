"""Background renderer: always renders the next missing audio segment from where you are listening."""
from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import library as lib
from . import timing
from .segment import Unit

log = logging.getLogger("reader.worker")


def _unit(c: dict, i: int) -> Unit:
    d = c["units"][i]
    text = c["blocks"][d["block"]]["text"][d["start"]:d["end"]]
    return Unit(id=d["id"], block=d["block"], start=d["start"], end=d["end"], text=text, spoken=d["spoken"],
                role=d["role"], kind=d["kind"], pause=d["pause"])


LIMITER = "alimiter=limit=0.68:attack=5:release=80:level=disabled"   # peaks <= -3.3 dBFS (audiobook spec: <= -3 dB)


def _encode(wavs: list[Path], dst: Path) -> None:
    """AAC with the peak limiter; several wavs are joined sample-exactly (concat demuxer) before encoding."""
    tmp = dst.with_name(dst.stem + ".tmp.m4a")
    if len(wavs) == 1:
        src = ["-i", str(wavs[0])]
    else:
        lst = dst.with_suffix(".txt")
        lst.write_text("".join(f"file '{w.resolve()}'\n" for w in wavs))
        src = ["-f", "concat", "-safe", "0", "-i", str(lst)]
    subprocess.run(["ffmpeg", "-y", "-v", "error", *src, "-af", LIMITER, "-c:a", "aac", "-b:a", "80k",
                    "-movflags", "+faststart", str(tmp)], check=True)
    os.replace(tmp, dst)
    dst.with_suffix(".txt").unlink(missing_ok=True)


class Worker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True, name="render-worker")
        self.focus: tuple[str, int, int] | None = None     # (book, chapter, unit index)
        self.wake = threading.Event()
        self.status = dict(state="idle", job=None, rate=None, error=None, rendered_secs=0.0)
        self._stats = {}

    # ---------------------------------------------------------------- scheduling
    def set_focus(self, book_id: str, chapter: int, unit: int) -> None:
        self.focus = (book_id, int(chapter), int(unit))
        self.wake.set()

    def _order(self):
        """Books to render, in priority order: the one being listened to first, then the others by recent use.
        Books with rendering switched off are skipped entirely."""
        books = [m for m in lib.list_books() if m.get("render", True)]
        focus = self.focus
        if focus is None:
            p = next((m["position"] for m in books if m.get("position")), None)
            m0 = next((m for m in books if m.get("position")), None)
            focus = (m0["id"], p["chapter"], p["unit"]) if m0 else None
        out = []
        if focus and any(m["id"] == focus[0] for m in books):
            out.append((next(m for m in books if m["id"] == focus[0]), focus[1], focus[2]))
        for m in books:
            if not focus or m["id"] != focus[0]:
                p = m.get("position") or {}
                out.append((m, p.get("chapter", 0), p.get("unit", 0)))
        return out

    def _first_missing(self, m: dict, ch0: int, u0: int):
        order = [c for c in m["chapters"] if c["include"] and c["n_segments"]]
        order = [c for c in order if c["index"] >= ch0] + [c for c in order if c["index"] < ch0]   # ahead first, then wrap
        for c in order:
            if lib.chapter_status(m["id"], c["index"], c["n_segments"]).count(False) == 0:
                continue
            chap = lib.chapter(m["id"], c["index"])
            start_seg = 0
            if c["index"] == ch0:
                start_seg = next((s for s, seg in enumerate(chap["segments"]) if seg["u0"] <= u0 < seg["u1"]), 0)
            for s in list(range(start_seg, len(chap["segments"]))) + list(range(0, start_seg)):
                if not lib.segment_ready(m["id"], c["index"], s):
                    return m, chap, s
        return None

    def next_job(self):
        if lib.settings()["paused"]:
            return None
        for m, ch0, u0 in self._order():
            job = self._first_missing(m, ch0, u0)
            if job:
                return job
        return None

    def queue(self) -> list[dict]:
        """Every book with its rendering state, progress and an ETA at the current speed."""
        rate = self.status.get("rate") or 1.0
        out, ahead = [], 0.0
        order = [m for m, *_ in self._order()]
        rest = [m for m in lib.list_books() if m["id"] not in {o["id"] for o in order}]
        for m in order + rest:
            p = lib.progress(m)
            left = max(0, p["total_est"] - p["ready_est"])
            eta = None
            if m.get("render", True) and left:
                ahead += left / max(rate, 0.1)
                eta = round(ahead)
            out.append(dict(id=m["id"], title=m["title"], lang=m["lang"], render=m.get("render", True),
                            ready=p["ready_est"], total=p["total_est"], eta=eta))
        return out

    # ---------------------------------------------------------------- rendering
    def _apply_threads(self):
        n = lib.settings()["threads"]
        if n != getattr(self, "_threads", None):
            import ptts, torch
            ptts.set_num_threads(n)
            torch.set_num_threads(n)
            self._threads = n
            self.status["threads"] = n

    def run(self):
        threads = int(os.environ.get("READER_THREADS", "4"))
        os.environ.setdefault("READER_THREADS", str(threads))
        try:
            os.nice(int(os.environ.get("READER_NICE", "10")))
        except OSError:
            pass
        import torch
        torch.set_num_threads(threads)
        while True:
            try:
                self._apply_threads()
                job = self.next_job()
                if job is None:
                    self.status.update(state="paused" if lib.settings()["paused"] else "idle", job=None)
                    self.wake.wait(30)
                    self.wake.clear()
                    continue
                self.render_segment(*job)
            except Exception as e:  # keep the worker alive; surface the error in /api/status
                log.error("render failed: %s", traceback.format_exc())
                self.status.update(state="error", error=str(e))
                time.sleep(10)

    def render_segment(self, m: dict, chap: dict, s: int) -> None:
        from .engine import Engine
        from .render import VoiceStats, assemble, render_unit
        seg = chap["segments"][s]
        eng = Engine(m["lang"], m["voice"])
        cache = lib.CACHE / eng.voice
        cache.mkdir(parents=True, exist_ok=True)
        stats = self._stats.setdefault(eng.key, VoiceStats())
        self.status.update(state="rendering", error=None,
                           job=dict(book=m["id"], title=m["title"], chapter=chap["index"], chapter_title=chap["title"],
                                    segment=s, of=len(chap["segments"])))
        units, metas, t0 = [], [], time.time()
        focus_at_start = self.focus
        for i in range(seg["u0"], seg["u1"]):
            u = _unit(chap, i)
            metas.append(render_unit(u, eng, stats, cache))
            units.append(u)
            if lib.settings()["paused"] or not lib.meta(m["id"]).get("render", True):
                return                               # paused from the UI: stop at the next sentence (takes stay cached)
            if self.focus != focus_at_start:        # listener jumped elsewhere: serve that first
                nxt = self.next_job()
                if nxt and (nxt[0]["id"], nxt[1]["index"], nxt[2]) != (m["id"], chap["index"], s):
                    return
        out = lib.audio_dir(m["id"], chap["index"])
        out.mkdir(parents=True, exist_ok=True)
        wav = out / f"{s}.wav"                       # kept until the whole chapter is joined into one file
        tl = assemble(units, metas, cache, wav, lead_in=0.0)
        _encode([wav], out / f"{s}.m4a")
        units_out = []
        for k, (u, ut) in enumerate(zip(units, tl["units"])):
            text = chap["blocks"][u.block]["text"]
            units_out.append(dict(i=seg["u0"] + k, t0=ut["t0"], t1=ut["t1"],
                                  words=timing.map_words(text, u.start, u.end, ut["words"], ut["t0"], ut["t1"])))
        lib._write(out / f"{s}.json", dict(duration=tl["duration"], units=units_out))
        self.build_chapter(m, chap)
        took = time.time() - t0
        self.status["rendered_secs"] += tl["duration"]
        # speed = audio rendered / wall time over the last 15 minutes (one slow segment no longer swings it)
        now = time.time()
        self._window = [(t, a, w) for t, a, w in getattr(self, "_window", []) if now - t < 900] + [(now, tl["duration"], took)]
        self.status["rate"] = round(sum(a for _, a, _ in self._window) / max(sum(w for *_, w in self._window), 1e-6), 2)

    def build_chapter(self, m: dict, chap: dict) -> None:
        """Once every segment exists, join them into one continuous chapter file (no hand-offs while listening)."""
        import soundfile as sf
        ch, n = chap["index"], len(chap["segments"])
        out = lib.audio_dir(m["id"], ch)
        wavs = [out / f"{s}.wav" for s in range(n)]
        if lib.chapter_file_ready(m["id"], ch) or not all(w.exists() and lib.segment_ready(m["id"], ch, s) for s, w in enumerate(wavs)):
            return
        units, offset = [], 0.0
        for s, w in enumerate(wavs):
            seg = lib._read(out / f"{s}.json")
            for u in seg["units"]:
                units.append(dict(i=u["i"], t0=round(u["t0"] + offset, 3), t1=round(u["t1"] + offset, 3),
                                  words=[[a, b, round(t0 + offset, 3), round(t1 + offset, 3)] for a, b, t0, t1 in u["words"]]))
            offset += sf.info(str(w)).frames / sf.info(str(w)).samplerate
        _encode(wavs, out / "full.m4a")
        lib._write(out / "full.json", dict(duration=round(offset, 3), units=units))
        for w in wavs:
            w.unlink(missing_ok=True)
        log.info("chapter file ready: %s ch%s (%.0f s)", m["id"], ch, offset)
