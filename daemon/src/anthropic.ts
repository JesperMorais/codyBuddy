import Anthropic from "@anthropic-ai/sdk";
import { Telemetry, type UsageLike } from "./telemetry.js";
import type { MisconceptionMap } from "./memory.js";

export interface BuddyReply {
  mode: "speak" | "chat" | "no_op";
  text: string;
  wants_followup: boolean;
}

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/** Verdict from the cheap Haiku gate that decides whether the expensive
 *  Sonnet round-trip is worth doing for a given trigger. */
export type SpeakDecision = "speak" | "chat" | "no_op";

/**
 * Subset of the Anthropic-backed client that Session depends on.
 * Tests can substitute a fake implementation.
 */
export interface AiClient {
  /**
   * Cheap pre-flight: should the buddy actually engage with this trigger?
   * Implemented with Haiku 4.5 in the production client. When the verdict
   * is `no_op`, Session short-circuits and never calls `ask` (saves a
   * Sonnet round-trip).
   */
  shouldSpeak(triggerPayload: object, sessionSummary: string): Promise<SpeakDecision>;
  /**
   * `systemBlocks` is an ordered list of text blocks. Each block is sent
   * to the model as its own ephemerally-cached system entry, in order:
   *   - blocks[0] is always the active mode prompt
   *   - blocks[1..] may include a personality overlay and/or a learner
   *     profile block, depending on Session state
   * Concrete clients map each block 1:1 to whatever their provider's
   * native shape is (Anthropic: separate cache blocks; Ollama: one
   * concatenated system message).
   */
  ask(
    systemBlocks: string[],
    sessionSummary: string,
    triggerPayload: object
  ): Promise<BuddyReply>;
  /**
   * Streaming variant for the conversation loop (Task 11.1). Yields
   * raw text deltas as they arrive — no JSON parsing, no buffering.
   * The conversation loop's sentence-buffer adapter (Task 11.2)
   * collects deltas into sentence-shaped chunks for the streaming
   * Kokoro TTS bridge (Task 10.3).
   *
   * Unlike `ask`, this does NOT take `sessionSummary` as a separate
   * arg — by the time the loop reaches askStream, the payload built
   * by the conversation-context assembler (Task 10.9) already
   * contains every relevant input (transcript history, editor
   * context, triggers).
   *
   * The `signal` parameter is the loop's barge-in mechanism: when
   * VAD reports speech.start mid-utterance, the loop aborts, the
   * underlying SDK stream is cancelled, and the iterator finishes
   * cleanly without yielding more deltas. See Task 10.5.
   *
   * Implementations may yield zero deltas (model returned empty),
   * which the loop handles as THINKING → IDLE.
   */
  askStream(
    systemBlocks: string[],
    triggerPayload: object,
    signal?: AbortSignal
  ): AsyncIterable<string>;
  summarize(transcript: string): Promise<string>;
  distillLearnerProfile(
    history: string,
    priorProfile: string,
    misconceptions?: MisconceptionMap
  ): Promise<string>;
}

export class AnthropicClient implements AiClient {
  private client: Anthropic;
  private model: string;
  private telemetry: Telemetry;

