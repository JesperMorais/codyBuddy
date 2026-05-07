// Task 10.8: WakeWordGate tests.
//
// Spec headline (verbatim): "with `BUDDY_WAKEWORD='hey buddy'` and a
// fixture transcript 'hello world hey buddy what time is it', assert
// only 'what time is it' reaches the LLM path."
//
// We exercise the gate directly with a fake clock so the 30s active
// window can be tested deterministically.
//
// Run: node --test daemon/test/wake-word.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { WakeWordGate } = await import("../dist/wake-word.js");

function buildGate({ phrase = "hey buddy", activeWindowMs = 30_000 } = {}) {
  let now = 1_000_000;
  const gate = new WakeWordGate({ phrase, activeWindowMs, clock: () => now });
  return {
    gate,
    advance(ms) {
      now += ms;
    },
    setClock(t) {
      now = t;
    },
    get now() {
      return now;
    },
  };
}

test("10.8 (a) spec headline: 'hello world hey buddy what time is it' forwards 'what time is it'", () => {
  const { gate } = buildGate();
  const result = gate.forward("hello world hey buddy what time is it");
  assert.equal(result.triggered, true);
  assert.equal(result.state, "armed");
  assert.equal(result.text, "what time is it");
});

test("10.8 (b) BUDDY_WAKEWORD='off' (or empty) is open-mic — every transcript forwards verbatim", () => {
  for (const off of ["off", "", "  ", undefined]) {
    const gate = new WakeWordGate({ phrase: off });
    const result = gate.forward("hello world  ");
    assert.equal(result.state, "off", `phrase=${JSON.stringify(off)} should be off`);
    assert.equal(result.text, "hello world");
    assert.equal(result.triggered, false);
  }
});

test("10.8 (c) gated state drops transcripts that don't contain the wake word", () => {
  const { gate } = buildGate();
  const result = gate.forward("not addressing the buddy at all");
  assert.equal(result.text, null);
  assert.equal(result.state, "gated");
  assert.equal(result.triggered, false);
});

test("10.8 (d) inside the 30s active window, follow-up transcripts pass through without the wake word", () => {
  const { gate, advance } = buildGate();
  // Trigger.
  gate.forward("hey buddy how do I run this?");
  // 5s later, follow-up.
  advance(5000);
  const followUp = gate.forward("also what does this error mean?");
  assert.equal(followUp.text, "also what does this error mean?");
  assert.equal(followUp.state, "armed");
  assert.equal(followUp.triggered, false);
});

test("10.8 (e) active window re-arms back to gated after 30s of silence", () => {
  const { gate, advance } = buildGate();
  gate.forward("hey buddy what's up");
  // Just past the 30s window.
  advance(30_001);
  assert.equal(gate.state(), "gated");
  const result = gate.forward("are you still there");
  assert.equal(result.text, null, "must drop transcripts after the window expires");
  assert.equal(result.state, "gated");
});

test("10.8 (f) follow-up traffic INSIDE the window bumps the deadline forward", () => {
  const { gate, advance } = buildGate();
  gate.forward("hey buddy first");
  // 25s later (still inside window) → second turn arrives.
  advance(25_000);
  const second = gate.forward("a follow-up question");
  assert.equal(second.state, "armed");
  // Now another 25s — without the bump this would be at +50s and gated.
  // With the bump, deadline is now+30s from the second turn.
  advance(25_000);
  assert.equal(gate.state(), "armed", "active conversation should keep the gate open");
  const third = gate.forward("and another follow-up");
  assert.equal(third.text, "and another follow-up");
  assert.equal(third.state, "armed");
});

test("10.8 (g) wake word is matched case-insensitively and stripped from the forwarded text", () => {
  const { gate } = buildGate();
  const result = gate.forward("HEY BUDDY tell me a joke");
  assert.equal(result.triggered, true);
  assert.equal(result.text, "tell me a joke");
});

test("10.8 (h) two wake-word fires in one transcript: only the first split is taken", () => {
  // "hey buddy A hey buddy B" → "A hey buddy B" (the second occurrence
  // is part of the user's question to the buddy; we don't second-guess).
  const { gate } = buildGate();
  const result = gate.forward("hey buddy A hey buddy B");
  assert.equal(result.triggered, true);
  assert.equal(result.text, "A hey buddy B");
});

test("10.8 (i) wake word with no follow-up text returns text:null but still arms the gate", () => {
  const { gate } = buildGate();
  const result = gate.forward("hey buddy");
  assert.equal(result.triggered, true);
  assert.equal(result.text, null, "no follow-up content to forward");
  assert.equal(result.state, "armed", "but the gate is now armed for the next turn");
});

test("10.8 (j) disarm() takes the gate back to gated immediately", () => {
  const { gate } = buildGate();
  gate.forward("hey buddy hi");
  assert.equal(gate.state(), "armed");
  gate.disarm();
  assert.equal(gate.state(), "gated");
  // Next transcript without the wake word is dropped.
  assert.equal(gate.forward("are you there").text, null);
});

test("10.8 (k) custom wake word other than 'hey buddy' works", () => {
  const { gate } = buildGate({ phrase: "computer" });
  const result = gate.forward("hello computer what is it");
  assert.equal(result.triggered, true);
  assert.equal(result.text, "what is it");
});

// 16.13: WakeWordGate.findPhrase was a substring match (String#indexOf
// on the lowercased haystack), so wake word "buddy" triggered on
// "buddybuilds" or "my buddyship is great". Switched to a whole-word
// regex match. The cases below pin the new semantics.

test("16.13 (l) single-word wake 'buddy' triggers on a real word boundary", () => {
  const { gate } = buildGate({ phrase: "buddy" });
  const result = gate.forward("hey buddy what time is it");
  assert.equal(result.triggered, true);
  assert.equal(result.state, "armed");
  assert.equal(result.text, "what time is it");
});

test("16.13 (m) single-word wake 'buddy' does NOT trigger on 'buddybuilds'", () => {
  const { gate } = buildGate({ phrase: "buddy" });
  const result = gate.forward("buddybuilds is a cool startup");
  assert.equal(result.triggered, false, "'buddybuilds' must not be treated as the wake word");
  assert.equal(result.state, "gated");
  assert.equal(result.text, null);
});

test("16.13 (n) single-word wake 'buddy' does NOT trigger on 'my buddyship is great'", () => {
  const { gate } = buildGate({ phrase: "buddy" });
  const result = gate.forward("my buddyship is great");
  assert.equal(result.triggered, false);
  assert.equal(result.state, "gated");
  assert.equal(result.text, null);
});

test("16.13 (o) wake word still triggers when followed by punctuation (no trailing space)", () => {
  const { gate } = buildGate({ phrase: "buddy" });
  const result = gate.forward("buddy, what's the weather?");
  assert.equal(result.triggered, true);
  assert.equal(result.state, "armed");
  // Anything after the wake word is forwarded verbatim modulo trim.
  assert.equal(result.text, ", what's the weather?");
});
