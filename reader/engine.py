"""Phonon TTS wrapper. Text arrives fully normalized, so Phonon's own rewrites are off."""
from __future__ import annotations

import functools
import os

import numpy as np

MODELS = {"en": "hf://gradium/phonon-31m-en", "es": "hf://gradium/phonon-40m-es"}
DEFAULT_VOICE = {"en": "Easton", "es": "Alba"}
SR = 24000
VERSION = "phonon-1"  # bump to invalidate cached takes


@functools.lru_cache(maxsize=4)
def _tts(lang: str, quant: str):
    import ptts
    ptts.set_num_threads(int(os.environ.get("READER_THREADS", "4")))
    return ptts.TTS(MODELS[lang], lang=lang, quant=quant, rewrites="none")


class Engine:
    def __init__(self, lang: str, voice: str | None = None, quant: str = "f32"):
        self.lang, self.voice, self.quant = lang, voice or DEFAULT_VOICE[lang], quant
        self.tts = _tts(lang, quant)

    @property
    def key(self) -> str:
        return f"{VERSION}:{self.lang}:{self.voice}:{self.quant}"

    def synth(self, text: str, seed: int, temperature: float = 0.3) -> np.ndarray:
        return np.asarray(self.tts.synth(text, voice=self.voice, seed=seed, temperature=temperature), dtype=np.float32)


def trim(audio: np.ndarray, sr: int = SR, thresh_db: float = -42.0, pad: float = 0.03) -> np.ndarray:
    """Cut leading/trailing silence (relative to the take's peak), keeping a short pad."""
    if audio.size == 0:
        return audio
    frame = int(sr * 0.01)
    n = len(audio) // frame
    if n == 0:
        return audio
    rms = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms / (rms.max() + 1e-12))
    on = np.where(db > thresh_db)[0]
    if on.size == 0:
        return audio
    s = max(0, on[0] * frame - int(pad * sr))
    e = min(len(audio), (on[-1] + 1) * frame + int(pad * sr))
    return audio[s:e]
