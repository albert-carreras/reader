# Reader: self-hosted read-along audiobooks (draft v0.1)

> The original design draft (2026-11-26), kept for its reasoning. Several decisions changed since: the engine is now
> Pocket TTS with previous-sentence context, and playback is one continuous MediaSource stream. See the README and
> [docs/roadmap.md](docs/roadmap.md).

Personal ElevenReader replacement. The laptop is the server, CPU only, served from bored.cat. The iPhone (PWA) is the main client.
Priorities, in order: **voice quality → listening UX → everything else**. Speed is secondary. Books render ahead of time, quietly.

---

## 1. Use cases

| # | Situation | What has to just work |
|---|---|---|
| U1 | **Commute, phone in pocket, AirPods** | Open the app, one tap to Continue. Lock screen and AirPods controls work. "What did she just say?" is one press. |
| U2 | **Adding a book** (EPUB from email, iCloud, a download) | Get it into the library from the iPhone in a few taps. Hear a voice preview of *this* book before committing hours of rendering. |
| U3 | **No signal** (metro, plane, abroad) | Downloaded books play fully offline. Progress syncs later. |
| U4 | **Reading along** on the sofa | The real book text, with the sentence being spoken highlighted and the word underlined. Tap any sentence to jump there. |
| U5 | **Reading without audio**, then listening later | One shared position. Read two chapters on the laptop at night, and the morning commute continues from the right sentence. |
| U6 | **Bedtime** | Sleep timer (minutes, or end of chapter) that fades out. Next day it resumes a few sentences back, not mid-word. |
| U7 | **A name is pronounced wrong** (fantasy names, an English word in a Spanish book) | Fix it once, hear the fix, and the whole book is corrected in the background. |
| U8 | **Laptop asleep or offline** | The app says so plainly and plays whatever is downloaded. It never shows a blank error. |
| U9 | **Several books going** | Library with progress. The render queue serves the book you're actually listening to first. |

## 2. Engine: Phonon (decided 2026-11-26)

Blind test on this laptop (same passage, loudness-matched). English: Kokoro > ZONOS3 > Phonon. Spanish: Phonon > ZONOS3 > Kokoro.
The user chose **Phonon for both languages** (`phonon-31m-en`, `phonon-40m-es`, f32 weights): one engine, fast, with a rewrite hook. The spare speed goes into quality (§4).
Speed at 4 threads: about 3.7× realtime (en) and 5.6× (es). A 10 h book renders in about 2–3 h, so streaming starts within seconds.
Rejected: Ming-3.0 (<0.1× on CPU), ZONOS3 (0.6×, came second), Kokoro (weak Spanish, misreads "1.200").

So the app has to make "ready-ahead" visible and honest:
- On add: *"Chapter 1 ready in ~6 min · whole book ~16 h (by tomorrow 10:40)"*.
- Player scrubber shows the rendered part like a video buffer bar. Each book shows *"Ready 3 h 20 m ahead of you"*.
- The renderer always prioritises: current book from the playhead forward (next ~2 h first), then the rest of that book, then other books.
- The CPU budget is a setting: threads, `nice 19`, and optional quiet hours. Default: 4 threads, never more than half the machine.

If the playhead catches up with rendering, playback **pauses at a sentence boundary** with *"Rendering ahead… ~2 min"*. It never cuts mid-word and never silently switches voice.

## 3. Screens (iPhone)

**Library**
- "Continue" hero card: cover, chapter, time left, big play.
- Grid of books with a progress ring and a render-state dot (ready / rendering / queued).
- `+` button: Files picker for an EPUB. See §5 for the share-sheet route.

**Book page (after upload)**
- Detected language (from the EPUB metadata, editable). Voice picker with a **10-second preview of this book's first paragraph** in each voice.
- Chapter list, with front and back matter (copyright, contents, acknowledgements) pre-unticked.
- Render estimate. "Download for offline": whole book, or "keep the next 5 h downloaded" automatically.

**Player: Listen mode** (default when playing; glanceable on the move)
- Cover blurred as the background. The current sentence large and centered, the current word emphasised, the previous and next sentences faded.
- Controls, thumb-reachable at the bottom:
  - `⟲ sentence` (tap = previous sentence, double-tap = previous paragraph)
  - `▶︎/⏸`
  - `⟳ sentence`
  - `-30 s` / `+30 s` as secondary buttons
  - speed (0.75–2.5×, pitch preserved, remembered per book)
  - sleep timer
  - chapter list
- Scrubber is per chapter and shows the rendered region. Labels: time left in the chapter and in the book, at the current speed.

**Player: Read mode** (swipe up from Listen, or tap the text)
- Full chapter text in the book's own structure (headings, italics, scene breaks). Spoken sentence highlighted, spoken word underlined.
- Auto-follow scroll. If you scroll away, follow pauses and a "⤓ Back to narrator" pill appears.
- Tap a sentence: menu with *Play from here* · *Bookmark* · *Fix pronunciation…*.
- Theme (light / sepia / dark / OLED black), font size, line spacing.

