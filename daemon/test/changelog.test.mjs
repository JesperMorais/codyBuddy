// Task 8.2: scripts/gen-changelog.mjs categorisation + render tests.
//
// Run: node --test daemon/test/changelog.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const { categorize, render } = await import(
  "../../scripts/gen-changelog.mjs"
);

test("8.2 (a) categorize routes Task / Plan / Fix / Refactor / other correctly", () => {
  const commits = [
    { hash: "aaa", subject: "Task 1.1: extract AiClient interface" },
    { hash: "bbb", subject: "Plan: add Phase 9 (Personalities)" },
    { hash: "ccc", subject: "Fix: replace shell-glob test args with Node auto-discovery" },
    { hash: "ddd", subject: "Refactor: extract daemon spawn helpers" },
    { hash: "eee", subject: "Initial commit: Coding Buddy MVP scaffolding" },
  ];
  const sections = categorize(commits);
  assert.deepEqual(
    sections.added.map((c) => c.hash),
    ["aaa", "bbb"]
  );
  assert.deepEqual(sections.fixed.map((c) => c.hash), ["ccc"]);
  assert.deepEqual(sections.changed.map((c) => c.hash), ["ddd"]);
  assert.deepEqual(sections.notes.map((c) => c.hash), ["eee"]);
});

test("8.2 (b) render emits Keep-a-Changelog headings only when sections are non-empty", () => {
  const out = render({
    added: [{ hash: "abc", subject: "Task 0.1: bootstrap" }],
    changed: [],
    fixed: [{ hash: "def", subject: "Fix: secret scrub" }],
    notes: [],
  });
  assert.match(out, /^# Changelog/);
  assert.match(out, /Keep a Changelog/);
  assert.match(out, /## \[Unreleased\] — generated \d{4}-\d{2}-\d{2}/);
  assert.match(out, /### Added\n- Task 0\.1: bootstrap \(abc\)/);
  assert.match(out, /### Fixed\n- Fix: secret scrub \(def\)/);
  assert.equal(out.includes("### Changed"), false);
  assert.equal(out.includes("### Notes"), false);
});

test("8.2 (c) render is stable when sections are all empty (date-only header)", () => {
  const out = render({ added: [], changed: [], fixed: [], notes: [] });
  assert.match(out, /^# Changelog/);
  assert.match(out, /## \[Unreleased\] — generated \d{4}-\d{2}-\d{2}/);
  assert.equal(out.includes("###"), false);
});

test("8.2 (d) CHANGELOG.md exists at the repo root and starts with the canonical header", () => {
  const path = resolve(repoRoot, "CHANGELOG.md");
  assert.ok(existsSync(path), "CHANGELOG.md must exist — run `pnpm changelog` to refresh");
  const head = readFileSync(path, "utf8").slice(0, 200);
  assert.match(head, /^# Changelog/);
  assert.match(head, /Keep a Changelog/);
});

test("8.2 (e) CHANGELOG.md mentions some Task entries (proves the script ran on real history)", () => {
  const body = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(body, /### Added/, "expected at least one Added entry");
  // Conservative — at least one Task-line plus one Plan-line have been
  // committed (this PR series alone produces several).
  assert.match(body, /Task \d+\.\d+:/);
});
