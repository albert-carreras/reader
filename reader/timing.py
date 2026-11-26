"""Map aligned spoken words back onto the display text, so the page can highlight the word being read."""
from __future__ import annotations

import difflib
import re

from unidecode import unidecode

WORD = re.compile(r"\w+(?:['’]\w+)*")


def _norm(w: str) -> str:
    return re.sub(r"[^a-z']", "", unidecode(w).lower().replace("’", "'"))


def display_words(text: str, start: int, end: int) -> list[tuple[int, int, str]]:
    return [(start + m.start(), start + m.end(), _norm(m.group())) for m in WORD.finditer(text[start:end])]


def map_words(block_text: str, start: int, end: int, spoken: list[dict], t0: float, t1: float) -> list[list[float]]:
    """-> [[char_start, char_end, t_start, t_end], ...] for the display words of one unit (times absolute)."""
    disp = display_words(block_text, start, end)
    if not disp:
        return []
    a = [d[2] for d in disp]
    b = [w["w"] for w in spoken]
    times: list[tuple[float, float] | None] = [None] * len(disp)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                times[i1 + k] = (spoken[j1 + k]["t0"], spoken[j1 + k]["t1"])
        elif op == "replace" and j2 > j1:
            # e.g. "1808" spoken as "mil ochocientos ocho": share the spoken span across the display words
            s0, s1 = spoken[j1]["t0"], spoken[j2 - 1]["t1"]
            n = i2 - i1
            for k in range(n):
                times[i1 + k] = (s0 + (s1 - s0) * k / n, s0 + (s1 - s0) * (k + 1) / n)
    # fill gaps by interpolating between known neighbours
    known = [i for i, t in enumerate(times) if t]
    for i, t in enumerate(times):
        if t:
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        lo = times[prev][1] if prev is not None else t0
        hi = times[nxt][0] if nxt is not None else t1
        gap_lo = prev if prev is not None else -1
        gap_hi = nxt if nxt is not None else len(disp)
        n = gap_hi - gap_lo - 1
        k = i - gap_lo - 1
        times[i] = (lo + (hi - lo) * k / n, lo + (hi - lo) * (k + 1) / n)
    return [[s, e, round(tt[0], 3), round(tt[1], 3)] for (s, e, _), tt in zip(disp, times)]
