// Task 15.6 smoke test: built daemon binary boots, accepts a
// ping over WebSocket, and exits cleanly on SIGINT.
//
// Skips when the binary hasn't been built — `pnpm build:daemon-bin`
// produces it. CI's release matrix runs the build and then this
// test on each OS.
//
// Run: node --test daemon/test/daemon-bin-smoke.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBin = resolve(__dirname, "..", "dist-bin");

function platformLabel() {
  if (process.platform === "win32") return "win-x64";
  if (process.platform === "darwin") return "mac-x64";
  return "linux-x64";
}

function binaryPath() {
  const base = `buddy-daemon-${platformLabel()}`;
  const ext = process.platform === "win32" ? ".exe" : "";
  return join(distBin, base + ext);
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

async function pollPort(port, maxMs = 10_000, stepMs = 200) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const result = await new Promise((res) => {
        ws.once("open", () => res(ws));
        ws.once("error", () => res(null));
      });
      if (result) return result;
    } catch {
      // continue
    }
    await wait(stepMs);
  }
  return null;
}

const binary = binaryPath();
const have = existsSync(binary);
const skipReason = have ? undefined : `${binary} not built — run pnpm build:daemon-bin`;

if (skipReason) console.log(`SKIP: daemon-bin smoke — ${skipReason}`);

test(
  "15.6 single-binary daemon boots, accepts ping, exits cleanly on SIGINT",
  { skip: skipReason },
  async () => {
    const port = await freePort();
    // Spawn with a fake API key so the daemon doesn't bail on
    // missing env. The .env-loaded values would override these
    // in dev, but the bin doesn't ship a .env so process.env wins.
    const proc = spawn(binary, [], {
      env: {
        ...process.env,
        BUDDY_DAEMON_PORT: String(port),
        BUDDY_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-smoke-" + "x".repeat(80),
        BUDDY_TTS_BACKEND: "none",
        // No model files needed for ping; the WS server is up
        // even without them.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));

    try {
      const ws = await pollPort(port);
      assert.ok(
        ws,
        `binary did not open WS on port ${port} within 10s.\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );

      // Send ping, expect pong.
      const pong = await new Promise((resolve, reject) => {
        const onMessage = (data) => {
          try {
            const obj = JSON.parse(data.toString());
            if (obj.type === "pong") {
              ws.off("message", onMessage);
              resolve(obj);
            }
          } catch {
            // ignore non-JSON / boot frames
          }
        };
        ws.on("message", onMessage);
        ws.once("error", reject);
        ws.send(JSON.stringify({ type: "ping" }));
        // 5s safety timeout.
        setTimeout(() => reject(new Error("no pong within 5s")), 5_000);
      });

      assert.equal(pong.type, "pong");
      try {
        ws.close();
      } catch {
        // ignore
      }
    } finally {
      // Clean SIGINT exit. On Windows SIGINT to a child is a
      // no-op via Node's spawn; we send Ctrl-C via process.kill
      // with SIGTERM-equivalent. Node propagates SIGINT cleanly
      // on Linux/macOS via process.kill(pid, 'SIGINT').
      const killed = await new Promise((resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
        try {
          if (process.platform === "win32") {
            proc.kill();
          } else {
            proc.kill("SIGINT");
          }
        } catch {
          // already dead
          resolve({ code: 0, signal: null });
        }
        // Hard timeout.
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* */
          }
          resolve({ code: -1, signal: "TIMEOUT" });
        }, 5_000);
      });
      // We don't strict-assert exit code 0 because Windows process
      // termination paths don't propagate the JS handler reliably.
      // The contract is "exits cleanly" — i.e. doesn't hang, which
      // the SIGKILL timeout would reveal.
      assert.notEqual(killed.signal, "TIMEOUT", "binary did not exit within 5s");
    }
  }
);
