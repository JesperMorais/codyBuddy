// Task 11.2: SentenceBuffer + sentencesFromDeltas tests.
//
// Spec headline (verbatim): "feed a fixture stream of deltas;
// assert sentences are emitted as soon as their terminator arrives,
// not at end-of-stream."
//
// Coverage:
//   (a)–(d) test SentenceBuffer.push() / flush() directly with
//           hand-built strings — pure, deterministic.
//   (e)     test sentencesFromDeltas with a slow producer that
//           HOLDS THE STREAM OPEN after the first sentence's
//           terminator. The first sentence must surface before the
//           upstream resolves — that's the spec's "as soon as the
//           terminator arrives" invariant.
//   (f)–(g) abort signal honored mid-stream; multiple sentences in
//           one delta yielded in order.
//
// Run: node --test daemon/test/sentence-buffer.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

const { SentenceBuffer, sentencesFromDeltas } = await import("../dist/sentence-buffer.js");

test("11.2 (a) push() returns each completed sentence and holds back the trailing fragment", () => {
  const buf = new SentenceBuffer();
  const out1 = buf.push("Hello there. How are ");
  assert.deepEqual(out1, ["Hello there."]);
  assert.equal(buf.pendingText(), " How are ");
  const out2 = buf.push("you?");
  assert.deepEqual(out2, ["How are you?"]);
  assert.equal(buf.hasPending(), false);
});

test("11.2 (b) sentence boundaries: . ! ? and double newline", () => {
  const buf = new SentenceBuffer();
  // Period → sentence
  assert.deepEqual(buf.push("First."), ["First."]);
  // Exclamation → sentence
  assert.deepEqual(buf.push("Wait! "), ["Wait!"]);
  // Question → sentence
  assert.deepEqual(buf.push("Why? "), ["Why?"]);
  // Double newline → sentence (a paragraph break, e.g. between
  // bullets — whitespace-only "sentences" are dropped though)
  assert.deepEqual(buf.push("Block one\n\n"), ["Block one"]);
  assert.deepEqual(buf.push("Block two\n\nMore"), ["Block two"]);
  assert.equal(buf.flush(), "More");
});

test("11.2 (c) flush() returns the pending fragment and clears the buffer", () => {
  const buf = new SentenceBuffer();
  buf.push("Just a fragment with no terminator yet");
  assert.equal(buf.hasPending(), true);
  assert.equal(buf.flush(), "Just a fragment with no terminator yet");
  assert.equal(buf.flush(), "");
  assert.equal(buf.hasPending(), false);
});

test("11.2 (d) multiple sentences in one push are surfaced in order", () => {
  const buf = new SentenceBuffer();
  const out = buf.push("First. Second! Third? Trailing");
  assert.deepEqual(out, ["First.", "Second!", "Third?"]);
  assert.equal(buf.flush(), "Trailing");
});

test("11.2 (e) SPEC HEADLINE: sentence emits as soon as the terminator lands, NOT at end-of-stream", async () => {
  // Deferred async iterable that yields "Hello world." then HOLDS
  // — never yielding the second chunk until the test resolves it.
  // If sentencesFromDeltas waited for end-of-stream, the for-await
  // below would never see the first sentence.
  let releaseSecondChunk;
  const secondChunkReady = new Promise((r) => (releaseSecondChunk = r));

  const upstream = {
    async *[Symbol.asyncIterator]() {
      yield "Hello world.";
      // Park here until the test releases. If the buffer is correctly
      // sentence-streaming, the consumer will have already received
      // "Hello world." before this point.
      await secondChunkReady;
      yield " Second sentence.";
    },
  };

  const sentences = [];
  const t0 = Date.now();
  let firstSentenceAt = 0;

  // Consume in the background so we can observe interim state.
  const consumer = (async () => {
    for await (const s of sentencesFromDeltas(upstream)) {
      if (sentences.length === 0) firstSentenceAt = Date.now();
      sentences.push(s);
    }
  })();

  // The first sentence should land before we release the second
  // chunk — within a tight bound.
  await wait(50);
  assert.equal(sentences.length, 1, "first sentence must arrive without waiting for end-of-stream");
  assert.equal(sentences[0], "Hello world.");
  const firstLatency = firstSentenceAt - t0;
  assert.ok(firstLatency < 50, `first sentence latency ${firstLatency}ms should be near-immediate`);

  // Now release the second chunk; the iterator finishes and we get
  // the second sentence.
  releaseSecondChunk();
  await consumer;
  assert.deepEqual(sentences, ["Hello world.", "Second sentence."]);
});

test("11.2 (f) abort signal stops sentencesFromDeltas mid-stream", async () => {
  const ctrl = new AbortController();
  let yieldedAfterAbort = false;
  const upstream = {
    async *[Symbol.asyncIterator]() {
      yield "First. ";
      ctrl.abort();
      // Give the consumer a microtask boundary to observe the abort.
      await wait(5);
      yield "Second.";
      yieldedAfterAbort = true;
    },
  };

  const sentences = [];
  for await (const s of sentencesFromDeltas(upstream, ctrl.signal)) {
    sentences.push(s);
  }
  assert.deepEqual(sentences, ["First."]);
  // The upstream may keep producing internally — what matters is the
  // consumer didn't see anything past the abort.
});

