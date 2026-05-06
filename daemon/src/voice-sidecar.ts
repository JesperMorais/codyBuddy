// Voice sidecar process supervisor — Task 10.1.
//
// Spawns voice/main.py via uvicorn, supervises stdout/stderr, polls
// /health for readiness, kills cleanly on dispose. Mirrors the shape
// of extension/src/daemon-spawn.ts so the two supervisors read the
// same way.
//
// Opt-in via BUDDY_VAD_SPAWN=true in the daemon env. The sidecar is
// otherwise expected to be running externally (pnpm dev:voice) — the
// supervisor doesn't probe for an existing one because the voice
// sidecar's port is a per-deployment choice rather than a fixed
// loopback.

import { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

export interface VoiceSidecarOptions {
  /** Absolute path to the voice/ directory containing main.py. */
  voiceDir: string;
  /** Loopback port for uvicorn to bind. */
  port: number;
  /** Where to write sidecar stdout/stderr. */
  log: (line: string) => void;
  /** Python executable. Defaults to "python3" then "python" on PATH. */
  pythonBin?: string;
  /** Test seam: replaces node:child_process.spawn. */
  spawnImpl?: typeof nodeSpawn;
}

export interface VoiceSidecar {
  /** The spawned uvicorn process. Exposed for tests; production callers
   *  should use isRunning() / dispose() instead of poking it directly. */
  process: ChildProcess;
  /** True between successful spawn and process exit. */
  isRunning(): boolean;
  /** Polls GET /health until 200 or the deadline. Returns true on
   *  ready, false on timeout. Useful before opening the /vad WS. */
  waitForReady(timeoutMs?: number): Promise<boolean>;
  /** Sends SIGTERM. The child reaper logs the exit. Idempotent. */
  dispose(): void;
}

export function spawnVoiceSidecar(opts: VoiceSidecarOptions): VoiceSidecar {
  const spawnFn = opts.spawnImpl ?? nodeSpawn;
  const python = opts.pythonBin ?? "python3";
  const child = spawnFn(
    python,
    [
      "-m",
      "uvicorn",
      "main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(opts.port),
      "--log-level",
      "warning",
    ],
    {
      cwd: opts.voiceDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  let alive = true;
  child.stdout?.on("data", (b) =>
    opts.log(`[voice] ${b.toString().trimEnd()}`)
  );
  child.stderr?.on("data", (b) =>
    opts.log(`[voice] ${b.toString().trimEnd()}`)
  );
  child.on("exit", (code) => {
    alive = false;
    opts.log(`[voice] exited (code=${code})`);
  });
  // spawn() throws via the `error` event when the binary is missing
  // (ENOENT) — without a listener Node crashes the daemon. Mark the
  // supervisor as dead and surface the failure to the log.
  child.on("error", (err) => {
    alive = false;
    opts.log(`[voice] spawn error: ${err.message}`);
  });

  return {
    process: child,
    isRunning: () => alive && child.exitCode === null,
    waitForReady: async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!alive) return false;
        try {
          const res = await fetch(`http://127.0.0.1:${opts.port}/health`);
          if (res.ok) return true;
        } catch {
          // not up yet
        }
        await wait(150);
      }
      return false;
    },
    dispose: () => {
      try {
        child.kill();
      } catch {
        // already dead
      }
    },
  };
}

/** Walks up from `start` looking for a `voice/` directory containing
 *  main.py. Returns null when not found; caller should disable
 *  auto-spawn and warn. Mirrors findDaemonScript in the extension. */
export function findVoiceDir(start: string, exists: (p: string) => boolean): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "voice", "main.py");
    if (exists(candidate)) return resolve(dir, "voice");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
