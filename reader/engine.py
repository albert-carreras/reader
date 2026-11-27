"""TTS engines. Text arrives fully normalized; a voice name picks its engine.

- Pocket TTS (Kyutai, 100M): the default since the blind intonation reels of 2026-11-27 (caro_davy for English,
  lola for Spanish). Its built-in voices include LibriVox narrators, prompts that read like a book rather than an ad.
- Phonon (Gradium, 31M/40M): the first engine. Its catalog voices are assistant and ad reads. Kept as an option.
"""
from __future__ import annotations

import functools
import os

import numpy as np

SR = 24000

POCKET_VERSION = "pocket-2"   # bump to invalidate cached Pocket takes
# Previous-sentence context (picked blind over plain takes in both languages, 2026-11-27): each sentence's voice
# prompt is the voice's reference clip followed by the end of the sentence before, so the model hears where the
# narration is coming from instead of starting every sentence fresh.
CONTEXT = os.environ.get("READER_CONTEXT", "1") == "1"
CONTEXT_REF_SECS, CONTEXT_PREV_SECS, CONTEXT_GAP_SECS = 8.0, 6.0, 0.25
POCKET_MODEL = {"en": "english", "es": "spanish"}
POCKET_VOICES = {
    "en": ["caro_davy", "peter_yearsley", "stuart_bell", "bill_boerst", "mary", "jane", "george", "michael", "eve",
           "alba", "anna", "vera", "charles", "paul"],
    "es": ["lola"],
}

PHONON_VERSION = "phonon-2"   # bump to invalidate cached Phonon takes
PHONON_MODELS = {"en": "hf://gradium/phonon-31m-en", "es": "hf://gradium/phonon-40m-es"}
# Native narration pace (Phonon's duration_delta conditioner). 0 = model default (~209 wpm es / ~236 wpm en);
# 1.0 measured ~177 / ~195 wpm with unchanged alignment scores and pitch variation. Saturates around 2.0.
PACE = {"es": 1.0, "en": 1.0}
PHONON_VOICES = {
    "es": ["Alba", "Noa", "Candela", "Celia", "Alicia", "Nerea", "Lucía-Sol", "Marcos", "Borja", "Iker", "Nuno", "Izan",
           "Guillermo", "Rebeca", "Regina", "Danae", "Azucena", "Jimena", "Ximena", "Lalo", "Aldo", "Yael", "Ulises", "Leonel", "Nico"],
    "en": ["Easton", "Micah", "Trevor", "Russell", "Preston", "Miles", "Zoey", "Juniper", "Everly", "Harper", "Hadley", "Delia",
           "Maeve", "Freya", "Pippa", "Elodie-Rose", "Imogen", "Lottie", "Bryony", "Alfie", "Hugh", "Edwin", "Spencer", "Toby", "Teddy"],
}

DEFAULT_VOICE = {"en": "caro_davy", "es": "lola"}
VOICES = {lang: POCKET_VOICES[lang] + PHONON_VOICES[lang] for lang in ("en", "es")}


def engine_of(lang: str, voice: str) -> str:
    return "pocket" if voice in POCKET_VOICES.get(lang, []) else "phonon"


def _threads() -> int:
    return int(os.environ.get("READER_THREADS", "4"))


@functools.lru_cache(maxsize=4)
def _phonon(lang: str, quant: str):
    import ptts
    ptts.set_num_threads(_threads())
    tts = ptts.TTS(PHONON_MODELS[lang], lang=lang, quant=quant, rewrites="none")
    tts.set_conditions({"duration_delta": PACE.get(lang, 0.0)})
    return tts


def quiet_logs() -> None:
    """Pocket logs five INFO lines per sentence (thousands an hour in the journal)."""
    import logging
    logging.getLogger("pocket_tts").setLevel(logging.WARNING)


def release() -> None:
    """Idle: stop the worker processes and unload every model, giving the memory back (they reload on demand)."""
    import ctypes
    import gc
    drop_pool()
    for f in (_pocket_model, _pocket_voice, _pocket_ref, _phonon):
        f.cache_clear()
    from . import align
    align._model.cache_clear()
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass


@functools.lru_cache(maxsize=2)
def _pocket_model(lang: str):
    import torch
    quiet_logs()
    n = torch.get_num_threads()
    from pocket_tts import TTSModel    # importing it pins torch to 1 thread (its model is fastest on one core) ...
    torch.set_num_threads(n)           # ... so give the rest (forced alignment) its threads back
    return TTSModel.load_model(language=POCKET_MODEL[lang])


@functools.lru_cache(maxsize=8)
def _pocket_voice(lang: str, voice: str):
    return _pocket_model(lang).get_state_for_audio_prompt(voice)


def _read_audio(path) -> np.ndarray:
    import subprocess
    import tempfile

    import soundfile as sf
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-ac", "1", "-ar", str(SR), tmp.name], check=True)
        audio, _ = sf.read(tmp.name, dtype="float32")
    return audio


def _encode(lang: str, audio: np.ndarray):
    """Audio -> Pocket's voice-prompt conditioning [1, frames, dim] (the costly part of a prompt: ~0.15 s per s)."""
    import torch
    return _pocket_model(lang)._encode_audio(torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))[None, None])


