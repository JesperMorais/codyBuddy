// Task 12.4: XTTS routing per personality.
//
// Pinned contract: setPersonality("drill_sergeant") routes synth
// requests to XTTS with the correct ref clip.
//
// Three layers, same shape as 12.2:
//   (a) Bridge — speakNow dispatches to XTTS when the active
//       personality config has voice_engine="xtts" + xtts_ref;
//       falls through to the constructor backend otherwise. The
//       request body carries the ref clip and language.
//   (b) Server wiring — setPersonality with an xtts personality
//       pushes the config into the bridge so the next speak call
//       hits the XTTS endpoint.
//   (c) Shipped configs — drill_sergeant / pirate / shakespearean /
//       rude all have voice_engine="xtts" with xtts_ref pointing
//       at refs/<name>.wav, and the WAV files actually exist.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");
const personalitiesDir = join(promptsDir, "personalities");
const voiceRefsDir = join(__dirname, "..", "..", "voice", "refs");

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

test("12.4 (a) bridge routes to XTTS when personality cfg has voice_engine=xtts + xtts_ref", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const bridge = new TtsBridge({ backend: "auto", fetchImpl });
  bridge.setPersonalityVoiceConfig({
    voice_engine: "xtts",
    xtts_ref: "refs/drill_sergeant.wav",
    rate: 1.0,
    energy: 1.0,
    pause_factor: 1.0,
  });
  assert.equal(bridge.effectiveEngine(), "xtts");
  await bridge.speak("attention!");
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31417\/synth$/);
  assert.equal(calls[0].body.ref_clip, "refs/drill_sergeant.wav");
  assert.equal(calls[0].body.language, "en");
  assert.equal(typeof calls[0].body.text, "string");
});

test("12.4 (a) bridge stays on Kokoro when personality cfg is voice_engine=kokoro", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "auto", fetchImpl });
  bridge.setPersonalityVoiceConfig({
    voice_engine: "kokoro",
    kokoro_voice: "af_bella",
    rate: 1.0,
    energy: 1.0,
    pause_factor: 1.0,
  });
  assert.equal(bridge.effectiveEngine(), "kokoro");
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.length, 1);
  // Kokoro endpoint, not XTTS.
  assert.match(calls[0].url, /:31416\/tts$/);
});

test("12.4 (a) bridge routes Kokoro when no personality cfg has been set", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "auto", fetchImpl });
  // No setPersonalityVoiceConfig — fall through to backend.
  assert.equal(bridge.effectiveEngine(), "kokoro");
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31416\/tts$/);
});

test("12.4 (a) bridge falls through to backend when xtts cfg is missing xtts_ref", async () => {
  // An xtts engine without a ref clip is degenerate — the bridge
  // should NOT route there (would fail downstream with no clip), it
  // should fall through to the constructor backend.
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "auto", fetchImpl });
  bridge.setPersonalityVoiceConfig({
    voice_engine: "xtts",
    rate: 1.0,
    energy: 1.0,
    pause_factor: 1.0,
  });
  assert.equal(bridge.effectiveEngine(), "kokoro");
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31416\/tts$/);
});

test("12.4 (a) custom xttsUrl + xttsLanguage are honoured", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const bridge = new TtsBridge({
    backend: "auto",
    fetchImpl,
    xttsUrl: "http://10.0.0.1:9999/synth",
    xttsLanguage: "fr",
  });
  bridge.setPersonalityVoiceConfig({
    voice_engine: "xtts",
    xtts_ref: "refs/pirate.wav",
    rate: 1.0,
    energy: 1.0,
    pause_factor: 1.0,
  });
  await bridge.speak("ahoy");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://10.0.0.1:9999/synth");
  assert.equal(calls[0].body.language, "fr");
  assert.equal(calls[0].body.ref_clip, "refs/pirate.wav");
});

// --- (b) server wiring -------------------------------------------

async function bootDaemon(opts = {}) {
  const port = 32500 + Math.floor(Math.random() * 1000);
  const prompts = loadPromptDir(promptsDir);
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const personalityConfigs = loadPersonalityConfigs(
    personalitiesDir,
    personalities.keys()
  );
  const kokoroVoiceFor = new Map();
  for (const [name, cfg] of personalityConfigs) {
    if (cfg.voice_engine === "kokoro" && cfg.kokoro_voice) {
      kokoroVoiceFor.set(name, cfg.kokoro_voice);
    }
  }

  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const tts = new TtsBridge({ backend: "auto", fetchImpl });
  const memDir = mkdtempSync(join(tmpdir(), "buddy-12.4-mem-"));
  const memory = new MemoryStore(memDir);
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
    personalityVoiceConfigs: personalityConfigs,
  });

  return { wss, port, tts, fetchCalls };
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

