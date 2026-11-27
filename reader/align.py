"""Forced alignment of the known text to a take (MMS, multilingual): word timings + per-word confidence."""
from __future__ import annotations

import functools
import re

import numpy as np
from unidecode import unidecode

SR_IN = 24000
SR = 16000
PAD = 0.3


@functools.lru_cache(maxsize=1)
def _model():
    import torch
    from torchaudio.pipelines import MMS_FA
    import ctypes
    import gc
    model = MMS_FA.get_model(with_star=False).eval()
    # quantize in place and hand the freed full-precision weights back to the system: otherwise ~3 GB stays
    # resident for a model that needs ~0.6 GB
    model = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8, inplace=True)
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass
    return model, MMS_FA.get_dict(star=None)


def words(text: str) -> list[str]:
    return [w for w in re.sub(r"[^a-z' ]", " ", unidecode(text).lower().replace("’", "'")).split() if w.strip("'")]


def _resample(audio: np.ndarray, sr: int) -> np.ndarray:
    if sr == SR:
        return audio
    import torch, torchaudio
    return torchaudio.functional.resample(torch.from_numpy(audio.astype(np.float32)), sr, SR).numpy()


WINDOW, OVERLAP = 20.0, 1.0      # seconds: long clips are scored in windows (attention memory grows with length²)


def _emissions(model, wav):
    """Per-frame character log-probabilities. A 90 s sentence in one pass needs gigabytes for attention; in 20 s
    windows (with 1 s of shared context each side, trimmed off) it needs tens of megabytes."""
    import torch
    n = wav.shape[1]
    if n <= (WINDOW + 2 * OVERLAP) * SR:
        em, _ = model(wav)
        return torch.log_softmax(em, dim=-1)
    step, ov, parts = int(WINDOW * SR), int(OVERLAP * SR), []
    for s0 in range(0, n, step):
        a, b, s1 = max(0, s0 - ov), min(n, s0 + step + ov), min(n, s0 + step)
        em, _ = model(wav[:, a:b])
        per = em.shape[1] / (b - a)                               # frames per sample in this window
        parts.append(em[:, round((s0 - a) * per): round((s1 - a) * per)])
    return torch.log_softmax(torch.cat(parts, dim=1), dim=-1)


def align(audio: np.ndarray, text: str, sr: int = SR_IN) -> list[dict]:
    """[{word, start, end, score}] in seconds (relative to `audio`). Empty if nothing alignable."""
    import torch, torchaudio
    model, dictionary = _model()
    ws = words(text)
    ws = [w for w in ws if any(c in dictionary for c in w)]
    if not ws:
        return []
    tokens = [dictionary[c] for w in ws for c in w if c in dictionary]
    pad = np.zeros(int(PAD * SR), np.float32)   # CTC needs a little context around short clips
    wav = torch.from_numpy(np.concatenate([pad, _resample(audio, sr), pad]))[None]
    with torch.inference_mode():
        em = _emissions(model, wav)
    if em.shape[1] < len(tokens):
        return [dict(word=w, start=0.0, end=0.0, score=0.0) for w in ws]
    ali, scores = torchaudio.functional.forced_align(em, torch.tensor([tokens], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(ali[0], scores[0].exp())
    ratio = wav.shape[1] / em.shape[1] / SR
    out, i = [], 0
    for w in ws:
        n = sum(1 for c in w if c in dictionary)
        sp = spans[i:i + n]
        i += n
        out.append(dict(word=w, start=round(max(0.0, sp[0].start * ratio - PAD), 3), end=round(max(0.0, sp[-1].end * ratio - PAD), 3),
                        score=round(float(np.mean([s.score for s in sp])), 3)))
    return out


def verdict(ali: list[dict], duration: float) -> tuple[bool, list[str]]:
    """Is the take faithful to the text? Returns (ok, reasons)."""
    if not ali:
        return True, []
    reasons = []
    bad = [a["word"] for a in ali if len(a["word"]) >= 3 and a["score"] < (0.1 if "'" in a["word"] else 0.3)]
    content = [a["score"] for a in ali if len(a["word"]) >= 3] or [a["score"] for a in ali]
    mean = float(np.mean(content))
    if bad:
        reasons.append("unclear: " + " ".join(bad[:4]))
    if len(ali) > 3 and mean < (0.45 if duration < 1.2 else 0.6):    # too few words for a meaningful mean
        reasons.append(f"low mean score {mean:.2f}")
    gaps = [b["start"] - a["end"] for a, b in zip(ali, ali[1:])]
    if gaps and max(gaps) > 1.3:
        reasons.append(f"gap {max(gaps):.1f}s (babble or hang)")
    if ali[-1]["end"] < duration - 1.2:
        reasons.append(f"{duration - ali[-1]['end']:.1f}s of audio after the last word")
    return not reasons, reasons
