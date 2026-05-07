// Task 15.8: daemon-side audio device WS contract.
//
// Coverage:
//   (a) enumerateAudioDevices returns {input, output} arrays
//       (currently empty stubs — real per-OS enumeration is a
//       follow-up; the test pins the shape so the wiring works).
//   (b) WS getAudioDevices request → audioDevices response with
//       the right shape, requestId echoed back, error path
//       surfaces the failure message.
//
// Run: node --test daemon/test/audio-devices.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { enumerateAudioDevices } = await import("../dist/audio-devices.js");
const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { loadPromptDir, loadPersonalities } = await import(
  "../dist/personalities-loader.js"
);
const { FakeAnthropicClient } = await import("./fakes.mjs");

const promptsDir = join(__dirname, "..", "prompts");

// --- (a) module unit ---------------------------------------------

test("15.8 (a) enumerateAudioDevices returns {input,output} arrays", async () => {
  const list = await enumerateAudioDevices();
  assert.equal(typeof list, "object");
  assert.ok(Array.isArray(list.input));
  assert.ok(Array.isArray(list.output));
});

// --- (b) WS protocol --------------------------------------------

async function bootDaemon(opts = {}) {
  const port = 33800 + Math.floor(Math.random() * 1000);
  const prompts = loadPromptDir(promptsDir);
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const memDir = mkdtempSync(join(tmpdir(), "buddy-15.8-mem-"));
  const memory = new MemoryStore(memDir);
  const fake = new FakeAnthropicClient();
  const session = new Session(fake, prompts, {
    personalities,
    memory,
    defaultPersonality: "nice",
  });
  const tts = new TtsBridge({ backend: "none" });
  const stt = { transcribe: async () => "" };
  const recorder = {
    start: () => ({ ok: true }),
    stop: async () => ({ ok: true, wav: Buffer.alloc(0), durationMs: 0 }),
    isRecording: () => false,
    cancel: () => {},
  };
  const wss = startServer({
    session,
    tts,
    stt,
    recorder,
    port,
    audioDeviceProvider: opts.audioDeviceProvider,
  });
  return { wss, port };
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws._inbox = [];
    ws._waiters = [];
    ws.on("message", (data) => {
      const obj = JSON.parse(data.toString());
      for (let i = 0; i < ws._waiters.length; i++) {
        if (ws._waiters[i].predicate(obj)) {
          const w = ws._waiters.splice(i, 1)[0];
          w.resolve(obj);
          return;
        }
      }
      ws._inbox.push(obj);
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws, predicate = () => true) {
  for (let i = 0; i < ws._inbox.length; i++) {
    if (predicate(ws._inbox[i])) {
      return Promise.resolve(ws._inbox.splice(i, 1)[0]);
    }
  }
  return new Promise((resolve, reject) => {
    ws._waiters.push({ predicate, resolve });
    ws.once("error", reject);
  });
}

test("15.8 (b) WS getAudioDevices echoes requestId + returns provider list", async () => {
  const stubbed = {
    input: [
      { id: "mic-a", name: "Microphone A", isDefault: true },
      { id: "mic-b", name: "Microphone B" },
    ],
    output: [{ id: "spk-a", name: "Speakers A", isDefault: true }],
  };
  const { wss, port } = await bootDaemon({
    audioDeviceProvider: async () => stubbed,
  });
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "getAudioDevices", requestId: "rid-1" }));
    const reply = await nextMessage(ws, (m) => m.type === "audioDevices");
    assert.equal(reply.requestId, "rid-1");
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.input, stubbed.input);
    assert.deepEqual(reply.output, stubbed.output);
    ws.close();
  } finally {
    wss.close();
  }
});

test("15.8 (b) WS getAudioDevices surfaces provider error path", async () => {
  const { wss, port } = await bootDaemon({
    audioDeviceProvider: async () => {
      throw new Error("device probe failed");
    },
  });
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "getAudioDevices", requestId: "err-1" }));
    const reply = await nextMessage(ws, (m) => m.type === "audioDevices");
    assert.equal(reply.requestId, "err-1");
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /device probe failed/);
    ws.close();
  } finally {
    wss.close();
  }
});

test("15.8 (b) default provider returns empty arrays (no provider passed)", async () => {
  const { wss, port } = await bootDaemon({});
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "getAudioDevices", requestId: "def-1" }));
    const reply = await nextMessage(ws, (m) => m.type === "audioDevices");
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.input, []);
    assert.deepEqual(reply.output, []);
    ws.close();
  } finally {
    wss.close();
  }
});
