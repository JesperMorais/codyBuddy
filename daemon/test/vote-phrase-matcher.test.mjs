// Task 14.3: phrase-match unit tests for voice-detected feedback.
//
// Run: node --test daemon/test/vote-phrase-matcher.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { matchVotePhrase, VOTE_PHRASES } = await import(
  "../dist/vote-phrase-matcher.js"
);

test("14.3 matches all four shipped phrases (lowercase, no punctuation)", () => {
  assert.deepEqual(matchVotePhrase("good buddy"), { vote: "up", phrase: "good buddy" });
  assert.deepEqual(matchVotePhrase("useful"), { vote: "up", phrase: "useful" });
  assert.deepEqual(matchVotePhrase("shut up buddy"), {
    vote: "down",
    phrase: "shut up buddy",
  });
  assert.deepEqual(matchVotePhrase("wrong"), { vote: "down", phrase: "wrong" });
});

test("14.3 matching is case-insensitive", () => {
  assert.equal(matchVotePhrase("GOOD BUDDY")?.vote, "up");
  assert.equal(matchVotePhrase("Useful")?.vote, "up");
  assert.equal(matchVotePhrase("Shut Up Buddy")?.vote, "down");
  assert.equal(matchVotePhrase("WRONG")?.vote, "down");
});

test("14.3 trailing '.' or '!' is allowed", () => {
  assert.equal(matchVotePhrase("good buddy.")?.vote, "up");
  assert.equal(matchVotePhrase("useful!")?.vote, "up");
  assert.equal(matchVotePhrase("wrong.")?.vote, "down");
});

test("14.3 leading/trailing whitespace tolerated", () => {
  assert.equal(matchVotePhrase("  good buddy  ")?.vote, "up");
  assert.equal(matchVotePhrase("\twrong\n")?.vote, "down");
});

test("14.3 phrase embedded in a longer sentence does NOT match", () => {
  // "useful" inside a real sentence is not a vote — the user is
  // commenting on something else. The strict whole-utterance match
  // is what protects us from false positives.
  assert.equal(matchVotePhrase("yeah that was useful for the bug"), null);
  assert.equal(matchVotePhrase("you got that wrong but no worries"), null);
  assert.equal(matchVotePhrase("good buddy you are at this stuff"), null);
  assert.equal(matchVotePhrase("don't shut up buddy keep going"), null);
});

test("14.3 empty / whitespace-only input returns null", () => {
  assert.equal(matchVotePhrase(""), null);
  assert.equal(matchVotePhrase("   "), null);
  assert.equal(matchVotePhrase(undefined), null);
});

test("14.3 unrelated short phrases return null", () => {
  assert.equal(matchVotePhrase("hello"), null);
  assert.equal(matchVotePhrase("buddy"), null); // word alone — not a vote
  assert.equal(matchVotePhrase("good"), null);
  assert.equal(matchVotePhrase("yeah"), null);
});

test("14.3 every shipped phrase entry has a vote of 'up' or 'down'", () => {
  for (const entry of VOTE_PHRASES) {
    assert.ok(
      entry.vote === "up" || entry.vote === "down",
      `phrase ${entry.phrase} has invalid vote ${entry.vote}`
    );
    assert.ok(entry.phrase.length > 0);
    assert.ok(entry.pattern instanceof RegExp);
  }
  // Spec pins these four — drift guard.
  const phrases = VOTE_PHRASES.map((p) => p.phrase).sort();
  assert.deepEqual(phrases, ["good buddy", "shut up buddy", "useful", "wrong"]);
});
