// Audio host — Task 16.1.
//
// Composes the Phase 10/11/13 voice-loop primitives into a single
// runtime that the daemon entry point can boot when
// `BUDDY_VOICE_LOOP=on`. Without this module, all of:
//
//   ConversationLoop · VadBridge · StreamingSttBridge · StreamingTtsBridge
//   BargeInController · TieredRouter · TurnTelemetry
//
// ship as classes with green unit tests but are never instantiated
// at runtime. This is the minimum viable wiring that produces ONE
// turns.jsonl line per completed voice turn — matching the spec's
// MVP bar in TASKS.md item 16.1.
//
// Deliberately deferred to 16.1.x sub-items (still listed in TASKS.md):
//   - Real audio device wiring (mic → VAD WS, TTS chunks → speaker)
//   - Sidebar status pill driven by loop transitions

import { ConversationLoop, type ConversationState } from "./conversation.js";
import { BargeInController } from "./barge-in.js";
import type {
  HaikuClassifier,
  HaikuVerdict,
  RouteOutcome,
} from "./tiered-router.js";
import type { TurnTelemetry } from "./turn-telemetry.js";
import type { UsageRecord } from "./telemetry.js";
import type { WakeWordGate } from "./wake-word.js";
import type { BackchannelController } from "./backchannel.js";
import type { AutoQuietGate } from "./auto-quiet.js";
import {
  applyCapDowngrade,
  type CapStatus,
  type DailyCostCap,
  type Suspendable,
} from "./daily-cost-cap.js";

/** Narrow shape of VadBridge that the host actually uses. Tests
 *  pass a tiny fake; production passes the real bridge. */
export interface VadEventSource {
  onSpeechStart(h: (ts: number) => void): void;
  onSpeechEnd(h: (ts: number) => void): void;
}

/** Narrow shape of StreamingSttBridge the host uses. */
export interface SttEventSource {
  onFinal(
    h: (text: string, source: "engine" | "promoted") => void
  ): void;
}

/** Narrow shape of StreamingTtsBridge the host uses. The conversation
 *  loop's speakSentence/finishUtterance/cancelSpeak deps map 1:1 to
 *  these methods. */
export interface TtsSink {
  feedSentence(text: string, voice?: string): void;
  finish(): void;
  dispose(): void;
}

/** Anything `route()`-shaped with a getLastOutcome accessor. The
 *  real TieredRouter satisfies this; tests can stub it. */
export interface RouterWithOutcome {
  route(
    systemBlocks: string[],
    payload: object,
    signal?: AbortSignal
  ): AsyncIterable<string>;
  getLastOutcome(): RouteOutcome | undefined;
  /** Optional — see TieredRouter.getLastTokenUsage. When absent or
   *  returning empty, the host writes a turn entry with zero token
   *  counts (the 16.1 MVP behaviour). When present, haiku/sonnet
   *  model + usage are surfaced into the per-turn telemetry entry —
   *  Task 16.1.2. */
  getLastTokenUsage?(): { haiku?: UsageRecord; sonnet?: UsageRecord };
}

