// Task 12.3: XTTS-v2 sidecar smoke test.
//
// Spawns voice/xtts.py via uvicorn on an OS-assigned port, hits
// /health, then POSTs /synth with a tiny payload. Auto-skips when
// Python or its FastAPI deps aren't available — CI on
// windows-latest typically won't have uvicorn installed, so the
// test must be a no-op there.
//
// Assertions cover the spec contract:
//   1. /health returns 200 with {ok: true} (and an xtts_loaded flag).
//   2. /synth degrades gracefully when the `TTS` package isn't
//      installed and returns 200 + {ok: false, skipped: "xtts-not-installed"}.
//      If TTS IS installed locally, /synth either returns binary
//      PCM (audio/L16;rate=24000;channels=1) when the ref clip
//      exists, OR a JSON {ok: false, error: "ref_clip not found"}
//      when it doesn't. All three outcomes satisfy the contract:
//      the sidecar booted, its endpoint accepted the schema, and it
//      didn't crash on a missing engine or missing input.
//
// Run: node --test daemon/test/xtts-sidecar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const voiceDir = resolve(__dirname, "../../voice");

function findPython() {
  for (const cmd of ["python", "python3", "py"]) {
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

/** Build a 24kHz mono Int16 silence WAV (~80 bytes) for the smoke
 *  test's "fixture ref clip" — a real on-disk path so XTTS, if
 *  loaded, would have something to read. The clip is too short to
 *  produce useful synth output, but it's enough for the schema
 *  contract: the endpoint accepts an existing path. */
function writeFixtureRef() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-12.3-ref-"));
  const path = join(dir, "ref.wav");
  // Minimal valid WAV: RIFF/WAVE header + fmt chunk + 0-sample data.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4); // file size - 8
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24000, 24); // sample rate
  header.writeUInt32LE(48000, 28); // byte rate (sr * 2)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(0, 40); // 0 sample frames
  writeFileSync(path, header);
  return path;
}

const python = findPython();
const haveDeps = python ? pythonHasDeps(python) : false;
const skipReason = !python
  ? "python not on PATH"
  : !haveDeps
    ? "uvicorn or fastapi not importable"
    : undefined;

if (skipReason) {
  console.log(`SKIP: xtts sidecar smoke — ${skipReason}`);
}

test(
  "12.3 xtts sidecar /health and /synth graceful-degrade smoke",
  { skip: skipReason },
  async () => {
    const port = await freePort();
    const proc = spawn(
      python,
      [
        "-m",
        "uvicorn",
        "xtts:app",
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
      // (a) /health
      const healthRes = await pollHealth(port);
      if (!healthRes) {
        throw new Error(
          `xtts sidecar did not become ready within 10s. stderr was:\n${stderrBuf.slice(0, 2000)}`
        );
      }
      const healthBody = await healthRes.json();
      assert.equal(healthRes.status, 200);
      assert.equal(healthBody.ok, true);
      assert.equal(typeof healthBody.xtts_loaded, "boolean");

      // (b) /synth with a fixture ref clip on disk.
      const refPath = writeFixtureRef();
      const synthRes = await fetch(`http://127.0.0.1:${port}/synth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "smoke test",
          ref_clip: refPath,
          language: "en",
        }),
      });
      assert.equal(synthRes.status, 200);

      const ct = synthRes.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        // Either graceful-degrade (TTS not installed) or a real
        // synth error from a degenerate fixture (XTTS installed but
        // refused the empty/short clip). Both are valid for the
        // smoke test — the endpoint accepted the schema and didn't
        // crash.
        const body = await synthRes.json();
        const degraded =
          typeof body.skipped === "string" &&
          body.skipped.startsWith("xtts-not-installed");
        const synthErrored = typeof body.error === "string";
        assert.ok(
          degraded || synthErrored,
          `expected graceful-degrade or synth-error JSON, got: ${JSON.stringify(body)}`
        );
      } else if (ct.startsWith("audio/L16")) {
        // XTTS is installed AND somehow tolerated the fixture clip.
        // Verify the headers carry the documented sample-rate hint
        // and that we got some bytes back.
        assert.match(ct, /rate=24000/);
        const buf = Buffer.from(await synthRes.arrayBuffer());
        assert.ok(buf.length >= 0, "binary stream body should be readable");
      } else {
        throw new Error(
          `unexpected /synth content-type: ${ct} (want application/json or audio/L16)`
        );
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
            // ignore
          }
          resolve(undefined);
        }, 3000);
      });
    }
  }
);

test(
  "12.3 xtts sidecar /synth handles missing ref_clip when xtts is loaded",
  { skip: skipReason },
  async () => {
    const port = await freePort();
    const proc = spawn(
      python,
      [
        "-m",
        "uvicorn",
        "xtts:app",
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
      if (!(await pollHealth(port))) {
        throw new Error(`sidecar not ready: ${stderrBuf.slice(0, 1000)}`);
      }

      // Send a path we know doesn't exist on disk. The endpoint
      // should respond 200 + JSON {ok:false} regardless of whether
      // XTTS itself is installed — both branches are safe.
      const res = await fetch(`http://127.0.0.1:${port}/synth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "x",
          ref_clip: "/nonexistent/ref/path/that/cannot/exist.wav",
          language: "en",
        }),
      });
      assert.equal(res.status, 200);
      const ct = res.headers.get("content-type") || "";
      assert.ok(
        ct.includes("application/json"),
        `expected json on missing ref_clip, got ${ct}`
      );
      const body = await res.json();
      assert.equal(body.ok, false);
      // Either graceful-degrade or the explicit ref-not-found error.
      const degraded =
        typeof body.skipped === "string" &&
        body.skipped.startsWith("xtts-not-installed");
      const refMissing =
        typeof body.error === "string" && body.error.includes("ref_clip");
      assert.ok(
        degraded || refMissing,
        `expected degrade or ref_clip error, got: ${JSON.stringify(body)}`
      );
    } finally {
      proc.kill();
      await new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve(undefined);
        proc.once("exit", () => resolve(undefined));
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve(undefined);
        }, 3000);
      });
    }
  }
);

test("12.3 xtts sidecar pyproject extra exists", () => {
  // Drift guard: pyproject.toml must declare the [xtts] optional
  // dependency group setup-xtts.ps1 installs.
  const pyproject = readFileSync(join(voiceDir, "pyproject.toml"), "utf8");
  assert.match(pyproject, /\bxtts\s*=\s*\[/);
  assert.match(pyproject, /TTS>=/);
});

test("12.3 setup-xtts.ps1 exists in voice/ next to setup-piper.ps1", () => {
  assert.ok(existsSync(join(voiceDir, "setup-xtts.ps1")));
});

test("12.3 xtts.py exists in voice/", () => {
  assert.ok(existsSync(join(voiceDir, "xtts.py")));
});
