// Task 10.5: barge-in handler integration test.
//
// Spec headline (verbatim): "with a fake long-running TTS and LLM
// stream, dispatch a `speech.start` event; assert both terminate
// within 100ms".
//
// We wire the actual VadBridge against a mock /vad upstream so the
// event path mirrors production. On speech.start, the conversation
// loop will call BargeInController.trigger() — for the test, we
// register two cancellers that represent a long-running TTS playback
// (a 5s setTimeout) and a long-running LLM stream (an AbortController
// that's signaled). Both must report "killed" within 100ms of the
// upstream emit.
//
// Run: node --test daemon/test/barge-in.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocketServer } from "ws";

const { BargeInController } = await import("../dist/barge-in.js");
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

/** A long-running TTS-shaped fake. Resolves when killed; otherwise
 *  hangs for 5s. The "killed" promise is what the test assertion
 *  awaits. */
function makeLongRunningTts() {
  let killAt = 0;
  let resolveKilled;
  const killed = new Promise((r) => (resolveKilled = r));
  const naturalTimer = setTimeout(() => {
    // Would have played for 5s. The barge-in cancel is what we want
    // to fire instead.
  }, 5000);
  naturalTimer.unref?.();
  return {
    cancel() {
      killAt = Date.now();
      clearTimeout(naturalTimer);
      resolveKilled(killAt);
    },
    killed,
    get killAt() {
      return killAt;
    },
  };
}

/** A long-running LLM-stream-shaped fake. The async iterator yields
 *  tokens slowly until the AbortSignal fires, then exits cleanly. */
function makeLongRunningLlm() {
  const ctrl = new AbortController();
  let killAt = 0;
  const tokens = [];
  const finished = (async () => {
    try {
      for (let i = 0; i < 1000; i++) {
        if (ctrl.signal.aborted) return "aborted";
        await wait(20);
        tokens.push(`tok${i}`);
      }
      return "exhausted";
    } catch (err) {
      return `error:${err instanceof Error ? err.message : err}`;
    }
  })();
  return {
    cancel() {
      killAt = Date.now();
      ctrl.abort();
    },
    finished,
    tokens,
    get killAt() {
      return killAt;
    },
  };
}

test("10.5 (a) speech.start from VAD truncates fake TTS + LLM stream within 100ms (spec budget)", async () => {
  const wss = makeServer((ws) => {
    // Hold; the test triggers speech.start manually below.
    ws.serverHandle = ws;
  });
  const port = await listen(wss);

  const tts = makeLongRunningTts();
  const llm = makeLongRunningLlm();
  const barge = new BargeInController({ log: () => {} });
  barge.register("tts", () => tts.cancel());
  barge.register("llm", () => llm.cancel());

  const bridge = new VadBridge({
    url: `ws://127.0.0.1:${port}/vad`,
    log: () => {},
    reconnectMs: 0,
  });

  // Wire VAD → barge-in. This is exactly what the conversation loop
  // (Task 10.6) will do.
  bridge.onSpeechStart(() => {
    void barge.trigger();
  });

  bridge.connect();
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (bridge.isOpen()) {
        clearInterval(tick);
        resolve();
      }
    }, 10);
  });

  try {
    // Find the server-side socket the bridge connected on.
    const serverSocket = [...wss.clients][0];
    assert.ok(serverSocket, "server must have an attached client");

    const t0 = Date.now();
    serverSocket.send(JSON.stringify({ type: "speech.start", ts: 1234 }));

    await tts.killed;
    await Promise.race([llm.finished, wait(500)]);

    assert.ok(tts.killAt > 0, "TTS must have been cancelled");
    assert.ok(llm.killAt > 0, "LLM must have been cancelled");
    const ttsLatency = tts.killAt - t0;
    const llmLatency = llm.killAt - t0;
    assert.ok(
      ttsLatency < 100,
      `TTS cancel latency ${ttsLatency}ms exceeds 100ms budget`
    );
    assert.ok(
      llmLatency < 100,
      `LLM cancel latency ${llmLatency}ms exceeds 100ms budget`
    );
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.5 (b) trigger() awaits async cancellers and reports total elapsed", async () => {
  const barge = new BargeInController({ log: () => {} });
  let aDone = 0;
  let bDone = 0;
  barge.register("a", async () => {
    await wait(20);
    aDone = Date.now();
  });
  barge.register("b", async () => {
    await wait(40);
    bDone = Date.now();
  });

  const t0 = Date.now();
  const elapsed = await barge.trigger();
  // elapsed is at least the slowest canceller (~40ms) and at most
  // a smidge more (Promise.allSettled overhead).
  assert.ok(elapsed >= 35, `elapsed ${elapsed}ms should reflect the slow canceller`);
  assert.ok(aDone - t0 >= 15);
  assert.ok(bDone - t0 >= 35);
});

test("10.5 (c) a thrown canceller doesn't prevent the others from running", async () => {
  const logs = [];
  const barge = new BargeInController({ log: (l) => logs.push(l) });
  let bRan = false;
  barge.register("a", () => {
    throw new Error("a-broke");
  });
  barge.register("b", () => {
    bRan = true;
  });
  await barge.trigger();
  assert.equal(bRan, true, "b must run even after a threw");
  assert.ok(
    logs.some((l) => /canceller a threw: a-broke/.test(l)),
    "thrown canceller name + message should be in the log"
  );
});

test("10.5 (d) re-entrant trigger() while one is in flight is a no-op (no double-fire)", async () => {
  const barge = new BargeInController({ log: () => {} });
  let calls = 0;
  barge.register("slow", async () => {
    await wait(40);
    calls += 1;
  });
  // Fire two triggers concurrently — only the first should run.
  const a = barge.trigger();
  const b = barge.trigger();
  const [elapsedA, elapsedB] = await Promise.all([a, b]);
  assert.equal(calls, 1, "canceller should run exactly once across re-entrant triggers");
  assert.ok(elapsedA >= 35, `first trigger() should reflect work done; got ${elapsedA}ms`);
  assert.equal(elapsedB, 0, "second trigger() resolves to 0 immediately");
});

test("10.5 (e) unregister removes a canceller", async () => {
  const barge = new BargeInController({ log: () => {} });
  let aCalls = 0;
  let bCalls = 0;
  const unA = barge.register("a", () => {
    aCalls += 1;
  });
  barge.register("b", () => {
    bCalls += 1;
  });
  unA();
  assert.equal(barge.size(), 1, "size should reflect unregister");
  await barge.trigger();
  assert.equal(aCalls, 0);
  assert.equal(bCalls, 1);
});

test("10.5 (f) trigger() with no cancellers resolves to 0 immediately", async () => {
  const barge = new BargeInController({ log: () => {} });
  const t0 = Date.now();
  const elapsed = await barge.trigger();
  assert.equal(elapsed, 0);
  assert.ok(Date.now() - t0 < 5, "no work should take measurable time");
});
