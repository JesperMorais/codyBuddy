/**
 * Screenpipe MCP-style integration. Used as a fallback context provider
 * for EXPLICIT_ASK triggers when the editor signal (`recent_diff`) is
 * empty — typically because the user has been in a browser, terminal, or
 * Slack and only just brought the buddy back into focus.
 *
 * The Screenpipe daemon (https://github.com/screenpipe/screenpipe) exposes
 * an HTTP API that returns OCR'd text from recent screen activity. We
 * speak that API directly rather than going through a full MCP stdio
 * handshake — it's a one-tool integration and HTTP keeps the test seam
 * clean.
 */

export interface ScreenpipeOcrEntry {
  /** Raw OCR text captured from the screen. */
  text: string;
  /** Best-effort app the OCR was captured from. */
  app_name?: string;
  /** Best-effort window title. */
  window_name?: string;
  /** ISO-8601 timestamp of the capture. */
  timestamp?: string;
}

export interface ScreenpipeClient {
  queryRecent(seconds: number): Promise<ScreenpipeOcrEntry[]>;
}

export interface HttpScreenpipeOptions {
  baseUrl?: string;
  /** Test seam: replaces globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Cap on entries returned. Default 20. */
  limit?: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3030";

export class HttpScreenpipeClient implements ScreenpipeClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private limit: number;

  constructor(opts: HttpScreenpipeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetchImpl ?? fetch;
    this.limit = opts.limit ?? 20;
  }

  async queryRecent(seconds: number): Promise<ScreenpipeOcrEntry[]> {
    const end = new Date();
    const start = new Date(end.getTime() - seconds * 1000);
    const params = new URLSearchParams({
      content_type: "ocr",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      limit: String(this.limit),
    });
    const url = `${this.baseUrl}/search?${params.toString()}`;
    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new Error(`screenpipe HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ content?: ScreenpipeOcrEntry; type?: string } | undefined>;
    };
    if (!json.data) return [];
    const out: ScreenpipeOcrEntry[] = [];
    for (const row of json.data) {
      if (row?.content?.text) out.push(row.content);
    }
    return out;
  }
}

/**
 * Compact a Screenpipe result into a string suitable for inclusion in the
 * trigger payload. Keeps the most recent N entries and trims each to a
 * reasonable length.
 */
export function summarizeOcr(entries: ScreenpipeOcrEntry[], maxEntries = 5, maxChars = 240): string {
  const tail = entries.slice(-maxEntries);
  return tail
    .map((e) => {
      const tag = e.app_name ? `[${e.app_name}] ` : "";
      const text = e.text.length > maxChars ? e.text.slice(0, maxChars) + "…" : e.text;
      return `${tag}${text}`;
    })
    .join("\n---\n");
}
