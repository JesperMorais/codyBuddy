// Task 9.6: random-personality opt-in. With shuffle enabled the
// active personality rotates per handleTrigger, never repeating the
// previous one. Default is off — existing behaviour is unchanged.
//
// Contract:
// - opts.defaultShuffle (or persisted via MemoryStore.setShuffle)
//   enables the rotation. opts.rng injects a deterministic generator
//   so this test is reproducible.
// - With shuffle on, two consecutive triggers receive different
//   personalities (when ≥2 are loaded).
// - With shuffle off, personality is sticky across triggers.
// - With only one personality loaded, shuffle is a no-op (nothing
//   to rotate to — assertion verifies no crash).
// - setShuffle persists across Session reinstantiation.
//
// Run: node --test daemon/test/personality-shuffle.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);
const personalities = new Map([
  ["nice", "nice overlay"],
  ["dry", "dry overlay"],
  ["pirate", "pirate overlay"],
  ["rude", "rude overlay"],
]);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-shuffle-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Linear-congruential generator → deterministic floats in [0,1). */
function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function buildSession({ dir, defaultShuffle = false, defaultPersonality = "nice", rng } = {}) {
  const fake = new FakeAnthropicClient({
    replies: Array.from({ length: 10 }, () => ({
      mode: "chat",
      text: "ok",
      wants_followup: false,
    })),
  });
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, {
    memory,
    personalities,
    defaultPersonality,
    defaultShuffle,
    rng,
  });
  return { fake, session, memory };
}

test("9.6 (a) two consecutive triggers receive different personalities under shuffle", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { session, fake } = buildSession({
      dir,
      defaultShuffle: true,
      rng: seededRng(42),
    });
    assert.equal(session.isShuffle(), true);

    await session.handleTrigger("EXPLICIT_ASK", { active_file: "a.ts" });
    const first = session.getPersonality();

    await session.handleTrigger("EXPLICIT_ASK", { active_file: "b.ts" });
    const second = session.getPersonality();

    assert.notEqual(first, second, "consecutive shuffle picks must differ");
    // The system blocks the client saw should reflect the rotation —
    // each ask call carries that turn's overlay (block index 1) when
    // it's not "nice".
    assert.equal(fake.calls.ask.length, 2);
  } finally {
    cleanup();
  }
});

test("9.6 (b) shuffle excludes the previous personality on every pick", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { session } = buildSession({
      dir,
      defaultShuffle: true,
      rng: seededRng(7),
    });
    let prev = session.getPersonality();
    for (let i = 0; i < 8; i++) {
      await session.handleTrigger("EXPLICIT_ASK", { active_file: `f${i}.ts` });
      const next = session.getPersonality();
      assert.notEqual(next, prev, `iteration ${i}: ${next} must differ from previous ${prev}`);
      assert.ok(personalities.has(next), `${next} must be a loaded personality`);
      prev = next;
    }
  } finally {
    cleanup();
  }
});

test("9.6 (c) shuffle off (default) keeps personality sticky across triggers", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { session } = buildSession({
      dir,
      defaultPersonality: "dry",
      // defaultShuffle omitted → false
    });
    assert.equal(session.isShuffle(), false);
    await session.handleTrigger("EXPLICIT_ASK", { active_file: "a.ts" });
    await session.handleTrigger("EXPLICIT_ASK", { active_file: "b.ts" });
    await session.handleTrigger("EXPLICIT_ASK", { active_file: "c.ts" });
    assert.equal(session.getPersonality(), "dry");
  } finally {
    cleanup();
  }
});

test("9.6 (d) shuffle is a no-op when only one personality is loaded", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const fake = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "ok", wants_followup: false }],
    });
    const memory = new MemoryStore(dir);
    const single = new Map([["nice", "nice overlay"]]);
    const session = new Session(fake, prompts, {
      memory,
      personalities: single,
      defaultShuffle: true,
      rng: seededRng(1),
    });
    await session.handleTrigger("EXPLICIT_ASK", { active_file: "a.ts" });
    assert.equal(session.getPersonality(), "nice");
    assert.equal(fake.calls.ask.length, 1);
  } finally {
    cleanup();
  }
});

test("9.6 (e) setShuffle persists across Session reinstantiation", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory1 = new MemoryStore(dir);
    const session1 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory1,
      personalities,
    });
    assert.equal(session1.isShuffle(), false);
    session1.setShuffle(true);
    assert.equal(session1.isShuffle(), true);

    const path = memory1.paths().shuffle;
    assert.ok(existsSync(path), "shuffle.json must be written");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { shuffle: true });

    const memory2 = new MemoryStore(dir);
    const session2 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory2,
      personalities,
    });
    assert.equal(session2.isShuffle(), true);
  } finally {
    cleanup();
  }
});

test("9.6 (f) BUDDY_PERSONALITY=random style: defaultShuffle seeds a fresh session as on", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { session } = buildSession({
      dir,
      defaultShuffle: true,
      defaultPersonality: "nice",
    });
    assert.equal(session.isShuffle(), true);
    assert.equal(session.getPersonality(), "nice");
  } finally {
    cleanup();
  }
});

test("9.6 (g) persisted shuffle=false beats defaultShuffle=true on restore", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory1 = new MemoryStore(dir);
    memory1.setShuffle(false);

    const memory2 = new MemoryStore(dir);
    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory2,
      personalities,
      defaultShuffle: true,
    });
    assert.equal(session.isShuffle(), false);
  } finally {
    cleanup();
  }
});

test("9.6 (h) shuffle picks include 'nice' (overlay omission still valid mid-rotation)", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    // Seed with a non-nice personality so 'nice' is one of the candidates.
    const { session } = buildSession({
      dir,
      defaultShuffle: true,
      defaultPersonality: "dry",
      rng: seededRng(99),
    });
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      await session.handleTrigger("EXPLICIT_ASK", { active_file: `f${i}.ts` });
      seen.add(session.getPersonality());
    }
    // Across 30 picks of 4 candidates, every loaded personality should
    // surface at least once with this seed — verifies "nice" isn't
    // accidentally filtered out of the rotation.
    for (const name of personalities.keys()) {
      assert.ok(seen.has(name), `${name} should appear at least once across 30 shuffles`);
    }
  } finally {
    cleanup();
  }
});
