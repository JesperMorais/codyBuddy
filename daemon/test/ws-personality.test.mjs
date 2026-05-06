// Task 9.4: WS protocol carries personality + availablePersonalities on
// every modeSet ack, and accepts setPersonality / getPersonality message
// types. Boots the real WS server in-process with a Session that has a
// loaded personalities map and asserts the round-trip behaviour.
//
// Run: node --test daemon/test/ws-personality.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { SttBridge } = await import("../dist/stt.js");
const { Recorder } = await import("../dist/recorder.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

// Per-test temp memory dir keeps the suite hermetic — without it the
// 9.5 personality persistence layer would leak state between tests
// and (worse) write into the developer's real ~/.coding-buddy on
// every local run.
function buildDeps({ defaultPersonality = "nice" } = {}) {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
    ["pirate", "pirate overlay"],
  ]);
  const memDir = mkdtempSync(join(tmpdir(), "buddy-ws-"));
  const memory = new MemoryStore(memDir);
  const session = new Session(fake, prompts, {
    memory,
    personalities,
    defaultPersonality,
  });
  const tts = new TtsBridge({ backend: "none" });
  const stt = new SttBridge({});
  const recorder = new Recorder();
  return {
    session,
    tts,
    stt,
    recorder,
    cleanup: () => rmSync(memDir, { recursive: true, force: true }),
  };
}

function waitListening(wss) {
  return new Promise((resolve) => {
    if (wss.address()) resolve();
    else wss.once("listening", resolve);
  });
}

// Attach the message buffer at construction time — the server pushes
// `modeSet` and `audioOwner` before any test code can run, and those
// frames are dropped if no listener exists yet.
function openClient(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue = [];
    const waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.next = (predicate) =>
      new Promise((res) => {
        const idx = queue.findIndex(predicate);
        if (idx >= 0) {
          const [m] = queue.splice(idx, 1);
          res(m);
        } else {
          waiters.push({ predicate, resolve: res });
        }
      });
    ws.once("open", () => resolve(ws));
  });
}

function nextMessage(ws, predicate) {
  return ws.next(predicate);
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

test("9.4 (a) initial modeSet carries personality + availablePersonalities", async () => {
  const deps = buildDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = await openClient(port);
    try {
      const ack = await nextMessage(ws, (m) => m.type === "modeSet");
      assert.equal(ack.ok, true);
      assert.equal(ack.mode, "tutor");
      assert.deepEqual(ack.available, ["tutor"]);
      assert.equal(ack.personality, "nice");
      assert.deepEqual(ack.availablePersonalities.sort(), ["dry", "nice", "pirate"]);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.4 (b) setPersonality switches personality and acks via modeSet", async () => {
  const deps = buildDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = await openClient(port);
    try {
      // Drain initial ack.
      await nextMessage(ws, (m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setPersonality", personality: "dry" }));
      const ack = await nextMessage(ws, (m) => m.type === "modeSet");
      assert.equal(ack.ok, true);
      assert.equal(ack.personality, "dry");
      assert.equal(ack.mode, "tutor");
      assert.equal(deps.session.getPersonality(), "dry");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.4 (c) setPersonality with unknown name acks ok:false and leaves state unchanged", async () => {
  const deps = buildDeps({ defaultPersonality: "dry" });
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = await openClient(port);
    try {
      await nextMessage(ws, (m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setPersonality", personality: "does_not_exist" }));
      const ack = await nextMessage(ws, (m) => m.type === "modeSet");
      assert.equal(ack.ok, false);
      assert.equal(ack.personality, "dry");
      assert.equal(deps.session.getPersonality(), "dry");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.4 (d) getPersonality replies with current modeSet snapshot", async () => {
  const deps = buildDeps({ defaultPersonality: "pirate" });
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = await openClient(port);
    try {
      await nextMessage(ws, (m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "getPersonality" }));
      const ack = await nextMessage(ws, (m) => m.type === "modeSet");
      assert.equal(ack.ok, true);
      assert.equal(ack.personality, "pirate");
      assert.equal(ack.mode, "tutor");
      assert.deepEqual(ack.availablePersonalities.sort(), ["dry", "nice", "pirate"]);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.4 (e) setMode ack still carries the personality dimension", async () => {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([
    ["tutor", "tutor prompt"],
    ["reviewer", "reviewer prompt"],
  ]);
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
  ]);
  const memDir = mkdtempSync(join(tmpdir(), "buddy-ws-"));
  const memory = new MemoryStore(memDir);
  const session = new Session(fake, prompts, {
    memory,
    personalities,
    defaultPersonality: "dry",
  });
  const wss = startServer({
    session,
    tts: new TtsBridge({ backend: "none" }),
    stt: new SttBridge({}),
    recorder: new Recorder(),
    port: 0,
  });
  await waitListening(wss);
  const port = wss.address().port;
  try {
    const ws = await openClient(port);
    try {
      await nextMessage(ws, (m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setMode", mode: "reviewer" }));
      const ack = await nextMessage(ws, (m) => m.type === "modeSet");
      assert.equal(ack.ok, true);
      assert.equal(ack.mode, "reviewer");
      assert.equal(ack.personality, "dry");
      assert.deepEqual(ack.availablePersonalities.sort(), ["dry", "nice"]);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    rmSync(memDir, { recursive: true, force: true });
  }
});
