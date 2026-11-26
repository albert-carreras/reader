# reader

A self-hosted, read-along audiobook player, built to replace ElevenReader.
1. Add an EPUB.
2. It's narrated by a local TTS (Phonon, CPU only) in the background.
3. Listen in the browser while the text follows along: sentence highlighted, word underlined.

- **Audio pipeline** (`reader/`). Detail in [DESIGN.md](DESIGN.md) §4.
  - The EPUB is parsed into chapters and blocks.
  - Text becomes speech units: dialogue vs narrator tags, intonation kinds, and spoken forms via the NeMo grammars plus book rules.
  - Each unit gets Phonon takes, scored on the pitch contour. Verification uses MMS forced alignment, which also yields word timings.
  - A PSOLA fix corrects endings when needed.
  - Units are assembled into ~75 s AAC segments.
- **Web app** (`reader/server.py`, `reader/web/`).
  - FastAPI with one background renderer that always works from wherever you are listening.
  - Vanilla-JS UI: library, book page, reader/player.
  - Controls: sentence and ±15 s skips, speed, chapter auto-advance, Media Session, keyboard, position sync.
- **Deploy:** [docs/deploy.md](docs/deploy.md). Same pattern as piso-radar and cfo: user service, Cloudflare Tunnel, Workers VPC edge, Cloudflare Access.

```
uv sync
./stack local                                    # http://127.0.0.1:8130
uv run reader render book.epub -c 3 -n 20        # CLI: render part of a chapter to renders/
uv run pytest -q                                 # text-normalisation regression cases
```
