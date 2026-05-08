// Two-tier router — Task 11.4.
//
// The conversation loop's primary cost lever. Most voice turns are
// short ("yeah", "what about the import?", "no, the other one") and
// don't need Sonnet — Haiku 4.5 handles them at a fraction of the
// cost. The router runs Haiku first; Sonnet is only invoked when:
//
//   (a) the editor trigger is one of EXPLICIT_ASK / BAD_PATH /
//       MISCONCEPTION (the user, by name, is asking for a real answer
//       — or the editor flagged something the cheap tier would
//       likely fumble),
//   (b) the editor context changed since last turn (new file,
//       new diff, new diagnostics — fresh ground that benefits from
//       the bigger model's deeper analysis),
//   (c) the rolling transcript has crossed a token threshold
//       (longer conversations earn the upgrade — harder context),
//   (d) Haiku itself returned `escalate: true` (it self-classified
//       the turn as out of its weight class).
//
// The decision is binary: each turn ends up routed to exactly one
// tier. Tests pin "Haiku says no-escalate → Sonnet never called" and
// "each escalation condition → Sonnet called exactly once."
//
// Wiring: in production the router replaces the direct
// AnthropicClient.askStream call inside the ConversationLoop's
// completeUtterance dependency. This module is decoupled from the
// loop so the routing logic can be exercised on its own.

import { createHash } from "node:crypto";

import type { BuddyReply } from "./anthropic.js";
import type { UsageRecord } from "./telemetry.js";

/** Cheap classifier+responder. The Haiku-tier verdict is one of:
 *    - {escalate: true}    → router must call Sonnet for the actual reply
 *    - {escalate: false, text} → Haiku already produced the reply
 *
 *  The production implementation is a single Haiku call instructed to
 *  reply with a short conversational answer OR the literal token
 *  "ESCALATE" if it can't handle the turn. Tests stub this directly.
 */
export interface HaikuClassifier {
  classify(payload: object, systemBlocks: string[]): Promise<HaikuVerdict>;
  /** Optional — implementers can expose the most recent classify()
   *  call's (model, usage) so the router's getLastTokenUsage() can
   *  surface it to per-turn telemetry. Stubs that don't issue API
   *  calls (e.g. AlwaysEscalateHaiku) leave this undefined. */
  getLastUsage?(): UsageRecord | undefined;
}

export type HaikuVerdict =
  | { escalate: true }
  | { escalate: false; text: string };

/** Subset of AnthropicClient the Sonnet path needs — streaming only.
 *  The chat/sidebar path keeps using `ask` directly. */
export interface StreamingResponder {
  askStream(
    systemBlocks: string[],
    payload: object,
    signal?: AbortSignal
  ): AsyncIterable<string>;
  /** Optional — see HaikuClassifier.getLastUsage. */
  getLastUsage?(): UsageRecord | undefined;
}

export interface TieredRouterOptions {
  haiku: HaikuClassifier;
  sonnet: StreamingResponder;
  /** Estimated-token threshold above which transcript size forces
   *  escalation. Default 1500 tokens (~6 KB of text). */
  transcriptTokenThreshold?: number;
  /** Pluggable token estimator (default: chars/4 — close enough for
   *  routing decisions). Tests override this with a length-equals
   *  function so threshold values stay readable. */
  estimateTokens?: (text: string) => number;
  /** Optional log hook. Telemetry (Task 11.5) will subscribe here. */
  log?: (line: string) => void;
}

export interface RouteOutcome {
  tier: "haiku" | "sonnet";
  reason: string;
}

const ESCALATING_TRIGGERS: ReadonlySet<string> = new Set([
  "EXPLICIT_ASK",
  "BAD_PATH",
  "MISCONCEPTION",
]);

interface RouterPayload {
  trigger?: string;
  active_file?: string;
  recent_diff?: string;
  diagnostics?: Array<{ message?: string }>;
  recent_chat?: Array<{ role?: string; text?: string }>;
  user_question?: string;
}

export class TieredRouter {
  private lastEditorFingerprint?: string;
  private threshold: number;
  private estimate: (text: string) => number;
  private log: (line: string) => void;
  private lastOutcome?: RouteOutcome;

  constructor(private opts: TieredRouterOptions) {
    this.threshold = opts.transcriptTokenThreshold ?? 1500;
    this.estimate = opts.estimateTokens ?? defaultEstimate;
    this.log = opts.log ?? (() => {});
  }

  /** Pure inspection: does the payload alone (no Haiku call needed)
   *  force Sonnet? Conditions (a), (b), (c). Returns the reason so
   *  telemetry can attribute escalations. */
  shouldEscalateUpfront(payload: object): { escalate: boolean; reason: string } {
    const p = payload as RouterPayload;
    if (p.trigger && ESCALATING_TRIGGERS.has(p.trigger)) {
      return { escalate: true, reason: `trigger=${p.trigger}` };
    }
    const fp = editorFingerprint(p);
    if (this.lastEditorFingerprint !== undefined && fp !== this.lastEditorFingerprint) {
      return { escalate: true, reason: "editor_context_changed" };
    }
    const tokens = this.estimateTranscriptTokens(p);
    if (tokens > this.threshold) {
      return { escalate: true, reason: "transcript_token_threshold" };
    }
    return { escalate: false, reason: "" };
  }

