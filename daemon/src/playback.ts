// Real audio device wiring (TTS playback path) — Task 16.1.7.
//
// PCM chunks arrive from `StreamingTtsBridge.onAudioChunk` (Phase 10
// streaming TTS). This module fronts the OS-side playback path so
// the audio host doesn't need to know about subprocesses, device IDs,
// or which CLI tool is available — it just speaks the
// `PlaybackSink` interface.
//
// Production wires a `SubprocessPlaybackSink` that pipes raw PCM
// (signed-16-bit little-endian) into the user-selected output device
// via one of:
//   - paplay --raw   (PulseAudio / Linux)
//   - ffplay -f s16le -i -   (cross-platform, requires ffmpeg)
//
// The user picks the output device via the extension command
// `coding-buddy.selectAudioDevices`, which writes
// `BUDDY_AUDIO_OUTPUT_ID` to .env. The daemon reads it on boot and
// passes it through to the chosen subprocess.
//
// Tests substitute a `RecordingPlaybackSink` that captures the byte
// sequence in arrival order — this matches the spec's headline test
// (TASKS.md 16.1.7): "a fake binary frame sequence drives a recording
// sink that captures the bytes; assert the bytes match the upstream
// order".

import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Writable } from "node:stream";

/** PCM format passed at sentence_start so the playback sink can
 *  configure the player subprocess (sample rate / channels). All of
 *  Kokoro's frames are signed 16-bit little-endian today; if a future
 *  backend ships a different encoding, extend this union. */
export interface PlaybackFormat {
  sampleRate: number;
  channels: number;
  encoding: "pcm_s16le";
}

/** Anything that consumes a streamed PCM utterance. The lifecycle is
 *  one `beginUtterance` followed by 0..M `writeChunk` calls and
 *  exactly one `endUtterance`. Implementations MUST preserve the
 *  byte order of `writeChunk` — out-of-order playback produces
 *  garbled audio. `dispose` tears down any held resources. */
export interface PlaybackSink {
  beginUtterance(format: PlaybackFormat): void;
  writeChunk(buf: Buffer): void;
  endUtterance(): void;
  dispose(): void;
}

/** Narrow shape of a streaming-TTS bridge that the playback wire
 *  needs. The real `StreamingTtsBridge` satisfies this; tests can
 *  pass a fake that just registers handlers and triggers them. */
export interface PlaybackBridgeLike {
  onSentenceStart(
    h: (info: { sampleRate: number; channels: number; idx: number }) => void
  ): void;
  onAudioChunk(h: (buf: Buffer, idx: number) => void): void;
  onSentenceDone(h: (idx: number) => void): void;
}

/** Wire a playback sink to a streaming-TTS bridge. Each `sentence_start`
 *  begins a fresh utterance; binary chunks flow through unchanged;
 *  `sentence_done` ends it. The host doesn't have to think about
 *  this — it's a pure subscription. */
export function wirePlayback(
  bridge: PlaybackBridgeLike,
  sink: PlaybackSink
): void {
  bridge.onSentenceStart((info) => {
    sink.beginUtterance({
      sampleRate: info.sampleRate,
      channels: info.channels,
      encoding: "pcm_s16le",
    });
  });
  bridge.onAudioChunk((buf) => {
    sink.writeChunk(buf);
  });
  bridge.onSentenceDone(() => {
    sink.endUtterance();
  });
}

/** In-memory recording sink — captures every byte written, partitioned
 *  by utterance. The headline 16.1.7 test asserts that
 *  `Buffer.concat(allUtterances)` matches the upstream chunk order
 *  byte-for-byte. */
export class RecordingPlaybackSink implements PlaybackSink {
  /** One Buffer[] per utterance, in start order. */
  utterances: Buffer[][] = [];
  /** sampleRate/channels seen per utterance. */
  formats: PlaybackFormat[] = [];
  /** Current open utterance, or null between utterances. */
  private current: Buffer[] | null = null;

  beginUtterance(format: PlaybackFormat): void {
    this.current = [];
    this.utterances.push(this.current);
    this.formats.push(format);
  }

  writeChunk(buf: Buffer): void {
    if (!this.current) {
      throw new Error(
        "[recording-playback] writeChunk called outside any utterance"
      );
    }
    // Copy so callers mutating their buffer don't corrupt our record.
    this.current.push(Buffer.from(buf));
  }

  endUtterance(): void {
    this.current = null;
  }

  dispose(): void {
    this.current = null;
  }

  /** Concatenate every byte across every utterance in arrival order.
   *  The headline 16.1.7 invariant compares this against the
   *  upstream sequence. */
  allBytes(): Buffer {
    return Buffer.concat(this.utterances.flat());
  }
}

