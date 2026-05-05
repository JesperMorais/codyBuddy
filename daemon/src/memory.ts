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
  private cachedSummary = "";
  private eventsSinceSummary = 0;

  constructor(dir: string = join(homedir(), ".coding-buddy")) {
    this.dir = dir;
    this.logPath = join(dir, "memory.jsonl");
    this.summaryPath = join(dir, "memory.summary.md");
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

  paths(): { dir: string; log: string; summary: string } {
    return { dir: this.dir, log: this.logPath, summary: this.summaryPath };
  }
}
