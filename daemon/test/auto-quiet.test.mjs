// Task 13.1: auto-quiet detector tests.
//
// Spec contract:
//   "Simulate 6 minutes of silence; assert no Sonnet calls fired and
//    the loop transitioned to QUIET."
//
// Coverage:
//   (a) Gate unit tests — silence threshold, wake-word & length
//       filters, activity reset.
//   (b) ConversationLoop integration — under 6min silence + a
//       short transcript, completeUtterance is never invoked
//       (i.e. no Sonnet call). The loop reflects QUIET state.
//
// Run: node --test daemon/test/auto-quiet.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { AutoQuietGate } = await import("../dist/auto-quiet.js");
const { ConversationLoop } = await import("../dist/conversation.js");

// --- (a) gate unit tests -----------------------------------------

function fakeClock(initial = 1_700_000_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

test("13.1 (a) bootstraps as ACTIVE", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now });
  assert.equal(gate.state(), "ACTIVE");
});

test("13.1 (a) flips to QUIET after silenceMs without activity", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now, silenceMs: 5 * 60_000 });
  assert.equal(gate.state(), "ACTIVE");
  clock.advance(4 * 60_000);
  assert.equal(gate.state(), "ACTIVE", "still ACTIVE under threshold");
  clock.advance(2 * 60_000); // total 6 minutes
  assert.equal(gate.state(), "QUIET");
});

test("13.1 (a) noteActivity resets to ACTIVE", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now, silenceMs: 60_000 });
  clock.advance(120_000);
  assert.equal(gate.state(), "QUIET");
  gate.noteActivity();
  assert.equal(gate.state(), "ACTIVE");
});

test("13.1 (a) ACTIVE forwards every transcript", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now });
  const decision = gate.shouldForwardTranscript("ok");
  assert.equal(decision.dropped, false);
  assert.equal(decision.state, "ACTIVE");
});

test("13.1 (a) QUIET + wake-word match forwards and resets to ACTIVE", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 60_000,
    wakeWord: "hey buddy",
  });
  clock.advance(120_000);
  assert.equal(gate.state(), "QUIET");
  const dec = gate.shouldForwardTranscript("hey buddy what's the deal");
  assert.equal(dec.dropped, false);
  assert.equal(gate.state(), "ACTIVE", "wake-word match resets gate");
});

test("13.1 (a) QUIET + wake-word missing drops the transcript", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 60_000,
    wakeWord: "hey buddy",
  });
  clock.advance(120_000);
  const dec = gate.shouldForwardTranscript("yeah whatever");
  assert.equal(dec.dropped, true);
  assert.equal(dec.reason, "wake-word-not-matched");
  assert.equal(gate.state(), "QUIET", "drop does NOT reset to ACTIVE");
});

test("13.1 (a) QUIET + no wake word + short transcript drops", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 60_000,
    minTranscriptChars: 24,
  });
  clock.advance(120_000);
  const dec = gate.shouldForwardTranscript("uh-huh"); // < 24 chars
  assert.equal(dec.dropped, true);
  assert.equal(dec.reason, "transcript-too-short");
});

test("13.1 (a) QUIET + no wake word + long transcript forwards and resets", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 60_000,
    minTranscriptChars: 24,
  });
  clock.advance(120_000);
  const longText = "I have a real question about this code I'm staring at right now";
  const dec = gate.shouldForwardTranscript(longText);
  assert.equal(dec.dropped, false);
  assert.equal(gate.state(), "ACTIVE", "length-based wake also resets");
});

test("13.1 (a) empty transcript is always dropped, never resets", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now, silenceMs: 60_000 });
  clock.advance(120_000);
  assert.equal(gate.state(), "QUIET");
  const dec = gate.shouldForwardTranscript("   ");
  assert.equal(dec.dropped, true);
  assert.equal(dec.reason, "empty-transcript");
  assert.equal(gate.state(), "QUIET", "empty doesn't reset");
});

test("13.1 (a) wake-word match is case-insensitive", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 60_000,
    wakeWord: "Hey Buddy",
  });
  clock.advance(120_000);
  assert.equal(
    gate.shouldForwardTranscript("HEY BUDDY help me out").dropped,
    false
  );
});

test("13.1 (a) forceQuiet drops the gate without waiting for the clock", () => {
  const gate = new AutoQuietGate({ silenceMs: 5 * 60_000 });
  assert.equal(gate.state(), "ACTIVE");
  gate.forceQuiet();
  assert.equal(gate.state(), "QUIET");
});

