"""Blocks -> speech units: dialogue vs narration, sentence split, intonation kind, pauses."""
from __future__ import annotations

import functools
import re
from dataclasses import dataclass, asdict

from .book import Block, Chapter
from .textnorm import speak

RAYA = "—―"
MAX_CHARS = 1500         # Phonon reads 2,700-char sentences cleanly; only split beyond this (clauses first)
WH = {
    "es": r"((pero|y|e|o|pues|entonces|mas)\s+)?((a|de|en|por|para|con|hacia|desde|hasta|sin|sobre|entre)\s+)?(qu[ée]|qui[ée]n(es)?|c[óo]mo|d[óo]nde|ad[óo]nde|cu[áa]ndo|cu[áa]nt[oa]s?|cu[áa]l(es)?|por qu[ée]|para qu[ée]|de d[óo]nde|a qui[ée]n|con qui[ée]n|de qui[ée]n|en qu[ée]|a qu[ée])",
    "en": r"((but|and|so|then|oh|well)\s*,?\s+)?(what|who|whom|whose|which|where|when|why|how)",
}

# Pauses in seconds. Measured human read-aloud: 0.2-1.4 s after sentences, longer after longer sentences
# (up to x1.4); paragraph breaks clearly longer than sentence breaks. Sentence/paragraph pauses scale with length.
P = dict(sentence=0.40, question=0.48, exclaim=0.46, continuation=0.18, trailing=0.65, inner_tag=0.20,
         paragraph=0.85, dialogue_turn=0.70, heading=1.3, scene=2.0, verse_line=0.45, stanza=1.0, chapter_end=2.5)


def _scaled(base: float, chars: int, full: int = 260, extra: float = 0.4) -> float:
    """Longer sentences/paragraphs earn a longer breath afterwards (up to +40%)."""
    return round(base * (1 + extra * min(1.0, chars / full)), 3)


@dataclass
class Unit:
    id: str
    block: int
    start: int          # char span in the block's display text
    end: int
    text: str           # display text
    spoken: str         # what the TTS reads
    role: str           # narration | speech | tag | heading | verse
    kind: str           # statement | yesno | wh | exclaim | continuation | trailing | heading
    pause: float = 0.0  # silence after this unit

    def to_dict(self):
        return asdict(self)


@functools.lru_cache(maxsize=4)
def _sbd(lang: str):
    import pysbd
    return pysbd.Segmenter(language=lang if lang in ("es", "en") else "en", clean=False, char_span=True)


# ---------------------------------------------------------------- phrase split (dialogue structure)

def _raya_phrases(text: str) -> list[tuple[int, int, str]]:
    """Paragraph opening with a raya: alternate speech / narrator at every raya (spaced or not)."""
    lead = len(text) - len(text.lstrip())
    pos = [i for i, c in enumerate(text) if c in RAYA]
    if not pos or pos[0] != lead:
        return [(0, len(text), "narration")]
    bounds = pos + [len(text)]
    out, role = [], "speech"
    for a, b in zip(bounds, bounds[1:]):
        out.append((a + 1, b, role))
        role = "tag" if role == "speech" else "speech"
    return out


QUOTE_PAIRS = [("“", "”"), ("«", "»"), ('"', '"'), ("‘", "’")]


def _quote_phrases(text: str) -> list[tuple[int, int, str]]:
    """Split on quotation marks: inside = speech, outside = narration/tag."""
    spans, i, n = [], 0, len(text)
    while i < n:
        hit = None
        for o, c in QUOTE_PAIRS:
            j = text.find(o, i)
            if j < 0 or (o == "‘" and j > 0 and text[j - 1].isalpha()):
                continue
            if hit is None or j < hit[0]:
                hit = (j, o, c)
        if hit is None:
            break
        j, o, c = hit
        k = j + 1
        while True:
            k = text.find(c, k)
            if k < 0 or c != "’" or k + 1 >= n or not text[k + 1].isalpha():
                break
            k += 1  # apostrophe inside a word, keep looking
        if k < 0:
            break
        if _speechlike(text[j + 1:k], any(r == "speech" for *_, r in spans)):
            if j > i:
                spans.append((i, j, "narration"))
            spans.append((j + 1, k, "speech"))
            i = k + 1
        else:                       # a quoted word or title ("sack", "The Raven"): stays inside the sentence
            spans.append((i, k + 1, "narration"))
            i = k + 1
    if i < n:
        spans.append((i, n, "narration"))
    merged = []                     # join the narration pieces that quoted mentions left behind
    for a, b, r in spans:
        if merged and r == "narration" and merged[-1][2] == "narration" and merged[-1][1] == a:
            merged[-1] = (merged[-1][0], b, r)
        else:
            merged.append((a, b, r))
    spans = merged
    has_speech = any(r == "speech" for *_, r in spans)
    def role(a, b, r):
        if r != "narration" or not has_speech:
            return r
        seg = text[a:b].strip()
        return "tag" if len(seg) < 100 or seg[:1].islower() else "narration"
    return [(a, b, role(a, b, r)) for a, b, r in spans] or [(0, n, "narration")]


