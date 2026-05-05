// Task 2.2: comprehensive routing test for TtsBridge.
//
// Stubs `spawn` and `fetch` via the test seams added in TtsConfig and asserts
// that each value of BUDDY_TTS_BACKEND drives the right backend:
//   - none   → no spawn, no fetch (no-op)
//   - piper  → spawn invoked with the right args; no fetch
//   - kokoro → fetch invoked with the right URL/body; no spawn
//
// Run: node --test daemon/test/tts-bridge-routing.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { TtsBridge } = await import("../dist/tts-bridge.js");

// --------------------------------------------------------------------------
// Fake spawn — returns a ChildProcess-like object that immediately emits
// `close` with exit code 0 once `stdin.end()` is called.
// --------------------------------------------------------------------------
function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    let stdinClosed = false;
    child.stdin = {
      write: () => {},
      end: () => {
        stdinClosed = true;
        // Emit `close` async to mimic real spawn ordering.
        setImmediate(() => child.emit("close", 0));
      },
    };
    child.stderr = new EventEmitter();
    calls.push({ cmd, args, opts });
    return child;
  };
  return { fakeSpawn, calls };
}

// --------------------------------------------------------------------------
// Fake fetch — records calls, returns 200 OK by default.
// --------------------------------------------------------------------------
function makeFakeFetch({ status = 200 } = {}) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fakeFetch, calls };
}

async function flushQueue() {
  // Two macrotask hops: one for setImmediate inside fakeSpawn, one for the
  // queue drain to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// --------------------------------------------------------------------------
// none backend
// --------------------------------------------------------------------------

test("backend=none: speak() never calls spawn or fetch", async () => {
  const { fakeSpawn, calls: spawnCalls } = makeFakeSpawn();
  const { fakeFetch, calls: fetchCalls } = makeFakeFetch();

  const tts = new TtsBridge({
    backend: "none",
    spawnImpl: fakeSpawn,
    fetchImpl: fakeFetch,
  });

  await tts.speak("anything you want");
  await flushQueue();

  assert.equal(spawnCalls.length, 0, "spawn must not be called");
  assert.equal(fetchCalls.length, 0, "fetch must not be called");
  assert.equal(tts.isActive(), false);
  assert.equal(tts.describe(), "off");
});

// --------------------------------------------------------------------------
// piper backend
// --------------------------------------------------------------------------

test("backend=piper: speak() spawns the configured exe with --model and --output_file", async () => {
  const { fakeSpawn, calls: spawnCalls } = makeFakeSpawn();
  const { fakeFetch, calls: fetchCalls } = makeFakeFetch();

  const tts = new TtsBridge({
    backend: "piper",
    piperExe: "C:\\fake\\piper.exe",
    piperVoice: "C:\\fake\\voice.onnx",
    spawnImpl: fakeSpawn,
    fetchImpl: fakeFetch,
    existsImpl: () => true, // bypass real filesystem
  });

  await tts.speak("hello there");
  await flushQueue();

  assert.equal(spawnCalls.length, 1, "spawn must be called exactly once");
  assert.equal(spawnCalls[0].cmd, "C:\\fake\\piper.exe");
  assert.deepEqual(spawnCalls[0].args.slice(0, 2), ["--model", "C:\\fake\\voice.onnx"]);
  assert.equal(spawnCalls[0].args[2], "--output_file");
  assert.match(spawnCalls[0].args[3], /\.wav$/);
  assert.equal(fetchCalls.length, 0, "fetch must not be called for piper backend");
  assert.equal(tts.isActive(), true);
});

test("backend=piper: missing exe/voice paths throws (no spawn) — drain swallows it", async () => {
  const { fakeSpawn, calls: spawnCalls } = makeFakeSpawn();

  const tts = new TtsBridge({
    backend: "piper",
    piperExe: "/nope/piper.exe",
    piperVoice: "/nope/voice.onnx",
    spawnImpl: fakeSpawn,
    existsImpl: () => false, // simulate missing files
  });

  await tts.speak("hi");
  await flushQueue();

  assert.equal(spawnCalls.length, 0, "spawn must not be called when files missing");
});

// --------------------------------------------------------------------------
// kokoro backend
// --------------------------------------------------------------------------

test("backend=kokoro: speak() POSTs to the default URL with the right body", async () => {
  const { fakeSpawn, calls: spawnCalls } = makeFakeSpawn();
  const { fakeFetch, calls: fetchCalls } = makeFakeFetch();

  const tts = new TtsBridge({
    backend: "kokoro",
    spawnImpl: fakeSpawn,
    fetchImpl: fakeFetch,
  });

  await tts.speak("hello kokoro");
  await flushQueue();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:31416/tts");
  assert.equal(fetchCalls[0].init.method, "POST");
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.text, "hello kokoro");
  assert.equal(spawnCalls.length, 0, "spawn must not be called for kokoro backend");
});

test("backend=kokoro: explicit kokoroUrl is used", async () => {
  const { fakeFetch, calls: fetchCalls } = makeFakeFetch();
  const tts = new TtsBridge({
    backend: "kokoro",
    kokoroUrl: "http://kokoro.local:9000/speak",
    fetchImpl: fakeFetch,
  });

  await tts.speak("override");
  await flushQueue();

  assert.equal(fetchCalls[0].url, "http://kokoro.local:9000/speak");
});

test("backend=kokoro: a non-2xx response is logged but does not throw out of speak()", async () => {
  const { fakeFetch, calls: fetchCalls } = makeFakeFetch({ status: 500 });
  const tts = new TtsBridge({ backend: "kokoro", fetchImpl: fakeFetch });

  await tts.speak("server is down");
  await flushQueue();

  assert.equal(fetchCalls.length, 1);
});

// --------------------------------------------------------------------------
// queue / cancel
// --------------------------------------------------------------------------

test("multiple speak() calls drain in order through the configured backend", async () => {
  const { fakeFetch, calls: fetchCalls } = makeFakeFetch();
  const tts = new TtsBridge({ backend: "kokoro", fetchImpl: fakeFetch });

  await tts.speak("one");
  await tts.speak("two");
  await tts.speak("three");
  await flushQueue();
  await flushQueue();

  const bodies = fetchCalls.map((c) => JSON.parse(c.init.body).text);
  assert.deepEqual(bodies, ["one", "two", "three"]);
});

test("cancel() empties the queue before the backend drains it", async () => {
  // Slow fetch keeps the queue busy long enough to cancel pending entries.
  let resolveFirst;
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      await new Promise((r) => (resolveFirst = r));
    }
    return new Response("{}", { status: 200 });
  };
  const tts = new TtsBridge({ backend: "kokoro", fetchImpl: fakeFetch });

  void tts.speak("first");
  void tts.speak("second");
  void tts.speak("third");
  await new Promise((r) => setImmediate(r));

  // First fetch is in flight; queue holds "second" and "third". Cancel.
  tts.cancel();
  resolveFirst();
  await flushQueue();
  await flushQueue();

  // Only the first (already in flight) should have been sent.
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).text, "first");
});
