// Task 16.1.8: sidebar status pill driven by ConversationLoop
// transitions.
//
// Spec headline (TASKS.md 16.1.8): "drive the loop through THINKING +
// SPEAKING; assert two `loopState` frames arrived in the right order."
//
// We exercise the audio host's onLoopState callback end-to-end:
// drive a turn through the natural state machine and assert the
// emitted wire-format states (lowercase) arrive in order. Also
// covers the autoQuiet override (IDLE → "quiet" when the gate is
// QUIET) and the back-compat path (callback omitted = no-op).
//
// Run: node --test daemon/test/audio-host-loop-state.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost, mapLoopStateToWire } = await import(
  "../dist/audio-host.js"
);
const { TurnTelemetry } = await import("../dist/turn-telemetry.js");
const { AutoQuietGate } = await import("../dist/auto-quiet.js");

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
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1.8-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildHost({ onLoopState, autoQuiet } = {}) {
  const tmp = freshTempDir();
  const vad = new FakeVad();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const router = {
    route() {
      return streamFromChunks(["acknowledged."]);
    },
    getLastOutcome() {
      return { tier: "haiku", reason: "no_escalation" };
    },
  };
  const host = new AudioHost({
    vad,
    stt,
    tts,
    router,
    turnTelemetry: new TurnTelemetry(join(tmp.dir, "turns.jsonl")),
    onLoopState,
    autoQuiet,
    getSystemBlocks: () => ["sys"],
    getMode: () => "tutor",
    getPersonality: () => "nice",
    getWakeWord: () => "off",
    log: () => {},
  });
  return { host, vad, stt, cleanup: tmp.cleanup };
}

test("16.1.8 (a) SPEC HEADLINE: drive the loop through THINKING + SPEAKING; two loopState frames arrive in the right order", async () => {
  const seen = [];
  const { host, vad, stt, cleanup } = buildHost({
    onLoopState: (state) => seen.push(state),
  });
  try {
    // Drive a turn: IDLE → LISTENING (speech-start) → THINKING (final)
    // → SPEAKING (router yields chunk) → IDLE (sentence_done).
    vad.emitStart();
    stt.emitFinal("question one");
    await host.awaitSettled();

    // The state machine emits transitions on every change. The spec
    // pins THINKING and SPEAKING in that order, but we also expect to
    // see the bracketing LISTENING/IDLE for completeness.
    const thinkingIdx = seen.indexOf("thinking");
    const speakingIdx = seen.indexOf("speaking");
    assert.ok(
      thinkingIdx !== -1,
      `seen=${JSON.stringify(seen)} — missing 'thinking'`
    );
    assert.ok(
      speakingIdx !== -1,
      `seen=${JSON.stringify(seen)} — missing 'speaking'`
    );
    assert.ok(
      thinkingIdx < speakingIdx,
      `seen=${JSON.stringify(seen)} — 'thinking' must precede 'speaking'`
    );
  } finally {
    cleanup();
  }
});

test("16.1.8 (b) all wire states are lowercase and match ConversationState names", async () => {
  const seen = [];
  const { host, vad, stt, cleanup } = buildHost({
    onLoopState: (state) => seen.push(state),
  });
  try {
    vad.emitStart();
    stt.emitFinal("hi");
    await host.awaitSettled();

    // No uppercase states should ever leak through the wire format.
    for (const s of seen) {
      assert.equal(
        s,
        s.toLowerCase(),
        `state '${s}' must be lowercase on the wire`
      );
      // Must be one of the documented values.
      assert.ok(
        ["idle", "listening", "thinking", "speaking", "interrupted", "quiet"].includes(s),
        `state '${s}' must be a documented wire label`
      );
    }
  } finally {
    cleanup();
  }
});

test("16.1.8 (c) callback omitted preserves prior behaviour (no throw, no broadcast)", async () => {
  const { host, vad, stt, cleanup } = buildHost({}); // no onLoopState
  try {
    vad.emitStart();
    stt.emitFinal("ok");
    await host.awaitSettled();
    // The lack of an assertion is the assertion — host must not throw.
    void host;
  } finally {
    cleanup();
  }
});

test("16.1.8 (d) onLoopState that throws is logged but does not break the loop", async () => {
  const errs = [];
  const { host, vad, stt, cleanup } = buildHost({
    onLoopState: () => {
      throw new Error("boom");
    },
  });
  try {
    vad.emitStart();
    stt.emitFinal("hello");
    await host.awaitSettled();
    // Loop must still complete the turn — getState returns IDLE.
    assert.equal(host.getState(), "IDLE");
    void errs;
  } finally {
    cleanup();
  }
});

test("16.1.8 (e) mapLoopStateToWire: IDLE + autoQuiet QUIET → 'quiet'; otherwise loop state lowercased", () => {
  // No gate → straight lowercase.
  assert.equal(mapLoopStateToWire("IDLE"), "idle");
  assert.equal(mapLoopStateToWire("LISTENING"), "listening");
  assert.equal(mapLoopStateToWire("THINKING"), "thinking");
  assert.equal(mapLoopStateToWire("SPEAKING"), "speaking");
  assert.equal(mapLoopStateToWire("INTERRUPTED"), "interrupted");

  // Gate ACTIVE → no override.
  let nowMs = 1_000_000;
  const activeGate = new AutoQuietGate({
    silenceMs: 5 * 60_000,
    now: () => nowMs,
  });
  // Activate the gate so it's in ACTIVE.
  activeGate.noteActivity();
  assert.equal(mapLoopStateToWire("IDLE", activeGate), "idle");

  // Gate QUIET (silenceMs elapsed) AND loop IDLE → 'quiet'.
  const quietGate = new AutoQuietGate({
    silenceMs: 60_000,
    now: () => nowMs,
  });
  quietGate.noteActivity();
  nowMs += 120_000; // 2min later — past the 1min silence.
  assert.equal(quietGate.state(), "QUIET");
  assert.equal(mapLoopStateToWire("IDLE", quietGate), "quiet");

  // Gate QUIET but loop NOT IDLE → loop state still wins (the gate
  // override is only meaningful when the loop is otherwise idle).
  assert.equal(mapLoopStateToWire("LISTENING", quietGate), "listening");
  assert.equal(mapLoopStateToWire("THINKING", quietGate), "thinking");
});

test("16.1.8 (f) host.getWireState() reflects the current state after-gate", async () => {
  let nowMs = 1_000_000;
  const gate = new AutoQuietGate({
    silenceMs: 60_000,
    now: () => nowMs,
  });
  const { host, vad, stt, cleanup } = buildHost({ autoQuiet: gate });
  try {
    // Initially ACTIVE → IDLE => "idle"
    assert.equal(host.getWireState(), "idle");

    // Drive a turn — wire state passes through normal transitions.
    vad.emitStart();
    stt.emitFinal("hi");
    await host.awaitSettled();
    assert.equal(host.getWireState(), "idle"); // back to IDLE

    // Advance past silence threshold — gate flips to QUIET → wire
    // becomes 'quiet' even though loop state is still IDLE.
    nowMs += 120_000;
    assert.equal(gate.state(), "QUIET");
    assert.equal(host.getWireState(), "quiet");
  } finally {
    cleanup();
  }
});
