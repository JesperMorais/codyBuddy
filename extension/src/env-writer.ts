// .env updater — Task 15.8.
//
// Writes / replaces a small set of key=value lines in a .env file
// without disturbing the rest of the file (comments, ordering,
// other keys). Used by the audio-device picker, but lives here as
// a pure helper so other tasks can borrow it.
//
// Algorithm:
//   1. For each (key, value) in updates:
//      a. If a non-comment line starts with `<key>=`, replace it.
//      b. If a commented-out line `# <key>=…` exists, replace it
//         with the live form (uncommenting in place).
//      c. Otherwise, append `<key>=<value>` at the end.
//   2. Preserve trailing newline if present; otherwise add one.
//
// Idempotent: re-running with the same updates produces the same
// file content.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface EnvUpdates {
  [key: string]: string;
}

/** Apply `updates` to `.env` at `envPath`. Creates the file if
 *  missing. Returns the new file contents. */
export function updateEnvFile(envPath: string, updates: EnvUpdates): string {
  const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const next = applyEnvUpdates(original, updates);
  writeFileSync(envPath, next, "utf8");
  return next;
}

/** Pure version — no I/O. Returns the new file contents given
 *  the current contents and an updates map. */
export function applyEnvUpdates(current: string, updates: EnvUpdates): string {
  // Normalise line endings; preserve final trailing newline state.
  const hadTrailingNewline = current === "" ? true : current.endsWith("\n");
  const lines = current.split(/\r?\n/);
  // The split leaves an empty string after a trailing newline; drop
  // it so we don't re-add one when joining.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const remaining = new Set(Object.keys(updates));

  const out = lines.map((line) => {
    for (const key of remaining) {
      // Live: `KEY=...`
      const live = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
      if (live.test(line)) {
        remaining.delete(key);
        return `${key}=${updates[key]}`;
      }
      // Commented: `# KEY=...` or `#KEY=...`
      const commented = new RegExp(`^\\s*#\\s*${escapeRe(key)}\\s*=`);
      if (commented.test(line)) {
        remaining.delete(key);
        return `${key}=${updates[key]}`;
      }
    }
    return line;
  });

  // Append any keys that weren't found anywhere.
  for (const key of remaining) {
    out.push(`${key}=${updates[key]}`);
  }

  let joined = out.join("\n");
  if (hadTrailingNewline) joined += "\n";
  return joined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
