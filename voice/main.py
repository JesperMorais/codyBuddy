"""Kokoro TTS sidecar.

Run: uvicorn main:app --port 31416

Plays audio on the host's default output device. Lazy-loads Kokoro on first
request so cold-start cost is paid once. If kokoro-onnx isn't installed, the
endpoint still responds 200 but logs a warning, so the daemon doesn't crash.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="[voice] %(message)s")
log = logging.getLogger("voice")

app = FastAPI()

_tts_lock = asyncio.Lock()
_kokoro = None
_voice_id = "af_sarah"


class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = None


def _load_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    try:
        from kokoro_onnx import Kokoro

        _kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
        log.info("kokoro loaded")
    except Exception as exc:
        log.warning("kokoro unavailable (%s); /tts will be a no-op", exc)
        _kokoro = False
    return _kokoro


def _play(samples, sample_rate):
    try:
        import sounddevice as sd

        sd.play(samples, sample_rate)
        sd.wait()
    except Exception as exc:
        log.warning("playback failed: %s", exc)


@app.post("/tts")
async def tts(req: SpeakRequest):
    text = req.text.strip()
    if not text:
        return {"ok": True, "skipped": "empty"}

    async with _tts_lock:
        kokoro = _load_kokoro()
        if not kokoro:
            log.info("would have spoken: %s", text)
            return {"ok": True, "skipped": "kokoro-not-installed", "text": text}

        voice = req.voice or _voice_id
        loop = asyncio.get_running_loop()
        samples, sample_rate = await loop.run_in_executor(
            None, lambda: kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
        )
        await loop.run_in_executor(None, _play, samples, sample_rate)
        return {"ok": True, "spoken": text}


@app.get("/health")
def health():
    return {"ok": True}
