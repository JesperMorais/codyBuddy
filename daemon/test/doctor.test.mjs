// Task 15.2: pnpm doctor tests.
//
// Runs the doctor script in two staged states and asserts the
// red/green count matches the spec contract:
//
//   - "fresh checkout" — .env missing, daemon/dist absent →
//     reds present, exit non-zero.
//   - "after setup" — .env created, daemon/dist built →
//     no reds, exit zero (yellows for optional bits like the
//     voice venv and sidecars are fine).
//
// The full spec test ("CI on all three OS") lives in CI; this is
// the local guard so a regression in the script itself surfaces
// before push.
//
// Run: node --test daemon/test/doctor.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "doctor.mjs");

function runDoctor(cwd) {
  // No --colour interpretation needed — we parse lines.
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function makeFakeRepo(opts = {}) {
  // Build a directory layout the doctor expects to find. Creates
  // a copy of `scripts/doctor.mjs` so the script path inside the
  // copy resolves to the same repo root via `..`. Tests then
  // toggle .env presence / daemon dist presence.
  const dir = mkdtempSync(join(tmpdir(), "buddy-doctor-"));
  // The script uses `dirname(fileURLToPath(import.meta.url))` to
  // locate repoRoot — so the COPY of doctor.mjs needs to live at
  // `<dir>/scripts/doctor.mjs`. We don't copy the entire repo;
  // we just stub the bits the doctor reads.
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(scriptPath, join(dir, "scripts", "doctor.mjs"));
  if (opts.envFile !== undefined) {
    writeFileSync(join(dir, ".env"), opts.envFile);
  }
  if (opts.daemonDist) {
    mkdirSync(join(dir, "daemon", "dist"), { recursive: true });
    writeFileSync(
      join(dir, "daemon", "dist", "index.js"),
      "// fake compiled daemon for doctor smoke\n"
    );
  }
  if (opts.extensionOut) {
    mkdirSync(join(dir, "extension", "out"), { recursive: true });
    writeFileSync(
      join(dir, "extension", "out", "extension.js"),
      "// fake compiled extension\n"
    );
  }
  return dir;
}

function runIn(dir) {
  const r = spawnSync(
    process.execPath,
    [join(dir, "scripts", "doctor.mjs")],
    {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      encoding: "utf8",
    }
  );
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function countByPrefix(text, prefix) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.startsWith(prefix)).length;
}

test("15.2 (a) fresh-checkout state: reds present, exit non-zero", () => {
  // No .env, no daemon dist, no extension out.
  const dir = makeFakeRepo({});
  try {
    const r = runIn(dir);
    // Doctor should exit 1 because .env and daemon dist are red.
    assert.notEqual(r.status, 0, "doctor must exit non-zero with reds");
    assert.match(r.stdout, /Doctor: \d+ green, \d+ yellow, \d+ red/);
    const reds = countByPrefix(r.stdout, "[XX]");
    assert.ok(reds >= 2, `expected ≥2 red lines, got ${reds}\n${r.stdout}`);
    // Specifically: .env should be red.
    assert.match(r.stdout, /\[XX\]\s+\.env\s/);
    // And daemon build should be red.
    assert.match(r.stdout, /\[XX\]\s+daemon build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15.2 (b) post-setup state: no reds, exit zero", () => {
  // Simulate what setup.ps1 / setup.sh + pnpm -r build produces:
  // .env present (with a real-looking key), daemon/dist built,
  // extension/out built.
  const fakeEnv = `BUDDY_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-test-${"x".repeat(80)}
BUDDY_DAEMON_PORT=31415
`;
  const dir = makeFakeRepo({
    envFile: fakeEnv,
    daemonDist: true,
    extensionOut: true,
  });
  try {
    const r = runIn(dir);
    assert.equal(
      r.status,
      0,
      `expected exit 0 after setup, got ${r.status}.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
    );
    assert.match(r.stdout, /Doctor: \d+ green, \d+ yellow, 0 red/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15.2 (c) anthropic provider with placeholder key fails red", () => {
  // The default .env.example ships ANTHROPIC_API_KEY=sk-ant-...;
  // we treat that placeholder as red so users don't think they're
  // good to go.
  const fakeEnv = `BUDDY_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
`;
  const dir = makeFakeRepo({
    envFile: fakeEnv,
    daemonDist: true,
    extensionOut: true,
  });
  try {
    const r = runIn(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /\[XX\]\s+\.env ANTHROPIC_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15.2 (d) ollama provider doesn't require ANTHROPIC_API_KEY", () => {
  const fakeEnv = `BUDDY_PROVIDER=ollama
BUDDY_OLLAMA_URL=http://localhost:11434/v1
`;
  const dir = makeFakeRepo({
    envFile: fakeEnv,
    daemonDist: true,
    extensionOut: true,
  });
  try {
    const r = runIn(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[OK\]\s+\.env BUDDY_OLLAMA_URL/);
    // No red on missing anthropic key under provider=ollama.
    assert.doesNotMatch(r.stdout, /\[XX\]\s+\.env ANTHROPIC_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15.2 (e) renders the four-section summary line", () => {
  const dir = makeFakeRepo({});
  try {
    const r = runIn(dir);
    assert.match(r.stdout, /Doctor: (\d+) green, (\d+) yellow, (\d+) red/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15.2 (f) pnpm doctor script entry exists in root package.json", () => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  );
  assert.equal(pkg.scripts.doctor, "node scripts/doctor.mjs");
});

test("15.2 (g) doctor runs against the real repo without throwing", () => {
  // Smoke: doctor on the real repo. We don't assert exit 0 because
  // CI may or may not have certain bits installed. We just assert
  // the script completes and prints a summary line.
  const r = runDoctor(repoRoot);
  assert.match(r.stdout, /Doctor: \d+ green, \d+ yellow, \d+ red/);
  // No uncaught error spew.
  assert.doesNotMatch(r.stderr, /uncaught error|TypeError|ReferenceError/);
});
