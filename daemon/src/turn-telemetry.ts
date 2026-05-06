// Per-turn telemetry — Task 11.5.
//
// The existing Telemetry (telemetry.ts) is per-API-call: every
// AnthropicClient.ask / shouldSpeak / askStream / summarize / distill
// appends one line with that single response's token usage. That's
// great for low-level audits but it doesn't roll up into "what did
// THIS conversational turn actually cost me?" — turns can hit one or
// both tiers, accumulate cache reads, and the cost-discipline
// machinery in Phase 13 needs a turn-shaped record.
//
// This module owns that turn shape:
//   - which tier(s) ran (haiku always; sonnet on escalation)
//   - aggregated and per-tier token counts (input / output / cache)
//   - USD estimate for the whole turn
//   - end-to-end latency (turn start → final reply ready)
//   - the buddy state at the time: wake-word mode, personality, mode
//
// Everything is appended as JSONL to the same `~/.coding-buddy/`
// directory the per-call telemetry uses, but to a separate file so
// downstream readers (cost-cap watcher, sidebar $/hr counter) can
// scan turns without filtering by `method`. JSONL with multiple
// shapes is fine in principle, but a single-shape file is cheaper to
// stream and easier to reason about.
//
// Pricing constants below are an approximation, kept in code rather
// than fetched live so the cost estimate is deterministic and
// CI-stable. They're meant to be tuned via PR when Anthropic adjusts
// list prices.

import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { UsageLike } from "./telemetry.js";

export const DEFAULT_TURN_TELEMETRY_PATH = join(
  homedir(),
  ".coding-buddy",
  "turns.jsonl"
);

/** USD per million tokens. Approximation of Anthropic's published list
 *  prices; tune by PR when rates change. Cache reads are charged at
 *  10% of base input; cache creations at 125%. */
export const PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cache_read: number; cache_creation: number }
> = {
  "claude-haiku-4-5-20251001": {
    input: 1.0,
    output: 5.0,
    cache_read: 0.1,
    cache_creation: 1.25,
  },
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cache_read: 0.1,
    cache_creation: 1.25,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_creation: 3.75,
  },
  // Conservative fallback (Sonnet rates) so unknown models don't
  // silently report $0 — better to over-estimate than under-estimate.
  default: {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_creation: 3.75,
  },
};

export function estimateUsd(model: string, usage: UsageLike): number {
  const rate = PRICING_USD_PER_MTOK[model] ?? PRICING_USD_PER_MTOK.default;
  return (
    ((usage.input_tokens ?? 0) * rate.input) / 1_000_000 +
    ((usage.output_tokens ?? 0) * rate.output) / 1_000_000 +
    ((usage.cache_read_input_tokens ?? 0) * rate.cache_read) / 1_000_000 +
    ((usage.cache_creation_input_tokens ?? 0) * rate.cache_creation) /
      1_000_000
  );
}

/** Caller-supplied turn data. `haikuUsage` is omitted when the router
 *  escalated upfront and never invoked Haiku; `sonnetUsage` is omitted
 *  when Haiku handled the turn alone. */
export interface TurnInput {
  /** Override clock for tests. Defaults to Date.now(). */
  ts?: number;
  /** Haiku model id (e.g. "claude-haiku-4-5-20251001"). Omitted on
   *  upfront-escalation turns where Haiku was skipped. */
  haikuModel?: string;
  haikuUsage?: UsageLike;
  /** Sonnet model id. Omitted when Haiku handled the turn alone. */
  sonnetModel?: string;
  sonnetUsage?: UsageLike;
  /** TieredRouter.RouteOutcome.reason. */
  routerReason: string;
  /** Wall-clock ms from turn start to final reply ready. */
  endToEndMs: number;
  /** BUDDY_WAKEWORD setting at the time of the turn. */
  wakeWord: string;
  /** Active personality (e.g. "nice", "drill_sergeant"). */
  personality: string;
  /** Active mode (e.g. "tutor", "reviewer"). */
  mode: string;
}

