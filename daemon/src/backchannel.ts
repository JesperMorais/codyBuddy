// Backchannel module — Task 10.7.
//
// While the conversation loop is in LISTENING and the user has been
// speaking continuously for >3s, the daemon plays a short pre-recorded
// acknowledgement clip ("mhm" / "right" / "yeah" / "go on" / "hmm")
// locally — no LLM call. Cooldown ≥8s between plays so the buddy
// doesn't spam interjections. Off when BUDDY_BACKCHANNEL=off.
//
// Why this is its own module rather than logic in the loop:
//   1. The loop's job is the IDLE↔LISTENING↔THINKING↔SPEAKING state
//      machine; backchannels are a side-channel that don't change
//      conversation state.
//   2. The play() side effect is mockable for tests (no real audio
//      device required).
//   3. The cooldown bookkeeping is small but easy to get wrong if
//      it shares state with the loop's INTERRUPTED transition.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type BackchannelState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "INTERRUPTED";

export interface BackchannelOptions {
  /** Master toggle. When false the controller is a complete no-op
   *  (won't even scan the clips dir on construction). */
  enabled?: boolean;
  /** Directory containing backchannel WAVs. Names must match the
   *  glob `*-{1,2,3}.wav` — see voice/backchannels/README.md. */
  clipsDir: string;
  /** Side-effect: play the chosen clip. Mockable for tests; in
   *  production this hands the WAV to the existing playback path
   *  (powershell on Windows, sounddevice elsewhere). */
  play: (clipPath: string) => void | Promise<void>;
  /** Speech duration above which a backchannel becomes eligible.
   *  Default 3000ms — the spec value. */
  speechThresholdMs?: number;
  /** Minimum gap between backchannels. Default 8000ms — the spec
   *  value. */
  cooldownMs?: number;
  /** Test seam for the wall clock. Defaults to Date.now. */
  clock?: () => number;
  /** Test seam for clip selection. Receives the candidate clip
   *  paths, returns the index to play. Defaults to a random pick
   *  that excludes the previous clip when possible. */
  pick?: (clips: string[], previous: string | null) => number;
  /** Optional logger. */
  log?: (line: string) => void;
}

export class BackchannelController {
  private enabled: boolean;
  private clips: string[];
  private play: (path: string) => void | Promise<void>;
  private speechThresholdMs: number;
  private cooldownMs: number;
  private clock: () => number;
  private pick: (clips: string[], previous: string | null) => number;
  private log: (line: string) => void;

  private state: BackchannelState = "IDLE";
  private speechStartedAt = 0;
  private lastPlayedAt = 0;
  private lastClip: string | null = null;
  /** Set to true after a backchannel fires for the *current* speech
   *  segment, so we never play more than one per turn. */
  private playedInCurrentSegment = false;

  constructor(opts: BackchannelOptions) {
    this.enabled = opts.enabled ?? true;
    this.play = opts.play;
    this.speechThresholdMs = opts.speechThresholdMs ?? 3000;
    this.cooldownMs = opts.cooldownMs ?? 8000;
    this.clock = opts.clock ?? Date.now;
    this.pick = opts.pick ?? defaultPick;
    this.log = opts.log ?? ((l) => console.log(l));
    this.clips = this.enabled ? loadClips(opts.clipsDir) : [];
    if (this.enabled && this.clips.length === 0) {
      this.log(
        `[backchannel] enabled but no clips found in ${opts.clipsDir} — disabling`
      );
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clipCount(): number {
    return this.clips.length;
  }

  /** Number of ms since the last backchannel fired. Returns
   *  Infinity if none has ever fired. */
  msSinceLastPlay(now = this.clock()): number {
    return this.lastPlayedAt === 0 ? Infinity : now - this.lastPlayedAt;
  }

  /** Wire from the loop: state changed. We only care about
   *  LISTENING (the only state where backchannels are eligible). */
  notifyState(next: BackchannelState): void {
    this.state = next;
    if (next !== "LISTENING") {
      // Leaving LISTENING resets the per-segment latch so the next
      // LISTENING segment can fire one if eligible.
      this.playedInCurrentSegment = false;
      this.speechStartedAt = 0;
    }
  }

  /** Wire from VAD: user just started talking. */
  notifySpeechStart(now = this.clock()): void {
    this.speechStartedAt = now;
    this.playedInCurrentSegment = false;
  }

  /** Wire from VAD: user stopped. Resets the per-segment latch. */
  notifySpeechEnd(): void {
    this.speechStartedAt = 0;
    this.playedInCurrentSegment = false;
  }

  /** Periodic check. Production wires this to a setInterval(100ms)
   *  or to the STT partial-transcript event. Tests call it
   *  directly with a fake clock. */
  tick(now = this.clock()): boolean {
    if (!this.enabled) return false;
    if (this.state !== "LISTENING") return false;
    if (this.playedInCurrentSegment) return false;
    if (this.speechStartedAt === 0) return false;
    if (now - this.speechStartedAt < this.speechThresholdMs) return false;
    if (this.msSinceLastPlay(now) < this.cooldownMs) return false;

    const idx = this.pick(this.clips, this.lastClip);
    const clip = this.clips[idx] ?? this.clips[0];
    this.lastClip = clip;
    this.lastPlayedAt = now;
    this.playedInCurrentSegment = true;
    try {
      void this.play(clip);
    } catch (err) {
      this.log(
        `[backchannel] play failed: ${err instanceof Error ? err.message : err}`
      );
    }
    return true;
  }
}

function loadClips(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".wav"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function defaultPick(clips: string[], previous: string | null): number {
  if (clips.length === 0) return 0;
  if (clips.length === 1) return 0;
  // Exclude the previous clip when possible so back-to-back fires
  // don't repeat the same take.
  let idx = Math.floor(Math.random() * clips.length);
  if (clips[idx] === previous) idx = (idx + 1) % clips.length;
  return idx;
}
