// Owner-only persistence for ~/.coding-buddy (#96).
//
// The buddy's state dir holds curated-sensitive data: verbatim user
// questions + buddy replies (which often quote the user's code), a
// distilled "what this developer keeps getting wrong" learner profile,
// and truncated code-excerpt samples. Created under the usual umask it
// lands 0o755 (dir) / 0o644 (files) — readable by every local user on a
// shared dev box, lab machine, or CI runner with persistent homes.
//
// The DIRECTORY mode is the load-bearing control: with the dir at
// 0o700, other non-root users have no traversal (execute) bit, so they
// cannot open any file inside it regardless of the file's own mode. The
// 0o600 file modes are defense-in-depth — they matter only if the dir
// mode is later loosened or a file is copied out.
//
// All mode bits are POSIX semantics. On Windows, Node maps `mode` to
// just the read-only attribute (0o600 keeps the write bit set, so files
// stay writable) and `chmod` is a near-no-op; these helpers therefore
// degrade cleanly to plain mkdir/write there.

import { mkdirSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * Ensure `dir` exists and is owner-only (0o700).
 *
 * `mkdirSync`'s `mode` only governs directories *this* call creates; a
 * dir that already exists (e.g. one created 0o755 before this hardening
 * shipped) keeps its current mode. So we `chmod` afterward to tighten it
 * on the next daemon start — the upgrade path. The chmod is best-effort:
 * it's a near-no-op on Windows and a hardening step must never break
 * persistence, so failures are swallowed.
 */
export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort (Windows / exotic filesystem)
  }
}

/**
 * `writeFileSync` that creates owner-only (0o600) files. The mode only
 * takes effect when the file is created; an existing file keeps its
 * mode, but the 0o700 dir already gates access either way.
 */
export function writeFileSecure(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf8",
): void {
  writeFileSync(path, data, { encoding, mode: FILE_MODE });
}

/** `appendFileSync` counterpart of {@link writeFileSecure}. */
export function appendFileSecure(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf8",
): void {
  appendFileSync(path, data, { encoding, mode: FILE_MODE });
}
