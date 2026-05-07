// Task 16.1: AudioHost MVP wiring test.
//
// Spec headline (TASKS.md 16.1): "WS round-trip through a real
// VadBridge mock-server emits an askStream call and a turns.jsonl
// line."
//
// We use the host's narrow VadEventSource / SttEventSource / TtsSink
// interfaces so the test can drive every event manually — no real
// WebSockets, no real subprocess. The point is to verify the wiring
// actually composes the loop, the router, and the telemetry sink in
// the right order: VAD → loop.speechStart → STT final →
// loop.transcript → router.route → tts.feedSentence (per sentence)
// → SPEAKING → IDLE → turnTelemetry.record (one line in turns.jsonl).
//
// Run: node --test daemon/test/audio-host.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost } = await import("../dist/audio-host.js");
const { TurnTelemetry } = await import("../dist/turn-telemetry.js");

class FakeVad {
  constructor() {
    this.startHandlers = [];
    this.endHandlers = [];
  }
  onSpeechStart(h) {
    this.startHandlers.push(h);
  }
  onSpeechEnd(h) {
    this.endHandlers.push(h);
  }
  emitStart(ts = 0) {
    for (const h of this.startHandlers) h(ts);
  }
  emitEnd(ts = 0) {
    for (const h of this.endHandlers) h(ts);
  }
}

class FakeStt {
  constructor() {
    this.finalHandlers = [];
  }
  onFinal(h) {
    this.finalHandlers.push(h);
  }
  emitFinal(text, source = "engine") {
    for (const h of this.finalHandlers) h(text, source);
  }
}

class FakeTts {
  constructor() {
    this.fed = [];
    this.finishCalls = 0;
    this.disposeCalls = 0;
  }
  feedSentence(text) {
    this.fed.push(text);
  }
  finish() {
    this.finishCalls += 1;
  }
  dispose() {
    this.disposeCalls += 1;
  }
}

/** Returns an async iterable that yields the given chunks. */
function streamFromChunks(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await wait(2);
        yield c;
      }
    },
  };
}

class FakeRouter {
  constructor({ chunks = [], reason = "trigger=EXPLICIT_ASK" } = {}) {
    this.calls = [];
    this.chunks = chunks;
    this.lastOutcome = { tier: "sonnet", reason };
  }
  route(systemBlocks, payload, signal) {
    this.calls.push({ systemBlocks: [...systemBlocks], payload, signal });
    return streamFromChunks(this.chunks);
  }
  getLastOutcome() {
    return this.lastOutcome;
  }
}

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildHost({
  routerChunks = ["Sure thing.", " Anything else?"],
  routerReason = "trigger=EXPLICIT_ASK",
  jsonlPath,
} = {}) {
  const vad = new FakeVad();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const router = new FakeRouter({ chunks: routerChunks, reason: routerReason });
  const telemetry = new TurnTelemetry(jsonlPath);
  const host = new AudioHost({
    vad,
    stt,
    tts,
    router,
    turnTelemetry: telemetry,
    getSystemBlocks: () => ["TUTOR-PROMPT", "DRY-OVERLAY"],
    getMode: () => "tutor",
    getPersonality: () => "dry",
    getWakeWord: () => "off",
    log: () => {},
  });
  return { host, vad, stt, tts, router, telemetry };
}

test("16.1 (a) full voice turn produces exactly one turns.jsonl line and feeds TTS sentences", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    const { host, vad, stt, router, tts } = buildHost({
      routerChunks: ["First sentence.", " Second one!"],
      routerReason: "trigger=EXPLICIT_ASK",
      jsonlPath,
    });
    assert.equal(host.getState(), "IDLE");

    // 1. VAD: user starts talking.
    vad.emitStart();
    assert.equal(host.getState(), "LISTENING");

    // 2. VAD: user stops. (No-op on the loop; STT is responsible
    //    for delivering the final transcript next.)
    vad.emitEnd();
    assert.equal(host.getState(), "LISTENING");

    // 3. STT: final transcript arrives. The loop transitions to
    //    THINKING, calls router.route, iterates the chunks, splits
    //    on sentence boundaries, calls tts.feedSentence per sentence,
    //    then transitions to IDLE when the stream ends.
    stt.emitFinal("explain it");
    await host.awaitSettled();

    assert.equal(host.getState(), "IDLE");
    assert.equal(router.calls.length, 1);
    assert.deepEqual(router.calls[0].systemBlocks, ["TUTOR-PROMPT", "DRY-OVERLAY"]);
    assert.deepEqual(router.calls[0].payload, { user_question: "explain it" });
    assert.deepEqual(tts.fed, ["First sentence.", "Second one!"]);
    assert.equal(tts.finishCalls, 1);

    // 4. The headline assertion: exactly one turns.jsonl line.
    assert.ok(existsSync(jsonlPath), "turns.jsonl must exist");
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `expected 1 turn line, got ${lines.length}`);
    const turn = JSON.parse(lines[0]);
    assert.equal(turn.method, "turn");
    assert.equal(turn.router_reason, "trigger=EXPLICIT_ASK");
    assert.equal(turn.mode, "tutor");
    assert.equal(turn.personality, "dry");
    assert.equal(turn.wake_word, "off");
    assert.ok(turn.end_to_end_ms >= 0, "end_to_end_ms must be a number");
    // MVP per 16.1: token usage isn't captured yet (deferred to
    // 16.1.x), so both tier flags stay false. The line is still
    // a valid turn entry — that's the spec's MVP bar.
    assert.equal(turn.haiku_tier, false);
    assert.equal(turn.sonnet_tier, false);
  } finally {
    cleanup();
  }
});

