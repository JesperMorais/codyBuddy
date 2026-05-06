// Task 11.3: conversational-prompt loader + snapshot tests.
//
// Spec headline (verbatim): "snapshot the assembled system blocks
// for `conversational/tutor + drill_sergeant`."
//
// Coverage:
//   (a) Loader returns all four conversational modes.
//   (b) Each conversational prompt contains the spec's "speaking
//       aloud" rule and is plain-text (no JSON output instruction).
//   (c) SPEC HEADLINE: assembled system blocks for tutor +
//       drill_sergeant match the on-disk content exactly, in order.
//   (d) The chat-path mode prompts (one dir up) still ship and
//       are different from the conversational variants.
//   (e) Personality "nice" omits the overlay — same Session
//       contract as the chat path.
//
// Run: node --test daemon/test/conversational-prompts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { loadConversationalPrompts } = await import("../dist/conversational-prompts.js");
const { loadPromptDir } = await import("../dist/personalities-loader.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "..", "prompts");
const conversationalDir = join(promptsDir, "conversational");
const personalitiesDir = join(promptsDir, "personalities");

const REQUIRED_MODES = ["tutor", "reviewer", "architect", "explainer"];

test("11.3 (a) loadConversationalPrompts returns all four shipped modes", () => {
  const map = loadConversationalPrompts(promptsDir);
  for (const mode of REQUIRED_MODES) {
    assert.ok(map.has(mode), `missing conversational/${mode}.md`);
    const content = map.get(mode);
    assert.ok(content && content.length > 200, `${mode}.md is too short: ${content?.length} bytes`);
  }
});

test("11.3 (b) every conversational prompt carries the 'speaking aloud' rule and forbids JSON output", () => {
  const map = loadConversationalPrompts(promptsDir);
  for (const mode of REQUIRED_MODES) {
    const c = map.get(mode);
    // Spec rule: "you are speaking aloud — don't say file paths,
    // line numbers, or symbols longer than one identifier".
    assert.match(
      c,
      /speaking aloud/i,
      `${mode}.md must explicitly say "speaking aloud"`
    );
    assert.match(
      c,
      /file paths|line numbers/i,
      `${mode}.md must mention what NOT to say (file paths / line numbers)`
    );
    // Plain text — the chat-path prompts say "Output format: a
    // single JSON object". The conversational variants must say the
    // opposite.
    assert.match(
      c,
      /plain text/i,
      `${mode}.md must declare plain-text output`
    );
    assert.ok(
      !/JSON object/i.test(c),
      `${mode}.md must NOT declare JSON output`
    );
    // 1-2 sentence default — the spec value, not 3-5.
    assert.match(
      c,
      /1-2 sentences|1\s*-\s*2\s*sentences/i,
      `${mode}.md must declare a 1-2 sentence default length`
    );
  }
});

test("11.3 (c) SPEC HEADLINE: assembled system blocks for conversational/tutor + drill_sergeant match disk", async () => {
  const tutor = readFileSync(join(conversationalDir, "tutor.md"), "utf8");
  const drillSergeant = readFileSync(join(personalitiesDir, "drill_sergeant.md"), "utf8");

  // Build a fresh session against the conversational mode prompt
  // and the real drill_sergeant overlay. handleTrigger sends the
  // assembled blocks straight to the FakeAnthropicClient so we can
  // pin them.
  const dir = mkdtempSync(join(tmpdir(), "buddy-11.3-"));
  try {
    const fake = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "ack", wants_followup: false }],
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, new Map([["tutor", tutor]]), {
      memory,
      personalities: new Map([
        ["nice", "(would be nice overlay)"],
        ["drill_sergeant", drillSergeant],
      ]),
      defaultPersonality: "drill_sergeant",
    });

    await session.handleTrigger("EXPLICIT_ASK", { user_question: "?" });

    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 2, "tutor + drill_sergeant → exactly 2 system blocks");
    assert.equal(blocks[0], tutor, "block[0] must be the conversational tutor prompt verbatim");
    assert.equal(blocks[1], drillSergeant, "block[1] must be the drill_sergeant overlay verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11.3 (d) chat-path prompts still ship and differ from the conversational variants", () => {
  const chat = loadPromptDir(promptsDir);
  const conversational = loadConversationalPrompts(promptsDir);
  for (const mode of REQUIRED_MODES) {
    assert.ok(chat.has(mode), `chat-path ${mode}.md must still ship`);
    assert.ok(conversational.has(mode));
    assert.notEqual(
      chat.get(mode),
      conversational.get(mode),
      `chat-path ${mode}.md and conversational/${mode}.md must not be identical`
    );
    // The chat-path prompt declares JSON output; the conversational
    // one declares plain text. Sanity check both.
    assert.match(chat.get(mode), /JSON object/, `chat-path ${mode} must declare JSON`);
    assert.match(conversational.get(mode), /plain text/i, `conversational ${mode} must declare plain text`);
  }
});

test("11.3 (e) personality 'nice' omits the overlay — same Session contract as the chat path", async () => {
  const tutor = readFileSync(join(conversationalDir, "tutor.md"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "buddy-11.3e-"));
  try {
    const fake = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "ack", wants_followup: false }],
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, new Map([["tutor", tutor]]), {
      memory,
      personalities: new Map([["nice", "would be the nice overlay"]]),
      defaultPersonality: "nice",
    });

    await session.handleTrigger("EXPLICIT_ASK", { user_question: "?" });

    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 1, "nice → no overlay block");
    assert.equal(blocks[0], tutor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11.3 (f) loadConversationalPrompts on a missing dir returns an empty map (fresh-checkout tolerance)", () => {
  const map = loadConversationalPrompts("/path/that/definitely/does/not/exist");
  assert.equal(map.size, 0);
});
