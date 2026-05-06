// Task 9.5: persist personality to MemoryStore so a daemon restart
// restores the user's last choice. Mirrors the mute-persistence
// contract from Task 3.3.
//
// Behaviour the daemon promises:
// - setPersonality(name) writes to disk and survives reinstantiation
//   of Session against the same MemoryStore.
// - "nice" is also persistable (it's a valid first-class choice, not
//   a sentinel for "no preference").
// - When nothing is persisted, the constructor falls back to
//   defaultPersonality (typically BUDDY_PERSONALITY env), then "nice".
// - A persisted name that is no longer loaded (e.g. the .md file was
//   deleted between runs) is ignored on restore — the daemon falls
//   back to the default rather than crashing or holding a dangling
//   reference.
// - A corrupt personality.json is treated as "no preference".
//
// Run: node --test daemon/test/personality-persistence.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
]);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-personality-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("9.5 (a) setPersonality survives Session reinstantiation against the same MemoryStore", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory1 = new MemoryStore(dir);
    const session1 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory1,
      personalities,
    });
    assert.equal(session1.getPersonality(), "nice");
    assert.equal(session1.setPersonality("dry"), true);
    assert.equal(session1.getPersonality(), "dry");

    // personality.json was written
    const path = memory1.paths().personality;
    assert.ok(existsSync(path), "personality.json must exist");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { personality: "dry" });

    // New Session against the same dir → restores "dry"
    const memory2 = new MemoryStore(dir);
    const session2 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory2,
      personalities,
    });
    assert.equal(session2.getPersonality(), "dry");
  } finally {
    cleanup();
  }
});

test("9.5 (b) persisted value beats defaultPersonality on restore", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory1 = new MemoryStore(dir);
    const session1 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory1,
      personalities,
      defaultPersonality: "pirate",
    });
    session1.setPersonality("dry");

    // Restart with a *different* defaultPersonality — disk wins.
    const memory2 = new MemoryStore(dir);
    const session2 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory2,
      personalities,
      defaultPersonality: "pirate",
    });
    assert.equal(session2.getPersonality(), "dry");
  } finally {
    cleanup();
  }
});

test("9.5 (c) defaultPersonality is used when nothing has been persisted yet", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory,
      personalities,
      defaultPersonality: "pirate",
    });
    assert.equal(session.getPersonality(), "pirate");
    assert.equal(memory.getPersonality(), null, "no write happens until setPersonality is called");
  } finally {
    cleanup();
  }
});

test("9.5 (d) setPersonality('nice') is persisted explicitly (not treated as 'clear')", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory1 = new MemoryStore(dir);
    const session1 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory1,
      personalities,
      defaultPersonality: "pirate",
    });
    assert.equal(session1.setPersonality("nice"), true);

    // Restart with the same env default of "pirate" — persisted "nice" must win.
    const memory2 = new MemoryStore(dir);
    const session2 = new Session(new FakeAnthropicClient(), prompts, {
      memory: memory2,
      personalities,
      defaultPersonality: "pirate",
    });
    assert.equal(session2.getPersonality(), "nice");
  } finally {
    cleanup();
  }
});

test("9.5 (e) persisted name that is no longer loaded is ignored on restore", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    // Hand-write a personality file referring to a name that the next
    // run will not have loaded (e.g. the .md file was deleted).
    writeFileSync(join(dir, "personality.json"), JSON.stringify({ personality: "ghost" }), "utf8");

    const memory = new MemoryStore(dir);
    assert.equal(memory.getPersonality(), "ghost", "raw read returns whatever's on disk");

    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory,
      personalities,
      defaultPersonality: "dry",
    });
    // "ghost" isn't in the loaded map — fall back to defaultPersonality.
    assert.equal(session.getPersonality(), "dry");
  } finally {
    cleanup();
  }
});

test("9.5 (f) corrupt personality.json is treated as no preference", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    writeFileSync(join(dir, "personality.json"), "not json {{{", "utf8");
    const memory = new MemoryStore(dir);
    assert.equal(memory.getPersonality(), null);

    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory,
      personalities,
      defaultPersonality: "pirate",
    });
    assert.equal(session.getPersonality(), "pirate");
  } finally {
    cleanup();
  }
});

test("9.5 (g) MemoryStore.paths() exposes the personality path", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    assert.equal(memory.paths().personality, join(dir, "personality.json"));
  } finally {
    cleanup();
  }
});

test("9.5 (h) setPersonality with unknown name does not write to disk", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const memory = new MemoryStore(dir);
    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory,
      personalities,
    });
    assert.equal(session.setPersonality("does_not_exist"), false);
    assert.equal(existsSync(memory.paths().personality), false);
    assert.equal(session.getPersonality(), "nice");
  } finally {
    cleanup();
  }
});
