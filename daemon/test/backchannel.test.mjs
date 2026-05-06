// Task 10.7: BackchannelController tests.
//
// Spec headline (verbatim): "with a 10s synthetic transcript, assert
// exactly one backchannel plays and the cooldown is honoured."
//
// We drive the controller with a fake clock (no real time passes)
// and a recording play() callback. State changes / VAD events come
// in the order the production loop will produce them.
//
// Run: node --test daemon/test/backchannel.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { BackchannelController } = await import("../dist/backchannel.js");

/** Builds a temp dir with N synthetic .wav files (empty bytes — we
 *  only care about file existence) so loadClips() picks them up. */
function freshClipsDir(names = ["mhm-1.wav", "mhm-2.wav", "right-1.wav", "yeah-1.wav", "hmm-1.wav"]) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-bc-"));
  for (const name of names) {
    writeFileSync(join(dir, name), Buffer.alloc(0));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Returns a controller wired to a fake clock and a recording play
 *  callback. The clock is mutable via the returned `setClock`. */
function buildController({ clipsDir, enabled = true, speechThresholdMs, cooldownMs } = {}) {
  let now = 1_000_000;
  const played = [];
  const ctrl = new BackchannelController({
    enabled,
    clipsDir,
    speechThresholdMs,
    cooldownMs,
    play: (clip) => played.push({ clip, at: now }),
    clock: () => now,
    pick: (clips, prev) => {
      // Deterministic: pick the first clip that isn't `prev`.
      const idx = clips.findIndex((c) => c !== prev);
      return idx >= 0 ? idx : 0;
    },
    log: () => {},
  });
  return {
    ctrl,
    played,
    advance(ms) {
      now += ms;
    },
    setClock(t) {
      now = t;
    },
    get now() {
      return now;
    },
  };
}

test("10.7 (a) exactly one backchannel fires across a 10s synthetic transcript with one >3s segment", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({ clipsDir: dir });
    assert.equal(ctrl.isEnabled(), true);
    assert.equal(ctrl.clipCount(), 5);

    // Start of voice turn: loop transitions IDLE → LISTENING and VAD
    // fires speech.start. Synthetic transcript: user speaks for the
    // full 10s window without pause.
    ctrl.notifyState("LISTENING");
    ctrl.notifySpeechStart();

    // Tick every 100ms for 10s. The controller decides when (or if)
    // to fire — and how many times.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      ctrl.tick();
      advance(100);
    }
    // End of speech.
    ctrl.notifySpeechEnd();
    ctrl.notifyState("THINKING");

    assert.equal(played.length, 1, `expected exactly one backchannel, got ${played.length}`);
    // First fire must land just after the 3s threshold, not earlier.
    // Allow one tick of slop (the controller re-checks every 100ms).
    const fireOffsetMs = played[0].at - 1_000_000;
    assert.ok(
      fireOffsetMs >= 3000 && fireOffsetMs <= 3200,
      `fire offset ${fireOffsetMs}ms outside [3000, 3200]`
    );
  } finally {
    cleanup();
  }
});

test("10.7 (b) cooldown ≥8s is honoured across two consecutive speech segments", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({ clipsDir: dir });

    // Segment 1: 4s of speech (fires one backchannel at ~3s).
    ctrl.notifyState("LISTENING");
    ctrl.notifySpeechStart();
    for (let i = 0; i < 40; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(played.length, 1, "first segment should have fired one backchannel");
    const firstAt = played[0].at;
    ctrl.notifySpeechEnd();

    // 2s gap (user paused).
    advance(2_000);

    // Segment 2: another 4s of speech. The cooldown wall (8s since
    // the first play) hasn't elapsed yet, so no fire.
    ctrl.notifySpeechStart();
    for (let i = 0; i < 40; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(
      played.length,
      1,
      `cooldown should suppress segment-2 fire; played ${played.length}`
    );

    // Continue segment 2 long enough that the cooldown elapses
    // mid-segment. After segment-1 fire @ firstAt, +2s gap +4s
    // segment-2 = 6s elapsed. Need ≥2s more to clear the 8s
    // cooldown, then one more tick to actually fire.
    for (let i = 0; i < 30; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(played.length, 2, "cooldown elapsed, second fire should land");
    assert.ok(
      played[1].at - firstAt >= 8000,
      `gap ${played[1].at - firstAt}ms must be ≥ 8000ms`
    );
  } finally {
    cleanup();
  }
});

test("10.7 (c) BUDDY_BACKCHANNEL=off (enabled:false) is a complete no-op", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({ clipsDir: dir, enabled: false });
    assert.equal(ctrl.isEnabled(), false);
    ctrl.notifyState("LISTENING");
    ctrl.notifySpeechStart();
    for (let i = 0; i < 100; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(played.length, 0);
  } finally {
    cleanup();
  }
});

