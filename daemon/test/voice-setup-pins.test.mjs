// Task 16.14: per-OS voice-extras setup tooling drift guard.
//
// Asserts that:
//   (a) The .sh equivalents exist next to each .ps1 — so the README's
//       "fresh checkout on Windows 11, macOS, or Linux" claim about
//       voice extras is honoured (not Windows-only).
//   (b) The pinned Piper release is the same in setup-piper.ps1 and
//       setup-piper.sh — drift between OSes silently breaks contributors.
//   (c) The pinned whisper.cpp tag is the same in setup-whisper.ps1
//       and setup-whisper.sh, AND it is at least v1.8.x — guards
//       against the v1.7.6 stale pin called out in TASKS.md 16.14.
//
// Run: node --test daemon/test/voice-setup-pins.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const voiceDir = join(__dirname, "..", "..", "voice");

test("16.14 (a) per-OS voice setup scripts exist for piper and whisper", () => {
  for (const name of [
    "setup-piper.ps1",
    "setup-piper.sh",
    "setup-whisper.ps1",
    "setup-whisper.sh",
  ]) {
    assert.ok(
      existsSync(join(voiceDir, name)),
      `expected voice/${name} (16.14: voice extras must work on Windows + macOS/Linux)`,
    );
  }
});

test("16.14 (b) piper pin matches between setup-piper.ps1 and setup-piper.sh", () => {
  const ps = readFileSync(join(voiceDir, "setup-piper.ps1"), "utf8");
  const sh = readFileSync(join(voiceDir, "setup-piper.sh"), "utf8");

  // .ps1 pin lives in the release URL.
  const psMatch = ps.match(
    /github\.com\/rhasspy\/piper\/releases\/download\/([^/]+)\//,
  );
  assert.ok(psMatch, "setup-piper.ps1: could not find piper release tag");

  // .sh pin lives in piper_release="…".
  const shMatch = sh.match(/piper_release="([^"]+)"/);
  assert.ok(shMatch, "setup-piper.sh: could not find piper_release variable");

  assert.equal(
    shMatch[1],
    psMatch[1],
    `piper pin drift: .ps1=${psMatch[1]} vs .sh=${shMatch[1]}`,
  );
});

test("16.14 (c) whisper.cpp pin matches between .ps1 and .sh and is >= v1.8.0", () => {
  const ps = readFileSync(join(voiceDir, "setup-whisper.ps1"), "utf8");
  const sh = readFileSync(join(voiceDir, "setup-whisper.sh"), "utf8");

  const psMatch = ps.match(
    /github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/(v\d+\.\d+\.\d+)\//,
  );
  assert.ok(psMatch, "setup-whisper.ps1: could not find whisper release tag");

  const shMatch = sh.match(/whisper_tag="(v\d+\.\d+\.\d+)"/);
  assert.ok(shMatch, "setup-whisper.sh: could not find whisper_tag variable");

  assert.equal(
    shMatch[1],
    psMatch[1],
    `whisper.cpp pin drift: .ps1=${psMatch[1]} vs .sh=${shMatch[1]}`,
  );

  // Floor enforcement — TASKS.md 16.14 specifically calls v1.7.6 stale.
  // Anything below v1.8.0 fails this test.
  const m = psMatch[1].match(/^v(\d+)\.(\d+)\./);
  assert.ok(m, `unparsable whisper tag: ${psMatch[1]}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  assert.ok(
    major > 1 || (major === 1 && minor >= 8),
    `whisper.cpp pin ${psMatch[1]} is below the v1.8.0 floor (16.14 stale-pin check)`,
  );
});
