"""The on-disk library: imported books, their chapters/units/segments, playback positions."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import threading
import time
from pathlib import Path

from . import book as bookmod
from . import segment
from .engine import DEFAULT_VOICE

DATA = Path(os.environ.get("READER_DATA", Path.home() / "reader" / "data"))
BOOKS = DATA / "books"
CACHE = DATA / "cache"
SEGMENT_SECS = 30      # target length of one audio piece: short, so a part that isn't rendered yet starts soon
PIPELINE = 6           # bump when segmentation/pauses/mastering change: books are re-segmented and re-assembled
log = logging.getLogger("reader.library")
CPS = 15.0             # rough spoken chars/second, for estimates before audio exists

_lock = threading.RLock()


def _write(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False))
    os.replace(tmp, path)


def _read(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def book_dir(book_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{3,80}", book_id):
        raise KeyError(book_id)
    return BOOKS / book_id


def _segments(units: list[segment.Unit]) -> list[dict]:
    segs, cur, est = [], [], 0.0
    for i, u in enumerate(units):
        cur.append(i)
        est += len(u.spoken) / CPS + u.pause
        if est >= SEGMENT_SECS:
            segs.append(dict(u0=cur[0], u1=cur[-1] + 1, est=round(est, 1)))
            cur, est = [], 0.0
    if cur:
        segs.append(dict(u0=cur[0], u1=cur[-1] + 1, est=round(est, 1)))
    return segs


def import_epub(src: Path, original_name: str = "") -> str:
    bk = bookmod.load(src)
    digest = hashlib.sha1(src.read_bytes()).hexdigest()[:6]
    slug = re.sub(r"[^a-z0-9]+", "-", bookmod.clean(bk.title).lower().encode("ascii", "ignore").decode()).strip("-")[:50] or "book"
    book_id = f"{slug}-{digest}"
    d = BOOKS / book_id
    with _lock:
        if (d / "meta.json").exists():
            return book_id
        (d / "chapters").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, d / "book.epub")
        if bk.cover:
            ext = Path(bk.cover_name or "cover.jpg").suffix.lower() or ".jpg"
            (d / f"cover{ext}").write_bytes(bk.cover)
        chapters = _write_chapters(d, bk)
        _write(d / "meta.json", dict(id=book_id, title=bk.title, author=bk.author, lang=bk.lang,
                                     voice=DEFAULT_VOICE.get(bk.lang, DEFAULT_VOICE["en"]), chapters=chapters,
                                     source=original_name or src.name, added=time.time(), pipeline=PIPELINE))
    return book_id


def _write_chapters(d: Path, bk) -> list[dict]:
    chapters = []
    for ch in bk.chapters:
        us = segment.units(ch, bk.lang) if ch.include else []
        segs = _segments(us)
        _write(d / "chapters" / f"{ch.index}.json", dict(
            index=ch.index, title=ch.title, role=ch.role, include=ch.include,
            blocks=[dict(kind=b.kind, text=b.text, level=b.level) for b in ch.blocks],
            units=[dict(id=u.id, block=u.block, start=u.start, end=u.end, spoken=u.spoken, role=u.role,
                        kind=u.kind, pause=u.pause) for u in us],
            segments=segs))
        chapters.append(dict(index=ch.index, title=ch.title, role=ch.role, include=ch.include,
                             n_units=len(us), n_segments=len(segs), est=round(sum(s["est"] for s in segs))))
    return chapters


def _drop_audio(d: Path, m: dict) -> None:
    """Audio no longer matches the book (new voice, language or pipeline). A new generation number tells the
    renderer to discard whatever it was in the middle of; the caller writes meta."""
    shutil.rmtree(d / "audio", ignore_errors=True)
    m["gen"] = m.get("gen", 0) + 1


def _units_sig(chapter: dict | None) -> str:
    return hashlib.sha1(json.dumps([(u["block"], u["start"], u["end"], u["spoken"]) for u in (chapter or {}).get("units", [])]).encode()).hexdigest()


def _keep_finished_chapters(d: Path, m: dict, old_sigs: dict) -> None:
    """After re-segmentation: a fully rendered chapter whose sentences didn't change keeps its audio (only the
    piece files, cut at the old boundaries, go); anything else is dropped and rendered again (from cached takes
    where the text is unchanged). The new generation number makes the renderer discard work in progress."""
    for c in m["chapters"]:
        cd = d / "audio" / str(c["index"])
        if not cd.exists():
            continue
        same = old_sigs.get(c["index"]) == _units_sig(_read(d / "chapters" / f"{c['index']}.json"))
        if same and (cd / "full.m4a").exists() and (cd / "full.json").exists():
            for f in cd.iterdir():
                if not f.name.startswith("full."):
                    f.unlink(missing_ok=True)
        else:
            shutil.rmtree(cd, ignore_errors=True)
    m["gen"] = m.get("gen", 0) + 1


def _unit_at(chapter: dict | None, block: int, start: int) -> int | None:
    for i, u in enumerate((chapter or {}).get("units", [])):
        if u["block"] == block and u["start"] <= start < max(u["end"], u["start"] + 1):
            return i
    return None


def upgrade_all(after_each=None) -> None:
    """Re-segment books made by an older pipeline. Their audio is rebuilt by the renderer, from cached takes when the
    spoken text is unchanged (~14x realtime). The listener's place is carried over by its position in the text, since
    unit numbers change with segmentation. Runs in the background at startup."""
    from .engine import voice_for
    for mp in sorted(BOOKS.glob("*/meta.json")):     # a voice the engine no longer has (Phonon's): the narrator,
        m = _read(mp)                                 # with the old audio dropped so voices never mix in a chapter
        if m and voice_for(m["lang"], m["voice"]) != m["voice"]:
            log.info("%s: voice %s is gone, now %s", m["id"], m["voice"], voice_for(m["lang"], m["voice"]))
            set_voice(m["id"], voice_for(m["lang"], m["voice"]))
    for mp in sorted(BOOKS.glob("*/meta.json")):
        m = _read(mp)
        if not m or m.get("pipeline", 1) >= PIPELINE:
            continue
        d = mp.parent
        log.info("upgrading %s to pipeline %d", m["id"], PIPELINE)
        bk = bookmod.load(d / "book.epub")
        with _lock:
            pos = _read(d / "position.json")
            if pos and pos.get("block") is None:         # older positions only know the unit number: anchor it in the text
                u = ((_read(d / "chapters" / f"{pos['chapter']}.json") or {}).get("units") or [None] * (pos["unit"] + 1))
                u = u[pos["unit"]] if pos["unit"] < len(u) else None
                if u:
                    pos.update(block=u["block"], start=u["start"], du=0.0)
            old = {c["index"]: _units_sig(_read(d / "chapters" / f"{c['index']}.json")) for c in m["chapters"]}
            m["chapters"] = _write_chapters(d, bk)
            m["pipeline"] = PIPELINE
            _keep_finished_chapters(d, m, old)
            _write(mp, m)
            if pos and pos.get("block") is not None:
                i = _unit_at(_read(d / "chapters" / f"{pos['chapter']}.json"), pos["block"], pos["start"])
                if i is not None:
                    pos["unit"] = i
                _write(d / "position.json", pos)                 # "updated" is kept: a newer phone copy still wins
        if after_each:
            after_each()


def list_books() -> list[dict]:
    out = []
    for d in sorted(BOOKS.glob("*/meta.json")):
        m = _read(d)
        if m:
            m.setdefault("render", True)
            m["position"] = position(m["id"])
            m["progress"] = progress(m)
            out.append(m)
    return sorted(out, key=lambda m: -(m["position"] or {}).get("updated", m.get("added", 0)))


def meta(book_id: str) -> dict:
    m = _read(book_dir(book_id) / "meta.json")
    if not m:
        raise KeyError(book_id)
    m.setdefault("render", True)
    return m


def set_voice(book_id: str, voice: str) -> dict:
    with _lock:
        m = meta(book_id)
        if voice != m["voice"]:
            m["voice"] = voice
            _drop_audio(book_dir(book_id), m)                # takes stay cached per voice
            _write(book_dir(book_id) / "meta.json", m)
    return m


def chapter(book_id: str, index: int) -> dict:
    c = _read(book_dir(book_id) / "chapters" / f"{int(index)}.json")
    if c is None:
        raise KeyError(index)
    return c


def audio_dir(book_id: str, ch: int) -> Path:
    return book_dir(book_id) / "audio" / str(int(ch))


def chapter_file_ready(book_id: str, ch: int) -> bool:
    d = audio_dir(book_id, ch)
    return (d / "full.m4a").exists() and (d / "full.json").exists()


def segment_ready(book_id: str, ch: int, s: int) -> bool:
    d = audio_dir(book_id, ch)
    return (d / f"{s}.m4a").exists() and (d / f"{s}.json").exists()


def chapter_status(book_id: str, ch: int, n_segments: int) -> list[bool]:
    if chapter_file_ready(book_id, ch):          # a finished chapter needs no pieces (they may be cut differently now)
        return [True] * n_segments
    return [segment_ready(book_id, ch, s) for s in range(n_segments)]


# ---------------------------------------------------------------- streaming copies (one continuous MediaSource)
#
# The player feeds chapter after chapter into a single MediaSource, so the audio element never ends between
# chapters. iOS closes a locked web app's audio session when an element reaches its natural end and won't reopen
# it from the background, so ending and starting the next file there is what stopped playback at chapter ends.
# MediaSource needs fragmented MP4; each rendered .m4a gets a fragmented copy on first use (a stream copy, < 1 s).

FRAG_SECS = 2
_frag_locks: dict[str, threading.Lock] = {}


def _boxes(buf: bytes, start: int, end: int):
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[i:i + 8])
        hdr = 8
        if size == 1:
            size, hdr = struct.unpack(">Q", buf[i + 8:i + 16])[0], 16
        elif size == 0:
            size = end - i
        if size < hdr:
            return
        yield typ.decode("latin1"), i, i + size, i + hdr
        i += size


def _child(buf: bytes, path: list[str], start: int, end: int):
    for typ, s, e, p in _boxes(buf, start, end):
        if typ == path[0]:
            return (s, e, p) if len(path) == 1 else _child(buf, path[1:], p, e)
    return None


def _frag_index(path: Path) -> dict:
    """Byte ranges of the init segment and of every fragment (moof+mdat), with each fragment's start time."""
    buf = path.read_bytes()
    top = list(_boxes(buf, 0, len(buf)))
    moov = next(b for b in top if b[0] == "moov")
    mdhd = _child(buf, ["trak", "mdia", "mdhd"], moov[3], moov[2])
    v, p = buf[mdhd[2]], mdhd[2]
    timescale = struct.unpack(">I", buf[p + 12:p + 16] if v == 0 else buf[p + 20:p + 24])[0]
    frags = []
    for k, (typ, s, e, p) in enumerate(top):
        if typ != "moof":
            continue
        tf = _child(buf, ["traf", "tfdt"], p, e)
        q = tf[2]
        base = struct.unpack(">Q", buf[q + 4:q + 12])[0] if buf[q] == 1 else struct.unpack(">I", buf[q + 4:q + 8])[0]
        mdat = top[k + 1]
        frags.append([s, mdat[2] - s, round(base / timescale, 4)])
    return dict(init=[0, moov[2]], frags=frags, bytes=sum(f[1] for f in frags) + moov[2])