test("10.7 (d) state ≠ LISTENING blocks fires even when speech.start was the last VAD event", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({ clipsDir: dir });

    // We're in THINKING (e.g. waiting for STT final) — the controller
    // must NOT fire even though "user is speaking" from VAD's view.
    ctrl.notifyState("THINKING");
    ctrl.notifySpeechStart();
    for (let i = 0; i < 50; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(played.length, 0);
  } finally {
    cleanup();
  }
});

test("10.7 (e) speech segment <3s never fires", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({ clipsDir: dir });
    ctrl.notifyState("LISTENING");
    ctrl.notifySpeechStart();
    // 2.5s of speech, then end.
    for (let i = 0; i < 25; i++) {
      ctrl.tick();
      advance(100);
    }
    ctrl.notifySpeechEnd();
    assert.equal(played.length, 0);
  } finally {
    cleanup();
  }
});

test("10.7 (f) leaving LISTENING resets the per-segment latch (next LISTENING segment can fire)", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({
      clipsDir: dir,
      cooldownMs: 100, // tight cooldown so the second segment isn't gated by it
    });

    // First long segment fires once.
    ctrl.notifyState("LISTENING");
    ctrl.notifySpeechStart();
    for (let i = 0; i < 40; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(played.length, 1);
    ctrl.notifySpeechEnd();
    ctrl.notifyState("THINKING");
    ctrl.notifyState("SPEAKING");
    ctrl.notifyState("IDLE");

    // Plenty of wall time so the cooldown definitely elapsed.
    advance(5_000);

    // Second long segment can fire again.
    ctrl.notifyState("LISTENING");
    ctrl.notifySpeechStart();
    for (let i = 0; i < 40; i++) {
      ctrl.tick();
      advance(100);
    }
    assert.equal(played.length, 2, "second segment should also fire");
  } finally {
    cleanup();
  }
});

test("10.7 (g) clip selection avoids the previous clip on back-to-back fires", () => {
  const { dir, cleanup } = freshClipsDir();
  try {
    const { ctrl, played, advance } = buildController({
      clipsDir: dir,
      cooldownMs: 100,
    });

    // Three consecutive segments → three fires, no immediate repeats.
    for (let segment = 0; segment < 3; segment++) {
      ctrl.notifyState("LISTENING");
      ctrl.notifySpeechStart();
      for (let i = 0; i < 40; i++) {
        ctrl.tick();
        advance(100);
      }
      ctrl.notifySpeechEnd();
      ctrl.notifyState("IDLE");
      advance(500);
    }
    assert.equal(played.length, 3);
    for (let i = 1; i < played.length; i++) {
      assert.notEqual(
        played[i].clip,
        played[i - 1].clip,
        `back-to-back fires picked the same clip ${played[i].clip}`
      );
    }
  } finally {
    cleanup();
  }
});

test("10.7 (h) controller with empty clipsDir disables itself silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "buddy-bc-empty-"));
  try {
    const { ctrl } = buildController({ clipsDir: dir });
    assert.equal(ctrl.isEnabled(), false);
    assert.equal(ctrl.clipCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("10.7 (i) shipped voice/backchannels/ contains the 15 spec clips at 24kHz mono PCM", async () => {
  // Canary that the placeholder/real clips on disk satisfy the spec
  // shape. If a future PR drops the count or the format, this fails.
  const { readdirSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "voice", "backchannels");

  const wavs = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
  assert.equal(wavs.length, 15, `expected 15 .wav files, got ${wavs.length}: ${wavs.join(", ")}`);

  for (const word of ["mhm", "right", "yeah", "go-on", "hmm"]) {
    for (const take of [1, 2, 3]) {
      assert.ok(
        wavs.includes(`${word}-${take}.wav`),
        `missing required backchannel file ${word}-${take}.wav`
      );
    }
  }

  // Spot-check the first WAV's header — fmt chunk must declare
  // mono / 16-bit / 24kHz so playback at the kokoro sample rate
  // doesn't pitch-shift.
  const buf = readFileSync(join(dir, wavs[0]));
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  // Walk to the fmt chunk.
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const channels = buf.readUInt16LE(offset + 10);
      const sampleRate = buf.readUInt32LE(offset + 12);
      const bitsPerSample = buf.readUInt16LE(offset + 22);
      assert.equal(channels, 1, "must be mono");
      assert.equal(sampleRate, 24000, "must be 24kHz to match Kokoro");
      assert.equal(bitsPerSample, 16, "must be 16-bit");
      return;
    }
    offset += 8 + size + (size % 2);
  }
  assert.fail("no fmt chunk found in first backchannel WAV");
});
