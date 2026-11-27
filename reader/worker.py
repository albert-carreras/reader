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
from .engine import synth_job as _synth_job
from .render import ctx_id, final_audio, render_unit, unit_key
from .segment import Unit

log = logging.getLogger("reader.worker")


from .machine import headroom_gb


def _give_back() -> None:
    """Hand freed memory back to the system after each piece. The allocator otherwise keeps what every sentence's
    scratch tensors used, and the process grows ~17 MB a sentence (measured: 1.9 -> 2.6 GB in 20 sentences, flat
    at 1.9 GB with this). Takes ~250 ms, so once per piece rather than per sentence."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass

# a side lane costs one more voice process (~1.5-2 GB): start one only with room for it under the service's limit
# (and on the machine), and leave a chapter when the room gets thin
SIDE_LANE_MIN_GB, SIDE_LANE_STOP_GB = 2.5, 1.0
# A second chain slows the first by ~10% (2,208 takes, 2026-11-27: 0.71x realtime alone, 0.63x with another
# chapter rendering). One chain is slower than realtime, so a listener inside a chapter that is still rendering
# catches up and waits: side lanes hold while less than URGENT_SECS of rendered audio lies between the listener and
# the piece lane 0 is rendering (its own piece, or the next one; across a chapter end too).
URGENT_SECS = 45.0


def lanes_for(threads: int) -> int:
    """How many chapters render at once (CPU setting Low / Medium / High). Lane 0 always follows the listener;
    the others take whole later chapters, which need no context from before (a chapter starts fresh)."""
    return 1 if threads <= 2 else 2 if threads <= 4 else 3
IDLE_RELEASE_S = float(os.environ.get("READER_IDLE_RELEASE", "300"))   # unload models after this long with nothing to do


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
        self.status = dict(state="idle", job=None, rate=None, error=None, rendered_secs=0.0, lanes=[])
        self._stats = {}
        self.claims: dict[tuple[str, int], int] = {}        # (book, chapter) -> side lane rendering it
        self.claims_lock = threading.Lock()
        self.lane0_at: tuple[str, int] | None = None       # the chapter lane 0 is on
        self.lane_jobs: dict[int, dict] = {}                # side lane -> what it's doing (for the app)
        self.side_wanted = 0
        self._side: dict[int, threading.Thread] = {}
        self._chapter_locks: dict[tuple[str, int], threading.Lock] = {}
        self._urgent: tuple = (None, False)                 # (focus + lane 0's piece, is the listener waiting)

    # ---------------------------------------------------------------- scheduling
    def set_focus(self, book_id: str, chapter: int, unit: int) -> None:
        self.focus = (book_id, int(chapter), int(unit))
        self.wake.set()

    def _order(self, books: list[dict] | None = None):
        """Books to render, in priority order: the one being listened to first, then the others by recent use.
        Books with rendering switched off are skipped entirely."""
        books = [m for m in (books if books is not None else lib.list_books())
                 if m.get("render", True) and m.get("pipeline", 1) >= lib.PIPELINE]   # not mid-upgrade
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

    def _first_missing(self, m: dict, ch0: int, u0: int, focus_chapter: int | None = None):
        order = [c for c in m["chapters"] if c["include"] and c["n_segments"]]
        order = [c for c in order if c["index"] >= ch0] + [c for c in order if c["index"] < ch0]   # ahead first, then wrap
        for c in order:
            if lib.chapter_status(m["id"], c["index"], c["n_segments"]).count(False) == 0:
                continue
            # (a side lane may hold this chapter: lane 0 takes it anyway, and the side lane steps aside after its
            # current sentence; that keeps the chapter you'll hear next on the lane that follows you)
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
        for k, (m, ch0, u0) in enumerate(self._order()):
            job = self._first_missing(m, ch0, u0, ch0 if k == 0 else None)
            if job:
                return job
        return None

    def _side_job(self, lane: int, warm: bool = False):
        """A whole later chapter for a side lane: the listened book's next chapters first, then the other books'.
        Starting a lane needs memory to spare; a lane already running (its voice process loaded) only needs to
        stay clear of the floor."""
        if lib.settings()["paused"] or headroom_gb() < (SIDE_LANE_STOP_GB if warm else SIDE_LANE_MIN_GB):
            return None                                # not enough memory to spare: lane 0 alone
        with self.claims_lock:
            for k, (m, ch0, _u0) in enumerate(self._order()):
                for c in m["chapters"]:
                    if not (c["include"] and c["n_segments"]) or (k == 0 and c["index"] <= ch0) or (k > 0 and c["index"] < ch0):
                        continue
                    key = (m["id"], c["index"])
                    if key in self.claims or key == self.lane0_at:
                        continue
                    if lib.chapter_status(m["id"], c["index"], c["n_segments"]).count(False) == 0:
                        continue
                    self.claims[key] = lane
                    log.info("lane %d: %s, chapter %d", lane, m["id"], c["index"])
                    return m, lib.chapter(m["id"], c["index"])
        return None

    def _side_lane(self, lane: int) -> None:
        log.info("lane %d started", lane)
        warm = False
        while lane <= self.side_wanted:
            job = None
            try:
                job = self._side_job(lane, warm)
                if job is None:
                    self.lane_jobs.pop(lane, None)
                    time.sleep(10)
                    continue
                m, chap = job
                warm = True
                for s in range(len(chap["segments"])):
                    if lane > self.side_wanted or self.lane0_at == (m["id"], chap["index"]) or lib.settings()["paused"] \
                            or headroom_gb() < SIDE_LANE_STOP_GB:
                        log.info("lane %d leaves chapter %d (lane 0 is there, fewer lanes, paused, or memory)", lane, chap["index"])
                        break                              # fewer lanes, the listener came here, or memory is tight
                    if not lib.segment_ready(m["id"], chap["index"], s):
                        if self.render_segment(m, chap, s, lane=lane) is False:
                            log.info("lane %d leaves chapter %d mid-piece", lane, chap["index"])
                            break
            except Exception:  # noqa: BLE001
                log.error("lane %d render failed: %s", lane, traceback.format_exc())
                time.sleep(10)
            finally:
                if job:
                    self.lane_jobs.pop(lane, None)       # not shown as working on a chapter it has left
                    with self.claims_lock:
                        self.claims.pop((job[0]["id"], job[1]["index"]), None)
        self.lane_jobs.pop(lane, None)
        log.info("lane %d stopped", lane)

    def _ensure_lanes(self) -> None:
        self.side_wanted = lanes_for(lib.settings()["threads"]) - 1
        for lane in range(1, self.side_wanted + 1):
            t = self._side.get(lane)
            if t is None or not t.is_alive():
                self._side[lane] = threading.Thread(target=self._side_lane, args=(lane,), daemon=True, name=f"render-lane-{lane}")
                self._side[lane].start()
        self.status["lanes"] = [dict(j) for j in self.lane_jobs.values()]

    def listener_waiting(self) -> bool:
        """The listener is waiting for lane 0's piece, or soon will be: less than URGENT_SECS of rendered audio lies
        between where they are and that piece."""
        job, f = self.status.get("job"), self.focus
        if self.status.get("state") != "rendering" or not job or not f or job["book"] != f[0]:
            return False
        key = (f, job["chapter"], job["segment"])
        if self._urgent[0] != key:
            try:
                self._urgent = (key, self._ahead_of_listener(f, job["chapter"], job["segment"]) < URGENT_SECS)
            except KeyError:
                self._urgent = (key, False)
        return self._urgent[1]

    def _ahead_of_listener(self, f: tuple, ch: int, seg: int) -> float:
        """Seconds of audio (estimated) from the start of the listener's piece to piece `seg` of chapter `ch`,
        looking two chapters past theirs; infinite if that piece isn't ahead of them."""
        m = lib.meta(f[0])
        order = [c["index"] for c in m["chapters"] if c["include"] and c["n_segments"]]
        if f[1] not in order:
            return float("inf")
        gap = 0.0
        for ci in order[order.index(f[1]): order.index(f[1]) + 3]:
            segs = lib.chapter(f[0], ci)["segments"]
            start = next((k for k, sg in enumerate(segs) if sg["u0"] <= f[2] < sg["u1"]), 0) if ci == f[1] else 0
            for k in range(start, len(segs)):
                if (ci, k) == (ch, seg):
                    return gap
                gap += segs[k]["est"]
        return float("inf")

    def active_jobs(self) -> list[dict]:
        """What the lanes are producing right now: lane 0's piece while it renders (not after an error), and the side
        lanes' pieces unless they are holding for the listener."""
        lane0 = [self.status["job"]] if self.status.get("state") == "rendering" and self.status.get("job") else []
        return lane0 + [j for j in list(self.lane_jobs.values()) if not j.get("held")]

    def rendering_books(self) -> set[str]:
        return {j["book"] for j in self.active_jobs()}

    def queue(self) -> list[dict]:
        """Every book with its rendering state, progress and an ETA at the current speed.
        state: done (all rendered) · off (switched off for this book) · upgrading (being re-read for a new pipeline)
        · paused (all rendering is paused) · rendering (a lane is on it now) · queued (next in line)."""
        # every lane's output, counting lanes holding for the listener too: a hold lasts a minute or two, and the
        # whole-book time shouldn't double while it does
        rate = (self.status.get("rate") or 1.0) * max(1, 1 + len(self.lane_jobs))
        out, ahead = [], 0.0
        books = lib.list_books()                          # one pass: each book's progress is computed once
        order = [m for m, *_ in self._order(books)]
        rest = [m for m in books if m["id"] not in {o["id"] for o in order}]
        paused, busy = lib.settings()["paused"], self.rendering_books()
        for m in order + rest:
            p = m["progress"]
            left = max(0, p["total_est"] - p["ready_est"])
            on = m.get("render", True)
            eta = None
            if on and left:
                ahead += left / max(rate, 0.1)
                eta = round(ahead)
            state = "done" if left <= 1 else "off" if not on else "upgrading" if m.get("pipeline", 1) < lib.PIPELINE \
                else "paused" if paused else "rendering" if m["id"] in busy else "queued"
            out.append(dict(id=m["id"], title=m["title"], lang=m["lang"], render=on, state=state,
                            ready=p["ready_est"], total=p["total_est"], eta=eta))
        return out

    # ---------------------------------------------------------------- rendering
    def _apply_threads(self):
        n = lib.settings()["threads"]
        if n != getattr(self, "_threads", None):
            import torch
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
        idle_since, released = 0.0, False
        while True:
            try:
                self._apply_threads()
                self._ensure_lanes()
                job = self.next_job()
                if job is None:
                    self.lane0_at = None
                    self.status.update(state="paused" if lib.settings()["paused"] else "idle", job=None)
                    idle_since = idle_since or time.time()
                    if not released and not self.lane_jobs and time.time() - idle_since > IDLE_RELEASE_S:
                        from .engine import release
                        release()                    # ~4 GB back to the system while there's nothing to render
                        released = True
                        log.info("idle: models unloaded")
                    self.wake.wait(30)
                    self.wake.clear()
                    continue
                idle_since, released = 0.0, False
                self.lane0_at = (job[0]["id"], job[1]["index"])
                self.render_segment(*job)
            except Exception as e:  # keep the worker alive; surface the error in /api/status
                log.error("render failed: %s", traceback.format_exc())
                self.status.update(state="error", error=str(e))
                time.sleep(10)

    def render_segment(self, m: dict, chap: dict, s: int, lane: int = 0):
        """Render one piece. Lane 0 follows the listener (and reports to the app's countdown); side lanes render
        later chapters. Returns False when a side lane should give the chapter up."""
        from .engine import Engine
        from .render import VoiceStats, assemble, render_unit
        seg = chap["segments"][s]
        eng = Engine(m["lang"], m["voice"])
        cache = lib.CACHE / eng.voice
        cache.mkdir(parents=True, exist_ok=True)
        stats = self._stats.setdefault(eng.key, VoiceStats())
        job = dict(book=m["id"], title=m["title"], chapter=chap["index"], chapter_title=chap["title"],
                   segment=s, of=len(chap["segments"]), units=seg["u1"] - seg["u0"], done=0, est=seg["est"], started=time.time())
        if lane == 0:
            self.status.update(state="rendering", error=None, job=job)
        else:
            self.lane_jobs[lane] = job
        units, metas, t0, held_s = [], [], time.time(), 0.0
        focus_at_start = self.focus
        # Pocket with context renders as a chain (each sentence hears the one before): the next sentence starts in a
        # worker process as soon as this one's first take exists, overlapping verification. Otherwise every first
        # take of the segment starts at once.
        chain = getattr(eng, "uses_context", False)
        firsts = {} if chain else self._prefetch(eng, chap, seg, cache)
        ahead: dict = {}
        prev_u = _unit(chap, seg["u0"] - 1) if chain and seg["u0"] > 0 else None
        prev_audio = self._cached_final(chap, seg["u0"] - 1, eng, cache) if prev_u else None

        def start(j: int, context):
            if not chain or j >= seg["u1"] or j in ahead:
                return
            un = _unit(chap, j)
            before = _unit(chap, j - 1) if j > 0 else None
            if context is None or (cache / f"{unit_key(un, eng, ctx_id(before))}.json").exists():
                return
            f = self._submit(eng, un, context)
            if f is not None:
                ahead[j] = f
        try:
            for i in range(seg["u0"], seg["u1"]):
                if lane and self.listener_waiting():
                    job["held"] = True                       # the listener needs lane 0's speed: hold, keep the chapter
                    h0 = time.time()
                    while self.listener_waiting() and not self._side_leaves(lane, m, chap):
                        time.sleep(1)
                    held_s += time.time() - h0
                    job["held"] = False
                    if self._side_leaves(lane, m, chap):
                        return False                     # lane 0 came here, fewer lanes, paused, off, or memory
                u = _unit(chap, i)
                ctx = (ctx_id(prev_u), prev_audio) if chain and prev_u is not None and prev_audio is not None else None
                first = firsts.get(i) or ahead.pop(i, None)
                if chain and first is None and not (cache / f"{unit_key(u, eng, ctx[0] if ctx else '')}.json").exists():
                    first = self._submit(eng, u, ctx[1] if ctx else None)
                t_unit = time.time()
                meta = render_unit(u, eng, stats, cache, first, ctx, on_first=(lambda a, j=i + 1: start(j, a)) if chain else None,
                                   submit=lambda text, seed, c: self._submit_take(eng, text, seed, c))
                if lane == 0:
                    self._note_speed(meta["duration"], time.time() - t_unit)
                metas.append(meta)
                units.append(u)
                job["done"] = len(metas)                  # the app shows a real countdown while you wait
                if chain:
                    prev_u, prev_audio = u, final_audio(meta, cache)
                    start(i + 1, prev_audio)                 # a cached sentence never produced a first take: start now
                if lib.settings()["paused"] or not lib.meta(m["id"]).get("render", True):
                    return False                         # paused from the UI: stop at the next sentence (takes stay cached)
                if lane:
                    if lane > self.side_wanted or self.lane0_at == (m["id"], chap["index"]):
                        return False                     # fewer lanes now, or the listener came to this chapter
                    continue
                if self.focus != focus_at_start:        # listener jumped elsewhere: serve that first
                    nxt = self.next_job()
                    if nxt and (nxt[0]["id"], nxt[1]["index"], nxt[2]) != (m["id"], chap["index"], s):
                        return
        finally:
            for f in list(firsts.values()) + list(ahead.values()):
                f.cancel()
        now = lib.meta(m["id"])
        if (now.get("gen", 0), now.get("pipeline"), now["voice"]) != (m.get("gen", 0), m.get("pipeline"), m["voice"]):
            return                                   # the book's audio was reset while we worked (voice, upgrade): discard
        out = lib.audio_dir(m["id"], chap["index"])
        out.mkdir(parents=True, exist_ok=True)
        wav = out / f"{s}.wav"                       # kept until the whole chapter is joined into one file
        tmp = out / f"{s}.lane{lane}.wav"            # two lanes can finish the same piece: never share a file
        tl = assemble(units, metas, cache, tmp, lead_in=0.0)
        with self._lock_for(m["id"], chap["index"]):
            if lib.segment_ready(m["id"], chap["index"], s):
                tmp.unlink(missing_ok=True)
                return                                   # another lane finished it first
            tmp.replace(wav)
            _encode([wav], out / f"{s}.m4a")
        units_out = []
        for k, (u, ut) in enumerate(zip(units, tl["units"])):
            text = chap["blocks"][u.block]["text"]
            units_out.append(dict(i=seg["u0"] + k, key=ut["key"], t0=ut["t0"], t1=ut["t1"],
                                  words=timing.map_words(text, u.start, u.end, ut["words"], ut["t0"], ut["t1"])))
        with self._lock_for(m["id"], chap["index"]):
            lib._write(out / f"{s}.json", dict(duration=tl["duration"], units=units_out))
            self.build_chapter(m, chap)
        _give_back()
        took = time.time() - t0 - held_s                   # time spent holding for the listener isn't rendering
        self.status["rendered_secs"] += tl["duration"]
        # speed = audio rendered / wall time over the last 15 minutes (one slow segment no longer swings it)
        now = time.time()
        self._window = [(t, a, w) for t, a, w in getattr(self, "_window", []) if now - t < 900] + [(now, tl["duration"], took)]
        self.status["rate"] = round(sum(a for _, a, _ in self._window) / max(sum(w for *_, w in self._window), 1e-6), 2)

    def _lock_for(self, book_id: str, ch: int) -> threading.Lock:
        with self.claims_lock:
            return self._chapter_locks.setdefault((book_id, ch), threading.Lock())

    def _prefetch(self, eng, chap: dict, seg: dict, cache: Path) -> dict:
        """Without context: start take 0 of every sentence of this segment not yet cached, in parallel worker
        processes. One process per render lane (Low 1, Medium 2, High 3)."""
        from .engine import drop_pool, synth_pool
        from .render import _seed, unit_key
        pool = synth_pool(lanes_for(lib.settings()["threads"]))
        out = {}
        try:
            for i in range(seg["u0"], seg["u1"]):
                u = _unit(chap, i)
                if not (cache / f"{unit_key(u, eng)}.json").exists():
                    out[i] = pool.submit(_synth_job, eng.lang, eng.voice, u.spoken, _seed(u.spoken, 0))
        except Exception:  # noqa: BLE001  (a broken pool: render in-process this time)
            drop_pool()
        return out

    def _note_speed(self, audio_s: float, wall_s: float) -> None:
        """Speed on freshly voiced sentences only (cached ones take no time and would make waits look shorter
        than they are): what the app's countdown uses while you wait for a part to render."""
        if wall_s < 0.4:
            return
        self._fresh = (getattr(self, "_fresh", []) + [(audio_s, wall_s)])[-25:]
        self.status["speed"] = round(sum(a for a, _ in self._fresh) / max(sum(w for _, w in self._fresh), 1e-6), 2)

    def _submit(self, eng, u: Unit, context):
        """Take 0 of one sentence in a worker process (None if the pool is broken: it's then rendered here)."""
        from .render import _seed
        return self._submit_take(eng, u.spoken, _seed(u.spoken, 0), context)

    def _submit_take(self, eng, text: str, seed: int, context):
        """Any take in a worker process, so the app's process never loads a voice model of its own."""
        from .engine import drop_pool, synth_pool
        try:
            return synth_pool(lanes_for(lib.settings()["threads"])).submit(_synth_job, eng.lang, eng.voice, text, seed, context)
        except Exception:  # noqa: BLE001
            drop_pool()
            return None

    def _side_leaves(self, lane: int, m: dict, chap: dict) -> bool:
        """A side lane gives its chapter up: fewer lanes now, lane 0 came to it, rendering paused or switched off for
        the book, or memory running thin."""
        return (lane > self.side_wanted or self.lane0_at == (m["id"], chap["index"]) or lib.settings()["paused"]
                or not lib.meta(m["id"]).get("render", True) or headroom_gb() < SIDE_LANE_STOP_GB)

    def _cached_final(self, chap: dict, i: int, eng, cache: Path):
        """The chosen take of sentence i, if it was rendered (with or without its own context)."""
        if i < 0:
            return None
        u = _unit(chap, i)
        before = _unit(chap, i - 1) if i > 0 else None
        for key in (unit_key(u, eng, ctx_id(before)), unit_key(u, eng, "")):
            meta = lib._read(cache / f"{key}.json")
            if meta and (cache / f"{key}.wav").exists():
                return final_audio(meta, cache)
        return None

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
                units.append(dict(u, t0=round(u["t0"] + offset, 3), t1=round(u["t1"] + offset, 3),
                                  words=[[a, b, round(t0 + offset, 3), round(t1 + offset, 3)] for a, b, t0, t1 in u["words"]]))
            offset += sf.info(str(w)).frames / sf.info(str(w)).samplerate
        _encode(wavs, out / "full.m4a")
        lib._write(out / "full.json", dict(duration=round(offset, 3), units=units))
        for f in out.iterdir():          # the pieces are now in the chapter file (a player still on them reloads it)
            if not f.name.startswith("full."):
                f.unlink(missing_ok=True)
        log.info("chapter file ready: %s ch%s (%.0f s)", m["id"], ch, offset)