def audio_version(src: Path) -> str:
    st = src.stat()
    return f"{int(st.st_mtime)}-{st.st_size}"


def _part_paths(book_id: str, ch: int, part: str) -> tuple[Path, Path]:
    d = audio_dir(book_id, ch)
    if part == "full":
        return d / "full.m4a", d / "full.json"
    return d / f"{int(part)}.m4a", d / f"{int(part)}.json"


def stream(book_id: str, ch: int, part: str) -> tuple[Path, dict] | None:
    """(fragmented file, its index + timeline) for one rendered file: part is "full" or a segment number."""
    src, tl_p = _part_paths(book_id, ch, part)
    if not (src.exists() and tl_p.exists()):
        return None
    out, idx_p = src.with_suffix(".frag.mp4"), src.with_suffix(".frag.json")
    with _lock:
        lock = _frag_locks.setdefault(str(out), threading.Lock())
    with lock:
        if not (out.exists() and idx_p.exists() and out.stat().st_mtime >= src.stat().st_mtime):
            tmp = out.with_name(out.stem + ".tmp.mp4")
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-map", "0:a", "-c", "copy",
                            "-movflags", "+empty_moov+default_base_moof", "-frag_duration", str(FRAG_SECS * 1_000_000),
                            "-f", "mp4", str(tmp)], check=True)
            idx = _frag_index(tmp)
            os.replace(tmp, out)
            _write(idx_p, dict(idx, v=audio_version(src)))
        idx = _read(idx_p)
    tl = _read(tl_p) or {}
    return out, dict(idx, duration=tl.get("duration"), units=tl.get("units", []))


