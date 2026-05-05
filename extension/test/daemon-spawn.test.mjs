// Tests for the auto-spawn helpers in extension/src/daemon-spawn.ts.
// These don't load the VS Code API, so they run under plain `node --test`.
//
// Run: node --test extension/test/daemon-spawn.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";

const { probeDaemonPort, findDaemonScript, spawnDaemon } = await import(
  "../out/daemon-spawn.js"
);

// --------------------------------------------------------------------------
// probeDaemonPort
// --------------------------------------------------------------------------

test("probeDaemonPort returns true when something is listening on the port", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const alive = await probeDaemonPort(port);
    assert.equal(alive, true);
  } finally {
    server.close();
  }
});

test("probeDaemonPort returns false when no one is listening", async () => {
  // Pick a free port by opening + closing a server, then probe it.
  const tmp = createServer();
  await new Promise((r) => tmp.listen(0, "127.0.0.1", r));
  const { port } = tmp.address();
  await new Promise((r) => tmp.close(r));

  const alive = await probeDaemonPort(port, 200);
  assert.equal(alive, false);
});

// --------------------------------------------------------------------------
// findDaemonScript
// --------------------------------------------------------------------------

test("findDaemonScript walks up to locate daemon/dist/index.js", () => {
  // Pretend the extension lives at <root>/extension; the daemon at <root>/daemon.
  // path.resolve normalizes to the host OS's separators + drive prefix, so match
  // by suffix rather than literal equality.
  const seen = [];
  const fakeExists = (p) => {
    seen.push(p);
    return /[\\/]daemon[\\/]dist[\\/]index\.js$/.test(p) && /[\\/]repo[\\/]/.test(p);
  };
  const found = findDaemonScript("/repo/extension", fakeExists);
  assert.ok(found, `expected a script path; seen=${JSON.stringify(seen)}`);
  assert.match(found, /daemon[\\/]dist[\\/]index\.js$/);
});

test("findDaemonScript returns null when daemon/dist is missing all the way up", () => {
  const found = findDaemonScript("/some/random/path", () => false);
  assert.equal(found, null);
});

// --------------------------------------------------------------------------
// spawnDaemon
// --------------------------------------------------------------------------

function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", 0);
    calls.push({ cmd, args, opts });
    return child;
  };
  return { fakeSpawn, calls };
}

test("spawnDaemon launches node with the script path and BUDDY_DAEMON_PORT in env", () => {
  const { fakeSpawn, calls } = makeFakeSpawn();
  const lines = [];
  const handle = spawnDaemon({
    script: "C:\\repo\\daemon\\dist\\index.js",
    port: 31420,
    log: (l) => lines.push(l),
    spawnImpl: fakeSpawn,
    nodeBin: "C:\\Program Files\\nodejs\\node.exe",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(calls[0].args, ["C:\\repo\\daemon\\dist\\index.js"]);
  assert.equal(calls[0].opts.env.BUDDY_DAEMON_PORT, "31420");
  assert.equal(calls[0].opts.cwd, "C:\\repo\\daemon\\dist");

  // Pipes output through the log function.
  handle.process.stdout.emit("data", Buffer.from("hello\n"));
  handle.process.stderr.emit("data", Buffer.from("warn: x\n"));
  assert.deepEqual(lines, ["[daemon] hello", "[daemon] warn: x"]);

  // dispose() emits exit which logs.
  handle.dispose();
  assert.equal(lines.at(-1), "[daemon] exited (code=0)");
});