export interface SubprocessPlaybackSinkOptions {
  /** OS device id from BUDDY_AUDIO_OUTPUT_ID. `default`, empty, or
   *  unset all mean "use the OS default device". When the chosen
   *  player CLI supports a device flag, this gets passed through. */
  outputDeviceId?: string;
  /** Optional logger; defaults to no-op (production passes
   *  console.log). */
  log?: (line: string) => void;
  /** Override the spawn function for tests / dependency injection. */
  spawn?: typeof nodeSpawn;
  /** Override the platform detection (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Override the player resolver — production walks PATH for paplay
   *  / ffplay; tests inject a fixed result. Returning undefined makes
   *  the sink degrade to a logged no-op (the daemon stays up; no
   *  audio plays). */
  resolvePlayer?: (platform: NodeJS.Platform) => PlayerSpec | undefined;
}

/** Description of an OS playback CLI. The sink spawns it per
 *  utterance, pipes PCM into stdin, and closes stdin on
 *  endUtterance. The CLI must accept raw PCM on stdin — paplay,
 *  ffplay, sox -t raw all qualify. */
export interface PlayerSpec {
  /** Executable to spawn (resolved to absolute path is fine). */
  command: string;
  /** Function returning the argv given the playback format and
   *  optional device id. Lets each CLI map sample-rate / channels /
   *  device flags appropriately. */
  args: (
    format: PlaybackFormat,
    outputDeviceId: string | undefined
  ) => string[];
}

/** Auto-detect the best available player on the current platform.
 *  Linux prefers paplay (PulseAudio); everywhere else falls back to
 *  ffplay if it's on PATH. Returns undefined when none found —
 *  callers should log and degrade. */
export function defaultResolvePlayer(
  platform: NodeJS.Platform
): PlayerSpec | undefined {
  const has = (cmd: string): boolean => {
    const probe = spawnSync(platform === "win32" ? "where" : "which", [cmd], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return probe.status === 0;
  };
  if (platform === "linux" && has("paplay")) {
    return {
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
    };
  }
  if (has("ffplay")) {
    return {
      command: "ffplay",
      args: (fmt) => [
        "-f",
        "s16le",
        "-ar",
        String(fmt.sampleRate),
        "-ac",
        String(fmt.channels),
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "error",
        "-",
      ],
    };
  }
  return undefined;
}

/** Production playback sink. Spawns the OS player per utterance and
 *  pipes PCM into its stdin. Failures (player crashes, write to a
 *  closed pipe) are logged but never thrown — the daemon keeps
 *  running; the user just doesn't hear the broken sentence. */
export class SubprocessPlaybackSink implements PlaybackSink {
  private outputDeviceId: string | undefined;
  private log: (line: string) => void;
  private spawnFn: typeof nodeSpawn;
  private platform: NodeJS.Platform;
  private player: PlayerSpec | undefined;
  private active?: ChildProcessByStdio<Writable, null, null>;

  constructor(opts: SubprocessPlaybackSinkOptions = {}) {
    this.outputDeviceId = opts.outputDeviceId;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.platform = opts.platform ?? process.platform;
    const resolver = opts.resolvePlayer ?? defaultResolvePlayer;
    this.player = resolver(this.platform);
    if (!this.player) {
      this.log(
        `[playback] no player CLI found on ${this.platform} (looked for paplay/ffplay) — TTS audio will not be heard. Install ffmpeg or set up PulseAudio.`
      );
    }
  }

  beginUtterance(format: PlaybackFormat): void {
    if (!this.player) return;
    // Defensive: a stuck previous utterance shouldn't block the new
    // one. Closing stdin on the old proc lets it drain and exit.
    if (this.active) {
      try {
        this.active.stdin.end();
      } catch {
        // closed mid-flight
      }
      this.active = undefined;
    }
    try {
      const args = this.player.args(format, this.outputDeviceId);
      // stdio: stdin piped, stdout discarded, stderr discarded.
      // We don't need to read anything back — the player either plays
      // the audio or fails (we'll see errors via the 'error' event).
      const proc = this.spawnFn(this.player.command, args, {
        stdio: ["pipe", "ignore", "ignore"],
      }) as unknown as ChildProcessByStdio<Writable, null, null>;
      proc.on("error", (err) => {
        this.log(`[playback] ${this.player?.command} spawn error: ${err.message}`);
      });
      proc.on("exit", (code, signal) => {
        if (code !== 0 && code !== null && signal === null) {
          this.log(
            `[playback] ${this.player?.command} exited code=${code}`
          );
        }
        if (this.active === proc) this.active = undefined;
      });
      this.active = proc;
    } catch (err) {
      this.log(
        `[playback] failed to spawn ${this.player.command}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      this.active = undefined;
    }
  }

  writeChunk(buf: Buffer): void {
    if (!this.active) return;
    try {
      this.active.stdin.write(buf);
    } catch (err) {
      this.log(
        `[playback] write to ${this.player?.command} stdin failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  endUtterance(): void {
    if (!this.active) return;
    try {
      this.active.stdin.end();
    } catch {
      // pipe already closed by the player exiting; nothing to do.
    }
    // Don't unset `active` here — leave it for `exit` to clear so we
    // can detect overlap and drain cleanly.
  }

  dispose(): void {
    if (this.active) {
      try {
        this.active.kill("SIGINT");
      } catch {
        // already exited
      }
      this.active = undefined;
    }
  }
}
