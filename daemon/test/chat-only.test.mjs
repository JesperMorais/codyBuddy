// Task 15.11: chat-only minimal install boot path.
//
// Spec: "with BUDDY_VOICE_LOOP=off, daemon boots and a chat
//        trigger round-trips successfully without any voice
//        sidecar running."
//
// Coverage:
//   (a) Index-level wiring: BUDDY_VOICE_LOOP=off short-circuits
//       even when BUDDY_VAD_SPAWN=true is set (no spawn attempt).
//   (b) End-to-end via startServer: a chat trigger
//       (`type:"trigger"`, `EXPLICIT_ASK`) round-trips a reply.
//       No voice sidecar is contacted (we bind no fetch stub at
//       the kokoro/xtts URLs and assert nothing is called).
//   (c) The sidebar's audioOwner ack reflects "webview" (TTS off).
//   (d) README documents the chat-only path with the spec'd flags.
//
// Run: node --test daemon/test/chat-only.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { loadPromptDir, loadPersonalities } = await import(
  "../dist/personalities-loader.js"
);
const { FakeAnthropicClient } = await import("./fakes.mjs");

const promptsDir = join(repoRoot, "daemon", "prompts");

// --- (a) index.ts wiring -----------------------------------------

test("15.11 (a) BUDDY_VOICE_LOOP=off short-circuits the voice spawn", () => {
  // The index.ts gate: only spawn when voiceLoop !== "off" AND
  // BUDDY_VAD_SPAWN === "true". Even with BUDDY_VAD_SPAWN=true,
  // setting BUDDY_VOICE_LOOP=off must skip the spawn.
  const text = readFileSync(
    join(repoRoot, "daemon", "src", "index.ts"),
    "utf8"
  );
  assert.match(text, /voiceLoop !== ["']off["']\s*&&/);
  assert.match(text, /BUDDY_VOICE_LOOP/);
});

// --- (b)+(c) end-to-end round-trip ------------------------------

async function bootChatOnly() {
  // Mimic what BUDDY_VOICE_LOOP=off + BUDDY_TTS_BACKEND=none
  // produces: a daemon with no TTS and no sidecar reach.
  const port = 34000 + Math.floor(Math.random() * 1000);
  const prompts = loadPromptDir(promptsDir);
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const memDir = mkdtempSync(join(tmpdir(), "buddy-15.11-mem-"));
  const memory = new MemoryStore(memDir);
  const fake = new FakeAnthropicClient({
    replies: [
      { mode: "chat", text: "chat-only reply", wants_followup: false },
    ],
  });
  const session = new Session(fake, prompts, {
    personalities,
    memory,
    defaultPersonality: "nice",
  });

  // The fetch trap: any call to a Kokoro / XTTS / voice URL is a
  // bug — chat-only must never try. Capture all fetch attempts.
  const fetchCalls = [];
  const trapFetch = async (url, init) => {
    fetchCalls.push(String(url));
    throw new Error(`unexpected fetch in chat-only: ${url}`);
  };

  const tts = new TtsBridge({ backend: "none", fetchImpl: trapFetch });

  const stt = { transcribe: async () => "" };
  const recorder = {
    start: () => ({ ok: true }),
    stop: async () => ({ ok: true, wav: Buffer.alloc(0), durationMs: 0 }),
    isRecording: () => false,
    cancel: () => {},
  };

  const wss = startServer({ session, tts, stt, recorder, port });
  return { wss, port, fetchCalls };
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

test("15.11 (b) chat trigger round-trips without any voice sidecar fetch", async () => {
  const { wss, port, fetchCalls } = await bootChatOnly();
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");

    ws.send(
      JSON.stringify({
        type: "trigger",
        trigger: "EXPLICIT_ASK",
        payload: { user_question: "explain this snippet" },
      })
    );
    const reply = await nextMessage(ws, (m) => m.type === "reply");
    assert.equal(reply.reply.mode, "chat");
    assert.equal(reply.reply.text, "chat-only reply");

    // Crucial: the fetch trap was never tripped. TTS=none means
    // the bridge skipped synth entirely.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      fetchCalls.length,
      0,
      `chat-only must not contact any voice URL, got: ${fetchCalls.join(", ")}`
    );
    ws.close();
  } finally {
    wss.close();
  }
});

test("15.11 (c) chat-only audioOwner ack reflects webview (TTS off)", async () => {
  const { wss, port } = await bootChatOnly();
  try {
    const ws = await openClient(port);
    const ack = await nextMessage(ws, (m) => m.type === "audioOwner");
    assert.equal(ack.owner, "webview", "TTS=none must hand audio to webview");
    assert.match(ack.backend, /off/i);
    ws.close();
  } finally {
    wss.close();
  }
});

// --- (d) README documents the path ------------------------------

test("15.11 (d) README has a chat-only callout linking to the minimal section", () => {
  const text = readFileSync(join(repoRoot, "README.md"), "utf8");
  assert.match(text, /Just want chat\?/);
  // The heading uses an em-dash; tolerant match for any dash-like char.
  assert.match(text, /Minimal install\s*[-—–]+\s*chat only/i);
});

test("15.11 (d) README minimal section names BUDDY_VOICE_LOOP=off + BUDDY_TTS_BACKEND=none", () => {
  const text = readFileSync(join(repoRoot, "README.md"), "utf8");
  // The two required env values from the spec.
  assert.match(text, /BUDDY_VOICE_LOOP=off/);
  assert.match(text, /BUDDY_TTS_BACKEND=none/);
  // The setup-script invocation form for both OS families.
  assert.match(text, /setup\.ps1\s+-SkipVoice/);
  assert.match(text, /setup\.sh\s+--skip-voice/);
});

test("15.11 (d) .env.example documents BUDDY_VOICE_LOOP", () => {
  const text = readFileSync(join(repoRoot, ".env.example"), "utf8");
  assert.match(text, /BUDDY_VOICE_LOOP=auto/);
  assert.match(text, /chat-only install/i);
});
