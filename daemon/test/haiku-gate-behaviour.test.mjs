// Task 4.2 behavioural coverage of the Haiku gate (RESEARCH.md §5.4
// two-tier classifier). Pairs with the wire-up tests in
// haiku-gate-wire.test.mjs.
//
// Contract:
//   - With shouldSpeak() returning "no_op", Session.ask is NEVER invoked
//     (Sonnet round-trip skipped — the whole point of the gate).
//   - With "speak" or "chat", BOTH the gate and ask are invoked.
//   - Decision queue drains in order across multiple triggers.
//   - EXPLICIT_ASK still bypasses the gate even when the queue contains
//     no_op decisions ahead of it.
//
// Run: node --test daemon/test/haiku-gate-behaviour.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function freshSession(fake) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-4.2-"));
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, { memory });
  return {
    session,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("4.2 (a) gate=no_op short-circuits — ask is NEVER invoked", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["no_op"],
    replies: [{ mode: "chat", text: "should never be sent", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    const reply = await session.handleTrigger("STUCK_LOOP", { active_file: "foo.ts" });

    assert.equal(fake.calls.shouldSpeak.length, 1, "gate must be consulted");
    assert.equal(fake.calls.ask.length, 0, "ask must NOT run when gate says no_op");
    assert.equal(reply.mode, "no_op");
    assert.equal(reply.text, "");
    assert.equal(reply.wants_followup, false);
  } finally {
    cleanup();
  }
});

test("4.2 (b) gate=speak invokes both arms", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["speak"],
    replies: [{ mode: "speak", text: "have you tried await?", wants_followup: true }],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    const reply = await session.handleTrigger("MISCONCEPTION", { active_file: "foo.ts" });

    assert.equal(fake.calls.shouldSpeak.length, 1, "gate consulted");
    assert.equal(fake.calls.ask.length, 1, "ask invoked");
    assert.equal(reply.mode, "speak");
    assert.equal(reply.text, "have you tried await?");
  } finally {
    cleanup();
  }
});

test("4.2 (c) gate=chat also invokes both arms (gate is permissive)", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["chat"],
    replies: [{ mode: "chat", text: "let me think about that", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    const reply = await session.handleTrigger("BAD_PATH", { active_file: "foo.ts" });

    assert.equal(fake.calls.shouldSpeak.length, 1);
    assert.equal(fake.calls.ask.length, 1);
    assert.equal(reply.mode, "chat");
  } finally {
    cleanup();
  }
});

test("4.2 (d) decision queue drains in order across triggers", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["no_op", "speak", "no_op", "chat"],
    replies: [
      { mode: "speak", text: "second-trigger reply", wants_followup: false },
      { mode: "chat", text: "fourth-trigger reply", wants_followup: false },
    ],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    const r1 = await session.handleTrigger("STUCK_LOOP", { active_file: "1.ts" });
    const r2 = await session.handleTrigger("MISCONCEPTION", { active_file: "2.ts" });
    const r3 = await session.handleTrigger("BAD_PATH", { active_file: "3.ts" });
    const r4 = await session.handleTrigger("NEW_TOPIC", { active_file: "4.ts" });

    assert.equal(fake.calls.shouldSpeak.length, 4, "gate hit on every non-EXPLICIT_ASK");
    assert.equal(fake.calls.ask.length, 2, "only 2 of 4 reach Sonnet");
    assert.equal(r1.mode, "no_op");
    assert.equal(r2.text, "second-trigger reply");
    assert.equal(r3.mode, "no_op");
    assert.equal(r4.text, "fourth-trigger reply");
  } finally {
    cleanup();
  }
});

test("4.2 (e) EXPLICIT_ASK bypasses gate even when no_op is queued", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["no_op"], // would silence anything that consults the gate
    replies: [{ mode: "chat", text: "explicit answer", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    const reply = await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "explain this loop",
    });

    assert.equal(fake.calls.shouldSpeak.length, 0, "gate must not be consulted on EXPLICIT_ASK");
    assert.equal(fake.calls.ask.length, 1, "ask runs unconditionally for EXPLICIT_ASK");
    assert.equal(reply.text, "explicit answer");
  } finally {
    cleanup();
  }
});