def _speechlike(q: str, after_speech: bool) -> bool:
    """Is a quoted span someone talking? Dialogue starts with a capital (or continues an earlier quote) and ends in
    punctuation, or runs to a few words. A single quoted word or a short title is a mention, not dialogue."""
    q = q.strip()
    words = len(re.findall(r"\w+", q))
    starts = after_speech or q[:1].isupper() or q[:1] in "¿¡"
    return (starts or words >= 4) and (bool(re.search(r"[.,;:!?…—-]$", q)) or words >= 4)


def _phrases(text: str) -> list[tuple[int, int, str]]:
    if text.lstrip()[:1] in RAYA:
        return _raya_phrases(text)
    if re.search(r"[“«\"‘]", text):
        return _quote_phrases(text)
    return [(0, len(text), "narration")]


# ---------------------------------------------------------------- sentences

SAFE_END = re.compile(r"[.!?…][\"»”’)]*\s+(?=[A-ZÁÉÍÓÚÑ¿¡—«“])")
ABBREV = re.compile(r"(?:^|\s)(?:[A-Z]|Sr|Sra|Srta|Dr|Dra|Mr|Mrs|Ms|St|Ud|Uds|Vd|Dña|D|etc|p|pág|núm|vol|cap)$")


def _pieces(a: int, b: int, text: str, size: int = 2500) -> list[tuple[int, int]]:
    """pysbd is quadratic on huge paragraphs: pre-cut them at unambiguous sentence ends."""
    if b - a <= size * 1.2:
        return [(a, b)]
    out, start = [], a
    for m in SAFE_END.finditer(text, a, b):
        if ABBREV.search(text[max(a, m.start() - 6):m.start()]):
            continue
        if m.end() - start >= size:
            out.append((start, m.end()))
            start = m.end()
    out.append((start, b))
    return out


def _sentences(text: str, a: int, b: int, lang: str) -> list[tuple[int, int]]:
    if b - a > 3000:
        return [se for pa, pb in _pieces(a, b, text) for se in _sentences_one(text, pa, pb, lang)]
    return _sentences_one(text, a, b, lang)


def _sentences_one(text: str, a: int, b: int, lang: str) -> list[tuple[int, int]]:
    chunk = text[a:b]
    if not chunk.strip():
        return []
    out = []
    for span in _sbd(lang).segment(chunk):
        s, e = a + span.start, a + span.end
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if e > s and re.search(r"\w", text[s:e]):
            out.append((s, e))
    return out


def _split_long(text: str, s: int, e: int) -> list[tuple[int, int]]:
    if e - s <= MAX_CHARS:
        return [(s, e)]
    seg = text[s:e]
    mid = len(seg) / 2
    good = [m.end() for m in re.finditer(r"[;:](\s|$)|\s[—–]\s|\)\s", seg) if 60 <= m.end() <= len(seg) - 40]
    if not good:
        good = [m.end() for m in re.finditer(r",\s", seg) if 60 <= m.end() <= len(seg) - 40]
    if not good:
        good = [m.start() for m in re.finditer(r"\s(y|e|o|pero|que|and|but|or|which|that)\s", seg) if 40 <= m.start() <= len(seg) - 30]
    if not good:
        return [(s, e)]
    cut = min(good, key=lambda c: abs(c - mid))
    left, right = (s, s + cut), (s + cut, e)
    while right[0] < e and text[right[0]].isspace():
        right = (right[0] + 1, e)
    return _split_long(text, *left) + _split_long(text, *right)


def _kind(t: str, lang: str, last_in_sentence: bool) -> str:
    core = re.sub(r"[\s«»“”\"’'—―)\]]+$", "", t)
    if not last_in_sentence:
        return "continuation"
    if core.endswith("?"):
        q = core[core.rfind("¿") + 1:] if "¿" in core else core
        q = re.sub(r"^[\s«“\"‘(]+", "", q).lower()
        return "wh" if re.match(WH[lang] + r"\b", q) else "yesno"
    if core.endswith("!"):
        return "exclaim"
    if core.endswith("…") or core.endswith("..."):
        return "trailing"
    if core[-1:] == ":":
        return "statement"
    if core[-1:] in ",;":
        return "continuation"
    return "statement"


def _end_pause(kind: str, chars: int = 0) -> float:
    if kind == "continuation":
        return P["continuation"]
    base = {"yesno": P["question"], "wh": P["question"], "exclaim": P["exclaim"], "trailing": P["trailing"]}.get(kind, P["sentence"])
    return _scaled(base, chars)


