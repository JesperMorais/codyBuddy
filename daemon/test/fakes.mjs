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
  constructor({ replies = [], summary = "(fake summary)", profile = "(fake profile)" } = {}) {
    this._replies = [...replies];
    this._defaultReply = { mode: "no_op", text: "", wants_followup: false };
    this._summary = summary;
    this._profile = profile;
    this.calls = { ask: [], summarize: [], distillLearnerProfile: [] };
  }

  async ask(systemPrompt, sessionSummary, triggerPayload, learnerProfile = "") {
    this.calls.ask.push({ systemPrompt, sessionSummary, triggerPayload, learnerProfile });
    if (this._replies.length === 0) return { ...this._defaultReply };
    return { ...this._replies.shift() };
  }

  async summarize(transcript) {
    this.calls.summarize.push(transcript);
    return this._summary;
  }

  async distillLearnerProfile(history, priorProfile) {
    this.calls.distillLearnerProfile.push({ history, priorProfile });
    return this._profile;
  }
}