export interface AudioHostDeps {
  vad: VadEventSource;
  stt: SttEventSource;
  tts: TtsSink;
  router: RouterWithOutcome;
  turnTelemetry: TurnTelemetry;
  /** Optional pre-built barge-in controller. If omitted the host
   *  instantiates one and registers `tts.dispose` as the "tts"
   *  canceller. Tests can pass a custom instance to inspect it. */
  bargeIn?: BargeInController;
  /** Returns the system blocks for the next utterance — typically
   *  `[conversationalModePrompt, personalityOverlay]`. The host
   *  doesn't own conversational prompt loading; `index.ts` does. */
  getSystemBlocks: () => string[];
  /** Returns the active mode name (e.g. "tutor"). Used for telemetry. */
  getMode: () => string;
  /** Returns the active personality name. Used for telemetry. */
  getPersonality: () => string;
  /** Returns the BUDDY_WAKEWORD value at turn time. Used for
   *  telemetry. The actual gating of transcripts is performed by
   *  the optional `wakeWordGate` dep below — Task 16.1.3. */
  getWakeWord: () => string;
  /** Optional wake-word gate (Task 16.1.3). When provided, every
   *  STT final passes through `gate.forward(text)` before reaching
   *  the loop: gated transcripts are dropped, the wake-word phrase
   *  itself is stripped from the forwarded text. Omitted (the 16.1
   *  MVP behaviour) means open-mic — every final lands at
   *  loop.transcript verbatim. */
  wakeWordGate?: WakeWordGate;
  /** Optional backchannel controller (Task 16.1.4). When provided,
   *  the host:
   *    - drives `notifyState` from every loop transition,
   *    - drives `notifySpeechStart` / `notifySpeechEnd` from VAD,
   *    - calls `tick()` on a periodic timer (default 100ms; pass
   *      `backchannelTickMs: 0` to disable the host-driven timer
   *      and tick externally — useful for tests).
   *  Omitted preserves the 16.1 MVP behaviour (no backchannel). */
  backchannel?: BackchannelController;
  /** Tick interval in ms for the BackchannelController. Default
   *  100ms — fast enough that the speech-duration crossing the
   *  3s threshold is observed within one frame. 0 disables the
   *  host-driven setInterval (tests drive `tick()` manually). */
  backchannelTickMs?: number;
  /** Optional auto-quiet gate (Task 16.1.5). When provided, STT
   *  finals also pass through `gate.shouldForwardTranscript(text)`
   *  before reaching the loop. After 5min of silence the gate
   *  drops to QUIET; transcripts under 24 chars (or missing the
   *  configured wake-word) are dropped until activity resumes.
   *  VAD speech-start fires `noteActivity` so a returning user
   *  resumes immediately. Omitted preserves the 16.1 MVP
   *  always-forward behaviour. */
  autoQuiet?: AutoQuietGate;
  /** Optional daily-cost cap (Task 16.1.6). When provided, the host
   *  consults `cap.status()` after every per-turn telemetry append
   *  and, on a hit-edge or clear-edge transition, calls
   *  `applyCapDowngrade(status, [loop, ...capSuspendables])` so the
   *  voice loop AND any extra suspendables (typically the chat-path
   *  TtsBridge) flip suspension together. The host fires
   *  `onCapStateChange` on each transition so the wiring layer can
   *  broadcast a `capState` WS event and persist to disk. Omitting
   *  the cap preserves the prior behaviour (no enforcement). */
  dailyCostCap?: DailyCostCap;
  /** Extra suspendables to flip alongside the host-owned
   *  ConversationLoop on cap-state transitions. Production passes
   *  the chat-path TtsBridge here so a voice-driven cap-hit also
   *  silences chat replies. */
  capSuspendables?: Suspendable[];
  /** Fires once per cap-state transition (hit-edge AND clear-edge).
   *  The host calls it with the fresh status; the wiring layer
   *  broadcasts `{type: "capState", state: "hit"|"ok", ...}` and
   *  writes ~/.coding-buddy/daily-cost.json. */
  onCapStateChange?: (status: CapStatus) => void;
  log?: (line: string) => void;
}

/**
 * Always-escalate Haiku stub. The TieredRouter requires a
 * HaikuClassifier; until 16.1.x ships a real one (Haiku call that
 * returns `{escalate, text}`), every turn flows straight to Sonnet
 * via the upfront `editor_context_changed` / `trigger=…` checks or
 * — failing those — this stub. The router still records the route
 * reason correctly so telemetry can attribute the (lack of)
 * cheap-tier savings.
 */
export class AlwaysEscalateHaiku implements HaikuClassifier {
  async classify(): Promise<HaikuVerdict> {
    return { escalate: true };
  }
}

