// Task 16.1.6: DailyCostCap enforcement + TtsBridge.setSuspended wiring.
//
// Spec headline (TASKS.md 16.1.6): "with `BUDDY_DAILY_USD=0.01` and a
// stubbed turn USD of 0.05, the second turn never reaches
// `tts.feedSentence` and the WS broadcasts a `capState=hit` event."
//
// We exercise the audio-host's post-recordTurn cap check end-to-end
// with a fake router that surfaces token usage priced at ≈$0.06 per
// turn, and a recording fakeTts that tracks every feedSentence call.
// The first turn's TTS chunks land normally; after recordTurn the
// host observes status.hit, suspends the loop, and fires
// onCapStateChange (which production wires to wss.broadcastCapState +
// persistCapState). The second turn's emitFinal is dropped at the
// loop boundary, so feedSentence's call count is unchanged.
//
// Run: node --test daemon/test/audio-host-daily-cost-cap.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost } = await import("../dist/audio-host.js");
const { TurnTelemetry } = await import("../dist/turn-telemetry.js");
const {
  DailyCostCap,
  persistCapState,
  loadCapState,
} = await import("../dist/daily-cost-cap.js");

class FakeVad {
  constructor() {
    this.startHandlers = [];
    this.endHandlers = [];
  }
  onSpeechStart(h) {
    this.startHandlers.push(h);
  }
  onSpeechEnd(h) {
    this.endHandlers.push(h);
  }
  emitStart() {
    for (const h of this.startHandlers) h(0);
  }
  emitEnd() {
    for (const h of this.endHandlers) h(0);
  }
}

class FakeStt {
  constructor() {
    this.handlers = [];
  }
  onFinal(h) {
    this.handlers.push(h);
  }
  emitFinal(text) {
    for (const h of this.handlers) h(text, "engine");
  }
}

class FakeTts {
  constructor() {
    this.feeds = [];
    this.finishCount = 0;
    this.disposeCount = 0;
  }
  feedSentence(text) {
    this.feeds.push(text);
  }
  finish() {
    this.finishCount += 1;
  }
  dispose() {
    this.disposeCount += 1;
  }
}

class FakeChatBridge {
  constructor() {
    this.suspended = false;
  }
  setSuspended(s) {
    this.suspended = s;
  }
}

function streamFromChunks(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await wait(1);
        yield c;
      }
    },
  };
}

/** Router that emits a single short reply per turn AND surfaces a
 *  Sonnet usage record that prices at ≈$0.06 (1k input + 3k output @
 *  Sonnet rates = $0.003 + $0.045 = $0.048). Crosses a $0.01 cap. */
function expensiveRouter() {
  return {
    calls: [],
    route(systemBlocks, payload) {
      this.calls.push({ payload });
      return streamFromChunks(["acknowledged."]);
    },
    getLastOutcome() {
      return { tier: "sonnet", reason: "trigger=EXPLICIT_ASK" };
    },
    getLastTokenUsage() {
      return {
        sonnet: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1_000, output_tokens: 3_000 },
        },
      };
    },
  };
}

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1.6-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildHost({ capUsd = 0.01, capSuspendables, onCapStateChange } = {}) {
  const tmp = freshTempDir();
  const turnsPath = join(tmp.dir, "turns.jsonl");
  const tel = new TurnTelemetry(turnsPath);
  const cap = new DailyCostCap({ capUsd, turnTelemetry: tel });
  const vad = new FakeVad();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const router = expensiveRouter();
  const host = new AudioHost({
    vad,
    stt,
    tts,
    router,
    turnTelemetry: tel,
    dailyCostCap: cap,
    capSuspendables,
    onCapStateChange,
    getSystemBlocks: () => ["sys"],
    getMode: () => "tutor",
    getPersonality: () => "nice",
    getWakeWord: () => "off",
    log: () => {},
  });
  return {
    host,
    vad,
    stt,
    tts,
    router,
    cap,
    tel,
    tmp,
    cleanup: tmp.cleanup,
  };
}

