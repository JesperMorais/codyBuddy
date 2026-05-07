// Task 15.5: VSIX packaging drift guards.
//
// The full spec test ("workflow runs on a tag in a fork, artifacts
// appear on the release page") requires a real GitHub Actions
// dispatch which we can't exercise from `node --test`. This file
// pins the structural pieces that wire the workflow up:
//   - `pnpm build:vsix` script entries (root + extension)
//   - extension/.vscodeignore exists with the right exclusions
//   - LICENSE file at repo root (vsce warns without one)
//   - extension/package.json carries repository + license fields
//   - .github/workflows/release.yml triggers on `v*` tag pushes
//     and produces vsix + per-OS daemon zips with SHA256 sidecars.
//
// Run: node --test daemon/test/vsix-packaging.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
}

function readText(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

test("15.5 root pnpm script `build:vsix` exists and dispatches to extension", () => {
  const pkg = readJson("package.json");
  assert.ok(pkg.scripts["build:vsix"], "root build:vsix missing");
  assert.match(pkg.scripts["build:vsix"], /coding-buddy-vscode/);
});

test("15.5 extension package.json has build:vsix wired to vsce (via build helper)", () => {
  const pkg = readJson("extension/package.json");
  const script = pkg.scripts["build:vsix"];
  assert.ok(script, "extension build:vsix missing");
  // The helper resolves the version cross-platform (PowerShell
  // doesn't expand $npm_package_version) and runs vsce with the
  // right flags.
  assert.match(script, /scripts\/build-vsix\.mjs/);
  // Helper itself must invoke vsce + drop the artifact under the
  // documented filename.
  const helper = readText("extension/scripts/build-vsix.mjs");
  assert.match(helper, /@vscode\/vsce/);
  assert.match(helper, /coding-buddy-\$\{pkg\.version\}\.vsix/);
});

test("15.5 extension package.json has repository + license fields", () => {
  // vsce warns without these — they must ship for marketplace
  // candidacy. Drift guard so a future refactor doesn't drop them.
  const pkg = readJson("extension/package.json");
  assert.equal(pkg.license, "MIT");
  assert.equal(typeof pkg.repository, "object");
  assert.match(pkg.repository.url, /github\.com\/.+\.git$/);
  assert.ok(Array.isArray(pkg.categories) && pkg.categories.length > 0);
});

test("15.5 extension/.vscodeignore exists and excludes src + tests", () => {
  const path = "extension/.vscodeignore";
  assert.ok(existsSync(join(repoRoot, path)), `${path} missing`);
  const text = readText(path);
  for (const re of [/^src\/\*\*/m, /\.test\./, /tsconfig\.json/]) {
    assert.match(text, re, `vscodeignore should exclude ${re}`);
  }
});

test("15.5 LICENSE file at repo root", () => {
  const path = "LICENSE";
  assert.ok(existsSync(join(repoRoot, path)), "LICENSE missing — vsce will warn");
  const text = readText(path);
  assert.match(text, /MIT License/i);
  assert.match(text, /Coding Buddy/i);
});

test("15.5 release workflow exists and triggers on v* tag", () => {
  const path = ".github/workflows/release.yml";
  assert.ok(existsSync(join(repoRoot, path)), `${path} missing`);
  const text = readText(path);
  // Tag trigger
  assert.match(text, /tags:\s*\n\s*-\s*"v\*"/, "missing tag trigger on v*");
  // VSIX job
  assert.match(text, /pnpm build:vsix/, "missing vsix build step");
  // Per-OS daemon zip matrix
  assert.match(text, /windows-latest/, "missing windows in matrix");
  assert.match(text, /macos-latest/, "missing macos in matrix");
  assert.match(text, /ubuntu-latest/, "missing ubuntu in matrix");
  // SHA256 sidecars
  assert.match(text, /sha256/i, "missing checksum step");
  // Upload to release
  assert.match(
    text,
    /softprops\/action-gh-release/,
    "missing release upload action"
  );
});

test("15.5 release workflow names the daemon zips per OS", () => {
  const text = readText(".github/workflows/release.yml");
  // Suffix lives in a matrix entry (resolved into the artifact
  // name via ${{ matrix.suffix }}). The drift guard checks BOTH
  // the per-OS suffix declarations AND the templated artifact name
  // — together they prove the OS suffix flows through to the
  // shipped zip.
  for (const suffix of ["win-x64", "mac-x64", "linux-x64"]) {
    assert.match(
      text,
      new RegExp(`suffix:\\s*${suffix}`),
      `expected matrix entry: suffix: ${suffix}`
    );
  }
  // The artifact name interpolates the matrix suffix.
  assert.match(
    text,
    /buddy-daemon-\$\{\{\s*matrix\.suffix\s*\}\}\.zip/,
    "daemon zip artifact should be named via the matrix suffix"
  );
});

test("15.5 release workflow gates the GitHub-release upload on a v* tag", () => {
  // workflow_dispatch builds the artifacts but doesn't try to
  // attach them to a non-existent release.
  const text = readText(".github/workflows/release.yml");
  assert.match(
    text,
    /if:\s*startsWith\(github\.ref,\s*['"]refs\/tags\/v['"]\)/,
    "release upload should be gated on a v* tag ref"
  );
});

test("15.5 vsce uses --no-dependencies (workspace deps already vendored by tsc)", () => {
  // pnpm workspaces don't expose hoisted deps the way npm does,
  // so vsce's default "scan node_modules" finds nothing useful.
  // --no-dependencies tells vsce to ship only what `out/` references.
  const helper = readText("extension/scripts/build-vsix.mjs");
  assert.match(helper, /--no-dependencies/);
});
