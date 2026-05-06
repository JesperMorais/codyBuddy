// Task 10.2: StreamingSttBridge tests using a Node-based fake
// whisper-stream binary (test/fixtures/fake-whisper-stream.mjs).
//
// These cover the full contract that the live conversation loop will
// rely on:
//   - partials dispatched as the engine emits them
//   - final from the engine cancels the speech-end timer (no double-fire)
//   - signalSpeechEnd → final within 400ms (the spec's budget) even when
//     the engine never emits one (last partial gets promoted)
//   - feedAudio buffers writes that arrive before start()
//   - stop() is idempotent and tears the subprocess down cleanly
//   - missing binary → onError fires; isRunning stays false
//
// The fake binary lets the timing tests be deterministic without
// requiring a real whisper.cpp install. The integration test that
// drives a real whisper-stream against the same fixture WAV used by
// vad-sidecar-real lands separately when the install tooling does
// (Phase 15 territory).
//
// Run: node --test daemon/test/stt-stream.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const { StreamingSttBridge } = await import("../dist/stt-stream.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
// Lives in daemon/scripts/ (not daemon/test/) on purpose: node --test
// recursively walks the test/ tree and would otherwise execute this
// fixture as a test, where its top-level "read stdin forever" loop
// hangs the suite.
const fakeBinary = resolve(__dirname, "..", "scripts", "fake-whisper-stream.mjs");

function buildBridge(env = {}, opts = {}) {
  return new StreamingSttBridge({
    command: process.execPath,
    args: [fakeBinary],
    env,
    log: () => {},
    ...opts,
  });
}

/** Resolves when `target` partial events have been observed, or after
 *  `timeoutMs`. The timeout case lets the test assert how many actually
 *  arrived rather than getting stuck. */
async function waitForPartials(arr, target, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (arr.length < target && Date.now() < deadline) await wait(20);
}

test("10.2 (a) feedAudio drives the engine to emit partial events; bridge dispatches them in order", async () => {
  const bridge = buildBridge({
    FAKE_PARTIAL_AT_BYTES: "1024",
    FAKE_FINAL_ON_IDLE_MS: "0", // disable engine-final so this test only checks partials
  });
  const partials = [];
  bridge.onPartial((text) => partials.push(text));
  assert.equal(bridge.start(), true);
  try {
    // 4096 bytes → 4 partial events at PARTIAL_AT_BYTES=1024.
    for (let i = 0; i < 4; i++) bridge.feedAudio(Buffer.alloc(1024, i + 1));
    // Wait deterministically rather than pinning a magic number — the
    // full daemon test suite runs several spawning tests in parallel
    // and child-process startup can spike past a 150ms budget under load.
    await waitForPartials(partials, 4);
    assert.equal(partials.length, 4);
    // Default fake builds the partial as the running concat, so each
    // entry should be longer than the previous.
    for (let i = 1; i < partials.length; i++) {
      assert.ok(partials[i].length > partials[i - 1].length);
    }
  } finally {
    bridge.stop();
  }
});

test("10.2 (b) engine-emitted final cancels the speech-end timer (no promoted double-fire)", async () => {
  const bridge = buildBridge(
    {
      FAKE_PARTIAL_AT_BYTES: "1024",
      // Engine emits final 50ms after stdin idle — well under the bridge's 400ms.
      FAKE_FINAL_ON_IDLE_MS: "50",
    },
    { speechEndTimeoutMs: 400 }
  );
  const finals = [];
  bridge.onFinal((text, source) => finals.push({ text, source }));
  assert.equal(bridge.start(), true);
  try {
    bridge.feedAudio(Buffer.alloc(2048, 0xff));
    await wait(80); // let partial fire
    bridge.signalSpeechEnd();
    // Engine should beat the 400ms bridge timeout.
    await wait(500);
    assert.equal(finals.length, 1, "must fire exactly once, not promote-then-engine");
    assert.equal(finals[0].source, "engine");
    assert.match(finals[0].text, /partial/);
  } finally {
    bridge.stop();
  }
});

