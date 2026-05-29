// #96: ~/.coding-buddy holds curated-sensitive state (distilled learner
// profile, code-excerpt samples, verbatim Q&A). It must be owner-only —
// 0o700 dir / 0o600 files — so it isn't world-readable on shared or
// multi-user hosts.
//
// POSIX-mode assertions are skipped on Windows, where Node maps `mode`
// to just the read-only attribute (it can't represent 0o700/0o600). The
// behavioural assertions (dir/file created, content correct, helpers
// don't throw) run on every platform, so they still guard the Windows
// degradation path.
//
// Run: node --test daemon/test/secure-store.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  statSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  ensureSecureDir,
  writeFileSecure,
  appendFileSecure,
  DIR_MODE,
  FILE_MODE,
} = await import("../dist/secure-store.js");
const { MemoryStore } = await import("../dist/memory.js");

const posix = process.platform !== "win32";
const skipPosix = posix
  ? false
  : "POSIX file modes only (Windows maps mode to the read-only bit)";

function tmp() {
  return mkdtempSync(join(tmpdir(), "buddy-secure-"));
}

test("ensureSecureDir creates a missing nested dir", () => {
  const base = tmp();
  try {
    const dir = join(base, "nested", ".coding-buddy");
    ensureSecureDir(dir);
    assert.ok(existsSync(dir));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ensureSecureDir creates the dir at 0o700", { skip: skipPosix }, () => {
  const base = tmp();
  try {
    const dir = join(base, ".coding-buddy");
    ensureSecureDir(dir);
    assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "ensureSecureDir tightens a pre-existing world-readable dir (upgrade path)",
  { skip: skipPosix },
  () => {
    const base = tmp();
    try {
      const dir = join(base, ".coding-buddy");
      mkdirSync(dir, { mode: 0o755 });
      assert.equal(statSync(dir).mode & 0o777, 0o755, "precondition: 0o755");
      ensureSecureDir(dir);
      assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test("writeFileSecure round-trips content (and is 0o600 on POSIX)", () => {
  const base = tmp();
  try {
    const f = join(base, "secret.json");
    writeFileSecure(f, '{"a":1}');
    assert.equal(readFileSync(f, "utf8"), '{"a":1}');
    if (posix) assert.equal(statSync(f).mode & 0o777, FILE_MODE);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("appendFileSecure creates then appends (and is 0o600 on POSIX)", () => {
  const base = tmp();
  try {
    const f = join(base, "log.jsonl");
    appendFileSecure(f, "a\n");
    appendFileSecure(f, "b\n");
    assert.equal(readFileSync(f, "utf8"), "a\nb\n");
    if (posix) assert.equal(statSync(f).mode & 0o777, FILE_MODE);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "#96 MemoryStore persists into an owner-only dir with owner-only files",
  { skip: skipPosix },
  () => {
    const base = tmp();
    try {
      const dir = join(base, ".coding-buddy");
      const store = new MemoryStore(dir);
      store.append({
        ts: Date.now(),
        mode: "tutor",
        trigger: "AI?",
        reply_text: "verbatim user code excerpt",
      });
      store.setSummary("recurring misconception: off-by-one");
      assert.equal(statSync(dir).mode & 0o777, DIR_MODE, "dir not 0o700");
      const p = store.paths();
      assert.equal(statSync(p.log).mode & 0o777, FILE_MODE, "log not 0o600");
      assert.equal(
        statSync(p.summary).mode & 0o777,
        FILE_MODE,
        "summary not 0o600"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);
