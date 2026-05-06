// Task 4.3: token-cost telemetry. Append one JSON line to
// ~/.coding-buddy/telemetry.jsonl per Anthropic API response.
//
// This file covers both halves of the contract:
//   - Telemetry sink itself: record() appends, read() round-trips, missing
//     usage fields default to 0.
//   - Per-turn end-to-end: a Session.handleTrigger() that goes through the
//     gate AND ask appends two lines (one per API call). A no_op-gated turn
//     appends only the gate line.
//
// Run: node --test daemon/test/telemetry.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Telemetry } = await import("../dist/telemetry.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-tel-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------
// Telemetry sink
// --------------------------------------------------------------------------

test("4.3 (a) Telemetry.record appends one JSON line per call", () => {
  const { dir, cleanup } = freshTempDir();
  const filePath = join(dir, "telemetry.jsonl");
  try {
    const tel = new Telemetry(filePath);
    tel.record("ask", "claude-sonnet-4-6", {
      input_tokens: 200,
      output_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 600,
    });

    assert.ok(existsSync(filePath));
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.method, "ask");
    assert.equal(entry.model, "claude-sonnet-4-6");
    assert.equal(entry.input_tokens, 200);
    assert.equal(entry.output_tokens, 100);
    assert.equal(entry.cache_read_input_tokens, 50);
    assert.equal(entry.cache_creation_input_tokens, 600);
    assert.equal(typeof entry.ts, "number");
    assert.ok(entry.ts > 0);
  } finally {
    cleanup();
  }
});

test("4.3 (b) missing usage fields default to 0", () => {
  const { dir, cleanup } = freshTempDir();
  const filePath = join(dir, "telemetry.jsonl");
  try {
    const tel = new Telemetry(filePath);
    tel.record("shouldSpeak", "haiku", {});
    const entry = tel.read()[0];
    assert.equal(entry.input_tokens, 0);
    assert.equal(entry.output_tokens, 0);
    assert.equal(entry.cache_read_input_tokens, 0);
    assert.equal(entry.cache_creation_input_tokens, 0);
  } finally {
    cleanup();
  }
});

test("4.3 (c) multiple records accumulate in order; read() round-trips", () => {
  const { dir, cleanup } = freshTempDir();
  const filePath = join(dir, "telemetry.jsonl");
  try {
    const tel = new Telemetry(filePath);
    tel.record("a", "m1", { input_tokens: 1 });
    tel.record("b", "m2", { input_tokens: 2 });
    tel.record("c", "m3", { input_tokens: 3 });

    const entries = tel.read();
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => [e.method, e.model, e.input_tokens]),
      [["a", "m1", 1], ["b", "m2", 2], ["c", "m3", 3]]
    );
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Per-turn integration via Session + FakeAnthropicClient + Telemetry
// --------------------------------------------------------------------------

test("4.3 (d) per-turn: gate + ask each append a line (2 entries)", async () => {
  const { dir, cleanup } = freshTempDir();
  const filePath = join(dir, "telemetry.jsonl");
  try {
    const tel = new Telemetry(filePath);
    const fake = new FakeAnthropicClient({
      decisions: ["speak"],
      replies: [{ mode: "speak", text: "ok", wants_followup: false }],
      telemetry: tel,
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, prompts, { memory });

    await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });

    const entries = tel.read();
    assert.equal(entries.length, 2, "one gate record + one ask record per turn");
    assert.equal(entries[0].method, "shouldSpeak");
    assert.equal(entries[0].model, "claude-haiku-4-5-20251001");
    assert.equal(entries[1].method, "ask");
    assert.equal(entries[1].model, "claude-sonnet-4-6");
  } finally {
    cleanup();
  }
});

test("4.3 (e) per-turn: gate=no_op writes only the gate line (Sonnet skipped)", async () => {
  const { dir, cleanup } = freshTempDir();
  const filePath = join(dir, "telemetry.jsonl");
  try {
    const tel = new Telemetry(filePath);
    const fake = new FakeAnthropicClient({
      decisions: ["no_op"],
      telemetry: tel,
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, prompts, { memory });

    await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });

    const entries = tel.read();
    assert.equal(entries.length, 1, "no_op gate must skip the ask record");
    assert.equal(entries[0].method, "shouldSpeak");
  } finally {
    cleanup();
  }
});

test("4.3 (f) per-turn: EXPLICIT_ASK writes only the ask line (gate skipped)", async () => {
  const { dir, cleanup } = freshTempDir();
  const filePath = join(dir, "telemetry.jsonl");
  try {
    const tel = new Telemetry(filePath);
    const fake = new FakeAnthropicClient({
      replies: [{ mode: "chat", text: "answer", wants_followup: false }],
      telemetry: tel,
    });
    const memory = new MemoryStore(dir);
    const session = new Session(fake, prompts, { memory });

    await session.handleTrigger("EXPLICIT_ASK", { user_question: "why?" });

    const entries = tel.read();
    assert.equal(entries.length, 1, "EXPLICIT_ASK bypasses gate; only ask records");
    assert.equal(entries[0].method, "ask");
  } finally {
    cleanup();
  }
});

test("4.3 (g) DEFAULT_TELEMETRY_PATH lives under the home dir", async () => {
  const { DEFAULT_TELEMETRY_PATH } = await import("../dist/telemetry.js");
  assert.match(DEFAULT_TELEMETRY_PATH, /telemetry\.jsonl$/);
  assert.match(DEFAULT_TELEMETRY_PATH, /[\\/]\.coding-buddy[\\/]/);
});