export class AudioHost {
  private loop: ConversationLoop;
  private bargeIn: BargeInController;
  private turnStartedAt = 0;
  /** setInterval handle for the BackchannelController tick (16.1.4).
   *  Held so dispose() can clear it. Undefined when the controller
   *  isn't wired or `backchannelTickMs === 0`. */
  private backchannelTimer?: NodeJS.Timeout;
  /** Last observed cap-hit state. `undefined` = never checked yet,
   *  so the first observed status counts as a transition iff it's
   *  a hit (ensures boot-time hits notify the wiring layer). */
  private lastCapHit?: boolean;

  constructor(private deps: AudioHostDeps) {
    const log = deps.log ?? (() => {});
    this.bargeIn = deps.bargeIn ?? new BargeInController({ log });
    // Always register the tts canceller — barge-in cancellation must
    // stop in-flight playback even if the caller forgot to.
    this.bargeIn.register("tts", () => deps.tts.dispose());

    this.loop = new ConversationLoop({
      bargeIn: this.bargeIn,
      completeUtterance: (payload, signal) =>
        deps.router.route(deps.getSystemBlocks(), payload, signal),
      speakSentence: async (s) => {
        deps.tts.feedSentence(s);
      },
      finishUtterance: () => deps.tts.finish(),
      cancelSpeak: () => deps.tts.dispose(),
      log,
    });

    deps.vad.onSpeechStart(() => {
      this.loop.speechStart();
      // Task 16.1.4: drive backchannel from VAD speech-start.
      deps.backchannel?.notifySpeechStart();
      // Task 16.1.5: speech-start is a sign of life — resets the
      // auto-quiet silence countdown so a returning user doesn't
      // get filtered on their first transcript.
      deps.autoQuiet?.noteActivity();
    });
    deps.vad.onSpeechEnd(() => {
      this.loop.speechEnd();
      deps.backchannel?.notifySpeechEnd();
      // Spec also says speech-end resumes the gate; noteActivity is
      // idempotent so calling it on both edges keeps the silence
      // window aligned with reality.
      deps.autoQuiet?.noteActivity();
    });
    deps.stt.onFinal((text) => {
      // Task 16.1.3: gate STT finals through the optional wake-word
      // gate before the loop sees them. The gate handles three
      // states: "off" (every transcript passes), "gated" (drop
      // unless the wake-word phrase is in the text — strip it on
      // forward), "armed" (pass everything for 30s after the last
      // hit, bumping the deadline on each follow-up). Omitting the
      // gate dep preserves the 16.1 MVP open-mic behaviour.
      const forwarded = deps.wakeWordGate
        ? deps.wakeWordGate.forward(text).text
        : text;
      if (forwarded === null) return;
      // Task 16.1.5: after the wake-word gate clears the transcript
      // for the LLM-forwarding path, also consult the auto-quiet
      // gate. After 5min of silence the gate enters QUIET and drops
      // short transcripts (likely VAD misfires or backchannel
      // murmurs); the first long transcript or a noteActivity()
      // call resumes ACTIVE. Both gates are independently optional
      // — omitting either restores the previous layer's behaviour.
      if (deps.autoQuiet) {
        const decision = deps.autoQuiet.shouldForwardTranscript(forwarded);
        if (decision.dropped) return;
      }
      // The conversation loop is async-safe with respect to
      // transcript() — fire-and-forget is fine.
      void this.loop.transcript(forwarded);
    });

    this.loop.onTransition((next, prev) => {
      // Task 16.1.4: keep the backchannel controller in sync with
      // the loop's state. notifyState is idempotent and cheap;
      // forwarding every transition preserves its per-segment latch.
      deps.backchannel?.notifyState(next);
      this.observeTransition(prev, next);
    });

    // Task 16.1.4: periodic tick so the controller can fire when
    // the user has been speaking >3s. Production default 100ms;
    // tests pass 0 to disable and tick manually.
    const tickMs = deps.backchannelTickMs ?? 100;
    if (deps.backchannel && tickMs > 0) {
      this.backchannelTimer = setInterval(() => {
        deps.backchannel?.tick();
      }, tickMs);
      this.backchannelTimer.unref?.();
    }
  }

