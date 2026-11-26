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

    def _default_focus(self):
        for m in lib.list_books():
            p = m.get("position")
            if p:
                return m["id"], p["chapter"], p["unit"]
        return None

    def next_job(self):
        focus = self.focus or self._default_focus()
        if not focus:
            return None
        book_id, ch0, u0 = focus
        try:
            m = lib.meta(book_id)
        except KeyError:
            self.focus = None
            return None
        order = [c for c in m["chapters"] if c["include"] and c["n_segments"]]
        order = [c for c in order if c["index"] >= ch0] + [c for c in order if c["index"] < ch0]   # ahead first, then wrap
        for c in order:
            chap = lib.chapter(book_id, c["index"])
            start_seg = 0
            if c["index"] == ch0:
                start_seg = next((s for s, seg in enumerate(chap["segments"]) if seg["u0"] <= u0 < seg["u1"]), 0)
            segs = list(range(start_seg, len(chap["segments"]))) + list(range(0, start_seg))
            for s in segs:
                if not lib.segment_ready(book_id, c["index"], s):
                    return m, chap, s
        return None

    # ---------------------------------------------------------------- rendering
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
                job = self.next_job()
                if job is None:
                    self.status.update(state="idle", job=None)
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
            if self.focus != focus_at_start:        # listener jumped elsewhere: serve that first
                nxt = self.next_job()
                if nxt and (nxt[0]["id"], nxt[1]["index"], nxt[2]) != (m["id"], chap["index"], s):
                    return
        out = lib.audio_dir(m["id"], chap["index"])
        out.mkdir(parents=True, exist_ok=True)
        wav = out / f"{s}.wav"
        tl = assemble(units, metas, cache, wav, lead_in=0.0)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "aac", "-b:a", "80k", "-movflags", "+faststart",
                        str(out / f"{s}.m4a.tmp.m4a")], check=True)
        os.replace(out / f"{s}.m4a.tmp.m4a", out / f"{s}.m4a")
        wav.unlink(missing_ok=True)
        units_out = []
        for k, (u, ut) in enumerate(zip(units, tl["units"])):
            text = chap["blocks"][u.block]["text"]
            units_out.append(dict(i=seg["u0"] + k, t0=ut["t0"], t1=ut["t1"],
                                  words=timing.map_words(text, u.start, u.end, ut["words"], ut["t0"], ut["t1"])))
        lib._write(out / f"{s}.json", dict(duration=tl["duration"], units=units_out))
        took = time.time() - t0
        self.status["rendered_secs"] += tl["duration"]
        if took > 1:
            r = tl["duration"] / took
            self.status["rate"] = round(r if self.status["rate"] is None else 0.7 * self.status["rate"] + 0.3 * r, 2)
