// Task 13.3: live $/hr counter tests.
//
// Spec contract:
//   "Feed synthetic telemetry; assert the displayed rate matches."
//
// Coverage:
//   (a) RollingCostRate computation — empty file → 0; one turn in
//       the window → projected hourly rate matches the formula;
//       turns outside the window are ignored; window size honored;
//       read-failure resilience.
//   (b) WS wiring — getCostRate request returns a snapshot in the
//       documented shape; with no costRate observer wired, server
//       returns zeros (sidebar-friendly fallback).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const { TurnTelemetry } = await import("../dist/turn-telemetry.js");
const { RollingCostRate } = await import("../dist/cost-rate.js");
const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { loadPromptDir, loadPersonalities } = await import(
  "../dist/personalities-loader.js"
);
const { FakeAnthropicClient } = await import("./fakes.mjs");

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-13.3-"));
  return join(dir, "turns.jsonl");
}

function fakeClock(initial = 1_700_000_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function record(tel, opts) {
  return tel.record({
    ts: opts.ts,
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: { input_tokens: 100, output_tokens: 50 },
    sonnetModel: opts.sonnet ? "claude-sonnet-4-6" : undefined,
    sonnetUsage: opts.sonnet
      ? {
          input_tokens: opts.sonnetIn ?? 1000,
          output_tokens: opts.sonnetOut ?? 200,
        }
      : undefined,
    routerReason: opts.sonnet ? "trigger=EXPLICIT_ASK" : "no_escalation",
    endToEndMs: 500,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });
}

// --- (a) computation ---------------------------------------------

test("13.3 (a) empty telemetry → rate 0, spent 0", () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  const cr = new RollingCostRate({ turnTelemetry: tel, now: clock.now });
  const snap = cr.snapshot();
  assert.equal(snap.spentUsd, 0);
  assert.equal(snap.ratePerHourUsd, 0);
  assert.equal(snap.turnsInWindow, 0);
});

test("13.3 (a) one $1 turn in last 10 min → $6/hr (= 1/10*60)", () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  // Sonnet at $3/MTok input. 333,333 input tokens ≈ $1.00.
  const entry = record(tel, {
    ts: clock.now() - 60_000, // 1 min ago, in window
    sonnet: true,
    sonnetIn: 333_333,
    sonnetOut: 0,
  });
  // Sanity — entry shape we expect.
  assert.ok(entry.usd_estimate > 0);

  const cr = new RollingCostRate({
    turnTelemetry: tel,
    windowMs: 10 * 60_000,
    now: clock.now,
  });
  const snap = cr.snapshot();

  // Spent ≈ $1; rate = spent / 10min * 60min = $6/hr.
  assert.ok(Math.abs(snap.spentUsd - entry.usd_estimate) < 1e-6);
  const expectedRate = (entry.usd_estimate / (10 * 60_000)) * 3_600_000;
  assert.ok(
    Math.abs(snap.ratePerHourUsd - expectedRate) < 1e-6,
    `expected ${expectedRate}, got ${snap.ratePerHourUsd}`
  );
  assert.equal(snap.turnsInWindow, 1);
});

test("13.3 (a) turn 11 min ago is outside the window — not counted", () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  record(tel, {
    ts: clock.now() - 11 * 60_000,
    sonnet: true,
    sonnetIn: 1_000_000,
  });
  const cr = new RollingCostRate({
    turnTelemetry: tel,
    windowMs: 10 * 60_000,
    now: clock.now,
  });
  const snap = cr.snapshot();
  assert.equal(snap.spentUsd, 0);
  assert.equal(snap.ratePerHourUsd, 0);
  assert.equal(snap.turnsInWindow, 0);
});

test("13.3 (a) custom window size shrinks/grows the calculation", () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  // Three $1 turns spread across 8 minutes.
  const e1 = record(tel, { ts: clock.now() - 7 * 60_000, sonnet: true, sonnetIn: 333_333 });
  const e2 = record(tel, { ts: clock.now() - 5 * 60_000, sonnet: true, sonnetIn: 333_333 });
  const e3 = record(tel, { ts: clock.now() - 1 * 60_000, sonnet: true, sonnetIn: 333_333 });

  // 5-min window catches only the last two turns; total $2 → $24/hr.
  const cr5 = new RollingCostRate({
    turnTelemetry: tel,
    windowMs: 5 * 60_000,
    now: clock.now,
  });
  const s5 = cr5.snapshot();
  assert.equal(s5.turnsInWindow, 2);
  const expected5 = ((e2.usd_estimate + e3.usd_estimate) / (5 * 60_000)) * 3_600_000;
  assert.ok(Math.abs(s5.ratePerHourUsd - expected5) < 1e-6);

  // 10-min window catches all three.
  const cr10 = new RollingCostRate({
    turnTelemetry: tel,
    windowMs: 10 * 60_000,
    now: clock.now,
  });
  const s10 = cr10.snapshot();
  assert.equal(s10.turnsInWindow, 3);
  const expected10 =
    ((e1.usd_estimate + e2.usd_estimate + e3.usd_estimate) / (10 * 60_000)) *
    3_600_000;
  assert.ok(Math.abs(s10.ratePerHourUsd - expected10) < 1e-6);
});