test("16.1 (b) empty STT transcript produces NO turns.jsonl line (loop returns to IDLE without a turn)", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    const { host, vad, stt } = buildHost({ jsonlPath });
    vad.emitStart();
    stt.emitFinal("   ");
    await host.awaitSettled();
    assert.equal(host.getState(), "IDLE");
    // No file written because no turn was recorded — the loop went
    // LISTENING → IDLE without a SPEAKING transition.
    if (existsSync(jsonlPath)) {
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 0);
    }
  } finally {
    cleanup();
  }
});

test("16.1 (c) barge-in mid-utterance still records the partial turn (cost was real)", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    // Use a slow router that yields one chunk then awaits forever
    // (interrupted by abort). Capture turn telemetry on
    // INTERRUPTED → LISTENING.
    const fakeRouter = {
      calls: [],
      lastOutcome: { tier: "sonnet", reason: "trigger=EXPLICIT_ASK" },
      route(systemBlocks, payload, signal) {
        this.calls.push({ systemBlocks: [...systemBlocks], payload });
        return {
          async *[Symbol.asyncIterator]() {
            yield "First sentence. ";
            // Park forever; the abort will break us out.
            for (let i = 0; i < 200; i++) {
              if (signal?.aborted) return;
              await wait(5);
            }
          },
        };
      },
      getLastOutcome() {
        return this.lastOutcome;
      },
    };
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const telemetry = new TurnTelemetry(jsonlPath);
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router: fakeRouter,
      turnTelemetry: telemetry,
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    vad.emitStart();
    stt.emitFinal("explain it");

    // Wait until the loop has emitted "First sentence." and entered SPEAKING.
    while (host.getState() !== "SPEAKING") await wait(2);

    // Barge-in mid-utterance.
    vad.emitStart();
    await host.awaitSettled();

    // Loop returns to LISTENING after barge-in cleanup.
    assert.equal(host.getState(), "LISTENING");
    // Recorded one turn (the interrupted partial).
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `expected 1 partial-turn line, got ${lines.length}`);
    // tts.dispose was called (registered as the "tts" canceller in the host).
    assert.ok(tts.disposeCalls >= 1, "barge-in must dispose the TTS sink");
  } finally {
    cleanup();
  }
});

test("16.1 (d) wakeWord/personality/mode are pulled from getters at record time, not construction time", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    let mode = "tutor";
    let personality = "nice";
    let wake = "off";
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const router = new FakeRouter({
      chunks: ["ok."],
      reason: "trigger=EXPLICIT_ASK",
    });
    const telemetry = new TurnTelemetry(jsonlPath);
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router,
      turnTelemetry: telemetry,
      getSystemBlocks: () => ["sys"],
      getMode: () => mode,
      getPersonality: () => personality,
      getWakeWord: () => wake,
      log: () => {},
    });
    // Mutate the values after construction; the host must observe
    // the *current* values when the turn ends.
    mode = "reviewer";
    personality = "drill_sergeant";
    wake = "hey buddy";

    vad.emitStart();
    stt.emitFinal("look at this");
    await host.awaitSettled();

    const turn = JSON.parse(readFileSync(jsonlPath, "utf8").trim());
    assert.equal(turn.mode, "reviewer");
    assert.equal(turn.personality, "drill_sergeant");
    assert.equal(turn.wake_word, "hey buddy");
  } finally {
    cleanup();
  }
});

test("16.1 (e) host always registers a 'tts' canceller on the BargeInController", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    const { BargeInController } = await import("../dist/barge-in.js");
    const bargeIn = new BargeInController({ log: () => {} });
    assert.equal(bargeIn.size(), 0);
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const router = new FakeRouter();
    const telemetry = new TurnTelemetry(jsonlPath);
    new AudioHost({
      vad,
      stt,
      tts,
      router,
      turnTelemetry: telemetry,
      bargeIn,
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });
    assert.equal(bargeIn.size(), 1, "host must register exactly one canceller");

    // Trigger barge-in; tts.dispose should be called.
    await bargeIn.trigger();
    assert.equal(tts.disposeCalls, 1);
  } finally {
    cleanup();
  }
});
