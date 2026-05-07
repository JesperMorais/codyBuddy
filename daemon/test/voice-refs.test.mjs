// Task 15.7: voice/refs/*.wav contract.
//
// Spec: "each shipped clip exists, is mono, 24kHz, valid WAV
//        (programmatic check via `wave` module)."
//
// Node has no `wave` stdlib (that's Python's). We implement the
// same checks by parsing the RIFF/WAVE header — every shipped
// file must declare PCM, mono, 24kHz, 16-bit; the data chunk size
// must imply >=5s of audio (the spec lower bound). 12.4's drift
// guard already validates four of the files; this test extends to
// nsfw and bumps the duration lower bound.
//
// Run: node --test daemon/test/voice-refs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refsDir = join(__dirname, "..", "..", "voice", "refs");

const SHIPPED = [
  "drill_sergeant",
  "pirate",
  "shakespearean",
  "rude",
  "nsfw",
];

const WAV_LOWER_BOUND_SECONDS = 5;

function parseWav(buf) {
  // RIFF/WAVE/fmt /data — minimum we need to assert format.
  if (buf.toString("ascii", 0, 4) !== "RIFF") return { error: "no RIFF tag" };
  if (buf.toString("ascii", 8, 12) !== "WAVE") return { error: "no WAVE tag" };
  if (buf.toString("ascii", 12, 16) !== "fmt ") return { error: "no fmt chunk" };
  const audioFormat = buf.readUInt16LE(20); // 1 = PCM
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  // Data chunk header at byte 36 (assuming standard 16-byte fmt).
  if (buf.toString("ascii", 36, 40) !== "data") {
    return { error: "data chunk not at byte 36 (non-standard fmt block)" };
  }
  const dataBytes = buf.readUInt32LE(40);
  const bytesPerSample = bitsPerSample / 8;
  const samples = dataBytes / (bytesPerSample * channels);
  const seconds = samples / sampleRate;
  return {
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    seconds,
  };
}

for (const name of SHIPPED) {
  test(`15.7 voice/refs/${name}.wav exists, is mono 24kHz Int16 PCM, >=5s`, () => {
    const path = join(refsDir, `${name}.wav`);
    assert.ok(existsSync(path), `missing ${path}`);
    const buf = readFileSync(path);
    const wav = parseWav(buf);
    assert.equal(wav.error, undefined, `parse error: ${wav.error}`);
    assert.equal(wav.audioFormat, 1, `${name}: not PCM`);
    assert.equal(wav.channels, 1, `${name}: not mono`);
    assert.equal(wav.sampleRate, 24000, `${name}: not 24kHz`);
    assert.equal(wav.bitsPerSample, 16, `${name}: not 16-bit`);
    assert.ok(
      wav.seconds >= WAV_LOWER_BOUND_SECONDS - 0.001,
      `${name}: ${wav.seconds.toFixed(2)}s, expected >=${WAV_LOWER_BOUND_SECONDS}s`
    );
  });
}

test("15.7 voice/refs/README.md ships attribution + Audacity recipe", () => {
  const path = join(refsDir, "README.md");
  assert.ok(existsSync(path), "voice/refs/README.md missing");
  const text = readFileSync(path, "utf8");
  // Attribution section
  assert.match(text, /attribution/i);
  // Audacity recipe with concrete steps
  assert.match(text, /Audacity recipe/i);
  // The recipe must mention 24000 Hz somewhere — the format
  // contract — and "Mono" — the channel count.
  assert.match(text, /24000\s*Hz|24\s*kHz/i);
  assert.match(text, /Mono/);
  // The five shipped files appear in a table.
  for (const name of SHIPPED) {
    assert.match(
      text,
      new RegExp(`${name}\\.wav`),
      `README missing entry for ${name}.wav`
    );
  }
});

test("15.7 nsfw clip is provider-gated in the README", () => {
  // The nsfw personality (Task 9.9) is BUDDY_PROVIDER=ollama only.
  // The clip itself is just audio — but the table must flag the
  // gate so users on Anthropic don't go hunting for it.
  const text = readFileSync(join(refsDir, "README.md"), "utf8");
  assert.match(
    text,
    /nsfw[\s\S]*?BUDDY_PROVIDER\s*=\s*ollama|ollama-only/i,
    "nsfw row in voice/refs/README.md should call out the ollama gate"
  );
});

test("15.7 every shipped clip parses cleanly (no truncated headers)", () => {
  // Defence-in-depth: parseWav should never fail for a shipped clip.
  for (const name of SHIPPED) {
    const buf = readFileSync(join(refsDir, `${name}.wav`));
    const wav = parseWav(buf);
    assert.equal(wav.error, undefined, `${name}: ${wav.error}`);
  }
});
