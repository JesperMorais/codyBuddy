// Streaming STT bridge — Task 10.2.
//
// Wraps a long-lived subprocess (whisper.cpp's `stream` example, or
// any compatible adapter) that:
//   stdin  — raw 16kHz mono Int16 PCM frames, fed continuously
//   stdout — line-delimited JSON: {"type":"partial"|"final","text":...}
//   stderr — human-readable diagnostics, forwarded to the daemon log
//
// The bridge is intentionally agnostic about *how* the subprocess
// decides when to emit `final`. Real whisper-stream typically does it
// after a configurable silence interval; an adapter script can also
// emit it on EOF. signalSpeechEnd() bounds the wait: if no `final`
// arrives within speechEndTimeoutMs (default 400ms — the spec's
// requirement), the most recent partial is promoted to final and
// dispatched. This guarantees the live conversation loop never hangs
// waiting for the engine to settle.
//
// The bridge is a self-contained module — wiring it into the live
// audio path (mic → /vad → here → AnthropicClient.askStream) lands
// with the ConversationLoop in Task 10.6.

import { ChildProcess, spawn as nodeSpawn } from "node:child_process";

export interface StreamingSttOptions {
  /** Path to the streaming-STT binary or adapter script. */
  command: string;
  /** Arguments. Defaults to []. */
  args?: string[];
  /** Optional env merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** cwd for the spawn. */
  cwd?: string;
  /** Logger. Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * After signalSpeechEnd() the bridge waits this long for the
   * subprocess to emit a {type:"final"} event. If the deadline
   * passes, the last partial is promoted to final. Default 400ms —
   * the Task 10.2 spec's "final within 400ms of speech.end" budget.
   */
  speechEndTimeoutMs?: number;
  /** Test seam: replaces node:child_process.spawn. */
  spawnImpl?: typeof nodeSpawn;
}

export type PartialHandler = (text: string) => void;
export type FinalHandler = (text: string, source: "engine" | "promoted") => void;
export type ErrorHandler = (reason: string) => void;

interface SttEvent {
  type: string;
  text?: string;
  reason?: string;
}

export class StreamingSttBridge {
  private opts: StreamingSttOptions;
  private child?: ChildProcess;
  private alive = false;
  private partials: PartialHandler[] = [];
  private finals: FinalHandler[] = [];
  private errors: ErrorHandler[] = [];
  private lastPartial = "";
  private stdoutBuf = "";
  private speechEndTimer?: NodeJS.Timeout;
  private speechEndPending = false;
  private pendingFrames: Buffer[] = [];

  constructor(opts: StreamingSttOptions) {
    this.opts = opts;
  }

  isRunning(): boolean {
    return this.alive && this.child?.exitCode === null;
  }

  /** Spawns the subprocess and starts forwarding stdout. Returns true
   *  on a clean spawn, false when the binary is missing — in the
   *  latter case onError fires with the spawn reason and isRunning()
   *  stays false. Idempotent: noop when already running. */
  start(): boolean {
    if (this.isRunning()) return true;
    const log = this.opts.log ?? ((l: string) => console.log(l));
    const spawnFn = this.opts.spawnImpl ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(this.opts.command, this.opts.args ?? [], {
        env: { ...process.env, ...this.opts.env },
        cwd: this.opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[stt-stream] spawn failed: ${msg}`);
      this.dispatchError(`spawn failed: ${msg}`);
      return false;
    }
    this.child = child;
    this.alive = true;

    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) =>
      log(`[stt-stream] ${chunk.toString().trimEnd()}`)
    );
    child.on("exit", (code) => {
      this.alive = false;
      log(`[stt-stream] exited (code=${code})`);
    });
    child.on("error", (err) => {
      this.alive = false;
      const msg = err.message ?? String(err);
      log(`[stt-stream] subprocess error: ${msg}`);
      this.dispatchError(msg);
    });

    // Flush any audio buffered before start().
    while (this.pendingFrames.length) {
      const f = this.pendingFrames.shift()!;
      try {
        child.stdin?.write(f);
      } catch {
        // process may have exited; surface via error path
      }
    }
    return true;
  }

  /** Push raw 16kHz mono Int16 PCM into the engine. Frames sent
   *  before start() are buffered (capped) and flushed on spawn. */
  feedAudio(frame: Buffer): void {
    if (this.isRunning() && this.child?.stdin?.writable) {
      this.child.stdin.write(frame);
      return;
    }
    this.pendingFrames.push(frame);
    if (this.pendingFrames.length > 256) this.pendingFrames.shift();
  }

  /** Tell the bridge the upstream VAD just emitted speech.end. The
   *  bridge waits speechEndTimeoutMs for the engine to emit a
   *  {type:"final"} event; if none arrives, promotes the last partial
   *  to final and dispatches it tagged source:"promoted" so callers
   *  can distinguish engine truth from the bridge's safety net. */
  signalSpeechEnd(): void {
    if (this.speechEndPending) return; // already waiting
    this.speechEndPending = true;
    const ms = this.opts.speechEndTimeoutMs ?? 400;
    this.speechEndTimer = setTimeout(() => {
      this.speechEndTimer = undefined;
      if (!this.speechEndPending) return;
      this.speechEndPending = false;
      const promoted = this.lastPartial.trim();
      // Reset partial state so the next utterance starts fresh.
      this.lastPartial = "";
      for (const h of this.finals) h(promoted, "promoted");
    }, ms);
    this.speechEndTimer.unref?.();
  }

  onPartial(h: PartialHandler): void {
    this.partials.push(h);
  }

  onFinal(h: FinalHandler): void {
    this.finals.push(h);
  }

  onError(h: ErrorHandler): void {
    this.errors.push(h);
  }

  /** Tear down the subprocess. Idempotent. */
  stop(): void {
    if (this.speechEndTimer) clearTimeout(this.speechEndTimer);
    this.speechEndTimer = undefined;
    this.speechEndPending = false;
    if (!this.child) return;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // already dead
    }
    this.alive = false;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString();
    let idx;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let event: SttEvent | null = null;
      try {
        event = JSON.parse(line) as SttEvent;
      } catch {
        // Non-JSON lines (engine logs that escaped to stdout) are
        // dropped silently — stderr is the right channel for those.
        continue;
      }
      this.dispatchEvent(event);
    }
  }

  private dispatchEvent(ev: SttEvent): void {
    if (ev.type === "partial" && typeof ev.text === "string") {
      this.lastPartial = ev.text;
      for (const h of this.partials) h(ev.text);
    } else if (ev.type === "final" && typeof ev.text === "string") {
      // Final from the engine cancels the pending speech-end timer
      // so we don't double-fire with a promoted partial.
      if (this.speechEndTimer) {
        clearTimeout(this.speechEndTimer);
        this.speechEndTimer = undefined;
      }
      this.speechEndPending = false;
      const text = ev.text;
      this.lastPartial = "";
      for (const h of this.finals) h(text, "engine");
    } else if (ev.type === "error") {
      this.dispatchError(ev.reason ?? "unknown");
    }
  }

  private dispatchError(reason: string): void {
    for (const h of this.errors) h(reason);
  }
}
