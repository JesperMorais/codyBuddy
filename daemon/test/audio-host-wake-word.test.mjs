// Task 16.1.3: WakeWordGate filters STT finals before reaching the loop.
//
// Spec headline (TASKS.md 16.1.3): "with the gate set to 'hey buddy',
// stt.emitFinal('hello') produces no loop.transcript call;
// stt.emitFinal('hey buddy what's up') produces loop.transcript('what's up')."
//
// We can observe the loop's behaviour through the host: when no
// turn fires, the router never gets called and nothing reaches the
// TTS sink. When a turn DOES fire, the router gets the
// post-wake-word remainder as the user_question, and TTS feeds the
// reply chunks.
//
// Run: node --test daemon/test/audio-host-wake-word.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost } = await import("../dist/audio-host.js");
const { WakeWordGate } = await import("../dist/wake-word.js");
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
  emitStart() {
    for (const h of this.startHandlers) h(0);
  }
  emitEnd() {
    for (const h of this.endHandlers) h(0);
  }
}

class FakeStt {
  constructor() {
    this.handlers = [];
  }
  onFinal(h) {
    this.handlers.push(h);
  }
  emitFinal(text) {
    for (const h of this.handlers) h(text, "engine");
  }
}

class FakeTts {
  feedSentence() {}
  finish() {}
  dispose() {}
}

function streamFromChunks(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await wait(1);
        yield c;
      }
    },
  };
}

function buildHost({ phrase = "hey buddy", clipsDir }) {
  const dir = clipsDir ?? mkdtempSync(join(tmpdir(), "buddy-16.1.3-"));
  const jsonlPath = join(dir, "turns.jsonl");
  const fakeRouter = {
    calls: [],
    route(systemBlocks, payload) {
      this.calls.push({ systemBlocks: [...systemBlocks], payload });
      return streamFromChunks(["ack."]);
    },
    getLastOutcome() {
      return { tier: "haiku", reason: "no_escalation" };
    },
  };
  const vad = new FakeVad();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const telemetry = new TurnTelemetry(jsonlPath);
  const wakeWordGate = new WakeWordGate({ phrase });
  const host = new AudioHost({
    vad,
    stt,
    tts,
    router: fakeRouter,
    turnTelemetry: telemetry,
    wakeWordGate,
    getSystemBlocks: () => ["sys"],
    getMode: () => "tutor",
    getPersonality: () => "nice",
    getWakeWord: () => phrase,
    log: () => {},
  });
  return {
    host,
    vad,
    stt,
    tts,
    fakeRouter,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("16.1.3 (a) SPEC HEADLINE part 1: stt.emitFinal('hello') with phrase='hey buddy' produces NO loop.transcript / no router call", async () => {
  const { host, vad, stt, fakeRouter, cleanup } = buildHost({});
  try {
    vad.emitStart();
    stt.emitFinal("hello");
    // Give any async work a tick to flush.
    await wait(20);
    assert.equal(host.getState(), "LISTENING", "loop should still be in LISTENING — gate dropped the transcript");
    assert.equal(fakeRouter.calls.length, 0, "router must NOT be called when wake-word missing");
  } finally {
    cleanup();
  }
});

test("16.1.3 (b) SPEC HEADLINE part 2: stt.emitFinal('hey buddy what's up') produces loop.transcript('what's up')", async () => {
  const { host, vad, stt, fakeRouter, cleanup } = buildHost({});
  try {
    vad.emitStart();
    stt.emitFinal("hey buddy what's up");
    await host.awaitSettled();
    assert.equal(fakeRouter.calls.length, 1, "router must be called once");
    assert.deepEqual(
      fakeRouter.calls[0].payload,
      { user_question: "what's up" },
      "loop.transcript must receive the post-wake-word remainder, with the phrase stripped"
    );
  } finally {
    cleanup();
  }
});

test("16.1.3 (c) inside the 30s active window, follow-up transcripts pass without re-saying the wake word", async () => {
  const { host, vad, stt, fakeRouter, cleanup } = buildHost({});
  try {
    // First turn — must include the wake word.
    vad.emitStart();
    stt.emitFinal("hey buddy first turn");
    await host.awaitSettled();
    assert.equal(fakeRouter.calls.length, 1);
    assert.deepEqual(fakeRouter.calls[0].payload, { user_question: "first turn" });

    // Second turn — gate is armed, so we can skip the wake word.
    vad.emitStart();
    stt.emitFinal("follow-up question");
    await host.awaitSettled();
    assert.equal(fakeRouter.calls.length, 2, "follow-up inside active window must reach the router");
    assert.deepEqual(fakeRouter.calls[1].payload, { user_question: "follow-up question" });
  } finally {
    cleanup();
  }
});

test("16.1.3 (d) phrase='off' keeps open-mic behaviour: every transcript reaches the loop", async () => {
  const { host, vad, stt, fakeRouter, cleanup } = buildHost({ phrase: "off" });
  try {
    vad.emitStart();
    stt.emitFinal("just a transcript with no wake word");
    await host.awaitSettled();
    assert.equal(fakeRouter.calls.length, 1);
    assert.deepEqual(fakeRouter.calls[0].payload, {
      user_question: "just a transcript with no wake word",
    });
  } finally {
    cleanup();
  }
});

test("16.1.3 (e) wakeWordGate omitted from deps preserves 16.1 MVP open-mic (back-compat)", async () => {
  // No wakeWordGate dep at all — host should pass everything through.
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1.3e-"));
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    const fakeRouter = {
      calls: [],
      route(systemBlocks, payload) {
        this.calls.push({ payload });
        return streamFromChunks(["ack."]);
      },
      getLastOutcome() {
        return { tier: "haiku", reason: "no_escalation" };
      },
    };
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router: fakeRouter,
      turnTelemetry: new TurnTelemetry(jsonlPath),
      // wakeWordGate intentionally omitted
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    vad.emitStart();
    stt.emitFinal("anything goes");
    await host.awaitSettled();
    assert.equal(fakeRouter.calls.length, 1);
    assert.deepEqual(fakeRouter.calls[0].payload, { user_question: "anything goes" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("16.1.3 (f) wake-word phrase with no follow-up content arms the gate but produces no turn", async () => {
  const { host, vad, stt, fakeRouter, cleanup } = buildHost({});
  try {
    // Just the wake word, no question — gate arms, but loop has nothing to forward.
    vad.emitStart();
    stt.emitFinal("hey buddy");
    await wait(20);
    // No transcript reached the loop, so no router call.
    assert.equal(fakeRouter.calls.length, 0);

    // Next turn (within the 30s active window) should pass freely.
    vad.emitStart();
    stt.emitFinal("now what");
    await host.awaitSettled();
    assert.equal(fakeRouter.calls.length, 1);
    assert.deepEqual(fakeRouter.calls[0].payload, { user_question: "now what" });
  } finally {
    cleanup();
  }
});
