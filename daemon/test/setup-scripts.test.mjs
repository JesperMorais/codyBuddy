// Task 15.1: setup-script drift + smoke tests.
//
// The full spec test ("CI matrix runs both scripts on
// windows-latest, macos-latest, ubuntu-latest; pnpm doctor green
// afterward") depends on pnpm doctor (Task 15.2) which doesn't
// exist yet. Until then this test covers what we CAN verify
// locally:
//   (a) Both scripts exist at the repo root, with reasonable
//       syntax.
//   (b) Each script enforces the documented prereqs (Node ≥20,
//       pnpm, Python ≥3.11) and ships the friendly install hints.
//   (c) Each script is idempotent — handles a pre-existing .env
//       and pre-existing voice/.venv without erroring.
//   (d) Each script copies .env.example → .env when .env is
//       missing.
//   (e) The final success message matches the spec wording.
//
// Run: node --test daemon/test/setup-scripts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const psPath = join(repoRoot, "setup.ps1");
const shPath = join(repoRoot, "setup.sh");

test("15.1 (a) setup.ps1 exists at repo root", () => {
  assert.ok(existsSync(psPath), `expected ${psPath}`);
});

test("15.1 (a) setup.sh exists at repo root", () => {
  assert.ok(existsSync(shPath), `expected ${shPath}`);
});

test("15.1 (b) setup.ps1 enforces Node ≥20 + pnpm + Python ≥3.11", () => {
  const src = readFileSync(psPath, "utf8");
  // Node check (we read the major version and compare).
  assert.match(src, /Get-NodeMajor/);
  assert.match(src, /\$nodeMajor -lt 20/);
  // pnpm check.
  assert.match(src, /Test-Pnpm/);
  // Python ≥3.11.
  assert.match(src, /Get-PythonMajorMinor/);
  assert.match(src, /\$py\.Minor -lt 11/);
});

test("15.1 (b) setup.sh enforces Node ≥20 + pnpm + Python ≥3.11", () => {
  const src = readFileSync(shPath, "utf8");
  assert.match(src, /node_major.*-lt 20/);
  assert.match(src, /have pnpm/);
  // Python: explicit 3.11 floor in the conditional.
  assert.match(src, /minor.*-ge 11/);
});

test("15.1 (b) both scripts ship friendly install hints", () => {
  for (const path of [psPath, shPath]) {
    const src = readFileSync(path, "utf8");
    // Hints reference the install URLs / commands — the spec
    // says "prints exact install commands for whichever's missing".
    assert.match(src, /nodejs\.org/i, `${path}: missing Node hint`);
    assert.match(src, /corepack/, `${path}: missing pnpm hint`);
    assert.match(src, /python\.org|brew install python|apt-get install python/i, `${path}: missing Python hint`);
  }
});

test("15.1 (c) both scripts are idempotent (skip when .env / venv exist)", () => {
  for (const path of [psPath, shPath]) {
    const src = readFileSync(path, "utf8");
    // .env: only copy when missing.
    assert.match(
      src,
      /\.env already exists/,
      `${path}: idempotent .env branch missing`
    );
    // venv: only create when missing.
    assert.match(
      src,
      /voice\/\.venv exists/,
      `${path}: idempotent venv branch missing`
    );
  }
});

test("15.1 (d) both scripts copy .env.example → .env", () => {
  for (const path of [psPath, shPath]) {
    const src = readFileSync(path, "utf8");
    assert.match(
      src,
      /\.env\.example.*\.env|cp.*ENV_EXAMPLE.*ENV_FILE|Copy-Item.*envExample.*envFile/i,
      `${path}: missing .env.example → .env copy`
    );
  }
});

test("15.1 (e) both scripts emit the spec'd success message", () => {
  // "Setup complete. Add ANTHROPIC_API_KEY to .env and run pnpm dev."
  for (const path of [psPath, shPath]) {
    const src = readFileSync(path, "utf8");
    assert.match(
      src,
      /Setup complete\. Add ANTHROPIC_API_KEY to \.env and run pnpm dev\./,
      `${path}: missing spec'd final message`
    );
  }
});

test("15.1 (f) setup.ps1 is requires-Version 5.1 compatible", () => {
  // Drift guard against accidental introduction of `&&` (PS 7+ only)
  // — we still target Windows PowerShell 5.1.
  const src = readFileSync(psPath, "utf8");
  assert.ok(
    !/^[^\n#]*&&/m.test(src.replace(/^#.*$/gm, "")),
    "setup.ps1 must not use && (PS 5.1 incompatible)"
  );
  assert.match(src, /#requires -Version 5\.1/, "missing #requires header");
});

test("15.1 (g) setup.sh is bash-strict (set -euo pipefail)", () => {
  const src = readFileSync(shPath, "utf8");
  assert.match(src, /set -euo pipefail/, "missing strict-mode bash header");
  assert.match(src, /^#!\/usr\/bin\/env bash/, "missing bash shebang");
});

test("15.1 (h) both scripts cover the optional flags documented in their preamble", () => {
  // --skip-voice / --skip-pnpm / --quiet should each be parsed.
  for (const path of [psPath, shPath]) {
    const src = readFileSync(path, "utf8");
    assert.match(src, /SkipVoice|skip-voice/, `${path}: missing --skip-voice`);
    assert.match(src, /SkipPnpm|skip-pnpm/, `${path}: missing --skip-pnpm`);
    assert.match(src, /Quiet|--quiet/, `${path}: missing --quiet`);
  }
});

test("15.1 (i) both scripts gracefully skip model download when manifest absent", () => {
  // Task 15.10 will ship voice/models.json. Until then the setup
  // script must NOT try to download or 404 — it logs a skip and
  // continues.
  for (const path of [psPath, shPath]) {
    const src = readFileSync(path, "utf8");
    assert.match(
      src,
      /Task 15\.10|models\.json not present|skipping model download/i,
      `${path}: missing manifest-absent skip path`
    );
  }
});
