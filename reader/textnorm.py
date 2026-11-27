"""Display text -> spoken text, per language. Our book-specific rules wrap NeMo grammars (zyphra_textnorm)."""
from __future__ import annotations

import functools
import re

ROMAN = re.compile(r"^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$")
ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}

SECTION_WORDS = {
    "es": r"cap[íi]tulo|cap\.|tomo|volumen|vol\.|libro|parte|canto|acto|escena|lecci[óo]n|art[íi]culo|jornada|tratado",
    "en": r"chapter|chap\.|book|part|volume|vol\.|act|scene|canto|stave|section|lesson|article|letter",
}
CHAPTER_WORD = {"es": "Capítulo", "en": "Chapter"}
YEAR_RANGE = re.compile(r"(?<![\d-])\b(1\d{3}|20\d{2})\s*[-–]\s*(\d{4}|\d{2})\b(?![-\d])")
PAGE_RANGE = re.compile(r"\b((?i:pages|page|pp\.|p\.|páginas|página|págs\.|pág\.|chapters|capítulos|verses|versículos|versos)\s+)(\d{1,4})\s*[-–]\s*(\d{1,4})\b")
CONJ = {"es": "a", "en": "to"}


def roman_to_int(s: str) -> int | None:
    s = s.upper()
    if not s or not ROMAN.match(s):
        return None
    total = 0
    for a, b in zip(s, s[1:] + " "):
        v = ROMAN_VALUES[a]
        total += -v if b != " " and ROMAN_VALUES.get(b, 0) > v else v
    return total


@functools.lru_cache(maxsize=1)
def _nemo():
    import zyphra_textnorm
    return zyphra_textnorm


def _caps_fix(s: str) -> str:
    letters = [c for c in s if c.isalpha()]
    if len(letters) >= 4 and sum(c.isupper() for c in letters) / len(letters) > 0.7:
        low = s.lower()
        return re.sub(r"(^|[.!?¿¡:]\s*)(\w)", lambda m: m.group(1) + m.group(2).upper(), low)
    # runs of capitalised words (small-caps openings: "ALTHOUGH I HAVE LOVED MANY, there...") read as normal words
    def run(m):
        words = m.group(0)
        low = re.sub(r"[A-ZÁÉÍÓÚÑÜ]+", lambda w: w.group(0) if w.group(0) == "I" else w.group(0).lower(), words)
        return low[:1].upper() + low[1:] if m.start() == 0 or re.search(r"[.!?¿¡:]\s*$", s[:m.start()]) else low
    s = re.sub(r"\b[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ'’]*(?:[\s,]+[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ'’]*)+\b",
               lambda m: run(m) if sum(c.isalpha() for c in m.group(0)) >= 6 and not all(roman_to_int(w) for w in re.findall(r"\w+", m.group(0))) else m.group(0), s)
    # single shouting words inside normal text: MARIANELA -> Marianela (keep short acronyms like BBC)
    return re.sub(r"\b([A-ZÁÉÍÓÚÑÜ]{5,})\b", lambda m: m.group(1).capitalize() if not roman_to_int(m.group(1)) else m.group(1), s)


def heading_speech(text: str, lang: str) -> str:
    """'I. Perdido.' -> 'Capítulo 1. Perdido.'; 'IV' -> 'Chapter 4'; 'Stave I: Marley's Ghost' -> 'Stave 1: ...'."""
    t = text.strip()
    m = re.match(r"^(?:(%s)\s+)?([IVXLCDM]+|\d+)\b\s*([.:—–-]\s*(.*))?$" % SECTION_WORDS[lang], t, re.I)
    if m:
        word, num, _, rest = m.groups()
        n = roman_to_int(num) if not num.isdigit() else int(num)
        if n:
            head = f"{word.capitalize() if word else CHAPTER_WORD[lang]} {n}"
            return f"{head}. {rest.strip()}" if rest and rest.strip() else head
    return t


