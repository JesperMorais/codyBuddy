// Task 15.10: pinned model manifest tests.
//
// Spec: "corrupt a model file on disk, daemon exits with
//        `model checksum mismatch: <name>` and a clear remediation hint."
//
// Coverage:
//   (a) parseManifest schema validation
//   (b) verifyManifest: corrupt file → throws ModelChecksumError
//       with the spec'd message; missing file skipped; TBD-pinned
//       entry skipped; matching file passes; size-mismatch caught
//       before SHA256.
//   (c) findManifest walks up from a sub-directory.
//   (d) The shipped voice/models.json parses cleanly.
//
// Run: node --test daemon/test/models-manifest.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const {
  parseManifest,
  loadManifest,
  verifyManifest,
  findManifest,
  ManifestSchemaError,
  ModelChecksumError,
  sha256File,
} = await import("../dist/models-manifest.js");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "buddy-15.10-"));
}

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// --- (a) parseManifest schema validation ------------------------

test("15.10 (a) parseManifest accepts a well-formed object", () => {
  const m = parseManifest({
    models: [
      {
        name: "n",
        version: "1",
        path: "p",
        url: "https://x/y",
        sha256: "abcd",
      },
    ],
  });
  assert.equal(m.models.length, 1);
  assert.equal(m.models[0].name, "n");
});

test("15.10 (a) parseManifest rejects non-object root", () => {
  for (const bad of [null, "x", 42, [1, 2]]) {
    assert.throws(() => parseManifest(bad), ManifestSchemaError);
  }
});

test("15.10 (a) parseManifest rejects missing required fields", () => {
  for (const missing of ["name", "version", "path", "url", "sha256"]) {
    const entry = {
      name: "n",
      version: "1",
      path: "p",
      url: "https://x",
      sha256: "abc",
    };
    delete entry[missing];
    assert.throws(
      () => parseManifest({ models: [entry] }),
      ManifestSchemaError
    );
  }
});

test("15.10 (a) parseManifest rejects empty-string required fields", () => {
  assert.throws(
    () =>
      parseManifest({
        models: [
          { name: "", version: "1", path: "p", url: "u", sha256: "s" },
        ],
      }),
    /name must be a non-empty string/
  );
});

test("15.10 (a) parseManifest rejects non-numeric size_bytes", () => {
  assert.throws(
    () =>
      parseManifest({
        models: [
          {
            name: "n",
            version: "1",
            path: "p",
            url: "u",
            sha256: "s",
            size_bytes: "huge",
          },
        ],
      }),
    /size_bytes must be a number/
  );
});

// --- (b) verifyManifest -----------------------------------------

test("15.10 (b) corrupt file throws ModelChecksumError with the spec'd message", () => {
  const root = tempRoot();
  const filePath = join(root, "models", "fake.bin");
  mkdirSync(dirname(filePath), { recursive: true });
  // Ship a known body so we can pin its sha256.
  const body = Buffer.from("the real model bytes");
  writeFileSync(filePath, body);
  const realSha = sha256Buf(body);
  // Now corrupt it on disk.
  writeFileSync(filePath, Buffer.from("garbage replacement"));

  const manifest = parseManifest({
    models: [
      {
        name: "kokoro-v1.0",
        version: "1.0",
        path: "models/fake.bin",
        url: "https://example.com/fake.bin",
        sha256: realSha,
      },
    ],
  });

  let caught;
  try {
    verifyManifest(manifest, root);
    assert.fail("expected throw");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ModelChecksumError);
  // Spec wording: "model checksum mismatch: <name>".
  assert.match(caught.message, /^model checksum mismatch: kokoro-v1\.0/);
  // Remediation hint:
  assert.match(caught.message, /Re-run setup\.\{ps1,sh\}|installer redownload/);
  assert.equal(caught.modelName, "kokoro-v1.0");
});

test("15.10 (b) matching file passes verification", () => {
  const root = tempRoot();
  const filePath = join(root, "voice", "kokoro.onnx");
  mkdirSync(dirname(filePath), { recursive: true });
  const body = Buffer.from("clean model bytes");
  writeFileSync(filePath, body);
  const sha = sha256Buf(body);

  const manifest = parseManifest({
    models: [
      {
        name: "kokoro",
        version: "1.0",
        path: "voice/kokoro.onnx",
        url: "u",
        sha256: sha,
        size_bytes: body.length,
      },
    ],
  });
  const result = verifyManifest(manifest, root);
  assert.equal(result.checked, 1);
  assert.equal(result.skipped_tbd, 0);
  assert.equal(result.skipped_missing, 0);
});

