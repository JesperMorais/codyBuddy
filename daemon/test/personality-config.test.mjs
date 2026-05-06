// Task 12.1: personality voice-config loader tests.
//
// Two pinned assertions per the spec:
//   - Each shipped personality has a valid config.
//   - Loader rejects unknown engines.
// Plus schema-violation tests for the rest of the contract.
//
// Run: node --test daemon/test/personality-config.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const personalitiesDir = join(__dirname, "..", "prompts", "personalities");

const {
  parsePersonalityConfig,
  loadPersonalityConfigs,
  VOICE_ENGINES,
} = await import("../dist/personality-config.js");

function shippedPersonalityNames() {
  // Source of truth: every .md file under prompts/personalities/.
  return readdirSync(personalitiesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "buddy-12.1-"));
}

test("12.1 every shipped personality has a valid config", () => {
  const names = shippedPersonalityNames();
  assert.ok(names.length > 0, "expected at least one shipped personality");

  // Each .md must have a sibling .json that loads cleanly.
  const configs = loadPersonalityConfigs(personalitiesDir, names);
  assert.equal(configs.size, names.length);

  for (const name of names) {
    const cfg = configs.get(name);
    assert.ok(cfg, `missing config for personality '${name}'`);
    assert.ok(
      VOICE_ENGINES.includes(cfg.voice_engine),
      `personality '${name}' has invalid engine ${cfg.voice_engine}`
    );
    assert.equal(typeof cfg.rate, "number");
    assert.equal(typeof cfg.energy, "number");
    assert.equal(typeof cfg.pause_factor, "number");
    assert.ok(Number.isFinite(cfg.rate));
    assert.ok(Number.isFinite(cfg.energy));
    assert.ok(Number.isFinite(cfg.pause_factor));
  }
});

test("12.1 loader rejects unknown engine", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "weird.json"),
    JSON.stringify({
      voice_engine: "robovox",
      rate: 1.0,
      energy: 1.0,
      pause_factor: 1.0,
    })
  );
  // Also need a .md, but the loader only reads .json files for a
  // given list of names — so we just pass the name in.
  assert.throws(
    () => loadPersonalityConfigs(dir, ["weird"]),
    /unknown voice_engine/i
  );
});

test("12.1 parsePersonalityConfig rejects unknown engine", () => {
  assert.throws(
    () =>
      parsePersonalityConfig(
        { voice_engine: "robovox", rate: 1, energy: 1, pause_factor: 1 },
        "weird"
      ),
    /unknown voice_engine/i
  );
});

test("12.1 parsePersonalityConfig rejects missing voice_engine", () => {
  assert.throws(
    () =>
      parsePersonalityConfig(
        { rate: 1, energy: 1, pause_factor: 1 },
        "weird"
      ),
    /unknown voice_engine/i
  );
});

test("12.1 parsePersonalityConfig rejects missing numeric fields", () => {
  for (const field of ["rate", "energy", "pause_factor"]) {
    const cfg = {
      voice_engine: "kokoro",
      rate: 1,
      energy: 1,
      pause_factor: 1,
    };
    delete cfg[field];
    assert.throws(
      () => parsePersonalityConfig(cfg, "weird"),
      new RegExp(`${field} must be a finite number`)
    );
  }
});

test("12.1 parsePersonalityConfig rejects non-finite numbers (NaN, Infinity)", () => {
  const base = {
    voice_engine: "kokoro",
    rate: 1,
    energy: 1,
    pause_factor: 1,
  };
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => parsePersonalityConfig({ ...base, rate: value }, "weird"),
      /rate must be a finite number/
    );
  }
});

test("12.1 parsePersonalityConfig rejects non-object input", () => {
  for (const bad of [null, "string", 42, [], true]) {
    assert.throws(
      () => parsePersonalityConfig(bad, "weird"),
      /config must be a JSON object/
    );
  }
});

test("12.1 loader throws on missing config file with the path in the error", () => {
  const dir = tempDir();
  assert.throws(
    () => loadPersonalityConfigs(dir, ["missing"]),
    /missing at .*missing\.json/i
  );
});

test("12.1 loader throws on malformed JSON", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "broken.json"), "{not json,,,");
  assert.throws(
    () => loadPersonalityConfigs(dir, ["broken"]),
    /invalid JSON/i
  );
});

test("12.1 loader optional fields (kokoro_voice / xtts_ref) round-trip when present", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "withvoice.json"),
    JSON.stringify({
      voice_engine: "kokoro",
      kokoro_voice: "af_bella",
      rate: 1.0,
      energy: 1.0,
      pause_factor: 1.0,
    })
  );
  writeFileSync(
    join(dir, "withref.json"),
    JSON.stringify({
      voice_engine: "xtts",
      xtts_ref: "voice/refs/example.wav",
      rate: 1.0,
      energy: 1.0,
      pause_factor: 1.0,
    })
  );
  const configs = loadPersonalityConfigs(dir, ["withvoice", "withref"]);
  assert.equal(configs.get("withvoice")?.kokoro_voice, "af_bella");
  assert.equal(configs.get("withref")?.xtts_ref, "voice/refs/example.wav");
});

test("12.1 each shipped JSON parses to numeric fields in a sane range", () => {
  // Smoke-check: rate / energy / pause_factor multipliers should be
  // positive and within an order of magnitude of 1.0. Catches typos
  // like 11 instead of 1.1.
  const names = shippedPersonalityNames();
  const configs = loadPersonalityConfigs(personalitiesDir, names);
  for (const [name, cfg] of configs) {
    for (const f of ["rate", "energy", "pause_factor"]) {
      const v = cfg[f];
      assert.ok(v > 0, `${name}.${f} must be > 0 (got ${v})`);
      assert.ok(v < 5, `${name}.${f} suspiciously large (got ${v})`);
    }
  }
});

test("12.1 each shipped JSON file has matching .md sibling and vice versa", () => {
  const names = readdirSync(personalitiesDir);
  const md = new Set(
    names.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
  );
  const json = new Set(
    names.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  );
  for (const m of md) {
    assert.ok(json.has(m), `personality '${m}' has .md but no .json`);
  }
  for (const j of json) {
    assert.ok(md.has(j), `personality '${j}' has .json but no .md`);
  }
});

test("12.1 every shipped JSON is itself valid JSON (no trailing commas etc.)", () => {
  for (const f of readdirSync(personalitiesDir)) {
    if (!f.endsWith(".json")) continue;
    const raw = readFileSync(join(personalitiesDir, f), "utf8");
    assert.doesNotThrow(
      () => JSON.parse(raw),
      `${f}: not valid JSON`
    );
  }
});
