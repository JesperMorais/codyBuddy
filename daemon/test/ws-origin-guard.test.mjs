// CSWSH guard (#94). Asserts the daemon's WebSocket server rejects
// connections carrying an `Origin` header (the browser-CSWSH attack
// surface) while still accepting the legit Node ws client (which
// sends no Origin by default). Pre-fix: any browser on the user's
// machine could drive the daemon. Post-fix: connection upgrade
// returns 403 for any browser-issued connect.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { SttBridge } = await import("../dist/stt.js");
const { Recorder } = await import("../dist/recorder.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

function buildDeps() {
  const fake = new FakeAnthropicClient({ replies: [] });
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const session = new Session(fake, prompts);
  const tts = new TtsBridge({ backend: "none" });
  const stt = new SttBridge({});
  const recorder = new Recorder();
  return { session, tts, stt, recorder };
}

function waitListening(wss) {
  return new Promise((resolve) => {
    if (wss.address()) resolve();
    else wss.once("listening", resolve);
  });
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

test("WS rejects connections with an Origin header (CSWSH guard)", async () => {
  const wss = startServer({ ...buildDeps(), port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "http://evil.example",
    });
    try {
      await new Promise((resolve, reject) => {
        ws.once("open", () => reject(new Error("connection should not have opened")));
        ws.once("error", (err) => {
          // ws surfaces verifyClient(false, 403, ...) as an error event
          // whose message includes the status code.
          assert.match(String(err), /403/, `expected 403 in error, got: ${err}`);
          resolve();
        });
      });
    } finally {
      // Close the client socket whether the assertion passed or
      // failed so a regression doesn't hang the test runner on a
      // dangling open connection.
      try { ws.close(); } catch {}
    }
  } finally {
    await closeServer(wss);
  }
});

test("WS accepts connections without an Origin header (legit Node ws client)", async () => {
  const wss = startServer({ ...buildDeps(), port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    ws.close();
  } finally {
    await closeServer(wss);
  }
});
