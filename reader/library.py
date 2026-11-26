"""The on-disk library: imported books, their chapters/units/segments, playback positions."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path

from . import book as bookmod
from . import segment
from .engine import DEFAULT_VOICE

DATA = Path(os.environ.get("READER_DATA", Path.home() / "reader" / "data"))
BOOKS = DATA / "books"
CACHE = DATA / "cache"
SEGMENT_SECS = 75      # target length of one audio segment (a few sentences, or one very long one)
PIPELINE = 3           # bump when segmentation/pauses/mastering change: books are re-segmented and re-assembled
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


def upgrade_all() -> None:
    """Re-segment books made by an older pipeline; their audio is re-assembled (cached takes are reused when valid)."""
    for mp in sorted(BOOKS.glob("*/meta.json")):
        m = _read(mp)
        if not m or m.get("pipeline", 1) >= PIPELINE:
            continue
        d = mp.parent
        log.info("upgrading %s to pipeline %d", m["id"], PIPELINE)
        with _lock:
            bk = bookmod.load(d / "book.epub")
            m["chapters"] = _write_chapters(d, bk)
            m["pipeline"] = PIPELINE
            shutil.rmtree(d / "audio", ignore_errors=True)
            _write(mp, m)


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
            _write(book_dir(book_id) / "meta.json", m)
            shutil.rmtree(book_dir(book_id) / "audio", ignore_errors=True)   # takes stay cached per voice
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
    return [segment_ready(book_id, ch, s) for s in range(n_segments)]


def progress(m: dict) -> dict:
    ready = total = 0
    for c in m["chapters"]:
        if c["include"]:
            total += c["est"]
            st = chapter_status(m["id"], c["index"], c["n_segments"])
            if st:
                ready += c["est"] * sum(st) / len(st)
    pos = position(m["id"]) or {}
    heard = sum(c["est"] for c in m["chapters"] if c["include"] and c["index"] < pos.get("chapter", 0))
    return dict(total_est=round(total), ready_est=round(ready), heard_est=round(heard))


def position(book_id: str) -> dict | None:
    return _read(book_dir(book_id) / "position.json")


def set_position(book_id: str, chapter_index: int, unit: int, t: float = 0.0) -> dict:
    p = dict(chapter=int(chapter_index), unit=int(unit), t=float(t), updated=time.time())
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
        shutil.rmtree(d / "audio", ignore_errors=True)
        _write(d / "meta.json", m)
    return m


def clear_audio(book_id: str) -> int:
    d = book_dir(book_id) / "audio"
    freed = _size(d)
    shutil.rmtree(d, ignore_errors=True)
    return freed


def _size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


def _live_take_keys() -> set[str]:
    """Cache keys every book still needs with its current engine (voice, pace, version)."""
    from .engine import Engine
    keys = set()
    for mp in BOOKS.glob("*/meta.json"):
        m = _read(mp)
        if not m:
            continue
        ek = Engine.key_for(m["lang"], m["voice"])
        for c in m["chapters"]:
            if not c["n_units"]:
                continue
            for u in chapter(m["id"], c["index"])["units"]:
                keys.add(hashlib.sha1(f"{ek}|{u['kind']}|{u['spoken']}".encode()).hexdigest()[:16])
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
