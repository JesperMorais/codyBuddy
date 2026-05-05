// Helpers for auto-spawning the buddy daemon from the extension activation.
// Pulled out of extension.ts so the logic can be unit-tested without a VS Code
// host (extension.ts itself imports `vscode`, which the test runner can't load).

import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";

/**
 * Returns true if something is listening on 127.0.0.1:port. Used to avoid
 * spawning a second daemon when the user is already running one (e.g. via
 * `pnpm dev:daemon` in another terminal).
 */
export function probeDaemonPort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (alive: boolean) => {
      sock.removeAllListeners();
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolveProbe(alive);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Walks up from the extension's installation directory looking for the
 * compiled daemon entrypoint. Returns null if not found, in which case the
 * caller should disable auto-spawn and warn the user.
 */
export function findDaemonScript(extensionRoot: string, exists = existsSync): string | null {
  let dir = resolve(extensionRoot);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "daemon", "dist", "index.js");
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface SpawnOptions {
  /** Path to the daemon's compiled entrypoint (daemon/dist/index.js). */
  script: string;
  /** Loopback port the daemon should bind to. */
  port: number;
  /** Where to write daemon stdout/stderr. */
  log: (line: string) => void;
  /** Test seam: replaces node:child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Test seam: which node binary to run. Defaults to process.execPath. */
  nodeBin?: string;
}

export interface SpawnedDaemon {
  process: ChildProcess;
  dispose(): void;
}

export function spawnDaemon(opts: SpawnOptions): SpawnedDaemon {
  const spawnFn = opts.spawnImpl ?? spawn;
  const node = opts.nodeBin ?? process.execPath;
  const env = { ...process.env, BUDDY_DAEMON_PORT: String(opts.port) };
  const child = spawnFn(node, [opts.script], {
    env,
    cwd: dirname(opts.script),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (b) => opts.log(`[daemon] ${b.toString().trimEnd()}`));
  child.stderr?.on("data", (b) => opts.log(`[daemon] ${b.toString().trimEnd()}`));
  child.on("exit", (code) => opts.log(`[daemon] exited (code=${code})`));
  return {
    process: child,
    dispose: () => {
      try {
        child.kill();
      } catch {
        // already dead
      }
    },
  };
}