  constructor(apiKey: string, model: string, opts: { telemetry?: Telemetry } = {}) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.telemetry = opts.telemetry ?? new Telemetry();
  }

  async ask(
    systemBlocks: string[],
    sessionSummary: string,
    triggerPayload: object
  ): Promise<BuddyReply> {
    const blocks = systemBlocks
      .filter((b) => b && b.length > 0)
      .map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 400,
      system: blocks,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Session summary so far:\n${sessionSummary || "(none yet)"}`,
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: JSON.stringify(triggerPayload, null, 2),
            },
          ],
        },
      ],
    });

    const final = await stream.finalMessage();
    this.telemetry.record("ask", this.model, (final.usage ?? {}) as UsageLike);
    const textBlock = final.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

    if (process.env.BUDDY_DEBUG_RAW === "true") {
      console.log(`[anthropic raw] ${raw.slice(0, 400)}${raw.length > 400 ? "..." : ""}`);
    }

    if (!raw || raw === "NO_OP") {
      return { mode: "no_op", text: "", wants_followup: false };
    }

    try {
      const parsed = JSON.parse(this.extractJson(raw));
      const text =
        parsed.text ?? parsed.message ?? parsed.content ?? parsed.response ?? "";
      const mode: BuddyReply["mode"] = parsed.mode ?? (text ? "chat" : "no_op");
      return {
        mode,
        text: String(text),
        wants_followup: !!parsed.wants_followup,
      };
    } catch {
      return { mode: "chat", text: raw, wants_followup: false };
    }
  }

  /** Task 11.1: streaming variant of `ask` for the conversation loop.
   *  Yields raw text deltas as the SDK delivers them. The barge-in
   *  signal cancels the underlying SDK stream so the iterator stops
   *  promptly when the user starts talking again. */
  async *askStream(
    systemBlocks: string[],
    triggerPayload: object,
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const blocks = systemBlocks
      .filter((b) => b && b.length > 0)
      .map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 400,
      system: blocks,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: JSON.stringify(triggerPayload) },
          ],
        },
      ],
    });

    if (signal) {
      if (signal.aborted) {
        try {
          stream.abort();
        } catch {
          // already done
        }
        return;
      }
      const onAbort = () => {
        try {
          stream.abort();
        } catch {
          // ignore
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Best-effort cleanup: remove the listener when the iterator
      // exits naturally so a long-lived AbortController doesn't pin
      // the stream object in memory.
      try {
        for await (const text of textDeltas(stream)) {
          if (signal.aborted) break;
          yield text;
        }
      } finally {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // older runtimes
        }
        await this.recordStreamUsage(stream);
      }
      return;
    }

    try {
      for await (const text of textDeltas(stream)) {
        yield text;
      }
    } finally {
      await this.recordStreamUsage(stream);
    }
  }

  /** Subscribes to the SDK's finalMessage promise and records the
   *  usage block to telemetry. Errors (aborted stream, network) are
   *  swallowed — the live trigger path mustn't be blocked by a
   *  telemetry failure. */
  private async recordStreamUsage(stream: { finalMessage: () => Promise<{ usage?: unknown }> }): Promise<void> {
    try {
      const final = await stream.finalMessage();
      this.telemetry.record("askStream", this.model, (final.usage ?? {}) as UsageLike);
    } catch {
      // ignore — usage isn't recoverable on aborted streams
    }
  }

  async shouldSpeak(triggerPayload: object, sessionSummary: string): Promise<SpeakDecision> {
    try {
      const res = await this.client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 8,
        system:
          "You are a fast gate for a coding buddy. Given a trigger event from the user's editor, decide whether the buddy should: speak (high confidence the user benefits from a spoken nudge), chat (worth a sidebar reply but not voice), or no_op (stay silent). Reply with EXACTLY one of: speak, chat, no_op. No punctuation, no explanation.",
        messages: [
          {
            role: "user",
            content: `Session summary:\n${sessionSummary || "(none)"}\n\nTrigger event:\n${JSON.stringify(triggerPayload, null, 2)}`,
          },
        ],
      });
      this.telemetry.record("shouldSpeak", HAIKU_MODEL, (res.usage ?? {}) as UsageLike);
      const block = res.content.find((b) => b.type === "text");
      const raw = block && "text" in block ? block.text.trim().toLowerCase() : "";
      if (raw === "speak" || raw === "chat" || raw === "no_op") return raw;
      // Anything else is treated as "chat" — don't silence the user on a
      // garbled gate response, but don't promote to spoken either.
      return "chat";
    } catch (err) {
      console.error("[anthropic] shouldSpeak failed, defaulting to chat:", err);
      return "chat";
    }
  }

  async summarize(transcript: string): Promise<string> {
    const res = await this.client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 250,
      system:
        "Summarize the developer's last 30 minutes of activity into 5-8 terse bullets focused on: what they're building, blockers hit, misconceptions shown, things they got right. No fluff.",
      messages: [{ role: "user", content: transcript }],
    });
    this.telemetry.record("summarize", HAIKU_MODEL, (res.usage ?? {}) as UsageLike);
    const block = res.content.find((b) => b.type === "text");
    return block && "text" in block ? block.text : "";
  }

  async distillLearnerProfile(
    history: string,
    priorProfile: string,
    misconceptions: MisconceptionMap = {}
  ): Promise<string> {
    const sortedMisc = Object.entries(misconceptions)
      .filter(([, v]) => v.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, v]) => {
        const sample = v.sample ? ` — sample: ${v.sample.slice(0, 120)}` : "";
        return `- ${name}: count=${v.count}, last_seen=${new Date(v.last_seen).toISOString()}${sample}`;
      })
      .join("\n");
    const miscBlock = sortedMisc
      ? `\n\nDetected anti-patterns (counts across the whole session, NOT just recent history):\n${sortedMisc}`
      : "";
    const res = await this.client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: `You maintain a long-term learner profile for a developer based on their interactions with a coding buddy. Your job: distill recurring patterns. Output 5-10 bullets, grouped under exactly these headings (omit a heading if empty):

## Recurring misconceptions
(things they've gotten wrong more than once — be specific: language, concept, what they confused it with)

## Strengths
(things they consistently get right — include patterns, languages, idioms)

## Current focus
(what they appear to be learning or building right now)

## Topics covered
(short tag list of subjects discussed)

Be terse. Update the prior profile with new evidence; don't repeat unchanged facts. If the prior profile contradicts new evidence, prefer new evidence.`,
      messages: [
        {
          role: "user",
          content: `Prior profile:\n${priorProfile || "(none)"}\n\nNew interaction history (most recent last):\n${history}${miscBlock}`,
        },
      ],
    });
    this.telemetry.record("distillLearnerProfile", HAIKU_MODEL, (res.usage ?? {}) as UsageLike);
    const block = res.content.find((b) => b.type === "text");
    return block && "text" in block ? block.text.trim() : priorProfile;
  }

  private extractJson(raw: string): string {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return raw;
    return raw.slice(start, end + 1);
  }
}

/**
 * Pure helper: walks an Anthropic SDK MessageStream's event iterator
 * and yields each text delta. Typed permissively (`unknown`) so it
 * accepts the SDK's `RawMessageStreamEvent` and any compatible
 * fixture shape tests hand it.
 */
export async function* textDeltas(stream: AsyncIterable<unknown>): AsyncIterable<string> {
  for await (const raw of stream) {
    const event = raw as { type?: string; delta?: { type?: string; text?: string } };
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      yield event.delta.text;
    }
  }
}
