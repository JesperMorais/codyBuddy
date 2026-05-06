// Auto-quiet detector — Task 13.1.
//
// Cost-discipline lever. Always-on voice + a chatty LLM tier is
// expensive when nobody is actually using the buddy. After 5 min of
// observed silence (no speech.end events AND no editor edits) the
// daemon drops into QUIET: mic stays open and VAD keeps emitting,
// but transcripts are filtered before they reach the LLM tier
// unless they look like the user actually addressed the buddy.
//
// Filter rules in QUIET:
//   - wake-word configured → transcripts must contain the phrase
//   - wake-word OFF        → transcripts must be ≥ minTranscriptChars
//                             (short utterances are likely background
//                             chatter or false positives from VAD)
//
// Either branch, when satisfied, also resets the gate to ACTIVE so
// the conversation can continue normally.
//
// The gate is intentionally a standalone module — easy to test, easy
// to wire into either the audio loop (ConversationLoop) or any
// editor-side path that wants to register activity.

export interface AutoQuietOptions {
  /** Inactivity threshold in ms before flipping to QUIET. Default
   *  5 minutes. The spec calls this out explicitly; bump it via
   *  config rather than tuning the constant. */
  silenceMs?: number;
  /** When set, transcripts must contain this phrase to wake the
   *  buddy up out of QUIET. Matched case-insensitively. Empty /
   *  undefined → length-based heuristic. */
  wakeWord?: string;
  /** Minimum transcript length (chars, post-trim) for the
   *  length-based heuristic. Default 24 — long enough to filter
   *  out "yeah", "uh-huh", and most VAD-misfires; short enough to
   *  let real questions through. */
  minTranscriptChars?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export type QuietState = "ACTIVE" | "QUIET";

export type DropReason =
  | "wake-word-not-matched"
  | "transcript-too-short"
  | "empty-transcript";

export interface QuietDecision {
  /** Resolved state at the time of the call. */
  state: QuietState;
  /** True when the gate is recommending the caller drop the
   *  transcript instead of forwarding to the LLM. */
  dropped: boolean;
  /** Why the gate dropped. Always present when dropped=true. */
  reason?: DropReason;
}

export class AutoQuietGate {
  private lastActivityAt: number;
  private silenceMs: number;
  private wakeWord?: string;
  private minTranscriptChars: number;
  private nowFn: () => number;

  constructor(opts: AutoQuietOptions = {}) {
    this.silenceMs = opts.silenceMs ?? 5 * 60_000;
    this.wakeWord =
      opts.wakeWord && opts.wakeWord.trim()
        ? opts.wakeWord.trim().toLowerCase()
        : undefined;
    this.minTranscriptChars = opts.minTranscriptChars ?? 24;
    this.nowFn = opts.now ?? Date.now;
    // Bootstrap as ACTIVE — the daemon just started; we have no
    // basis to declare it quiet yet.
    this.lastActivityAt = this.nowFn();
  }

  /** Mark a sign of life. Either the user spoke (speech.end fired)
   *  OR they made an editor edit (handleTrigger ran). Resets the
   *  silence countdown — the next state() will return ACTIVE until
   *  silenceMs has passed again. */
  noteActivity(): void {
    this.lastActivityAt = this.nowFn();
  }

  /** Read the gate's current state without mutating it. */
  state(): QuietState {
    return this.nowFn() - this.lastActivityAt >= this.silenceMs
      ? "QUIET"
      : "ACTIVE";
  }

  /** Decide whether `text` should reach the LLM tier. ACTIVE always
   *  forwards. QUIET applies the configured filter (wake-word OR
   *  length heuristic). When the filter passes, the gate ALSO
   *  resets to ACTIVE so subsequent transcripts don't keep getting
   *  filtered mid-conversation. */
  shouldForwardTranscript(text: string): QuietDecision {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      // An empty transcript is definitely not a sign of life and
      // shouldn't reach the LLM in either state. We don't reset on
      // it, otherwise repeated empty fires from the STT path would
      // pin us to ACTIVE forever.
      return {
        state: this.state(),
        dropped: true,
        reason: "empty-transcript",
      };
    }
    const state = this.state();
    if (state === "ACTIVE") {
      // Note activity here too — speaking is a sign of life even
      // before speech.end fires.
      this.lastActivityAt = this.nowFn();
      return { state, dropped: false };
    }

    // QUIET — apply the configured filter.
    if (this.wakeWord) {
      if (trimmed.toLowerCase().includes(this.wakeWord)) {
        this.lastActivityAt = this.nowFn();
        return { state: "QUIET", dropped: false };
      }
      return { state, dropped: true, reason: "wake-word-not-matched" };
    }

    if (trimmed.length >= this.minTranscriptChars) {
      this.lastActivityAt = this.nowFn();
      return { state: "QUIET", dropped: false };
    }
    return { state, dropped: true, reason: "transcript-too-short" };
  }

  /** Force the gate into QUIET right now — primarily for tests
   *  that want to skip the wall-clock wait. */
  forceQuiet(): void {
    this.lastActivityAt = this.nowFn() - this.silenceMs - 1;
  }

  /** How long since the last activity, in ms. */
  millisSinceActivity(): number {
    return this.nowFn() - this.lastActivityAt;
  }
}
