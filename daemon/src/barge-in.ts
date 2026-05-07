// Barge-in controller — Task 10.5.
//
// The conversation loop registers cancellers (TTS playback, in-flight
// LLM stream, queued backchannels, anything else that should "shut up
// when the user starts talking") with this controller. Whoever
// observes the VAD's speech.start event then calls trigger(), which
// fans out to every registered canceller concurrently.
//
// Design notes:
//   - Cancellers are plain functions, not Promises — the controller
//     awaits whatever they return so async cleanup works, but doesn't
//     require it. A canceller that just calls childProcess.kill() and
//     returns is fine.
//   - trigger() returns a Promise resolved with the elapsed ms once
//     every canceller has settled. The conversation loop uses that
//     to log how long the barge-in took for telemetry; tests use it
//     to assert the spec's 100ms budget.
//   - Errors from individual cancellers are swallowed and logged —
//     a misbehaving TTS canceller mustn't prevent the LLM stream from
//     getting truncated.
//   - One trigger() call fires every canceller exactly once. If a new
//     speech.start arrives while a previous trigger() is still
//     awaiting cancellers, it's intentionally a no-op (we're already
//     mid-shutdown; firing again would just re-call killed processes).
//   - Per-canceller timeout (Task 16.10): if any individual canceller
//     hangs past `cancellerTimeoutMs` (default 100ms — the spec budget),
//     trigger() abandons it (Promise.race against a timer) and the
//     `inFlight` flag clears so subsequent speech.start events aren't
//     dropped indefinitely. The offender is logged by name so a stuck
//     TTS dispose / WS close is attributable.

export type Canceller = () => void | Promise<void>;

export interface BargeInOptions {
  log?: (line: string) => void;
  /** Per-canceller timeout in milliseconds. Defaults to 100ms — the
   *  spec's barge-in budget. A canceller that hasn't settled by then
   *  is abandoned (its name is logged) so a single hung canceller
   *  cannot wedge the conversation loop in INTERRUPTED forever. */
  cancellerTimeoutMs?: number;
}

export class BargeInController {
  private cancellers: Array<{ name: string; fn: Canceller }> = [];
  private inFlight = false;
  private log: (line: string) => void;
  private cancellerTimeoutMs: number;

  constructor(opts: BargeInOptions = {}) {
    this.log = opts.log ?? ((l) => console.log(l));
    this.cancellerTimeoutMs = opts.cancellerTimeoutMs ?? 100;
  }

  /** Register a canceller. The `name` is used in error logs so a
   *  thrown canceller is easy to attribute. Returns an `unregister`
   *  function for symmetry with EventEmitter-style APIs. */
  register(name: string, fn: Canceller): () => void {
    const entry = { name, fn };
    this.cancellers.push(entry);
    return () => {
      this.cancellers = this.cancellers.filter((e) => e !== entry);
    };
  }

  /** Number of currently-registered cancellers. Useful for tests
   *  that want to confirm the wiring took. */
  size(): number {
    return this.cancellers.length;
  }

  /** Returns true while a previous trigger() is still awaiting its
   *  cancellers. The conversation loop can branch on this to skip
   *  redundant kills. */
  isInFlight(): boolean {
    return this.inFlight;
  }

  /** Fire every registered canceller concurrently. Resolves to the
   *  wall-clock elapsed ms once all cancellers have settled (or been
   *  abandoned via timeout — see `cancellerTimeoutMs`). A canceller
   *  that throws is logged but never blocks the others. A canceller
   *  that hangs past the per-canceller timeout is abandoned (logged
   *  by name) so the controller cannot get stuck in `inFlight=true`.
   *  Re-entrant calls (a second trigger() while the first is still
   *  running) resolve to 0 immediately — the work is already in
   *  progress. */
  async trigger(): Promise<number> {
    if (this.inFlight) return 0;
    if (this.cancellers.length === 0) return 0;
    this.inFlight = true;
    const startedAt = Date.now();
    const snapshot = [...this.cancellers];
    const timeoutMs = this.cancellerTimeoutMs;
    try {
      await Promise.allSettled(
        snapshot.map(async ({ name, fn }) => {
          // Per-canceller race: bound each invocation by `timeoutMs` so
          // a stuck canceller (e.g. TTS dispose blocked on a slow WS
          // close) never wedges trigger(). The work itself isn't
          // killed — JS can't unilaterally cancel an async function —
          // but we stop awaiting it, the inFlight flag clears, and
          // future speech.start events fire normally.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = Symbol("barge-in:timeout");
          const timeout = new Promise<typeof timedOut>((resolve) => {
            timer = setTimeout(() => resolve(timedOut), timeoutMs);
            timer.unref?.();
          });
          try {
            const result = await Promise.race([
              (async () => {
                try {
                  await fn();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  this.log(`[barge-in] canceller ${name} threw: ${msg}`);
                }
              })(),
              timeout,
            ]);
            if (result === timedOut) {
              this.log(
                `[barge-in] canceller ${name} timed out after ${timeoutMs}ms — abandoning`
              );
            }
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        })
      );
    } finally {
      this.inFlight = false;
    }
    return Date.now() - startedAt;
  }
}
