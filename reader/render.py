"""Render units with take selection (intonation + consistency) and verification, then assemble a chapter."""
from __future__ import annotations

import hashlib
import json
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from . import align, prosody
from .engine import SR, Engine, trim
from .segment import Unit

import os
MAX_TAKES = int(os.environ.get("READER_MAX_TAKES", "4"))
TEMPS = [0.3, 0.5, 0.5, 0.7]
MIN_SPEECH_TAKES = int(os.environ.get("READER_SPEECH_TAKES", "2"))
RESHAPE = os.environ.get("READER_RESHAPE", "mild")      # off | mild | strong
# kind -> (needs fixing?, target final delta in semitones for mild / strong)
RESHAPE_RULES = {
    "statement": (lambda d: d > 1.0, {"mild": -1.5, "strong": -3.0}),
    "wh": (lambda d: d > 2.5, {"mild": -0.5, "strong": -2.0}),
    "yesno": (lambda d: d < 1.5, {"mild": 3.5, "strong": 5.0}),
}


def acceptable(kind: str, f: dict | None) -> bool:
    """Is this contour good enough to stop generating more takes?"""
    if f is None:
        return False
    d = f["final_delta"]
    return {
        "statement": d < -1.0,
        "yesno": d > 3.0,
        "wh": d < 1.0,
        "exclaim": f["range_st"] > 6.0,
        "continuation": d > -5.0,
        "trailing": d > -5.5,
        "heading": d < 0.5,
    }.get(kind, True)


@dataclass
class VoiceStats:
    """Running picture of the voice, so takes stay consistent from sentence to sentence."""
    hz: list[float] = field(default_factory=list)
    cps: list[float] = field(default_factory=list)   # spoken chars per second

    def median_hz(self):
        return float(np.median(self.hz)) if len(self.hz) >= 5 else None

    def median_cps(self):
        return float(np.median(self.cps)) if len(self.cps) >= 5 else None


def _seed(text: str, k: int) -> int:
    return (zlib.crc32(text.encode()) * 7919 + k * 104729) % (2**31)


def score_take(u: Unit, audio: np.ndarray, f: dict | None, stats: VoiceStats) -> tuple[float, dict]:
    parts = {"fit": prosody.fit(u.kind, f, stats.median_hz())}
    if f and u.role == "speech" and len(u.spoken) >= 12:
        parts["lively"] = float(np.clip((f["std_st"] - 2.5) * 0.4, -0.6, 0.8))   # dialogue should not be flat
    if f and stats.median_hz() and len(u.spoken) >= 20:
        off = abs(12 * np.log2(f["median_hz"] / stats.median_hz()))
        parts["register"] = -max(0.0, off - 1.0) * 0.6          # don't jump register between sentences
    cps = len(u.spoken) / max(len(audio) / SR, 0.1)
    if stats.median_cps() and len(u.spoken) > 25:
        r = cps / stats.median_cps()
        parts["pace"] = -max(0.0, abs(np.log(r)) - 0.15) * 4    # don't rush or drag
    return float(sum(parts.values())), parts


def render_unit(u: Unit, eng: Engine, stats: VoiceStats, cache: Path) -> dict:
    key = hashlib.sha1(f"{eng.key}|{u.kind}|{u.spoken}".encode()).hexdigest()[:16]
    wav_p, meta_p = cache / f"{key}.wav", cache / f"{key}.json"
    if wav_p.exists() and meta_p.exists():
        meta = json.loads(meta_p.read_text())
        _maybe_reshape(meta, cache, meta_p)
        _learn(stats, meta)
        return meta
    t0 = time.time()
    takes = []
    max_takes = MAX_TAKES if len(u.spoken) <= 400 else min(MAX_TAKES, 2)   # long sentences: contour matters less, cost more
    for k in range(max_takes):
        audio = trim(eng.synth(u.spoken, seed=_seed(u.spoken, k), temperature=TEMPS[k]))
        f = prosody.features(audio)
        s, parts = score_take(u, audio, f, stats)
        takes.append(dict(k=k, audio=audio, f=f, score=s, parts=parts))
        min_takes = MIN_SPEECH_TAKES if u.role == "speech" and len(u.spoken) >= 12 else 1
        if k + 1 >= min_takes and acceptable(u.kind, f) and parts.get("register", 0) > -0.5 and parts.get("pace", 0) > -0.5:
            break
    synth_s = time.time() - t0
    chosen, flags = None, []
    for t in sorted(takes, key=lambda t: -t["score"]):
        ali = align.align(t["audio"], u.spoken)
        dur = len(t["audio"]) / SR
        ok, reasons = align.verdict(ali, dur)
        if ali and ali[-1]["end"] < dur - 0.4:      # trailing noise after the last word: cut it
            t["audio"] = t["audio"][: int((ali[-1]["end"] + 0.12) * SR)]
            ok, reasons = align.verdict(ali, len(t["audio"]) / SR)
        t["ali"], t["reasons"] = ali, reasons
        if ok:
            chosen = t
            break
        flags.append(f"take {t['k']}: {'; '.join(reasons)}")
    if chosen is None:  # nothing verified: keep the best-sounding take, flag it for review
        chosen = max(takes, key=lambda t: t["score"])
        flags.append("UNVERIFIED")
    sf.write(wav_p, chosen["audio"], SR, subtype="PCM_16")
    meta = dict(unit=u.id, key=key, spoken=u.spoken, kind=u.kind, role=u.role, take=chosen["k"], n_takes=len(takes),
                score=round(chosen["score"], 2), parts={k: round(v, 2) for k, v in chosen["parts"].items()},
                features={k: round(v, 2) for k, v in (chosen["f"] or {}).items()},
                duration=round(len(chosen["audio"]) / SR, 3), words=chosen.get("ali", []), flags=flags,
                secs=round(time.time() - t0, 2), synth_secs=round(synth_s, 2))
    meta_p.write_text(json.dumps(meta, ensure_ascii=False))
    _maybe_reshape(meta, cache, meta_p)
    _learn(stats, meta)
    return meta


