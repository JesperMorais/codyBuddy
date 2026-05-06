// Task 5.2: pattern -> {count, last_seen, sample} map for misconceptions.
//
// Coverage:
//   - MemoryStore.recordMisconception: increments count, refreshes
//     last_seen, preserves the first sample, persists to disk.
//   - getMisconceptions: round-trips on a fresh MemoryStore against the
//     same dir.
//   - Corrupt file is treated as empty.
//   - Session.handleTrigger records on MISCONCEPTION (extracts the
//     pattern name from `reason: "anti-pattern: NAME"`).
//   - distillLearnerProfile receives the counts directly (asserted via
//     the FakeAnthropicClient).
//
// Behavioural test (3 hits across 3 handleTrigger calls produces a
// "Recurring misconceptions" entry with count >= 3 in the next distill)
// is Task 5.3.
//
// Run: node --test daemon/test/misconception-counts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-misc-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------
// MemoryStore.recordMisconception
// --------------------------------------------------------------------------

test("5.2 (a) recordMisconception(name) starts count at 1, sets last_seen + sample", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    const before = Date.now();
    const rec = memory.recordMisconception("ts-as-any", "{ \"line\": 12 }");
    const after = Date.now();
    assert.equal(rec.count, 1);
    assert.equal(rec.sample, "{ \"line\": 12 }");
    assert.ok(rec.last_seen >= before && rec.last_seen <= after);

    const map = memory.getMisconceptions();
    assert.equal(map["ts-as-any"].count, 1);
  } finally {
    cleanup();
  }
});

test("5.2 (b) repeated record calls increment count and refresh last_seen", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    memory.recordMisconception("py-bare-except", "first sample");
    const second = memory.recordMisconception("py-bare-except", "second sample (ignored)");
    const third = memory.recordMisconception("py-bare-except");
    assert.equal(third.count, 3);
    assert.equal(third.sample, "first sample", "earliest sample preserved");
    assert.ok(second.last_seen <= third.last_seen);
  } finally {
    cleanup();
  }
});

test("5.2 (c) misconceptions persist across MemoryStore reinstantiation", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const m1 = new MemoryStore(dir);
    m1.recordMisconception("ts-as-any");
    m1.recordMisconception("ts-as-any");
    m1.recordMisconception("py-bare-except");

    const m2 = new MemoryStore(dir);
    const map = m2.getMisconceptions();
    assert.equal(map["ts-as-any"].count, 2);
    assert.equal(map["py-bare-except"].count, 1);
  } finally {
    cleanup();
  }
});

test("5.2 (d) corrupt misconceptions.json reads as empty", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    writeFileSync(join(dir, "misconceptions.json"), "not json {{{", "utf8");
    const memory = new MemoryStore(dir);
    assert.deepEqual(memory.getMisconceptions(), {});
  } finally {
    cleanup();
  }
});

test("5.2 (e) paths() exposes the misconceptions file", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    assert.equal(memory.paths().misconceptions, join(dir, "misconceptions.json"));
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Session.handleTrigger records on MISCONCEPTION
// --------------------------------------------------------------------------

test("5.2 (f) MISCONCEPTION trigger records the pattern via memory", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const fake = new FakeAnthropicClient({
      decisions: ["chat"],
      replies: [{ mode: "chat", text: "noticed something", wants_followup: false }],
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, prompts, { memory });

    await session.handleTrigger("MISCONCEPTION", {
      active_file: "x.ts",
      reason: "anti-pattern: ts-as-any",
    });

    const map = memory.getMisconceptions();
    assert.equal(map["ts-as-any"].count, 1);
    assert.ok(map["ts-as-any"].sample);
  } finally {
    cleanup();
  }
});

test("5.2 (g) non-MISCONCEPTION triggers do not record misconceptions", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const fake = new FakeAnthropicClient({
      decisions: ["chat"],
      replies: [{ mode: "chat", text: "ok", wants_followup: false }],
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, prompts, { memory });

    await session.handleTrigger("STUCK_LOOP", {
      active_file: "x.ts",
      reason: "stuck on 3 errors for 120s",
    });

    assert.deepEqual(memory.getMisconceptions(), {});
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// distillLearnerProfile receives the counts
// --------------------------------------------------------------------------

test("5.2 (h) Session.forceDistillProfile passes the misconception map to the client", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const fake = new FakeAnthropicClient({ profile: "(distilled)" });
    const memory = new MemoryStore(dir);
    memory.recordMisconception("ts-as-any");
    memory.recordMisconception("ts-as-any");
    memory.recordMisconception("py-mutable-default-arg");

    const session = new Session(fake, prompts, { memory });
    await session.forceDistillProfile();

    assert.equal(fake.calls.distillLearnerProfile.length, 1);
    const call = fake.calls.distillLearnerProfile[0];
    assert.equal(call.misconceptions["ts-as-any"].count, 2);
    assert.equal(call.misconceptions["py-mutable-default-arg"].count, 1);
  } finally {
    cleanup();
  }
});
