// Task 10.3: StreamingTtsBridge tests against a mock /tts/stream
// upstream. The mock plays the role of voice/main.py's
// kokoro-backed handler so the timing assertion is deterministic.
//
// Spec contract verified here: "synth a 4-sentence input; first audio
// chunk arrives <150ms after first sentence sent." With the bridge
// dispatching chunks immediately on receipt and the mock emitting a
// chunk synchronously on the first sentence's text frame, the only
// latency in play is the WS round-trip — well under 150ms locally
// and (loosely) on CI.
//
// Run: node --test daemon/test/tts-stream.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocketServer } from "ws";

const { StreamingTtsBridge } = await import("../dist/tts-stream.js");

async function listen(server) {
  await new Promise((r) => server.on("listening", r));
  return server.address().port;
}

function makeServer(handler) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", handler);
  return wss;
}

/** Mock that synthesises each incoming sentence immediately into a
 *  fixed PCM payload. `chunkBytesPerSentence` controls how big each
 *  per-sentence emission is so tests can also count chunks. */
function fakeKokoroHandler({ chunkBytesPerSentence = 320 } = {}) {
  return (ws) => {
    let nextIdx = 0;
    ws.on("message", async (raw) => {
      const text = raw.toString();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      if (payload.done) {
        ws.send(JSON.stringify({ type: "done" }));
        ws.close();
        return;
      }
      if (typeof payload.text !== "string" || !payload.text.trim()) return;
      const idx = nextIdx++;
      ws.send(
        JSON.stringify({
          type: "sentence_start",
          idx,
          sample_rate: 24000,
          channels: 1,
        })
      );
      ws.send(Buffer.alloc(chunkBytesPerSentence, idx + 1));
      ws.send(JSON.stringify({ type: "sentence_done", idx }));
    });
  };
}

