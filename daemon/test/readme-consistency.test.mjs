// Task 8.1 guard rail: keeps README.md from drifting away from the code.
// If a DoD checkbox link rots, or a hotkey moves, the test fails loudly
// instead of silently misleading users.
//
// Run: node --test daemon/test/readme-consistency.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

test("8.1 (a) every DoD checkbox links to an existing test file", () => {
  // Match `[x] ... → [path/to/file.mjs](path/to/file.mjs)` chunks.
  const linkRe = /\[(?:x| )\] [^\n]*?\(([^)]+\.(?:mjs|ts))\)/g;
  const matches = [...readme.matchAll(linkRe)];
  assert.ok(matches.length >= 5, `expected at least 5 DoD links, got ${matches.length}`);

  for (const m of matches) {
    const rel = m[1];
    const abs = resolve(repoRoot, rel);
    assert.ok(existsSync(abs), `README references missing file: ${rel}`);
  }
});

test("8.1 (b) hotkey table mentions the three real keybindings from extension/package.json", () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "extension", "package.json"), "utf8"));
  const keys = pkg.contributes.keybindings.map((b) => b.key);
  assert.ok(keys.length >= 3, "extension should declare at least 3 keybindings");

  for (const key of keys) {
    // Render keys the way README does (e.g. `Ctrl+Alt+Q`)
    const rendered = key
      .split("+")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("+");
    assert.ok(
      readme.includes(rendered),
      `README is missing keybinding from package.json: ${rendered} (raw: ${key})`
    );
  }
});

test("8.1 (c) every key env var listed in .env.example appears in the README config table", () => {
  const env = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
  const vars = new Set();
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+[A-Z0-9_]*)=/);
    if (m) vars.add(m[1]);
  }
  assert.ok(vars.size > 0, ".env.example must define at least one variable");

  for (const v of vars) {
    assert.ok(
      readme.includes(v),
      `README config table is missing env var documented in .env.example: ${v}`
    );
  }
});

test("8.1 (d) README mentions all four shipped mode prompt files", () => {
  for (const mode of ["tutor", "architect", "explainer", "reviewer"]) {
    assert.ok(readme.includes(mode), `README missing mode reference: ${mode}`);
  }
});

test("8.1 (e) README points to scripts/tune-triggers.mjs and that file exists", () => {
  assert.match(readme, /scripts\/tune-triggers\.mjs/);
  assert.ok(existsSync(resolve(repoRoot, "scripts", "tune-triggers.mjs")));
});
