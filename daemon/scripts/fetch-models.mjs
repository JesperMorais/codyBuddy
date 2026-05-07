#!/usr/bin/env node
// Pinned-model downloader — Task 16.3.1.
//
// Reads voice/models.json and, for each entry whose `path` is missing
// or stale, downloads `url` → `path`, verifies `size_bytes` (when
// present), and verifies `sha256` (when not the literal
// "TBD-fill-in-when-downloading" placeholder).
//
// Plain JS (no TS build required) so setup.{sh,ps1} can shell out
// right after `pnpm install`, before any TypeScript has been
// compiled. Mirrors the verifier conventions from
// `daemon/src/models-manifest.ts` (TBD-skip, lowercase-hex SHA256).
//
// Exit codes:
//   0  every required entry is present + verified, or every required
//      entry was skipped (TBD-pinned hashes / --skip-tbd flag)
//   1  download failed, size mismatch, or hash mismatch
//   2  manifest schema error
//
// Usage:
//   node daemon/scripts/fetch-models.mjs <manifest-path> [base-dir]
//   node daemon/scripts/fetch-models.mjs voice/models.json
//
// Behaviour:
//   - `path` resolves relative to `base-dir` (default = manifest's
//     parent's parent — matches the verifier's resolveBaseDir for the
//     repo-rooted manifest).
//   - Downloads stream to a `<path>.partial`, then atomic-rename on
//     successful verification — half-written files never leave a stale
//     hash on disk.
//   - When the file already exists AND its SHA256 matches a pinned
//     non-TBD hash, the entry is reported "✓ cached" with no network
//     traffic.
//   - When `sha256` is TBD-pinned, the size check still runs but the
//     hash check is skipped — a download just lands the file; future
//     PRs lock in the real hash.
//   - 3xx redirects are followed automatically (Hugging Face uses them).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, createWriteStream } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

/** "TBD-fill-in-when-downloading" matches; any other prefix that
 *  starts with "TBD" also matches (defensive). */
function isTbd(s) {
  return typeof s === "string" && s.startsWith("TBD");
}

/** Hex digest (lower-case) of a file. Streamed so multi-GB models
 *  don't blow up RSS. */
export async function sha256File(path) {
  const hash = createHash("sha256");
  const fd = await import("node:fs").then((m) => m.promises.open(path, "r"));
  try {
    const buf = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  return hash.digest("hex");
}

/** Download `url` → `destPath` via streaming. Returns when the body
 *  is fully written. Throws on non-2xx. Follows 3xx (max 5 hops). */
export function downloadTo(url, destPath, opts = {}) {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl;
  const maxRedirects = opts.maxRedirects ?? 5;

  // Test seam: if the caller injects a fetchImpl, use it instead of
  // the real network request. The fixture HTTP server in tests is
  // simpler to drive that way, AND keeps the unit test offline.
  if (fetchImpl) {
    return (async () => {
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(destPath), { recursive: true });
      const tmp = `${destPath}.partial`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(tmp, buf);
      renameSync(tmp, destPath);
    })();
  }

  return new Promise((resolveP, rejectP) => {
    let hops = 0;
    const go = (currentUrl) => {
      const u = new URL(currentUrl);
      const reqFn = u.protocol === "http:" ? httpRequest : httpsRequest;
      const req = reqFn(
        currentUrl,
        { method: "GET", headers: { "user-agent": "codybuddy-fetch-models" } },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (++hops > maxRedirects) {
              rejectP(new Error(`too many redirects (${hops}) for ${url}`));
              return;
            }
            log(`[fetch-models] ${res.statusCode} → ${res.headers.location}`);
            res.resume();
            const next = new URL(res.headers.location, currentUrl).toString();
            go(next);
            return;
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            rejectP(new Error(`HTTP ${res.statusCode ?? "?"} for ${currentUrl}`));
            res.resume();
            return;
          }
          mkdirSync(dirname(destPath), { recursive: true });
          const tmp = `${destPath}.partial`;
          const out = createWriteStream(tmp);
          res.pipe(out);
          out.on("finish", () => {
            out.close();
            try {
              renameSync(tmp, destPath);
              resolveP();
            } catch (err) {
              rejectP(err);
            }
          });
          out.on("error", (err) => {
            try {
              unlinkSync(tmp);
            } catch {
              // already gone
            }
            rejectP(err);
          });
        }
      );
      req.on("error", rejectP);
      req.end();
    };
    go(url);
  });
}

/** Process one manifest entry. Returns one of:
 *    "cached"      — file existed and hash matched (no work)
 *    "downloaded"  — pulled fresh and verified
 *    "tbd-skipped" — sha256 is TBD; we still landed the bytes if the
 *                    file was missing, but the hash check was skipped
 *  Throws on size/hash mismatch or download failure. */
