// ConversationLoop — Task 10.6.
//
// The state machine that drives the live audio path. Replaces
// Session.handleTrigger for voice turns; Session keeps owning the
// chat path (sidebar text input, EXPLICIT_ASK from a quickpick, etc).
//
// States:
//   IDLE        — nothing happening; opportunities can be consumed here.
//   LISTENING   — VAD reports the user is speaking; STT is active.
//   THINKING    — STT delivered a final transcript (or an opportunity
//                 fired); the LLM stream is running.
//   SPEAKING    — TTS is playing back the assistant's reply.
//   INTERRUPTED — barge-in fired during SPEAKING; cleanup in progress
//                 before we transition back. (Always followed by
//                 LISTENING — the user is, by definition, already talking.)
//
// Transitions:
//   IDLE → LISTENING            : speechStart()
//   IDLE → THINKING              : opportunity dequeued + processed
//   LISTENING → THINKING         : transcript() arrives after speechEnd()
//   LISTENING → IDLE             : transcript() empty / error path
//   THINKING → SPEAKING          : LLM stream yields its first token
//   THINKING → IDLE              : LLM stream finishes empty / errored
//   SPEAKING → INTERRUPTED       : speechStart() during SPEAKING (barge-in)
//   SPEAKING → IDLE              : LLM stream done + TTS playback done
//   INTERRUPTED → LISTENING      : barge-in cancellers settled
//
// Editor triggers (anti-pattern, stuck-loop, EXPLICIT_ASK from the
// editor decoration) feed in via enqueueOpportunity(). They're held
// in a FIFO and dequeued only when the state is IDLE so we never
// stomp on a live voice turn. EXPLICIT_ASK from the chat sidebar
// goes through the existing Session.handleTrigger path — the
// conversation loop is voice-first.
//
// "No orphaned audio" is the spec's invariant. Every path that
// leaves SPEAKING (or INTERRUPTED) calls deps.cancelSpeak()
// directly from transition() so the audio stops reaching the
// speakers — even when the LLM stream finished happily and we just
// got barged in mid-sentence. The host wires cancelSpeak to
// StreamingTtsBridge.dispose() in production; that call must be
// idempotent because the host typically also registers the same
// canceller with the BargeInController and both will fire on
// SPEAKING → INTERRUPTED.

import { EventEmitter } from "node:events";
import type { BargeInController } from "./barge-in.js";
import { SentenceBuffer } from "./sentence-buffer.js";
import type { AutoQuietGate, QuietState } from "./auto-quiet.js";
import { matchVotePhrase, type VoteMatch } from "./vote-phrase-matcher.js";

export type ConversationState =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "SPEAKING"
  | "INTERRUPTED";

export interface Opportunity {
  /** Editor trigger name, e.g. "MISCONCEPTION", "STUCK_LOOP", "EXPLICIT_ASK". */
  trigger: string;
  /** Whatever payload Session.handleTrigger would have received. */
  payload: object;
}