def progress(m: dict) -> dict:
    ready = total = 0
    for c in m["chapters"]:
        if c["include"]:
            total += c["est"]
            st = chapter_status(m["id"], c["index"], c["n_segments"])
            if st:
                ready += c["est"] * sum(st) / len(st)
    # your place: the chapters before yours, and how far into yours you are (by sentence)
    pos = position(m["id"]) or {}
    heard = 0.0
    for c in m["chapters"]:
        if c["include"] and c["index"] < pos.get("chapter", 0):
            heard += c["est"]
        elif c["include"] and c["index"] == pos.get("chapter") and c.get("n_units"):
            heard += c["est"] * min(1.0, pos.get("unit", 0) / c["n_units"])
    return dict(total_est=round(total), ready_est=round(ready), heard_est=round(heard))


def position(book_id: str) -> dict | None:
    return _read(book_dir(book_id) / "position.json")


def set_position(book_id: str, chapter_index: int, unit: int, t: float = 0.0, block: int | None = None,
                 start: int | None = None, du: float | None = None) -> dict:
    p = dict(chapter=int(chapter_index), unit=int(unit), t=float(t), updated=time.time())
    if block is not None and start is not None:
        p.update(block=int(block), start=int(start), du=round(float(du or 0.0), 3))
    _write(book_dir(book_id) / "position.json", p)
    return p


