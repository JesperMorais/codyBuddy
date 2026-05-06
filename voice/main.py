"""Kokoro TTS sidecar (and now silero-vad too).

Run: uvicorn main:app --port 31416

Plays audio on the host's default output device. Lazy-loads Kokoro on first
request so cold-start cost is paid once. If kokoro-onnx isn't installed, the
endpoint still responds 200 but logs a warning, so the daemon doesn't crash.

The /vad WebSocket endpoint adds streaming voice-activity detection via
silero-vad. The daemon connects, streams 16kHz mono Int16 PCM frames in,
and receives JSON events on speech.start / speech.end transitions. Same
graceful-degrade story as /tts: when silero-vad isn't installed, /vad
sends one error frame and closes cleanly so the daemon's reconnect loop
can give up rather than spin.
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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


# --------------------------------------------------------------------------
# Voice-activity detection — Task 10.1
# --------------------------------------------------------------------------

# silero-vad expects 16kHz mono Int16 PCM. Frames are 512 samples = 32ms
# at 16kHz, the model's native window. Smaller chunks are buffered until
# a full window is available; larger chunks are processed in 512-sample
# slices.
VAD_SAMPLE_RATE = 16_000
VAD_FRAME_SAMPLES = 512
VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * 2  # Int16 = 2 bytes/sample
# Hangover after the last "speech" frame before declaring speech.end.
# Without this, normal pauses inside a sentence emit churn.
VAD_END_HANGOVER_MS = 300
# Probability above which a frame counts as speech. Silero's defaults
# bias toward false positives on noisy mics; 0.5 is the recommended
# starting point in the model's README.
VAD_SPEECH_THRESHOLD = 0.5

_vad_lock = asyncio.Lock()
_vad_model = None
_vad_load_error: Optional[str] = None


def _load_silero_vad():
    """Lazy-load silero-vad. Returns the model on success or None on
    failure; the failure reason is cached so repeated /vad opens get a
    consistent error rather than re-paying the import cost each time."""
    global _vad_model, _vad_load_error
    if _vad_model is not None:
        return _vad_model
    if _vad_load_error is not None:
        return None
    try:
        import torch  # noqa: F401  — required by silero-vad
        from silero_vad import load_silero_vad

        _vad_model = load_silero_vad()
        log.info("silero-vad loaded")
        return _vad_model
    except Exception as exc:
        _vad_load_error = f"silero-vad-not-installed: {exc}"
        log.warning("silero-vad unavailable (%s); /vad will reject opens", exc)
        return None


def _pcm16_to_tensor(buf: bytes):
    """Convert raw Int16 PCM bytes to a [-1, 1] float32 torch tensor."""
    import torch

    count = len(buf) // 2
    if count == 0:
        return torch.zeros(0, dtype=torch.float32)
    samples = struct.unpack(f"<{count}h", buf[: count * 2])
    return torch.tensor(samples, dtype=torch.float32) / 32768.0


# --------------------------------------------------------------------------
# Streaming TTS — Task 10.3
# --------------------------------------------------------------------------
#
# Protocol on /tts/stream:
#   client → server  : text frame {"text": str, "voice": str?} per sentence
#                       Send a text frame {"done": true} to indicate
#                       end-of-utterance (server flushes any in-flight synth
#                       and then closes from its side).
#   server → client  : interleaved
#       text  {"type":"sentence_start","idx":N,"sample_rate":24000,"channels":1}
#       binary <PCM frame>           # 0..M frames of raw Int16 LE PCM
#       text  {"type":"sentence_done","idx":N}
#       …repeat for each accepted sentence…
#       text  {"type":"done"}        # all sentences flushed
#
# Each sentence is dispatched to a worker as soon as it arrives, so a
# slow second sentence doesn't block the first one's audio reaching
# the daemon. The "first audio chunk arrives <150ms after first
# sentence sent" budget is the test contract — see
# daemon/test/tts-stream.test.mjs.
#
# Graceful-degrade matches /vad and /tts: if kokoro_onnx isn't
# installed, the endpoint sends one {"type":"error",...} frame and
# closes 1011 so the daemon's reconnect loop can latch.

# Kokoro emits a single (samples, sample_rate) tuple per sentence; we
# slice that into ~80ms chunks so the daemon can start playback before
# the whole utterance is in hand. 80ms at 24kHz mono int16 = 3840
# bytes — small enough for low latency, large enough to keep WS
# overhead reasonable.
_TTS_STREAM_CHUNK_MS = 80


def _slice_int16(samples_array, sample_rate: int, chunk_ms: int):
    """Yields successive slices of a numpy/list-like int16 array, each
    `chunk_ms` long at `sample_rate`. The final slice is whatever
    remains. Bytes-only — converts each slice to a bytes object."""
    import numpy as np

    arr = np.asarray(samples_array)
    if arr.dtype != np.int16:
        # Kokoro returns float32 in [-1,1]; convert for the wire.
        arr = (np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16)
    samples_per_chunk = max(1, int(sample_rate * chunk_ms / 1000))
    for i in range(0, len(arr), samples_per_chunk):
        yield arr[i : i + samples_per_chunk].tobytes()


@app.websocket("/tts/stream")
async def tts_stream(ws: WebSocket):
    await ws.accept()

    # Lazy-load Kokoro through the same path /tts uses so we share the
    # cached engine across HTTP and WS callers.
    async with _tts_lock:
        kokoro = _load_kokoro()

    if not kokoro:
        await ws.send_text(
            json.dumps(
                {
                    "type": "error",
                    "reason": "kokoro-not-installed",
                }
            )
        )
        await ws.close(code=1011)
        return

    next_idx = 0
    inflight: list[asyncio.Task] = []
    send_lock = asyncio.Lock()

    async def synth_one(idx: int, text: str, voice: str):
        loop = asyncio.get_running_loop()
        try:
            samples, sample_rate = await loop.run_in_executor(
                None, lambda: kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
            )
        except Exception as exc:
            log.warning("/tts/stream synth failed for idx=%d: %s", idx, exc)
            async with send_lock:
                try:
                    await ws.send_text(
                        json.dumps({"type": "sentence_error", "idx": idx, "reason": str(exc)})
                    )
                except Exception:
                    pass
            return
        async with send_lock:
            try:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "sentence_start",
                            "idx": idx,
                            "sample_rate": int(sample_rate),
                            "channels": 1,
                        }
                    )
                )
                for chunk in _slice_int16(samples, int(sample_rate), _TTS_STREAM_CHUNK_MS):
                    await ws.send_bytes(chunk)
                await ws.send_text(json.dumps({"type": "sentence_done", "idx": idx}))
            except Exception as exc:
                log.warning("/tts/stream send failed for idx=%d: %s", idx, exc)

    try:
        while True:
            msg = await ws.receive_text()
            try:
                payload = json.loads(msg)
            except Exception:
                await ws.send_text(
                    json.dumps({"type": "error", "reason": f"bad json: {msg[:100]}"})
                )
                continue

            if payload.get("done"):
                # Flush in-flight synths, then signal done and close.
                if inflight:
                    await asyncio.gather(*inflight, return_exceptions=True)
                inflight.clear()
                async with send_lock:
                    try:
                        await ws.send_text(json.dumps({"type": "done"}))
                    except Exception:
                        pass
                await ws.close()
                return

            text = str(payload.get("text", "")).strip()
            if not text:
                continue
            voice = str(payload.get("voice") or _voice_id)
            idx = next_idx
            next_idx += 1
            inflight.append(asyncio.create_task(synth_one(idx, text, voice)))
            # Drop completed tasks so the list doesn't grow unbounded.
            inflight[:] = [t for t in inflight if not t.done()]
    except WebSocketDisconnect:
        # Client hung up mid-stream. Cancel any in-flight syntheses
        # so we don't keep CPU-burning Kokoro work the daemon will
        # never receive.
        for t in inflight:
            t.cancel()
        return
    except Exception as exc:
        log.warning("/tts/stream loop error: %s", exc)
        try:
            await ws.send_text(json.dumps({"type": "error", "reason": str(exc)}))
        except Exception:
            pass
        await ws.close(code=1011)


@app.websocket("/vad")
async def vad(ws: WebSocket):
    await ws.accept()

    async with _vad_lock:
        model = _load_silero_vad()

    if model is None:
        await ws.send_text(
            json.dumps(
                {
                    "type": "error",
                    "reason": _vad_load_error or "silero-vad unavailable",
                }
            )
        )
        await ws.close(code=1011)
        return

    # Reset model state per connection so prior speech doesn't leak in.
    model.reset_states()
    pcm_buffer = bytearray()
    samples_consumed = 0  # cumulative count for the ts field
    in_speech = False
    last_speech_ts_ms: Optional[float] = None

    def now_ms() -> float:
        # `ts` is the audio-stream offset in ms (sample-accurate),
        # not wall clock. This is what the daemon's reconcile path
        # cares about — wall-clock skew between sidecar and daemon
        # shouldn't perturb event timing.
        return (samples_consumed / VAD_SAMPLE_RATE) * 1000.0

    try:
        while True:
            chunk = await ws.receive_bytes()
            pcm_buffer.extend(chunk)

            while len(pcm_buffer) >= VAD_FRAME_BYTES:
                frame_bytes = bytes(pcm_buffer[:VAD_FRAME_BYTES])
                del pcm_buffer[:VAD_FRAME_BYTES]
                tensor = _pcm16_to_tensor(frame_bytes)
                samples_consumed += VAD_FRAME_SAMPLES
                prob = float(model(tensor, VAD_SAMPLE_RATE).item())
                ts = now_ms()

                if prob >= VAD_SPEECH_THRESHOLD:
                    last_speech_ts_ms = ts
                    if not in_speech:
                        in_speech = True
                        await ws.send_text(json.dumps({"type": "speech.start", "ts": ts}))
                else:
                    if (
                        in_speech
                        and last_speech_ts_ms is not None
                        and ts - last_speech_ts_ms >= VAD_END_HANGOVER_MS
                    ):
                        in_speech = False
                        await ws.send_text(
                            json.dumps({"type": "speech.end", "ts": last_speech_ts_ms})
                        )
                        last_speech_ts_ms = None
    except WebSocketDisconnect:
        # Normal client close — emit a final speech.end if mid-utterance
        # so downstream consumers don't dangle in "still speaking" forever.
        if in_speech and last_speech_ts_ms is not None:
            try:
                await ws.send_text(
                    json.dumps({"type": "speech.end", "ts": last_speech_ts_ms})
                )
            except Exception:
                pass
        return
    except Exception as exc:
        log.warning("/vad processing error: %s", exc)
        try:
            await ws.send_text(json.dumps({"type": "error", "reason": str(exc)}))
        except Exception:
            pass
        await ws.close(code=1011)