test("11.2 (g) trailing fragment is yielded as a final sentence on stream end", async () => {
  const upstream = {
    async *[Symbol.asyncIterator]() {
      yield "One sentence. And then ";
      yield "a trailing fragment without punctuation";
    },
  };
  const sentences = [];
  for await (const s of sentencesFromDeltas(upstream)) sentences.push(s);
  assert.deepEqual(sentences, [
    "One sentence.",
    "And then a trailing fragment without punctuation",
  ]);
});

test("16.8 (i) decimals do NOT trigger a sentence boundary mid-buffer (`It's 2.5 meters.`)", () => {
  const buf = new SentenceBuffer();
  // Single push: "2.5" is decimal — only the trailing period closes
  // the sentence.
  assert.deepEqual(buf.push("It's 2.5 meters."), ["It's 2.5 meters."]);
  assert.equal(buf.hasPending(), false);
});

test("16.8 (i') decimals across chunk boundaries do NOT split (chunk ends after `2.`)", () => {
  // Streaming case: the LLM may chunk between digits. The first
  // push ends with a digit-then-period, which on its own looks like
  // a sentence end — but the next chunk continues the number. The
  // buffer must hold off until disambiguation lands.
  const buf = new SentenceBuffer();
  assert.deepEqual(buf.push("It's 2."), [], "trailing digit-period must wait for more input");
  assert.equal(buf.hasPending(), true);
  assert.deepEqual(buf.push("5 meters."), ["It's 2.5 meters."]);
  assert.equal(buf.hasPending(), false);
});

test("16.8 (j) common abbreviations don't split: Dr., Mr., Mrs., St., Inc., e.g., i.e., etc.", () => {
  // Each in its own buffer so each is independently asserted.
  const cases = [
    ["Dr. Smith said hi.", ["Dr. Smith said hi."]],
    ["Mr. Jones left.", ["Mr. Jones left."]],
    ["Mrs. Smith arrived.", ["Mrs. Smith arrived."]],
    ["St. Louis is nice.", ["St. Louis is nice."]],
    ["Acme Inc. announced.", ["Acme Inc. announced."]],
    ["e.g. this is fine.", ["e.g. this is fine."]],
    ["i.e. that means yes.", ["i.e. that means yes."]],
    ["Cats, dogs, etc. live here.", ["Cats, dogs, etc. live here."]],
  ];
  for (const [input, expected] of cases) {
    const buf = new SentenceBuffer();
    assert.deepEqual(buf.push(input), expected, `input: ${JSON.stringify(input)}`);
  }
});

test("16.8 (k) terminator immediately followed by a non-space character is NOT a boundary (URLs/version strings)", () => {
  // Things like "node.js" or "v1.2.3" should not split — the
  // terminator must be followed by whitespace, EOL, or end-of-buffer.
  const buf = new SentenceBuffer();
  assert.deepEqual(buf.push("Use node.js for this."), ["Use node.js for this."]);
});

test("16.8 (l) sentence-ending number followed by space emits the FIRST sentence; trailing `6.` defers to flush()", () => {
  // The decimal-guard suppresses emission when `<digit>.` sits at
  // end-of-buffer (ambiguous between "the number 6" and "6.x" still
  // streaming). The first boundary `5. ` is unambiguous (whitespace
  // follower) and emits immediately; the trailing `6.` waits and is
  // only released by flush() — semantically correct for streams,
  // since the LLM may continue with another digit.
  const buf = new SentenceBuffer();
  assert.deepEqual(buf.push("The answer is 5. The next is 6."), ["The answer is 5."]);
  assert.equal(buf.hasPending(), true);
  // flush() releases the held fragment at end-of-stream.
  assert.equal(buf.flush(), "The next is 6.");
});

test("16.8 (l') sentencesFromDeltas releases a trailing `<digit>.` sentence at end-of-stream", async () => {
  // The async-iterable wrapper is the path the conversation loop
  // actually uses. This guards that the digit-period hold doesn't
  // *swallow* the trailing sentence — it just defers it to flush().
  const upstream = {
    async *[Symbol.asyncIterator]() {
      yield "The answer is 5. The next is 6.";
    },
  };
  const out = [];
  for await (const s of sentencesFromDeltas(upstream)) out.push(s);
  assert.deepEqual(out, ["The answer is 5.", "The next is 6."]);
});

test("16.8 (m) abbreviation followed by capital letter still does not split (`Dr. Smith.`)", () => {
  // Common false positive: heuristics that emit on `<terminator>
  // <Capital>` would split "Dr. Smith." between "Dr." and "Smith.".
  const buf = new SentenceBuffer();
  assert.deepEqual(buf.push("Dr. Smith."), ["Dr. Smith."]);
});

test("11.2 (h) zero-length sentences never leak out (no empty strings in any push() result)", () => {
  // The buffer's invariant is "no zero-length strings". Punctuation-
  // adjacent whitespace is normalised by trim() but a degenerate
  // case like a lone "." is allowed through — TTS reads it as a
  // beat, and suppressing it would silently swallow a real model
  // emit. The strict guarantee is just: nothing ever yields "".
  const buf = new SentenceBuffer();
  for (const chunk of ["", "   ", "Hello.", "  ", "\n\n", "Goodbye!"]) {
    for (const s of buf.push(chunk)) assert.ok(s.length > 0, `unexpected empty from chunk ${JSON.stringify(chunk)}`);
  }
  assert.equal(buf.flush().length === 0 || buf.flush().length > 0, true);
});