  /** Route one conversational turn. Yields text deltas from whichever
   *  tier handles it. The editor fingerprint is updated after the
   *  turn so the *next* call can detect context drift via (b). */
  async *route(
    systemBlocks: string[],
    payload: object,
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const upfront = this.shouldEscalateUpfront(payload);
    if (upfront.escalate) {
      this.lastOutcome = { tier: "sonnet", reason: upfront.reason };
      this.log(`[router] sonnet (${upfront.reason})`);
      try {
        for await (const chunk of this.opts.sonnet.askStream(systemBlocks, payload, signal)) {
          yield chunk;
        }
      } finally {
        this.updateFingerprint(payload);
      }
      return;
    }

    const verdict = await this.opts.haiku.classify(payload, systemBlocks);
    if (verdict.escalate) {
      this.lastOutcome = { tier: "sonnet", reason: "haiku_flagged_escalate" };
      this.log(`[router] sonnet (haiku_flagged_escalate)`);
      try {
        for await (const chunk of this.opts.sonnet.askStream(systemBlocks, payload, signal)) {
          yield chunk;
        }
      } finally {
        this.updateFingerprint(payload);
      }
      return;
    }

    this.lastOutcome = { tier: "haiku", reason: "no_escalation" };
    this.log(`[router] haiku`);
    try {
      yield verdict.text;
    } finally {
      this.updateFingerprint(payload);
    }
  }

  /** Last routing decision — for telemetry / tests. Undefined before
   *  the first route() call. */
  getLastOutcome(): RouteOutcome | undefined {
    return this.lastOutcome;
  }

  /** Combined token usage for the most recent turn, pulling from the
   *  optional `getLastUsage` hooks the classifier and responder may
   *  expose — Task 16.1.2. The audio host reads this in its
   *  recordTurn() to populate haikuModel/haikuUsage/sonnetModel/
   *  sonnetUsage on the turns.jsonl entry. Either field may be
   *  undefined: stub classifiers and Ollama (which doesn't yet
   *  surface usage) skip cleanly. */
  getLastTokenUsage(): { haiku?: UsageRecord; sonnet?: UsageRecord } {
    const result: { haiku?: UsageRecord; sonnet?: UsageRecord } = {};
    const haikuUsage = this.opts.haiku.getLastUsage?.();
    if (haikuUsage) result.haiku = haikuUsage;
    const sonnetUsage = this.opts.sonnet.getLastUsage?.();
    if (sonnetUsage) result.sonnet = sonnetUsage;
    return result;
  }

  private estimateTranscriptTokens(p: RouterPayload): number {
    const turns = p.recent_chat ?? [];
    const text =
      turns.map((t) => t.text ?? "").join("\n") +
      (p.user_question ? `\n${p.user_question}` : "");
    return this.estimate(text);
  }

  private updateFingerprint(payload: object): void {
    this.lastEditorFingerprint = editorFingerprint(payload as RouterPayload);
  }
}

/** Diffs longer than this are summarized by length+SHA-256 instead of
 *  embedding their full text in the fingerprint string. Keeps the
 *  fingerprint bounded (~80 bytes) on long edits while preserving the
 *  "any change flips the hash" semantics: a single-byte tweak inside
 *  a 50KB diff still flips the digest. Threshold chosen so typical
 *  voice-turn payloads (a few lines of context) keep the cheap path
 *  with no hashing — only outliers pay the cost.
 *
 *  Task 16.19 — bound fingerprint memory for long diffs. */
const DIFF_HASH_THRESHOLD_BYTES = 4 * 1024;

function summarizeDiff(diff: string): string {
  // Byte length, not character length, since the threshold is meant
  // as a memory bound on the fingerprint string itself.
  if (Buffer.byteLength(diff, "utf8") <= DIFF_HASH_THRESHOLD_BYTES) {
    return diff;
  }
  // The "sha256:" prefix keeps short diffs that happen to look like a
  // 64-char hex string from colliding with the hashed branch.
  return `sha256:${createHash("sha256").update(diff).digest("hex")}`;
}

/** Stable signature of the editor-context-bearing fields. Anything
 *  observably different between two turns flips the fingerprint and
 *  triggers escalation (b). */
function editorFingerprint(p: RouterPayload): string {
  const file = p.active_file ?? "";
  const diff = p.recent_diff ?? "";
  const diags = (p.diagnostics ?? []).map((d) => d.message ?? "").join("|");
  return `${file}::${diff.length}::${summarizeDiff(diff)}::${diags}`;
}

function defaultEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Helper for callers that need the same shape ConversationLoop
 *  currently expects from completeUtterance: a function that takes
 *  (payload, signal) and returns AsyncIterable<string>. Wraps a
 *  router so the loop can plug it in without referencing systemBlocks
 *  on every turn — those come from Session.buildSystemBlocks. */
export function asCompleteUtterance(
  router: TieredRouter,
  getSystemBlocks: () => string[]
): (payload: object, signal: AbortSignal) => AsyncIterable<string> {
  return (payload, signal) => router.route(getSystemBlocks(), payload, signal);
}

// Re-export for clarity at call sites.
export type { BuddyReply };
