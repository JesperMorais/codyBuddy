// Task 11.1: AnthropicClient.askStream contract tests.
//
// Three layers of coverage:
//   (a)–(c) test the textDeltas() helper directly with hand-shaped
//           SDK-event iterables. The helper is the seam — once it's
//           correct, the SDK does the rest.
//   (d)–(f) test FakeAnthropicClient.askStream (consumer-side) so
//           the conversation loop's wiring works against the same
//           AsyncIterable shape the real client produces.
//   (g)     real-API smoke test gated on ANTHROPIC_API_KEY. Skipped
//           in CI; runnable locally.
//
// Run: node --test daemon/test/ask-stream.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { textDeltas, AnthropicClient } = await import("../dist/anthropic.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

/** Build an async iterable that yields the given event objects in
 *  order. Used to feed textDeltas a deterministic event stream. */
function eventStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

test("11.1 (a) textDeltas yields the text from each content_block_delta event", async () => {
  const events = [
    { type: "message_start" },
    { type: "content_block_start", index: 0 },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "." } },
    { type: "content_block_stop" },
    { type: "message_delta" },
    { type: "message_stop" },
  ];
  const out = [];
  for await (const t of textDeltas(eventStream(events))) out.push(t);
  assert.deepEqual(out, ["Hello", " world", "."]);
});

test("11.1 (b) textDeltas ignores non-text deltas (e.g. tool_use deltas) and other event types", async () => {
  const events = [
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "actual " } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "}" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "text" } },
  ];
  const out = [];
  for await (const t of textDeltas(eventStream(events))) out.push(t);
  assert.deepEqual(out, ["actual ", "text"]);
});

test("11.1 (c) textDeltas handles a stream that yields zero text deltas (model returned no text)", async () => {
  const events = [
    { type: "message_start" },
    { type: "message_stop" },
  ];
  const out = [];
  for await (const t of textDeltas(eventStream(events))) out.push(t);
  assert.deepEqual(out, []);
});

test("11.1 (d) FakeAnthropicClient.askStream yields preconfigured chunks in order", async () => {
  const fake = new FakeAnthropicClient({
    streamChunks: [["Hi ", "there", "."]],
  });
  const chunks = [];
  for await (const c of fake.askStream(["sys"], { user_question: "?" })) {
    chunks.push(c);
  }
  assert.deepEqual(chunks, ["Hi ", "there", "."]);
  assert.equal(fake.calls.askStream.length, 1);
  assert.deepEqual(fake.calls.askStream[0].systemBlocks, ["sys"]);
  assert.deepEqual(fake.calls.askStream[0].triggerPayload, { user_question: "?" });
});

test("11.1 (e) FakeAnthropicClient.askStream stops when the abort signal fires", async () => {
  const fake = new FakeAnthropicClient({
    streamChunks: [["one ", "two ", "three"]],
  });
  const ctrl = new AbortController();
  const chunks = [];
  let yielded = 0;
  for await (const c of fake.askStream(["sys"], {}, ctrl.signal)) {
    chunks.push(c);
    yielded += 1;
    if (yielded === 1) ctrl.abort();
  }
  // The fake checks signal.aborted between yields, so we get the
  // first chunk and then stop.
  assert.deepEqual(chunks, ["one "]);
});

test("11.1 (f) FakeAnthropicClient.askStream falls back to defaultStreamChunks when the per-call queue is empty", async () => {
  const fake = new FakeAnthropicClient({
    defaultStreamChunks: ["fallback "],
  });
  const chunks = [];
  for await (const c of fake.askStream([], {})) chunks.push(c);
  assert.deepEqual(chunks, ["fallback "]);
});

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) console.log("SKIP: 11.1 askStream real-API smoke — ANTHROPIC_API_KEY not set");

test(
  "11.1 (g) real-API smoke: AnthropicClient.askStream yields at least one delta and respects abort",
  { skip: apiKey ? undefined : "ANTHROPIC_API_KEY not set" },
  async () => {
    const client = new AnthropicClient(apiKey, "claude-haiku-4-5-20251001");
    const ctrl = new AbortController();
    const chunks = [];
    let total = 0;
    try {
      for await (const c of client.askStream(
        ["You are a helpful assistant. Reply concisely."],
        { user_question: "Say one short sentence." },
        ctrl.signal
      )) {
        chunks.push(c);
        total += c.length;
        // Abort after we've definitely seen the first delta — the
        // iterator should finish promptly.
        if (chunks.length >= 1) ctrl.abort();
      }
    } catch (err) {
      // The SDK may surface the abort as an error; accept that here
      // — the contract is "iterator stops promptly", not "no throw".
      const msg = err instanceof Error ? err.message : String(err);
      if (!/aborted/i.test(msg)) throw err;
    }
    assert.ok(chunks.length >= 1, "expected at least one delta from a live model");
    assert.ok(total > 0);
  }
);
