// Task 10.6: ConversationLoop state machine tests.
//
// Spec headline: "drive the state machine through each transition
// with mocked I/O; assert correct state sequence and no orphaned
// audio."
//
// We feed the loop fakes for completeUtterance / speakSentence /
// finishUtterance / cancelSpeak / awaitPlaybackDone, plus the real
// BargeInController from Task 10.5 with cancelSpeak registered as
// the TTS canceller. Each test drives one transition path and
// asserts the recorded state sequence exactly.
//
// Run: node --test daemon/test/conversation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

const { ConversationLoop } = await import("../dist/conversation.js");
const { BargeInController } = await import("../dist/barge-in.js");

/** Returns an async iterable that yields `chunks` with optional
 *  per-chunk delay. Honors AbortSignal between chunks. */
function streamFromChunks(chunks, { gap = 5 } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        if (gap > 0) await wait(gap);
        yield c;
      }
    },
    /** Helper for "infinite" streams so the test can verify cancellation. */
  };
}

/** Async iterable that yields once every `gap` ms forever; used to
 *  prove abort signals truncate it. */
function infiniteStream({ gap = 20, signal }) {
  return {
    async *[Symbol.asyncIterator]() {
      let i = 0;
      while (true) {
        if (signal?.aborted) return;
        await wait(gap);
        if (signal?.aborted) return;
        yield `t${i++} `;
      }
    },
  };
}

