// Task 12.2: Kokoro voice mapping per personality.
//
// Pinned contract: setPersonality("dry") results in TTS calls using
// the configured Kokoro voice (am_adam in the shipped config).
//
// Tests cover three layers so a regression in any of them surfaces
// independently:
//   (a) TtsBridge — speakViaKokoro sends `voice` in the request body
//       when one has been set; doesn't include it when unset.
//   (b) Server wiring — `setPersonality` over the WS protocol pushes
//       the configured voice into the bridge.
//   (c) Shipped configs — the spec mappings (nice → af_bella,
//       dry → am_adam, passive_aggressive → af_sarah) are what's on
//       disk.
//
// Run: node --test daemon/test/kokoro-voice-mapping.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");
const personalitiesDir = join(promptsDir, "personalities");

const { TtsBridge } = await import("../dist/tts-bridge.js");
const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { loadPromptDir, loadPersonalities } = await import(
  "../dist/personalities-loader.js"
);
const { loadPersonalityConfigs } = await import("../dist/personality-config.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

// --- (a) bridge unit tests ----------------------------------------

test("12.2 (a) bridge sends voice in body when setKokoroVoice has been called", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "kokoro", fetchImpl });
  bridge.setKokoroVoice("am_adam");
  await bridge.speak("hello");
  // Drain the queue.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.voice, "am_adam");
});

test("12.2 (a) bridge omits voice when none is set (sidecar default)", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "kokoro", fetchImpl });
  await bridge.speak("hello");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.voice, undefined);
});

test("12.2 (a) setKokoroVoice with empty/undefined clears the override", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "kokoro", fetchImpl });
  bridge.setKokoroVoice("am_adam");
  bridge.setKokoroVoice("");
  assert.equal(bridge.getKokoroVoice(), undefined);
  bridge.setKokoroVoice("af_bella");
  bridge.setKokoroVoice(undefined);
  assert.equal(bridge.getKokoroVoice(), undefined);
});

// --- (b) server wiring -------------------------------------------

async function bootDaemon(opts = {}) {
  const port = 31500 + Math.floor(Math.random() * 1000);
  const prompts = loadPromptDir(promptsDir);
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const configs = loadPersonalityConfigs(personalitiesDir, personalities.keys());
  const kokoroVoiceFor = new Map();
  for (const [name, cfg] of configs) {
    if (cfg.voice_engine === "kokoro" && cfg.kokoro_voice) {
      kokoroVoiceFor.set(name, cfg.kokoro_voice);
    }
  }

  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const tts = new TtsBridge({ backend: "kokoro", fetchImpl });
  // Use a temp dir for memory so we don't pollute ~/.coding-buddy.
  const memoryDir = mkdtempSync(join(tmpdir(), "buddy-12.2-mem-"));
  const memory = new MemoryStore(memoryDir);
  const fake = new FakeAnthropicClient({
    replies: [{ mode: "speak", text: "ok", wants_followup: false }],
    defaultDecision: "speak",
  });
  const session = new Session(fake, prompts, {
    personalities,
    defaultPersonality: opts.defaultPersonality ?? "nice",
    memory,
  });
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
    kokoroVoiceFor,
  });

  return { wss, port, tts, fetchCalls, kokoroVoiceFor };
}