test("10.2 (c) signalSpeechEnd promotes the last partial within 400ms when the engine never emits final", async () => {
  const bridge = buildBridge(
    {
      FAKE_PARTIAL_AT_BYTES: "1024",
      FAKE_FINAL_ON_IDLE_MS: "0", // engine NEVER fires final
    },
    { speechEndTimeoutMs: 400 }
  );
  const finals = [];
  bridge.onFinal((text, source) => finals.push({ text, source, ts: Date.now() }));
  assert.equal(bridge.start(), true);
  try {
    bridge.feedAudio(Buffer.alloc(3072, 1));
    await wait(80);
    const t0 = Date.now();
    bridge.signalSpeechEnd();
    await wait(550);
    assert.equal(finals.length, 1, "exactly one final should fire");
    assert.equal(finals[0].source, "promoted");
    const latency = finals[0].ts - t0;
    assert.ok(
      latency >= 400 && latency < 600,
      `promoted final latency ${latency}ms outside [400, 600). Spec budget is 400ms.`
    );
    assert.match(finals[0].text, /partial/);
  } finally {
    bridge.stop();
  }
});

test("10.2 (d) signalSpeechEnd promotes empty string when no partial was ever received", async () => {
  const bridge = buildBridge(
    { FAKE_PARTIAL_AT_BYTES: "1024", FAKE_FINAL_ON_IDLE_MS: "0" },
    { speechEndTimeoutMs: 100 }
  );
  const finals = [];
  bridge.onFinal((text, source) => finals.push({ text, source }));
  assert.equal(bridge.start(), true);
  try {
    // No audio sent — no partials.
    bridge.signalSpeechEnd();
    await wait(200);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].source, "promoted");
    assert.equal(finals[0].text, "");
  } finally {
    bridge.stop();
  }
});

test("10.2 (e) feedAudio called before start() is buffered and flushed on spawn", async () => {
  const bridge = buildBridge(
    { FAKE_PARTIAL_AT_BYTES: "512", FAKE_FINAL_ON_IDLE_MS: "0" },
  );
  const partials = [];
  bridge.onPartial((t) => partials.push(t));
  // Feed BEFORE start.
  bridge.feedAudio(Buffer.alloc(1024, 1));
  bridge.feedAudio(Buffer.alloc(1024, 2));
  assert.equal(bridge.start(), true);
  try {
    // 2048 bytes / 512 bytes-per-partial = 4 partials.
    await waitForPartials(partials, 4);
    assert.equal(partials.length, 4);
  } finally {
    bridge.stop();
  }
});

test("10.2 (f) start() returns false and onError fires when the binary is missing", async () => {
  const bridge = new StreamingSttBridge({
    command: "/path/to/binary/that/does/not/exist",
    log: () => {},
  });
  const errors = [];
  bridge.onError((reason) => errors.push(reason));
  const ok = bridge.start();
  // Wait a tick — spawn ENOENT surfaces as either a thrown spawn or
  // an async 'error' event depending on Node version.
  await wait(100);
  assert.equal(bridge.isRunning(), false);
  // Either the synchronous return was false, or the async error path fired.
  assert.ok(
    ok === false || errors.length > 0,
    `expected synchronous false or onError fire; ok=${ok} errors=${errors.length}`
  );
  bridge.stop();
});

test("10.2 (g) stop() is idempotent and clears any pending speech-end timer", async () => {
  const bridge = buildBridge(
    { FAKE_PARTIAL_AT_BYTES: "1024", FAKE_FINAL_ON_IDLE_MS: "0" },
    { speechEndTimeoutMs: 500 }
  );
  const finals = [];
  bridge.onFinal((text, source) => finals.push({ text, source }));
  assert.equal(bridge.start(), true);
  bridge.feedAudio(Buffer.alloc(1024, 1));
  await wait(80);
  bridge.signalSpeechEnd();
  bridge.stop();
  bridge.stop(); // idempotent
  await wait(700);
  assert.equal(finals.length, 0, "stop() must cancel the pending promote-final");
  assert.equal(bridge.isRunning(), false);
});

test("10.2 (h) {type:'error'} from the engine surfaces via onError without crashing the bridge", async () => {
  const bridge = buildBridge({
    FAKE_ERROR_ON_START: "model-not-found",
  });
  const errors = [];
  bridge.onError((reason) => errors.push(reason));
  assert.equal(bridge.start(), true);
  try {
    await wait(150);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "model-not-found");
  } finally {
    bridge.stop();
  }
});
