// Task 9.9 (WS layer): when setPersonality rejects a name that the
// loader marked as gated, the modeSet ack must carry the loader's
// reason verbatim so the sidebar can show *why* the switch failed
// rather than silently snapping the dropdown back.
//
// Run: node --test daemon/test/ws-nsfw.test.mjs

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

function buildAnthropicLikeDeps() {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
  ]);
  // Mimic loadPersonalities(promptsDir, "anthropic") output.
  const gatedPersonalities = new Map([
    ["nsfw", "personality 'nsfw' requires BUDDY_PROVIDER=ollama (current provider does not support uncensored output)"],
  ]);
  const memDir = mkdtempSync(join(tmpdir(), "buddy-9.9-ws-"));
  const memory = new MemoryStore(memDir);
  const session = new Session(fake, prompts, { memory, personalities });
  return {
    session,
    tts: new TtsBridge({ backend: "none" }),
    stt: new SttBridge({}),
    recorder: new Recorder(),
    gatedPersonalities,
    cleanup: () => rmSync(memDir, { recursive: true, force: true }),
  };
}

function buildOllamaLikeDeps() {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const personalities = new Map([
    ["nice", "nice overlay"],
    ["dry", "dry overlay"],
    ["nsfw", "nsfw overlay"],
  ]);
  const memDir = mkdtempSync(join(tmpdir(), "buddy-9.9-ws-"));
  const memory = new MemoryStore(memDir);
  const session = new Session(fake, prompts, { memory, personalities });
  return {
    session,
    tts: new TtsBridge({ backend: "none" }),
    stt: new SttBridge({}),
    recorder: new Recorder(),
    gatedPersonalities: new Map(),
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

test("9.9 (h) anthropic-like server: setPersonality('nsfw') acks ok:false with the gated reason", async () => {
  const deps = buildAnthropicLikeDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setPersonality", personality: "nsfw" }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.ok, false);
      assert.match(ack.reason, /BUDDY_PROVIDER=ollama/);
      assert.equal(ack.personality, "nice", "personality must remain unchanged");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.9 (i) ollama-like server: setPersonality('nsfw') acks ok:true with no reason", async () => {
  const deps = buildOllamaLikeDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setPersonality", personality: "nsfw" }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.ok, true);
      assert.equal(ack.personality, "nsfw");
      assert.equal(ack.reason, undefined, "ok:true acks must omit the reason field");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});

test("9.9 (j) unknown (non-gated) personality still rejects with a generic reason", async () => {
  const deps = buildAnthropicLikeDeps();
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  try {
    const ws = await openClient(wss.address().port);
    try {
      await ws.next((m) => m.type === "modeSet");
      ws.send(JSON.stringify({ type: "setPersonality", personality: "totally_made_up" }));
      const ack = await ws.next((m) => m.type === "modeSet");
      assert.equal(ack.ok, false);
      assert.match(ack.reason, /unknown personality/);
      assert.match(ack.reason, /totally_made_up/);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    deps.cleanup();
  }
});
