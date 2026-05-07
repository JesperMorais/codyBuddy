#!/usr/bin/env node
// Single-binary daemon builder — Task 15.6.
//
// Three steps, each shellable on its own:
//   1. Bundle daemon/dist/index.js + every dependency into one
//      CommonJS file (Node SEA needs a single CJS entry).
//      esbuild does this in ~1s.
//   2. Generate the SEA blob:
//        node --experimental-sea-config daemon/sea-config.json
//   3. Copy the running node binary to `buddy-daemon-<plat>-x64[.exe]`
//      and inject the SEA blob via postject.
//
// Output lands at `daemon/dist-bin/buddy-daemon-<plat>-x64[.exe]`.
// Cross-compiling isn't possible — Node SEA must run on the same
// platform as the node binary it injects into.
//
// Usage:
//   pnpm build:daemon-bin
//
// Local smoke:
//   ./daemon/dist-bin/buddy-daemon-linux-x64
//   ws://127.0.0.1:31415 should accept {type:"ping"} → "pong"
//
// CI matrix in .github/workflows/release.yml runs this on each OS.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonDir = resolve(__dirname, "..");
const distBin = join(daemonDir, "dist-bin");
const seaConfig = join(daemonDir, "sea-config.json");
const blobPath = join(distBin, "sea-prep.blob");
const bundlePath = join(distBin, "bundle.cjs");

// shell:true on Windows is needed for npx (resolves .cmd) but
// breaks paths with spaces (Program Files\nodejs\node.exe). Two
// helpers: runShell for npx-style invocations, runDirect for the
// node binary itself.
function runShell(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: daemonDir,
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`[build-bin] ${cmd} ${args.join(" ")} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function runDirect(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: daemonDir,
    shell: false,
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`[build-bin] ${cmd} ${args.join(" ")} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function platformLabel() {
  switch (process.platform) {
    case "win32":
      return "win-x64";
    case "darwin":
      return "mac-x64";
    case "linux":
      return "linux-x64";
    default:
      return `${process.platform}-x64`;
  }
}

function binaryName() {
  const base = `buddy-daemon-${platformLabel()}`;
  return process.platform === "win32" ? `${base}.exe` : base;
}

console.log("[build-bin] step 1/3: bundling daemon with esbuild");
mkdirSync(distBin, { recursive: true });
// Use the dist build's index.js as the entry; esbuild collapses it
// + every dependency into a single CJS file. --platform=node maps
// node: builtins through; --target=node20 keeps modern syntax.
runShell("npx", [
  "--yes",
  "esbuild@0.23.0",
  "dist/index.js",
  "--bundle",
  "--platform=node",
  "--target=node20",
  "--format=cjs",
  `--outfile=${bundlePath}`,
  "--external:./voice/*",
  "--legal-comments=none",
]);

const bundleSize = statSync(bundlePath).size;
console.log(
  `[build-bin] bundle: ${bundlePath} (${(bundleSize / 1024).toFixed(0)} KB)`
);

console.log("[build-bin] step 2/3: generating SEA blob");
runDirect(process.execPath, ["--experimental-sea-config", seaConfig]);
if (!existsSync(blobPath)) {
  console.error("[build-bin] sea-prep.blob not created");
  process.exit(1);
}

console.log("[build-bin] step 3/3: copying node binary + injecting blob");
const outBin = join(distBin, binaryName());
copyFileSync(process.execPath, outBin);

// Postject flags differ slightly across platforms — windows
// doesn't need fuse, mac needs --macho-segment-name. Keep it
// simple: NODE_SEA_FUSE works on every platform per the docs.
const postjectArgs = [
  "--yes",
  "postject@1.0.0-alpha.6",
  outBin,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
runShell("npx", postjectArgs);

// Ship prompts/ next to the binary — daemon/src/index.ts looks
// for them as siblings of process.execPath when it can't resolve
// from import.meta.url (i.e. running as the SEA bundle).
const promptsSrc = join(daemonDir, "prompts");
const promptsDst = join(distBin, "prompts");
if (existsSync(promptsDst)) rmSync(promptsDst, { recursive: true, force: true });
cpSync(promptsSrc, promptsDst, { recursive: true });

const finalSize = statSync(outBin).size;
console.log(
  `[build-bin] done: ${outBin} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`
);
console.log(`[build-bin] prompts shipped: ${promptsDst}`);
console.log("[build-bin] smoke: run the binary, then send {type:\"ping\"} on ws://127.0.0.1:31415 — expect pong.");
