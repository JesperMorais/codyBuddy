// Task 9.10 guard rail: README.md and .env.example must stay in sync
// with the personality machinery shipped in 9.1–9.9. Each assertion
// pins one explicit deliverable from the task description.
//
// Run: node --test daemon/test/personality-docs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");

const baseline = readdirSync(resolve(repoRoot, "daemon", "prompts", "personalities"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));
const ollamaOnly = readdirSync(resolve(repoRoot, "daemon", "prompts", "personalities-ollama"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));

test("9.10 (a) every shipped baseline personality is named in README.md", () => {
  assert.ok(baseline.length > 0, "baseline personalities directory must not be empty");
  for (const name of baseline) {
    assert.ok(
      readme.includes(name),
      `README.md is missing the shipped baseline personality: ${name}`
    );
  }
});

test("9.10 (b) every shipped baseline personality is named in .env.example", () => {
  for (const name of baseline) {
    assert.ok(
      envExample.includes(name),
      `.env.example is missing the shipped baseline personality: ${name}`
    );
  }
});

test("9.10 (c) README documents the BUDDY_PERSONALITY env var", () => {
  assert.match(readme, /BUDDY_PERSONALITY/);
});

test("9.10 (d) README documents the shuffle toggle (BUDDY_PERSONALITY=random)", () => {
  assert.match(readme, /random/i, "README must mention the random/shuffle mode");
  assert.match(readme, /shuffle/i, "README must use the word 'shuffle' so users can find it");
});

test("9.10 (e) .env.example documents the random/shuffle special value", () => {
  assert.match(envExample, /random/i);
  assert.match(envExample, /shuffle/i);
});

test("9.10 (f) README explicitly states nsfw requires BUDDY_PROVIDER=ollama", () => {
  // The whole README block (or table row) covering nsfw must mention
  // both nsfw and the BUDDY_PROVIDER=ollama gate in close proximity.
  // We assert both appear and that the gating clause is present.
  assert.ok(ollamaOnly.includes("nsfw"), "shipped nsfw.md should exist before this test runs");
  assert.match(readme, /nsfw/i, "README must mention nsfw");
  assert.match(
    readme,
    /BUDDY_PROVIDER=ollama/i,
    "README must mention the BUDDY_PROVIDER=ollama gate verbatim"
  );
  // And it should explicitly call out anthropic as the unsupported case
  // — otherwise the user can't tell whether they're affected.
  assert.match(
    readme,
    /anthropic/i,
    "README must reference the anthropic provider when explaining the gate"
  );
});

test("9.10 (g) .env.example explicitly states nsfw requires BUDDY_PROVIDER=ollama and is unavailable on Anthropic", () => {
  assert.match(envExample, /nsfw/i);
  assert.match(envExample, /BUDDY_PROVIDER=ollama/i);
  assert.match(envExample, /anthropic/i);
});

test("9.10 (h) README's Personalities section references the persistence file paths", () => {
  // 9.5 and 9.6 persist to ~/.coding-buddy/personality.json and
  // shuffle.json. Documenting these lets users debug a stale state.
  assert.match(readme, /personality\.json/);
  assert.match(readme, /shuffle\.json/);
});
