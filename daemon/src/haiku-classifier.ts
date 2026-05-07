// Real HaikuClassifier implementation — Task 16.1.1.
//
// The TieredRouter (Phase 11.4) was designed against an injected
// HaikuClassifier interface. The MVP audio host wired in 16.1
// passed an `AlwaysEscalateHaiku` stub so every voice turn that
// didn't trip the upfront-escalation rules still routed to Sonnet —
// the cheap-tier savings the router exists to deliver were zero.
//
// AnthropicHaikuClassifier replaces the stub with a real Haiku 4.5
// call. Reply contract: a single JSON object on the model's stdout,
// either `{"escalate":true}` (the question needs Sonnet) or
// `{"escalate":false,"text":"<short reply>"}` (Haiku handled it).
// The router yields the latter's text directly without invoking
// Sonnet.
//
// Failure posture: anything that isn't a clean
// `{escalate:false,text:string}` JSON object — network error, model
// hallucination, malformed JSON, missing field — defaults to
// `{escalate:true}`. Never silently silence the user; the worst case
// is paying Sonnet rates we'd have paid pre-router anyway.

import Anthropic from "@anthropic-ai/sdk";
import { Telemetry, type UsageLike } from "./telemetry.js";
import type { HaikuClassifier, HaikuVerdict } from "./tiered-router.js";

const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";

/** System prompt the classifier prepends to whatever system blocks
 *  the loop assembled. Kept concise so token cost stays trivial —
 *  Haiku rates plus a ~120-token overhead. */
const ROUTER_PROMPT = `You are a fast routing gate for a coding-buddy LLM.
You receive the conversation context and a payload describing a single
voice-turn from a developer. Decide:

- escalate=true if the question genuinely needs the larger Sonnet model:
  * complex multi-step reasoning
  * code review or architecture
  * refactor / multi-file change
  * deep explanation of a system the user doesn't yet understand
- escalate=false if you can answer it well in 1-2 short sentences yourself.
  When in doubt, escalate.

Reply with EXACTLY one JSON object, no preamble, no markdown:
{"escalate": true}
OR
{"escalate": false, "text": "<your 1-2 sentence reply>"}

Never include explanation outside the JSON. Never use markdown fences.`;

/** Minimal shape the classifier needs from `Anthropic.messages` —
 *  lets tests pass a fake instead of mocking the whole SDK. */
export interface HaikuMessagesClient {
  create(req: object): Promise<{
    content: Array<{ type: string; text?: string }>;
    usage?: object;
  }>;
}

export interface AnthropicHaikuClassifierOptions {
  /** Anthropic API key. Required unless `client` is provided. */
  apiKey?: string;
  /** Override the Haiku model id. */
  model?: string;
  /** Shares the existing per-call telemetry log so classify hits
   *  show up alongside ask/summarize entries. */
  telemetry?: Telemetry;
  /** Test seam: replaces the production `Anthropic` SDK instance. */
  client?: { messages: HaikuMessagesClient };
  log?: (line: string) => void;
}

export class AnthropicHaikuClassifier implements HaikuClassifier {
  private messages: HaikuMessagesClient;
  private model: string;
  private telemetry: Telemetry;
  private log: (line: string) => void;

  constructor(opts: AnthropicHaikuClassifierOptions = {}) {
    if (opts.client) {
      this.messages = opts.client.messages;
    } else if (opts.apiKey) {
      const anthropic = new Anthropic({ apiKey: opts.apiKey });
      this.messages = anthropic.messages;
    } else {
      throw new Error(
        "AnthropicHaikuClassifier requires either apiKey or a test client"
      );
    }
    this.model = opts.model ?? DEFAULT_HAIKU_MODEL;
    this.telemetry = opts.telemetry ?? new Telemetry();
    this.log = opts.log ?? (() => {});
  }

  async classify(
    payload: object,
    systemBlocks: string[]
  ): Promise<HaikuVerdict> {
    const blocks = systemBlocks
      .filter((b) => b && b.length > 0)
      .map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      }));

    let raw = "";
    try {
      const res = await this.messages.create({
        model: this.model,
        max_tokens: 200,
        system: [{ type: "text" as const, text: ROUTER_PROMPT }, ...blocks],
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      });
      this.telemetry.record(
        "classify",
        this.model,
        (res.usage ?? {}) as UsageLike
      );
      const block = res.content.find((b) => b.type === "text");
      raw = block && typeof block.text === "string" ? block.text.trim() : "";
    } catch (err) {
      this.log(
        `[haiku-classifier] call failed (${
          err instanceof Error ? err.message : err
        }) — escalating`
      );
      return { escalate: true };
    }

    return parseVerdict(raw, this.log);
  }
}

/** Pure helper — extracts the JSON object the model emitted, returns
 *  a verdict, and falls back to escalate on anything else. Exported
 *  for tests; production callers go through `classify()`. */
export function parseVerdict(
  raw: string,
  log: (line: string) => void = () => {}
): HaikuVerdict {
  if (!raw) return { escalate: true };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    log(`[haiku-classifier] no JSON object in reply: ${raw.slice(0, 80)}`);
    return { escalate: true };
  }
  let obj: { escalate?: unknown; text?: unknown };
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as {
      escalate?: unknown;
      text?: unknown;
    };
  } catch {
    log(`[haiku-classifier] invalid JSON in reply: ${raw.slice(0, 80)}`);
    return { escalate: true };
  }
  if (obj.escalate === false && typeof obj.text === "string" && obj.text.trim()) {
    return { escalate: false, text: obj.text };
  }
  // escalate=true (or the model returned it without text, or text was empty,
  // or escalate is missing/non-bool — all roads to "let Sonnet handle it")
  return { escalate: true };
}