test("13.3 (a) sums many small turns over the window", () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  // 20 small Haiku-only turns spread over the last 10 min.
  for (let i = 0; i < 20; i++) {
    tel.record({
      ts: clock.now() - i * 30_000, // every 30s back
      haikuModel: "claude-haiku-4-5-20251001",
      haikuUsage: { input_tokens: 1000, output_tokens: 100 },
      routerReason: "no_escalation",
      endToEndMs: 200,
      wakeWord: "off",
      personality: "nice",
      mode: "tutor",
    });
  }
  // Half fall outside a 5-min window (i*30s > 5min when i > 10).
  const cr5 = new RollingCostRate({
    turnTelemetry: tel,
    windowMs: 5 * 60_000,
    now: clock.now,
  });
  const s5 = cr5.snapshot();
  assert.ok(s5.turnsInWindow >= 10 && s5.turnsInWindow <= 11);
});

test("13.3 (a) future-dated entries (clock skew) are excluded", () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  // ts in the future — bad clock, partial replay, etc. Don't
  // count toward "the last 10 minutes" — that's a window into
  // the past.
  record(tel, {
    ts: clock.now() + 30_000,
    sonnet: true,
    sonnetIn: 1_000_000,
  });
  const cr = new RollingCostRate({ turnTelemetry: tel, now: clock.now });
  assert.equal(cr.snapshot().turnsInWindow, 0);
});

test("13.3 (a) telemetry read failure does not throw", () => {
  // Same posture as DailyCostCap — under-count rather than crash.
  const fakeTel = {
    read() {
      throw new Error("disk gone");
    },
  };
  const cr = new RollingCostRate({ turnTelemetry: fakeTel });
  const snap = cr.snapshot();
  assert.equal(snap.spentUsd, 0);
  assert.equal(snap.ratePerHourUsd, 0);
});

// --- (b) WS wiring -----------------------------------------------

async function bootDaemon(opts = {}) {
  const port = 33500 + Math.floor(Math.random() * 1000);
  const promptsDir = join(import.meta.dirname, "..", "prompts");
  const prompts = loadPromptDir(promptsDir);
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const memDir = mkdtempSync(join(tmpdir(), "buddy-13.3-mem-"));
  const memory = new MemoryStore(memDir);
  const fake = new FakeAnthropicClient();
  const session = new Session(fake, prompts, {
    personalities,
    memory,
    defaultPersonality: "nice",
  });
  const tts = new TtsBridge({ backend: "none" });
  const stt = { transcribe: async () => "" };
  const recorder = {
    start: () => ({ ok: true }),
    stop: async () => ({ ok: true, wav: Buffer.alloc(0), durationMs: 0 }),
    isRecording: () => false,
    cancel: () => {},
  };
  const wss = startServer({
    session,
    tts,
    stt,
    recorder,
    port,
    costRate: opts.costRate,
  });
  return { wss, port };
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws._inbox = [];
    ws._waiters = [];
    ws.on("message", (data) => {
      const obj = JSON.parse(data.toString());
      for (let i = 0; i < ws._waiters.length; i++) {
        if (ws._waiters[i].predicate(obj)) {
          const w = ws._waiters.splice(i, 1)[0];
          w.resolve(obj);
          return;
        }
      }
      ws._inbox.push(obj);
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws, predicate = () => true) {
  for (let i = 0; i < ws._inbox.length; i++) {
    if (predicate(ws._inbox[i])) {
      return Promise.resolve(ws._inbox.splice(i, 1)[0]);
    }
  }
  return new Promise((resolve, reject) => {
    ws._waiters.push({ predicate, resolve });
    ws.once("error", reject);
  });
}

test("13.3 (b) WS getCostRate returns snapshot fields", async () => {
  const tel = new TurnTelemetry(tempPath());
  const clock = fakeClock();
  // One $1 turn in the window.
  record(tel, { ts: clock.now() - 60_000, sonnet: true, sonnetIn: 333_333 });
  const costRate = new RollingCostRate({
    turnTelemetry: tel,
    windowMs: 10 * 60_000,
    now: clock.now,
  });

  const { wss, port } = await bootDaemon({ costRate });
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "getCostRate" }));
    const reply = await nextMessage(ws, (m) => m.type === "costRate");

    assert.equal(reply.type, "costRate");
    assert.ok(reply.spent_usd > 0);
    // ~$6/hr (1 USD / 10 min projected)
    assert.ok(Math.abs(reply.rate_per_hour_usd - 6) < 0.5);
    assert.equal(reply.window_ms, 10 * 60_000);
    assert.equal(reply.turns_in_window, 1);
    assert.equal(typeof reply.computed_at, "number");
    ws.close();
  } finally {
    wss.close();
  }
});

test("13.3 (b) WS getCostRate without a costRate observer returns zeros", async () => {
  const { wss, port } = await bootDaemon({}); // no costRate
  try {
    const ws = await openClient(port);
    await nextMessage(ws, (m) => m.type === "modeSet");
    ws.send(JSON.stringify({ type: "getCostRate" }));
    const reply = await nextMessage(ws, (m) => m.type === "costRate");

    assert.equal(reply.spent_usd, 0);
    assert.equal(reply.rate_per_hour_usd, 0);
    assert.equal(reply.window_ms, 0);
    assert.equal(reply.turns_in_window, 0);
    assert.equal(typeof reply.computed_at, "number");
    ws.close();
  } finally {
    wss.close();
  }
});
