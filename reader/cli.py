"""reader: EPUB -> verified, intonation-checked narration.

  reader chapters BOOK.epub                       list chapters
  reader script BOOK.epub -c 3                    show what will be spoken (no audio)
  reader render BOOK.epub -c 3 [-n 40] [-v Noa]   render chapter 3 (optionally only its first n units)
  reader say "text" -l es                         render one line (debug)
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
    eng = Engine(lang, a.voice)
    slug = re.sub(r"\W+", "-", Path(a.epub).stem).strip("-")
    out = Path(a.out) / slug
    cache = out / "cache" / eng.voice
    cache.mkdir(parents=True, exist_ok=True)
    stats = VoiceStats()
    metas, t0, audio_s = [], time.time(), 0.0
    print(f"{bk.title} · {ch.title} · {len(units)} units · voice {eng.voice} · {a.threads} threads")
    for i, u in enumerate(units, 1):
        m = render_unit(u, eng, stats, cache)
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
    eng = Engine(a.lang, a.voice)
    spoken = speak(a.text, a.lang)
    audio = trim(eng.synth(spoken, seed=a.seed, temperature=a.temperature))
    sf.write(a.out, audio, SR)
    print(spoken, prosody.features(audio))


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
    s.add_argument("-s", "--seed", type=int, default=0); s.add_argument("-T", "--temperature", type=float, default=0.3)
    s.add_argument("-o", "--out", default="say.wav"); s.set_defaults(fn=cmd_say)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
