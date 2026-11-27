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
RESHAPE = os.environ.get("READER_RESHAPE", "mild")      # off | mild | strong
# One take per sentence (Pocket's single takes were preferred blind), with one exception: a take whose ending goes
# the wrong way for its kind gets a second seed before the pitch fix. Measured on 2,208 takes (2026-11-27): 62% of
# yes/no questions didn't rise, 1% of statements rose, 5% of wh-questions rose. About 4% more synthesis in all.
SECOND_TAKE = os.environ.get("READER_SECOND_TAKE", "1") == "1"
# Dead air: any quiet stretch longer than SQUASH_OVER inside a take is shortened to SQUASH_TO (first seen with
# Phonon, which stopped for 1-3 s mid-sentence; kept as a guard for any take).
SQUASH_OVER, SQUASH_TO, SQUASH_DB = 0.7, 0.4, -45.0
# kind -> (needs fixing?, target final delta in semitones for mild / strong)
RESHAPE_RULES = {
    "statement": (lambda d: d > 1.0, {"mild": -1.5, "strong": -3.0}),
    "wh": (lambda d: d > 2.5, {"mild": -0.5, "strong": -2.0}),
    "yesno": (lambda d: d < 1.5, {"mild": 3.5, "strong": 5.0}),
}


def wrong_ending(kind: str, f: dict | None) -> bool:
    """The take ends the wrong way for its kind (a statement rising, a yes/no question not rising): the same test
    that sends a take to the pitch fix."""
    rule = RESHAPE_RULES.get(kind)
    return bool(rule and f and rule[0](f["final_delta"]))


@dataclass
class VoiceStats:
    """Running picture of the voice, so takes stay consistent from sentence to sentence."""
    hz: list[float] = field(default_factory=list)
    cps: list[float] = field(default_factory=list)   # spoken chars per second

    def median_hz(self):
        return float(np.median(self.hz)) if len(self.hz) >= 5 else None

    def median_cps(self):
        return float(np.median(self.cps)) if len(self.cps) >= 5 else None


