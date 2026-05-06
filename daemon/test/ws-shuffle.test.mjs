// Task 9.8 (daemon side): the modeSet ack now carries `shuffle` and the
// WS protocol accepts `setShuffle`. Together these let the sidebar
// reflect and toggle random-personality mode in one round-trip.
//
// Run: node --test daemon/test/ws-shuffle.test.mjs

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

function buildDeps({ defaultShuffle = false } = {}) {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
    ["pirate", "pirate overlay"],
  ]);
  const memDir = mkdtempSync(join(tmpdir(), "buddy-ws-shuffle-"));
  const memory = new MemoryStore(memDir);
  const session = new Session(fake, prompts, {
    memory,
    personalities,
    defaultShuffle,
  });
  return {
    session,
    tts: new TtsBridge({ backend: "none" }),
    stt: new SttBridge({}),
    recorder: new Recorder(),
    cleanup: () => rmSync(memDir, { recursive: true, force: true }),
  };
}

function waitListening(wss) {
  return new Promise((resolve) => {
    if (wss.address()) resolve();
    else wss.once("listening", resolve);
  });
}

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

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

test("9.8 (a) initial modeSet carries shuffle:false by default", async () => {
  const deps = buildDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.shuffle, false);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.8 (b) initial modeSet reflects defaultShuffle:true", async () => {
  const deps = buildDeps({ defaultShuffle: true });
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.shuffle, true);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.8 (c) setShuffle:true toggles state and acks via modeSet", async () => {
  const deps = buildDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setShuffle", shuffle: true }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.ok, true);
      assert.equal(ack.shuffle, true);
      assert.equal(deps.session.isShuffle(), true);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.8 (d) setShuffle:false turns it off", async () => {
  const deps = buildDeps({ defaultShuffle: true });
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setShuffle", shuffle: false }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.shuffle, false);
      assert.equal(deps.session.isShuffle(), false);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.8 (e) setMode / setPersonality acks also include shuffle (sidebar gets all dimensions in one frame)", async () => {
  const deps = buildDeps({ defaultShuffle: true });
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setPersonality", personality: "dry" }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.personality, "dry");
      assert.equal(ack.shuffle, true, "shuffle dimension must ride along");
      assert.deepEqual(ack.available, ["tutor"]);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});
