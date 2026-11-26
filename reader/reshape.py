"""Last-resort intonation fix: reshape the final pitch contour with PSOLA (Praat), keeping timing and voice."""
from __future__ import annotations

import numpy as np
import parselmouth
from parselmouth.praat import call

from . import prosody

SR = 24000


def final_contour(audio: np.ndarray, target_delta: float, window: float = 0.45, max_shift: float = 6.0,
                  sr: int = SR) -> tuple[np.ndarray, float]:
    """Ramp the pitch of the last `window` seconds of speech so the ending moves toward `target_delta` semitones."""
    f = prosody.features(audio, sr)
    if f is None:
        return audio, 0.0
    shift = float(np.clip(target_delta - f["final_delta"], -max_shift, max_shift))
    if abs(shift) < 0.5:
        return audio, 0.0
    snd = parselmouth.Sound(audio.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=70, pitch_ceiling=500)
    tv = pitch.xs()[pitch.selected_array["frequency"] > 0]
    t_end, end = float(tv[-1]), snd.get_total_duration()
    t_start = t_end - window
    manip = call(snd, "To Manipulation", 0.01, 70, 500)
    tier = call(manip, "Extract pitch tier")
    n = int(call(tier, "Get number of points"))
    pts = [(call(tier, "Get time from index", i), call(tier, "Get value at index", i)) for i in range(1, n + 1)]
    call(tier, "Remove points between", t_start, end)
    for t, v in pts:
        if t >= t_start:
            k = min(1.0, (t - t_start) / window)
            call(tier, "Add point", t, v * 2 ** (shift * k / 12))
    call([tier, manip], "Replace pitch tier")
    out = call(manip, "Get resynthesis (overlap-add)")
    return np.asarray(out.values[0], np.float32)[: len(audio)], shift
