// Task 13.2: per-day USD cap tests.
//
// Spec contract:
//   "With a low cap and stubbed token costs, assert downgrade
//    after the threshold."
//
// Coverage:
//   (a) DailyCostCap module — sums today's spend from telemetry,
//       compares against cap, returns hit/not-hit. Old entries
//       (yesterday) don't count.
//   (b) TtsBridge.setSuspended / ConversationLoop.setSuspended —
//       speak() and transcript() become no-ops when suspended.
//   (c) applyCapDowngrade helper — ties the status to suspendables
//       so the host can wire status → bridge + loop with one call.
//
// Run: node --test daemon/test/daily-cost-cap.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TurnTelemetry } = await import("../dist/turn-telemetry.js");
const { DailyCostCap, applyCapDowngrade } = await import(
  "../dist/daily-cost-cap.js"
);
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { ConversationLoop } = await import("../dist/conversation.js");

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-13.2-"));
  return join(dir, "turns.jsonl");
}

function fakeClock(initial = new Date("2026-05-07T15:30:00").getTime()) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function recordTurn(tel, opts) {
  return tel.record({
    ts: opts.ts,
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: { input_tokens: 100, output_tokens: 50 },
    sonnetModel: opts.sonnet ? "claude-sonnet-4-6" : undefined,
    sonnetUsage: opts.sonnet
      ? { input_tokens: opts.sonnetIn ?? 1000, output_tokens: opts.sonnetOut ?? 200 }
      : undefined,
    routerReason: opts.sonnet ? "trigger=EXPLICIT_ASK" : "no_escalation",
    endToEndMs: 500,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });
}

// --- (a) cap module ----------------------------------------------

test("13.2 (a) under-cap status: hit=false", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock();
  // One small turn today.
  recordTurn(tel, { ts: clock.now() - 60_000 }); // ~$0.0007

  const cap = new DailyCostCap({
    capUsd: 5.0,
    turnTelemetry: tel,
    now: clock.now,
  });
  const status = cap.status();
  assert.equal(status.hit, false);
  assert.equal(status.capUsd, 5.0);
  assert.ok(status.spentUsd > 0);
  assert.ok(status.spentUsd < 0.01);
});

test("13.2 (a) at-cap and over-cap status: hit=true", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock();
  // Big turn that overshoots a low cap by a comfortable margin.
  // Sonnet @ $3/MTok input, $15/MTok output → 1M input + 200k output ≈ $6
  recordTurn(tel, {
    ts: clock.now() - 60_000,
    sonnet: true,
    sonnetIn: 1_000_000,
    sonnetOut: 200_000,
  });

  const cap = new DailyCostCap({
    capUsd: 0.01,
    turnTelemetry: tel,
    now: clock.now,
  });
  const status = cap.status();
  assert.equal(status.hit, true, `expected hit, got status=${JSON.stringify(status)}`);
  assert.ok(status.spentUsd > 0.01);
});

test("13.2 (a) yesterday's spend doesn't count toward today's cap", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock(); // 2026-05-07 15:30 local
  // Yesterday at noon — shouldn't count.
  const yesterdayTs = clock.now() - 27 * 60 * 60_000; // 27h ago
  recordTurn(tel, {
    ts: yesterdayTs,
    sonnet: true,
    sonnetIn: 1_000_000,
    sonnetOut: 200_000, // big
  });

  const cap = new DailyCostCap({
    capUsd: 0.01,
    turnTelemetry: tel,
    now: clock.now,
  });
  const status = cap.status();
  assert.equal(
    status.hit,
    false,
    `yesterday's $${status.spentUsd} should not count toward today; status=${JSON.stringify(status)}`
  );
  assert.equal(status.spentUsd, 0);
});

test("13.2 (a) midnight rollover: yesterday's hit becomes today's not-hit", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  // Right before midnight: spent $6, cap $5 → hit.
  const lateYesterday = new Date("2026-05-06T23:55:00").getTime();
  recordTurn(tel, {
    ts: lateYesterday,
    sonnet: true,
    sonnetIn: 1_000_000,
    sonnetOut: 200_000,
  });
  // Now check from "today" (next morning).
  const todayMorning = new Date("2026-05-07T08:00:00").getTime();
  const cap = new DailyCostCap({
    capUsd: 5.0,
    turnTelemetry: tel,
    now: () => todayMorning,
  });
  const status = cap.status();
  assert.equal(status.hit, false, "midnight rollover wipes the slate");
  assert.equal(status.spentUsd, 0);
  assert.equal(status.forDate, "2026-05-07");
});

test("13.2 (a) status returns ISO date for today (local)", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock(new Date("2026-12-25T03:14:00").getTime());
  const cap = new DailyCostCap({ turnTelemetry: tel, now: clock.now });
  assert.equal(cap.status().forDate, "2026-12-25");
});

