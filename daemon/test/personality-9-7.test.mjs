// Task 9.7: rigour pass on the personality machinery. The four
// bullets below come straight from the TASKS.md item — each one
// closes a gap that the looser 9.3 / 9.6 tests don't quite cover:
//
//   1. Snapshot: setMode("tutor") + setPersonality("rude") produces
//      the expected ordered system blocks sent to the fake client.
//      Repeat for `nice` (overlay omitted) and one more combo.
//   2. setPersonality("does_not_exist") returns false, leaves state
//      unchanged, no throw.
//   3. Switching personality mid-session does not corrupt recent_chat
//      or memory.
//   4. Random mode produces a different personality across N=10
//      triggers (seeded RNG).
//
// These exercise the *real* on-disk prompt content rather than
// synthetic placeholders so a future tweak to the shipped overlays
// surfaces here as a snapshot diff.
//
// Run: node --test daemon/test/personality-9-7.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "..", "prompts");
const personalitiesDir = join(promptsDir, "personalities");

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

// Mirror the helper that index.ts uses to load .md files into a Map.
function loadPromptDir(dir) {
  const map = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    map.set(basename(f, ".md"), readFileSync(join(dir, f), "utf8"));
  }
  return map;
}

const realPrompts = loadPromptDir(promptsDir);
const realPersonalities = loadPromptDir(personalitiesDir);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-9.7-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildSession({ dir, defaultPersonality, defaultMode, defaultShuffle, rng } = {}) {
  const fake = new FakeAnthropicClient({
    replies: Array.from({ length: 20 }, (_, i) => ({
      mode: "chat",
      text: `reply ${i}`,
      wants_followup: false,
    })),
  });
  const memory = new MemoryStore(dir);
  const session = new Session(fake, realPrompts, {
    memory,
    personalities: realPersonalities,
    defaultPersonality,
    defaultMode,
    defaultShuffle,
    rng,
  });
  return { fake, session, memory };
}

// LCG → reproducible floats in [0,1).
function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// --------------------------------------------------------------------------
// Bullet 1: snapshot tests against the real shipped prompts.
// --------------------------------------------------------------------------

test("9.7 (1a) snapshot: setMode('tutor') + setPersonality('rude') → [tutor.md, rude.md]", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { fake, session } = buildSession({ dir });
    assert.equal(session.setMode("tutor"), true);
    assert.equal(session.setPersonality("rude"), true);
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "why?" });

    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 2, "tutor + rude → 2 blocks");
    assert.equal(blocks[0], realPrompts.get("tutor"));
    assert.equal(blocks[1], realPersonalities.get("rude"));
  } finally {
    cleanup();
  }
});

test("9.7 (1b) snapshot: personality='nice' omits the overlay (mode block only)", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { fake, session } = buildSession({ dir, defaultPersonality: "nice" });
    assert.equal(session.setMode("tutor"), true);
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "why?" });

    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 1, "nice → no overlay block");
    assert.equal(blocks[0], realPrompts.get("tutor"));
    // The shipped nice.md exists but is NOT in the assembled blocks
    // (the contract says nice is the no-overlay baseline).
    assert.equal(blocks.includes(realPersonalities.get("nice")), false);
  } finally {
    cleanup();
  }
});

test("9.7 (1c) snapshot: setMode('reviewer') + setPersonality('drill_sergeant') → [reviewer.md, drill_sergeant.md]", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { fake, session } = buildSession({ dir });
    assert.equal(session.setMode("reviewer"), true);
    assert.equal(session.setPersonality("drill_sergeant"), true);
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "is this safe?" });

    const blocks = fake.calls.ask[0].systemBlocks;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0], realPrompts.get("reviewer"));
    assert.equal(blocks[1], realPersonalities.get("drill_sergeant"));
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Bullet 2: setPersonality("does_not_exist") returns false, no throw, state intact.
// --------------------------------------------------------------------------

test("9.7 (2) setPersonality('does_not_exist') returns false, leaves state unchanged, no throw", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { session, memory } = buildSession({ dir, defaultPersonality: "dry" });
    const before = session.getPersonality();
    let result;
    assert.doesNotThrow(() => {
      result = session.setPersonality("does_not_exist");
    });
    assert.equal(result, false);
    assert.equal(session.getPersonality(), before, "personality must be unchanged");
    // And nothing was written to disk for the rejected name.
    assert.equal(memory.getPersonality(), null, "no persisted write on rejection");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Bullet 3: switching personality mid-session preserves recent_chat + memory.
// --------------------------------------------------------------------------

test("9.7 (3) switching personality mid-session does not corrupt recent_chat or memory", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { fake, session, memory } = buildSession({ dir });
    assert.equal(session.setMode("tutor"), true);

    session.setPersonality("dry");
    await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "first question",
      active_file: "a.ts",
    });

    session.setPersonality("pirate");
    await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "second question",
      active_file: "b.ts",
    });

    session.setPersonality("rude");
    await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "third question",
      active_file: "c.ts",
    });

    // recent_chat is built from Session.events on each call. The
    // third call's enriched payload should reference the prior two
    // questions in order — never a personality leak.
    assert.equal(fake.calls.ask.length, 3);
    const thirdRecent = fake.calls.ask[2].triggerPayload.recent_chat;
    assert.equal(thirdRecent.length, 2, "third call sees the two prior turns");
    assert.equal(thirdRecent[0].user_question, "first question");
    assert.equal(thirdRecent[1].user_question, "second question");
    // recent_chat carries reply text, not personality state — the swap
    // mustn't have leaked overlay strings into the conversation log.
    for (const e of thirdRecent) {
      assert.equal(typeof e.reply_text, "string");
      assert.ok(
        !e.reply_text.includes("OVERLAY") &&
          !e.reply_text.includes(realPersonalities.get("dry")) &&
          !e.reply_text.includes(realPersonalities.get("pirate")),
        "reply_text must not contain personality overlay text"
      );
    }

    // Persistent memory log: every reply should be appended in order
    // with its mode/file, untouched by the personality changes.
    const events = memory.loadRecent(10);
    assert.equal(events.length, 3);
    assert.equal(events[0].user_question, "first question");
    assert.equal(events[0].file, "a.ts");
    assert.equal(events[0].mode, "tutor");
    assert.equal(events[1].user_question, "second question");
    assert.equal(events[1].file, "b.ts");
    assert.equal(events[2].user_question, "third question");
    assert.equal(events[2].file, "c.ts");

    // The persisted personality (last setPersonality call wins) must
    // match what the session reports — no drift between the two.
    assert.equal(memory.getPersonality(), "rude");
    assert.equal(session.getPersonality(), "rude");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Bullet 4: random mode → N=10 triggers all rotate (seeded RNG).
// --------------------------------------------------------------------------

test("9.7 (4) random mode produces a different personality across N=10 triggers", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { session } = buildSession({
      dir,
      defaultShuffle: true,
      rng: seededRng(1234),
    });
    assert.equal(session.isShuffle(), true);

    let prev = session.getPersonality();
    const seen = [prev];
    for (let i = 0; i < 10; i++) {
      await session.handleTrigger("EXPLICIT_ASK", {
        user_question: `q${i}`,
        active_file: `f${i}.ts`,
      });
      const next = session.getPersonality();
      assert.notEqual(next, prev, `trigger ${i + 1}: ${next} must differ from previous ${prev}`);
      assert.ok(realPersonalities.has(next), `${next} must be a real shipped personality`);
      seen.push(next);
      prev = next;
    }
    assert.equal(seen.length, 11, "11 personalities recorded (initial + 10 rotations)");
  } finally {
    cleanup();
  }
});