**Lock screen / AirPods (Media Session)**
- Shows the cover, book title and chapter title.
- Skip-back = previous sentence (falls back to −15 s). Skip-forward = next sentence (+15 s fallback). Scrubber = chapter.
- Smart resume: after a pause longer than 2 min, restart at the start of the sentence. After a pause longer than 1 h, go back two sentences.

## 4. Audio pipeline (built: `reader/`)

`book.py` parses the EPUB into chapters → blocks.
- Block kinds: heading / para / verse / scene break / quote / item.
- Skips hidden elements, page numbers, footnote markers, running heads, and front and back matter (title page, contents, copyright, colophon).
- Merges "I" + "Perdido." into one heading.

`segment.py` turns blocks into speech units.
- Dialogue structure: Spanish dashes, spaced or not; `“ ” ‘ ’ « »` quotes; speech vs narrator tag.
- Sentence split with pysbd. Clause split only for sentences over 320 chars.
- Each unit gets an intonation kind (statement / yes-no / wh / exclamation / continuation / trailing) and a structural pause.
- A verse stanza is one unit, with a breath at line ends.

`textnorm.py` produces the spoken form: NeMo grammars (zyphra_textnorm) plus book rules.
- Book rules cover heading speech ("Capítulo uno."), year ranges, Roman numerals after section words, 1800s accents (á → a), quote and dash removal, and ALL-CAPS.
- Regression cases live in `tests/test_text.py`.

`render.py` handles each unit:
1. **Takes:** Phonon (f32) with deterministic seeds. Up to 4 takes, stopping as soon as the contour fits the kind. Dialogue always gets 2 takes, and the livelier one wins.
2. **Scoring** (`prosody.py`, Praat pitch): fit of the final contour, register and pace consistency with the running voice stats, and liveliness for dialogue.
3. **Verification** (`align.py`): MMS forced alignment of the known text. Per-word confidence catches skipped or garbled words, gaps and trailing babble. It also yields word timings for highlighting.
4. **Last-resort fix** (`reshape.py`): if the chosen take still has the wrong ending, PSOLA reshapes the last ~0.45 s of pitch. Off / mild / strong; the corrected file is stored next to the original.
5. **Cache:** per unit, keyed by engine + kind + spoken text.

`assemble()` trims silences, levels each unit (±4 dB), adds the structural pauses and 6 ms fades, and writes the chapter wav, `.m4a`, and a timeline JSON (unit and word times).

Measured at 4 threads with `nice 10`: about **1.4–1.6× realtime**, ~1.3–1.6 takes per unit, 0 flags on the Marianela and Alice samples.

Measurements that drove the design:
- Phonon English statements often end rising (5/6 seeds on one sentence).
- Spanish wh-questions rise on 4/6 seeds.
- Comma fragments always fall, hence no comma splitting.
- Yes/no questions always rise correctly.

## 5. Getting books in (iOS has no PWA share target)
1. `+` in the app → Files picker. Works with iCloud Drive, Downloads and Mail attachments saved to Files.
2. **iOS Shortcut "Send to Reader"** in the share sheet. It POSTs the EPUB to `/api/upload` with a personal token, so books can be shared straight from Mail, Safari downloads or Books exports.
3. Laptop: drag and drop in the web UI, or drop the file into `~/reader/inbox/`.

## 6. Architecture (sketch)
- **Server** (on the laptop): one FastAPI app with SQLite and files on disk.
  - The **render worker** is a separate process per TTS engine, each in its own venv because the engines have conflicting dependency pins. It runs at a low priority under the CPU budget.
  - Behind nginx at `read.bored.cat` (TLS like the other bored.cat sites). Single user: password login, long-lived cookie. The Shortcut uses a separate upload token.
- **Data model:** book → chapter → block (heading/paragraph) → sentence. Each sentence has a stable id, used as *the* position for both reading and listening. Audio is cached per sentence, with timings and word offsets.
- **Delivery to iOS:**
  - Online: a per-chapter **HLS playlist**. Safari plays it natively and it can grow while the chapter is still rendering. Background and lock-screen playback are handled by iOS.
  - Offline: the server assembles a single `.m4a` per finished chapter. The app stores it in IndexedDB (with `navigator.storage.persist()`) and plays it from a blob URL.
  - Timing JSON per chapter drives the highlighting.
- **Client:** a PWA (installable to the home screen) with one `<audio>` element, the Media Session API, and a service worker for the app shell and offline data.

## 7. Risks to prototype first (on the real iPhone)
1. Background playback across a chapter change (switching `src` on `ended` while the screen is locked).
2. Native HLS with a growing (EVENT) playlist in a home-screen web app.
3. Offline blob playback after the app has been killed, and storage persistence.
4. Lock-screen skip buttons mapped to sentence jumps (how iOS labels them).

## 8. Later / maybe
Multiple voices for dialogue vs narration · PDFs and web articles · m4b export · bookmarks export · per-book voice blends.
