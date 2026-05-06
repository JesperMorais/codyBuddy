// Task 10.1 (daemon side): VadBridge connects to the voice sidecar's
// /vad WebSocket, parses the speech.start / speech.end / error events,
// streams audio frames in, and reconnects when the upstream drops.
//
// These tests use a mock WebSocketServer in place of the real Python
// sidecar so they run on every machine. The fixture-WAV integration
// test that exercises real silero-vad is gated separately under
// daemon/test/vad-sidecar-real.test.mjs (still TODO — see PR notes).
//
// Run: node --test daemon/test/vad-bridge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocketServer } from "ws";

const { VadBridge } = await import("../dist/vad-bridge.js");

async function listen(server) {
  await new Promise((r) => server.on("listening", r));
  return server.address().port;
}

function makeServer(handler) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", handler);
  return wss;
}

function lines() {
  const out = [];
  return { out, log: (l) => out.push(l) };
}

test("10.1 (a) bridge dispatches speech.start / speech.end events from the upstream WS", async () => {
  const wss = makeServer((ws) => {
    setTimeout(() => ws.send(JSON.stringify({ type: "speech.start", ts: 320 })), 20);
    setTimeout(() => ws.send(JSON.stringify({ type: "speech.end", ts: 1280 })), 60);
  });
  const port = await listen(wss);
  const { log } = lines();
  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log,
    reconnectMs: 0,
  });
  const starts = [];
  const ends = [];
  bridge.onSpeechStart((ts) => starts.push(ts));
  bridge.onSpeechEnd((ts) => ends.push(ts));
  bridge.connect();
  try {
    await wait(200);
    assert.deepEqual(starts, [320]);
    assert.deepEqual(ends, [1280]);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.1 (b) bridge streams audio frames to the upstream after open, buffering pre-open writes", async () => {
  const received = [];
  const wss = makeServer((ws) => {
    ws.on("message", (data, isBinary) => {
      received.push({ isBinary, len: data.length });
    });
  });
  const port = await listen(wss);
  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log: () => {},
    reconnectMs: 0,
  });
  // Send BEFORE connect — must be buffered and flushed on open.
  bridge.sendAudio(Buffer.alloc(1024, 0x10));
  bridge.connect();
  // Send AFTER connect (likely after open lands).
  await wait(50);
  bridge.sendAudio(Buffer.alloc(2048, 0x20));
  try {
    await wait(100);
    assert.equal(received.length, 2, "both frames must reach the server");
    assert.equal(received[0].len, 1024);
    assert.equal(received[1].len, 2048);
    for (const r of received) assert.equal(r.isBinary, true, "frames must be binary");
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.1 (c) bridge stops reconnecting after an upstream error event (silero-vad missing)", async () => {
  let connections = 0;
  const wss = makeServer((ws) => {
    connections += 1;
    ws.send(JSON.stringify({ type: "error", reason: "silero-vad-not-installed: pip install ..." }));
    ws.close(1011);
  });
  const port = await listen(wss);
  const errors = [];
  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log: () => {},
    reconnectMs: 50,
  });
  bridge.onError((reason) => errors.push(reason));
  bridge.connect();
  try {
    // Give plenty of time for any reconnect spin to surface.
    await wait(400);
    assert.equal(connections, 1, "must NOT reconnect after a permanent error");
    assert.equal(bridge.isPermanentlyDown(), true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /silero-vad-not-installed/);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.1 (d) bridge reconnects after a transient drop (no error frame)", async () => {
  let connections = 0;
  const wss = makeServer((ws) => {
    connections += 1;
    if (connections === 1) {
      // Drop the first connection without sending an error frame.
      setTimeout(() => ws.close(), 30);
    } else {
      // Second connection: send a real event, prove reconnect worked.
      ws.send(JSON.stringify({ type: "speech.start", ts: 100 }));
    }
  });
  const port = await listen(wss);
  const starts = [];
  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log: () => {},
    reconnectMs: 50,
  });
  bridge.onSpeechStart((ts) => starts.push(ts));
  bridge.connect();
  try {
    // Allow first connect, drop, reconnect cycle.
    await wait(400);
    assert.ok(connections >= 2, `expected ≥2 connect attempts, got ${connections}`);
    assert.deepEqual(starts, [100]);
    assert.equal(bridge.isPermanentlyDown(), false);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.1 (e) reset() clears the permanently-down latch so a future connect retries", async () => {
  const wss = makeServer((ws) => {
    ws.send(JSON.stringify({ type: "error", reason: "silero-vad-not-installed" }));
    ws.close(1011);
  });
  const port = await listen(wss);
  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log: () => {},
    reconnectMs: 30,
  });
  bridge.connect();
  try {
    await wait(150);
    assert.equal(bridge.isPermanentlyDown(), true);
    bridge.reset();
    assert.equal(bridge.isPermanentlyDown(), false);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.1 (f) bad JSON from the upstream is logged but does not crash the bridge", async () => {
  const wss = makeServer((ws) => {
    ws.send("not json {{{");
    setTimeout(() => ws.send(JSON.stringify({ type: "speech.start", ts: 50 })), 30);
  });
  const port = await listen(wss);
  const { out, log } = lines();
  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log,
    reconnectMs: 0,
  });
  const starts = [];
  bridge.onSpeechStart((ts) => starts.push(ts));
  bridge.connect();
  try {
    await wait(200);
    assert.ok(out.some((l) => /bad message/.test(l)), "bad JSON must be logged");
    assert.deepEqual(starts, [50], "valid messages after bad JSON must still dispatch");
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});
