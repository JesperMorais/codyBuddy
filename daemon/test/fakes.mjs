/**
 * FakeAnthropicClient — deterministic test double for the AiClient
 * interface. Lets tests bypass the network and assert exactly what
 * Session does with the returned BuddyReply.
 *
 * Usage:
 *   const fake = new FakeAnthropicClient({
 *     replies: [{ mode: "chat", text: "ok", wants_followup: false }],
 *   });
 *   const session = new Session(fake, prompts);
 *   const reply = await session.handleTrigger("EXPLICIT_ASK", payload);
 *
 * After the call, fake.calls.ask holds the recorded arguments.
 */
export class FakeAnthropicClient {
  constructor({
    replies = [],
    decisions = [],
    streamChunks = [],
    defaultStreamChunks = [],
    summary = "(fake summary)",
    profile = "(fake profile)",
    defaultDecision = "speak",
    telemetry,
    fakeUsage = { input_tokens: 100, output_tokens: 50 },
  } = {}) {
    this._replies = [...replies];
    this._decisions = [...decisions];
    this._streamChunks = [...streamChunks];
    this._defaultStreamChunks = [...defaultStreamChunks];
    this._defaultReply = { mode: "no_op", text: "", wants_followup: false };
    this._defaultDecision = defaultDecision;
    this._summary = summary;
    this._profile = profile;
    this._telemetry = telemetry;
    this._fakeUsage = fakeUsage;
    this.calls = {
      ask: [],
      askStream: [],
      shouldSpeak: [],
      summarize: [],
      distillLearnerProfile: [],
    };
  }

  _recordUsage(method, model) {
    if (this._telemetry) {
      this._telemetry.record(method, model, this._fakeUsage);
    }
  }

  async shouldSpeak(triggerPayload, sessionSummary) {
    this.calls.shouldSpeak.push({ triggerPayload, sessionSummary });
    this._recordUsage("shouldSpeak", "claude-haiku-4-5-20251001");
    if (this._decisions.length === 0) return this._defaultDecision;
    return this._decisions.shift();
  }

  /** Task 11.1: streaming variant for the conversation loop. Yields
   *  preconfigured chunks from `streamChunks` (per-call, FIFO).
   *  When no chunks are queued, yields nothing. Honors the abort
   *  signal between chunk emits. */
  async *askStream(systemBlocks, triggerPayload, signal) {
    this.calls.askStream = this.calls.askStream ?? [];
    this.calls.askStream.push({
      systemBlocks: [...systemBlocks],
      triggerPayload,
    });
    this._recordUsage("askStream", "claude-sonnet-4-6");
    const chunks = this._streamChunks?.shift() ?? this._defaultStreamChunks ?? [];
    for (const chunk of chunks) {
      if (signal?.aborted) return;
      yield chunk;
    }
  }

  async ask(systemBlocks, sessionSummary, triggerPayload) {
    // Back-compat: existing tests inspect `systemPrompt` (the first block,
    // which is always the active mode prompt). New tests should use
    // `systemBlocks`.
    this.calls.ask.push({
      systemBlocks: [...systemBlocks],
      systemPrompt: systemBlocks[0] ?? "",
      sessionSummary,
      triggerPayload,
    });
    this._recordUsage("ask", "claude-sonnet-4-6");
    if (this._replies.length === 0) return { ...this._defaultReply };
    return { ...this._replies.shift() };
  }

  async summarize(transcript) {
    this.calls.summarize.push(transcript);
    this._recordUsage("summarize", "claude-haiku-4-5-20251001");
    return this._summary;
  }

  async distillLearnerProfile(history, priorProfile, misconceptions = {}) {
    this.calls.distillLearnerProfile.push({ history, priorProfile, misconceptions });
    this._recordUsage("distillLearnerProfile", "claude-haiku-4-5-20251001");
    return this._profile;
  }
}
