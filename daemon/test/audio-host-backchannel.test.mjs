// Task 16.1.4: BackchannelController periodic scheduler in the audio host.
//
// Spec headline (TASKS.md 16.1.4): "a synthetic 4s VAD speech-start
// segment in the host produces exactly one backchannel play() call
// and the cooldown is honoured across a 12s test horizon."
//
// We use the host's `backchannelTickMs: 0` knob to disable its
// internal setInterval and tick the controller manually with a
// fake clock — that way the test runs in milliseconds, not 12s of
// real wall time, while still exercising the host's wiring of
// notifyState / notifySpeechStart / notifySpeechEnd.
//
// Run: node --test daemon/test/audio-host-backchannel.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost } = await import("../dist/audio-host.js");
const { BackchannelController } = await import("../dist/backchannel.js");
const { TurnTelemetry } = await import("../dist/turn-telemetry.js");

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
  onFinal() {}
}

class FakeTts {
  feedSentence() {}
  finish() {}
  dispose() {}
}

class FakeRouter {
  route() {
    return {
      async *[Symbol.asyncIterator]() {
        yield "ok.";
      },
    };
  }
  getLastOutcome() {
    return { tier: "haiku", reason: "no_escalation" };
  }
}

/** Build a temp clipsDir with N synthetic .wav files so the
 *  controller has something to "play". */
function freshClipsDir(names = ["mhm-1.wav", "mhm-2.wav", "yeah-1.wav"]) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1.4-"));
  for (const name of names) writeFileSync(join(dir, name), Buffer.alloc(0));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildHost({ clipsDir, played, now }) {
  const fakeRouter = new FakeRouter();
  const vad = new FakeVad();
  const backchannel = new BackchannelController({
    enabled: true,
    clipsDir,
    play: (clip) => played.push({ clip, at: now() }),
    clock: now,
    log: () => {},
  });
  const tmpJsonl = join(clipsDir, "turns.jsonl");
  const host = new AudioHost({
    vad,
    stt: new FakeStt(),
    tts: new FakeTts(),
    router: fakeRouter,
    turnTelemetry: new TurnTelemetry(tmpJsonl),
    backchannel,
    backchannelTickMs: 0, // disable host setInterval; we tick manually
    getSystemBlocks: () => ["sys"],
    getMode: () => "tutor",
    getPersonality: () => "nice",
    getWakeWord: () => "off",
    log: () => {},
  });
  return { host, vad, backchannel };
}

test("16.1.4 (a) SPEC HEADLINE: 4s VAD speech-start segment produces exactly one backchannel play() call within a 12s horizon", () => {
  const { dir, cleanup } = freshClipsDir();
  let nowMs = 1_000_000;
  const played = [];
  try {
    const { host, vad, backchannel } = buildHost({
      clipsDir: dir,
      played,
      now: () => nowMs,
    });

    // Loop is IDLE; user starts speaking → loop transitions to LISTENING.
    vad.emitStart();
    // The audio host wires notifyState from loop transitions; manually
    // also notify in case the loop hasn't synchronously transitioned
    // for our fake. (vad.emitStart on the real loop synchronously
    // moves to LISTENING — see ConversationLoop.speechStart.)
    assert.equal(host.getState(), "LISTENING");
    assert.equal(backchannel.isEnabled(), true);

    // Tick every 100ms for 12 simulated seconds. Backchannel fires
    // once after the 3s threshold; cooldown (≥8s) must keep the
    // total at 1 across the whole window.
    for (let elapsedMs = 0; elapsedMs < 12_000; elapsedMs += 100) {
      backchannel.tick();
      nowMs += 100;
    }

    assert.equal(
      played.length,
      1,
      `expected exactly one backchannel play() in 12s; got ${played.length}`
    );
    // Fire offset: must land just after the 3s threshold.
    const fireOffsetMs = played[0].at - 1_000_000;
    assert.ok(
      fireOffsetMs >= 3_000 && fireOffsetMs <= 3_200,
      `fire offset ${fireOffsetMs}ms outside [3000, 3200]`
    );

    host.dispose();
  } finally {
    cleanup();
  }
});