test("10.3 (a) first audio chunk arrives <150ms after the first sentence is sent (4-sentence input)", async () => {
  const wss = makeServer(fakeKokoroHandler());
  const port = await listen(wss);
  const bridge = new StreamingTtsBridge({
    url: `ws://127.0.0.1:${port}/tts/stream`,
    log: () => {},
    reconnectMs: 0,
  });

  const chunks = [];
  let firstChunkAt = 0;
  let firstSentSent = 0;
  bridge.onAudioChunk((buf, idx) => {
    if (chunks.length === 0) firstChunkAt = Date.now();
    chunks.push({ buf, idx });
  });
  const sentenceDones = [];
  bridge.onSentenceDone((idx) => sentenceDones.push(idx));
  const allDoneSeen = new Promise((resolve) => bridge.onDone(() => resolve()));

  bridge.connect();
  // Wait for open so the first sentence isn't queued behind the
  // pre-open buffer flush — the spec is about wire latency, not
  // bridge bookkeeping.
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (bridge.isOpen()) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  try {
    firstSentSent = Date.now();
    bridge.feedSentence("Hello world.");
    bridge.feedSentence("This is the second sentence.");
    bridge.feedSentence("And a third one for good measure.");
    bridge.feedSentence("Finally the fourth sentence wraps it up.");
    bridge.finish();

    await allDoneSeen;

    const latency = firstChunkAt - firstSentSent;
    assert.ok(
      latency >= 0 && latency < 150,
      `first audio chunk took ${latency}ms (budget: <150ms)`
    );
    assert.equal(chunks.length, 4, "one chunk per sentence with the mock's setup");
    // Chunks should arrive in send order (idx 0..3).
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].idx, i, `chunk ${i} should belong to sentence ${i}`);
    }
    assert.deepEqual(sentenceDones.sort((a, b) => a - b), [0, 1, 2, 3]);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.3 (b) sentence_start fires once per sentence with the engine's sample_rate", async () => {
  const wss = makeServer(fakeKokoroHandler());
  const port = await listen(wss);
  const bridge = new StreamingTtsBridge({
    url: `ws://127.0.0.1:${port}/tts/stream`,
    log: () => {},
    reconnectMs: 0,
  });
  const starts = [];
  bridge.onSentenceStart((info) => starts.push(info));
  bridge.connect();
  try {
    await wait(50);
    bridge.feedSentence("a");
    bridge.feedSentence("b");
    await wait(150);
    assert.equal(starts.length, 2);
    assert.equal(starts[0].idx, 0);
    assert.equal(starts[1].idx, 1);
    for (const s of starts) {
      assert.equal(s.sampleRate, 24000);
      assert.equal(s.channels, 1);
    }
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.3 (c) feedSentence buffers writes that arrive before the WS opens", async () => {
  const received = [];
  const wss = makeServer((ws) => {
    ws.on("message", (raw) => {
      try {
        received.push(JSON.parse(raw.toString()));
      } catch {
        // ignore
      }
    });
  });
  const port = await listen(wss);
  const bridge = new StreamingTtsBridge({
    url: `ws://127.0.0.1:${port}/tts/stream`,
    log: () => {},
    reconnectMs: 0,
  });
  // Send before connect.
  bridge.feedSentence("first");
  bridge.feedSentence("second");
  bridge.connect();
  try {
    await wait(150);
    assert.equal(received.length, 2);
    assert.equal(received[0].text, "first");
    assert.equal(received[1].text, "second");
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.3 (d) upstream {type:'error'} latches the bridge as permanently down", async () => {
  let connections = 0;
  const wss = makeServer((ws) => {
    connections += 1;
    ws.send(
      JSON.stringify({
        type: "error",
        reason: "kokoro-not-installed: pip install ...",
      })
    );
    ws.close(1011);
  });
  const port = await listen(wss);
  const bridge = new StreamingTtsBridge({
    url: `ws://127.0.0.1:${port}/tts/stream`,
    log: () => {},
    reconnectMs: 50,
  });
  const errors = [];
  bridge.onError((reason) => errors.push(reason));
  bridge.connect();
  try {
    await wait(400);
    assert.equal(connections, 1, "must NOT reconnect after permanent error");
    assert.equal(bridge.isPermanentlyDown(), true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /kokoro-not-installed/);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.3 (e) {type:'sentence_error'} surfaces via onError but does NOT latch (transient per-sentence failure)", async () => {
  const wss = makeServer((ws) => {
    let idx = 0;
    ws.on("message", (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.done) {
        ws.send(JSON.stringify({ type: "done" }));
        ws.close();
        return;
      }
      const id = idx++;
      // Fail sentence 0; succeed sentence 1.
      if (id === 0) {
        ws.send(
          JSON.stringify({
            type: "sentence_error",
            idx: id,
            reason: "synth-failed",
          })
        );
        return;
      }
      ws.send(
        JSON.stringify({
          type: "sentence_start",
          idx: id,
          sample_rate: 24000,
          channels: 1,
        })
      );
      ws.send(Buffer.alloc(64, id));
      ws.send(JSON.stringify({ type: "sentence_done", idx: id }));
    });
  });
  const port = await listen(wss);
  const bridge = new StreamingTtsBridge({
    url: `ws://127.0.0.1:${port}/tts/stream`,
    log: () => {},
    reconnectMs: 0,
  });
  const errors = [];
  const dones = [];
  bridge.onError((reason) => errors.push(reason));
  bridge.onSentenceDone((idx) => dones.push(idx));
  bridge.connect();
  try {
    await wait(50);
    bridge.feedSentence("will fail");
    bridge.feedSentence("will succeed");
    await wait(200);
    assert.equal(errors.length, 1, "exactly one per-sentence error");
    assert.equal(errors[0], "synth-failed");
    assert.equal(bridge.isPermanentlyDown(), false, "per-sentence failure must NOT latch");
    assert.deepEqual(dones, [1]);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.3 (f) finish() sends {done:true} and onDone fires when the upstream replies", async () => {
  const wss = makeServer(fakeKokoroHandler());
  const port = await listen(wss);
  const bridge = new StreamingTtsBridge({
    url: `ws://127.0.0.1:${port}/tts/stream`,
    log: () => {},
    reconnectMs: 0,
  });
  const doneSeen = new Promise((resolve) => bridge.onDone(() => resolve(true)));
  bridge.connect();
  try {
    await wait(50);
    bridge.feedSentence("hello");
    bridge.finish();
    const ok = await Promise.race([
      doneSeen,
      wait(500).then(() => false),
    ]);
    assert.equal(ok, true, "onDone must fire after finish()");
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});
