#!/usr/bin/env node
/**
 * scripts/tune-triggers.mjs
 *
 * Reads ~/.coding-buddy/votes.jsonl (or a custom path via --file) and
 * prints per-trigger up/down rates plus a suggested threshold delta:
 *
 *   - downvote rate > 50%       → suggest raising threshold (be more
 *                                  conservative, fire less often)
 *   - upvote rate   >= 75%      → suggest lowering threshold (current
 *                                  signal is well-calibrated, can fire
 *                                  more often)
 *   - otherwise                 → keep (50/50 splits land here — need
 *                                  more data, not a directional signal)
 *
 * Run: node scripts/tune-triggers.mjs [--file <path>] [--min <n>]
 *   --file  votes JSONL path (default ~/.coding-buddy/votes.jsonl)
 *   --min   ignore triggers with fewer than N total votes (default 5)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const out = { file: join(homedir(), ".coding-buddy", "votes.jsonl"), min: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--min") out.min = Number(argv[++i]) || out.min;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/tune-triggers.mjs [--file <path>] [--min <n>]\n" +
          "  --file  votes JSONL (default ~/.coding-buddy/votes.jsonl)\n" +
          "  --min   ignore triggers with < n votes (default 5)"
      );
      process.exit(0);
    }
  }
  return out;
}

export function readVotes(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function aggregate(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e || typeof e.trigger !== "string") continue;
    if (e.vote !== "up" && e.vote !== "down") continue;
    const slot = counts.get(e.trigger) ?? { trigger: e.trigger, up: 0, down: 0 };
    if (e.vote === "up") slot.up += 1;
    else slot.down += 1;
    counts.set(e.trigger, slot);
  }
  return [...counts.values()];
}

export function suggest(slot) {
  const total = slot.up + slot.down;
  if (total === 0) return { suggestion: "no data", rationale: "" };
  const downRate = slot.down / total;
  const upRate = slot.up / total;
  if (downRate > 0.5) {
    return {
      suggestion: "raise threshold",
      rationale: `${(downRate * 100).toFixed(0)}% downvotes — be more conservative`,
    };
  }
  if (upRate >= 0.75) {
    return {
      suggestion: "lower threshold",
      rationale: `${(upRate * 100).toFixed(0)}% upvotes — buddy is well-calibrated, can fire more often`,
    };
  }
  return {
    suggestion: "keep",
    rationale: `${(upRate * 100).toFixed(0)}% upvotes / ${(downRate * 100).toFixed(0)}% downvotes — within tolerance`,
  };
}

export function report(filePath, minVotes) {
  const entries = readVotes(filePath);
  const total = entries.length;
  const slots = aggregate(entries).sort((a, b) => b.up + b.down - (a.up + a.down));
  const lines = [];
  lines.push(`# Coding Buddy — trigger tuning report`);
  lines.push(`source: ${filePath}`);
  lines.push(`votes:  ${total} total across ${slots.length} triggers (min ${minVotes} per trigger to surface)`);
  lines.push("");
  if (total === 0) {
    lines.push("No votes recorded yet. Click 👍/👎 on replies in the sidebar to seed the log.");
    return lines.join("\n");
  }
  for (const slot of slots) {
    const t = slot.up + slot.down;
    if (t < minVotes) continue;
    const s = suggest(slot);
    lines.push(`${slot.trigger.padEnd(16)}  up=${slot.up} down=${slot.down}  → ${s.suggestion} (${s.rationale})`);
  }
  return lines.join("\n");
}

// Run only when invoked directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  console.log(report(args.file, args.min));
}
