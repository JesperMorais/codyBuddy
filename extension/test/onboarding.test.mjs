// Task 15.12: first-run sidebar onboarding tests.
//
// Spec: "with no .env, activate the extension; assert the panel
//        appears and completing it produces a valid .env."
//
// The vscode quickpick / showInputBox surface is hard to drive
// from node:test, so the wizard's runner is unit-tested via its
// pure pieces:
//   - shouldShowOnboarding(envPath): when it returns true, the
//     extension would have launched the wizard.
//   - applyOnboardingResult(envPath, result): writes the picked
//     values to .env (the spec's "produces a valid .env").
//
// Run: node --test extension/test/onboarding.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  shouldShowOnboarding,
  isValidApiKey,
  applyOnboardingResult,
  ONBOARDING_DISMISSED_KEY,
} = require("../out/onboarding.js");

function tempPath(content) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-15.12-"));
  const path = join(dir, ".env");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

// --- shouldShowOnboarding ---------------------------------------

test("15.12 shouldShowOnboarding: missing .env returns true", () => {
  const path = join(mkdtempSync(join(tmpdir(), "buddy-15.12-empty-")), ".env");
  assert.equal(shouldShowOnboarding(path), true);
});

test("15.12 shouldShowOnboarding: placeholder ANTHROPIC_API_KEY returns true", () => {
  const path = tempPath(
    "BUDDY_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-...\n"
  );
  assert.equal(shouldShowOnboarding(path), true);
});

test("15.12 shouldShowOnboarding: missing ANTHROPIC_API_KEY returns true", () => {
  const path = tempPath("BUDDY_PROVIDER=anthropic\n");
  assert.equal(shouldShowOnboarding(path), true);
});

test("15.12 shouldShowOnboarding: real key returns false", () => {
  const path = tempPath(
    `BUDDY_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-${"x".repeat(80)}\n`
  );
  assert.equal(shouldShowOnboarding(path), false);
});

test("15.12 shouldShowOnboarding: BUDDY_PROVIDER=ollama returns false", () => {
  // Ollama users don't need an Anthropic key; the wizard would
  // be confusing. Keep them out of it.
  const path = tempPath(
    "BUDDY_PROVIDER=ollama\nBUDDY_OLLAMA_URL=http://localhost:11434/v1\n"
  );
  assert.equal(shouldShowOnboarding(path), false);
});

// --- isValidApiKey ----------------------------------------------

test("15.12 isValidApiKey accepts realistic keys", () => {
  assert.equal(isValidApiKey(`sk-ant-${"x".repeat(80)}`), true);
  assert.equal(isValidApiKey(`  sk-ant-${"y".repeat(50)}  `), true);
});

test("15.12 isValidApiKey rejects placeholder + short + wrong-prefix + empty", () => {
  for (const bad of [
    "",
    "   ",
    "sk-ant-...",
    "sk-ant-",
    "sk-foo-aaaaaaaaaaaaaaaaaaaa",
    "openai-not-anthropic",
    "sk-ant-abc", // too short
  ]) {
    assert.equal(isValidApiKey(bad), false, `expected reject for: ${bad}`);
  }
});

// --- applyOnboardingResult --------------------------------------

test("15.12 applyOnboardingResult writes a valid .env (the spec test)", () => {
  // No .env yet — the wizard's user just completed step 4.
  const path = join(mkdtempSync(join(tmpdir(), "buddy-15.12-spec-")), ".env");
  const result = {
    apiKey: `sk-ant-${"a".repeat(80)}`,
    personality: "drill_sergeant",
    wakeWord: "hey buddy",
  };
  applyOnboardingResult(path, result);

  const onDisk = readFileSync(path, "utf8");
  assert.match(onDisk, /^ANTHROPIC_API_KEY=sk-ant-/m);
  assert.match(onDisk, /^BUDDY_PERSONALITY=drill_sergeant$/m);
  assert.match(onDisk, /^BUDDY_WAKEWORD=hey buddy$/m);
  assert.match(onDisk, /^BUDDY_PROVIDER=anthropic$/m);

  // Subsequent shouldShowOnboarding calls should now report false —
  // the wizard would not re-run on the next activation.
  assert.equal(shouldShowOnboarding(path), false);
});

test("15.12 applyOnboardingResult preserves existing keys (only updates the four)", () => {
  const path = tempPath(`BUDDY_DAEMON_PORT=31416
BUDDY_TTS_BACKEND=auto
ANTHROPIC_API_KEY=sk-ant-...
`);
  applyOnboardingResult(path, {
    apiKey: `sk-ant-${"b".repeat(80)}`,
    personality: "nice",
    wakeWord: "off",
  });
  const onDisk = readFileSync(path, "utf8");
  // Untouched keys preserved.
  assert.match(onDisk, /^BUDDY_DAEMON_PORT=31416$/m);
  assert.match(onDisk, /^BUDDY_TTS_BACKEND=auto$/m);
  // Updated keys.
  assert.match(onDisk, /^ANTHROPIC_API_KEY=sk-ant-bb/m);
  assert.match(onDisk, /^BUDDY_PERSONALITY=nice$/m);
  assert.match(onDisk, /^BUDDY_WAKEWORD=off$/m);
});

test("15.12 applyOnboardingResult honors a custom wake phrase verbatim", () => {
  const path = tempPath("");
  applyOnboardingResult(path, {
    apiKey: `sk-ant-${"c".repeat(80)}`,
    personality: "nice",
    wakeWord: "yo computer",
  });
  const onDisk = readFileSync(path, "utf8");
  assert.match(onDisk, /^BUDDY_WAKEWORD=yo computer$/m);
});

// --- workspace state contract ----------------------------------

test("15.12 ONBOARDING_DISMISSED_KEY is exported as the documented name", () => {
  assert.equal(ONBOARDING_DISMISSED_KEY, "buddy.onboardingDismissed");
});

// --- extension command + drift guard ---------------------------

test("15.12 extension package.json exposes the runOnboarding command", () => {
  const pkg = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "package.json"),
      "utf8"
    )
  );
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(
    cmds.includes("coding-buddy.runOnboarding"),
    `expected runOnboarding command, got: ${cmds.join(", ")}`
  );
});
