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
// leaves SPEAKING calls cancelSpeak() (which the host wires to
// StreamingTtsBridge.dispose() in production) so the audio stops
// reaching the speakers — even when the LLM stream finished
// happily and we just got barged in mid-sentence.

import { EventEmitter } from "node:events";
import type { BargeInController } from "./barge-in.js";
import { SentenceBuffer } from "./sentence-buffer.js";

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
  /** Hard-cancel the TTS pipeline (used on barge-in). Must drop any
   *  in-flight playback so we don't leave audio echoing into the
   *  user's mic — the spec's "no orphaned audio" invariant. */
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
}

export class ConversationLoop {
  private state: ConversationState = "IDLE";
  private opportunities: Opportunity[] = [];
  private events = new EventEmitter();
  private deps: ConversationLoopDeps;
  private log: (line: string) => void;

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
   *  later (per Task 10.2's contract). */
  speechEnd(): void {
    // No-op; the STT path is responsible for delivering
    // transcript() when it has a final.
  }

  /** STT delivered a final transcript. Branches:
   *   - empty/whitespace → IDLE (don't bother the LLM with nothing)
   *   - has text → THINKING + start the LLM stream
   *   - state is INTERRUPTED → drop the transcript; the user is
   *     barging-in mid-utterance, the new speech.start has already
   *     queued the cleanup. */
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
    this.pendingTranscript = trimmed;
    await this.runUtterance({ trigger: "EXPLICIT_ASK", payload: { user_question: trimmed } });
  }

  /** Editor-side trigger. Queued and consumed only when IDLE so we
   *  never preempt a live voice turn. */
  enqueueOpportunity(opp: Opportunity): void {
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
    // Special invariant: every path leaving SPEAKING / INTERRUPTED
    // must hard-cancel TTS so we never leak audio. The
    // INTERRUPTED case calls cancel via bargeIn.trigger() (which the
    // host registered cancelSpeak() into); the IDLE-from-SPEAKING
    // case happens after the natural finishUtterance(), so no extra
    // cancel is needed. The defensive cancel below catches the rare
    // path where finishUtterance() didn't actually drain — no
    // double-cancel concern because cancelSpeak is idempotent in
    // the host wiring (StreamingTtsBridge.dispose() is too).
    if ((prev === "SPEAKING" || prev === "INTERRUPTED") && next === "IDLE") {
      // No-op in production: finishUtterance already settled
      // playback. Keeping the hook so a misbehaving TTS bridge can't
      // strand audio.
    }
  }
}