def pre_rules(s: str, lang: str) -> str:
    # quotation marks never get spoken; apostrophes inside words stay
    s = re.sub(r"[«»“”„\"]", "", s)
    s = re.sub(r"(^|[\s(\[—])‘", r"\1", s)
    s = re.sub(r"’(?=[\s.,;:!?)\]—…]|$)", "", s)
    s = s.replace("‘", "")
    s = re.sub(r"[*†‡#_~|<>\[\]{}]", " ", s)
    s = re.sub(r"\.{3,}|…+", "…", s)
    # dashes used as parentheses inside a sentence read as commas
    s = re.sub(r"\s*[—―]\s*|\s+[–-]\s+", ", ", s).strip(" ,")     # spaced en/em dashes too ("life – Rachel")
    if lang == "es":
        # 19th-century orthography: the preposition/conjunctions written with an accent
        s = re.sub(r"(?<![\wÁÉÍÓÚáéíóú])([áéóúÁÉÓÚ])(?![\wÁÉÍÓÚáéíóú])", lambda m: {"á": "a", "é": "e", "ó": "o", "ú": "u", "Á": "A", "É": "E", "Ó": "O", "Ú": "U"}[m.group(1)], s)
    # ranges: years (1914-1918, 1990-91) and pages/chapters (pp. 111-222) read "a"/"to"; phone numbers don't
    s = YEAR_RANGE.sub(lambda m: m.group(0) if len(m.group(2)) == 4 and int(m.group(2)) <= int(m.group(1))
                       else f"{m.group(1)} {CONJ[lang]} {m.group(2)}", s)
    s = PAGE_RANGE.sub(lambda m: f"{m.group(1)}{m.group(2)} {CONJ[lang]} {m.group(3)}", s)
    # Roman numerals after section words read as cardinals: "capítulo IV" -> "capítulo 4". Numerals must be capitals
    # (not "book mix"), and in English a lone "I" is the pronoun ("the book I wanted") unless the section word is
    # capitalised ("Part I of") or punctuation follows ("in volume I.")
    def section(m):
        word, num = m.group(1), m.group(2)
        if lang == "en" and num == "I" and not word[:1].isupper() and not re.match(r"\s*([.,:;!?)\]—–-]|$)", s[m.end():]):
            return m.group(0)
        return f"{word} {roman_to_int(num) or num}"
    s = re.sub(r"\b((?i:%s))\s+([IVXLCDM]+)\b" % SECTION_WORDS[lang], section, s)
    if lang == "en":
        s = re.sub(r"\b([IVXLCDM]{2,})(?=\s+century)", lambda m: f"{roman_to_int(m.group(1))}th" if roman_to_int(m.group(1)) else m.group(1), s)
    return _caps_fix(s)


def post_rules(s: str, lang: str) -> str:
    s = re.sub(r"\s*\(\s*", ", ", s)
    s = re.sub(r"\s*\)\s*", ", ", s)
    s = re.sub(r"\s+([,.;:!?…])", r"\1", s)
    s = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", s)
    s = re.sub(r",\s*([.!?…])", r"\1", s)
    s = re.sub(r"([.!?…])\s*[,;:]+", r"\1", s)
    s = re.sub(r"^…\s*", "", s)
    s = re.sub(r"^[,;:\s]+", "", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    if lang == "es":
        s = re.sub(r"^([¿¡]+)\s*,\s*", r"\1", s)
    return s


def _normalize(s: str, lang: str) -> str:
    """NeMo slows down sharply on very long strings; normalise long sentences in clause-sized pieces
    (", " boundaries never split a number, date or abbreviation)."""
    if len(s) <= 300:
        return _nemo().normalize(s, language=lang)
    parts, cur = [], ""
    for piece in re.split(r"(?<=[,;:])\s+", s):
        if cur and len(cur) + len(piece) > 250:
            parts.append(cur)
            cur = piece
        else:
            cur = f"{cur} {piece}" if cur else piece
    if cur:
        parts.append(cur)
    return " ".join(_nemo().normalize(p, language=lang) for p in parts)


def speak(text: str, lang: str, heading: bool = False) -> str:
    s = heading_speech(text, lang) if heading else text
    s = pre_rules(s, lang)
    s = _normalize(s, lang)   # NeMo is conservative on plain prose (checked), so always run it
    return post_rules(s, lang)
