#!/usr/bin/env node
// Coding Buddy doctor — Task 15.2.
//
// Verifies every dependency the buddy needs, reports versions,
// pings each running sidecar, and confirms .env is filled in.
//
// Output is a colored checklist:
//   GREEN  — all good
//   YELLOW — advisory / optional / can't probe (e.g. sidecar
//            not running)
//   RED    — required and missing/broken
//
// Exit code is 0 when no checks are red, 1 otherwise. Run via:
//   pnpm doctor
//
// Notes:
//   - Sidecar /health pings have a short timeout — when sidecars
//     are not running, doctor reports yellow (informational), not
//     red. Running them is optional for chat-only setups.
//   - Audio device probing is best-effort and platform-dependent;
//     when we can't enumerate, we yellow rather than red.
//
// CI runs this on windows-latest / macos-latest / ubuntu-latest
// after the setup script lands; a green-or-yellow doctor confirms
// 15.1 + 15.2 work end-to-end.

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// --- Color helpers -----------------------------------------------

const isTty = process.stdout.isTTY === true;
function color(code, text) {
  if (!isTty) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color("32", t);
const yellow = (t) => color("33", t);
const red = (t) => color("31", t);
const dim = (t) => color("2", t);

const SYMBOLS = { green: "[OK]", yellow: "[--]", red: "[XX]" };

// --- Result accumulator ------------------------------------------

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

function print(line) {
  process.stdout.write(line + "\n");
}

// --- Generic helpers ---------------------------------------------

function tryCmd(cmd, args, opts = {}) {
  // Windows resolves .cmd/.bat/.ps1 via PATHEXT only when invoked
  // through a shell; node's execFileSync bypasses that. Use
  // spawnSync with shell: true on Windows so e.g. `pnpm` finds
  // `pnpm.cmd`. Other platforms use execFileSync directly to avoid
  // an unnecessary shell.
  if (process.platform === "win32") {
    // Pass a single concatenated string to avoid Node's
    // DEP0190 warning about shell: true with separate args.
    // Inputs here are hard-coded tool names + flags, no
    // user-supplied data — escaping isn't load-bearing.
    const joined = [cmd, ...(args ?? [])].join(" ");
    const r = spawnSync(joined, {
      stdio: "pipe",
      shell: true,
      ...opts,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.toString().trim();
  }
  try {
    return execFileSync(cmd, args, { stdio: "pipe", ...opts })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function which(cmd) {
  for (const candidate of [cmd, `${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`]) {
    const out = tryCmd(
      process.platform === "win32" ? "where" : "command",
      process.platform === "win32" ? [candidate] : ["-v", candidate]
    );
    if (out) return out.split(/\r?\n/)[0].trim();
  }
  return null;
}

// --- Checks ------------------------------------------------------

function checkNode() {
  const v = process.versions.node;
  const major = Number(v.split(".")[0]);
  if (major >= 20) {
    record("node", "green", `v${v}`);
  } else {
    record("node", "red", `v${v} (need >=20)`);
  }
}

function checkPnpm() {
  const v = tryCmd("pnpm", ["--version"]);
  if (v) {
    record("pnpm", "green", `v${v}`);
  } else {
    record("pnpm", "red", "not on PATH");
  }
}

function checkPython() {
  for (const cand of [
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
    "python",
  ]) {
    const v = tryCmd(cand, ["--version"]);
    if (!v) continue;
    const m = /Python\s+(\d+)\.(\d+)/.exec(v);
    if (!m) continue;
    const [, maj, min] = m.map(Number);
    if (maj > 3 || (maj === 3 && min >= 11)) {
      record("python", "green", `${cand} v${maj}.${min}`);
      return;
    }
    record("python", "red", `${cand} v${maj}.${min} (need >=3.11)`);
    return;
  }
  // Voice is optional — yellow rather than red when nothing satisfies.
  record(
    "python",
    "yellow",
    "no Python >=3.11 on PATH (voice features unavailable)"
  );
}

function checkVoiceVenv() {
  const venvDir = join(repoRoot, "voice", ".venv");
  if (!existsSync(venvDir)) {
    record(
      "voice/.venv",
      "yellow",
      `not present — run setup.{ps1,sh} or skip if chat-only`
    );
    return;
  }
  const candidates =
    process.platform === "win32"
      ? [join(venvDir, "Scripts", "python.exe")]
      : [join(venvDir, "bin", "python"), join(venvDir, "bin", "python3")];
  for (const py of candidates) {
    if (existsSync(py)) {
      const v = tryCmd(py, ["--version"]);
      record("voice/.venv", "green", `${v ?? "exists"} (${py})`);
      return;
    }
  }
  record("voice/.venv", "red", "venv directory present but no python found");
}

function checkEnvFile() {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    record(".env", "red", "missing — run setup script or copy .env.example");
    return;
  }
  const text = readFileSync(envPath, "utf8");
  // Provider may come from either source; shell env wins when set.
  const provider =
    process.env.BUDDY_PROVIDER ||
    readEnvVar(text, "BUDDY_PROVIDER") ||
    "anthropic";
  // Provider key requirement.
  //
  // Both `process.env` and `.env` are accepted: the daemon loads
  // .env into process.env via dotenv at boot, then reads from
  // process.env. Doctor must mirror that — a user who sources
  // their key via direnv / 1Password CLI / a CI job secret should
  // not see a misleading red just because .env has a placeholder
  // (or no entry at all).
  function placeholder(v) {
    return !v || /^sk-ant-\.\.\.$/.test(v) || v.startsWith("sk-ant-...");
  }
  if (provider === "anthropic") {
    const envKey = process.env.ANTHROPIC_API_KEY ?? "";
    const fileKey = readEnvVar(text, "ANTHROPIC_API_KEY") ?? "";
    // Prefer a non-placeholder shell value over .env, then a
    // non-placeholder .env value over a placeholder shell value.
    const effective = !placeholder(envKey)
      ? envKey
      : !placeholder(fileKey)
        ? fileKey
        : envKey || fileKey;
    const source = effective === envKey && envKey ? "shell env" : ".env";
    if (placeholder(effective)) {
      record(
        "ANTHROPIC_API_KEY",
        "red",
        "missing or still the placeholder (checked process.env and .env)"
      );
    } else if (effective.startsWith("sk-ant-")) {
      record(
        "ANTHROPIC_API_KEY",
        "green",
        `set via ${source} (${effective.length} chars)`
      );
    } else {
      record(
        "ANTHROPIC_API_KEY",
        "yellow",
        `set via ${source} but unexpected prefix — usually starts with sk-ant-`
      );
    }
  } else if (provider === "ollama") {
    const envUrl = process.env.BUDDY_OLLAMA_URL ?? "";
    const fileUrl = readEnvVar(text, "BUDDY_OLLAMA_URL") ?? "";
    const effective = envUrl || fileUrl;
    if (!effective) {
      record("BUDDY_OLLAMA_URL", "yellow", "unset (defaults to localhost)");
    } else {
      const source = envUrl ? "shell env" : ".env";
      record("BUDDY_OLLAMA_URL", "green", `${effective} (via ${source})`);
    }
  } else {
    record(
      ".env BUDDY_PROVIDER",
      "red",
      `unrecognised provider "${provider}" (expected anthropic|ollama)`
    );
  }
  record(".env", "green", `present (${text.split(/\r?\n/).length} lines)`);
}

function readEnvVar(text, name) {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

function checkDaemonBuild() {
  const distMain = join(repoRoot, "daemon", "dist", "index.js");
  if (existsSync(distMain)) {
    const sz = statSync(distMain).size;
    record("daemon build", "green", `daemon/dist/index.js (${sz} bytes)`);
  } else {
    record(
      "daemon build",
      "red",
      "daemon/dist/index.js missing — run `pnpm -r build`"
    );
  }
}

function checkExtensionBuild() {
  const out = join(repoRoot, "extension", "out", "extension.js");
  if (existsSync(out)) {
    const sz = statSync(out).size;
    record("extension build", "green", `extension/out/extension.js (${sz} bytes)`);
  } else {
    // Extension is built on demand; missing → yellow, not red.
    record(
      "extension build",
      "yellow",
      "extension/out/extension.js missing — run `pnpm -r build` if installing the .vsix"
    );
  }
}

async function checkSidecar(name, url, timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      record(name, "green", `${url} -> ${res.status}`);
    } else {
      record(name, "yellow", `${url} -> HTTP ${res.status}`);
    }
  } catch {
    // Sidecar offline is fine — they're optional.
    record(name, "yellow", `not running at ${url}`);
  }
}

function checkAudioDevices() {
  // Best-effort: on Linux we look for /proc/asound; on macOS we
  // try `system_profiler SPAudioDataType`; on Windows we don't
  // currently probe (would need PowerShell + Get-AudioDevice).
  // None of these are 100% reliable; yellow on inconclusive.
  if (process.platform === "linux") {
    if (existsSync("/proc/asound/cards")) {
      const txt = readFileSync("/proc/asound/cards", "utf8");
      if (txt.trim().length > 0) {
        record("audio devices", "green", "ALSA cards present");
        return;
      }
    }
    record("audio devices", "yellow", "no ALSA cards found in /proc/asound");
    return;
  }
  if (process.platform === "darwin") {
    const r = spawnSync("system_profiler", ["SPAudioDataType"], {
      stdio: "pipe",
    });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
      record("audio devices", "green", "system_profiler reports audio HW");
      return;
    }
    record("audio devices", "yellow", "system_profiler unavailable / no HW");
    return;
  }
  // Windows + others — not probed.
  record(
    "audio devices",
    "yellow",
    "not probed on this platform (advisory)"
  );
}

// --- Render ------------------------------------------------------

function render() {
  const padName = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const sym = SYMBOLS[r.status];
    const colored =
      r.status === "green"
        ? green(sym)
        : r.status === "yellow"
          ? yellow(sym)
          : red(sym);
    const namePad = r.name.padEnd(padName, " ");
    const detail = r.detail ? dim(`  ${r.detail}`) : "";
    print(`${colored} ${namePad}${detail}`);
  }
  // Summary
  const counts = results.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {}
  );
  const summary = `${counts.green ?? 0} green, ${counts.yellow ?? 0} yellow, ${counts.red ?? 0} red`;
  print("");
  print(`Doctor: ${summary}`);
  return (counts.red ?? 0) === 0 ? 0 : 1;
}

// --- Main --------------------------------------------------------

async function main() {
  // Required dependencies
  checkNode();
  checkPnpm();
  checkPython();
  // Workspace state
  checkEnvFile();
  checkDaemonBuild();
  checkExtensionBuild();
  // Voice
  checkVoiceVenv();
  // Sidecars (best-effort)
  await Promise.all([
    checkSidecar("kokoro sidecar", "http://127.0.0.1:31416/health"),
    checkSidecar("xtts sidecar", "http://127.0.0.1:31417/health"),
  ]);
  checkAudioDevices();
  process.exit(render());
}

main().catch((err) => {
  console.error("[doctor] uncaught error:", err);
  process.exit(2);
});
