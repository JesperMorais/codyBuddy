import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Subset of Anthropic SDK usage we care about. Every field defaults to 0 so
 *  callers can pass partial objects without guarding each call site. */
export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A `(model, usage)` pair surfaced by clients/classifiers to consumers
 *  that want to record per-turn telemetry — Task 16.1.2. The model id
 *  is included so the consumer (TurnTelemetry / RollingCostRate) can
 *  apply the right per-million-token pricing without guessing. */
export interface UsageRecord {
  model: string;
  usage: UsageLike;
}

export interface TelemetryEntry {
  ts: number;
  method: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const DEFAULT_TELEMETRY_PATH = join(homedir(), ".coding-buddy", "telemetry.jsonl");

/**
 * Append-only token-usage log. One JSON line per API response. Disk write
 * failures are logged but never thrown — telemetry must not break the
 * primary buddy round-trip.
 */
export class Telemetry {
  constructor(private filePath: string = DEFAULT_TELEMETRY_PATH) {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  record(method: string, model: string, usage: UsageLike): void {
    const entry: TelemetryEntry = {
      ts: Date.now(),
      method,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      console.error("[telemetry] write failed:", err);
    }
  }

  read(): TelemetryEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TelemetryEntry);
  }

  path(): string {
    return this.filePath;
  }
}
