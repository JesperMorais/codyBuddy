#!/usr/bin/env node
// Cross-platform VSIX builder — Task 15.5.
//
// Wraps `vsce package` so the output filename is always
// `coding-buddy-<version>.vsix` regardless of shell quirks.
// PowerShell doesn't expand `$npm_package_version` in npm-script
// strings the way bash does, so the literal `-o` value would land
// on disk verbatim.
//
// Reads version from extension/package.json. Uses npx so the
// caller doesn't have to add @vscode/vsce as a workspace dep.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(__dirname, "..");
const repoRoot = resolve(extensionDir, "..");
const pkg = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
const out = `coding-buddy-${pkg.version}.vsix`;

// Mirror the repo-root LICENSE into extension/ so vsce finds it
// without rearranging the repo's canonical layout. Idempotent —
// we just overwrite if it changed upstream.
const repoLicense = join(repoRoot, "LICENSE");
const extLicense = join(extensionDir, "LICENSE");
if (existsSync(repoLicense)) {
  copyFileSync(repoLicense, extLicense);
}

const r = spawnSync(
  "npx",
  [
    "--yes",
    "@vscode/vsce@^3.0.0",
    "package",
    "--no-yarn",
    "--no-dependencies",
    "-o",
    out,
  ],
  {
    cwd: extensionDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  }
);
process.exit(r.status ?? 1);
