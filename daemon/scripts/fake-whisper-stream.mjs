#!/usr/bin/env node
// Test fixture for stt-stream.test.mjs. Emulates the contract that
// StreamingSttBridge expects from a whisper-stream-shaped subprocess:
//   stdin  — raw 16-bit PCM bytes (we just count them)
//   stdout — line-delimited JSON: {"type":"partial"|"final"|"error", text/reason}
//
// Behaviour, controlled by env so individual tests can shape it:
//   FAKE_PARTIAL_AT_BYTES (default 4096) — emit a {type:"partial"}
//     event after every N bytes of stdin.
//   FAKE_FINAL_ON_IDLE_MS (default 100) — when stdin has been quiet
//     for this long, emit a {type:"final"} event with the full
//     concatenated partial text. Set 0 to disable (the bridge's
//     speechEndTimeoutMs promote-fallback path then fires).
//   FAKE_ERROR_ON_START — if non-empty, emit one {type:"error"} and
//     exit 0 immediately. Used to test the error path.
//   FAKE_PARTIAL_TEXTS — comma-separated list to rotate through; if
//     unset, partial text is "partial-N" with N incrementing.

import { setTimeout as wait } from "node:timers/promises";

const PARTIAL_AT_BYTES = Number(process.env.FAKE_PARTIAL_AT_BYTES ?? 4096);
const FINAL_ON_IDLE_MS = Number(process.env.FAKE_FINAL_ON_IDLE_MS ?? 100);
const ERROR_ON_START = process.env.FAKE_ERROR_ON_START ?? "";
const PARTIAL_TEXTS = (process.env.FAKE_PARTIAL_TEXTS ?? "")
  .split(",")
  .filter(Boolean);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (ERROR_ON_START) {
  emit({ type: "error", reason: ERROR_ON_START });
  process.exit(0);
}

let bytesSinceLast = 0;
let totalBytes = 0;
let partialIdx = 0;
let lastFullText = "";
let idleTimer = null;

function pickPartial() {
  if (PARTIAL_TEXTS.length > 0) {
    const t = PARTIAL_TEXTS[partialIdx % PARTIAL_TEXTS.length];
    partialIdx += 1;
    return t;
  }
  partialIdx += 1;
  return `partial-${partialIdx}`;
}

function scheduleIdleFinal() {
  if (FINAL_ON_IDLE_MS <= 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!lastFullText) return;
    emit({ type: "final", text: lastFullText });
    lastFullText = "";
  }, FINAL_ON_IDLE_MS);
  idleTimer.unref?.();
}

process.stdin.on("data", (chunk) => {
  totalBytes += chunk.length;
  bytesSinceLast += chunk.length;
  while (bytesSinceLast >= PARTIAL_AT_BYTES) {
    bytesSinceLast -= PARTIAL_AT_BYTES;
    const next = pickPartial();
    lastFullText = lastFullText ? `${lastFullText} ${next}` : next;
    emit({ type: "partial", text: lastFullText });
  }
  scheduleIdleFinal();
});

process.stdin.on("end", () => {
  if (lastFullText) emit({ type: "final", text: lastFullText });
  process.exit(0);
});

// Keep alive forever (until parent kills us).
setInterval(() => {}, 60_000).unref?.();
