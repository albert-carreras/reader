"""Pitch features of a take and how well they fit what the sentence needs (question rise, statement fall, ...)."""
from __future__ import annotations

import numpy as np
import parselmouth

SR = 24000


def features(audio: np.ndarray, sr: int = SR) -> dict | None:
    snd = parselmouth.Sound(audio.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=70, pitch_ceiling=500)
    f0 = pitch.selected_array["frequency"]
    t = pitch.xs()
    voiced = f0 > 0
    if voiced.sum() < 8:
        return None
    st = 12 * np.log2(f0[voiced] / np.median(f0[voiced]))      # semitones around the take's own median
    tv = t[voiced]
    # final contour: last ~350 ms of voiced speech, ignoring the very last 2 frames (creak)
    end = tv[-1]
    win = (tv >= end - 0.35) & (tv <= end - 0.02)
    if win.sum() < 4:
        win = tv >= end - 0.5
    fin_t, fin_st = tv[win], st[win]
    slope = float(np.polyfit(fin_t, fin_st, 1)[0]) if len(fin_t) >= 3 else 0.0
    # rise/fall over the final window relative to the level just before it
    pre = st[(tv >= end - 0.9) & (tv < end - 0.35)]
    base = float(np.median(pre)) if len(pre) >= 3 else float(np.median(st))
    final_delta = float(np.median(fin_st[-4:]) - base)
    return dict(
        median_hz=float(np.median(f0[voiced])),
        range_st=float(np.percentile(st, 95) - np.percentile(st, 5)),
        std_st=float(np.std(st)),
        final_slope=slope,          # semitones / s over the last 350 ms
        final_delta=final_delta,    # semitones, end vs the stretch just before
        voiced_ratio=float(voiced.mean()),
    )


def fit(kind: str, f: dict | None, voice_median_hz: float | None = None) -> float:
    """Higher is better. Roughly: 0 = neutral, +2 = clearly what we want, negative = wrong contour."""
    if f is None:
        return -5.0
    d, rng, sd = f["final_delta"], f["range_st"], f["std_st"]
    score = 0.0
    # liveliness: penalise monotone takes, and wild ones
    score += np.clip(sd - 1.5, -1.5, 1.0) - max(0.0, sd - 5.0)
    if kind == "yesno":
        score += np.clip(d / 2.0, -2.0, 3.0)                 # want a clear final rise
    elif kind == "wh":
        score += 0.5 * np.clip(rng / 6.0, 0, 1.5) - max(0.0, d - 3.0) * 0.3   # fall or level is fine; avoid strong rise
    elif kind == "exclaim":
        score += np.clip((rng - 6.0) / 3.0, -1.5, 2.0)      # wide pitch range
        score -= max(0.0, d - 5.0) * 0.4                    # but a big final rise turns it into a question
        if voice_median_hz:
            score += np.clip(12 * np.log2(f["median_hz"] / voice_median_hz) / 2.0, -1.0, 1.5)   # raised register
    elif kind == "statement":
        score += np.clip(-d / 2.0, -2.5, 1.0)               # want a fall; punish uptalk
    elif kind in ("continuation", "trailing"):
        score += -max(0.0, -d - 3.0) * 0.5                  # don't sound finished
    return float(score)