test("15.10 (b) missing file is skipped (chat-only install path)", () => {
  const root = tempRoot();
  const manifest = parseManifest({
    models: [
      {
        name: "absent",
        version: "1",
        path: "voice/never-downloaded.onnx",
        url: "u",
        sha256: "abc",
      },
    ],
  });
  const result = verifyManifest(manifest, root);
  assert.equal(result.checked, 0);
  assert.equal(result.skipped_missing, 1);
});

test("15.10 (b) TBD-pinned sha256 is skipped (manifest pre-population)", () => {
  const root = tempRoot();
  const filePath = join(root, "tmp.bin");
  writeFileSync(filePath, Buffer.from("anything"));
  const manifest = parseManifest({
    models: [
      {
        name: "preview",
        version: "0.1",
        path: "tmp.bin",
        url: "u",
        sha256: "TBD-fill-in-when-downloading",
      },
    ],
  });
  const result = verifyManifest(manifest, root);
  assert.equal(result.skipped_tbd, 1);
  assert.equal(result.checked, 0);
});

test("15.10 (b) size mismatch is caught before SHA256", () => {
  const root = tempRoot();
  const filePath = join(root, "size.bin");
  writeFileSync(filePath, Buffer.from("x".repeat(100)));
  const manifest = parseManifest({
    models: [
      {
        name: "wrong-size",
        version: "1",
        path: "size.bin",
        url: "u",
        sha256: "abc",
        size_bytes: 99,
      },
    ],
  });
  let caught;
  try {
    verifyManifest(manifest, root);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ModelChecksumError);
  assert.match(caught.message, /99B/);
  assert.match(caught.message, /100B/);
});

test("15.10 (b) absolute paths in manifest are honored as-is", () => {
  const root = tempRoot();
  const filePath = join(root, "abs.bin");
  const body = Buffer.from("abs body");
  writeFileSync(filePath, body);
  const sha = sha256Buf(body);

  const manifest = parseManifest({
    models: [
      {
        name: "abs",
        version: "1",
        // Absolute path — verifier shouldn't prepend baseDir.
        path: filePath,
        url: "u",
        sha256: sha,
      },
    ],
  });
  // baseDir different from the file's location — proves
  // the absolute path is honored.
  const result = verifyManifest(manifest, tempRoot());
  assert.equal(result.checked, 1);
});

// --- (c) findManifest --------------------------------------------

test("15.10 (c) findManifest walks up from a deep subdirectory", () => {
  // The shipped manifest at repo-root/voice/models.json should be
  // found from any nested directory under the repo.
  const path = findManifest(join(repoRoot, "daemon", "src"));
  assert.ok(path && path.endsWith("voice" + (process.platform === "win32" ? "\\" : "/") + "models.json"));
});

test("15.10 (c) findManifest returns null when not found", () => {
  const path = findManifest("/nonexistent-dir-no-manifest-anywhere");
  assert.equal(path, null);
});

// --- (d) shipped manifest validates -----------------------------

test("15.10 (d) the shipped voice/models.json parses cleanly", () => {
  const path = join(repoRoot, "voice", "models.json");
  const m = loadManifest(path);
  assert.ok(m);
  assert.ok(Array.isArray(m.models));
  assert.ok(m.models.length >= 5, "expect at least Whisper, Kokoro, XTTS, VAD, wake-word");
  // Each entry has the spec'd fields.
  for (const entry of m.models) {
    assert.ok(entry.name);
    assert.ok(entry.version);
    assert.ok(entry.path);
    assert.ok(entry.url);
    assert.ok(entry.sha256);
  }
});

test("15.10 (d) shipped manifest covers all five spec'd model families", () => {
  const m = loadManifest(join(repoRoot, "voice", "models.json"));
  const names = m.models.map((x) => x.name);
  // Spec lists Whisper, Kokoro, XTTS-v2, silero-vad, openWakeWord.
  // Substring match — we ship `kokoro-v1.0` not `Kokoro` etc.
  for (const family of ["kokoro", "whisper", "xtts", "silero", "openwakeword"]) {
    assert.ok(
      names.some((n) => n.toLowerCase().includes(family)),
      `manifest missing a model for family: ${family}`
    );
  }
});

// --- (e) sha256File correctness -----------------------------------

test("15.10 (e) sha256File matches Node's crypto", () => {
  const root = tempRoot();
  const filePath = join(root, "x.bin");
  const body = Buffer.from("kokoro placeholder");
  writeFileSync(filePath, body);
  assert.equal(sha256File(filePath), sha256Buf(body));
});
