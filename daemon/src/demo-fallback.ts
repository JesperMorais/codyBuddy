// Demo-fallback wrapper — Task 15.4.
//
// Wraps a real AiClient (typically AnthropicClient) plus a
// DemoClient. While demo is active, every call attempts the real
// client first; on success the wrapper PERMANENTLY promotes itself
// to "real-only" and returns the real reply. On failure (or when
// the real client returns an empty no_op suggesting a
// misconfiguration), the wrapper falls back to demo for that turn
// and keeps trying real on the next.
//
// "Auto-disables when an API key is set and the first real
// Anthropic call succeeds" — that's the contract from the spec.
// Pure transitions, no global state.
//
// When the daemon boots with BUDDY_DEMO=true and NO API key, it
// uses DemoClient pure (the path the main spec test exercises).
// When BUDDY_DEMO=true AND a key IS set, it uses this wrapper so
// the demo banner clears the moment the real call works.

import type { AiClient, BuddyReply, SpeakDecision } from "./anthropic.js";
import type { MisconceptionMap } from "./memory.js";
import type { DemoClient } from "./demo-client.js";

export interface DemoFallbackOptions {
  real: AiClient;
  demo: DemoClient;
  /** Fired the FIRST time a real call succeeds and demo is
   *  permanently disabled. The server uses this to broadcast a
   *  `{type:"demoMode", active:false}` message to connected
   *  webviews so the watermark clears in real time. */
  onRealSuccess?: () => void;
}

export class DemoFallbackClient implements AiClient {
  private demoActive = true;

  constructor(private opts: DemoFallbackOptions) {}

  /** Read the active flag — for tests / introspection. */
  isDemoActive(): boolean {
    return this.demoActive;
  }

  private markRealSuccess(): void {
    if (this.demoActive) {
      this.demoActive = false;
      try {
        this.opts.onRealSuccess?.();
      } catch (err) {
        console.error("[demo-fallback] onRealSuccess threw:", err);
      }
    }
  }

  async shouldSpeak(triggerPayload: object, summary: string): Promise<SpeakDecision> {
    if (!this.demoActive) {
      return this.opts.real.shouldSpeak(triggerPayload, summary);
    }
    try {
      const v = await this.opts.real.shouldSpeak(triggerPayload, summary);
      this.markRealSuccess();
      return v;
    } catch {
      return this.opts.demo.shouldSpeak(triggerPayload, summary);
    }
  }

  async ask(
    systemBlocks: string[],
    sessionSummary: string,
    triggerPayload: object
  ): Promise<BuddyReply> {
    if (!this.demoActive) {
      return this.opts.real.ask(systemBlocks, sessionSummary, triggerPayload);
    }
    try {
      const reply = await this.opts.real.ask(
        systemBlocks,
        sessionSummary,
        triggerPayload
      );
      // Treat an actual non-empty reply as success. An empty
      // no_op may indicate the real client misfired (auth issue
      // returning fast) — fall back to demo this turn rather
      // than disabling demo on a degenerate result.
      if (reply.text && reply.text.trim().length > 0) {
        this.markRealSuccess();
        return reply;
      }
      return this.opts.demo.ask(systemBlocks, sessionSummary, triggerPayload);
    } catch {
      return this.opts.demo.ask(systemBlocks, sessionSummary, triggerPayload);
    }
  }

  async *askStream(
    systemBlocks: string[],
    triggerPayload: object,
    signal?: AbortSignal
  ): AsyncIterable<string> {
    if (!this.demoActive) {
      yield* this.opts.real.askStream(systemBlocks, triggerPayload, signal);
      return;
    }
    try {
      let any = false;
      for await (const chunk of this.opts.real.askStream(
        systemBlocks,
        triggerPayload,
        signal
      )) {
        any = true;
        yield chunk;
      }
      if (any) this.markRealSuccess();
      else {
        // Real stream produced nothing — demo fallback for this turn.
        yield* this.opts.demo.askStream(systemBlocks, triggerPayload, signal);
      }
    } catch {
      yield* this.opts.demo.askStream(systemBlocks, triggerPayload, signal);
    }
  }

  async summarize(transcript: string): Promise<string> {
    if (!this.demoActive) return this.opts.real.summarize(transcript);
    try {
      const s = await this.opts.real.summarize(transcript);
      this.markRealSuccess();
      return s;
    } catch {
      return this.opts.demo.summarize(transcript);
    }
  }

  async distillLearnerProfile(
    history: string,
    priorProfile: string,
    misconceptions: MisconceptionMap = {}
  ): Promise<string> {
    if (!this.demoActive) {
      return this.opts.real.distillLearnerProfile(
        history,
        priorProfile,
        misconceptions
      );
    }
    try {
      const p = await this.opts.real.distillLearnerProfile(
        history,
        priorProfile,
        misconceptions
      );
      this.markRealSuccess();
      return p;
    } catch {
      return this.opts.demo.distillLearnerProfile(
        history,
        priorProfile,
        misconceptions
      );
    }
  }
}