test('12.4 (b) setPersonality("drill_sergeant") routes synth to XTTS with the right ref', async () => {
  const { wss, tts, port, fetchCalls } = await bootDaemon({
    defaultPersonality: "nice",
  });
  try {
    // Initial: "nice" → kokoro engine.
    assert.equal(tts.effectiveEngine(), "kokoro");

    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");

    // Switch to drill_sergeant — an xtts personality.
    ws.send(
      JSON.stringify({ type: "setPersonality", personality: "drill_sergeant" })
    );
    const ack = await nextMessage(
      ws,
      (m) => m.type === "modeSet" && m.personality === "drill_sergeant"
    );
    assert.equal(ack.ok, true);
    assert.equal(tts.effectiveEngine(), "xtts");

    // Now trigger a reply; the spoken text should fan out via XTTS.
    ws.send(
      JSON.stringify({
        type: "trigger",
        trigger: "EXPLICIT_ASK",
        payload: { user_question: "report sergeant" },
      })
    );
    await nextMessage(ws, (m) => m.type === "reply");
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(fetchCalls.length >= 1, "expected at least one synth fetch");
    const last = fetchCalls[fetchCalls.length - 1];
    assert.match(last.url, /:31417\/synth$/);
    assert.equal(last.body.ref_clip, "refs/drill_sergeant.wav");

    ws.close();
  } finally {
    wss.close();
  }
});

test("12.4 (b) initial xtts personality at boot already routes to XTTS", async () => {
  const { wss, tts } = await bootDaemon({ defaultPersonality: "pirate" });
  try {
    assert.equal(tts.effectiveEngine(), "xtts");
    assert.equal(
      tts.getPersonalityVoiceConfig()?.xtts_ref,
      "refs/pirate.wav"
    );
  } finally {
    wss.close();
  }
});

test("12.4 (b) switching back from xtts to kokoro personality reverts routing", async () => {
  const { wss, tts, port } = await bootDaemon({
    defaultPersonality: "drill_sergeant",
  });
  try {
    assert.equal(tts.effectiveEngine(), "xtts");
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "setPersonality", personality: "nice" }));
    await nextMessage(
      ws,
      (m) => m.type === "modeSet" && m.personality === "nice"
    );
    assert.equal(tts.effectiveEngine(), "kokoro");
    ws.close();
  } finally {
    wss.close();
  }
});

// --- (c) shipped data --------------------------------------------

test("12.4 (c) drill_sergeant / pirate / shakespearean / rude flipped to xtts", () => {
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const configs = loadPersonalityConfigs(personalitiesDir, personalities.keys());
  for (const name of ["drill_sergeant", "pirate", "shakespearean", "rude"]) {
    const cfg = configs.get(name);
    assert.ok(cfg, `missing config for ${name}`);
    assert.equal(cfg.voice_engine, "xtts", `${name} should be xtts`);
    assert.equal(
      cfg.xtts_ref,
      `refs/${name}.wav`,
      `${name} xtts_ref should point at refs/${name}.wav`
    );
  }
});

test("12.4 (c) every shipped xtts personality has its ref WAV on disk", () => {
  for (const name of ["drill_sergeant", "pirate", "shakespearean", "rude"]) {
    const path = join(voiceRefsDir, `${name}.wav`);
    assert.ok(existsSync(path), `missing ref clip: ${path}`);
  }
});

test("12.4 (c) shipped ref WAVs are valid RIFF/WAVE 24kHz mono Int16 PCM", () => {
  // Validate the placeholder header so a future test that depends on
  // the audio shape (e.g. XTTS smoke) doesn't trip on a corrupt file.
  for (const name of ["drill_sergeant", "pirate", "shakespearean", "rude"]) {
    const path = join(voiceRefsDir, `${name}.wav`);
    const buf = readFileSync(path);
    assert.equal(buf.toString("ascii", 0, 4), "RIFF", `${name}: bad RIFF tag`);
    assert.equal(buf.toString("ascii", 8, 12), "WAVE", `${name}: bad WAVE tag`);
    assert.equal(buf.toString("ascii", 12, 16), "fmt ", `${name}: bad fmt tag`);
    assert.equal(buf.readUInt16LE(20), 1, `${name}: not PCM`);
    assert.equal(buf.readUInt16LE(22), 1, `${name}: not mono`);
    assert.equal(buf.readUInt32LE(24), 24000, `${name}: not 24kHz`);
    assert.equal(buf.readUInt16LE(34), 16, `${name}: not 16-bit`);
  }
});

test("12.4 (c) voice/refs/README.md exists with placeholder explanation", () => {
  const path = join(voiceRefsDir, "README.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf8");
  assert.match(content, /placeholder/i);
  assert.match(content, /5-7\s*seconds/i);
});

test("12.4 (c) parseTtsBackend now accepts 'xtts'", async () => {
  const { parseTtsBackend } = await import("../dist/config.js");
  assert.equal(parseTtsBackend("xtts"), "xtts");
});
