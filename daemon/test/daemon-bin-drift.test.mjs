// Task 15.6: drift guard for the single-binary daemon build.
//
// Pins the structural pieces — the actual smoke test
// (daemon-bin-smoke.test.mjs) skips when no binary is built; this
// file always runs and catches a regression in the script /
// config / wiring layer.
//
// Run: node --test daemon/test/daemon-bin-drift.test.mjs

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

test("15.6 daemon/sea-config.json exists with required fields", () => {
  const path = "daemon/sea-config.json";
  assert.ok(existsSync(join(repoRoot, path)), `${path} missing`);
  const cfg = readJson(path);
  assert.equal(cfg.main, "dist-bin/bundle.cjs");
  assert.equal(cfg.output, "dist-bin/sea-prep.blob");
  assert.equal(cfg.disableExperimentalSEAWarning, true);
});

test("15.6 daemon/scripts/build-bin.mjs exists with the three SEA steps", () => {
  const text = readText("daemon/scripts/build-bin.mjs");
  // Step 1: esbuild bundle
  assert.match(text, /esbuild/);
  assert.match(text, /--bundle/);
  assert.match(text, /--format=cjs/);
  // Step 2: SEA blob
  assert.match(text, /--experimental-sea-config/);
  // Step 3: postject inject
  assert.match(text, /postject/);
  assert.match(text, /NODE_SEA_BLOB/);
  assert.match(text, /NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2/);
});

test("15.6 build:daemon-bin script wired in root + daemon", () => {
  const root = readJson("package.json");
  assert.equal(
    root.scripts["build:daemon-bin"],
    "pnpm --filter buddy-daemon build:bin"
  );
  const daemon = readJson("daemon/package.json");
  assert.match(daemon.scripts["build:bin"], /scripts\/build-bin\.mjs/);
});

test("15.6 build-bin produces per-OS suffix names", () => {
  const text = readText("daemon/scripts/build-bin.mjs");
  for (const suffix of ["win-x64", "mac-x64", "linux-x64"]) {
    assert.match(
      text,
      new RegExp(`return ["']${suffix}["']`),
      `build-bin missing suffix branch: ${suffix}`
    );
  }
});

test("15.6 build-bin ships prompts/ alongside the binary", () => {
  // Daemon at runtime needs the prompts/ directory; SEA only
  // embeds the JS bundle. The build script must copy prompts/
  // into dist-bin/ so the release zip carries them.
  const text = readText("daemon/scripts/build-bin.mjs");
  assert.match(text, /prompts/, "build-bin should mention prompts");
  assert.match(text, /cpSync/, "build-bin should copy prompts via cpSync");
});

test("15.6 daemon/src/index.ts handles SEA bundle's empty import.meta", () => {
  // esbuild's CJS output sets import.meta = {}; fileURLToPath('')
  // throws. The dev path falls back to dirname(process.execPath).
  const text = readText("daemon/src/index.ts");
  assert.match(text, /try\s*\{\s*\n\s*return dirname\(fileURLToPath\(import\.meta\.url\)/);
  assert.match(text, /return dirname\(process\.execPath\)/);
});

test("15.6 daemon/src/index.ts looks for prompts as binary sibling first", () => {
  const text = readText("daemon/src/index.ts");
  assert.match(text, /resolve\(__dirname,\s*"prompts"\)/);
  assert.match(text, /resolve\(__dirname,\s*"\.\.\/prompts"\)/);
});

test("15.6 daemon/dist-bin is gitignored", () => {
  const ignore = readText(".gitignore");
  assert.match(ignore, /^dist-bin\//m);
});

test("15.6 release workflow builds + smoke-tests the binary on all 3 OS", () => {
  const text = readText(".github/workflows/release.yml");
  // The matrix must include the three OS for daemon-bin job.
  // Re-using the same matrix as daemon-zip is fine — the binary
  // build piggybacks on it. We just check the build step exists.
  assert.match(
    text,
    /build:daemon-bin|build-bin\.mjs/,
    "release workflow should build the single-binary daemon"
  );
});
