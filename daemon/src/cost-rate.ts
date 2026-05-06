// Live $/hr counter — Task 13.3.
//
// Reads the per-turn telemetry log (Task 11.5) and computes the
// rolling spend rate over a configurable window. The sidebar
// pulls this via the WS `getCostRate` message and renders the
// projected $/hr on its status pill so the user has continuous
// visibility into what the buddy is actually costing them.
//
// Window semantics:
//   - Default 10 minutes — long enough to smooth over single-turn
//     burst, short enough to react when the user starts hammering
//     EXPLICIT_ASKs.
//   - Sums usd_estimate from every turn entry with ts >= now - windowMs.
//   - Projects to $/hr by spent / windowMs * 3_600_000.
//
// The module is read-only — no side effects. Read failures
// gracefully under-count rather than throw, matching DailyCostCap's
// posture.

import type { TurnTelemetry, TurnEntry } from "./turn-telemetry.js";

export interface RollingCostRateOptions {
  turnTelemetry: TurnTelemetry;
  /** Window in ms over which to sum spend. Default 10 * 60_000 (10min). */
  windowMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface CostRateSnapshot {
  /** USD spent in the rolling window. */
  spentUsd: number;
  /** Window size in ms — for sidebar tooltip / debugging. */
  windowMs: number;
  /** Hourly rate projected from the window. spent / windowMs * 3.6M. */
  ratePerHourUsd: number;
  /** Number of telemetry entries in the window. Useful for the
   *  sidebar's "calm" vs "active" rendering — same dollars from 1
   *  big turn and 100 tiny turns mean different things. */
  turnsInWindow: number;
  /** When this snapshot was computed (epoch ms). */
  computedAt: number;
}

export class RollingCostRate {
  private telemetry: TurnTelemetry;
  private windowMs: number;
  private nowFn: () => number;

  constructor(opts: RollingCostRateOptions) {
    this.telemetry = opts.turnTelemetry;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.nowFn = opts.now ?? Date.now;
  }

  /** Window size for sidebar / config display. */
  windowMillis(): number {
    return this.windowMs;
  }

  /** Compute the current snapshot. Reads the full telemetry file
   *  (turns.jsonl, usually small) and filters to entries within
   *  [now - windowMs, now]. The host can call this on a fixed
   *  cadence (sidebar polls every 5-10s, say) without a noticeable
   *  cost — the file is sequential and tiny in steady state. */
  snapshot(): CostRateSnapshot {
    const computedAt = this.nowFn();
    const cutoff = computedAt - this.windowMs;
    let spent = 0;
    let count = 0;
    let entries: TurnEntry[];
    try {
      entries = this.telemetry.read();
    } catch (err) {
      console.error("[cost-rate] telemetry read failed:", err);
      entries = [];
    }
    for (const e of entries) {
      if (typeof e.ts === "number" && e.ts >= cutoff && e.ts <= computedAt) {
        spent += e.usd_estimate ?? 0;
        count += 1;
      }
    }
    const rate =
      this.windowMs > 0 ? (spent / this.windowMs) * 3_600_000 : 0;
    return {
      spentUsd: round6(spent),
      windowMs: this.windowMs,
      ratePerHourUsd: round6(rate),
      turnsInWindow: count,
      computedAt,
    };
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
