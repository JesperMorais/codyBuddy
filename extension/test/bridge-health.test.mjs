// Task 3.2: bridge health-probe tests against a mock WS endpoint.
//
// Spins up a real `ws.WebSocketServer`, points DaemonBridge at it, and
// asserts that:
//   - The bridge sends `{type: "ping"}` immediately on connect.
//   - When the server replies `{type: "pong"}`, onHealth fires with up=true.
//   - When the server stays silent past the timeout, onHealth fires up=false.
//   - When the server closes the socket, onHealth fires up=false.
//
// Run: node --test extension/test/bridge-health.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

const { DaemonBridge } = await import("../out/bridge.js");

function makeOutput() {
  const lines = [];
  return { lines, appendLine: (l) => lines.push(l) };
}

async function listen(server) {
  await new Promise((r) => server.on("listening", r));
  return server.address().port;
}

function awaitHealth(bridge, predicate) {
  return new Promise((resolve) => {
    bridge.onHealth(({ up }) => {
      if (predicate(up)) resolve(up);
    });
  });
}

test("bridge fires onHealth(up=true) once the daemon ponges", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await listen(wss);
  const pings = [];
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      pings.push(msg);
      if (msg.type === "ping") sock.send(JSON.stringify({ type: "pong" }));
    });
  });

  const output = makeOutput();
  const bridge = new DaemonBridge(port, output);
  try {
    const up = await awaitHealth(bridge, (v) => v === true);
    assert.equal(up, true);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].type, "ping");
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("bridge fires onHealth(up=false) on socket close after a pong", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await listen(wss);
  const sockets = [];
  wss.on("connection", (sock) => {
    sockets.push(sock);
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ping") sock.send(JSON.stringify({ type: "pong" }));
    });
  });

  const output = makeOutput();
  const bridge = new DaemonBridge(port, output);
  try {
    await awaitHealth(bridge, (v) => v === true);
    // Now close the server-side socket. Bridge should flip to down.
    sockets[0].close();
    const down = await awaitHealth(bridge, (v) => v === false);
    assert.equal(down, false);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("bridge stays at up=false when the server never replies to ping", async () => {
  // Server that accepts connections but ignores all messages.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await listen(wss);
  wss.on("connection", () => {
    // intentionally silent
  });

  const output = makeOutput();
  const bridge = new DaemonBridge(port, output);
  try {
    // Initial replay says false. After 3.2s, the timeout fires; we still see false.
    let observed = [];
    bridge.onHealth(({ up }) => observed.push(up));
    await new Promise((r) => setTimeout(r, 3200));
    assert.deepEqual(observed.filter((v) => v === true), []);
    assert.match(output.lines.join("\n"), /no pong in 3s/);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});
