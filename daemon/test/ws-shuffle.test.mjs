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

test("16.16 (e) modeSet broadcasts the seed personality, not the per-trigger shuffle roll", async () => {
  // Wire up a deterministic shuffle so the runtime overlay rolls away
  // from the seed on the very first trigger. The modeAck after a mode
  // change must still report the seed — otherwise the sidebar dropdown
  // would appear to drift on every turn even though the user's
  // configured personality hasn't changed.
  const fake = new (await import("./fakes.mjs")).FakeAnthropicClient({
    replies: [{ mode: "chat", text: "ok", wants_followup: false }],
  });
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
    ["pirate", "pirate overlay"],
  ]);
  const memDir = mkdtempSync(join(tmpdir(), "buddy-ws-shuffle-seed-"));
  const memory = new MemoryStore(memDir);
  let rngState = 1;
  const session = new Session(fake, prompts, {
    memory,
    personalities,
    defaultPersonality: "dry",
    defaultShuffle: true,
    rng: () => {
      rngState = (rngState * 1664525 + 1013904223) >>> 0;
      return rngState / 0x100000000;
    },
  });
  const deps = {
    session,
    tts: new TtsBridge({ backend: "none" }),
    stt: new SttBridge({}),
    recorder: new Recorder(),
    cleanup: () => rmSync(memDir, { recursive: true, force: true }),
  };
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      const initial = await ws.next((m) => m.type === "modeSet");
      assert.equal(initial.personality, "dry", "boot ack carries the seed");

      // Run a trigger — shuffle rolls the runtime overlay to a different
      // personality. The seed (and thus the next modeAck) must not change.
      await session.handleTrigger("EXPLICIT_ASK", { active_file: "a.ts" });
      assert.notEqual(
        session.getPersonality(),
        "dry",
        "shuffle must have rolled the runtime overlay"
      );
      assert.equal(
        session.getSeedPersonality(),
        "dry",
        "shuffle must NOT mutate the seed"
      );

      ws.send(JSON.stringify({ type: "getMode" }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(
        ack.personality,
        "dry",
        "WS modeAck must surface the seed, never the per-trigger shuffle roll"
      );
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
