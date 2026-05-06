// Task 4.1 minimal wire-up test — verifies that the Haiku gate hook is
// actually consulted from Session.handleTrigger, and that EXPLICIT_ASK
// bypasses it (the user explicitly asked — never silence them).
//
// Comprehensive behaviour coverage (no_op skips Sonnet, speak invokes both
// arms) lives in Task 4.2.
//
// Run: node --test daemon/test/haiku-gate-wire.test.mjs

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
  const dir = mkdtempSync(join(tmpdir(), "buddy-4.1-"));
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, { memory });
  return {
    session,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("4.1 (a) shouldSpeak is consulted on non-EXPLICIT_ASK triggers", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["chat"],
    replies: [{ mode: "chat", text: "ok", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });

    assert.equal(fake.calls.shouldSpeak.length, 1, "shouldSpeak must be called");
    assert.equal(fake.calls.ask.length, 1, "ask must follow when gate allows");
  } finally {
    cleanup();
  }
});

test("4.1 (b) EXPLICIT_ASK bypasses the Haiku gate entirely", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["no_op"], // would silence STUCK_LOOP, but EXPLICIT_ASK ignores it
    replies: [{ mode: "chat", text: "answer", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    const reply = await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "why does this break?",
    });

    assert.equal(fake.calls.shouldSpeak.length, 0, "EXPLICIT_ASK must not consult the gate");
    assert.equal(fake.calls.ask.length, 1);
    assert.equal(reply.text, "answer");
  } finally {
    cleanup();
  }
});
