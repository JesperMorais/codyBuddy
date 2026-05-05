// Focused tests for Session.mute() — contract from RESEARCH.md §3.1 and
// the README "Hotkeys" row for Ctrl+Alt+M (Quiet for 30 min):
// - After mute(30), non-EXPLICIT_ASK triggers must return {mode: "no_op"}
//   AND must NOT consult the AI client.
// - EXPLICIT_ASK triggers always go through (the user explicitly asked).
// - unmute() restores normal behavior.
// Run: node --test daemon/test/session-mute.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { Session } = await import("../dist/session.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function build() {
  const fake = new FakeAnthropicClient({
    replies: [
      { mode: "chat", text: "ok", wants_followup: false },
      { mode: "chat", text: "second reply", wants_followup: false },
      { mode: "chat", text: "third reply", wants_followup: false },
    ],
  });
  return { fake, session: new Session(fake, prompts) };
}

test("1.5 (a) muted STUCK_LOOP returns no_op without calling the AI client", async () => {
  const { fake, session } = build();
  session.mute(30);

  const reply = await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });

  assert.equal(reply.mode, "no_op");
  assert.equal(reply.text, "");
  assert.equal(reply.wants_followup, false);
  assert.equal(fake.calls.ask.length, 0, "AI client must not be invoked while muted");
});

test("1.5 (b) muted MISCONCEPTION returns no_op without calling the AI client", async () => {
  const { fake, session } = build();
  session.mute(30);

  const reply = await session.handleTrigger("MISCONCEPTION", { active_file: "x.ts" });

  assert.equal(reply.mode, "no_op");
  assert.equal(fake.calls.ask.length, 0);
});

test("1.5 (c) muted EXPLICIT_ASK still goes through to the AI client", async () => {
  const { fake, session } = build();
  session.mute(30);

  const reply = await session.handleTrigger("EXPLICIT_ASK", {
    active_file: "x.ts",
    user_question: "why does this break?",
  });

  assert.equal(reply.mode, "chat");
  assert.equal(reply.text, "ok");
  assert.equal(fake.calls.ask.length, 1);
});

test("1.5 (d) unmute restores normal behavior on the next non-EXPLICIT_ASK trigger", async () => {
  const { fake, session } = build();
  session.mute(30);
  await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });
  assert.equal(fake.calls.ask.length, 0);

  session.unmute();
  const reply = await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });

  assert.equal(reply.mode, "chat");
  assert.equal(reply.text, "ok");
  assert.equal(fake.calls.ask.length, 1);
});

test("1.5 (e) isMuted() reflects state across mute/unmute", () => {
  const { session } = build();
  assert.equal(session.isMuted(), false);
  session.mute(30);
  assert.equal(session.isMuted(), true);
  session.unmute();
  assert.equal(session.isMuted(), false);
});
