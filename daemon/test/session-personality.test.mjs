// Task 9.3: Session.personality + buildSystemBlocks contract.
//
// Run: node --test daemon/test/session-personality.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "MODE PROMPT"]]);

function freshSession(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-9.3-"));
  const fake = opts.fake ?? new FakeAnthropicClient({
    replies: [{ mode: "chat", text: "ok", wants_followup: false }],
  });
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, {
    memory,
    personalities: opts.personalities ?? new Map([
      ["nice", "NICE OVERLAY"],
      ["dry", "DRY OVERLAY"],
      ["pirate", "PIRATE OVERLAY"],
    ]),
    defaultPersonality: opts.defaultPersonality,
  });
  return { fake, session, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------
// Default + getter/setter
// --------------------------------------------------------------------------

test("9.3 (a) default personality is 'nice'", () => {
  const { session, cleanup } = freshSession();
  try {
    assert.equal(session.getPersonality(), "nice");
  } finally {
    cleanup();
  }
});

test("9.3 (b) defaultPersonality option is honoured", () => {
  const { session, cleanup } = freshSession({ defaultPersonality: "dry" });
  try {
    assert.equal(session.getPersonality(), "dry");
  } finally {
    cleanup();
  }
});

test("9.3 (c) setPersonality accepts loaded names and 'nice'", () => {
  const { session, cleanup } = freshSession();
  try {
    assert.equal(session.setPersonality("dry"), true);
    assert.equal(session.getPersonality(), "dry");
    assert.equal(session.setPersonality("pirate"), true);
    assert.equal(session.getPersonality(), "pirate");
    assert.equal(session.setPersonality("nice"), true);
    assert.equal(session.getPersonality(), "nice");
  } finally {
    cleanup();
  }
});

test("9.3 (d) setPersonality returns false on unknown names; state unchanged", () => {
  const { session, cleanup } = freshSession({ defaultPersonality: "dry" });
  try {
    assert.equal(session.setPersonality("does-not-exist"), false);
    assert.equal(session.getPersonality(), "dry");
  } finally {
    cleanup();
  }
});

test("9.3 (e) listPersonalities still returns the loaded names", () => {
  const { session, cleanup } = freshSession();
  try {
    assert.deepEqual(session.listPersonalities().sort(), ["dry", "nice", "pirate"]);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// systemBlocks composition (the meat of 9.3)
// --------------------------------------------------------------------------

test("9.3 (f) personality='nice' (default) sends ONE block: just the mode prompt", async () => {
  const { fake, session, cleanup } = freshSession();
  try {
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q" });
    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0], "MODE PROMPT");
  } finally {
    cleanup();
  }
});

test("9.3 (g) non-nice personality sends TWO blocks: mode prompt + overlay", async () => {
  const { fake, session, cleanup } = freshSession({ defaultPersonality: "dry" });
  try {
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q" });
    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0], "MODE PROMPT");
    assert.equal(blocks[1], "DRY OVERLAY");
  } finally {
    cleanup();
  }
});

test("9.3 (h) switching personality mid-session swaps the overlay on the next ask", async () => {
  const fake = new FakeAnthropicClient({
    replies: [
      { mode: "chat", text: "first", wants_followup: false },
      { mode: "chat", text: "second", wants_followup: false },
    ],
  });
  const { session, cleanup } = freshSession({ fake });
  try {
    session.setPersonality("dry");
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q1" });
    session.setPersonality("pirate");
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q2" });
    assert.deepEqual(fake.calls.ask[0].systemBlocks, ["MODE PROMPT", "DRY OVERLAY"]);
    assert.deepEqual(fake.calls.ask[1].systemBlocks, ["MODE PROMPT", "PIRATE OVERLAY"]);
  } finally {
    cleanup();
  }
});

test("9.3 (i) learner profile, when present, becomes the trailing block", async () => {
  const { fake, session, cleanup } = freshSession({ defaultPersonality: "dry" });
  try {
    // Seed the memory with a learner profile, then trigger.
    session.getMemory().setSummary("Recurring: forgets await.");
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q" });
    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0], "MODE PROMPT");
    assert.equal(blocks[1], "DRY OVERLAY");
    assert.match(blocks[2], /^What I've noticed about this developer over time:/);
    assert.match(blocks[2], /Recurring: forgets await\./);
  } finally {
    cleanup();
  }
});

test("9.3 (j) personality='nice' but a personality overlay registered as 'nice' is NOT included", async () => {
  // The "nice" baseline omits the overlay even if a "nice" entry exists
  // in the map — that's the contract for the neutral default.
  const { fake, session, cleanup } = freshSession();
  try {
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q" });
    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks.includes("NICE OVERLAY"), false);
  } finally {
    cleanup();
  }
});
