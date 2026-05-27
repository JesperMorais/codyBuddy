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

import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensureSecureDir, appendFileSecure } from "./secure-store.js";
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
  // Conservative fallback (Sonnet rates) so unknown *Anthropic* models
  // don't silently report $0 — better to over-estimate than
  // under-estimate when a hosted model id rolls over (e.g. a new
  // claude-sonnet-X-X-YYYYMMDD pin lands before the table is updated).
  default: {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_creation: 3.75,
  },
};

/** Task 16.7(c): Ollama / OpenAI-compatible local model ids are
 *  shaped `<name>:<tag>` (e.g. `qwen2.5-coder:32b`, `llama3.1:8b`).
 *  These run on the user's hardware and have no per-token cost, so
 *  pricing them at the Sonnet fallback shows fictional dollar amounts
 *  to local users once turn telemetry is wired. The shape check is
 *  conservative — Anthropic model ids never contain `:`. */
function isLocalModel(model: string): boolean {
  return model.includes(":");
}

export function estimateUsd(model: string, usage: UsageLike): number {
  // Task 16.7(c): local models are free at the per-token level.
  if (isLocalModel(model)) return 0;
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
      ensureSecureDir(dirname(this.filePath));
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
      appendFileSecure(this.filePath, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("[turn-telemetry] write failed:", err);
    }
    return entry;
  }

  /** Read all turns from disk. Empty array when the file doesn't
   *  exist yet. Used by Phase 13's cost-cap watcher and the sidebar
   *  $/hr counter.
   *
   *  Per-line tolerance (issue #141): a single malformed line — caused
   *  by a mid-write crash, a disk-full at a chunk boundary, manual
   *  edits, or a future schema migration reading an older file — must
   *  not nuke the entire read. DailyCostCap.safeRead and
   *  RollingCostRate.snapshot wrap this call in try/catch and fall
   *  back to an empty entries array on any throw, which silently
   *  disables the cap and zeros the $/hr pill. We mirror
   *  MemoryStore.loadRecent's posture: skip bad lines, keep the rest.
   *  One log per call (capped to the first bad-line index) so
   *  operators can find/repair the file without flooding stderr. */
  read(): TurnEntry[] {
    if (!existsSync(this.filePath)) return [];
    const out: TurnEntry[] = [];
    let firstBadIndex = -1;
    let badCount = 0;
    const lines = readFileSync(this.filePath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as TurnEntry);
      } catch {
        badCount += 1;
        if (firstBadIndex < 0) firstBadIndex = i;
      }
    }
    if (badCount > 0) {
      console.error(
        `[turn-telemetry] skipped ${badCount} malformed line(s) in ${this.filePath} (first at line ${firstBadIndex + 1})`
      );
    }
    return out;
  }

  /** Read only the trailing window of the file, capped at `maxBytes`.
   *  Useful for callers (RollingCostRate) that only need the last few
   *  minutes of entries — keeps cost O(maxBytes) regardless of total
   *  file size, so a long-lived daemon doesn't re-parse a many-MB
   *  log on every poll.
   *
   *  Strategy: stat → read the last `maxBytes` of the file → drop the
   *  leading partial line (the boundary mid-line) → parse the rest with
   *  the same per-line tolerance as `read()`. Entries strictly older
   *  than the requested window may still be returned (the cap is on
   *  bytes, not on entries) so callers should still filter by `ts`.
   *
   *  Tradeoff: a window that's *bigger* than the bytes covered by
   *  `maxBytes` will under-count (real entries inside the window were
   *  trimmed at the head). Pick a `maxBytes` budget several orders of
   *  magnitude larger than typical per-window entry volume; for the
   *  cost-rate use case (~30-90 turns per 10-min window, ~250 bytes
   *  per JSONL line ≈ 25KB), 256KB is a 10× safety factor.
   *
   *  Task 16.19 — bound RollingCostRate read cost. */
  readTail(maxBytes: number): TurnEntry[] {
    if (maxBytes <= 0) return [];
    if (!existsSync(this.filePath)) return [];
    const size = statSync(this.filePath).size;
    if (size === 0) return [];
    const readBytes = Math.min(size, Math.floor(maxBytes));
    const offset = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    const fd = openSync(this.filePath, "r");
    try {
      let total = 0;
      while (total < readBytes) {
        const n = readSync(
          fd,
          buf,
          total,
          readBytes - total,
          offset + total
        );
        if (n === 0) break;
        total += n;
      }
      // total may be < readBytes only if the file shrank under us
      // (unlikely for an append-only log). Slice to what we got.
      const text = buf.toString("utf8", 0, total);
      // Drop the leading partial line whenever we didn't read from the
      // very start — without that we'd try to JSON.parse the tail of a
      // truncated record and log a spurious "skipped malformed" line.
      const startsAtFile = offset === 0;
      const newlineIdx = text.indexOf("\n");
      const usable =
        startsAtFile || newlineIdx < 0 ? text : text.slice(newlineIdx + 1);
      const out: TurnEntry[] = [];
      let firstBadIndex = -1;
      let badCount = 0;
      const lines = usable.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as TurnEntry);
        } catch {
          badCount += 1;
          if (firstBadIndex < 0) firstBadIndex = i;
        }
      }
      if (badCount > 0) {
        console.error(
          `[turn-telemetry] skipped ${badCount} malformed line(s) in ${this.filePath} tail (first at offset-line ${firstBadIndex + 1})`
        );
      }
      return out;
    } finally {
      closeSync(fd);
    }
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
