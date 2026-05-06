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

export type Canceller = () => void | Promise<void>;

export interface BargeInOptions {
  log?: (line: string) => void;
}

export class BargeInController {
  private cancellers: Array<{ name: string; fn: Canceller }> = [];
  private inFlight = false;
  private log: (line: string) => void;

  constructor(opts: BargeInOptions = {}) {
    this.log = opts.log ?? ((l) => console.log(l));
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
   *  wall-clock elapsed ms once all cancellers have settled. A
   *  canceller that throws is logged but never blocks the others.
   *  Re-entrant calls (a second trigger() while the first is still
   *  running) resolve to 0 immediately — the work is already in
   *  progress. */
  async trigger(): Promise<number> {
    if (this.inFlight) return 0;
    if (this.cancellers.length === 0) return 0;
    this.inFlight = true;
    const startedAt = Date.now();
    const snapshot = [...this.cancellers];
    try {
      await Promise.allSettled(
        snapshot.map(async ({ name, fn }) => {
          try {
            await fn();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`[barge-in] canceller ${name} threw: ${msg}`);
          }
        })
      );
    } finally {
      this.inFlight = false;
    }
    return Date.now() - startedAt;
  }
}
