// Task 6.2: snapshot-style assertions on the request AnthropicClient.ask
// builds for each mode.
//
// The "snapshot" here is the structural contract:
//   - model field is the configured model.
//   - system is a single ephemerally-cached text block whose `text` equals
//     daemon/prompts/<mode>.md byte-for-byte.
//   - messages has one user message with two content blocks:
//       [0]: ephemerally-cached "Session summary so far: …" block.
//       [1]: uncached JSON.stringify of the trigger payload (what
//            extension/src/extension.ts sendTrigger() builds + what's
//            captured under daemon/test/fixtures/<mode>.payload.json).
//
// Implementation: stub the Anthropic SDK's messages.stream at the instance
// level, capture the request object, then assert the structure.
//
// Run: node --test daemon/test/mode-fixtures.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");
const fixturesDir = join(__dirname, "fixtures");
const telemetryDir = mkdtempSync(join(tmpdir(), "buddy-6.2-tel-"));

const { AnthropicClient } = await import("../dist/anthropic.js");
const { Telemetry } = await import("../dist/telemetry.js");

const MODES = ["tutor", "architect", "explainer", "reviewer"];

function modePrompt(mode) {
  return readFileSync(join(promptsDir, `${mode}.md`), "utf8");
}

function fixturePayload(mode) {
  return JSON.parse(readFileSync(join(fixturesDir, `${mode}.payload.json`), "utf8"));
}

function buildClientWithStub(model = "claude-sonnet-4-6") {
  const captured = [];
  // Telemetry pointed at a temp file; we don't care about its side
  // effects in this test.
  const tel = new Telemetry(join(telemetryDir, "telemetry.jsonl"));
  const client = new AnthropicClient("fake-key", model, { telemetry: tel });
  client.client.messages.stream = (req) => {
    captured.push(req);
    return {
      finalMessage: async () => ({
        content: [{ type: "text", text: '{"mode":"chat","text":"ok","wants_followup":false}' }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    };
  };
  return { client, captured };
}

for (const mode of MODES) {
  test(`6.2 (${mode}) request structure matches fixture + ${mode}.md`, async () => {
    const { client, captured } = buildClientWithStub();
    const payload = fixturePayload(mode);
    const sessionSummary = "(no summary yet)";

    await client.ask([modePrompt(mode)], sessionSummary, payload);

    assert.equal(captured.length, 1);
    const req = captured[0];

    // Top-level
    assert.equal(req.model, "claude-sonnet-4-6");
    assert.equal(req.max_tokens, 400);

    // System block — exactly one, ephemerally cached, content = mode.md
    assert.ok(Array.isArray(req.system), "system must be an array of blocks");
    assert.equal(req.system.length, 1);
    assert.equal(req.system[0].type, "text");
    assert.equal(req.system[0].text, modePrompt(mode));
    assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });

    // Messages — exactly one user turn with two content blocks
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    const blocks = req.messages[0].content;
    assert.equal(blocks.length, 2);

    // Block 0: session summary, ephemerally cached
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text, /Session summary so far:/);
    assert.match(blocks[0].text, new RegExp(sessionSummary));
    assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });

    // Block 1: pretty-printed JSON of the trigger payload, NOT cached
    assert.equal(blocks[1].type, "text");
    assert.equal(blocks[1].text, JSON.stringify(payload, null, 2));
    assert.equal(blocks[1].cache_control, undefined);
  });
}

test("6.2 each block in systemBlocks becomes its own ephemerally-cached system entry", async () => {
  // Session is the layer that decides what goes into systemBlocks
  // (mode prompt, optional personality overlay, optional learner profile);
  // AnthropicClient.ask just maps each block to a cached text entry.
  // This test pins the per-block caching contract.
  const { client, captured } = buildClientWithStub();
  const payload = fixturePayload("tutor");

  const learnerBlock =
    "What I've noticed about this developer over time:\nRecurring: forgets await.";
  await client.ask([modePrompt("tutor"), learnerBlock], "", payload);

  const req = captured[0];
  assert.equal(req.system.length, 2);
  assert.equal(req.system[0].text, modePrompt("tutor"));
  assert.equal(req.system[1].text, learnerBlock);
  assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(req.system[1].cache_control, { type: "ephemeral" });
});

test("6.2 each mode's system prompt is distinct (no accidental cross-wiring)", () => {
  const seen = new Map();
  for (const mode of MODES) {
    const text = modePrompt(mode);
    const previous = seen.get(text);
    assert.equal(previous, undefined, `${mode}.md duplicates content from ${previous}`);
    seen.set(text, mode);
  }
});