test("16.1.6 (a) SPEC HEADLINE: BUDDY_DAILY_USD=0.01 + per-turn USD ~$0.05 → second turn never reaches tts.feedSentence; capState=hit fires", async () => {
  const broadcasts = [];
  const { host, vad, stt, tts, router, cleanup } = buildHost({
    capUsd: 0.01,
    onCapStateChange: (status) => broadcasts.push(status),
  });
  try {
    // --- Turn 1: cap not yet hit, full turn flows through ---
    vad.emitStart();
    stt.emitFinal("first question");
    await host.awaitSettled();
    // Drain any post-record async work.
    await wait(20);

    assert.equal(router.calls.length, 1, "turn 1 reaches the router");
    assert.ok(tts.feeds.length >= 1, "turn 1 reaches TTS feedSentence");
    const turn1Feeds = tts.feeds.length;
    assert.equal(broadcasts.length, 1, "cap transition fires once after turn 1");
    assert.equal(broadcasts[0].hit, true, "broadcast carries hit=true");
    assert.ok(
      broadcasts[0].spentUsd > 0.01,
      `spent ${broadcasts[0].spentUsd} should exceed 0.01 cap`
    );

    // --- Turn 2: cap is hit, loop suspended → no router call, no TTS ---
    vad.emitStart();
    stt.emitFinal("second question");
    await wait(50);

    assert.equal(
      router.calls.length,
      1,
      "turn 2 router NOT called (loop suspended by cap downgrade)"
    );
    assert.equal(
      tts.feeds.length,
      turn1Feeds,
      "turn 2 produced no new feedSentence calls"
    );
    assert.equal(host.getState(), "IDLE", "loop stays IDLE under suspension");
    assert.equal(
      broadcasts.length,
      1,
      "no second transition — already hit, no edge to broadcast"
    );
  } finally {
    cleanup();
  }
});

test("16.1.6 (b) capSuspendables (chat-path bridge) flips alongside the host-owned loop", async () => {
  const chat = new FakeChatBridge();
  const { host, vad, stt, cleanup } = buildHost({
    capUsd: 0.01,
    capSuspendables: [chat],
  });
  try {
    assert.equal(chat.suspended, false, "chat bridge starts un-suspended");

    vad.emitStart();
    stt.emitFinal("burn the budget");
    await host.awaitSettled();
    await wait(20);

    assert.equal(
      chat.suspended,
      true,
      "chat-path bridge MUST be suspended on cap-hit transition"
    );
  } finally {
    cleanup();
  }
});

test("16.1.6 (c) cap omitted preserves prior behaviour: every turn reaches TTS regardless of spend", async () => {
  const tmp = freshTempDir();
  try {
    const tel = new TurnTelemetry(join(tmp.dir, "turns.jsonl"));
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const router = expensiveRouter();
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router,
      turnTelemetry: tel,
      // dailyCostCap intentionally omitted
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    // Two expensive turns — without a cap, both should land at TTS.
    vad.emitStart();
    stt.emitFinal("turn one");
    await host.awaitSettled();
    const t1 = tts.feeds.length;

    vad.emitStart();
    stt.emitFinal("turn two");
    await host.awaitSettled();

    assert.ok(t1 >= 1, "first turn reached TTS");
    assert.ok(tts.feeds.length > t1, "second turn ALSO reached TTS — no cap");
    assert.equal(router.calls.length, 2, "router called for every turn");
    void host;
  } finally {
    tmp.cleanup();
  }
});

test("16.1.6 (d) persistCapState round-trips today's hit status to disk", () => {
  const tmp = freshTempDir();
  try {
    const path = join(tmp.dir, "daily-cost.json");
    const status = {
      spentUsd: 0.0612,
      capUsd: 0.01,
      hit: true,
      forDate: new Date().toISOString().slice(0, 10),
      computedAt: Date.now(),
    };
    persistCapState(path, status);
    assert.ok(existsSync(path), "file written");

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.hit, true);
    assert.equal(parsed.spent_usd, 0.0612);
    assert.equal(parsed.cap_usd, 0.01);
    assert.equal(parsed.date, status.forDate);

    // loadCapState returns the persisted shape iff the date is "today".
    const loaded = loadCapState(path);
    assert.ok(loaded);
    assert.equal(loaded.hit, true);

    // Future load with `now` pointing at tomorrow → undefined (slate is fresh).
    const tomorrowMs = Date.now() + 26 * 60 * 60_000;
    const stale = loadCapState(path, () => tomorrowMs);
    assert.equal(stale, undefined, "yesterday's persisted state is ignored");
  } finally {
    tmp.cleanup();
  }
});

test("16.1.6 (e) onCapStateChange is fired with the host-observed CapStatus, not a stale snapshot", async () => {
  const captured = [];
  const { host, vad, stt, cleanup } = buildHost({
    capUsd: 0.01,
    onCapStateChange: (s) => captured.push({ ...s }),
  });
  try {
    vad.emitStart();
    stt.emitFinal("blow the budget");
    await host.awaitSettled();
    await wait(20);

    assert.equal(captured.length, 1);
    const s = captured[0];
    assert.equal(s.hit, true);
    assert.equal(s.capUsd, 0.01);
    assert.ok(typeof s.forDate === "string" && s.forDate.length === 10);
    assert.ok(typeof s.computedAt === "number");
  } finally {
    cleanup();
  }
});