test("16.1.4 (b) speech.end resets the per-segment latch — next long segment can fire again", () => {
  const { dir, cleanup } = freshClipsDir();
  let nowMs = 1_000_000;
  const played = [];
  try {
    const { host, vad, backchannel } = buildHost({
      clipsDir: dir,
      played,
      now: () => nowMs,
    });

    // Segment 1: 4s of speech → fires.
    vad.emitStart();
    for (let i = 0; i < 40; i++) {
      backchannel.tick();
      nowMs += 100;
    }
    assert.equal(played.length, 1);
    vad.emitEnd();

    // Wait long enough for the cooldown to elapse (8s+).
    nowMs += 10_000;

    // Segment 2: 4s of speech → fires again.
    vad.emitStart();
    for (let i = 0; i < 40; i++) {
      backchannel.tick();
      nowMs += 100;
    }
    assert.equal(played.length, 2, `expected 2 fires across two long segments`);

    host.dispose();
  } finally {
    cleanup();
  }
});

test("16.1.4 (c) speech segments under 3s never fire, even during a long listening window", () => {
  const { dir, cleanup } = freshClipsDir();
  let nowMs = 1_000_000;
  const played = [];
  try {
    const { host, vad, backchannel } = buildHost({
      clipsDir: dir,
      played,
      now: () => nowMs,
    });

    // Three short speech segments separated by 1s pauses.
    for (let segment = 0; segment < 3; segment++) {
      vad.emitStart();
      for (let i = 0; i < 25; i++) {
        // 2.5s
        backchannel.tick();
        nowMs += 100;
      }
      vad.emitEnd();
      nowMs += 1_000;
    }
    assert.equal(played.length, 0);

    host.dispose();
  } finally {
    cleanup();
  }
});

test("16.1.4 (d) host setInterval drives backchannel.tick() automatically (real-side smoke)", async () => {
  // This test uses the host's REAL 100ms setInterval. We use an
  // accelerated speech threshold so the test runs quickly. Verifies
  // the host actually wires the timer (not just the manual-tick path
  // tests cover above).
  const { dir, cleanup } = freshClipsDir();
  let nowMs = 1_000_000;
  const played = [];
  try {
    const fakeRouter = new FakeRouter();
    const vad = new FakeVad();
    const backchannel = new BackchannelController({
      enabled: true,
      clipsDir: dir,
      speechThresholdMs: 200, // accelerated for the test
      cooldownMs: 100,
      play: (clip) => played.push({ clip, at: nowMs }),
      clock: () => nowMs,
      log: () => {},
    });
    const tmpJsonl = join(dir, "turns.jsonl");
    const host = new AudioHost({
      vad,
      stt: new FakeStt(),
      tts: new FakeTts(),
      router: fakeRouter,
      turnTelemetry: new TurnTelemetry(tmpJsonl),
      backchannel,
      backchannelTickMs: 50, // host runs setInterval at 50ms
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    // Start speaking; advance the fake clock past the 200ms threshold.
    vad.emitStart();
    // Advance clock + let real time elapse so the host's 50ms
    // setInterval ticks at least 5 times.
    for (let i = 0; i < 10; i++) {
      nowMs += 50;
      await wait(55);
    }
    assert.ok(played.length >= 1, "host's setInterval should drive the controller to fire");
    host.dispose();
  } finally {
    cleanup();
  }
});

test("16.1.4 (e) host.dispose clears the backchannel setInterval (no leaked timers)", async () => {
  const { dir, cleanup } = freshClipsDir();
  let nowMs = 1_000_000;
  const played = [];
  try {
    const fakeRouter = new FakeRouter();
    const vad = new FakeVad();
    const backchannel = new BackchannelController({
      enabled: true,
      clipsDir: dir,
      speechThresholdMs: 50,
      cooldownMs: 50,
      play: (clip) => played.push({ clip, at: nowMs }),
      clock: () => nowMs,
      log: () => {},
    });
    const host = new AudioHost({
      vad,
      stt: new FakeStt(),
      tts: new FakeTts(),
      router: fakeRouter,
      turnTelemetry: new TurnTelemetry(join(dir, "turns.jsonl")),
      backchannel,
      backchannelTickMs: 30,
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    host.dispose();

    // Start speaking and advance time. With the timer cleared,
    // tick() is never called → no fires.
    vad.emitStart();
    for (let i = 0; i < 10; i++) {
      nowMs += 50;
      await wait(40);
    }
    assert.equal(
      played.length,
      0,
      "after dispose() the timer must be cleared and no fires happen"
    );
  } finally {
    cleanup();
  }
});
