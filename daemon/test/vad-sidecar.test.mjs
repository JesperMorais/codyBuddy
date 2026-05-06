// Task 10.1: end-to-end smoke test for the voice/main.py /vad endpoint.
//
// Spawns the real Python sidecar via uvicorn, opens a /vad WebSocket
// through the daemon's VadBridge, and asserts the graceful-degrade
// path: when silero-vad isn't installed, the upstream sends one
// `{type:"error", reason:"silero-vad-not-installed: ..."}` frame and
// closes, and the bridge latches into permanently-down rather than
// spinning on reconnect.
//
// The full silero-vad-with-fixture-WAV integration test (the
// "±100ms timestamps" assertion in the TASKS.md spec) requires
// installing torch + silero-vad locally and would download ~150MB
// of model weights into CI. That assertion ships separately when
// the install tooling lands; this file covers the
// hand-off-and-graceful-degrade contract that runs everywhere.
//
// Run: node --test daemon/test/vad-sidecar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const { VadBridge } = await import("../dist/vad-bridge.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const voiceDir = resolve(__dirname, "../../voice");

function findPython() {
  for (const cmd of ["python", "python3", "py"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "pipe" });
      return cmd;
    } catch {
      // try next candidate
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

function pythonHasSileroVad(python) {
  try {
    execFileSync(python, ["-c", "import silero_vad, torch"], { stdio: "pipe" });
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

async function pollHealth(port, maxMs = 10_000, stepMs = 200) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res;
    } catch {
      // not up yet
    }
    await wait(stepMs);
  }
  return null;
}

const python = findPython();
const haveDeps = python ? pythonHasDeps(python) : false;
const skipReason = !python
  ? "python not on PATH"
  : !haveDeps
    ? "uvicorn or fastapi not importable"
    : undefined;

if (skipReason) {
  console.log(`SKIP: vad sidecar — ${skipReason}`);
}

test(
  "10.1 vad sidecar graceful-degrade: missing silero-vad → one error frame, no reconnect spin",
  { skip: skipReason || (python && pythonHasSileroVad(python)
      ? "silero-vad IS installed; this test asserts the missing-dep path. See vad-sidecar-real.test.mjs (TODO) for the installed-path assertion."
      : undefined) },
  async () => {
    const port = await freePort();
    const proc = spawn(
      python,
      [
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-level",
        "warning",
      ],
      { cwd: voiceDir, windowsHide: true }
    );

    let stderrBuf = "";
    proc.stderr.on("data", (d) => (stderrBuf += d.toString()));

    try {
      const healthRes = await pollHealth(port);
      if (!healthRes) {
        throw new Error(
          `voice sidecar did not become ready within 10s. stderr was:\n${stderrBuf.slice(0, 2000)}`
        );
      }

      const bridge = new VadBridge({
        url: `ws://127.0.0.1:${port}/vad`,
        log: () => {},
        // Tight reconnect so we'd notice if the bridge spun.
        reconnectMs: 100,
      });
      const errors = [];
      bridge.onError((reason) => errors.push(reason));
      bridge.connect();
      try {
        // 600ms is 6 reconnect windows; if the bridge wasn't honouring
        // the permanent-down latch we'd see multiple errors here.
        await wait(600);
        assert.equal(errors.length, 1, "expected exactly one error event");
        assert.match(errors[0], /silero-vad/);
        assert.equal(bridge.isPermanentlyDown(), true);
      } finally {
        bridge.dispose();
      }
    } finally {
      proc.kill();
      await new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve(undefined);
        proc.once("exit", () => resolve(undefined));
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve(undefined);
        }, 3000);
      });
    }
  }
);
