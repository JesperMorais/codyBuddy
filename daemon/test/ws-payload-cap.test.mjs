// WS payload cap (#95). Asserts:
//   1. The 8 MiB WS-level cap closes any client that ships a frame
//      larger than `maxPayload` (ws library emits close code 1009).
//   2. The transcribe handler's inner-ring 4 MiB cap on the *decoded*
//      buffer rejects oversized audio that slipped under the WS-level
//      cap (base64's 4/3 expansion makes this scenario possible).
//   3. A small valid transcribe still goes through end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { Recorder } = await import("../dist/recorder.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

// SttBridge stub — `transcribe(buf)` returns a marker so the
// small-valid-transcribe test can also assert the buffer reaches the
// bridge unmodified.
class StubStt {
  constructor() {
    this.lastBufLen = -1;
  }
  configure() {}
  describe() { return "stub"; }
  isAvailable() { return true; }
  async transcribe(buf) {
    this.lastBufLen = buf.length;
    return "stub-transcript";
  }
}

function buildDeps(stt) {
  const fake = new FakeAnthropicClient({ replies: [] });
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const session = new Session(fake, prompts);
  const tts = new TtsBridge({ backend: "none" });
  const recorder = new Recorder();
  return { session, tts, stt, recorder };
}

function waitListening(wss) {
  return new Promise((resolve) => {
    if (wss.address()) resolve();
    else wss.once("listening", resolve);
  });
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    function onMsg(data) {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        ws.off("message", onMsg);
        resolve(msg);
      }
    }
    ws.on("message", onMsg);
    ws.once("error", reject);
  });
}

test("WS rejects messages larger than maxPayload (close code 1009)", async () => {
  const wss = startServer({ ...buildDeps(new StubStt()), port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  let ws;
  try {
    ws = await openClient(port);
    // Build a JSON message that's just over 8 MiB. The base64 string
    // dominates; the JSON envelope adds only ~80 bytes.
    const bigPayload = "A".repeat(9 * 1024 * 1024);
    const oversized = JSON.stringify({
      type: "transcribe",
      requestId: "oversized",
      audio: bigPayload,
    });
    const closed = new Promise((resolve) => {
      ws.once("close", (code) => resolve(code));
    });
    ws.send(oversized);
    // Explicit deadline: without maxPayload set, pre-fix the server
    // accepts 9 MiB and processes it as a normal transcribe request;
    // no `close` ever fires and the test would hang the runner. With
    // the deadline, the regression surfaces as a clean assertion.
    const deadline = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const result = await Promise.race([closed, deadline]);
    assert.notEqual(
      result, "timeout",
      "WS server accepted a 9 MiB message — maxPayload cap missing or set too high"
    );
    // ws library spec: 1009 = "message too big". Some platforms close
    // with 1006 ("abnormal closure") if the underlying socket is
    // torn first. Accept either as evidence that the WS layer
    // rejected the frame instead of buffering 9 MiB into JSON.parse.
    assert.ok(
      result === 1009 || result === 1006,
      `expected close code 1009 or 1006, got ${result}`
    );
  } finally {
    try { ws?.close(); } catch {}
    await closeServer(wss);
  }
});

test("transcribe rejects decoded buffer > 4 MiB even when base64 is under the WS cap", async () => {
  const wss = startServer({ ...buildDeps(new StubStt()), port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  let ws;
  try {
    ws = await openClient(port);
    // Decoded audio = 5 MiB. base64 expansion is ~4/3, so the wire
    // payload is ~6.67 MiB — under the 8 MiB WS cap, but over the
    // 4 MiB per-handler cap. This is exactly the case the inner-ring
    // guard exists for.
    const decodedSize = 5 * 1024 * 1024;
    const audioB64 = Buffer.alloc(decodedSize, 0x41).toString("base64");
    ws.send(JSON.stringify({
      type: "transcribe",
      requestId: "too-big-decoded",
      audio: audioB64,
    }));
    const reply = await nextMessage(ws, (m) => m.type === "transcribed");
    assert.equal(reply.requestId, "too-big-decoded");
    assert.equal(reply.ok, false);
    assert.match(reply.error, /audio too large/);
  } finally {
    try { ws?.close(); } catch {}
    await closeServer(wss);
  }
});

test("transcribe under the cap reaches the SttBridge unchanged", async () => {
  const stub = new StubStt();
  const wss = startServer({ ...buildDeps(stub), port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  let ws;
  try {
    ws = await openClient(port);
    const audioBytes = Buffer.alloc(1024, 0x42);
    ws.send(JSON.stringify({
      type: "transcribe",
      requestId: "small-ok",
      audio: audioBytes.toString("base64"),
    }));
    const reply = await nextMessage(ws, (m) => m.type === "transcribed");
    assert.equal(reply.requestId, "small-ok");
    assert.equal(reply.ok, true);
    assert.equal(reply.text, "stub-transcript");
    assert.equal(stub.lastBufLen, audioBytes.length);
  } finally {
    try { ws?.close(); } catch {}
    await closeServer(wss);
  }
});
