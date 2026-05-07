// Task 14.3: voice-detected vote integration through ConversationLoop.
//
// Spec contract:
//   "Feed each phrase as a transcript; assert the corresponding
//    vote is appended."
//
// Wiring under test:
//   ConversationLoop.transcript() consults the phrase matcher on
//   every incoming finalised transcript. On match, it calls the
//   host's voteHandler (production: VoteStore.record) and consumes
//   the transcript without invoking the LLM.
//
// Run: node --test daemon/test/vote-from-voice.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ConversationLoop } = await import("../dist/conversation.js");
const { VoteStore } = await import("../dist/votes.js");

function makeLoopDeps(extra = {}) {
  const calls = { complete: 0, vote: [] };
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      calls.complete += 1;
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
    voteHandler: (match, raw) => {
      calls.vote.push({ match, raw });
    },
    ...extra,
  };
  return { deps, calls };
}

test("14.3 each shipped phrase is appended to the VoteStore", async () => {
  // The pinned spec test, end to end with a real VoteStore.
  const dir = mkdtempSync(join(tmpdir(), "buddy-14.3-"));
  const path = join(dir, "votes.jsonl");
  const votes = new VoteStore(path);

  const phrases = [
    { transcript: "good buddy", expectedVote: "up" },
    { transcript: "useful", expectedVote: "up" },
    { transcript: "shut up buddy", expectedVote: "down" },
    { transcript: "wrong", expectedVote: "down" },
  ];

  let completeCalls = 0;
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      completeCalls += 1;
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
    voteHandler: (match, raw) => {
      votes.record({
        trigger: "voice",
        reply_text: `phrase=${match.phrase}`,
        vote: match.vote,
      });
    },
  };
  const loop = new ConversationLoop(deps);

  for (const { transcript, expectedVote } of phrases) {
    loop.speechStart();
    await loop.transcript(transcript);
  }

  // No LLM invocations — every transcript was a vote.
  assert.equal(completeCalls, 0, "votes must not reach the LLM");

  const stored = votes.read();
  assert.equal(stored.length, phrases.length);
  for (let i = 0; i < phrases.length; i++) {
    assert.equal(stored[i].vote, phrases[i].expectedVote);
    assert.equal(stored[i].trigger, "voice");
  }
});

test("14.3 a non-vote transcript falls through to the LLM", async () => {
  const { deps, calls } = makeLoopDeps();
  const loop = new ConversationLoop(deps);

  loop.speechStart();
  await loop.transcript("how do I fix this null pointer");
  await loop.awaitSettled();

  assert.equal(calls.vote.length, 0, "no vote should fire");
  assert.equal(calls.complete, 1, "LLM should run");
});

test("14.3 vote handler can be async — loop awaits it", async () => {
  let resolved = false;
  const { deps, calls } = makeLoopDeps({
    voteHandler: async (match) => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
      calls.vote.push({ match });
    },
  });
  const loop = new ConversationLoop(deps);

  loop.speechStart();
  await loop.transcript("useful");

  assert.equal(resolved, true, "handler ran to completion");
  assert.equal(calls.vote.length, 1);
  assert.equal(calls.complete, 0);
});

test("14.3 vote handler that throws does not crash the loop", async () => {
  const calls = { complete: 0, vote: 0 };
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      calls.complete += 1;
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
    voteHandler: () => {
      calls.vote += 1;
      throw new Error("disk gone");
    },
  };
  const loop = new ConversationLoop(deps);

  loop.speechStart();
  await loop.transcript("useful");

  // Handler ran but threw; loop swallowed it and reset to IDLE.
  assert.equal(calls.vote, 1);
  assert.equal(loop.getState(), "IDLE");
  // No LLM called either way — the vote was matched.
  assert.equal(calls.complete, 0);
});

test("14.3 loop without voteHandler ignores the matcher (back-compat)", async () => {
  // When no voteHandler is wired, the loop never consults the
  // matcher — short utterances flow to the LLM as before.
  const calls = { complete: 0 };
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      calls.complete += 1;
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
    // no voteHandler
  };
  const loop = new ConversationLoop(deps);

  loop.speechStart();
  await loop.transcript("useful");
  await loop.awaitSettled();

  assert.equal(calls.complete, 1, "without a voteHandler, transcript reaches LLM");
});

test("14.3 vote-matched transcript bypasses the auto-quiet gate", async () => {
  // Even in QUIET, a vote phrase is meaningful — the user is
  // engaging with the buddy. Vote handler runs; gate stays QUIET
  // (vote isn't activity in the sense of "wake up and chat") OR
  // resets, depending on implementation. Either is acceptable;
  // the key invariant is that the LLM is NEVER reached.
  const { AutoQuietGate } = await import("../dist/auto-quiet.js");
  const calls = { complete: 0, vote: 0 };
  const gate = new AutoQuietGate({ silenceMs: 60_000 });
  gate.forceQuiet();

  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      calls.complete += 1;
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
    quietGate: gate,
    voteHandler: () => {
      calls.vote += 1;
    },
  };
  const loop = new ConversationLoop(deps);

  loop.speechStart();
  await loop.transcript("wrong");

  assert.equal(calls.vote, 1, "vote fires even in QUIET");
  assert.equal(calls.complete, 0, "LLM never reached");
});
