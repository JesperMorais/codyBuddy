/**
 * Ollama (or any OpenAI-compatible local LLM) provider.
 *
 * When BUDDY_PROVIDER=ollama, daemon/src/index.ts builds this instead of
 * AnthropicClient. The interface is the same (AiClient) so Session is
 * unchanged.
 *
 * Targets the OpenAI-compatible /v1/chat/completions endpoint that Ollama
 * exposes on localhost:11434.
 */

import type { AiClient, BuddyReply, SpeakDecision } from "./anthropic.js";
import type { MisconceptionMap } from "./memory.js";
import { Telemetry } from "./telemetry.js";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:32b";

export interface OllamaClientOptions {
  baseUrl?: string;
  model?: string;
  /** Test seam: replaces globalThis.fetch. */
  fetchImpl?: typeof fetch;
  telemetry?: Telemetry;
}

interface ChatChoice {
  message?: { role?: string; content?: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OllamaClient implements AiClient {
  private baseUrl: string;
  private model: string;
  private fetchFn: typeof fetch;
  private telemetry: Telemetry;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? DEFAULT_OLLAMA_MODEL;
    this.fetchFn = opts.fetchImpl ?? fetch;
    this.telemetry = opts.telemetry ?? new Telemetry();
  }

  private async chat(method: string, messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as ChatResponse;
    this.telemetry.record(method, this.model, {
      input_tokens: json.usage?.prompt_tokens,
      output_tokens: json.usage?.completion_tokens,
    });
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }

  /** Task 11.1: streaming variant for the conversation loop. Uses
   *  the OpenAI-compatible `stream:true` chat completion endpoint;
   *  parses the Server-Sent Events stream and yields each delta's
   *  text. Honors the abort signal by aborting the underlying fetch
   *  so the local model stops generating promptly on barge-in. */
  async *askStream(
    systemBlocks: string[],
    triggerPayload: object,
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const system = systemBlocks.filter((b) => b && b.length > 0).join("\n\n");
    const userText = JSON.stringify(triggerPayload);
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener("abort", onParentAbort, { once: true });
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userText },
          ],
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (signal) signal.removeEventListener("abort", onParentAbort);
      // Aborted before the request even started — yield nothing.
      const aborted = (err as { name?: string }).name === "AbortError";
      if (aborted) return;
      throw err;
    }
    if (!res.ok) {
      if (signal) signal.removeEventListener("abort", onParentAbort);
      throw new Error(`ollama HTTP ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      if (signal) signal.removeEventListener("abort", onParentAbort);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // OpenAI SSE format: lines beginning with "data: " separated
        // by blank lines. The terminal sentinel is "data: [DONE]".
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = obj.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) yield delta;
          } catch {
            // Malformed event line — skip it; the local model
            // occasionally emits keep-alive comments.
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (signal) signal.removeEventListener("abort", onParentAbort);
    }
  }

  async ask(
    systemBlocks: string[],
    sessionSummary: string,
    triggerPayload: object
  ): Promise<BuddyReply> {
    const system = systemBlocks.filter((b) => b && b.length > 0).join("\n\n");
    const userText = `Session summary so far:\n${sessionSummary || "(none yet)"}\n\nTrigger event:\n${JSON.stringify(triggerPayload, null, 2)}`;
    const raw = await this.chat("ask", [
      { role: "system", content: system },
      { role: "user", content: userText },
    ], 400);

    if (!raw || raw === "NO_OP") {
      return { mode: "no_op", text: "", wants_followup: false };
    }
    try {
      const parsed = JSON.parse(extractJson(raw));
      const text = parsed.text ?? parsed.message ?? parsed.content ?? parsed.response ?? "";
      const mode: BuddyReply["mode"] = parsed.mode ?? (text ? "chat" : "no_op");
      return { mode, text: String(text), wants_followup: !!parsed.wants_followup };
    } catch {
      return { mode: "chat", text: raw, wants_followup: false };
    }
  }

  async shouldSpeak(triggerPayload: object, sessionSummary: string): Promise<SpeakDecision> {
    try {
      const raw = (
        await this.chat(
          "shouldSpeak",
          [
            {
              role: "system",
              content:
                "You are a fast gate for a coding buddy. Given a trigger event from the user's editor, decide whether the buddy should: speak (high confidence the user benefits from a spoken nudge), chat (worth a sidebar reply but not voice), or no_op (stay silent). Reply with EXACTLY one of: speak, chat, no_op. No punctuation, no explanation.",
            },
            {
              role: "user",
              content: `Session summary:\n${sessionSummary || "(none)"}\n\nTrigger event:\n${JSON.stringify(triggerPayload, null, 2)}`,
            },
          ],
          8
        )
      ).toLowerCase();
      if (raw === "speak" || raw === "chat" || raw === "no_op") return raw;
      return "chat";
    } catch (err) {
      console.error("[ollama] shouldSpeak failed, defaulting to chat:", err);
      return "chat";
    }
  }

  async summarize(transcript: string): Promise<string> {
    return await this.chat(
      "summarize",
      [
        {
          role: "system",
          content:
            "Summarize the developer's last 30 minutes of activity into 5-8 terse bullets focused on: what they're building, blockers hit, misconceptions shown, things they got right. No fluff.",
        },
        { role: "user", content: transcript },
      ],
      250
    );
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
    const out = await this.chat(
      "distillLearnerProfile",
      [
        {
          role: "system",
          content: `You maintain a long-term learner profile for a developer based on their interactions with a coding buddy. Your job: distill recurring patterns. Output 5-10 bullets, grouped under exactly these headings (omit a heading if empty):

## Recurring misconceptions
(things they've gotten wrong more than once — be specific: language, concept, what they confused it with)

## Strengths
(things they consistently get right — include patterns, languages, idioms)

## Current focus
(what they appear to be learning or building right now)

## Topics covered
(short tag list of subjects discussed)

Be terse. Update the prior profile with new evidence; don't repeat unchanged facts. If the prior profile contradicts new evidence, prefer new evidence.`,
        },
        {
          role: "user",
          content: `Prior profile:\n${priorProfile || "(none)"}\n\nNew interaction history (most recent last):\n${history}${miscBlock}`,
        },
      ],
      400
    );
    return out || priorProfile;
  }
}

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return raw;
  return raw.slice(start, end + 1);
}