export interface TurnEntry {
  ts: number;
  method: "turn";
  haiku_tier: boolean;
  sonnet_tier: boolean;
  router_reason: string;
  haiku_model: string | null;
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  haiku_cache_read_input_tokens: number;
  haiku_cache_creation_input_tokens: number;
  sonnet_model: string | null;
  sonnet_input_tokens: number;
  sonnet_output_tokens: number;
  sonnet_cache_read_input_tokens: number;
  sonnet_cache_creation_input_tokens: number;
  /** Aggregated across both tiers (sum), so cost rollups don't have
   *  to add the two halves themselves. */
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  usd_estimate: number;
  end_to_end_ms: number;
  wake_word: string;
  personality: string;
  mode: string;
}

/**
 * Append-only per-turn log. One JSON line per conversational turn.
 * Disk-write failures are logged but never thrown — the live trigger
 * path mustn't be blocked by a telemetry failure (matches the
 * existing Telemetry contract).
 */
export class TurnTelemetry {
  constructor(private filePath: string = DEFAULT_TURN_TELEMETRY_PATH) {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {
      // Same posture as Telemetry: never fatal here. Append will
      // surface the real error per-call.
    }
  }

  /** Build the entry, append it, return it. The return is mostly for
   *  tests / wiring code; production callers can ignore it. */
  record(input: TurnInput): TurnEntry {
    const haiku = normalize(input.haikuUsage);
    const sonnet = normalize(input.sonnetUsage);
    const usd =
      (input.haikuModel
        ? estimateUsd(input.haikuModel, input.haikuUsage ?? {})
        : 0) +
      (input.sonnetModel
        ? estimateUsd(input.sonnetModel, input.sonnetUsage ?? {})
        : 0);

    const entry: TurnEntry = {
      ts: input.ts ?? Date.now(),
      method: "turn",
      haiku_tier: !!input.haikuModel,
      sonnet_tier: !!input.sonnetModel,
      router_reason: input.routerReason,
      haiku_model: input.haikuModel ?? null,
      haiku_input_tokens: haiku.input,
      haiku_output_tokens: haiku.output,
      haiku_cache_read_input_tokens: haiku.cache_read,
      haiku_cache_creation_input_tokens: haiku.cache_creation,
      sonnet_model: input.sonnetModel ?? null,
      sonnet_input_tokens: sonnet.input,
      sonnet_output_tokens: sonnet.output,
      sonnet_cache_read_input_tokens: sonnet.cache_read,
      sonnet_cache_creation_input_tokens: sonnet.cache_creation,
      input_tokens: haiku.input + sonnet.input,
      output_tokens: haiku.output + sonnet.output,
      cache_read_input_tokens: haiku.cache_read + sonnet.cache_read,
      cache_creation_input_tokens:
        haiku.cache_creation + sonnet.cache_creation,
      usd_estimate: round6(usd),
      end_to_end_ms: input.endToEndMs,
      wake_word: input.wakeWord,
      personality: input.personality,
      mode: input.mode,
    };

    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      console.error("[turn-telemetry] write failed:", err);
    }
    return entry;
  }

  /** Read all turns from disk. Empty array when the file doesn't
   *  exist yet. Used by Phase 13's cost-cap watcher and the sidebar
   *  $/hr counter. */
  read(): TurnEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TurnEntry);
  }

  path(): string {
    return this.filePath;
  }
}

interface NormalizedUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

function normalize(u?: UsageLike): NormalizedUsage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cache_read: u?.cache_read_input_tokens ?? 0,
    cache_creation: u?.cache_creation_input_tokens ?? 0,
  };
}

/** USD estimates round to 6 decimal places — sub-microcent precision
 *  is noise, but truncating to fewer drops sub-cent costs. */
function round6(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
