// Task 9.2: Session accepts a personalities Map<string,string> and exposes
// listPersonalities(). The actual loader lives in daemon/src/index.ts (a
// thin readdirSync helper); we exercise the *contract* it has to satisfy
// by loading the real on-disk personality files via that same helper
// pattern and threading the result through Session.
//
// Run: node --test daemon/test/personality-loader.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const personalitiesDir = resolve(__dirname, "..", "prompts", "personalities");

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

// Mirror the helper that index.ts uses so the test fails if that helper
// ever silently changes shape (e.g. starts including non-md files).
function loadPromptDir(dir) {
  const map = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    map.set(basename(f, ".md"), readFileSync(join(dir, f), "utf8"));
  }
  return map;
}

function freshSession(opts) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-9.2-"));
  const memory = new MemoryStore(dir);
  const session = new Session(new FakeAnthropicClient(), prompts, {
    memory,
    ...opts,
  });
  return { session, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------

test("9.2 (a) loadPromptDir reads every .md file under daemon/prompts/personalities", () => {
  const map = loadPromptDir(personalitiesDir);
  for (const expected of [
    "nice",
    "dry",
    "rude",
    "drill_sergeant",
    "passive_aggressive",
    "pirate",
    "shakespearean",
  ]) {
    assert.ok(map.has(expected), `personalities map missing "${expected}"`);
    assert.ok(map.get(expected).length > 100, `personalities/${expected}.md is unexpectedly short`);
  }
});

test("9.2 (b) loadPromptDir skips non-.md entries (e.g. nested directories)", () => {
  const dir = mkdtempSync(join(tmpdir(), "buddy-9.2-mixed-"));
  try {
    writeFileSync(join(dir, "a.md"), "alpha", "utf8");
    writeFileSync(join(dir, "b.md"), "beta", "utf8");
    writeFileSync(join(dir, "README.txt"), "not a prompt", "utf8");
    // a sibling directory, like prompts/personalities/ inside prompts/
    rmSync(join(dir, ".gitkeep"), { force: true });
    const map = loadPromptDir(dir);
    assert.deepEqual([...map.keys()].sort(), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9.2 (c) Session stores the personalities map and exposes listPersonalities()", () => {
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
  ]);
  const { session, cleanup } = freshSession({ personalities });
  try {
    assert.deepEqual(session.listPersonalities().sort(), ["dry", "nice"]);
  } finally {
    cleanup();
  }
});

test("9.2 (d) Session without a personalities option still works (back-compat)", () => {
  const { session, cleanup } = freshSession({});
  try {
    assert.deepEqual(session.listPersonalities(), []);
  } finally {
    cleanup();
  }
});

test("9.2 (e) loading the real personalities dir end-to-end yields the seven shipped names", () => {
  const personalities = loadPromptDir(personalitiesDir);
  const { session, cleanup } = freshSession({ personalities });
  try {
    const names = session.listPersonalities().sort();
    assert.deepEqual(names, [
      "drill_sergeant",
      "dry",
      "nice",
      "passive_aggressive",
      "pirate",
      "rude",
      "shakespearean",
    ]);
  } finally {
    cleanup();
  }
});
