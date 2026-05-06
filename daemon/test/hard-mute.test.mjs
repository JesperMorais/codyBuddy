// Task 10.4: hard-mute hotkey wire test.
//
// Spec contract (verbatim): "dispatch the WS message, assert mic stream
// closed and TTS subprocess sent SIGINT". The latency budget is <50ms
// from receipt of {type:"hardMute"} to handler completion.
//
// We boot the real WS server with:
//   - a spied recorder (records cancel() calls)
//   - a real TtsBridge in piper backend, with a fake spawn that returns
//     a Node-shaped child process tracking the kill signal
//
// Then dispatch {type:"hardMute"}, await the {type:"hardMuted"} ack,
// and assert:
//   1. recorder.cancel() was called
//   2. tts.cancel() SIGINT'd the in-flight spawned subprocess
//   3. ack.elapsedMs is comfortably under 50ms
//
// Run: node --test daemon/test/hard-mute.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocket } from "ws";

const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { SttBridge } = await import("../dist/stt.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

/** A minimal Recorder stand-in that the server treats identically to
 *  the real one but records cancel() invocations and lets the test
 *  fake an in-progress recording without spawning powershell. */
class SpyRecorder {
  constructor() {
    this.cancelCalls = 0;
    this.recording = false;
  }
  isRecording() {
    return this.recording;
  }
  start() {
    this.recording = true;
    return { ok: true };
  }
  async stop() {
    this.recording = false;
    return { ok: false, error: "spy: no real wav" };
  }
  cancel() {
    this.cancelCalls += 1;
    this.recording = false;
  }
}

/** ChildProcess-shaped fake that records kill signals so the test can
 *  assert the SIGINT contract without touching a real binary. The
 *  exitCode stays null until kill() is called — TtsBridge guards on
 *  exitCode === null before signaling. */
function makeFakeChild() {
  const ee = new EventEmitter();
  ee.killSignals = [];
  ee.exitCode = null;
  ee.stdin = { write() {}, end() {} };
  ee.stderr = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.kill = (signal) => {
    ee.killSignals.push(signal ?? "SIGTERM");
    ee.exitCode = 130; // 128 + SIGINT
    setImmediate(() => ee.emit("close", 130));
    return true;
  };
  return ee;
}

function makeFakeSpawn(child) {
  return () => child;
}

async function listen(server) {
  await new Promise((r) => server.on("listening", r));
  return server.address().port;
}

function openClient(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue = [];
    const waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const i = waiters.findIndex((w) => w.predicate(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.next = (predicate) =>
      new Promise((res) => {
        const i = queue.findIndex(predicate);
        if (i >= 0) {
          const [m] = queue.splice(i, 1);
          res(m);
        } else {
          waiters.push({ predicate, resolve: res });
        }
      });
    ws.once("open", () => resolve(ws));
  });
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

function buildSession() {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  // Use process.cwd() for the memory dir — we never write to it in
  // these tests, but Session insists on a MemoryStore reference.
  const memDir = `/tmp/buddy-hardmute-${process.pid}-${Date.now()}`;
  const memory = new MemoryStore(memDir);
  return new Session(fake, prompts, { memory });
}

test("10.4 (a) hardMute SIGINTs the in-flight TTS subprocess and cancels recording", async () => {
  const recorder = new SpyRecorder();
  recorder.start(); // pretend we were recording when the kill landed

  const fakeChild = makeFakeChild();
  // existsImpl: yes the piper paths exist, so speak() proceeds to spawn.
  const tts = new TtsBridge({
    backend: "piper",
    piperExe: "/fake/piper.exe",
    piperVoice: "/fake/voice.onnx",
    spawnImpl: makeFakeSpawn(fakeChild),
    existsImpl: () => true,
  });

  // Kick off speak — it'll spawn the fake child and await its close.
  // The promise hangs until cancel() (or natural exit) lands.
  const speakPromise = tts.speak("hello world");
  // Give the speak path a tick to hit spawnImpl and stash activeProc.
  await wait(20);

  const wss = startServer({
    session: buildSession(),
    tts,
    stt: new SttBridge({}),
    recorder,
    port: 0,
  });
  await listen(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet"); // drain initial ack
      const tStart = Date.now();
      ws.send(JSON.stringify({ type: "hardMute" }));
      const ack = await ws.next((m) => m.type === "hardMuted");
      const tEnd = Date.now();

      // Spec assertion #1: mic stream closed.
      assert.equal(recorder.cancelCalls, 1, "recorder.cancel() must be called once");
      assert.equal(recorder.recording, false, "recorder must report not-recording");
      assert.equal(ack.micCancelled, true, "ack.micCancelled mirrors the wasRecording flag");

      // Spec assertion #2: TTS subprocess sent SIGINT.
      assert.deepEqual(
        fakeChild.killSignals,
        ["SIGINT"],
        `expected exactly one SIGINT, got ${JSON.stringify(fakeChild.killSignals)}`
      );
      assert.equal(ack.ttsSignaled, true, "ack.ttsSignaled must reflect the SIGINT");

      // Spec budget: <50ms server-side. The wire round-trip is
      // dominated by the local socket; allow generous headroom for
      // CI noise but still pin the order of magnitude.
      assert.ok(
        ack.elapsedMs < 50,
        `daemon-side hard-mute took ${ack.elapsedMs}ms (spec budget <50ms)`
      );
      // End-to-end shouldn't be wildly different from the daemon's
      // own measurement when running locally.
      assert.ok(
        tEnd - tStart < 500,
        `wall-clock RTT ${tEnd - tStart}ms unexpectedly slow`
      );
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    // The speak promise rejects via piper exit-code branch when the
    // fake exits 130 — swallow it so the test ends clean.
    await speakPromise.catch(() => {});
  }
});

test("10.4 (b) hardMute is safe when nothing was active (idempotent kill)", async () => {
  const recorder = new SpyRecorder();
  // Not recording, no TTS in flight.
  const tts = new TtsBridge({ backend: "none" });
  const wss = startServer({
    session: buildSession(),
    tts,
    stt: new SttBridge({}),
    recorder,
    port: 0,
  });
  await listen(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "hardMute" }));
      const ack = await ws.next((m) => m.type === "hardMuted");
      assert.equal(ack.micCancelled, false, "no recording was active");
      assert.equal(ack.ttsSignaled, false, "no TTS subprocess to signal");
      assert.ok(ack.elapsedMs < 50);
      // recorder.cancel() should still have been called — it's a no-op
      // when nothing is in flight, but the handler doesn't gate on it.
      assert.equal(recorder.cancelCalls, 1);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
  }
});

test("10.4 (c) repeated hardMute keeps the daemon stable (no leaked listeners / state drift)", async () => {
  const recorder = new SpyRecorder();
  const tts = new TtsBridge({ backend: "none" });
  const wss = startServer({
    session: buildSession(),
    tts,
    stt: new SttBridge({}),
    recorder,
    port: 0,
  });
  await listen(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: "hardMute" }));
        const ack = await ws.next((m) => m.type === "hardMuted");
        assert.ok(ack.elapsedMs < 50);
      }
      assert.equal(recorder.cancelCalls, 5);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
  }
});
