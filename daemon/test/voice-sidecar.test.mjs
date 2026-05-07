// Task 2.3: voice sidecar smoke test.
//
// Spawns voice/main.py via uvicorn on an OS-assigned port, hits /health, and
// POSTs /tts with a tiny payload. Auto-skips when Python or its FastAPI deps
// aren't available — CI on windows-latest typically won't have uvicorn
// installed, so the test must be a no-op there.
//
// What the assertions cover (Task 2.3 contract):
//   1. /health returns 200 with {ok: true}.
//   2. /tts degrades gracefully when kokoro_onnx isn't installed and returns
//      {ok: true, skipped: "kokoro-not-installed"}.
//      If kokoro_onnx IS installed locally, the test also accepts a normal
//      success ({ok: true, spoken: "..."}) — the contract is about graceful
//      degrade, not about forcing the broken state.
//
// Run: node --test daemon/test/voice-sidecar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

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
      // server not up yet
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
  console.log(`SKIP: voice sidecar smoke — ${skipReason}`);
}

test("voice sidecar /health and /tts graceful-degrade smoke", { skip: skipReason }, async () => {
  const port = await freePort();
  const proc = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "buddy_voice.main:app",
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
    const healthBody = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(healthBody.ok, true);

    const ttsRes = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "smoke test" }),
    });
    assert.equal(ttsRes.status, 200);
    const ttsBody = await ttsRes.json();
    assert.equal(ttsBody.ok, true);

    // Either kokoro_onnx is missing → graceful degrade, OR it's installed
    // locally and the call actually played. Both satisfy the contract.
    const degraded = ttsBody.skipped === "kokoro-not-installed";
    const spoken = typeof ttsBody.spoken === "string";
    assert.ok(
      degraded || spoken,
      `expected graceful degrade or successful synth, got: ${JSON.stringify(ttsBody)}`
    );
  } finally {
    proc.kill();
    await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve(undefined);
      proc.once("exit", () => resolve(undefined));
      // Hard timeout in case the child ignores SIGTERM.
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
});
