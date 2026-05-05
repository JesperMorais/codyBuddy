// Tests for parseTtsBackend — the daemon must refuse to start with an
// unknown BUDDY_TTS_BACKEND value, and must accept exactly none|piper|kokoro.
// Run: node --test daemon/test/config.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { parseTtsBackend } = await import("../dist/config.js");

test("undefined returns the safe default 'none'", () => {
  assert.equal(parseTtsBackend(undefined), "none");
});

test("empty string returns the safe default 'none'", () => {
  assert.equal(parseTtsBackend(""), "none");
});

test("'none' is accepted", () => {
  assert.equal(parseTtsBackend("none"), "none");
});

test("'piper' is accepted", () => {
  assert.equal(parseTtsBackend("piper"), "piper");
});

test("'kokoro' is accepted", () => {
  assert.equal(parseTtsBackend("kokoro"), "kokoro");
});

test("an unknown value throws (daemon would exit on startup)", () => {
  assert.throws(
    () => parseTtsBackend("elevenlabs"),
    (err) =>
      err instanceof Error &&
      err.message.includes("BUDDY_TTS_BACKEND") &&
      err.message.includes("elevenlabs")
  );
});

test("a misspelling throws and lists allowed values", () => {
  assert.throws(
    () => parseTtsBackend("Piper"),
    (err) =>
      err instanceof Error &&
      err.message.includes("none") &&
      err.message.includes("piper") &&
      err.message.includes("kokoro")
  );
});