def _maybe_reshape(meta: dict, cache: Path, meta_p: Path) -> None:
    """If the chosen take still has the wrong ending, store a PSOLA-corrected version next to it."""
    if RESHAPE == "off" or meta["kind"] not in RESHAPE_RULES or not meta.get("features"):
        return
    done = meta.setdefault("reshaped", {})
    if RESHAPE in done:
        return
    needs, targets = RESHAPE_RULES[meta["kind"]]
    shift = 0.0
    if needs(meta["features"]["final_delta"]):
        from .reshape import final_contour
        audio, _ = sf.read(cache / f"{meta['key']}.wav", dtype="float32")
        fixed, shift = final_contour(audio, targets[RESHAPE], max_shift=5.0 if RESHAPE == "mild" else 8.0)
        if shift:
            sf.write(cache / f"{meta['key']}.{RESHAPE}.wav", fixed, SR, subtype="PCM_16")
    done[RESHAPE] = round(shift, 2)
    meta_p.write_text(json.dumps(meta, ensure_ascii=False))


def take_path(meta: dict, cache: Path) -> Path:
    if RESHAPE != "off" and (meta.get("reshaped") or {}).get(RESHAPE):
        return cache / f"{meta['key']}.{RESHAPE}.wav"
    return cache / f"{meta['key']}.wav"

def _learn(stats: VoiceStats, meta: dict):
    f = meta.get("features") or {}
    if f.get("median_hz") and meta["kind"] in ("statement", "continuation"):
        stats.hz.append(f["median_hz"])
    if len(meta["spoken"]) > 25 and meta["duration"] > 0:
        stats.cps.append(len(meta["spoken"]) / meta["duration"])


# ---------------------------------------------------------------- assembly

def _level(audio: np.ndarray, target_db: float = -20.0, max_gain_db: float = 4.0) -> np.ndarray:
    rms = np.sqrt(np.mean(audio ** 2) + 1e-12)
    gain_db = np.clip(target_db - 20 * np.log10(rms), -max_gain_db, max_gain_db)
    return audio * (10 ** (gain_db / 20))


def _fade(audio: np.ndarray, ms: float = 6) -> np.ndarray:
    n = min(len(audio) // 2, int(SR * ms / 1000))
    if n:
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        audio = audio.copy()
        audio[:n] *= ramp
        audio[-n:] *= ramp[::-1]
    return audio


def assemble(units: list[Unit], metas: list[dict], cache: Path, out_wav: Path, lead_in: float = 0.4) -> dict:
    pieces = [np.zeros(int(SR * lead_in), np.float32)]
    t = lead_in
    timeline = []
    for u, m in zip(units, metas):
        a, _ = sf.read(take_path(m, cache), dtype="float32")
        a = _fade(_level(a))
        timeline.append(dict(unit=u.id, key=m["key"], block=u.block, start_char=u.start, end_char=u.end, t0=round(t, 3),
                             t1=round(t + len(a) / SR, 3),
                             words=[dict(w=w["word"], t0=round(t + w["start"], 3), t1=round(t + w["end"], 3)) for w in m["words"]]))
        pieces += [a, np.zeros(int(SR * u.pause), np.float32)]
        t += len(a) / SR + u.pause
    audio = np.concatenate(pieces)
    peak = np.max(np.abs(audio)) + 1e-9
    if peak > 0.97:
        audio *= 0.97 / peak
    sf.write(out_wav, audio, SR, subtype="PCM_16")
    return dict(duration=round(len(audio) / SR, 2), units=timeline)