// --- (b) ConversationLoop integration ----------------------------

function makeLoopDeps() {
  const calls = { complete: 0, speak: 0, finish: 0, cancel: 0 };
  return {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* (_payload, _signal) {
      calls.complete += 1;
      yield "hello"; // single chunk so SPEAKING fires
    },
    speakSentence: async () => {
      calls.speak += 1;
    },
    finishUtterance: () => {
      calls.finish += 1;
    },
    cancelSpeak: () => {
      calls.cancel += 1;
    },
    log: () => {},
    _calls: calls,
  };
}

test("13.1 (b) 6 min of silence → QUIET; transcript dropped, no Sonnet call", async () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 5 * 60_000,
    minTranscriptChars: 24,
  });
  const deps = { ...makeLoopDeps(), quietGate: gate };
  const loop = new ConversationLoop(deps);

  // Simulate 6 minutes of silence — no speechEnd, no opportunity.
  clock.advance(6 * 60_000);
  assert.equal(loop.quietState(), "QUIET");

  // Drive a short transcript through the loop. Without the gate
  // it would call completeUtterance; with the gate, it gets
  // dropped before reaching the LLM.
  loop.speechStart(); // IDLE → LISTENING (gate not consulted here)
  await loop.transcript("hi"); // 2 chars — under length threshold

  assert.equal(deps._calls.complete, 0, "no Sonnet call after gate drop");
  assert.equal(loop.getState(), "IDLE", "loop bounced back to IDLE");
  assert.equal(loop.quietState(), "QUIET", "still in QUIET after drop");
});

test("13.1 (b) ACTIVE state forwards transcripts normally", async () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now, silenceMs: 5 * 60_000 });
  const deps = { ...makeLoopDeps(), quietGate: gate };
  const loop = new ConversationLoop(deps);

  // Stay under the silence threshold.
  clock.advance(60_000);
  assert.equal(loop.quietState(), "ACTIVE");

  loop.speechStart();
  await loop.transcript("hello can you help me with this thing");
  await loop.awaitSettled();

  assert.equal(deps._calls.complete, 1, "Sonnet called exactly once");
});

test("13.1 (b) speechEnd resets the quiet gate", async () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now, silenceMs: 5 * 60_000 });
  const deps = { ...makeLoopDeps(), quietGate: gate };
  const loop = new ConversationLoop(deps);

  clock.advance(6 * 60_000);
  assert.equal(loop.quietState(), "QUIET");
  loop.speechEnd();
  assert.equal(loop.quietState(), "ACTIVE", "speech.end reset the gate");
});

test("13.1 (b) editor opportunity resets the quiet gate", () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({ now: clock.now, silenceMs: 5 * 60_000 });
  const deps = { ...makeLoopDeps(), quietGate: gate };
  const loop = new ConversationLoop(deps);

  clock.advance(6 * 60_000);
  assert.equal(loop.quietState(), "QUIET");

  loop.enqueueOpportunity({ trigger: "MISCONCEPTION", payload: {} });
  assert.equal(loop.quietState(), "ACTIVE", "editor edit reset the gate");
});

test("13.1 (b) wake-word match in QUIET wakes the buddy and forwards transcript", async () => {
  const clock = fakeClock();
  const gate = new AutoQuietGate({
    now: clock.now,
    silenceMs: 5 * 60_000,
    wakeWord: "hey buddy",
  });
  const deps = { ...makeLoopDeps(), quietGate: gate };
  const loop = new ConversationLoop(deps);

  clock.advance(6 * 60_000);
  assert.equal(loop.quietState(), "QUIET");

  loop.speechStart();
  await loop.transcript("hey buddy can you look at this");
  await loop.awaitSettled();

  assert.equal(deps._calls.complete, 1, "Sonnet called once after wake-word");
  assert.equal(loop.quietState(), "ACTIVE");
});

test("13.1 (b) loop without a quietGate behaves exactly as before", async () => {
  // Back-compat: passing no quietGate must leave behavior unchanged
  // — short transcripts still go through, no implicit filtering.
  const deps = makeLoopDeps();
  const loop = new ConversationLoop(deps);
  assert.equal(loop.quietState(), null, "no gate → null state");
  loop.speechStart();
  await loop.transcript("hi");
  await loop.awaitSettled();
  assert.equal(deps._calls.complete, 1);
});
