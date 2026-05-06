import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MemoryEvent {
  ts: number;
  mode: string;
  trigger: string;
  file?: string;
  user_question?: string;
  reply_text: string;
}

/** One row in the misconception map, keyed by anti-pattern name. */
export interface MisconceptionRecord {
  count: number;
  last_seen: number;
  sample?: string;
}

export type MisconceptionMap = Record<string, MisconceptionRecord>;

export class MemoryStore {
  private dir: string;
  private logPath: string;
  private summaryPath: string;
  private mutePath: string;
  private misconceptionsPath: string;
  private personalityPath: string;
  private cachedSummary = "";
  private eventsSinceSummary = 0;

  constructor(dir: string = join(homedir(), ".coding-buddy")) {
    this.dir = dir;
    this.logPath = join(dir, "memory.jsonl");
    this.summaryPath = join(dir, "memory.summary.md");
    this.mutePath = join(dir, "mute.json");
    this.misconceptionsPath = join(dir, "misconceptions.json");
    this.personalityPath = join(dir, "personality.json");
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.summaryPath)) {
      this.cachedSummary = readFileSync(this.summaryPath, "utf8");
    }
  }

  append(event: MemoryEvent): void {
    appendFileSync(this.logPath, JSON.stringify(event) + "\n", "utf8");
    this.eventsSinceSummary += 1;
  }

  shouldRefresh(every = 20): boolean {
    return this.eventsSinceSummary >= every;
  }

  markRefreshed(): void {
    this.eventsSinceSummary = 0;
  }

  getSummary(): string {
    return this.cachedSummary;
  }

  setSummary(text: string): void {
    this.cachedSummary = text.trim();
    writeFileSync(this.summaryPath, this.cachedSummary, "utf8");
  }

  loadRecent(limit = 50): MemoryEvent[] {
    if (!existsSync(this.logPath)) return [];
    const raw = readFileSync(this.logPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    const out: MemoryEvent[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as MemoryEvent);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }

  /**
   * Returns the persisted mute deadline (epoch ms). 0 means "not muted".
   * Stale values that have already elapsed are ignored — the file may be
   * stale across daemon restarts and we don't want to revive expired mutes.
   */
  getMutedUntil(): number {
    if (!existsSync(this.mutePath)) return 0;
    try {
      const raw = readFileSync(this.mutePath, "utf8");
      const parsed = JSON.parse(raw) as { mutedUntil?: number };
      const ts = Number(parsed.mutedUntil ?? 0);
      if (!Number.isFinite(ts) || ts <= Date.now()) return 0;
      return ts;
    } catch {
      return 0;
    }
  }

  /**
   * Persists the mute deadline. Pass 0 (or any non-positive value) to clear it.
   * Disk write failures are swallowed: muting still works in-memory; the
   * persisted state is best-effort.
   */
  setMutedUntil(ts: number): void {
    const value = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
    try {
      writeFileSync(this.mutePath, JSON.stringify({ mutedUntil: value }), "utf8");
    } catch {
      // best effort
    }
  }

  /**
   * Increments the count for `pattern` and refreshes its `last_seen`.
   * Stores `sample` only if the slot is currently empty so we keep the
   * earliest concrete example without bloating the file across thousands
   * of repeats. Persistence is best-effort — write failures are logged
   * but never thrown so the live trigger path stays clean.
   */
  recordMisconception(pattern: string, sample?: string): MisconceptionRecord {
    const map = this.getMisconceptions();
    const existing = map[pattern];
    const next: MisconceptionRecord = existing
      ? {
          count: existing.count + 1,
          last_seen: Date.now(),
          sample: existing.sample ?? sample,
        }
      : { count: 1, last_seen: Date.now(), sample };
    map[pattern] = next;
    try {
      writeFileSync(this.misconceptionsPath, JSON.stringify(map, null, 2), "utf8");
    } catch (err) {
      console.error("[memory] misconception write failed", err);
    }
    return next;
  }

  getMisconceptions(): MisconceptionMap {
    if (!existsSync(this.misconceptionsPath)) return {};
    try {
      const raw = readFileSync(this.misconceptionsPath, "utf8");
      return JSON.parse(raw) as MisconceptionMap;
    } catch {
      return {};
    }
  }

  /**
   * Returns the persisted personality name, or null if nothing was ever
   * written. Unlike mute, there is no notion of "stale" — a chosen
   * personality should ride across daemon restarts indefinitely.
   * Validation against the actual loaded personalities map is the
   * caller's responsibility (Session does this in its constructor).
   */
  getPersonality(): string | null {
    if (!existsSync(this.personalityPath)) return null;
    try {
      const raw = readFileSync(this.personalityPath, "utf8");
      const parsed = JSON.parse(raw) as { personality?: unknown };
      const value = parsed.personality;
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** Persists the chosen personality. Best-effort — disk failures are
   *  swallowed so the in-memory choice is unaffected. */
  setPersonality(name: string): void {
    try {
      writeFileSync(this.personalityPath, JSON.stringify({ personality: name }), "utf8");
    } catch {
      // best effort
    }
  }

  /** Returns the persisted shuffle flag (random-personality mode), or
   *  null if nothing was ever written. Kept separate from
   *  personality.json because shuffle is orthogonal to the
   *  user's preferred seed personality. */
  getShuffle(): boolean | null {
    const path = join(this.dir, "shuffle.json");
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { shuffle?: unknown };
      if (typeof parsed.shuffle === "boolean") return parsed.shuffle;
      return null;
    } catch {
      return null;
    }
  }

  /** Persists the shuffle flag. Best-effort — disk failures are
   *  swallowed so the in-memory toggle is unaffected. */
  setShuffle(value: boolean): void {
    try {
      writeFileSync(join(this.dir, "shuffle.json"), JSON.stringify({ shuffle: value }), "utf8");
    } catch {
      // best effort
    }
  }

  paths(): {
    dir: string;
    log: string;
    summary: string;
    mute: string;
    misconceptions: string;
    personality: string;
    shuffle: string;
  } {
    return {
      dir: this.dir,
      log: this.logPath,
      summary: this.summaryPath,
      mute: this.mutePath,
      misconceptions: this.misconceptionsPath,
      personality: this.personalityPath,
      shuffle: join(this.dir, "shuffle.json"),
    };
  }
}
