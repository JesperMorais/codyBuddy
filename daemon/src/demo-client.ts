// Demo mode AI client — Task 15.4.
//
// Canned-reply implementation of the AiClient interface. Lets a new
// user hear / see a real voice turn before they've configured an
// Anthropic API key. The daemon picks this client when
// BUDDY_DEMO=true and ANTHROPIC_API_KEY is unset / placeholder.
//
// Replies rotate through CANNED_REPLIES so consecutive triggers
// don't repeat. The list is intentionally small (~10 entries) and
// in-character with what a tutor-mode buddy would actually say —
// the goal is "hear the voice", not "fool the user into thinking
// it's Claude". The sidebar watermark documents that.

import type { AiClient, BuddyReply, SpeakDecision } from "./anthropic.js";
import type { MisconceptionMap } from "./memory.js";

export const CANNED_REPLIES: ReadonlyArray<string> = [
  "I'm running in demo mode — these replies are canned, not from Claude. Add ANTHROPIC_API_KEY to .env and restart the daemon to switch on the real thing.",
  "What problem are you actually trying to solve here? Sometimes the bug isn't where the symptom is.",
  "Walk me through what you've tried so far. Even a wrong attempt narrows the search space.",
  "Could you read me the type the compiler is complaining about? Often the fix becomes obvious once it's in your ear.",
  "If you had to bet, which line is the one that's misbehaving? Trust your gut — even a 30% guess beats none.",
  "Have you printed the value at the boundary between the part you trust and the part you don't?",
  "What's the smallest test that would prove your hypothesis right or wrong?",
  "Sometimes the loop is the right place to ask: what is changing here that shouldn't be?",
  "Take a sip of water. Tell me again what this function is supposed to return.",
  "When this works, what's the first observable thing that'll be different?",
];

export interface DemoClientOptions {
  /** Override the rotation index — for tests. Defaults to 0. */
  startIndex?: number;
  /** Override the canned-reply list — for tests. */
  replies?: ReadonlyArray<string>;
  /** Stable model name used in telemetry-style fields. Defaults
   *  to "demo". The daemon's per-turn telemetry log will see
   *  this in the model field so demo turns are clearly labelled. */
  model?: string;
}

/**
 * Implements AiClient with rotating canned replies. shouldSpeak
 * always returns "speak" so demo turns route through the TTS path
 * (the user came here to hear the buddy). summarize and
 * distillLearnerProfile return brief deterministic strings so the
 * downstream paths still work.
 */
export class DemoClient implements AiClient {
  private idx: number;
  private replies: ReadonlyArray<string>;
  private model: string;

  constructor(opts: DemoClientOptions = {}) {
    this.idx = opts.startIndex ?? 0;
    this.replies = opts.replies ?? CANNED_REPLIES;
    this.model = opts.model ?? "demo";
  }

  /** Number of canned replies. */
  size(): number {
    return this.replies.length;
  }

  async shouldSpeak(_payload: object, _summary: string): Promise<SpeakDecision> {
    return "speak";
  }

  async ask(
    _systemBlocks: string[],
    _sessionSummary: string,
    _triggerPayload: object
  ): Promise<BuddyReply> {
    const text = this.replies[this.idx % this.replies.length];
    this.idx = (this.idx + 1) % this.replies.length;
    return { mode: "speak", text, wants_followup: false };
  }

  async *askStream(
    _systemBlocks: string[],
    _triggerPayload: object,
    _signal?: AbortSignal
  ): AsyncIterable<string> {
    const text = this.replies[this.idx % this.replies.length];
    this.idx = (this.idx + 1) % this.replies.length;
    // Yield the whole string as one chunk — the SentenceBuffer
    // adapter (Task 11.2) will split it on terminator boundaries.
    yield text;
  }

  async summarize(_transcript: string): Promise<string> {
    return "(demo mode — no real summary)";
  }

  async distillLearnerProfile(
    _history: string,
    priorProfile: string,
    _misconceptions: MisconceptionMap = {}
  ): Promise<string> {
    return priorProfile || "(demo mode — no real profile yet)";
  }

  /** Read the model label — used by tests + the per-turn telemetry
   *  wiring once 11.5 records demo turns. */
  modelName(): string {
    return this.model;
  }
}