def squash_silence(audio: np.ndarray, sr: int = SR) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Shorten long dead air inside a take to a natural pause. Returns (audio, cuts): removed sample ranges."""
    frame = int(sr * 0.01)
    n = len(audio) // frame
    if n < 3:
        return audio, []
    rms = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    quiet = 20 * np.log10(rms / (rms.max() + 1e-12)) < SQUASH_DB
    cuts, i, half = [], 0, int(SQUASH_TO / 2 * sr)
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        if i > 0 and j < n and (j - i) * 0.01 > SQUASH_OVER:      # inside the take, not its edges
            cuts.append((i * frame + half, j * frame - half))
        i = j
    return apply_cuts(audio, cuts), cuts


def apply_cuts(audio: np.ndarray, cuts: list[tuple[int, int]]) -> np.ndarray:
    if not cuts:
        return audio
    keep, pos = [], 0
    for a, b in cuts:
        keep.append(audio[pos:a])
        pos = b
    keep.append(audio[pos:])
    return np.concatenate(keep)


def remap(t: float, cuts: list[tuple[int, int]], sr: int = SR) -> float:
    """A time in the original take -> the same moment after cuts."""
    shift = 0.0
    for a, b in cuts:
        if t >= b / sr:
            shift += (b - a) / sr
        elif t > a / sr:
            return a / sr - shift
    return t - shift


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


def key_for(engine_key: str, kind: str, spoken: str, ctx_id: str = "") -> str:
    """Cache key of a take. With context, it also names the sentence that was heard before (by its text, so a
    re-rolled previous take doesn't cascade)."""
    base = f"{engine_key}|{kind}|{spoken}" + (f"|after:{ctx_id}" if ctx_id else "")
    return hashlib.sha1(base.encode()).hexdigest()[:16]


def ctx_id(prev: Unit | dict | None) -> str:
    if prev is None:
        return ""
    kind, spoken = (prev["kind"], prev["spoken"]) if isinstance(prev, dict) else (prev.kind, prev.spoken)
    return hashlib.sha1(f"{kind}|{spoken}".encode()).hexdigest()[:12]


def unit_key(u: Unit, eng: Engine, ctx: str = "") -> str:
    return key_for(eng.key, u.kind, u.spoken, ctx if getattr(eng, "uses_context", False) else "")


def final_audio(meta: dict, cache: Path) -> np.ndarray:
    """The chosen take as it will be heard (before the ending fix), e.g. as context for the next sentence."""
    audio, _ = sf.read(cache / f"{meta['key']}.wav", dtype="float32")
    return audio


def render_unit(u: Unit, eng: Engine, stats: VoiceStats, cache: Path, first=None, ctx=None, on_first=None) -> dict:
    """`first`: a future holding take 0's raw audio, already being synthesized in a worker process.
    `ctx`: (ctx_id, audio) of the sentence before, for engines that use context.
    `on_first(audio)`: called with take 0 as soon as it exists (unless a second take follows), so the next sentence
    can start meanwhile."""
    ctx_key, ctx_audio = ctx if ctx is not None and getattr(eng, "uses_context", False) else ("", None)
    key = unit_key(u, eng, ctx_key)
    wav_p, meta_p = cache / f"{key}.wav", cache / f"{key}.json"
    if wav_p.exists() and meta_p.exists():
        meta = json.loads(meta_p.read_text())
        meta = _refresh_cached(u, eng, stats, cache, meta, meta_p)
        _maybe_reshape(meta, cache, meta_p)
        _learn(stats, meta)
        return meta
    t0 = time.time()
    audio = None
    if first is not None:
        try:
            audio = first.result()
        except Exception:  # noqa: BLE001  (a broken worker: synthesize here instead)
            audio = None
    takes = [_take(u, eng, stats, 0, audio, ctx_audio)]
    if SECOND_TAKE and wrong_ending(u.kind, takes[0]["f"]):
        takes.append(_take(u, eng, stats, 1, None, ctx_audio))      # the next sentence waits to hear the winner
    elif on_first is not None:
        on_first(takes[0]["audio"])
    synth_s = time.time() - t0
    flags = []
    # a right ending first (that's what a second take is for), then the score; the first of those that verifies
    ranked = sorted(takes, key=lambda t: (wrong_ending(u.kind, t["f"]), -t["score"]))
    chosen = next((t for t in ranked if _verified(t, u.spoken, flags)), None)
    if chosen is None:
        chosen = _retry(u, eng, stats, takes, flags, ctx_audio)
    sf.write(wav_p, chosen["audio"], SR, subtype="PCM_16")
    meta = _meta(u, key, chosen, takes, flags, t0, synth_s)
    meta_p.write_text(json.dumps(meta, ensure_ascii=False))
    _maybe_reshape(meta, cache, meta_p)
    _learn(stats, meta)
    return meta


def _take(u: Unit, eng: Engine, stats: VoiceStats, k: int, raw: np.ndarray | None = None,
          context: np.ndarray | None = None) -> dict:
    if raw is None:
        raw = eng.synth(u.spoken, seed=_seed(u.spoken, k), context=context)
    audio, _ = squash_silence(trim(raw))
    f = prosody.features(audio)
    s, parts = score_take(u, audio, f, stats)
    return dict(k=k, audio=audio, f=f, score=s, parts=parts)


def _verified(t: dict, spoken: str, flags: list) -> bool:
    """Forced alignment of the known text: is every word there and clear? Also cuts trailing noise and keeps the
    word timings. A failed take adds its reasons to `flags`."""
    ali = align.align(t["audio"], spoken)
    dur = len(t["audio"]) / SR
    ok, reasons = align.verdict(ali, dur)
    if ali and ali[-1]["end"] < dur - 0.4:      # trailing noise after the last word: cut it
        t["audio"] = t["audio"][: int((ali[-1]["end"] + 0.12) * SR)]
        ok, reasons = align.verdict(ali, len(t["audio"]) / SR)
    t["ali"], t["reasons"] = ali, reasons
    if not ok:
        flags.append(f"take {t['k']}: {'; '.join(reasons)}")
    return ok


def _retry(u: Unit, eng: Engine, stats: VoiceStats, takes: list, flags: list, context: np.ndarray | None = None) -> dict:
    """No take passed verification: one more seed before settling (Pocket's failures are mostly the checker's). If it
    fails too, the best-scoring take is kept and flagged UNVERIFIED (listed by `reader qa`)."""
    t = _take(u, eng, stats, max(t["k"] for t in takes) + 1, None, context)
    takes.append(t)
    if _verified(t, u.spoken, flags):
        flags.append("retried")
        return t
    flags.append("UNVERIFIED")
    return max(takes, key=lambda t: t["score"])


def _meta(u: Unit, key: str, chosen: dict, takes: list, flags: list, t0: float, synth_s: float) -> dict:
    return dict(unit=u.id, key=key, spoken=u.spoken, kind=u.kind, role=u.role, take=chosen["k"], n_takes=len(takes),
                score=round(chosen["score"], 2), parts={k: round(v, 2) for k, v in chosen["parts"].items()},
                features={k: round(v, 2) for k, v in (chosen["f"] or {}).items()},
                duration=round(len(chosen["audio"]) / SR, 3), words=chosen.get("ali", []), flags=flags,
                secs=round(time.time() - t0, 2), synth_secs=round(synth_s, 2), squashed=True, retried=True)


def _refresh_cached(u: Unit, eng: Engine, stats: VoiceStats, cache: Path, meta: dict, meta_p: Path) -> dict:
    """Bring a take cached by an older renderer up to date: squash its dead air (word timings move with it), and
    give unverified takes the extra seeds they never got."""
    wav_p = cache / f"{meta['key']}.wav"
    if not meta.get("squashed"):
        audio, _ = sf.read(wav_p, dtype="float32")
        audio, cuts = squash_silence(audio)
        if cuts:
            sf.write(wav_p, audio, SR, subtype="PCM_16")
            for var in cache.glob(f"{meta['key']}.*.wav"):          # reshaped endings: same cut points
                a2, _ = sf.read(var, dtype="float32")
                sf.write(var, apply_cuts(a2, cuts), SR, subtype="PCM_16")
            for w in meta["words"]:
                w["start"], w["end"] = round(remap(w["start"], cuts), 3), round(remap(w["end"], cuts), 3)
            meta["duration"] = round(len(audio) / SR, 3)
            if "UNVERIFIED" in meta["flags"]:                       # the dead air may have been all that was wrong
                t, fl = dict(k=meta["take"], audio=audio), []
                if _verified(t, u.spoken, fl):
                    sf.write(wav_p, t["audio"], SR, subtype="PCM_16")
                    meta.update(words=t["ali"], duration=round(len(t["audio"]) / SR, 3), flags=[f for f in meta["flags"] if f != "UNVERIFIED"] + ["verified after squash"])
        meta["squashed"] = True
        meta_p.write_text(json.dumps(meta, ensure_ascii=False))
    if "UNVERIFIED" in meta["flags"] and not meta.get("retried") and getattr(eng, "can_synth", False):
        audio, _ = sf.read(wav_p, dtype="float32")
        old = dict(k=meta["n_takes"] - 1, audio=audio, f=prosody.features(audio), score=meta["score"], parts=meta.get("parts", {}),
                   ali=meta["words"])            # k: new seeds start after the ones already tried
        takes, flags, t0 = [old], [f for f in meta["flags"] if f != "UNVERIFIED"], time.time()
        chosen = _retry(u, eng, stats, takes, flags)
        if flags[-1] != "UNVERIFIED":                # a new seed passed: it replaces the old take
            sf.write(wav_p, chosen["audio"], SR, subtype="PCM_16")
            for var in cache.glob(f"{meta['key']}.*.wav"):
                var.unlink()
            meta = _meta(u, meta["key"], chosen, takes, flags, t0, time.time() - t0)
        else:
            meta.update(flags=flags, retried=True)
        meta_p.write_text(json.dumps(meta, ensure_ascii=False))
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

ROOM_TONE_DB = -64.0   # audiobook spec wants room tone, noise floor <= -60 dB; digital silence sounds "dead"


def room_tone(n: int, seed: int = 0) -> np.ndarray:
    """A faint, warm noise bed (low-passed white noise) at ROOM_TONE_DB RMS."""
    from scipy.signal import lfilter
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n).astype(np.float32)
    k = np.exp(-2 * np.pi * 1200 / SR)        # one-pole low-pass ~1.2 kHz
    y = lfilter([1 - k], [1, -k], x).astype(np.float32)
    y *= (10 ** (ROOM_TONE_DB / 20)) / (np.sqrt(np.mean(y ** 2)) + 1e-12)
    return y

def _level(audio: np.ndarray, target_db: float = -19.0, max_gain_db: float = 4.0) -> np.ndarray:
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
    audio = audio + room_tone(len(audio), seed=zlib.crc32(out_wav.name.encode() + str(len(audio)).encode()))
    peak = np.max(np.abs(audio)) + 1e-9
    if peak > 0.97:                 # hard safety only; the real limiter (-3 dB ceiling) runs at encode time
        audio *= 0.97 / peak
    sf.write(out_wav, audio, SR, subtype="PCM_16")
    return dict(duration=round(len(audio) / SR, 2), units=timeline)
