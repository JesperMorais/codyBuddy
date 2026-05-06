// Task 9.9: provider-gated personality loading. The `nsfw` personality
// lives in daemon/prompts/personalities-ollama/ and may only load
// when BUDDY_PROVIDER=ollama; on any other provider it lands in the
// `gated` map with a reason so the daemon can surface a clear error
// when the user asks for it.
//
// This file exercises the *loader* directly (no WS, no Session), then
// threads its output through Session to verify the end-to-end contract:
//   - provider=anthropic: nsfw not in listPersonalities; setPersonality returns false
//   - provider=ollama:    nsfw in listPersonalities;     setPersonality returns true
//
// Run: node --test daemon/test/personalities-loader.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "..", "prompts");

const { loadPersonalities, loadPromptDir } = await import("../dist/personalities-loader.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-9.9-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const prompts = new Map([["tutor", "MODE PROMPT"]]);

test("9.9 (a) the on-disk personalities-ollama/nsfw.md exists and is loadable", () => {
  const ollamaDir = join(promptsDir, "personalities-ollama");
  assert.ok(existsSync(ollamaDir), "personalities-ollama/ must exist");
  const map = loadPromptDir(ollamaDir);
  assert.ok(map.has("nsfw"), "nsfw.md must be present");
  const content = map.get("nsfw");
  assert.ok(content.length > 100, "nsfw.md must have non-trivial content");
  assert.match(content, /nsfw/i);
});

test("9.9 (b) provider=anthropic excludes nsfw and reports it as gated with a reason", () => {
  const { personalities, gated } = loadPersonalities(promptsDir, "anthropic");
  assert.equal(personalities.has("nsfw"), false, "nsfw must NOT load on anthropic");
  assert.ok(gated.has("nsfw"), "nsfw must be reported as gated");
  const reason = gated.get("nsfw");
  assert.match(reason, /BUDDY_PROVIDER=ollama/i);
  // The seven shipped baseline personalities still load.
  for (const name of ["nice", "dry", "rude", "pirate", "drill_sergeant", "shakespearean", "passive_aggressive"]) {
    assert.ok(personalities.has(name), `${name} must still load on anthropic`);
  }
});

test("9.9 (c) provider=ollama loads nsfw alongside the baseline personalities, no gating", () => {
  const { personalities, gated } = loadPersonalities(promptsDir, "ollama");
  assert.ok(personalities.has("nsfw"), "nsfw must load on ollama");
  assert.equal(gated.size, 0, "nothing should be gated on ollama");
  // Sanity: baseline personalities still present.
  assert.ok(personalities.has("nice"));
  assert.ok(personalities.has("dry"));
});

test("9.9 (d) Session(provider=anthropic).setPersonality('nsfw') returns false", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { personalities } = loadPersonalities(promptsDir, "anthropic");
    const memory = new MemoryStore(dir);
    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory,
      personalities,
    });
    assert.equal(session.listPersonalities().includes("nsfw"), false);
    assert.equal(session.setPersonality("nsfw"), false);
    assert.equal(session.getPersonality(), "nice");
  } finally {
    cleanup();
  }
});

test("9.9 (e) Session(provider=ollama).setPersonality('nsfw') returns true", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const { personalities } = loadPersonalities(promptsDir, "ollama");
    const memory = new MemoryStore(dir);
    const session = new Session(new FakeAnthropicClient(), prompts, {
      memory,
      personalities,
    });
    assert.equal(session.listPersonalities().includes("nsfw"), true);
    assert.equal(session.setPersonality("nsfw"), true);
    assert.equal(session.getPersonality(), "nsfw");
  } finally {
    cleanup();
  }
});

test("9.9 (f) provider switch correctly enables/disables nsfw across two daemon boots", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    // First boot on anthropic — try to set nsfw, expect false. The
    // attempt must not corrupt state for a future ollama boot.
    {
      const { personalities } = loadPersonalities(promptsDir, "anthropic");
      const memory = new MemoryStore(dir);
      const session = new Session(new FakeAnthropicClient(), prompts, {
        memory,
        personalities,
      });
      assert.equal(session.setPersonality("nsfw"), false);
      assert.equal(memory.getPersonality(), null, "rejected name must not persist");
    }
    // Second boot on ollama — same memory dir. Now nsfw should work.
    {
      const { personalities } = loadPersonalities(promptsDir, "ollama");
      const memory = new MemoryStore(dir);
      const session = new Session(new FakeAnthropicClient(), prompts, {
        memory,
        personalities,
      });
      assert.equal(session.setPersonality("nsfw"), true);
      assert.equal(memory.getPersonality(), "nsfw");
    }
  } finally {
    cleanup();
  }
});

test("9.9 (g) loadPromptDir returns empty map for a missing directory rather than throwing", () => {
  // The loader must tolerate missing personalities-ollama/ on a fresh
  // checkout where the user hasn't pulled in the optional content.
  const map = loadPromptDir("/path/that/definitely/does/not/exist");
  assert.equal(map.size, 0);
});