export interface ConversationLoopDeps {
  /** Barge-in fan-out from Task 10.5. The loop only needs trigger();
   *  the host registers concrete cancellers (TTS, LLM stream, etc.)
   *  before passing it in. */
  bargeIn: BargeInController;
  /**
   * Streams the assistant reply for `payload`. The signal aborts the
   * stream cleanly when barge-in fires. Called once per voice turn or
   * opportunity; the loop iterates the result and feeds sentence
   * boundaries to speakSentence().
   *
   * In production this is wired to AnthropicClient.askStream (Task
   * 11.1). For now the interface is decoupled so the loop can be
   * tested with any token source.
   */
  completeUtterance: (
    payload: object,
    signal: AbortSignal
  ) => AsyncIterable<string>;
  /** Push a sentence to the TTS sidecar. Resolves when the sentence
   *  has been fully accepted (not when audio finishes — that's a
   *  separate signal via onPlaybackDone). */
  speakSentence: (sentence: string) => Promise<void>;
  /** Tell the TTS path the utterance is complete. Triggers any
   *  flush logic the bridge has (e.g. StreamingTtsBridge.finish). */
  finishUtterance: () => void;
  /** Hard-cancel the TTS pipeline. Invoked by the loop on every
   *  transition that leaves SPEAKING or INTERRUPTED so the spec's
   *  "no orphaned audio" invariant is enforced by the loop itself,
   *  not by the host's bargeIn registration. Must drop any
   *  in-flight playback so we don't leave audio echoing into the
   *  user's mic. Required to be idempotent: the host typically
   *  also registers the same canceller with the BargeInController
   *  for symmetry with other cancellers, so both will fire on
   *  SPEAKING → INTERRUPTED. StreamingTtsBridge.dispose() (the
   *  production wiring) is idempotent. */
  cancelSpeak: () => void;
  /**
   * Resolves when audio playback for the current utterance has
   * actually finished. The loop transitions SPEAKING → IDLE only
   * when this resolves AND the LLM stream has ended. Optional:
   * if omitted, the loop transitions out of SPEAKING immediately
   * after the LLM stream ends (useful for tests that don't care
   * about playback).
   */
  awaitPlaybackDone?: () => Promise<void>;
  /** Optional logger; defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Optional auto-quiet gate (Task 13.1). When configured, the loop
   * consults it before forwarding transcripts to the LLM:
   *   - ACTIVE → forward as usual
   *   - QUIET  → drop unless the gate says the transcript passed
   *              the wake-word / length filter
   * Editor-side activity (handleTrigger) is registered separately
   * via gate.noteActivity() — the loop only handles the speech path.
   */
  quietGate?: AutoQuietGate;
  /**
   * Optional voice-detected vote handler (Task 14.3). When wired,
   * the loop runs the phrase matcher on every incoming transcript
   * BEFORE consulting the quiet gate or running the LLM. A match
   * results in the handler being invoked with the vote and the
   * canonical phrase, after which the transcript is consumed (no
   * LLM round-trip). Empty/non-matching transcripts fall through
   * to the existing path.
   *
   * Production hosts wire this to the existing VoteStore.record so
   * voice and sidebar-button votes share the same JSONL log.
   */
  voteHandler?: (
    match: VoteMatch,
    rawTranscript: string
  ) => void | Promise<void>;
}

export class ConversationLoop {
  private state: ConversationState = "IDLE";
  private opportunities: Opportunity[] = [];
  private events = new EventEmitter();
  private deps: ConversationLoopDeps;
  private log: (line: string) => void;

  /** Cap-driven downgrade flag (Task 13.2). When true, transcript()
   *  drops every utterance — the daily USD cap forced the buddy
   *  off the voice path. The host clears this on the next
   *  local-midnight rollover. */
  private suspended = false;
  /** Aborts the in-flight LLM stream when set; cleared when no
   *  stream is running. */
  private llmAbort?: AbortController;
  /** Latest finalized transcript waiting for THINKING. Cleared on consume. */
  private pendingTranscript = "";
  /** Set true while we're inside THINKING + SPEAKING for the SAME
   *  turn, so SPEAKING → IDLE waits for both stream-end AND
   *  playback-done. */
  private llmStreamFinished = false;
  /** Resolves when SPEAKING/INTERRUPTED finishes settling. Tests
   *  await this to drive the next transition deterministically. */
  private settling?: Promise<void>;

  constructor(deps: ConversationLoopDeps) {
    this.deps = deps;
    this.log = deps.log ?? ((l) => console.log(l));
  }

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  getState(): ConversationState {
    return this.state;
  }

  /** Subscribe to every state transition. The handler receives both
   *  the previous and next state so consumers can express
   *  edge-triggered logic without tracking state themselves. */
  onTransition(h: (next: ConversationState, prev: ConversationState) => void): void {
    this.events.on("transition", h);
  }

  /** VAD: the user just started talking. Drives IDLE → LISTENING or
   *  SPEAKING → INTERRUPTED (barge-in). LISTENING speech.start during
   *  THINKING is treated like a barge-in too: the LLM stream is
   *  truncated and we go back to LISTENING for the (now) new
   *  utterance. */
  speechStart(): void {
    if (this.state === "IDLE") {
      this.transition("LISTENING");
      return;
    }
    if (this.state === "SPEAKING" || this.state === "THINKING") {
      this.transition("INTERRUPTED");
      // Cleanup runs async; once it settles we're ready for the
      // user's words via LISTENING.
      this.settling = (async () => {
        try {
          this.llmAbort?.abort();
          await this.deps.bargeIn.trigger();
        } finally {
          this.transition("LISTENING");
        }
      })();
      return;
    }
    // Already LISTENING / INTERRUPTED — speech.start is redundant.
  }

