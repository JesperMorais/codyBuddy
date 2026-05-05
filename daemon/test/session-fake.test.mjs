// Verifies that Session accepts the AiClient interface (not the concrete
// AnthropicClient class) by wiring a FakeAnthropicClient and asserting the
// reply round-trips deterministically.
// Run: node --test daemon/test/session-fake.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { Session } = await import("../dist/session.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

test("Session accepts the AiClient interface (fake)", async () => {
  const fake = new FakeAnthropicClient({
    replies: [{ mode: "chat", text: "Have you considered why?", wants_followup: false }],
  });
  const session = new Session(fake, prompts);

  const reply = await session.handleTrigger("EXPLICIT_ASK", {
    active_file: "src/foo.ts",
    user_question: "what is this loop doing?",
  });

  assert.equal(reply.mode, "chat");
  assert.equal(reply.text, "Have you considered why?");
  assert.equal(fake.calls.ask.length, 1);
  assert.equal(fake.calls.ask[0].systemPrompt, "fake tutor system prompt");
});

test("FakeAnthropicClient default reply is a no_op", async () => {
  const fake = new FakeAnthropicClient();
  const session = new Session(fake, prompts);

  const reply = await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });

  assert.equal(reply.mode, "no_op");
  assert.equal(reply.text, "");
});

test("FakeAnthropicClient consumes queued replies in order", async () => {
  const fake = new FakeAnthropicClient({
    replies: [
      { mode: "chat", text: "first", wants_followup: false },
      { mode: "chat", text: "second", wants_followup: false },
    ],
  });
  const session = new Session(fake, prompts);

  const r1 = await session.handleTrigger("EXPLICIT_ASK", { user_question: "q1" });
  const r2 = await session.handleTrigger("EXPLICIT_ASK", { user_question: "q2" });

  assert.equal(r1.text, "first");
  assert.equal(r2.text, "second");
  assert.equal(fake.calls.ask.length, 2);
});
