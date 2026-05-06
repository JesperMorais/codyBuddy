// Task 7.1: Screenpipe MCP integration.
//
// Coverage:
//   - HttpScreenpipeClient builds the right URL with the right time range
//     and returns the OCR text array.
//   - summarizeOcr clamps entries and characters as documented.
//   - Session injects `screen_context` on EXPLICIT_ASK with empty
//     recent_diff and a Screenpipe client present.
//   - Session does NOT call Screenpipe on non-EXPLICIT_ASK triggers.
//   - Session does NOT call Screenpipe when recent_diff is non-empty.
//   - Session degrades gracefully when Screenpipe throws (still calls ask
//     with the original payload, no screen_context).
//
// Run: node --test daemon/test/screenpipe.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { HttpScreenpipeClient, summarizeOcr } = await import("../dist/screenpipe.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function freshSession(fake, screenpipe) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-7.1-"));
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, { memory, screenpipe });
  return { session, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------
// HttpScreenpipeClient
// --------------------------------------------------------------------------

test("7.1 (a) HttpScreenpipeClient builds /search?content_type=ocr URL", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          { content: { text: "hello world", app_name: "chrome", timestamp: "2026-05-06T00:00:00Z" } },
          { content: { text: "another snippet", app_name: "slack" } },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const client = new HttpScreenpipeClient({ baseUrl: "http://127.0.0.1:3030", fetchImpl: fakeFetch });
  const entries = await client.queryRecent(120);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^http:\/\/127\.0\.0\.1:3030\/search\?/);
  assert.match(calls[0], /content_type=ocr/);
  assert.match(calls[0], /start_time=/);
  assert.match(calls[0], /end_time=/);
  assert.match(calls[0], /limit=20/);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "hello world");
  assert.equal(entries[1].app_name, "slack");
});

test("7.1 (b) HttpScreenpipeClient throws on non-2xx", async () => {
  const fakeFetch = async () => new Response("nope", { status: 503, statusText: "Unavailable" });
  const client = new HttpScreenpipeClient({ fetchImpl: fakeFetch });
  await assert.rejects(() => client.queryRecent(60), /screenpipe HTTP 503/);
});

test("7.1 (c) HttpScreenpipeClient drops rows without text", async () => {
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({ data: [{ content: { app_name: "x" } }, { content: { text: "kept" } }, undefined] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const client = new HttpScreenpipeClient({ fetchImpl: fakeFetch });
  const entries = await client.queryRecent(60);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "kept");
});

// --------------------------------------------------------------------------
// summarizeOcr
// --------------------------------------------------------------------------

test("7.1 (d) summarizeOcr keeps the last N entries and clamps long text", () => {
  const entries = [
    { text: "first", app_name: "vscode" },
    { text: "second", app_name: "vscode" },
    { text: "third" },
    { text: "fourth" },
    { text: "fifth" },
    { text: "sixth" },
    { text: "seventh" },
  ];
  const out = summarizeOcr(entries, 3, 240);
  assert.match(out, /fifth/);
  assert.match(out, /sixth/);
  assert.match(out, /seventh/);
  assert.equal(out.includes("first"), false);

  const longText = "x".repeat(1000);
  const big = summarizeOcr([{ text: longText }], 1, 50);
  assert.equal(big.length <= 51 + 1, true, "should clamp to ~50 chars + ellipsis");
});

// --------------------------------------------------------------------------
// Session integration
// --------------------------------------------------------------------------

function fakeScreenpipe({ entries = [], throws = false } = {}) {
  const calls = [];
  return {
    calls,
    queryRecent: async (seconds) => {
      calls.push(seconds);
      if (throws) throw new Error("simulated screenpipe outage");
      return entries;
    },
  };
}

test("7.1 (e) EXPLICIT_ASK with empty recent_diff injects screen_context", async () => {
  const sp = fakeScreenpipe({ entries: [{ text: "Stack Overflow page about reduce()", app_name: "chrome" }] });
  const fake = new FakeAnthropicClient({
    replies: [{ mode: "chat", text: "based on what I saw on screen…", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake, sp);
  try {
    await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "what was that page I just had open?",
      recent_diff: "",
    });
    assert.equal(sp.calls.length, 1, "Screenpipe must be queried");
    assert.equal(sp.calls[0], 60, "default 60s window");
    const sent = fake.calls.ask[0].triggerPayload;
    assert.match(sent.screen_context, /Stack Overflow page about reduce/);
    assert.match(sent.screen_context, /\[chrome\]/);
  } finally {
    cleanup();
  }
});

test("7.1 (f) non-EXPLICIT_ASK trigger never queries Screenpipe", async () => {
  const sp = fakeScreenpipe({ entries: [{ text: "noise" }] });
  const fake = new FakeAnthropicClient({
    decisions: ["chat"],
    replies: [{ mode: "chat", text: "ok", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake, sp);
  try {
    await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts", recent_diff: "" });
    assert.equal(sp.calls.length, 0);
    const sent = fake.calls.ask[0].triggerPayload;
    assert.equal(sent.screen_context, undefined);
  } finally {
    cleanup();
  }
});

test("7.1 (g) EXPLICIT_ASK with non-empty recent_diff skips Screenpipe", async () => {
  const sp = fakeScreenpipe({ entries: [{ text: "noise" }] });
  const fake = new FakeAnthropicClient({
    replies: [{ mode: "chat", text: "ok", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake, sp);
  try {
    await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "fix this",
      recent_diff: "+ const x = 1;",
    });
    assert.equal(sp.calls.length, 0, "editor signal present → don't query Screenpipe");
    const sent = fake.calls.ask[0].triggerPayload;
    assert.equal(sent.screen_context, undefined);
  } finally {
    cleanup();
  }
});

test("7.1 (h) Session degrades gracefully when Screenpipe throws", async () => {
  const sp = fakeScreenpipe({ throws: true });
  const fake = new FakeAnthropicClient({
    replies: [{ mode: "chat", text: "answered without screen", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake, sp);
  try {
    const reply = await session.handleTrigger("EXPLICIT_ASK", {
      user_question: "what was on screen?",
      recent_diff: "",
    });
    assert.equal(reply.text, "answered without screen");
    assert.equal(sp.calls.length, 1, "Screenpipe was attempted");
    assert.equal(fake.calls.ask.length, 1, "ask still ran");
    assert.equal(fake.calls.ask[0].triggerPayload.screen_context, undefined);
  } finally {
    cleanup();
  }
});

test("7.1 (i) Session without a Screenpipe client never adds screen_context", async () => {
  const fake = new FakeAnthropicClient({
    replies: [{ mode: "chat", text: "ok", wants_followup: false }],
  });
  const { session, cleanup } = freshSession(fake, undefined);
  try {
    await session.handleTrigger("EXPLICIT_ASK", { user_question: "q", recent_diff: "" });
    assert.equal(fake.calls.ask[0].triggerPayload.screen_context, undefined);
  } finally {
    cleanup();
  }
});