def _join_dialogue(bu: list[Unit], text: str) -> list[Unit]:
    """One sentence split by quotes or rayas is voiced as one unit: “I’m sorry,” he said, “it’s just that…” reads as
    a single breath with the tag dropped in, instead of three fragments that each end like a sentence (Pocket turns a
    trailing comma into a full stop). Joined: a piece that ends mid-sentence and whatever continues it, and a
    lowercase tag after a question or exclamation (“Really?” she asked). An action beat in its own sentence
    (“Biscuit looked thoughtful.”) stays separate."""
    out: list[Unit] = []
    for v in bu:
        u = out[-1] if out else None
        joins = u is not None and len(u.spoken) + len(v.spoken) < MAX_CHARS and (     # (giant sentences split on purpose stay split)
            u.kind == "continuation" or (u.role == "speech" and v.role == "tag" and v.text.lstrip("—― ")[:1].islower()))
        if not joins:
            out.append(v)
            continue
        out[-1] = Unit("", u.block, u.start, v.end, text[u.start:v.end], f"{u.spoken} {v.spoken}",
                       "speech" if "speech" in (u.role, v.role) else u.role, v.kind, v.pause)
    return out


# ---------------------------------------------------------------- chapter -> units

def units(ch: Chapter, lang: str) -> list[Unit]:
    out: list[Unit] = []
    n = 0
    for bi, blk in enumerate(ch.blocks):
        if blk.kind == "scene_break":
            if out:
                out[-1].pause = max(out[-1].pause, P["scene"])
            continue
        if blk.kind == "heading":
            if out:
                out[-1].pause = max(out[-1].pause, P["heading"])
            out.append(Unit(f"{ch.index:03d}.{bi:04d}.00", bi, 0, len(blk.text), blk.text,
                            speak(blk.text, lang, heading=True), "heading", "heading", P["heading"]))
            continue
        if blk.kind == "verse":
            # a stanza is spoken in one go (flow), in chunks of whole lines if long; line ends get a light breath
            groups, cur = [], []
            for line in blk.lines:
                if cur and sum(len(l) for l in cur) + len(line) > MAX_CHARS:
                    groups.append(cur); cur = []
                cur.append(line)
            if cur:
                groups.append(cur)
            pos = 0
            for gi, lines in enumerate(groups):
                start = blk.text.find(lines[0], pos)
                end = blk.text.find(lines[-1], start) + len(lines[-1])
                pos = end
                spoken = " ".join(l if re.search(r"[.,;:!?…—]$", l) else l + "," for l in lines)
                k = _kind(lines[-1], lang, True)
                out.append(Unit(f"{ch.index:03d}.{bi:04d}.{gi:02d}", bi, start, end, blk.text[start:end],
                                speak(spoken, lang), "verse", k, P["verse_line"] * 1.5))
            out[-1].pause = P["stanza"]
            if out[-1].spoken.endswith(","):
                out[-1].spoken = out[-1].spoken[:-1] + "."
            continue
        text = blk.text
        bu: list[Unit] = []
        for a, b, role in _phrases(text):
            sents = _sentences(text, a, b, lang)
            for si, (s, e) in enumerate(sents):
                parts = _split_long(text, s, e)
                for pi, (ps, pe) in enumerate(parts):
                    disp = text[ps:pe]
                    spoken = speak(disp, lang)
                    if not re.search(r"\w", spoken):
                        continue
                    last = pi == len(parts) - 1
                    kind = _kind(disp, lang, last)
                    bu.append(Unit("", bi, ps, pe, disp, spoken, role, kind, _end_pause(kind, pe - ps)))
        # pauses between dialogue and its tag are short when the speech continues
        for u, v in zip(bu, bu[1:]):
            if u.role != v.role:
                u.pause = P["inner_tag"] if u.kind == "continuation" or v.role == "tag" and v.text[:1].islower() else min(u.pause, 0.3)
        # terminal punctuation for units that lost it (tags, split speech): punctuation sitting
        # between this unit and the next (e.g. the "." after a closing raya) decides how it ends
        for j, u in enumerate(bu):
            if u.spoken and u.spoken[-1] not in ".!?…,;:":
                gap = text[u.end: bu[j + 1].start] if j + 1 < len(bu) else text[u.end:]
                p = next((c for c in gap if c in ".!?…,;:"), None)
                if p in (".", "!", "?", "…"):
                    u.spoken += p
                    u.kind = _kind(u.spoken, lang, True)
                    u.pause = _end_pause(u.kind, u.end - u.start)
                elif j + 1 < len(bu):
                    u.spoken += ","
                    u.kind, u.pause = "continuation", P["inner_tag"]
                else:
                    u.spoken += "."
        bu = _join_dialogue(bu, text)
        if bu:
            nxt = next((b for b in ch.blocks[bi + 1:] if b.kind != "scene_break"), None)
            turn = nxt is not None and (nxt.text.lstrip()[:1] in RAYA + "“«\"‘")
            para = P["dialogue_turn"] if turn else _scaled(P["paragraph"], len(text), full=700, extra=0.3)
            bu[-1].pause = max(bu[-1].pause, para)
        for j, u in enumerate(bu):
            u.id = f"{ch.index:03d}.{bi:04d}.{j:02d}"
        out += bu
        n += len(bu)
    if out:
        out[-1].pause = P["chapter_end"]
    return out
