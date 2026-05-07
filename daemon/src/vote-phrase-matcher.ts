// Voice-detected feedback — Task 14.3.
//
// Phrase-match layer (no LLM) that recognises short utterances as
// thumbs-up/down votes:
//
//   "good buddy"     → up
//   "useful"         → up
//   "shut up buddy"  → down
//   "wrong"          → down
//
// Replaces the old Phase 7.3 sidebar 👍/👎 buttons. The vote log
// (VoteStore.record) is shared — only the input mechanism changes.
//
// The matcher is deliberately strict: only WHOLE-utterance matches
// fire. "Yeah, that was useful for the bugfix" does NOT count as a
// vote, because "useful" appears mid-sentence rather than as the
// user's entire response. Trailing "." / "!" and any casing are
// allowed; that's the only flexibility.

export type VoteValue = "up" | "down";

export interface VoteMatch {
  vote: VoteValue;
  /** The canonical phrase that fired — useful for telemetry / the
   *  votes JSONL `phrase` field, separate from the raw transcript. */
  phrase: string;
}

interface VotePhrase {
  phrase: string;
  vote: VoteValue;
  /** Whole-utterance regex with case-insensitive flag and
   *  optional trailing punctuation. */
  pattern: RegExp;
}

export const VOTE_PHRASES: ReadonlyArray<VotePhrase> = [
  { phrase: "good buddy", vote: "up", pattern: /^\s*good\s+buddy\s*[.!]?\s*$/i },
  {
    phrase: "shut up buddy",
    vote: "down",
    pattern: /^\s*shut\s+up\s+buddy\s*[.!]?\s*$/i,
  },
  { phrase: "useful", vote: "up", pattern: /^\s*useful\s*[.!]?\s*$/i },
  { phrase: "wrong", vote: "down", pattern: /^\s*wrong\s*[.!]?\s*$/i },
];

/**
 * Returns the matching vote when `text` is a whole-utterance match
 * for one of VOTE_PHRASES, or null otherwise. Matching is
 * case-insensitive and tolerates a trailing "." or "!".
 *
 * Empty / whitespace-only input returns null.
 */
export function matchVotePhrase(text: string | undefined): VoteMatch | null {
  if (!text || !text.trim()) return null;
  for (const entry of VOTE_PHRASES) {
    if (entry.pattern.test(text)) {
      return { vote: entry.vote, phrase: entry.phrase };
    }
  }
  return null;
}
