// Real-API smoke test gated on ANTHROPIC_API_KEY.
// SKIPPED automatically when the key is missing — CI is fine.
// To run locally: set ANTHROPIC_API_KEY in .env, then `pnpm test`.
//
// Asserts that the tutor system prompt + a synthetic trigger payload comes
// back as a parseable BuddyReply (mode ∈ {speak, chat, no_op}, text string,
// wants_followup boolean).
//
// Run: node --test daemon/test/anthropic-smoke.test.mjs

import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const apiKey = process.env.ANTHROPIC_API_KEY;
const skip = !apiKey;

if (skip) {
  console.log("SKIP: ANTHROPIC_API_KEY not set — real-API smoke test skipped");
}

const { AnthropicClient } = await import("../dist/anthropic.js");

test("real-API smoke: tutor prompt + synthetic trigger returns a parseable BuddyReply", { skip }, async () => {
  const tutorPrompt = readFileSync(resolve(__dirname, "../prompts/tutor.md"), "utf8");
  const model = process.env.BUDDY_MODEL ?? "claude-sonnet-4-6";
  const client = new AnthropicClient(apiKey, model);

  const triggerPayload = {
    trigger: "EXPLICIT_ASK",
    active_file: "src/foo.ts",
    selection: { line: 12, text: "  return arr.reduce((a, b) => a + b);" },
    diagnostics: [],
    recent_diff: "",
    recent_terminal: [],
    user_question: "what does reduce do here?",
  };

  const reply = await client.ask(tutorPrompt, "(no summary yet)", triggerPayload);

  // Shape contract from BuddyReply
  assert.ok(["speak", "chat", "no_op"].includes(reply.mode), `mode must be speak|chat|no_op, got ${reply.mode}`);
  assert.equal(typeof reply.text, "string");
  assert.equal(typeof reply.wants_followup, "boolean");

  // For an EXPLICIT_ASK we should always get *some* response — the tutor
  // prompt rule 8 (NO_OP if not confident) should not fire on a clear question.
  // But this is a soft assertion — if the model returned no_op, we don't fail
  // the smoke test, we just log it.
  if (reply.mode === "no_op") {
    console.log("note: model returned no_op for an EXPLICIT_ASK — unusual but not a failure");
  } else {
    assert.ok(reply.text.length > 0, "non-no_op reply should have text");
  }
});
