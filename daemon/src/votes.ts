/**
 * Append-only thumbs-up / thumbs-down log. One JSON line per vote.
 * Used by scripts/tune-triggers.mjs to compute per-trigger up/down
 * rates and suggest threshold deltas.
 *
 * Persistence is best-effort — disk failures are logged but never
 * thrown so a vote click never breaks the live UI.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type VoteValue = "up" | "down";

export interface VoteEntry {
  ts: number;
  trigger: string;
  reply_text: string;
  vote: VoteValue;
}

export const DEFAULT_VOTES_PATH = join(homedir(), ".coding-buddy", "votes.jsonl");

export class VoteStore {
  constructor(private filePath: string = DEFAULT_VOTES_PATH) {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  record(entry: { trigger: string; reply_text: string; vote: VoteValue }): VoteEntry {
    const row: VoteEntry = {
      ts: Date.now(),
      trigger: String(entry.trigger),
      reply_text: String(entry.reply_text ?? ""),
      vote: entry.vote === "down" ? "down" : "up",
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(row) + "\n", "utf8");
    } catch (err) {
      console.error("[votes] write failed:", err);
    }
    return row;
  }

  read(): VoteEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as VoteEntry;
        } catch {
          return null;
        }
      })
      .filter((v): v is VoteEntry => v !== null);
  }

  path(): string {
    return this.filePath;
  }
}
