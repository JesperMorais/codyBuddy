// Task 6.1: integration assertion that Session.setMode swaps the system
// prompt to the matching file under daemon/prompts/<mode>.md, and that
// the next handleTrigger sends that prompt to the AI client unchanged.
//
// Covers all four shipped modes: tutor, architect, explainer, reviewer.
//
// Run: node --test daemon/test/mode-switch.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

function loadAllPrompts() {
  const map = new Map();
  for (const f of readdirSync(promptsDir)) {
    if (!f.endsWith(".md")) continue;
    const name = basename(f, ".md");
    map.set(name, readFileSync(join(promptsDir, f), "utf8"));
  }
  return map;
}

function freshSession(fake, prompts) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-6.1-"));
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, { memory });
  return { session, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const prompts = loadAllPrompts();
const MODES = ["tutor", "architect", "explainer", "reviewer"];

test("6.1 (a) all four shipped modes are loaded from daemon/prompts/", () => {
  for (const mode of MODES) {
    assert.ok(prompts.has(mode), `prompts/${mode}.md must exist`);
    assert.ok(prompts.get(mode).length > 100, `${mode}.md is suspiciously short`);
  }
});

for (const mode of MODES) {
  test(`6.1 (b) setMode("${mode}") sends ${mode}.md as the system prompt to ask`, async () => {
    const fake = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "ok", wants_followup: false }],
    });
    const { session, cleanup } = freshSession(fake, prompts);
    try {
      assert.equal(session.setMode(mode), true);
      assert.equal(session.getMode(), mode);

      // EXPLICIT_ASK bypasses the Haiku gate so we go straight to ask().
      await session.handleTrigger("EXPLICIT_ASK", {
        user_question: `test ${mode}`,
      });

      assert.equal(fake.calls.ask.length, 1);
      assert.equal(
        fake.calls.ask[0].systemPrompt,
        prompts.get(mode),
        `system prompt sent to ask must match prompts/${mode}.md byte-for-byte`
      );
    } finally {
      cleanup();
    }
  });
}

test("6.1 (c) setMode rejects unknown modes and leaves state unchanged", () => {
  const fake = new FakeAnthropicClient();
  const { session, cleanup } = freshSession(fake, prompts);
  try {
    const before = session.getMode();
    assert.equal(session.setMode("does-not-exist"), false);
    assert.equal(session.getMode(), before);
  } finally {
    cleanup();
  }
});

test("6.1 (d) listModes returns the loaded mode names", () => {
  const fake = new FakeAnthropicClient();
  const { session, cleanup } = freshSession(fake, prompts);
  try {
    const list = session.listModes().sort();
    assert.deepEqual(list, [...MODES].sort());
  } finally {
    cleanup();
  }
});

test("6.1 (e) switching modes mid-session swaps the prompt for the next ask", async () => {
  const fake = new FakeAnthropicClient({
    replies: [
      { mode: "chat", text: "first", wants_followup: false },
      { mode: "chat", text: "second", wants_followup: false },
    ],
  });
  const { session, cleanup } = freshSession(fake, prompts);
  try {
    session.setMode("tutor");
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q1" });

    session.setMode("architect");
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q2" });

    assert.equal(fake.calls.ask[0].systemPrompt, prompts.get("tutor"));
    assert.equal(fake.calls.ask[1].systemPrompt, prompts.get("architect"));
    assert.notEqual(fake.calls.ask[0].systemPrompt, fake.calls.ask[1].systemPrompt);
  } finally {
    cleanup();
  }
});