@functools.lru_cache(maxsize=8)
def _pocket_ref(lang: str, voice: str):
    """The voice's reference clip, encoded once."""
    from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES, download_if_necessary
    audio = _read_audio(download_if_necessary(_ORIGINS_OF_PREDEFINED_VOICES[voice]))
    return _encode(lang, audio[: int(SR * CONTEXT_REF_SECS)])


def context_state(lang: str, voice: str, prev: np.ndarray):
    """A voice prompt = reference clip + a short gap + the last seconds of the previous sentence. The reference is
    encoded once; only the tail is encoded per sentence (Pocket's own get_state_for_audio_prompt re-encodes it all)."""
    import torch
    from pocket_tts.data.audio_utils import end_on_pause
    from pocket_tts.models.tts_model import init_states
    m = _pocket_model(lang)
    tail = np.concatenate([np.zeros(int(SR * CONTEXT_GAP_SECS), np.float32), prev[-int(SR * CONTEXT_PREV_SECS):]])
    tail = end_on_pause(torch.from_numpy(tail)[None], SR)[0].numpy()
    prompt = torch.cat([_pocket_ref(lang, voice), _encode(lang, tail)], dim=1)
    if m.flow_lm.insert_bos_before_voice:
        prompt = torch.cat([m.flow_lm.bos_before_voice, prompt], dim=1)
    state = init_states(m.flow_lm, batch_size=1, sequence_length=prompt.shape[1])
    with torch.no_grad():
        m._run_flow_lm_and_increment_step(model_state=state, audio_conditioning=prompt)
    return state


class Engine:
    def __init__(self, lang: str, voice: str | None = None, quant: str = "f32"):
        self.lang, self.voice, self.quant = lang, voice or DEFAULT_VOICE[lang], quant
        self.kind = engine_of(lang, self.voice)
        self.can_synth = True      # models load on first use: the renderer's main process mostly only verifies

    @property
    def tts(self):
        return _pocket_model(self.lang) if self.kind == "pocket" else _phonon(self.lang, self.quant)

    @property
    def state(self):
        return _pocket_voice(self.lang, self.voice)

    @property
    def key(self) -> str:
        return self.key_for(self.lang, self.voice, self.quant)

    @staticmethod
    def key_for(lang: str, voice: str | None = None, quant: str = "f32") -> str:
        voice = voice or DEFAULT_VOICE[lang]
        if engine_of(lang, voice) == "pocket":
            return f"{POCKET_VERSION}:{lang}:{POCKET_MODEL[lang]}:{voice}"
        return f"{PHONON_VERSION}:{lang}:{voice}:{quant}:pace{PACE.get(lang, 0.0)}"

    @property
    def uses_context(self) -> bool:
        return self.kind == "pocket" and CONTEXT

    def synth(self, text: str, seed: int, temperature: float = 0.3, context: np.ndarray | None = None) -> np.ndarray:
        """`context`: the previous sentence's audio (Pocket only): it goes into the voice prompt."""
        if self.kind == "pocket":
            import torch
            state = context_state(self.lang, self.voice, context) if context is not None and self.uses_context else self.state
            torch.manual_seed(seed)        # a take = a seed (Pocket's temperature is fixed when the model loads)
            n = torch.get_num_threads()
            torch.set_num_threads(1)       # Pocket runs best on one core; encoding and verification use more
            try:
                return self.tts.generate_audio(state, text).numpy().reshape(-1).astype(np.float32)
            finally:
                torch.set_num_threads(n)
        return np.asarray(self.tts.synth(text, voice=self.voice, seed=seed, temperature=temperature), dtype=np.float32)


# ---------------------------------------------------------------- parallel synthesis (Pocket)
# Pocket speaks on one core, so the renderer keeps a few worker processes that synthesize upcoming sentences'
# first takes while the main process verifies and assembles. Each process loads its own model (they aren't
# thread-safe) and keeps it for the voices it has seen.

_pool = None
_pool_size = 0


_worker_threads_set = False


def synth_job(lang: str, voice: str, text: str, seed: int, context: np.ndarray | None = None) -> np.ndarray:
    """Runs in a worker process. Context encoding there uses a few threads (a fresh process would take all 16 and
    fight the main process's verification); the synthesis itself runs on one."""
    global _worker_threads_set
    if not _worker_threads_set:
        import torch
        _pocket_model(lang)                       # its import pins torch to 1 thread; then set ours
        torch.set_num_threads(int(os.environ.get("READER_WORKER_THREADS", "4")))
        _worker_threads_set = True
    audio = Engine(lang, voice).synth(text, seed, context=context)
    try:                                          # hand the sentence's scratch memory back (~0.35 GB per worker)
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass
    return audio


def synth_pool(size: int):
    """A process pool of `size` synthesizers (recreated when the size changes); None for size < 1."""
    global _pool, _pool_size
    if size < 1:
        return None
    if _pool is None or size != _pool_size:
        import multiprocessing
        from concurrent.futures import ProcessPoolExecutor
        if _pool is not None:
            _pool.shutdown(wait=False, cancel_futures=True)
        # each process reloads its model after 200 sentences: memory can't creep up over a long book
        _pool = ProcessPoolExecutor(max_workers=size, mp_context=multiprocessing.get_context("spawn"), max_tasks_per_child=200)
        _pool_size = size
    return _pool


def drop_pool():
    """After a broken worker: start fresh next time."""
    global _pool, _pool_size
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
    _pool, _pool_size = None, 0


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
