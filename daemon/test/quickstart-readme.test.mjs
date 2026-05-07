// Task 15.3: Quickstart README drift guard.
//
// The spec calls for a Quickstart section that takes a user from
// `git clone` to first voice turn in <5 minutes, with screenshots
// at three phases and a Troubleshooting subsection covering five
// specific failure modes. This test pins the README structure so
// a future edit doesn't accidentally remove the contract.
//
// Run: node --test daemon/test/quickstart-readme.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const readmePath = join(repoRoot, "README.md");

function readme() {
  return readFileSync(readmePath, "utf8");
}

test("15.3 README has a top-level Quickstart section", () => {
  const text = readme();
  assert.match(
    text,
    /^## Quickstart/m,
    "expected `## Quickstart` heading at the top level"
  );
});

test("15.3 Quickstart has the five numbered onboarding steps", () => {
  const text = readme();
  // Steps 1–6 because we count 1=clone+install, 2=API key, 3=doctor,
  // 4=F5, 5=Ctrl+Alt+V, 6=ask. The spec says "first voice turn in
  // <5 minutes"; the exact count isn't pinned but the milestones are.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const re = new RegExp(`^${n}\\.\\s+\\*\\*`, "m");
    assert.match(
      text,
      re,
      `expected numbered step ${n}. **…** in the Quickstart`
    );
  }
});

test("15.3 Quickstart references the three sidebar screenshots", () => {
  const text = readme();
  for (const fn of [
    "sidebar-idle.png",
    "sidebar-listening.png",
    "sidebar-speaking.png",
  ]) {
    assert.match(
      text,
      new RegExp(`docs/screenshots/${fn}`),
      `Quickstart should reference docs/screenshots/${fn}`
    );
  }
});

test("15.3 Each screenshot has descriptive alt text", () => {
  const text = readme();
  // Lines like ![Sidebar at idle — red mic dot, …](docs/screenshots/sidebar-idle.png)
  // The alt text must be non-trivial — at least 20 chars before the closing `]`.
  const re =
    /!\[([^\]]+)\]\(docs\/screenshots\/sidebar-(idle|listening|speaking)\.png\)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    seen.add(m[2]);
    assert.ok(
      m[1].trim().length >= 20,
      `alt text for sidebar-${m[2]}.png is too short: "${m[1]}"`
    );
  }
  assert.deepEqual(
    [...seen].sort(),
    ["idle", "listening", "speaking"],
    "expected all three screenshot states to have alt text"
  );
});

test("15.3 Troubleshooting section exists with the five spec'd failures", () => {
  const text = readme();
  assert.match(text, /^## Troubleshooting/m, "Troubleshooting section missing");

  // Mic permission, GPU, model download, port, Anthropic 401 — these
  // are the five the spec calls out. Match on phrases that uniquely
  // identify each subsection.
  const expected = [
    /microphone|mic permission|access to the microphone/i,
    /GPU.*not found|XTTS.*GPU|CUDA/i,
    /model download.*interrupted|checksum mismatch/i,
    /port\s*31415|EADDRINUSE/i,
    /Anthropic\s*401|invalid\s*x-api-key/i,
  ];
  const trouble = text.split("## Troubleshooting")[1] ?? "";
  for (const re of expected) {
    assert.match(trouble, re, `troubleshooting missing: ${re}`);
  }
});

test("15.3 docs/screenshots/README.md exists and documents all three placeholders", () => {
  const path = join(repoRoot, "docs", "screenshots", "README.md");
  assert.ok(existsSync(path), `expected ${path} to exist`);
  const content = readFileSync(path, "utf8");
  for (const fn of [
    "sidebar-idle.png",
    "sidebar-listening.png",
    "sidebar-speaking.png",
  ]) {
    assert.match(content, new RegExp(fn), `screenshots README should mention ${fn}`);
  }
});

test("15.3 Quickstart points at the existing setup.{ps1,sh} (Task 15.1)", () => {
  // The Quickstart's headline first step uses the installer scripts
  // shipped in 15.1; pin that link so a refactor can't quietly
  // diverge.
  const text = readme();
  assert.match(text, /setup\.ps1/, "Quickstart should reference setup.ps1");
  assert.match(text, /setup\.sh/, "Quickstart should reference setup.sh");
});

test("15.3 Quickstart references pnpm doctor verification (Task 15.2)", () => {
  const text = readme();
  assert.match(text, /pnpm doctor/, "Quickstart should reference pnpm doctor");
});