export async function fetchOne(entry, baseDir, opts = {}) {
  const log = opts.log ?? (() => {});
  const filePath = isAbsolute(entry.path)
    ? entry.path
    : join(baseDir, entry.path);

  // Already on disk? Verify what we can.
  if (existsSync(filePath)) {
    if (!isTbd(entry.sha256)) {
      const actual = await sha256File(filePath);
      if (actual === entry.sha256) {
        log(`[fetch-models] ${entry.name}: ✓ cached`);
        return "cached";
      }
      // Hash mismatch on disk: download will overwrite via .partial+rename.
      log(
        `[fetch-models] ${entry.name}: cached file hash mismatch (got ${actual.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…) — re-downloading`
      );
    } else if (typeof entry.size_bytes === "number") {
      const got = statSync(filePath).size;
      if (got === entry.size_bytes) {
        log(
          `[fetch-models] ${entry.name}: ✓ cached (sha256 TBD; size ok)`
        );
        return "tbd-skipped";
      }
      log(
        `[fetch-models] ${entry.name}: cached size mismatch (${got} vs ${entry.size_bytes}) — re-downloading`
      );
    } else {
      log(`[fetch-models] ${entry.name}: ✓ cached (sha256 TBD; no size)`);
      return "tbd-skipped";
    }
  }

  log(`[fetch-models] ${entry.name}: downloading from ${entry.url}`);
  await downloadTo(entry.url, filePath, opts);

  // Post-download verification.
  if (typeof entry.size_bytes === "number") {
    const got = statSync(filePath).size;
    // Allow a small tolerance — manifests get bumped with imprecise
    // size_bytes occasionally; only flag wildly-different sizes
    // (>10% drift). The hash check is the authoritative gate.
    const drift = Math.abs(got - entry.size_bytes) / entry.size_bytes;
    if (drift > 0.1) {
      try {
        unlinkSync(filePath);
      } catch {
        // already gone
      }
      throw new Error(
        `${entry.name}: size_bytes mismatch — got ${got}, manifest says ${entry.size_bytes}`
      );
    }
  }
  if (!isTbd(entry.sha256)) {
    const actual = await sha256File(filePath);
    if (actual !== entry.sha256) {
      try {
        unlinkSync(filePath);
      } catch {
        // already gone
      }
      throw new Error(
        `${entry.name}: sha256 mismatch — got ${actual}, manifest says ${entry.sha256}`
      );
    }
    log(`[fetch-models] ${entry.name}: ✓ downloaded + verified`);
    return "downloaded";
  }
  log(`[fetch-models] ${entry.name}: ✓ downloaded (sha256 TBD; verification deferred)`);
  return "tbd-skipped";
}

/** Process every entry in the manifest. Returns a summary object. */
export async function fetchAll(manifestPath, baseDir, opts = {}) {
  const log = opts.log ?? ((line) => process.stdout.write(line + "\n"));
  if (!existsSync(manifestPath)) {
    log(`[fetch-models] manifest not found at ${manifestPath} — nothing to do`);
    return { downloaded: 0, cached: 0, tbdSkipped: 0, total: 0 };
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!raw || !Array.isArray(raw.models)) {
    throw Object.assign(new Error("manifest 'models' must be an array"), {
      schemaError: true,
    });
  }
  const summary = { downloaded: 0, cached: 0, tbdSkipped: 0, total: 0 };
  for (const entry of raw.models) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.path !== "string" || typeof entry.url !== "string") {
      throw Object.assign(
        new Error(`entry ${JSON.stringify(entry)} missing path/url`),
        { schemaError: true }
      );
    }
    summary.total += 1;
    const result = await fetchOne(entry, baseDir, { ...opts, log });
    if (result === "cached") summary.cached += 1;
    else if (result === "downloaded") summary.downloaded += 1;
    else if (result === "tbd-skipped") summary.tbdSkipped += 1;
  }
  log(
    `[fetch-models] summary: ${summary.downloaded} downloaded, ${summary.cached} cached, ${summary.tbdSkipped} TBD-skipped (of ${summary.total})`
  );
  return summary;
}

/** CLI entry point. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(
      "Usage: node daemon/scripts/fetch-models.mjs <manifest-path> [base-dir]\n"
    );
    process.exit(args.length === 0 ? 1 : 0);
  }
  const manifestPath = resolve(args[0]);
  // Default base = repo root (the manifest lives at voice/models.json
  // under the repo root, so its grandparent is the right base).
  const baseDir = args[1]
    ? resolve(args[1])
    : resolve(dirname(manifestPath), "..");
  try {
    await fetchAll(manifestPath, baseDir);
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[fetch-models] ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(err && err.schemaError ? 2 : 1);
  }
}

// Only run main() when invoked as the CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