test("13.2 (a) telemetry read failure does not throw — under-counts gracefully", () => {
  // Pass a fake telemetry whose read() throws. The cap should
  // surface 0 spend rather than crashing — the live trigger path
  // mustn't be blocked by a bookkeeping read.
  const fakeTel = {
    read() {
      throw new Error("disk gone");
    },
  };
  const cap = new DailyCostCap({ capUsd: 5.0, turnTelemetry: fakeTel });
  const status = cap.status();
  assert.equal(status.spentUsd, 0);
  assert.equal(status.hit, false);
});

// --- (b) suspendable wiring --------------------------------------

test("13.2 (b) bridge.setSuspended makes speak() a no-op", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const bridge = new TtsBridge({ backend: "kokoro", fetchImpl });
  bridge.setSuspended(true);
  await bridge.speak("hello");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0, "no fetch when suspended");
  assert.equal(bridge.isSuspended(), true);

  bridge.setSuspended(false);
  await bridge.speak("hello");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, "resumed after un-suspending");
});

test("13.2 (b) loop.setSuspended makes transcript drop", async () => {
  const calls = { complete: 0 };
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      calls.complete += 1;
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
  };
  const loop = new ConversationLoop(deps);
  loop.setSuspended(true);
  loop.speechStart();
  await loop.transcript("hello world");
  assert.equal(calls.complete, 0, "no LLM call when suspended");
  assert.equal(loop.getState(), "IDLE");

  loop.setSuspended(false);
  loop.speechStart();
  await loop.transcript("hello world");
  await loop.awaitSettled();
  assert.equal(calls.complete, 1, "resumed after un-suspending");
});

// --- (c) applyCapDowngrade helper --------------------------------

test("13.2 (c) applyCapDowngrade flips bridge + loop suspension by status", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock();
  // Spend over a $0.01 cap.
  recordTurn(tel, {
    ts: clock.now() - 60_000,
    sonnet: true,
    sonnetIn: 1_000_000,
    sonnetOut: 200_000,
  });
  const cap = new DailyCostCap({ capUsd: 0.01, turnTelemetry: tel, now: clock.now });

  const bridge = new TtsBridge({ backend: "kokoro" });
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
  };
  const loop = new ConversationLoop(deps);

  applyCapDowngrade(cap.status(), [bridge, loop]);
  assert.equal(bridge.isSuspended(), true);
  assert.equal(loop.isSuspended(), true);
});

test("13.2 (c) applyCapDowngrade clears suspension when cap not hit", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock();
  recordTurn(tel, { ts: clock.now() - 60_000 }); // tiny turn

  const cap = new DailyCostCap({ capUsd: 5.0, turnTelemetry: tel, now: clock.now });
  const bridge = new TtsBridge({ backend: "kokoro" });
  bridge.setSuspended(true); // pretend yesterday's cap-hit lingered
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      yield "x";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
  };
  const loop = new ConversationLoop(deps);
  loop.setSuspended(true);

  applyCapDowngrade(cap.status(), [bridge, loop]);
  assert.equal(bridge.isSuspended(), false, "midnight rollover clears bridge");
  assert.equal(loop.isSuspended(), false, "midnight rollover clears loop");
});

// --- end-to-end: low cap + stubbed costs → downgrade -------------

test("13.2 spec: low cap + stubbed token costs → downgrade lands", async () => {
  // The pinned spec test, end to end.
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const clock = fakeClock();

  // Two turns that together overshoot a $0.05 cap.
  recordTurn(tel, {
    ts: clock.now() - 120_000,
    sonnet: true,
    sonnetIn: 1_000_000, // $3
    sonnetOut: 0,
  });
  recordTurn(tel, {
    ts: clock.now() - 30_000,
    sonnet: true,
    sonnetIn: 1_000_000,
    sonnetOut: 0,
  });
  // Spent ≈ $6, cap $0.05 → very hit.

  const cap = new DailyCostCap({
    capUsd: 0.05,
    turnTelemetry: tel,
    now: clock.now,
  });
  const status = cap.status();
  assert.equal(status.hit, true);

  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const bridge = new TtsBridge({ backend: "kokoro", fetchImpl });
  const deps = {
    bargeIn: { trigger: async () => {} },
    completeUtterance: async function* () {
      yield "should-not-fire";
    },
    speakSentence: async () => {},
    finishUtterance: () => {},
    cancelSpeak: () => {},
    log: () => {},
  };
  const loop = new ConversationLoop(deps);

  applyCapDowngrade(status, [bridge, loop]);

  // After downgrade: TTS off, voice loop suspended.
  await bridge.speak("hello");
  loop.speechStart();
  await loop.transcript("hey can you help me");

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetchCalls.length, 0, "TTS off (no synth fetch)");
  assert.equal(loop.getState(), "IDLE", "voice loop suspended (stays IDLE)");
});