def delete(book_id: str) -> None:
    shutil.rmtree(book_dir(book_id), ignore_errors=True)


def cover_path(book_id: str) -> Path | None:
    return next(iter(sorted(book_dir(book_id).glob("cover.*"))), None)


# ---------------------------------------------------------------- rendering control, language, storage

SETTINGS = DATA / "settings.json"
LANGS = {"es": "Spanish", "en": "English"}


def settings() -> dict:
    s = _read(SETTINGS, {}) or {}
    return {"paused": bool(s.get("paused", False)), "threads": int(s.get("threads", int(os.environ.get("READER_THREADS", "4"))))}


def set_settings(**kw) -> dict:
    with _lock:
        s = settings()
        s.update({k: v for k, v in kw.items() if v is not None})
        DATA.mkdir(parents=True, exist_ok=True)
        _write(SETTINGS, s)
    return s


def set_render(book_id: str, on: bool) -> dict:
    with _lock:
        m = meta(book_id)
        m["render"] = bool(on)
        _write(book_dir(book_id) / "meta.json", m)
    return m


def set_lang(book_id: str, lang: str) -> dict:
    """Re-read the book as another language: new text normalisation, that language's narrator, fresh audio."""
    if lang not in LANGS:
        raise ValueError(lang)
    with _lock:
        m = meta(book_id)
        if lang == m["lang"]:
            return m
        d = book_dir(book_id)
        bk = bookmod.load(d / "book.epub")
        bk.lang = lang
        m.update(lang=lang, voice=DEFAULT_VOICE[lang], chapters=_write_chapters(d, bk), pipeline=PIPELINE)
        _drop_audio(d, m)
        _write(d / "meta.json", m)
    return m


def clear_audio(book_id: str) -> int:
    with _lock:
        m, d = meta(book_id), book_dir(book_id)
        freed = _size(d / "audio")
        _drop_audio(d, m)
        _write(d / "meta.json", m)
    return freed


def _size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


def _live_take_keys() -> set[str]:
    """Cache keys every book still needs with its current engine (voice, pace, version)."""
    from .engine import CONTEXT, Engine
    from .render import ctx_id, key_for
    keys = set()
    for mp in BOOKS.glob("*/meta.json"):
        m = _read(mp)
        if not m:
            continue
        ek = Engine.key_for(m["lang"], m["voice"])
        context = CONTEXT
        for c in m["chapters"]:
            if not c["n_units"]:
                continue
            us = chapter(m["id"], c["index"])["units"]
            for j, u in enumerate(us):
                keys.add(key_for(ek, u["kind"], u["spoken"]))                     # no context (a chapter start, a jump)
                if context and j:
                    keys.add(key_for(ek, u["kind"], u["spoken"], ctx_id(us[j - 1])))
    return keys


def storage() -> dict:
    total, used, free = shutil.disk_usage(DATA)
    books = []
    for mp in sorted(BOOKS.glob("*/meta.json")):
        m = _read(mp)
        if m:
            books.append(dict(id=m["id"], title=m["title"], audio=_size(mp.parent / "audio"), source=_size(mp.parent / "book.epub")))
    live = _live_take_keys()
    cache = stale = stale_n = 0
    for f in CACHE.rglob("*.wav"):
        sz = f.stat().st_size + (f.with_suffix(".json").stat().st_size if f.with_suffix(".json").exists() else 0)
        cache += sz
        if f.name.split(".")[0] not in live:
            stale += sz
            stale_n += 1
    return dict(disk_total=total, disk_free=free, books=books, cache=cache, cache_stale=stale, cache_stale_files=stale_n)


def clean_cache() -> int:
    """Delete cached takes no book can use any more (old pace/voice/version). Returns bytes freed."""
    live = _live_take_keys()
    freed = 0
    for f in list(CACHE.rglob("*")):
        if f.is_file() and f.name.split(".")[0] not in live:
            freed += f.stat().st_size
            f.unlink(missing_ok=True)
    return freed
