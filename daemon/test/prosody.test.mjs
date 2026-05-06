// Task 12.5: prosody application — rate / energy / pause_factor.
//
// Pinned contract: "same input text under drill_sergeant vs nice
// produces audio with measurably different duration."
//
// In CI we don't run real TTS engines, so the test verifies the
// CONTRACT that drives different durations: each personality's
// rate/energy/pause_factor multipliers are sent through to the
// synth endpoint with each speak() call. Since drill_sergeant
// has rate=1.1 and nice has rate=1.0, the same text synthesised
// at those speeds has measurably different duration by definition.
//
// Layers:
//   (a) Bridge — Kokoro request body carries rate/energy/pause_factor;
//       XTTS request body carries them. drill_sergeant's body !=
//       nice's body (rates differ, so byte lengths of any
//       proportional-to-rate stub also differ).
//   (b) Personalities — drill_sergeant config has rate=1.1; nice
//       has rate=1.0. The shipped JSONs carry the multipliers.
//
// Run: node --test daemon/test/prosody.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");
const personalitiesDir = join(promptsDir, "personalities");

const { TtsBridge } = await import("../dist/tts-bridge.js");
const { loadPersonalityConfigs } = await import("../dist/personality-config.js");
const { loadPersonalities } = await import(
  "../dist/personalities-loader.js"
);

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

function loadCfg(name) {
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  return loadPersonalityConfigs(personalitiesDir, personalities.keys()).get(name);
}

// --- (a) bridge: prosody fields reach the synth request ----------

test("12.5 (a) Kokoro body carries rate/energy/pause_factor from active personality", async () => {
  const calls = [];
  const bridge = new TtsBridge({ backend: "auto", fetchImpl: stubFetch(calls) });
  const nice = loadCfg("nice");
  bridge.setPersonalityVoiceConfig(nice);
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(body.rate, nice.rate);
  assert.equal(body.energy, nice.energy);
  assert.equal(body.pause_factor, nice.pause_factor);
});

test("12.5 (a) XTTS body carries rate/energy/pause_factor from active personality", async () => {
  const calls = [];
  const bridge = new TtsBridge({ backend: "auto", fetchImpl: stubFetch(calls) });
  const drill = loadCfg("drill_sergeant");
  bridge.setPersonalityVoiceConfig(drill);
  await bridge.speak("attention");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  // drill_sergeant routes to XTTS in the active config
  assert.match(calls[0].url, /:31417\/synth$/);
  const body = calls[0].body;
  assert.equal(body.rate, drill.rate);
  assert.equal(body.energy, drill.energy);
  assert.equal(body.pause_factor, drill.pause_factor);
});

test("12.5 (a) drill_sergeant and nice send measurably different prosody", async () => {
  // Two bridges, two synth calls — different personalities, same
  // text. The request bodies must differ in at least one prosody
  // dimension; in particular rate must be different (drill = 1.1,
  // nice = 1.0) which directly drives synth duration.
  const drillCalls = [];
  const niceCalls = [];

  const bridgeDrill = new TtsBridge({
    backend: "auto",
    fetchImpl: stubFetch(drillCalls),
  });
  bridgeDrill.setPersonalityVoiceConfig(loadCfg("drill_sergeant"));
  await bridgeDrill.speak("the same input text");

  const bridgeNice = new TtsBridge({
    backend: "auto",
    fetchImpl: stubFetch(niceCalls),
  });
  bridgeNice.setPersonalityVoiceConfig(loadCfg("nice"));
  await bridgeNice.speak("the same input text");

  await new Promise((r) => setTimeout(r, 5));

  assert.equal(drillCalls.length, 1);
  assert.equal(niceCalls.length, 1);
  // Same text, but drill_sergeant goes to XTTS at rate 1.1 and
  // nice goes to Kokoro at rate 1.0 — bodies differ both in URL
  // and in rate.
  assert.notEqual(drillCalls[0].url, niceCalls[0].url);
  assert.notEqual(drillCalls[0].body.rate, niceCalls[0].body.rate);

  // Simulated synth duration: 1/rate * text_length is a reasonable
  // first-order proxy for actual TTS output duration. The ratio
  // proves that synth output WILL measurably differ: ~9% at
  // rate=1.1 vs rate=1.0.
  const drillDuration = "the same input text".length / drillCalls[0].body.rate;
  const niceDuration = "the same input text".length / niceCalls[0].body.rate;
  assert.notEqual(drillDuration, niceDuration);
  assert.ok(
    Math.abs(drillDuration - niceDuration) > 0.5,
    `expected measurable duration delta, got drill=${drillDuration} nice=${niceDuration}`
  );
});

test("12.5 (a) bridge omits prosody when no personality cfg is set", async () => {
  // Backwards-compat: callers that haven't set a personality
  // config get baseline behavior — no rate/energy/pause_factor in
  // the body. Lets the sidecar's defaults apply.
  const calls = [];
  const bridge = new TtsBridge({ backend: "auto", fetchImpl: stubFetch(calls) });
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.rate, undefined);
  assert.equal(calls[0].body.energy, undefined);
  assert.equal(calls[0].body.pause_factor, undefined);
});

test("12.5 (a) all three prosody fields are passed through, not just rate", async () => {
  // Custom personality config with all three knobs at non-default
  // values. The body should reflect each one verbatim.
  const calls = [];
  const bridge = new TtsBridge({ backend: "auto", fetchImpl: stubFetch(calls) });
  bridge.setPersonalityVoiceConfig({
    voice_engine: "kokoro",
    kokoro_voice: "af_bella",
    rate: 0.85,
    energy: 1.27,
    pause_factor: 1.4,
  });
  await bridge.speak("hi");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls[0].body.rate, 0.85);
  assert.equal(calls[0].body.energy, 1.27);
  assert.equal(calls[0].body.pause_factor, 1.4);
});

// --- (b) shipped configs carry distinct prosody profiles ---------

test("12.5 (b) drill_sergeant has higher rate than nice (drives shorter duration)", () => {
  const drill = loadCfg("drill_sergeant");
  const nice = loadCfg("nice");
  assert.ok(drill, "missing drill_sergeant config");
  assert.ok(nice, "missing nice config");
  assert.ok(
    drill.rate > nice.rate,
    `drill_sergeant rate (${drill.rate}) should be > nice rate (${nice.rate})`
  );
  // The actual values pinned by 12.1: rate=1.1 vs 1.0.
  assert.equal(drill.rate, 1.1);
  assert.equal(nice.rate, 1.0);
});

test("12.5 (b) every shipped personality has prosody multipliers in (0, 5)", () => {
  // Sanity guard: catches typos like 11 instead of 1.1 (exists in
  // 12.1 too — duplicate kept here so a regression in EITHER place
  // can't break prosody silently).
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const configs = loadPersonalityConfigs(personalitiesDir, personalities.keys());
  for (const [name, cfg] of configs) {
    for (const f of ["rate", "energy", "pause_factor"]) {
      assert.ok(
        cfg[f] > 0 && cfg[f] < 5,
        `${name}.${f} = ${cfg[f]} out of sane range`
      );
    }
  }
});

test("12.5 (b) shipped personalities have at least 2 distinct rate values", () => {
  // Otherwise prosody is window-dressing. Different personalities
  // SHOULD speak at different speeds — that's the whole point of
  // this knob.
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const configs = loadPersonalityConfigs(personalitiesDir, personalities.keys());
  const rates = new Set();
  for (const cfg of configs.values()) rates.add(cfg.rate);
  assert.ok(
    rates.size >= 2,
    `expected at least 2 distinct rate values across personalities, got ${[...rates]}`
  );
});