  /** VAD: the user just stopped talking. Drives LISTENING → THINKING
   *  once the transcript arrives. We don't transition here directly
   *  because the STT bridge promotes its last-partial up to 400ms
   *  later (per Task 10.2's contract). The auto-quiet gate counts
   *  this as a sign of life — Task 13.1. */
  speechEnd(): void {
    this.deps.quietGate?.noteActivity();
    // No state transition; the STT path delivers transcript() when
    // it has a final.
  }

  /** STT delivered a final transcript. Branches:
   *   - empty/whitespace → IDLE (don't bother the LLM with nothing)
   *   - has text → THINKING + start the LLM stream
   *   - state is INTERRUPTED → drop the transcript; the user is
   *     barging-in mid-utterance, the new speech.start has already
   *     queued the cleanup.
   *   - quietGate says drop → IDLE (no LLM call) — Task 13.1. */
  async transcript(text: string): Promise<void> {
    if (this.state !== "LISTENING") {
      this.log(`[loop] transcript ignored in state=${this.state}`);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      this.transition("IDLE");
      this.maybeConsumeOpportunity();
      return;
    }
    // Cap-driven suspension (Task 13.2): the daily USD cap forced
    // the loop off the voice path. Drop the transcript and bounce
    // to IDLE — the chat path keeps working but voice is silent
    // until the next local-midnight rollover clears suspension.
    if (this.suspended) {
      this.log(`[loop] transcript dropped: cap-suspended`);
      this.transition("IDLE");
      this.maybeConsumeOpportunity();
      return;
    }
    // Voice vote (Task 14.3): "good buddy" / "useful" / "shut up
    // buddy" / "wrong" are recognised by phrase-match (no LLM)
    // and logged as votes via the host's voteHandler. The
    // transcript is consumed — we don't pass it on to the LLM
    // because the user wasn't asking a question. This also keeps
    // votes out of the conversation transcript visible to later
    // turns (it would just confuse a model that didn't generate
    // the prior reply).
    if (this.deps.voteHandler) {
      const voteMatch = matchVotePhrase(trimmed);
      if (voteMatch) {
        this.log(
          `[loop] vote-phrase matched: ${voteMatch.phrase} → ${voteMatch.vote}`
        );
        try {
          await this.deps.voteHandler(voteMatch, trimmed);
        } catch (err) {
          this.log(
            `[loop] voteHandler threw: ${err instanceof Error ? err.message : err}`
          );
        }
        this.transition("IDLE");
        this.maybeConsumeOpportunity();
        return;
      }
    }
    // Auto-quiet gate (Task 13.1): when QUIET, the gate's filter
    // decides whether this transcript reaches the LLM at all. If
    // dropped, we go straight back to IDLE without touching the
    // expensive tier — no Sonnet, no Kokoro/XTTS, no telemetry-
    // visible turn. Editor activity is tracked separately by the
    // host (Session, etc) via gate.noteActivity().
    if (this.deps.quietGate) {
      const decision = this.deps.quietGate.shouldForwardTranscript(trimmed);
      if (decision.dropped) {
        this.log(
          `[loop] transcript dropped by quiet gate: ${decision.reason ?? "unknown"}`
        );
        this.transition("IDLE");
        this.maybeConsumeOpportunity();
        return;
      }
    }
    this.pendingTranscript = trimmed;
    await this.runUtterance({ trigger: "EXPLICIT_ASK", payload: { user_question: trimmed } });
  }

  /** Resolve the active quiet state, or `null` when no gate is
   *  wired. Test seam + telemetry hook. */
  quietState(): QuietState | null {
    return this.deps.quietGate?.state() ?? null;
  }

