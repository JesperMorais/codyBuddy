// Task 15.13: screencast README-link drift guard.
//
// The MP4 itself is a manual deliverable — a contributor with a
// real machine + mic records it later. Until then this test pins
// the structural pieces: the README links to the documented path,
// the recording brief lives where the spec puts it, and the brief
// covers the spec'd beats.
//
// "Manual deliverable; no automated test, but the README must
//  link to it." — the spec.
//
// Run: node --test daemon/test/screencast-link.test.mjs

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

test("15.13 README links to docs/screencasts/quickstart.mp4", () => {
  const text = readme();
  assert.match(
    text,
    /docs\/screencasts\/quickstart\.mp4/,
    "Quickstart README must link to docs/screencasts/quickstart.mp4"
  );
});

test("15.13 README link sits inside the Quickstart section", () => {
  const text = readme();
  const start = text.indexOf("## Quickstart");
  const end = text.indexOf("## ", start + 1);
  assert.ok(start >= 0, "Quickstart heading missing");
  const slice = text.slice(start, end > start ? end : undefined);
  assert.match(
    slice,
    /docs\/screencasts\/quickstart\.mp4/,
    "screencast link must live inside the Quickstart section"
  );
});

test("15.13 docs/screencasts/README.md exists with a recording brief", () => {
  const path = join(repoRoot, "docs", "screencasts", "README.md");
  assert.ok(existsSync(path), `${path} missing`);
  const text = readFileSync(path, "utf8");
  // Brief headlines.
  assert.match(text, /Recording brief/i);
  assert.match(text, /quickstart\.mp4/);
});

test("15.13 brief documents the five spec'd beats end-to-end", () => {
  const text = readFileSync(
    join(repoRoot, "docs", "screencasts", "README.md"),
    "utf8"
  );
  // The spec wording: "clone -> installer -> API key -> first voice turn".
  assert.match(text, /clone/i, "brief should mention clone");
  assert.match(text, /installer|setup\.(ps1|sh)/i, "brief should mention the installer");
  assert.match(text, /API key|ANTHROPIC_API_KEY/i, "brief should mention API key");
  assert.match(text, /voice|listening|speaking/i, "brief should cover the voice turn");
  // Plus the total runtime budget.
  assert.match(text, /5:00|five[\s-]?minute|~?5\s*min/i, "brief should set ~5min length");
});

test("15.13 brief points at OBS Studio + 1080p capture defaults", () => {
  // Drift guard for the capture conventions — keeps the produced
  // video consistent across re-recordings.
  const text = readFileSync(
    join(repoRoot, "docs", "screencasts", "README.md"),
    "utf8"
  );
  assert.match(text, /OBS Studio/);
  assert.match(text, /1920\s*[x×]\s*1080/i);
});

test("15.13 brief documents the LFS / release-asset placement options", () => {
  const text = readFileSync(
    join(repoRoot, "docs", "screencasts", "README.md"),
    "utf8"
  );
  // Both placement paths covered so the contributor doesn't bloat
  // the repo by accident.
  assert.match(text, /Git LFS/i);
  assert.match(text, /GitHub Release/i);
});
