// Wake-word gate — Task 10.8.
//
// Gates the LLM-forwarding path behind a configurable wake word.
// When the gate is "off" (the default) every transcript reaches the
// LLM — the daemon is in open-mic always-listening mode. When a wake
// word is configured, transcripts are dropped until the wake word is
// heard; after that, the gate stays "armed" for 30 seconds (any
// follow-up turn within that window passes straight through). After
// the 30s active window elapses without further activity the gate
// re-arms back to "gated" and the user has to say the wake word again.
//
// Production also runs a low-CPU on-device audio detector
// (openWakeWord) so the LLM-side gate isn't the only line of defence —
// audio for un-armed periods doesn't even get streamed to Whisper at
// full quality. That detector is a separate concern; this module
// owns the *post-transcription* gate, which is what the spec test
// exercises directly: "with `BUDDY_WAKEWORD='hey buddy'` and a fixture
// transcript 'hello world hey buddy what time is it', assert only
// 'what time is it' reaches the LLM path."
//
// The transcript-side gate is also useful when the audio detector is
// disabled (CPU-constrained boxes, headless test rigs) — the daemon
// stays correct, just at the cost of streaming everything through
// Whisper.

export type WakeWordState = "off" | "gated" | "armed";

export interface WakeWordOptions {
  /** Wake word phrase. Empty / undefined / "off" disables the gate. */
  phrase?: string;
  /** How long to stay armed after the wake word (or after each
   *  follow-up transcript that bumps the deadline). Default 30s —
   *  the spec value. */
  activeWindowMs?: number;
  /** Test seam for the wall clock. */
  clock?: () => number;
}

export interface ForwardResult {
  /** Text to forward to the LLM, or null when the gate suppressed
   *  everything in this transcript. The wake-word phrase itself is
   *  always stripped — "hey buddy what time is it" yields
   *  "what time is it", not "hey buddy what time is it". */
  text: string | null;
  /** Gate state AFTER processing this transcript. Useful for
   *  telemetry and the sidebar mic indicator. */
  state: WakeWordState;
  /** True if this transcript contained the wake word. */
  triggered: boolean;
}

export class WakeWordGate {
  private phrase: string;
  private phraseLower: string;
  private off: boolean;
  private activeWindowMs: number;
  private clock: () => number;
  /** When the active window expires (ms since epoch). 0 = gated. */
  private armedUntil = 0;

  constructor(opts: WakeWordOptions = {}) {
    const raw = (opts.phrase ?? "").trim();
    this.off = raw === "" || raw.toLowerCase() === "off";
    this.phrase = this.off ? "" : raw;
    this.phraseLower = this.phrase.toLowerCase();
    this.activeWindowMs = opts.activeWindowMs ?? 30_000;
    this.clock = opts.clock ?? Date.now;
  }

  /** Current gate state. "off" means no wake word configured at all;
   *  "armed" means the active window is open; "gated" means the
   *  user must say the wake word to forward anything. */
  state(now: number = this.clock()): WakeWordState {
    if (this.off) return "off";
    return now < this.armedUntil ? "armed" : "gated";
  }

  /** Process one final transcript from the STT path. Returns the
   *  text that should reach the LLM (or null if nothing should), the
   *  resulting gate state, and whether this transcript triggered the
   *  wake word.
   *
   *  Behaviour by state:
   *    off    : every transcript passes through unchanged.
   *    armed  : every transcript passes through; window is bumped
   *             to now + activeWindowMs (so back-and-forth turns
   *             during a real conversation don't re-gate the user).
   *    gated  : split on the wake word. Anything before is dropped;
   *             anything after passes through and the gate becomes
   *             armed. If the wake word doesn't appear, returns null.
   */
  forward(transcript: string, now: number = this.clock()): ForwardResult {
    if (this.off) {
      return { text: transcript.trim() || null, state: "off", triggered: false };
    }
    const text = transcript ?? "";
    const armed = now < this.armedUntil;
    const idx = findPhrase(text, this.phraseLower);

    if (armed && idx < 0) {
      // Inside the active window and no fresh wake word — let the
      // transcript through and bump the deadline so an active
      // back-and-forth doesn't re-gate the user mid-thought.
      this.armedUntil = now + this.activeWindowMs;
      return { text: text.trim() || null, state: "armed", triggered: false };
    }

    if (idx < 0) {
      // Gated and no wake word in this transcript — drop everything.
      return { text: null, state: "gated", triggered: false };
    }

    // Wake word is in the transcript. Anything before it is dropped
    // (the user was clearly addressing someone else); anything after
    // is forwarded and the gate arms.
    const after = text.slice(idx + this.phraseLower.length).trim();
    this.armedUntil = now + this.activeWindowMs;
    return {
      text: after.length > 0 ? after : null,
      state: "armed",
      triggered: true,
    };
  }

  /** Force-rearm — useful when the loop transitions IDLE → LISTENING
   *  with an existing armed window: callers can extend it without
   *  going through forward(). */
  bumpWindow(now: number = this.clock()): void {
    if (this.off) return;
    if (now < this.armedUntil) {
      this.armedUntil = now + this.activeWindowMs;
    }
  }

  /** Force-disarm. Used by the hard-mute hotkey so the next
   *  transcript requires a fresh wake word. */
  disarm(): void {
    if (!this.off) this.armedUntil = 0;
  }
}

/** Case-insensitive whole-word phrase match. Returns the index of
 *  the first match in the original casing, or -1. We don't reach for
 *  a regex because the wake word is user-provided — escaping is
 *  trivial but skipping it is fine here, the search is just
 *  String#indexOf on the lowercased haystack. */
function findPhrase(haystack: string, phraseLower: string): number {
  if (!phraseLower) return -1;
  return haystack.toLowerCase().indexOf(phraseLower);
}
