// Task 12.6: TTS engine selector via BUDDY_TTS_BACKEND.
//
// Spec contract:
//   - "auto" + drill_sergeant → XTTS
//   - "auto" + nice           → Kokoro
//   - explicit "kokoro"       → Kokoro for ALL personalities (override)
//   - explicit "xtts"         → XTTS for ALL personalities (override)
//   - explicit "piper"/"none" → unchanged from prior behavior
//
// "auto" is the only mode that consults the active personality. Every
// other backend value is an explicit override that wins over the
// personality config.
//
// Run: node --test daemon/test/tts-selector.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");
const personalitiesDir = join(promptsDir, "personalities");

const { TtsBridge } = await import("../dist/tts-bridge.js");
const { parseTtsBackend } = await import("../dist/config.js");
const { loadPersonalityConfigs } = await import("../dist/personality-config.js");
const { loadPersonalities } = await import("../dist/personalities-loader.js");

function loadCfg(name) {
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  return loadPersonalityConfigs(personalitiesDir, personalities.keys()).get(name);
}

function stubFetch(calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

// --- parseTtsBackend ---------------------------------------------

test("12.6 parseTtsBackend accepts 'auto'", () => {
  assert.equal(parseTtsBackend("auto"), "auto");
});

test("12.6 parseTtsBackend still accepts kokoro/xtts/piper/none", () => {
  for (const v of ["kokoro", "xtts", "piper", "none"]) {
    assert.equal(parseTtsBackend(v), v);
  }
});

test("12.6 parseTtsBackend defaults empty/undefined to 'none' (back-compat)", () => {
  assert.equal(parseTtsBackend(""), "none");
  assert.equal(parseTtsBackend(undefined), "none");
});

test("12.6 parseTtsBackend rejects garbage", () => {
  assert.throws(() => parseTtsBackend("kokoroX"), /Unknown BUDDY_TTS_BACKEND/);
  assert.throws(() => parseTtsBackend("AUTO"), /Unknown BUDDY_TTS_BACKEND/); // case-sensitive
});

// --- effectiveEngine() — pure resolver ---------------------------

test("12.6 auto + drill_sergeant resolves to xtts", () => {
  const bridge = new TtsBridge({ backend: "auto" });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  assert.equal(bridge.effectiveEngine(), "xtts");
});

test("12.6 auto + nice resolves to kokoro", () => {
  const bridge = new TtsBridge({ backend: "auto" });
  bridge.setPersonalityVoiceConfig(loadCfg("nice"));
  assert.equal(bridge.effectiveEngine(), "kokoro");
});

test("12.6 auto + (no personality cfg) defaults to kokoro", () => {
  const bridge = new TtsBridge({ backend: "auto" });
  assert.equal(bridge.effectiveEngine(), "kokoro");
});

test("12.6 explicit kokoro overrides drill_sergeant (xtts personality)", () => {
  const bridge = new TtsBridge({ backend: "kokoro" });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  assert.equal(bridge.effectiveEngine(), "kokoro");
});

test("12.6 explicit xtts overrides nice (kokoro personality)", () => {
  const bridge = new TtsBridge({ backend: "xtts" });
  bridge.setPersonalityVoiceConfig(loadCfg("nice"));
  assert.equal(bridge.effectiveEngine(), "xtts");
});

test("12.6 explicit none overrides any personality (silent)", () => {
  const bridge = new TtsBridge({ backend: "none" });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  assert.equal(bridge.effectiveEngine(), "none");
});

test("12.6 explicit piper overrides any personality", () => {
  const bridge = new TtsBridge({ backend: "piper" });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  assert.equal(bridge.effectiveEngine(), "piper");
});

// --- routing actually fans out to the right URL ------------------

test("12.6 auto + drill_sergeant: speak() POSTs to XTTS", async () => {
  const calls = [];
  const bridge = new TtsBridge({ backend: "auto", fetchImpl: stubFetch(calls) });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  await bridge.speak("attention");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31417\/synth$/);
});

test("12.6 auto + nice: speak() POSTs to Kokoro", async () => {
  const calls = [];
  const bridge = new TtsBridge({ backend: "auto", fetchImpl: stubFetch(calls) });
  bridge.setPersonalityVoiceConfig(loadCfg("nice"));
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31416\/tts$/);
});

test("12.6 explicit kokoro + drill_sergeant: still POSTs to Kokoro", async () => {
  const calls = [];
  const bridge = new TtsBridge({ backend: "kokoro", fetchImpl: stubFetch(calls) });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  await bridge.speak("attention");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31416\/tts$/);
});

test("12.6 explicit none + drill_sergeant: speak is silent (no fetch)", async () => {
  const calls = [];
  const bridge = new TtsBridge({ backend: "none", fetchImpl: stubFetch(calls) });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  await bridge.speak("attention");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 0);
});

test("12.6 explicit xtts + xtts personality: POSTs to XTTS", async () => {
  // When the user picks BUDDY_TTS_BACKEND=xtts globally and the
  // active personality also carries an xtts_ref, the bridge routes
  // there and never falls back to Kokoro.
  const calls = [];
  const bridge = new TtsBridge({ backend: "xtts", fetchImpl: stubFetch(calls) });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  await bridge.speak("attention");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:31417\/synth$/);
  assert.equal(
    calls.filter((c) => c.url.includes(":31416")).length,
    0,
    "explicit xtts must not fall back to Kokoro"
  );
});

// --- describe() reflects the effective engine --------------------

test("12.6 describe() shows 'auto → kokoro' when auto resolves to kokoro", () => {
  const bridge = new TtsBridge({ backend: "auto" });
  bridge.setPersonalityVoiceConfig(loadCfg("nice"));
  assert.equal(bridge.describe(), "auto → kokoro");
});

test("12.6 describe() shows 'auto → xtts' when auto resolves to xtts", () => {
  const bridge = new TtsBridge({ backend: "auto" });
  bridge.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  assert.equal(bridge.describe(), "auto → xtts");
});

test("12.6 describe() unchanged for explicit backends", () => {
  // Explicit kokoro still describes as kokoro (with URL); explicit
  // none still describes as off. Sidebar/log strings stay
  // recognisable for users who didn't opt into auto.
  const k = new TtsBridge({ backend: "kokoro" });
  assert.match(k.describe(), /^kokoro \(/);

  const n = new TtsBridge({ backend: "none" });
  assert.equal(n.describe(), "off");
});
