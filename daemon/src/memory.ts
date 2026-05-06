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

export class MemoryStore {
  private dir: string;
  private logPath: string;
  private summaryPath: string;
  private mutePath: string;
  private cachedSummary = "";
  private eventsSinceSummary = 0;

  constructor(dir: string = join(homedir(), ".coding-buddy")) {
    this.dir = dir;
    this.logPath = join(dir, "memory.jsonl");
    this.summaryPath = join(dir, "memory.summary.md");
    this.mutePath = join(dir, "mute.json");
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

  paths(): { dir: string; log: string; summary: string; mute: string } {
    return {
      dir: this.dir,
      log: this.logPath,
      summary: this.summaryPath,
      mute: this.mutePath,
    };
  }
}