  /** Cap-driven downgrade switch (Task 13.2). When suspended=true,
   *  transcript() drops every utterance — the daily USD cap forced
   *  the buddy off the voice path. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  /** Read the suspension flag — for tests / introspection. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /** Editor-side trigger. Queued and consumed only when IDLE so we
   *  never preempt a live voice turn. Editor activity also resets
   *  the auto-quiet gate (Task 13.1). */
  enqueueOpportunity(opp: Opportunity): void {
    this.deps.quietGate?.noteActivity();
    this.opportunities.push(opp);
    this.maybeConsumeOpportunity();
  }

  /** Number of queued opportunities not yet consumed — for tests
   *  and telemetry. */
  pendingOpportunityCount(): number {
    return this.opportunities.length;
  }

  /** Block on the current utterance's settle promise (test helper).
   *  Returns immediately when no utterance is in flight. */
  async awaitSettled(): Promise<void> {
    if (this.settling) await this.settling;
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  private maybeConsumeOpportunity(): void {
    if (this.state !== "IDLE") return;
    const opp = this.opportunities.shift();
    if (!opp) return;
    void this.runUtterance(opp);
  }

  private async runUtterance(opp: Opportunity): Promise<void> {
    this.transition("THINKING");
    this.llmStreamFinished = false;
    const abort = new AbortController();
    this.llmAbort = abort;

    const settle = (async () => {
      try {
        let firstToken = true;
        const sentenceBuf = new SentenceBuffer();
        try {
          for await (const chunk of this.deps.completeUtterance(opp.payload, abort.signal)) {
            if (abort.signal.aborted) break;
            if (firstToken) {
              firstToken = false;
              this.transition("SPEAKING");
            }
            // Emit each completed sentence as soon as the buffer
            // surfaces one, so playback can start before the LLM
            // stream is done.
            for (const sentence of sentenceBuf.push(chunk)) {
              if (abort.signal.aborted) break;
              await this.deps.speakSentence(sentence);
            }
          }
          // Flush any trailing fragment as a final sentence.
          if (!abort.signal.aborted) {
            const tail = sentenceBuf.flush();
            if (tail) await this.deps.speakSentence(tail);
          }
        } catch (err) {
          this.log(`[loop] LLM stream error: ${err instanceof Error ? err.message : err}`);
        }
        this.llmStreamFinished = true;
        if (this.state === "THINKING") {
          // Stream ended without producing anything — go straight to IDLE.
          this.transition("IDLE");
          return;
        }
        if (this.state === "SPEAKING") {
          this.deps.finishUtterance();
          if (this.deps.awaitPlaybackDone) {
            try {
              await this.deps.awaitPlaybackDone();
            } catch {
              // playback errors mustn't strand the loop
            }
          }
          if (this.state === "SPEAKING") {
            this.transition("IDLE");
          }
        }
        // INTERRUPTED state is owned by speechStart()'s settling
        // promise; we don't transition out of it from here.
      } finally {
        if (this.llmAbort === abort) this.llmAbort = undefined;
        // Drain any opportunity that piled up while we were busy.
        this.maybeConsumeOpportunity();
      }
    })();

    this.settling = settle;
    await settle;
  }

  private transition(next: ConversationState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.log(`[loop] ${prev} → ${next}`);
    this.events.emit("transition", next, prev);
    // Spec invariant (header line 35-39): every path that leaves
    // SPEAKING must hard-cancel TTS so we never leak audio. The
    // SPEAKING → INTERRUPTED case is also driven via bargeIn.trigger()
    // in speechStart() (which the host typically also registers
    // cancelSpeak() into for symmetry with other cancellers), but we
    // call deps.cancelSpeak() unconditionally here so a host that
    // forgets the bargeIn.register("tts", ...) wiring still gets the
    // invariant enforced. cancelSpeak must be idempotent in the host
    // — StreamingTtsBridge.dispose() is — so a double-cancel from
    // both this path and the bargeIn fan-out is safe.
    //
    // We also catch the SPEAKING/INTERRUPTED → IDLE paths: the natural
    // finish runs after finishUtterance() drained playback, so this is
    // a defensive no-op in production. Keeping the call in is the only
    // way to make the invariant a property of the loop itself rather
    // than of the host's wiring, which is what 16.9 calls out.
    if (prev === "SPEAKING" || prev === "INTERRUPTED") {
      try {
        this.deps.cancelSpeak();
      } catch (err) {
        this.log(
          `[loop] cancelSpeak threw on ${prev}→${next}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }
}
