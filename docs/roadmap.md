# Roadmap: making the reading and the app as good as possible

**Decided 2026-11-26 (owner):** few features, each solid. Dropped:
- re-roll / pronunciation-fix UI
- sleep timer
- bookmarks
- export
- character voices

**Done in pipeline 2:**
- narration pace (Phonon duration_delta 1.0: ~187 wpm in Spanish)
- YouTube-style speed control
- length-scaled pauses
- mastering: −19 LUFS, peaks −3 dB, room tone
- rewind on resume after any stop, snapped to a pause in the speech
- one continuous file per finished chapter
- retry on network loss
- local + server position
- one-tap continue
- installable web app (manifest, icons, service worker)

**Next:** confirm background audio on the iPhone with the screen locked, including across chapter changes.

Impact/effort: **H/M/L**. Measurements are from our own output (Temporada de huracanes, ch. II, 2026-11-26).

## A. Narration (how it sounds)

1. **Narration pace** (H/S). We measure 226–243 wpm; the usual audiobook figure is ~150–160 wpm.
   - Slowing with playback speed is time-stretching. Phonon's `duration_delta` conditioner slows the voice natively.
   - Test it, then offer a per-book "pace" setting.
2. **Pauses that breathe** (H/S). Ours are fixed at 0.32 s between sentences and 0.7 s between paragraphs.
   - Measured human readers pause 0.2–1.4 s after sentences, longer after long ones (up to ×1.4).
   - Scale pauses with sentence length, and add a relaxed / normal / brisk pacing preset.
3. **Audiobook mastering** (M/S). Peaks are at −2.1 dB (spec: ≤ −3 dB). The gaps are digital silence (spec: room tone, noise floor ≤ −60 dB).
   - Add a limiter with a −3 dB ceiling, consistent loudness, and a faint room-tone bed in pauses.
4. **"Re-roll this sentence"** (H/M). Tap a sentence → 3 alternative takes → pick one → it replaces the original in place. You become the final judge of intonation.
5. **Pronunciation dictionary** (H/M). Tap a word → type how it should sound → only the sentences containing it are re-rendered. Per book and global. Voice Dream has this.
6. **Review list** (M/S). Per chapter: sentences that were flagged, unverified or reshaped, each with a play button and a re-roll button.
7. **Foreign words** (M/M). English words in a Spanish book and vice versa: detect them, then respell or flag them for review.
8. **phonon-40m-en for English** (M/S). Vendor blind-test score 2117 vs 2098 for the 31m model we use. A/B it with Easton.
9. **Footnotes on demand** (M/S). Tap a marker to hear or read the note, instead of dropping notes entirely.
10. **Character voices for dialogue** (H/L, experimental).
    - Attribute quotes to speakers (BookNLP for English, an LLM pass for Spanish), then give each character a voice.
    - VoxNovel and Audiobooker do this. A simpler first step: one alternate voice for all quoted speech.

## B. Listening

11. **Sleep timer** (H/S). Minutes or end of chapter, with a fade-out. Standard in ElevenReader and Audible.
12. **Gapless segment hand-off** (M/M). Preload the next segment into a second audio element so there's no hiccup every ~75 s.
13. **Bookmarks and clips with notes** (M/M). Per-book list, exportable to Markdown.
14. **Skip and resume settings** (L/S). Configurable skip interval (10/15/30 s), finer speed steps, and smart-rewind length.
15. **Time remaining** (M/S). Show time left in the chapter and book at the current speed, plus how far ahead audio is ready.
16. **Render queue control and "book ready" notification** (M/S). Choose which books render, pause rendering, and get a push when a book is done (ntfy, as in piso).

## C. Reading

17. **Keep the book's formatting** (H/M). Italics, bold, small caps, block quotes and images; today the text is plain.
18. **Highlight style** (M/S). Sentence / word / both / off, plus a focus mode that dims everything else. Studies find no comprehension difference between styles, so it's personal preference.
19. **Read without audio, same position** (M/M). A reading mode that keeps your place, then listening continues from where you stopped reading.
20. **Search, contents, typography** (M/S). In-book search, a table of contents with progress, a toggle to include front/back matter, and choice of font, line height and margins.
21. **Look-up and bilingual** (M/L). Tap a word to define it or translate the sentence. Parallel mode for books you have in both languages (as with Melchor): switch language at the same paragraph.

## D. Library and import

22. **m4b export with chapters** (M/S). Play in any audiobook app; also a stopgap for offline listening on the iPhone.
23. **Re-process after pipeline upgrades** (M/S). Version the text pipeline and re-segment books when it changes. Cached takes survive.
24. **More sources** (M/L). Web articles by URL, and PDF.

## E. iPhone (when we get there)

25. **Installable web app with offline downloads** (H/L). Risk: iOS 26 home-screen web apps have open WebKit bugs.
    - Audio breaks after the app is relaunched; lock-screen controls go dead; Now Playing opens the wrong app.
    - Prototype on the real phone first. Fall back to a Safari tab or m4b export, or a thin native shell.
26. **"Send to reader" iOS Shortcut** in the share sheet (L/S).

## F. Robustness

27. Renderer in its own process, cache cleanup when voices change, and tests for timing and assembly (L/S).
