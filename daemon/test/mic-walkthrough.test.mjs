// Task 15.9: mic-permission walkthrough drift guard.
//
// The README's "We need permission to access the microphone"
// subsection is now a dedicated walkthrough with three OS recipes
// + screenshots + the macOS VS Code-specific gotcha + PulseAudio
// AND PipeWire pointers. This test pins the structural pieces so
// future edits can't quietly drop them.
//
// Run: node --test daemon/test/mic-walkthrough.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

function readme() {
  return readFileSync(join(repoRoot, "README.md"), "utf8");
}

function micSection() {
  // The walkthrough lives between the H3 "1. ..." heading and the
  // next H3 "2. ..." heading. Slicing out that span keeps the
  // assertions scoped — a sibling section can't accidentally
  // satisfy a requirement.
  const text = readme();
  const start = text.indexOf('### 1. "We need permission to access the microphone"');
  const end = text.indexOf('### 2. ', start);
  assert.ok(start >= 0, "missing mic-permission heading");
  assert.ok(end > start, "missing next H3 to bound the section");
  return text.slice(start, end);
}

test("15.9 README has a mic-permission walkthrough heading", () => {
  const sec = micSection();
  assert.match(sec, /We need permission to access the microphone/);
});

test("15.9 walkthrough has Windows / macOS / Linux subsections", () => {
  const sec = micSection();
  assert.match(sec, /^####\s+Windows\s*11/m);
  assert.match(sec, /^####\s+macOS/m);
  assert.match(sec, /^####\s+Linux\s*\(PulseAudio\s*\/\s*PipeWire\)/m);
});

test("15.9 each OS section references its screenshot", () => {
  const sec = micSection();
  const expectedImages = [
    "docs/screenshots/mic/win11-mic-settings.png",
    "docs/screenshots/mic/macos-mic-settings.png",
    "docs/screenshots/mic/linux-pavucontrol-recording.png",
  ];
  for (const img of expectedImages) {
    assert.match(
      sec,
      new RegExp(img.replace(/\./g, "\\.")),
      `mic walkthrough missing image reference: ${img}`
    );
  }
});

test("15.9 each screenshot has descriptive alt text (>=25 chars)", () => {
  const sec = micSection();
  const re =
    /!\[([^\]]+)\]\(docs\/screenshots\/mic\/(win11-mic-settings|macos-mic-settings|linux-pavucontrol-recording)\.png\)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(sec)) !== null) {
    seen.add(m[2]);
    assert.ok(
      m[1].trim().length >= 25,
      `${m[2]} alt text too short: "${m[1]}"`
    );
  }
  assert.deepEqual(
    [...seen].sort(),
    [
      "linux-pavucontrol-recording",
      "macos-mic-settings",
      "win11-mic-settings",
    ],
    "expected all three OS screenshots to carry alt text"
  );
});

test("15.9 macOS section calls out the VS Code-specific gotcha + tccutil recipe", () => {
  const sec = micSection();
  // The signed-binary scoping — gotcha headline.
  assert.match(sec, /signed binary|VS Code-specific gotcha/i);
  // The concrete recipe (`tccutil reset`) — actionable, not just
  // "ask Apple support".
  assert.match(sec, /tccutil reset Microphone/);
});

test("15.9 Linux section names PulseAudio AND PipeWire", () => {
  const sec = micSection();
  assert.match(sec, /PulseAudio/);
  assert.match(sec, /PipeWire/);
  // Concrete tool: pavucontrol Recording tab is the cross-server
  // UI; pw-cli / wpctl are PipeWire-specific.
  assert.match(sec, /pavucontrol/);
  assert.match(sec, /pw-cli|wpctl/);
});

test("15.9 Windows section references both required toggles", () => {
  const sec = micSection();
  assert.match(sec, /Microphone access/);
  assert.match(sec, /Let desktop apps access your microphone/);
});

test("15.9 docs/screenshots/README.md documents the three new mic placeholders", () => {
  const path = join(repoRoot, "docs", "screenshots", "README.md");
  assert.ok(existsSync(path), "docs/screenshots/README.md missing");
  const text = readFileSync(path, "utf8");
  for (const fn of [
    "win11-mic-settings.png",
    "macos-mic-settings.png",
    "linux-pavucontrol-recording.png",
  ]) {
    assert.match(text, new RegExp(fn), `screenshots README missing ${fn}`);
  }
});
