"""XTTS-v2 sidecar — Task 12.3.

Run: uvicorn xtts:app --port 31417

A FastAPI sidecar that exposes coqui XTTS-v2 to the daemon for
voice-cloned, character-rich TTS. XTTS handles the heavy personalities
(drill_sergeant, pirate, shakespearean, rude — see Task 12.4); Kokoro
keeps the lightweight everyday voices (Task 12.2).

Endpoints:
  GET  /health  — cheap liveness probe; 200 + {ok, xtts_loaded}.
  POST /synth   — body {text, ref_clip, language}; streams 24kHz mono
                  Int16 PCM back when XTTS is loaded. When the `TTS`
                  package isn't installed it returns 200 + JSON
                  {ok: false, skipped: "xtts-not-installed"} so the
                  daemon's TTS bridge can branch and fall back to
                  another engine without crashing.
                  When XTTS is loaded but the ref_clip path doesn't
                  exist on disk, returns 200 + JSON
                  {ok: false, error: "ref_clip not found"}.

GPU note: XTTS-v2 is heavy (~1.5GB model + torch). On CUDA it hits
real-time on a midrange GPU; the CPU fallback works but runs ~3×
slower than real-time, which means a sentence's audio arrives only
after the user has already moved on. Recommend GPU for live use.

This sidecar only handles synthesis — playback stays on the daemon's
side. Kokoro's main.py plays via sounddevice locally because its
streaming path is built around in-process audio; XTTS is heavier and
fanned out to a sibling process so the daemon can route raw PCM to
its existing audio sink (PowerShell MediaPlayer on Windows).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="[xtts] %(message)s")
log = logging.getLogger("xtts")

app = FastAPI()

# XTTS-v2 outputs 24kHz mono. Pinned here so callers don't have to
# probe — daemon-side StreamingTtsBridge can pre-configure the audio
# sink before the first chunk arrives.
XTTS_SAMPLE_RATE = 24_000
# Slice the synthesised waveform into 80ms chunks for the wire. Same
# trade-off as Kokoro's /tts/stream: small enough to start playback
# before the whole utterance is in hand, large enough to keep HTTP
# overhead reasonable.
CHUNK_MS = 80

_xtts_lock = asyncio.Lock()
_xtts: Any = None
_xtts_load_error: Optional[str] = None


class SynthRequest(BaseModel):
    text: str
    ref_clip: str
    language: Optional[str] = "en"
    # Task 12.5: per-personality prosody multipliers. XTTS-v2's
    # TTS.tts() takes a `speed` arg directly (mapped from `rate`);
    # `energy` is applied as a post-synth amplitude scale and
    # `pause_factor` extends the trailing silence (best-effort,
    # since XTTS doesn't expose either knob natively).
    rate: Optional[float] = 1.0
    energy: Optional[float] = 1.0
    pause_factor: Optional[float] = 1.0


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _load_xtts():
    """Lazy-load XTTS-v2. Returns the loaded TTS handle on success or
    None on failure. The failure reason is cached so repeated /synth
    calls don't re-pay the import cost — they immediately graceful-
    degrade once the daemon has been told the engine isn't there."""
    global _xtts, _xtts_load_error
    if _xtts is not None:
        return _xtts if _xtts is not False else None
    if _xtts_load_error is not None:
        return None
    try:
        # `TTS` is the coqui-ai package on PyPI. Import is what's
        # expensive — first call can take 5-10s on cold CPU.
        from TTS.api import TTS

        device = "cuda" if _cuda_available() else "cpu"
        tts = TTS(
            model_name="tts_models/multilingual/multi-dataset/xtts_v2",
            progress_bar=False,
        ).to(device)
        log.info("xtts-v2 loaded on %s", device)
        _xtts = tts
        return _xtts
    except Exception as exc:
        _xtts_load_error = f"xtts-not-installed: {exc}"
        log.warning(
            "xtts-v2 unavailable (%s); /synth will graceful-degrade", exc
        )
        _xtts = False
        return None


@app.get("/health")
def health():
    # Cheap probe — does NOT trigger lazy load. The daemon's supervisor
    # uses /health for readiness; making it heavy would push first-byte
    # latency for the actual synth call somewhere it doesn't belong.
    loaded = _xtts not in (None, False)
    return {"ok": True, "xtts_loaded": loaded}


@app.post("/synth")
async def synth(req: SynthRequest):
    text = (req.text or "").strip()
    if not text:
        return JSONResponse({"ok": False, "skipped": "empty"})

    async with _xtts_lock:
        tts = _load_xtts()

    if tts is None:
        log.info("would have synthesized: %r (ref=%s)", text[:80], req.ref_clip)
        return JSONResponse(
            {
                "ok": False,
                "skipped": _xtts_load_error or "xtts-not-installed",
                "text": text,
            }
        )

    ref = Path(req.ref_clip)
    if not ref.exists():
        return JSONResponse(
            {
                "ok": False,
                "error": f"ref_clip not found: {req.ref_clip}",
            }
        )

    # Clamp prosody multipliers to a sensible range. XTTS-v2 accepts
    # `speed` in roughly [0.5, 2.0]; values outside that range either
    # produce unintelligible audio or are silently clamped by the
    # model anyway.
    rate = max(0.5, min(2.0, float(req.rate or 1.0)))
    energy = max(0.0, min(2.0, float(req.energy or 1.0)))
    pause_factor = max(0.5, min(3.0, float(req.pause_factor or 1.0)))

    loop = asyncio.get_running_loop()
    try:
        samples = await loop.run_in_executor(
            None,
            lambda: tts.tts(
                text=text,
                speaker_wav=str(ref),
                language=req.language or "en",
                speed=rate,
            ),
        )
    except Exception as exc:
        log.warning("synth failed: %s", exc)
        return JSONResponse({"ok": False, "error": f"synth failed: {exc}"})

    def chunked():
        import numpy as np

        arr = np.asarray(samples)
        # Apply energy as an amplitude scale before int16 conversion
        # so the clip-clamp at int16 boundaries lines up with the
        # scaled signal, not the original.
        if arr.dtype != np.int16:
            scaled = arr.astype(np.float32) * energy
            arr = (np.clip(scaled, -1.0, 1.0) * 32767).astype(np.int16)
        else:
            # Already int16 — apply energy in int space, clipping at
            # int16 bounds.
            scaled = arr.astype(np.int32) * energy
            arr = np.clip(scaled, -32768, 32767).astype(np.int16)
        # Pause-factor: append trailing silence proportional to
        # (pause_factor - 1) * one-sentence-pause. This is what
        # users actually feel between sentences in a multi-sentence
        # turn — XTTS itself emits no trailing silence, so the
        # sidecar appends it.
        if pause_factor > 1.0:
            base_pause_ms = 200  # natural inter-sentence pause
            extra_ms = int(base_pause_ms * (pause_factor - 1.0))
            tail_samples = int(XTTS_SAMPLE_RATE * extra_ms / 1000)
            if tail_samples > 0:
                tail = np.zeros(tail_samples, dtype=np.int16)
                arr = np.concatenate([arr, tail])
        chunk_samples = max(1, int(XTTS_SAMPLE_RATE * CHUNK_MS / 1000))
        for i in range(0, len(arr), chunk_samples):
            yield arr[i : i + chunk_samples].tobytes()

    media_type = f"audio/L16;rate={XTTS_SAMPLE_RATE};channels=1"
    headers = {
        "X-Sample-Rate": str(XTTS_SAMPLE_RATE),
        "X-Channels": "1",
    }
    return StreamingResponse(
        chunked(), media_type=media_type, headers=headers
    )
