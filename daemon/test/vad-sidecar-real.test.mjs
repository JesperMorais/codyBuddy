// Task 10.1 (the spec's "feed a fixture WAV with known speech segments;
// assert event timestamps within ±100ms" line). Skip-gated on:
//   1. Python + uvicorn + fastapi (so the sidecar boots)
//   2. silero-vad + torch importable from the same Python (so /vad
//      doesn't graceful-degrade)
//   3. The committed fixture WAV at daemon/test/fixtures/vad-speech-fixture.wav
//
// Fixture provenance: daemon/test/fixtures/vad-speech-fixture.wav is
// derived from /usr/share/sounds/alsa/Front_Center.wav (a male voice
// saying "Front Center", widely shipped with ALSA), resampled to
// 16kHz mono and padded with 500ms of silence on both ends:
//
//   [0 …  500ms]  silence
//   [500 … 1928ms] "Front Center" speech
//   [1928 … 2428ms] silence
//
// Expected events from /vad with the daemon's 300ms hangover:
//   speech.start.ts ≈ 500ms (within ±100ms)
//   speech.end.ts   ≈ 1928ms (within ±100ms — ts is the *last speech
//                              frame*, not the post-hangover wall time)
//
// Run: node --test daemon/test/vad-sidecar-real.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { createServer } from "node:net";

const { spawnVoiceSidecar } = await import("../dist/voice-sidecar.js");
const { VadBridge } = await import("../dist/vad-bridge.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const voiceDir = resolve(repoRoot, "voice");
const fixturePath = resolve(__dirname, "fixtures", "vad-speech-fixture.wav");

function findPython() {
  for (const cmd of ["python3", "python", "py"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "pipe" });
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

function pythonHas(python, mod) {
  try {
    execFileSync(python, ["-c", `import ${mod}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const python = findPython();
const skipReason = !python
  ? "python not on PATH"
  : !pythonHas(python, "uvicorn") || !pythonHas(python, "fastapi")
    ? "uvicorn or fastapi not importable"
    : !pythonHas(python, "silero_vad") || !pythonHas(python, "torch")
      ? "silero_vad or torch not importable (pip install -e voice/.[vad])"
      : !existsSync(fixturePath)
        ? `fixture WAV missing at ${fixturePath}`
        : undefined;

if (skipReason) console.log(`SKIP: vad fixture-WAV ±100ms — ${skipReason}`);

/** Parse a 16-bit PCM mono WAV file and return its sample buffer
 *  alongside the declared sample rate. Tolerates extra RIFF chunks
 *  (LIST/INFO etc.) by walking the chunk list to find "data".
 *  Throws on any unsupported format — we'd rather fail loud than
 *  feed silero-vad mis-shaped audio. */
function parseWavMono16(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let pcm;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") {
      const audioFormat = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bitsPerSample = body.readUInt16LE(14);
      if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error(`unsupported WAV format: pcm=${audioFormat} ch=${channels} bps=${bitsPerSample}`);
      }
    } else if (id === "data") {
      pcm = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!pcm) throw new Error("no data chunk");
  if (sampleRate !== 16_000) {
    throw new Error(`sample rate must be 16000Hz, got ${sampleRate}`);
  }
  return { pcm, sampleRate };
}

test(
  "10.1 (j) fixture WAV streamed through /vad emits speech.start/end with ts within ±100ms of expected",
  { skip: skipReason },
  async () => {
    const { pcm } = parseWavMono16(readFileSync(fixturePath));
    const port = await freePort();
    const sidecar = spawnVoiceSidecar({
      voiceDir,
      port,
      pythonBin: python,
      log: () => {},
    });

    try {
      const ready = await sidecar.waitForReady(20_000);
      if (!ready) {
        throw new Error("voice sidecar didn't become ready in 20s");
      }

      const events = [];
      const errors = [];
      const bridge = new VadBridge({
        url: `ws://127.0.0.1:${port}/vad`,
        log: () => {},
        reconnectMs: 0,
      });
      bridge.onSpeechStart((ts) => events.push({ type: "speech.start", ts }));
      bridge.onSpeechEnd((ts) => events.push({ type: "speech.end", ts }));
      bridge.onError((reason) => errors.push(reason));
      bridge.connect();

      // Wait for the WS to open before pushing audio. Without this
      // the bridge buffers everything, then dumps it on open in one
      // go which can confuse silero's per-call state.
      const opened = await new Promise((resolve) => {
        const start = Date.now();
        const tick = setInterval(() => {
          if (bridge.isOpen() || Date.now() - start > 5_000) {
            clearInterval(tick);
            resolve(bridge.isOpen());
          }
        }, 25);
      });
      assert.ok(opened, "VAD bridge failed to open WS in 5s");
      assert.deepEqual(errors, [], `unexpected /vad errors: ${errors.join(", ")}`);

      // Send audio in 32ms windows (silero's native frame size at
      // 16kHz = 512 samples = 1024 bytes of Int16). Realistic streaming
      // pace — also keeps us from blasting the model with one giant
      // buffer the python websockets layer would have to chunk.
      const FRAME_BYTES = 1024;
      for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
        const slice = pcm.subarray(i, Math.min(pcm.length, i + FRAME_BYTES));
        bridge.sendAudio(Buffer.from(slice));
        // 16 ms of wall delay per 32 ms of audio = 2× real-time so
        // the test finishes quickly while still being sequential
        // enough to get distinct start/end events rather than a
        // batched verdict.
        await wait(16);
      }
      // Drain interval — the hangover (300ms) plus model latency.
      await wait(800);

      bridge.dispose();

      // Expected timing per the fixture comment at the top of this file.
      const EXPECTED_START_MS = 500;
      const EXPECTED_END_MS = 1928;
      const TOLERANCE_MS = 100;

      const start = events.find((e) => e.type === "speech.start");
      const end = events.find((e) => e.type === "speech.end");
      assert.ok(start, `expected speech.start, got events: ${JSON.stringify(events)}`);
      assert.ok(end, `expected speech.end, got events: ${JSON.stringify(events)}`);
      assert.ok(
        Math.abs(start.ts - EXPECTED_START_MS) <= TOLERANCE_MS,
        `speech.start.ts=${start.ts} not within ±${TOLERANCE_MS}ms of ${EXPECTED_START_MS}`
      );
      assert.ok(
        Math.abs(end.ts - EXPECTED_END_MS) <= TOLERANCE_MS,
        `speech.end.ts=${end.ts} not within ±${TOLERANCE_MS}ms of ${EXPECTED_END_MS}`
      );
    } finally {
      sidecar.dispose();
      await new Promise((r) => {
        if (sidecar.process.exitCode !== null) return r(undefined);
        sidecar.process.once("exit", () => r(undefined));
        setTimeout(() => {
          try {
            sidecar.process.kill("SIGKILL");
          } catch {
            // ignore
          }
          r(undefined);
        }, 3000);
      });
    }
  }
);