// `ws` does NOT buffer incoming messages until a "message" listener is
// attached — we have to attach ours synchronously at construction time
// or we'll miss the boot-time modeAck/audioOwner frames.
function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws._inbox = [];
    ws._waiters = [];
    ws.on("message", (data) => {
      const obj = JSON.parse(data.toString());
      // Look for the first waiter whose predicate matches.
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
  // Drain any already-buffered messages first.
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

test("12.2 (b) initial Kokoro voice for the default personality is applied at boot", async () => {
  const { wss, tts, port } = await bootDaemon({ defaultPersonality: "dry" });
  try {
    // Bridge should have already received the voice for "dry" from
    // startServer's initial application.
    assert.equal(tts.getKokoroVoice(), "am_adam");
    // Open a connection so we can also see the server reflects "dry"
    // in modeAck.
    const ws = await openClient(port);
    const ack = await nextMessage(ws, (m) => m.type === "modeSet");
    assert.equal(ack.personality, "dry");
    ws.close();
  } finally {
    wss.close();
  }
});

test('12.2 (b) setPersonality("dry") via WS retargets the bridge to am_adam', async () => {
  const { wss, tts, port } = await bootDaemon({ defaultPersonality: "nice" });
  try {
    // After boot, the bridge is on nice → af_bella.
    assert.equal(tts.getKokoroVoice(), "af_bella");

    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet"); // initial
    ws.send(JSON.stringify({ type: "setPersonality", personality: "dry" }));
    const ack = await nextMessage(
      ws,
      (m) => m.type === "modeSet" && m.personality === "dry"
    );
    assert.equal(ack.ok, true);
    assert.equal(tts.getKokoroVoice(), "am_adam");

    ws.close();
  } finally {
    wss.close();
  }
});

test("12.2 (b) trigger after setPersonality emits Kokoro POST with the right voice", async () => {
  const { wss, tts, port, fetchCalls } = await bootDaemon({
    defaultPersonality: "nice",
  });
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "setPersonality", personality: "dry" }));
    await nextMessage(ws, (m) => m.type === "modeSet" && m.personality === "dry");

    ws.send(
      JSON.stringify({
        type: "trigger",
        trigger: "EXPLICIT_ASK",
        payload: { user_question: "hello?" },
      })
    );
    await nextMessage(ws, (m) => m.type === "reply");

    // The reply text "ok" went through TtsBridge.speak; queue drains
    // async. Wait briefly.
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(
      fetchCalls.length >= 1,
      `expected at least one Kokoro fetch, got ${fetchCalls.length}`
    );
    assert.equal(fetchCalls[fetchCalls.length - 1].body.voice, "am_adam");

    ws.close();
  } finally {
    wss.close();
  }
});

test("12.2 (b) failed setPersonality does NOT retarget the bridge", async () => {
  const { wss, tts, port } = await bootDaemon({ defaultPersonality: "nice" });
  try {
    assert.equal(tts.getKokoroVoice(), "af_bella");
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(
      JSON.stringify({ type: "setPersonality", personality: "does_not_exist" })
    );
    const ack = await nextMessage(
      ws,
      (m) => m.type === "modeSet" && typeof m.reason === "string"
    );
    assert.equal(ack.ok, false);
    assert.equal(tts.getKokoroVoice(), "af_bella", "bridge unchanged on rejection");
    ws.close();
  } finally {
    wss.close();
  }
});

// --- (c) shipped config snapshot ---------------------------------

test("12.2 (c) shipped Kokoro configs match the spec mappings", () => {
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const configs = loadPersonalityConfigs(personalitiesDir, personalities.keys());
  // The three personalities the spec named explicitly stay on Kokoro.
  assert.equal(configs.get("nice")?.kokoro_voice, "af_bella");
  assert.equal(configs.get("dry")?.kokoro_voice, "am_adam");
  assert.equal(configs.get("passive_aggressive")?.kokoro_voice, "af_sarah");
  // The remaining personalities (rude / drill_sergeant / pirate /
  // shakespearean) were flipped to xtts in Task 12.4 — they should
  // no longer carry a kokoro_voice at all.
  for (const name of ["rude", "drill_sergeant", "pirate", "shakespearean"]) {
    const cfg = configs.get(name);
    assert.equal(cfg?.voice_engine, "xtts", `${name} should be xtts`);
    assert.equal(
      cfg?.kokoro_voice,
      undefined,
      `${name} should NOT carry a kokoro_voice after 12.4`
    );
  }
});

test("12.2 (c) every shipped Kokoro personality has a non-empty voice id", () => {
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const configs = loadPersonalityConfigs(personalitiesDir, personalities.keys());
  for (const [name, cfg] of configs) {
    if (cfg.voice_engine !== "kokoro") continue;
    assert.ok(
      cfg.kokoro_voice && cfg.kokoro_voice.length > 0,
      `personality '${name}' is kokoro-engine but has no kokoro_voice`
    );
  }
});
