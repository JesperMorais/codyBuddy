// Task 3.3: persist mute state to MemoryStore so a daemon restart inside
// the 30-min mute window stays muted.
//
// The contract from the README "Hotkeys" row + RESEARCH.md §3.1:
// - mute(30) should survive a Session reinstantiation against the same
//   MemoryStore directory.
// - unmute() must clear it.
// - A stale on-disk timestamp that has already elapsed is ignored on
//   restore (we don't want to revive yesterday's mute).
//
// Run: node --test daemon/test/mute-persistence.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-mute-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("3.3 (a) mute(30) survives Session reinstantiation against the same MemoryStore", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const fake1 = new FakeAnthropicClient();
    const memory1 = new MemoryStore(dir);
    const session1 = new Session(fake1, prompts, { memory: memory1 });
    session1.mute(30);
    assert.equal(session1.isMuted(), true);

    // mute.json was written
    const mutePath = memory1.paths().mute;
    assert.ok(existsSync(mutePath), "mute.json must exist");
    const persisted = JSON.parse(readFileSync(mutePath, "utf8"));
    assert.ok(persisted.mutedUntil > Date.now(), "mutedUntil must be in the future");

    // New Session against the same dir → should pick up the persisted mute
    const fake2 = new FakeAnthropicClient();
    const memory2 = new MemoryStore(dir);
    const session2 = new Session(fake2, prompts, { memory: memory2 });
    assert.equal(session2.isMuted(), true);

    const reply = await session2.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });
    assert.equal(reply.mode, "no_op");
    assert.equal(fake2.calls.ask.length, 0);
  } finally {
    cleanup();
  }
});

test("3.3 (b) unmute() clears the persisted mute state", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const fake1 = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "ok", wants_followup: false }],
    });
    const memory1 = new MemoryStore(dir);
    const session1 = new Session(fake1, prompts, { memory: memory1 });
    session1.mute(30);
    session1.unmute();
    assert.equal(session1.isMuted(), false);

    const memory2 = new MemoryStore(dir);
    assert.equal(memory2.getMutedUntil(), 0);

    const fake2 = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "post-unmute", wants_followup: false }],
    });
    const session2 = new Session(fake2, prompts, { memory: memory2 });
    assert.equal(session2.isMuted(), false);

    const reply = await session2.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });
    assert.equal(reply.mode, "chat");
    assert.equal(reply.text, "post-unmute");
  } finally {
    cleanup();
  }
});

test("3.3 (c) stale persisted mute (already expired) is ignored on restore", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    // Hand-write a stale mute file (1 hour in the past)
    const mutePath = join(dir, "mute.json");
    writeFileSync(
      mutePath,
      JSON.stringify({ mutedUntil: Date.now() - 60 * 60_000 }),
      "utf8"
    );

    const fake = new FakeAnthropicClient();
    const memory = new MemoryStore(dir);
    assert.equal(memory.getMutedUntil(), 0, "stale ts must read as 0");

    const session = new Session(fake, prompts, { memory });
    assert.equal(session.isMuted(), false);
  } finally {
    cleanup();
  }
});

test("3.3 (d) corrupt mute.json is treated as no mute", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    writeFileSync(join(dir, "mute.json"), "not valid json {{{", "utf8");
    const memory = new MemoryStore(dir);
    assert.equal(memory.getMutedUntil(), 0);
  } finally {
    cleanup();
  }
});

test("3.3 (e) MemoryStore.paths() now includes the mute path", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    const paths = memory.paths();
    assert.equal(paths.mute, join(dir, "mute.json"));
  } finally {
    cleanup();
  }
});
