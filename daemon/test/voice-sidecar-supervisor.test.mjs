// Task 10.1: voice sidecar process supervisor.
//
// Spawns the real Python uvicorn process via spawnVoiceSidecar(),
// waits for /health, asserts isRunning(), then verifies a clean
// dispose(). Skip-gated on python + uvicorn availability — same
// gate as voice-sidecar.test.mjs and vad-sidecar.test.mjs.
//
// Run: node --test daemon/test/voice-sidecar-supervisor.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { spawnVoiceSidecar, findVoiceDir } = await import("../dist/voice-sidecar.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const voiceDir = resolve(repoRoot, "voice");

function findPython() {
  for (const cmd of ["python3", "python", "py"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "pipe" });
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

function pythonHasDeps(python) {
  try {
    execFileSync(python, ["-c", "import uvicorn, fastapi"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const python = findPython();
const haveDeps = python ? pythonHasDeps(python) : false;
const skipReason = !python
  ? "python not on PATH"
  : !haveDeps
    ? "uvicorn or fastapi not importable"
    : undefined;

if (skipReason) console.log(`SKIP: voice sidecar supervisor — ${skipReason}`);

test("10.1 (g) findVoiceDir locates voice/main.py walking up from a nested path", () => {
  // Pure-fs test (no spawn) — runs even when the skip gate fires.
  const found = findVoiceDir(__dirname, existsSync);
  assert.equal(found, voiceDir);

  // Returns null when nothing matches (using a stub `exists` that always says no).
  const notFound = findVoiceDir(__dirname, () => false);
  assert.equal(notFound, null);
});

test(
  "10.1 (h) spawnVoiceSidecar boots, waits for /health, isRunning() true, then disposes cleanly",
  { skip: skipReason },
  async () => {
    const port = await freePort();
    const logs = [];
    const sidecar = spawnVoiceSidecar({
      voiceDir,
      port,
      pythonBin: python,
      log: (line) => logs.push(line),
    });

    try {
      const ready = await sidecar.waitForReady(10_000);
      if (!ready) {
        throw new Error(
          `sidecar did not become ready in 10s. recent logs:\n${logs.slice(-20).join("\n")}`
        );
      }
      assert.equal(sidecar.isRunning(), true);

      // Confirm /health really answers — sanity check that waitForReady's
      // return value matches reality.
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    } finally {
      sidecar.dispose();
      // Give the process a beat to wind down so the next test's port
      // reuse doesn't collide if anyone else runs sequentially.
      await new Promise((r) => {
        if (sidecar.process.exitCode !== null) return r(undefined);
        sidecar.process.once("exit", () => r(undefined));
        setTimeout(() => {
          try {
            sidecar.process.kill("SIGKILL");
          } catch {
            // ignore
          }
          r(undefined);
        }, 3000);
      });
      assert.equal(sidecar.isRunning(), false, "isRunning must be false after dispose+exit");
    }
  }
);

test("10.1 (i) waitForReady returns false when the python binary doesn't exist", async () => {
  // Pure unit test of the supervisor's no-process path: spawn fails
  // because the binary doesn't exist, the child exits immediately,
  // waitForReady's `alive` check trips and returns false. No real
  // sidecar needed, so this runs even when the skip gate fires.
  const sidecar = spawnVoiceSidecar({
    voiceDir,
    port: 1, // privileged port — not that we'll ever try to bind
    pythonBin: "/path/to/python/that/does/not/exist",
    log: () => {},
  });
  try {
    const ready = await sidecar.waitForReady(1_000);
    assert.equal(ready, false);
  } finally {
    sidecar.dispose();
  }
});