  /** Tear down host-owned timers. Production has no clean shutdown
   *  path today (daemon exits on SIGINT and Node reaps timers), but
   *  tests need this to keep the test runner from hanging on the
   *  setInterval reference. */
  dispose(): void {
    if (this.backchannelTimer) {
      clearInterval(this.backchannelTimer);
      this.backchannelTimer = undefined;
    }
  }

  private observeTransition(
    prev: ConversationState,
    next: ConversationState
  ): void {
    // Start the wall clock the moment a turn begins (LISTENING for a
    // voice turn, THINKING for an opportunity-only turn that skips
    // LISTENING per the loop's contract).
    if (
      prev === "IDLE" &&
      (next === "LISTENING" || next === "THINKING")
    ) {
      this.turnStartedAt = Date.now();
      return;
    }
    // Record on the two state-machine paths that *complete* a turn:
    // SPEAKING → IDLE (natural finish) and INTERRUPTED → LISTENING
    // (barge-in mid-turn). The latter still counts — the user got a
    // partial reply, the cost was real.
    if (
      (prev === "SPEAKING" && next === "IDLE") ||
      (prev === "INTERRUPTED" && next === "LISTENING")
    ) {
      this.recordTurn();
    }
  }

  private recordTurn(): void {
    if (this.turnStartedAt === 0) return;
    const endToEndMs = Date.now() - this.turnStartedAt;
    this.turnStartedAt = 0;
    const outcome = this.deps.router.getLastOutcome();
    // Task 16.1.2: pull haiku/sonnet usage from the router so the
    // turn entry carries accurate token counts and TurnTelemetry can
    // compute a real usd_estimate (instead of always-zero, which is
    // what the 16.1 MVP shipped). Routers without the optional
    // getLastTokenUsage hook degrade to zero counts cleanly.
    const usage = this.deps.router.getLastTokenUsage?.() ?? {};
    try {
      this.deps.turnTelemetry.record({
        routerReason: outcome?.reason ?? "",
        endToEndMs,
        haikuModel: usage.haiku?.model,
        haikuUsage: usage.haiku?.usage,
        sonnetModel: usage.sonnet?.model,
        sonnetUsage: usage.sonnet?.usage,
        wakeWord: this.deps.getWakeWord(),
        personality: this.deps.getPersonality(),
        mode: this.deps.getMode(),
      });
    } catch (err) {
      // Telemetry is best-effort — match the rest of the codebase.
      this.deps.log?.(
        `[audio-host] turn telemetry append failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    this.observeCapAfterTurn();
  }

  /** Task 16.1.6: post-turn daily-cap check. Reads the cap status
   *  (which itself rescans today's telemetry — the line we just
   *  appended is included) and, on a hit-edge or clear-edge
   *  transition, suspends/resumes the host-owned loop plus any
   *  extra suspendables. Fires onCapStateChange on every transition
   *  so the wiring layer can persist to disk and broadcast WS. No-op
   *  when no cap is wired. */
  private observeCapAfterTurn(): void {
    const cap = this.deps.dailyCostCap;
    if (!cap) return;
    let status: CapStatus;
    try {
      status = cap.status();
    } catch (err) {
      this.deps.log?.(
        `[audio-host] cap status read failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    if (this.lastCapHit === status.hit) return;
    this.lastCapHit = status.hit;
    const suspendables: Suspendable[] = [
      this.loop,
      ...(this.deps.capSuspendables ?? []),
    ];
    applyCapDowngrade(status, suspendables);
    try {
      this.deps.onCapStateChange?.(status);
    } catch (err) {
      this.deps.log?.(
        `[audio-host] onCapStateChange threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /** Test hook: current loop state. */
  getState(): ConversationState {
    return this.loop.getState();
  }

  /** Test hook: wait for in-flight settle (matches loop API). */
  awaitSettled(): Promise<void> {
    return this.loop.awaitSettled();
  }
}
