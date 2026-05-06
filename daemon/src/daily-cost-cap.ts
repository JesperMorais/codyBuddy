// Daily USD cap — Task 13.2.
//
// Aggregates the per-turn telemetry log (Task 11.5) into a "spent so
// far today" number and compares it against a configured cap. When
// the cap is hit, the host downgrades to chat-only:
//   - TtsBridge.setSuspended(true) — synth calls become no-ops
//   - ConversationLoop.setSuspended(true) — transcripts are dropped
//   - Sidebar surfaces the state via the existing modeAck path
// "Until midnight local" means the cap auto-recovers on the next
// local-day boundary because every status() call recomputes the
// spend from telemetry entries timestamped >= today's local midnight.
//
// The module is read-only: it never modifies telemetry; it just
// scans. Wiring (calling setSuspended on bridge / loop) is the
// host's job — keeps this module trivially testable.

import type { TurnEntry, TurnTelemetry } from "./turn-telemetry.js";

export interface DailyCostCapOptions {
  /** Cap in USD. When today's spend ≥ cap, status().hit = true.
   *  Default 5.00 (matches BUDDY_DAILY_USD spec default). */
  capUsd?: number;
  /** Telemetry source to scan. Required. */
  turnTelemetry: TurnTelemetry;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface CapStatus {
  spentUsd: number;
  capUsd: number;
  hit: boolean;
  /** ISO date (YYYY-MM-DD, local) for which the spend is computed. */
  forDate: string;
  /** When this status was computed (epoch ms). */
  computedAt: number;
}

export class DailyCostCap {
  private cap: number;
  private telemetry: TurnTelemetry;
  private nowFn: () => number;

  constructor(opts: DailyCostCapOptions) {
    this.cap = opts.capUsd ?? 5.0;
    this.telemetry = opts.turnTelemetry;
    this.nowFn = opts.now ?? Date.now;
  }

  /** Cap value (USD). For sidebar display / telemetry. */
  cap_usd(): number {
    return this.cap;
  }

  /** Compute today's spend and the hit/not-hit verdict. Reads the
   *  full telemetry file and filters by today's local midnight —
   *  reasonable for now (turns.jsonl is small). If we ever need
   *  this on a hot path the host can cache the status with a
   *  small TTL. */
  status(): CapStatus {
    const computedAt = this.nowFn();
    const startOfDay = startOfLocalDay(computedAt);
    let spent = 0;
    const entries = this.safeRead();
    for (const e of entries) {
      if (typeof e.ts === "number" && e.ts >= startOfDay) {
        spent += e.usd_estimate ?? 0;
      }
    }
    return {
      spentUsd: round6(spent),
      capUsd: this.cap,
      hit: spent >= this.cap,
      forDate: localDateIso(computedAt),
      computedAt,
    };
  }

  /** Convenience boolean wrapper around status(). */
  isHit(): boolean {
    return this.status().hit;
  }

  private safeRead(): TurnEntry[] {
    try {
      return this.telemetry.read();
    } catch (err) {
      // Read failures are not fatal — better to under-count and
      // potentially exceed cap by a turn than to crash the daemon.
      console.error("[daily-cap] telemetry read failed:", err);
      return [];
    }
  }
}

/** Apply a hit-cap downgrade to the bridges that should suspend.
 *  Pure helper that calls each suspendable's setSuspended(value).
 *  Lets tests verify wiring without spawning the full daemon. */
export interface Suspendable {
  setSuspended(suspended: boolean): void;
}

export function applyCapDowngrade(
  status: CapStatus,
  suspendables: Suspendable[]
): void {
  for (const s of suspendables) {
    s.setSuspended(status.hit);
  }
}

/** Local-time midnight (this morning) in epoch ms. */
function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** YYYY-MM-DD in local time. */
function localDateIso(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
