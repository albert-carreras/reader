"""reader: EPUB -> verified, intonation-checked narration.

  reader chapters BOOK.epub                       list chapters
  reader script BOOK.epub -c 3                    show what will be spoken (no audio)
  reader render BOOK.epub -c 3 [-n 40] [-v lola]  render chapter 3 (optionally only its first n units)
  reader say "text" -l es                         render one line (debug)
  reader qa [BOOK]                                the rendered sentences most worth a listen, with timestamps
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")


def _book(path):
    from . import book
    return book.load(path)


def cmd_chapters(a):
    bk = _book(a.epub)
    print(f"{bk.title} — {bk.author} [{bk.lang}]")
    for ch in bk.chapters:
        print(f"{ch.index:4d} {'✓' if ch.include else '·'} {ch.role:14s} ~{ch.chars / 15 / 60:5.1f} min  {ch.title[:60]}")


def cmd_script(a):
    from . import segment
    bk = _book(a.epub)
    ch = bk.chapters[a.chapter - 1]
    for u in segment.units(ch, a.lang or bk.lang)[: a.n or None]:
        print(f"{u.id} {u.role:9s} {u.kind:12s} +{u.pause:.2f}s  {u.spoken}")


def _fmt(s):
    m, s = divmod(int(s), 60)
    return f"{m}m{s:02d}s"


def _check_voice(lang: str, voice: str | None) -> None:
    from .engine import POCKET_VOICES
    if voice and voice not in POCKET_VOICES.get(lang, []):
        sys.exit(f"no voice {voice!r} for {lang}: {', '.join(POCKET_VOICES.get(lang, []))}")


def cmd_render(a):
    os.environ.setdefault("READER_THREADS", str(a.threads))
    import torch
    torch.set_num_threads(a.threads)
    if a.nice:
        os.nice(a.nice)
    from . import segment
    from .engine import Engine
    from .render import VoiceStats, assemble, render_unit

    bk = _book(a.epub)
    lang = a.lang or bk.lang
    ch = bk.chapters[a.chapter - 1]
    units = segment.units(ch, lang)[: a.n or None]
    _check_voice(lang, a.voice)
    eng = Engine(lang, a.voice)
    slug = re.sub(r"\W+", "-", Path(a.epub).stem).strip("-")
    out = Path(a.out) / slug
    cache = out / "cache" / eng.voice
    cache.mkdir(parents=True, exist_ok=True)
    stats = VoiceStats()
    metas, t0, audio_s = [], time.time(), 0.0
    print(f"{bk.title} · {ch.title} · {len(units)} units · voice {eng.voice} · {a.threads} threads")
    from .render import ctx_id, final_audio
    prev, prev_audio = None, None
    for i, u in enumerate(units, 1):
        ctx = (ctx_id(prev), prev_audio) if eng.uses_context and prev is not None else None
        m = render_unit(u, eng, stats, cache, ctx=ctx)
        prev, prev_audio = u, final_audio(m, cache)
        metas.append(m)
        audio_s += m["duration"] + u.pause
        el = time.time() - t0
        mark = "  ⚑ " + " | ".join(m["flags"]) if m["flags"] else ""
        if a.verbose or m["flags"] or m["n_takes"] > 1:
            f = m["features"]
            print(f"  {u.id} {u.kind:12s} takes={m['n_takes']} pick={m['take']} Δend={f.get('final_delta', 0):+5.1f}st "
                  f"score={m['score']:+.1f}  {u.spoken[:70]}{mark}")
        if i % 25 == 0 or i == len(units):
            print(f"  … {i}/{len(units)} units · {_fmt(audio_s)} audio in {_fmt(el)} · {audio_s / max(el, 1e-6):.2f}x realtime", flush=True)
    name = f"{ch.index:03d}-{eng.voice}" + (f"-first{a.n}" if a.n else "")
    tl = assemble(units, metas, cache, out / f"{name}.wav")
    tl.update(book=bk.title, chapter=ch.title, voice=eng.voice, lang=lang)
    (out / f"{name}.json").write_text(json.dumps(tl, ensure_ascii=False))
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(out / f"{name}.wav"), "-c:a", "aac", "-b:a", "96k",
                    "-metadata", f"title={ch.title}", "-metadata", f"artist={bk.author}", "-metadata", f"album={bk.title}",
                    str(out / f"{name}.m4a")], check=True)
    takes = [m["n_takes"] for m in metas]
    print(f"done: {out / (name + '.m4a')}  ({_fmt(tl['duration'])})")
    print(f"takes: {sum(takes)} for {len(takes)} units (avg {sum(takes) / len(takes):.2f}); "
          f"multi-take units: {sum(t > 1 for t in takes)}; flagged: {sum(bool(m['flags']) for m in metas)}")


def cmd_say(a):
    import soundfile as sf
    from . import prosody
    from .engine import SR, Engine, trim
    from .textnorm import speak
    _check_voice(a.lang, a.voice)
    eng = Engine(a.lang, a.voice)
    spoken = speak(a.text, a.lang)
    audio = trim(eng.synth(spoken, seed=a.seed))
    sf.write(a.out, audio, SR)
    print(spoken, prosody.features(audio))


def cmd_qa(a):
    """Rank rendered sentences by how likely they sound wrong, with chapter timestamps to listen at in the app."""
    from . import library as lib
    from .engine import Engine
    from .render import ctx_id, key_for
    books = [m for m in lib.list_books() if not a.book or a.book.lower() in (m["id"] + " " + m["title"]).lower()]
    for m in books:
        eng = Engine(m["lang"], m["voice"])
        ek, cache = eng.key, lib.CACHE / eng.voice
        found, checked, missing = [], 0, 0
        for c in m["chapters"]:
            if not c["n_units"]:
                continue
            chap = lib.chapter(m["id"], c["index"])
            d = lib.audio_dir(m["id"], c["index"])
            parts = [lib._read(d / "full.json")] if (d / "full.json").exists() else [lib._read(d / f"{k}.json") for k in range(len(chap["segments"]))]
            offset = 0.0
            for part in parts:
                if not part:
                    break                       # not rendered from here on (timestamps would be guesses)
                for ut in part["units"]:
                    i = ut["i"]
                    u = chap["units"][i]
                    # the take that was used: recorded in the timeline since 2026-11-27; before that, the take that
                    # heard the sentence before it (context), else the one rendered without (a chapter start, a jump)
                    keys = ([ut["key"]] if ut.get("key") else []) + [
                        key_for(ek, u["kind"], u["spoken"], ctx_id(chap["units"][i - 1]) if i else ""), key_for(ek, u["kind"], u["spoken"])]
                    meta = next((x for x in (lib._read(cache / f"{k}.json") for k in keys) if x), None)
                    if not meta:
                        missing += 1
                        continue
                    checked += 1
                    issues, f = [], meta.get("features") or {}
                    if not meta["words"]:
                        issues.append((4, "no word timings (the aligner found nothing)"))
                    if "UNVERIFIED" in meta["flags"]:
                        issues.append((5, "unverified: " + next((x.split(": ", 1)[1] for x in meta["flags"] if x.startswith("take")), "")))
                    unclear = [w["word"] for w in meta["words"] if len(w["word"]) >= 3 and w["score"] < 0.3]
                    if unclear and "UNVERIFIED" not in meta["flags"]:
                        issues.append((3, "unclear: " + " ".join(unclear[:4])))
                    shift = (meta.get("reshaped") or {}).get("mild", 0) or 0
                    d_end = f.get("final_delta", 0) + shift
                    if u["kind"] == "yesno" and d_end < 1.0:
                        issues.append((2, f"question may not rise ({d_end:+.1f} st)"))
                    if u["kind"] == "statement" and d_end > 1.5:
                        issues.append((2, f"statement may rise ({d_end:+.1f} st)"))
                    if issues:
                        found.append((max(i[0] for i in issues), c["title"], offset + ut["t0"], "; ".join(i[1] for i in issues), u["spoken"]))
                offset += part["duration"]
        found.sort(key=lambda x: (-x[0], x[1], x[2]))
        print(f"\n{m['title']} ({eng.voice}): {len(found)} of {checked} rendered sentences worth a listen"
              + (f" ({missing} more without a cached take)" if missing else ""))
        for sev, title, t, why, text in found[: a.limit]:
            print(f"  {title[:24]:24s} {int(t // 60):3d}:{int(t % 60):02d}  {why}\n      {text[:110]}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="reader", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("chapters"); s.add_argument("epub"); s.set_defaults(fn=cmd_chapters)
    s = sub.add_parser("script"); s.add_argument("epub"); s.add_argument("-c", "--chapter", type=int, required=True)
    s.add_argument("-n", type=int); s.add_argument("-l", "--lang"); s.set_defaults(fn=cmd_script)
    s = sub.add_parser("render"); s.add_argument("epub"); s.add_argument("-c", "--chapter", type=int, required=True)
    s.add_argument("-n", type=int, help="only the first n units"); s.add_argument("-v", "--voice"); s.add_argument("-l", "--lang")
    s.add_argument("-o", "--out", default=str(Path.home() / "reader" / "renders")); s.add_argument("-t", "--threads", type=int, default=4)
    s.add_argument("--nice", type=int, default=10); s.add_argument("--verbose", action="store_true"); s.set_defaults(fn=cmd_render)
    s = sub.add_parser("say"); s.add_argument("text"); s.add_argument("-l", "--lang", default="es"); s.add_argument("-v", "--voice")
    s.add_argument("-s", "--seed", type=int, default=0)
    s.add_argument("-o", "--out", default="say.wav"); s.set_defaults(fn=cmd_say)
    s = sub.add_parser("qa"); s.add_argument("book", nargs="?"); s.add_argument("-n", "--limit", type=int, default=25); s.set_defaults(fn=cmd_qa)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
