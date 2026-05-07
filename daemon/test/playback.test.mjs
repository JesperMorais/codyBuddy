// Task 16.1.7: real audio device wiring (TTS playback path).
//
// Spec headline (TASKS.md 16.1.7): "a fake binary frame sequence
// drives a recording sink that captures the bytes; assert the bytes
// match the upstream order".
//
// We exercise three layers:
//   (a) RecordingPlaybackSink preserves chunk order across utterances.
//   (b) wirePlayback subscribes a sink to a streaming-TTS bridge so
//       sentence_start → beginUtterance, audioChunk → writeChunk,
//       sentence_done → endUtterance.
//   (c) SubprocessPlaybackSink degrades gracefully when no player is
//       installed (degenerate platform → no-op, no crash).
//
// Run: node --test daemon/test/playback.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const {
  RecordingPlaybackSink,
  SubprocessPlaybackSink,
  wirePlayback,
} = await import("../dist/playback.js");

/** Tiny fake bridge that exposes the three onX methods wirePlayback
 *  needs and emit*() helpers for tests to drive. */
class FakeBridge {
  constructor() {
    this.startHandlers = [];
    this.chunkHandlers = [];
    this.doneHandlers = [];
  }
  onSentenceStart(h) {
    this.startHandlers.push(h);
  }
  onAudioChunk(h) {
    this.chunkHandlers.push(h);
  }
  onSentenceDone(h) {
    this.doneHandlers.push(h);
  }
  emitStart(idx, sampleRate = 24000, channels = 1) {
    for (const h of this.startHandlers) h({ idx, sampleRate, channels });
  }
  emitChunk(buf, idx) {
    for (const h of this.chunkHandlers) h(buf, idx);
  }
  emitDone(idx) {
    for (const h of this.doneHandlers) h(idx);
  }
}

test("16.1.7 (a) SPEC HEADLINE: a fake binary frame sequence drives a recording sink whose bytes match upstream order", () => {
  const bridge = new FakeBridge();
  const sink = new RecordingPlaybackSink();
  wirePlayback(bridge, sink);

  // Synthesise an upstream sequence across two sentences, with
  // multiple chunks per sentence. Each chunk is a uniquely-tagged
  // PCM-shaped buffer so the test can detect any reordering.
  const u0c0 = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const u0c1 = Buffer.from([0x04, 0x05, 0x06, 0x07]);
  const u0c2 = Buffer.from([0x08, 0x09, 0x0a, 0x0b]);
  const u1c0 = Buffer.from([0x10, 0x11, 0x12, 0x13]);
  const u1c1 = Buffer.from([0x14, 0x15, 0x16, 0x17]);

  bridge.emitStart(0);
  bridge.emitChunk(u0c0, 0);
  bridge.emitChunk(u0c1, 0);
  bridge.emitChunk(u0c2, 0);
  bridge.emitDone(0);

  bridge.emitStart(1);
  bridge.emitChunk(u1c0, 1);
  bridge.emitChunk(u1c1, 1);
  bridge.emitDone(1);

  // Per-utterance bookkeeping is correct.
  assert.equal(sink.utterances.length, 2);
  assert.equal(sink.utterances[0].length, 3);
  assert.equal(sink.utterances[1].length, 2);

  // The aggregate byte stream matches the upstream chunk order
  // BYTE-FOR-BYTE — the spec invariant.
  const expected = Buffer.concat([u0c0, u0c1, u0c2, u1c0, u1c1]);
  assert.deepEqual(sink.allBytes(), expected);
});

test("16.1.7 (b) RecordingPlaybackSink copies chunks — caller mutating their buffer afterwards must not corrupt the record", () => {
  const sink = new RecordingPlaybackSink();
  sink.beginUtterance({ sampleRate: 24000, channels: 1, encoding: "pcm_s16le" });
  const original = Buffer.from([0xaa, 0xbb, 0xcc]);
  sink.writeChunk(original);
  // Mutate the caller's buffer post-write.
  original[0] = 0x00;
  original[1] = 0x00;
  original[2] = 0x00;
  sink.endUtterance();

  // The recorded chunk must still hold the original bytes.
  assert.deepEqual(sink.utterances[0][0], Buffer.from([0xaa, 0xbb, 0xcc]));
});

test("16.1.7 (b) writeChunk outside any utterance throws — guards against silent data loss", () => {
  const sink = new RecordingPlaybackSink();
  assert.throws(() => sink.writeChunk(Buffer.from([0x01])), /outside any utterance/);
});

test("16.1.7 (c) wirePlayback forwards the playback format from sentence_start to beginUtterance", () => {
  const bridge = new FakeBridge();
  const sink = new RecordingPlaybackSink();
  wirePlayback(bridge, sink);

  bridge.emitStart(0, 16000, 2);
  bridge.emitDone(0);

  assert.equal(sink.formats.length, 1);
  assert.deepEqual(sink.formats[0], {
    sampleRate: 16000,
    channels: 2,
    encoding: "pcm_s16le",
  });
});

test("16.1.7 (d) SubprocessPlaybackSink with no resolved player degrades to a logged no-op (writeChunk doesn't throw)", () => {
  const logs = [];
  const sink = new SubprocessPlaybackSink({
    log: (line) => logs.push(line),
    // Force the resolver to return undefined regardless of host.
    resolvePlayer: () => undefined,
  });
  // Initial log should warn about missing player.
  assert.ok(
    logs.some((l) => /no player CLI found/.test(l)),
    `expected boot warning; logs=${JSON.stringify(logs)}`
  );

  // The full lifecycle must not throw — daemon must stay up.
  sink.beginUtterance({ sampleRate: 24000, channels: 1, encoding: "pcm_s16le" });
  sink.writeChunk(Buffer.from([0x01, 0x02]));
  sink.endUtterance();
  sink.dispose();
});

test("16.1.7 (d) SubprocessPlaybackSink uses the injected spawn fn and forwards the device id to the player args", () => {
  const spawnCalls = [];
  /** Stub spawn returning a child-process-shaped object with a
   *  recording stdin and event-emitter no-ops. */
  const fakeSpawn = (cmd, args) => {
    const writes = [];
    const proc = {
      stdin: {
        write: (buf) => {
          writes.push(Buffer.from(buf));
          return true;
        },
        end: () => {},
      },
      stdout: null,
      stderr: null,
      kill: () => {},
      on: () => proc,
      once: () => proc,
      writes,
    };
    spawnCalls.push({ cmd, args, proc });
    return proc;
  };
  const sink = new SubprocessPlaybackSink({
    outputDeviceId: "alsa_output.pci-0000_00_1f.3.analog-stereo",
    spawn: fakeSpawn,
    platform: "linux",
    resolvePlayer: () => ({
      command: "paplay",
      args: (fmt, dev) => {
        const a = [
          "--raw",
          `--rate=${fmt.sampleRate}`,
          `--channels=${fmt.channels}`,
          "--format=s16le",
        ];
        if (dev && dev !== "default") a.push(`--device=${dev}`);
        return a;
      },
    }),
    log: () => {},
  });

  sink.beginUtterance({ sampleRate: 24000, channels: 1, encoding: "pcm_s16le" });
  sink.writeChunk(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  sink.endUtterance();
  sink.dispose();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, "paplay");
  assert.deepEqual(spawnCalls[0].args, [
    "--raw",
    "--rate=24000",
    "--channels=1",
    "--format=s16le",
    "--device=alsa_output.pci-0000_00_1f.3.analog-stereo",
  ]);
  assert.deepEqual(spawnCalls[0].proc.writes[0], Buffer.from([0xde, 0xad, 0xbe, 0xef]));
});
