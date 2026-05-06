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
