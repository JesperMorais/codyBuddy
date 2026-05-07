// Pinned model manifest verifier — Task 15.10.
//
// Reads voice/models.json, walks every entry, and SHA256-hashes
// each file that actually exists on disk. A mismatch refuses
// startup with `model checksum mismatch: <name>` so a corrupted
// download doesn't quietly serve garbage tokens. Missing files
// are skipped — chat-only installs don't need any of them, so
// requiring presence would lock chat users out.
//
// Manifest TBD-prefixed sha256 values are treated as a
// "not pinned yet" sentinel and skipped (with a one-line warning)
// so the manifest can land before every individual model has been
// downloaded + hashed by a maintainer. Every TBD must be replaced
// before that model's release-zip ships.
//
// Setup scripts (Task 15.1) read the same manifest to drive
// downloads — symmetric verification on read.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ModelManifestEntry {
  name: string;
  version: string;
  /** Repo-relative path the daemon reads from. */
  path: string;
  /** HTTPS URL the setup script downloads from. */
  url: string;
  /** Lower-case hex SHA256. The literal "TBD-fill-in-when-downloading"
   *  (or any string starting with "TBD") is a placeholder and skipped. */
  sha256: string;
  size_bytes?: number;
  license?: string;
  engine?: string;
  /** Free-text note. */
  comment?: string;
}

export interface ModelManifest {
  models: ModelManifestEntry[];
  comment?: string;
}

export class ManifestSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestSchemaError";
  }
}

export class ModelChecksumError extends Error {
  constructor(public modelName: string, public expected: string, public actual: string, public path: string) {
    super(
      `model checksum mismatch: ${modelName}. expected ${expected}, got ${actual} at ${path}. ` +
        `Re-run setup.{ps1,sh} or delete ${path} and let the installer redownload.`
    );
    this.name = "ModelChecksumError";
  }
}

/** Parse + validate a manifest object. Throws ManifestSchemaError
 *  on shape violations (missing fields, wrong types). */
export function parseManifest(raw: unknown): ModelManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestSchemaError("manifest root must be an object");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.models)) {
    throw new ManifestSchemaError("manifest.models must be an array");
  }
  const models: ModelManifestEntry[] = [];
  for (const [i, m] of (r.models as unknown[]).entries()) {
    if (typeof m !== "object" || m === null) {
      throw new ManifestSchemaError(`models[${i}] must be an object`);
    }
    const e = m as Record<string, unknown>;
    for (const required of ["name", "version", "path", "url", "sha256"]) {
      if (typeof e[required] !== "string" || (e[required] as string).length === 0) {
        throw new ManifestSchemaError(
          `models[${i}].${required} must be a non-empty string`
        );
      }
    }
    if (e.size_bytes !== undefined && typeof e.size_bytes !== "number") {
      throw new ManifestSchemaError(
        `models[${i}].size_bytes must be a number (or omitted)`
      );
    }
    models.push({
      name: e.name as string,
      version: e.version as string,
      path: e.path as string,
      url: e.url as string,
      sha256: e.sha256 as string,
      size_bytes: e.size_bytes as number | undefined,
      license: e.license as string | undefined,
      engine: e.engine as string | undefined,
      comment: e.comment as string | undefined,
    });
  }
  return {
    models,
    comment: typeof r.comment === "string" ? r.comment : undefined,
  };
}

/** Read + parse a manifest from disk. Returns null when the
 *  manifest doesn't exist (chat-only / pre-15.10 installs). */
export function loadManifest(manifestPath: string): ModelManifest | null {
  if (!existsSync(manifestPath)) return null;
  const text = readFileSync(manifestPath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ManifestSchemaError(
      `manifest at ${manifestPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return parseManifest(raw);
}

/** SHA256-hash a file as lowercase hex. */
export function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Verify every manifest entry whose file is on disk. Skips
 *  TBD-pinned entries and missing files. Throws ModelChecksumError
 *  on the FIRST mismatch — partial verification doesn't help when
 *  one model is bad, the daemon mustn't run.
 *
 *  baseDir: how to resolve relative `path` fields. Production
 *  passes the repo root. Tests pass the tmpdir holding the
 *  fixture files. Absolute `path` values are honored as-is. */
export interface VerifyResult {
  checked: number;
  skipped_tbd: number;
  skipped_missing: number;
  total: number;
}

export function verifyManifest(
  manifest: ModelManifest,
  baseDir: string
): VerifyResult {
  let checked = 0;
  let skippedTbd = 0;
  let skippedMissing = 0;

  for (const m of manifest.models) {
    if (m.sha256.startsWith("TBD")) {
      skippedTbd += 1;
      continue;
    }
    const filePath = isAbsolute(m.path) ? m.path : resolve(baseDir, m.path);
    if (!existsSync(filePath)) {
      skippedMissing += 1;
      continue;
    }
    // Optional size check first — much cheaper than full SHA256
    // and catches the most common "interrupted download" symptom.
    if (typeof m.size_bytes === "number") {
      const actualSize = statSync(filePath).size;
      if (actualSize !== m.size_bytes) {
        throw new ModelChecksumError(
          m.name,
          `${m.size_bytes}B`,
          `${actualSize}B`,
          filePath
        );
      }
    }
    const actual = sha256File(filePath);
    if (actual.toLowerCase() !== m.sha256.toLowerCase()) {
      throw new ModelChecksumError(m.name, m.sha256, actual, filePath);
    }
    checked += 1;
  }

  return {
    checked,
    skipped_tbd: skippedTbd,
    skipped_missing: skippedMissing,
    total: manifest.models.length,
  };
}

/** Convenience helper: locate manifest relative to a starting dir
 *  by walking up until `voice/models.json` is found. Returns the
 *  absolute path or null. The daemon uses this so it works from
 *  both the dev-time daemon/dist/ location and the SEA bundle's
 *  next-to-the-binary layout (Task 15.6). */
export function findManifest(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "voice", "models.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