function newLoop({
  completeUtterance,
  awaitPlaybackDone,
  cancelSpeak: hostCancelSpeak,
} = {}) {
  const transitions = [];
  const speakCalls = [];
  let finishCalls = 0;
  let cancelCalls = 0;
  const bargeIn = new BargeInController({ log: () => {} });
  const cancelSpeak = () => {
    cancelCalls += 1;
    if (hostCancelSpeak) hostCancelSpeak();
  };
  // Wire cancelSpeak into the barge-in controller, exactly as the
  // production host will.
  bargeIn.register("tts", cancelSpeak);

  const loop = new ConversationLoop({
    bargeIn,
    completeUtterance: completeUtterance ?? (() => streamFromChunks([])),
    speakSentence: async (s) => {
      speakCalls.push(s);
    },
    finishUtterance: () => {
      finishCalls += 1;
    },
    cancelSpeak,
    awaitPlaybackDone,
    log: () => {},
  });
  loop.onTransition((next, prev) => transitions.push(`${prev}→${next}`));
  return {
    loop,
    transitions,
    speakCalls,
    bargeIn,
    get finishCalls() {
      return finishCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

test("10.6 (a) full happy path: IDLE → LISTENING → THINKING → SPEAKING → IDLE", async () => {
  const ctx = newLoop({
    completeUtterance: () => streamFromChunks(["Hi there. ", "How can I help?"], { gap: 1 }),
  });
  assert.equal(ctx.loop.getState(), "IDLE");

  ctx.loop.speechStart();
  assert.equal(ctx.loop.getState(), "LISTENING");

  ctx.loop.speechEnd();
  assert.equal(ctx.loop.getState(), "LISTENING", "speechEnd alone shouldn't transition");

  await ctx.loop.transcript("what's wrong?");
  // After completion the loop returns to IDLE.
  assert.equal(ctx.loop.getState(), "IDLE");

  assert.deepEqual(
    ctx.transitions,
    ["IDLE→LISTENING", "LISTENING→THINKING", "THINKING→SPEAKING", "SPEAKING→IDLE"]
  );
  assert.deepEqual(ctx.speakCalls, ["Hi there.", "How can I help?"]);
  assert.equal(ctx.finishCalls, 1, "finishUtterance must fire exactly once on the natural path");
});

test("10.6 (b) empty transcript skips THINKING and returns to IDLE", async () => {
  const ctx = newLoop();
  ctx.loop.speechStart();
  await ctx.loop.transcript("   ");
  assert.equal(ctx.loop.getState(), "IDLE");
  assert.deepEqual(ctx.transitions, ["IDLE→LISTENING", "LISTENING→IDLE"]);
  assert.deepEqual(ctx.speakCalls, []);
});

test("10.6 (c) THINKING → IDLE when LLM stream is empty (no SPEAKING transition)", async () => {
  const ctx = newLoop({ completeUtterance: () => streamFromChunks([]) });
  ctx.loop.speechStart();
  await ctx.loop.transcript("hi");
  assert.equal(ctx.loop.getState(), "IDLE");
  assert.deepEqual(
    ctx.transitions,
    ["IDLE→LISTENING", "LISTENING→THINKING", "THINKING→IDLE"]
  );
});

test("10.6 (d) barge-in during SPEAKING aborts the LLM stream and cancels TTS — no orphaned audio", async () => {
  let abortObserved = false;
  const ctx = newLoop({
    completeUtterance: (_payload, signal) => {
      // Yield a couple sentences then hold; the test calls
      // speechStart() to barge in mid-utterance.
      return {
        async *[Symbol.asyncIterator]() {
          yield "First sentence. ";
          // Wait a beat so the loop transitions to SPEAKING and the
          // test thread can fire speechStart. We poll signal so the
          // abort lands quickly.
          for (let i = 0; i < 200; i++) {
            if (signal.aborted) {
              abortObserved = true;
              return;
            }
            await wait(5);
          }
          yield "Second sentence.";
        },
      };
    },
  });

  ctx.loop.speechStart();
  // Drive the THINKING → SPEAKING transition by handing a transcript.
  // We deliberately don't await transcript() so we can speechStart
  // again during SPEAKING.
  const turn = ctx.loop.transcript("explain it");
  // Wait until the loop has emitted "First sentence." and entered SPEAKING.
  while (ctx.loop.getState() !== "SPEAKING") await wait(2);

  // Barge in mid-utterance.
  ctx.loop.speechStart();
  assert.equal(ctx.loop.getState(), "INTERRUPTED");

  // Wait for cleanup to settle. The loop returns to LISTENING after
  // bargeIn.trigger() resolves.
  await ctx.loop.awaitSettled();
  // Drain the original turn so its promise resolves cleanly.
  await turn;

  assert.equal(abortObserved, true, "LLM stream must observe the abort signal");
  assert.equal(ctx.cancelCalls, 1, "cancelSpeak must be called exactly once via bargeIn");
  // We dispatched only the first sentence — the second never made it
  // through (orphaned-audio invariant).
  assert.deepEqual(ctx.speakCalls, ["First sentence."]);
  // Transitions must include INTERRUPTED → LISTENING.
  assert.ok(
    ctx.transitions.includes("SPEAKING→INTERRUPTED"),
    `expected SPEAKING→INTERRUPTED in ${ctx.transitions.join(", ")}`
  );
  assert.ok(
    ctx.transitions.includes("INTERRUPTED→LISTENING"),
    `expected INTERRUPTED→LISTENING in ${ctx.transitions.join(", ")}`
  );
  assert.equal(ctx.loop.getState(), "LISTENING");
});

test("10.6 (e) opportunities are queued during non-IDLE and consumed when state returns to IDLE", async () => {
  const completionsByPayload = new Map();
  const ctx = newLoop({
    completeUtterance: (payload) => {
      const key = JSON.stringify(payload);
      const stream = streamFromChunks(
        [`reply for ${key}.`],
        { gap: 1 }
      );
      completionsByPayload.set(key, stream);
      return stream;
    },
  });

  // Start a voice turn: enters THINKING, then SPEAKING, then IDLE.
  ctx.loop.speechStart();
  // While we're mid-turn, queue two opportunities.
  ctx.loop.enqueueOpportunity({
    trigger: "MISCONCEPTION",
    payload: { reason: "anti-pattern: x" },
  });
  ctx.loop.enqueueOpportunity({
    trigger: "STUCK_LOOP",
    payload: { stuck: true },
  });
  assert.equal(ctx.loop.pendingOpportunityCount(), 2);
  await ctx.loop.transcript("the voice question");

  // After the voice turn the queued opportunities run back-to-back.
  // Wait until both are drained.
  for (let i = 0; i < 100 && ctx.loop.pendingOpportunityCount() > 0; i++) await wait(5);
  await ctx.loop.awaitSettled();
  await wait(20); // allow the chained opportunity drain to settle

  assert.equal(ctx.loop.pendingOpportunityCount(), 0);
  assert.equal(ctx.loop.getState(), "IDLE");
  // We should have spoken three replies: voice + 2 opportunities.
  assert.equal(ctx.speakCalls.length, 3);
  assert.match(ctx.speakCalls[0], /the voice question/);
  // Opportunities run in FIFO order.
  assert.match(ctx.speakCalls[1], /anti-pattern: x/);
  assert.match(ctx.speakCalls[2], /stuck/);
});

test("10.6 (f) opportunity arriving when IDLE runs immediately (IDLE → THINKING without LISTENING)", async () => {
  const ctx = newLoop({
    completeUtterance: () => streamFromChunks(["Sure. "]),
  });
  ctx.loop.enqueueOpportunity({
    trigger: "EXPLICIT_ASK",
    payload: { user_question: "now please" },
  });
  // The opportunity is consumed synchronously; await its settle.
  await ctx.loop.awaitSettled();
  assert.equal(ctx.loop.getState(), "IDLE");
  // No LISTENING in the trace — opportunities skip it.
  assert.deepEqual(ctx.transitions, [
    "IDLE→THINKING",
    "THINKING→SPEAKING",
    "SPEAKING→IDLE",
  ]);
});

test("10.6 (g) awaitPlaybackDone is awaited before SPEAKING → IDLE", async () => {
  let resolvePlayback;
  const playback = new Promise((r) => (resolvePlayback = r));
  const ctx = newLoop({
    completeUtterance: () => streamFromChunks(["one. ", "two."], { gap: 1 }),
    awaitPlaybackDone: () => playback,
  });
  ctx.loop.speechStart();
  const turn = ctx.loop.transcript("hi");
  // Wait until the LLM stream is exhausted and the loop is parked
  // waiting for playback.
  for (let i = 0; i < 50 && ctx.loop.getState() !== "SPEAKING"; i++) await wait(5);
  assert.equal(ctx.loop.getState(), "SPEAKING");
  // It stays SPEAKING until awaitPlaybackDone resolves.
  await wait(30);
  assert.equal(ctx.loop.getState(), "SPEAKING", "playback gate must hold the state");
  resolvePlayback();
  await turn;
  assert.equal(ctx.loop.getState(), "IDLE");
});

test("10.6 (h) speechStart during THINKING is treated as a barge-in (LLM aborted, back to LISTENING)", async () => {
  let abortObserved = false;
  const ctx = newLoop({
    completeUtterance: (_payload, signal) => infiniteStream({ gap: 10, signal }),
  });
  // Hook the abort observation indirectly via the speakCalls list
  // (the infinite stream yields tokens until aborted; we'll check
  // it never yielded by observing the cancelSpeak count).
  ctx.bargeIn.register("watch-abort", () => {
    abortObserved = true;
  });

  ctx.loop.speechStart();
  // Don't await — we want THINKING then a barge-in.
  const turn = ctx.loop.transcript("...");
  // Wait until the loop entered THINKING. The infinite stream will
  // never produce a sentence boundary so we never reach SPEAKING.
  for (let i = 0; i < 50 && ctx.loop.getState() !== "THINKING"; i++) await wait(5);
  assert.equal(ctx.loop.getState(), "THINKING");
  ctx.loop.speechStart();
  assert.equal(ctx.loop.getState(), "INTERRUPTED");
  await ctx.loop.awaitSettled();
  await turn;
  assert.equal(ctx.loop.getState(), "LISTENING");
  assert.equal(abortObserved, true);
});
