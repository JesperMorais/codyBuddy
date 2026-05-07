// Task 16.1.5: AutoQuietGate integration in the audio host.
//
// Spec headline (TASKS.md 16.1.5): "with mocked clock advanced 6
// minutes, stt.emitFinal produces no loop.transcript call until a
// recordActivity lands."
//
// We use the gate's `now` seam to control the wall clock; the host
// drives noteActivity() from VAD speech-start/-end events.
//
// Run: node --test daemon/test/audio-host-auto-quiet.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost } = await import("../dist/audio-host.js");
const { AutoQuietGate } = await import("../dist/auto-quiet.js");
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

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1.5-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildHost({ now, autoQuiet, fakeRouter }) {
  const vad = new FakeVad();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const router = fakeRouter ?? {
    calls: [],
    route(systemBlocks, payload) {
      this.calls.push({ payload });
      return streamFromChunks(["ack."]);
    },
    getLastOutcome() {
      return { tier: "haiku", reason: "no_escalation" };
    },
  };
  const tmp = freshTempDir();
  const host = new AudioHost({
    vad,
    stt,
    tts,
    router,
    turnTelemetry: new TurnTelemetry(join(tmp.dir, "turns.jsonl")),
    autoQuiet,
    getSystemBlocks: () => ["sys"],
    getMode: () => "tutor",
    getPersonality: () => "nice",
    getWakeWord: () => "off",
    log: () => {},
  });
  return { host, vad, stt, tts, router, cleanup: tmp.cleanup };
}

test("16.1.5 (a) SPEC HEADLINE: 6min silence drops short transcripts; noteActivity resumes forwarding", async () => {
  let nowMs = 1_000_000;
  const gate = new AutoQuietGate({
    silenceMs: 5 * 60_000,
    minTranscriptChars: 24,
    now: () => nowMs,
  });
  const { host, vad, stt, router, cleanup } = buildHost({ autoQuiet: gate });
  try {
    // Bootstrap: at t=0 the gate is ACTIVE and a short transcript
    // would pass. Advance 6 minutes — gate flips to QUIET.
    nowMs += 6 * 60_000;
    assert.equal(gate.state(), "QUIET");

    // emitFinal with a short transcript — auto-quiet drops it.
    stt.emitFinal("hi");
    await wait(20);
    assert.equal(router.calls.length, 0, "QUIET state must drop short transcripts");

    // Now a "recordActivity" lands (e.g. user starts talking again).
    vad.emitStart();
    assert.equal(gate.state(), "ACTIVE", "noteActivity from speech-start must resume ACTIVE");

    // The same short transcript now passes.
    stt.emitFinal("hi");
    await host.awaitSettled();
    assert.equal(router.calls.length, 1);
    assert.deepEqual(router.calls[0].payload, { user_question: "hi" });
  } finally {
    cleanup();
  }
});

test("16.1.5 (b) long transcript bypasses QUIET (length-based heuristic) AND resets to ACTIVE", async () => {
  let nowMs = 1_000_000;
  const gate = new AutoQuietGate({
    silenceMs: 5 * 60_000,
    minTranscriptChars: 24,
    now: () => nowMs,
  });
  const { host, vad, stt, router, cleanup } = buildHost({ autoQuiet: gate });
  try {
    // Loop must be in LISTENING for transcript() to flow — emit
    // speech-start first. (This also calls noteActivity, so the
    // 6min silence advance below puts the gate at exactly the
    // boundary, just like the production timing.)
    vad.emitStart();
    nowMs += 6 * 60_000;
    assert.equal(gate.state(), "QUIET");

    // 25-char transcript (≥24) — gate forwards AND resets to ACTIVE.
    stt.emitFinal("hey buddy what's the time?");
    await host.awaitSettled();
    assert.equal(router.calls.length, 1);
    assert.equal(gate.state(), "ACTIVE", "long transcript must reset gate to ACTIVE");

    // A second short follow-up now passes since gate is ACTIVE.
    vad.emitStart();
    stt.emitFinal("ok");
    await host.awaitSettled();
    assert.equal(router.calls.length, 2);
  } finally {
    cleanup();
  }
});

test("16.1.5 (c) wake-word in transcript bypasses QUIET — same wake word as BUDDY_WAKEWORD", async () => {
  let nowMs = 1_000_000;
  const gate = new AutoQuietGate({
    silenceMs: 5 * 60_000,
    wakeWord: "hey buddy",
    now: () => nowMs,
  });
  const { host, vad, stt, router, cleanup } = buildHost({ autoQuiet: gate });
  try {
    vad.emitStart();
    nowMs += 6 * 60_000;
    assert.equal(gate.state(), "QUIET");

    // Short transcript without the wake word — dropped.
    stt.emitFinal("hi");
    await wait(20);
    assert.equal(router.calls.length, 0);

    // Short transcript WITH the wake word — passes; gate flips to ACTIVE.
    stt.emitFinal("hey buddy go");
    await host.awaitSettled();
    assert.equal(router.calls.length, 1);
    assert.equal(gate.state(), "ACTIVE");
  } finally {
    cleanup();
  }
});

test("16.1.5 (d) autoQuiet omitted preserves 16.1 MVP behaviour: every transcript reaches the loop", async () => {
  const { host, vad, stt, router, cleanup } = buildHost({}); // no autoQuiet
  try {
    vad.emitStart();
    stt.emitFinal("hi");
    await host.awaitSettled();
    assert.equal(router.calls.length, 1);
  } finally {
    cleanup();
  }
});

test("16.1.5 (e) speech-end also fires noteActivity (so the gate stays ACTIVE through a normal pause)", async () => {
  let nowMs = 1_000_000;
  const gate = new AutoQuietGate({
    silenceMs: 1_000,
    minTranscriptChars: 24,
    now: () => nowMs,
  });
  const { host, vad, stt, router, cleanup } = buildHost({ autoQuiet: gate });
  try {
    // Cycle through a brief speech segment.
    vad.emitStart();
    nowMs += 200;
    vad.emitEnd();
    nowMs += 500;

    // Even past 1s of "silence", the prior speech-end reset the
    // clock; gate is still ACTIVE.
    assert.equal(gate.state(), "ACTIVE");
    stt.emitFinal("ok");
    await host.awaitSettled();
    assert.equal(router.calls.length, 1);
  } finally {
    cleanup();
  }
});
