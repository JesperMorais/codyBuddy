// Task 16.3.1: pinned-model downloader tests.
//
// We exercise the download mechanics end-to-end against a local
// fixture HTTP server (no real network traffic, no real models).
// The headline assertion: a freshly-fetched manifest entry lands at
// the configured path with bytes and SHA256 matching the manifest
// pin — and that the same call is idempotent (cached files don't
// re-download).
//
// Run: node --test daemon/test/fetch-models.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const { fetchAll, fetchOne, sha256File } = await import(
  "../scripts/fetch-models.mjs"
);

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.3.1-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Tiny HTTP server that serves static fixture content per path.
 *  Each test gets an isolated server on an ephemeral port. */
async function startFixtureServer(routes) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const route = routes[req.url ?? ""];
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (route.redirectTo) {
      res.statusCode = 302;
      res.setHeader("location", route.redirectTo);
      res.end();
      return;
    }
    if (route.status && route.status >= 400) {
      res.statusCode = route.status;
      res.end(route.body ?? "");
      return;
    }
    res.statusCode = 200;
    res.end(route.body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

function sha256OfBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

test("16.3.1 (a) SPEC HEADLINE: a fresh manifest entry downloads, lands at `path`, with bytes + sha256 matching the pin", async () => {
  const tmp = freshTempDir();
  const body = Buffer.from("hello pinned model\n");
  const sha = sha256OfBuffer(body);
  const fx = await startFixtureServer({
    "/model.bin": { body },
  });
  try {
    const manifest = {
      models: [
        {
          name: "fixture-model",
          version: "1.0",
          path: "voice/fixture-model.bin",
          url: fx.url("/model.bin"),
          sha256: sha,
          size_bytes: body.length,
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = await fetchAll(manifestPath, tmp.dir, { log: () => {} });
    assert.equal(summary.downloaded, 1);
    assert.equal(summary.cached, 0);
    assert.equal(summary.total, 1);

    const dest = join(tmp.dir, "voice/fixture-model.bin");
    assert.ok(existsSync(dest), "destination file must exist");
    assert.deepEqual(readFileSync(dest), body, "file bytes match upstream body");
    assert.equal(await sha256File(dest), sha, "post-download sha256 matches manifest pin");
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (b) idempotent: a second call with a matching cached file does NOT re-download", async () => {
  const tmp = freshTempDir();
  const body = Buffer.from("cached payload");
  const sha = sha256OfBuffer(body);
  const fx = await startFixtureServer({
    "/cached.bin": { body },
  });
  try {
    const manifest = {
      models: [
        {
          name: "cached-model",
          version: "1.0",
          path: "voice/cached.bin",
          url: fx.url("/cached.bin"),
          sha256: sha,
          size_bytes: body.length,
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    // First call: downloads.
    const s1 = await fetchAll(manifestPath, tmp.dir, { log: () => {} });
    assert.equal(s1.downloaded, 1);
    assert.equal(fx.hits.length, 1);

    // Second call: file is on disk, hash matches → no fetch.
    const s2 = await fetchAll(manifestPath, tmp.dir, { log: () => {} });
    assert.equal(s2.cached, 1);
    assert.equal(s2.downloaded, 0);
    assert.equal(fx.hits.length, 1, "no second hit on the upstream");
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (c) SHA256 mismatch is fatal: removes the bogus file and throws", async () => {
  const tmp = freshTempDir();
  const body = Buffer.from("not what the manifest claims");
  const fx = await startFixtureServer({
    "/bad.bin": { body },
  });
  try {
    const manifest = {
      models: [
        {
          name: "bad-model",
          version: "1.0",
          path: "voice/bad.bin",
          url: fx.url("/bad.bin"),
          sha256: "0".repeat(64), // intentionally wrong
          size_bytes: body.length,
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      () => fetchAll(manifestPath, tmp.dir, { log: () => {} }),
      /sha256 mismatch/
    );
    // The bogus file must NOT linger.
    assert.equal(existsSync(join(tmp.dir, "voice/bad.bin")), false);
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (d) TBD-pinned hash: download proceeds, size is checked, hash is skipped", async () => {
  const tmp = freshTempDir();
  const body = Buffer.from("tbd content");
  const fx = await startFixtureServer({
    "/tbd.bin": { body },
  });
  try {
    const manifest = {
      models: [
        {
          name: "tbd-model",
          version: "1.0",
          path: "voice/tbd.bin",
          url: fx.url("/tbd.bin"),
          sha256: "TBD-fill-in-when-downloading",
          size_bytes: body.length,
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = await fetchAll(manifestPath, tmp.dir, { log: () => {} });
    assert.equal(summary.tbdSkipped, 1, "TBD entries count as tbd-skipped");
    assert.equal(summary.downloaded, 0);
    assert.equal(summary.cached, 0);
    // The bytes still landed.
    const dest = join(tmp.dir, "voice/tbd.bin");
    assert.ok(existsSync(dest));
    assert.deepEqual(readFileSync(dest), body);
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (e) HTTP 404 fails the download cleanly (no half-written file remains)", async () => {
  const tmp = freshTempDir();
  const fx = await startFixtureServer({
    "/missing.bin": { status: 404, body: "not found" },
  });
  try {
    const manifest = {
      models: [
        {
          name: "missing",
          version: "1.0",
          path: "voice/missing.bin",
          url: fx.url("/missing.bin"),
          sha256: "TBD-fill-in-when-downloading",
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      () => fetchAll(manifestPath, tmp.dir, { log: () => {} }),
      /HTTP 404/
    );
    assert.equal(existsSync(join(tmp.dir, "voice/missing.bin")), false);
    assert.equal(
      existsSync(join(tmp.dir, "voice/missing.bin.partial")),
      false,
      ".partial file must be cleaned up on failure"
    );
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (f) 3xx redirect is followed (Hugging Face style — resolve → CDN URL)", async () => {
  const tmp = freshTempDir();
  const body = Buffer.from("redirected payload");
  const sha = sha256OfBuffer(body);
  const fx = await startFixtureServer({
    "/resolve/main/file.bin": { redirectTo: "/cdn/file.bin" },
    "/cdn/file.bin": { body },
  });
  try {
    const manifest = {
      models: [
        {
          name: "redir",
          version: "1.0",
          path: "voice/redir.bin",
          url: fx.url("/resolve/main/file.bin"),
          sha256: sha,
          size_bytes: body.length,
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = await fetchAll(manifestPath, tmp.dir, { log: () => {} });
    assert.equal(summary.downloaded, 1);
    assert.equal(fx.hits.length, 2, "expected redirect + final hit");
    const dest = join(tmp.dir, "voice/redir.bin");
    assert.deepEqual(readFileSync(dest), body);
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (g) cached file with stale sha256 is re-downloaded over (atomic .partial → rename)", async () => {
  const tmp = freshTempDir();
  const goodBody = Buffer.from("the good upstream content");
  const goodSha = sha256OfBuffer(goodBody);
  const fx = await startFixtureServer({
    "/file.bin": { body: goodBody },
  });
  try {
    // Pre-populate the destination with stale content that has the
    // wrong sha — fetchOne should re-download over it.
    const dest = join(tmp.dir, "voice/file.bin");
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    mkdirSync(join(tmp.dir, "voice"), { recursive: true });
    wf(dest, Buffer.from("stale rubbish"));

    const summary = await fetchAll(
      (() => {
        const path = join(tmp.dir, "manifest.json");
        writeFileSync(
          path,
          JSON.stringify({
            models: [
              {
                name: "stale-replace",
                version: "1.0",
                path: "voice/file.bin",
                url: fx.url("/file.bin"),
                sha256: goodSha,
                size_bytes: goodBody.length,
              },
            ],
          })
        );
        return path;
      })(),
      tmp.dir,
      { log: () => {} }
    );
    assert.equal(summary.downloaded, 1);
    assert.deepEqual(readFileSync(dest), goodBody);
    assert.equal(await sha256File(dest), goodSha);
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (h) size_bytes mismatch (>10% drift) post-download is fatal", async () => {
  const tmp = freshTempDir();
  const body = Buffer.from("x".repeat(100));
  const sha = sha256OfBuffer(body);
  const fx = await startFixtureServer({
    "/sized.bin": { body },
  });
  try {
    const manifest = {
      models: [
        {
          name: "size-mismatch",
          version: "1.0",
          path: "voice/sized.bin",
          url: fx.url("/sized.bin"),
          sha256: sha,
          size_bytes: 1_000_000, // 4 orders of magnitude off
        },
      ],
    };
    const manifestPath = join(tmp.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      () => fetchAll(manifestPath, tmp.dir, { log: () => {} }),
      /size_bytes mismatch/
    );
    assert.equal(existsSync(join(tmp.dir, "voice/sized.bin")), false);
  } finally {
    await fx.close();
    tmp.cleanup();
  }
});

test("16.3.1 (i) missing manifest is a no-op (chat-only install path)", async () => {
  const tmp = freshTempDir();
  try {
    const summary = await fetchAll(
      join(tmp.dir, "does-not-exist.json"),
      tmp.dir,
      { log: () => {} }
    );
    assert.equal(summary.total, 0);
    assert.equal(summary.downloaded, 0);
    assert.equal(summary.cached, 0);
  } finally {
    tmp.cleanup();
  }
});

// Regression for #131: a `Jane Doe`-style home dir (any path containing a
// space, accented char, or other percent-encoded character) used to defeat
// the `import.meta.url === \`file://${process.argv[1]}\`` entry-point check
// because `import.meta.url` percent-encodes ("file:///.../Jane%20Doe/...")
// while `process.argv[1]` is the raw path. main() never ran, the script
// silently exited 0, and setup.{sh,ps1} treated that as success — leaving
// the user without their pinned models. Fix: compare against
// `pathToFileURL(process.argv[1]).href`, which uses the same encoding as
// `import.meta.url`.
test("16.3.1 (#131) fetch-models entrypoint runs main() even when its path contains a space", () => {
  const tmp = freshTempDir();
  try {
    // Reconstruct the script under a path that contains a literal space.
    const scriptSrc = fileURLToPath(
      new URL("../scripts/fetch-models.mjs", import.meta.url)
    );
    const spacedDir = join(tmp.dir, "with space");
    mkdirSync(spacedDir, { recursive: true });
    const spacedScript = join(spacedDir, "fetch-models.mjs");
    copyFileSync(scriptSrc, spacedScript);

    // Run without args. The CLI is supposed to print the Usage message
    // and exit 1. If the entrypoint check fails, main() never runs and
    // the script silently exits 0 — which is the exact bug.
    const result = spawnSync(process.execPath, [spacedScript], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      1,
      `expected exit 1 from no-args usage path, got ${result.status} (stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)})`
    );
    assert.match(
      result.stdout,
      /Usage: node .*fetch-models\.mjs/,
      "expected Usage line on stdout"
    );
  } finally {
    tmp.cleanup();
  }
});
