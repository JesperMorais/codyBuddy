// Sentence buffer — Task 11.2.
//
// The conversation loop receives raw text deltas from the streaming
// LLM (Task 11.1). The streaming TTS bridge (Task 10.3) wants
// complete sentences. This module bridges the two: collect deltas
// into a rolling buffer, emit each sentence the moment its
// terminator arrives.
//
// Why this matters for the spec's <150ms-first-chunk budget: holding
// the buffer until end-of-stream would mean Kokoro can only start
// synthesising the entire reply, defeating the streaming TTS pipe.
// Emitting per-sentence as the LLM produces them lets the first
// chunk of audio land before the LLM has even finished thinking.
//
// Task 16.8: the original boundary regex split on every `.`, so
// `2.5`, `Dr. Smith`, `e.g. this`, etc. all created false sentence
// boundaries. We now require the terminator to be followed by
// whitespace/EOL/end-of-buffer AND skip well-known abbreviations
// and mid-number decimals.

/** Lower-cased abbreviations whose trailing `.` is *never* a
 *  sentence boundary. The match is on the bare token (no period)
 *  preceding the period in the buffer — see `isAbbreviation`. Keep
 *  this list short and high-signal: the cost of a false positive
 *  here is "two real sentences run together" (TTS-recoverable),
 *  while a false negative is "Dr. Smith said hi." being read as
 *  three fragments. */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "jr",
  "sr",
  "prof",
  "inc",
  "ltd",
  "co",
  "vs",
  // multi-period forms — "e.g.", "i.e.", "a.m.", "p.m." — match by
  // their last segment because the regex consumes one `.` at a time
  // and the prior `.` stays in the buffer as the preceding char.
  "e.g",
  "i.e",
  "a.m",
  "p.m",
  "etc",
  // common honorifics / titles seen in dictation
  "rev",
  "gen",
  "col",
  "lt",
  "sgt",
]);

const SENTENCE_END = /[.!?]|\n\n/g;

/** Return the lower-cased word-ish token ending at `endIndex` in
 *  `buf` (exclusive). Walks back over letters, digits, and `.`
 *  (so `e.g` and `i.e` are recoverable). Returns "" if no token. */
function tokenBefore(buf: string, endIndex: number): string {
  let i = endIndex;
  while (i > 0) {
    const ch = buf.charCodeAt(i - 1);
    // a-z, A-Z, 0-9, '.'
    const isLetter =
      (ch >= 97 && ch <= 122) ||
      (ch >= 65 && ch <= 90) ||
      (ch >= 48 && ch <= 57) ||
      ch === 46; /* '.' */
    if (!isLetter) break;
    i--;
  }
  return buf.slice(i, endIndex).toLowerCase();
}

function isAbbreviation(buf: string, periodIndex: number): boolean {
  const tok = tokenBefore(buf, periodIndex);
  if (!tok) return false;
  return ABBREVIATIONS.has(tok);
}

function isDigit(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

export class SentenceBuffer {
  private buffer = "";

  /** Push a chunk. Returns any sentences that just became complete
   *  (one per emit terminator in the new buffer). The trailing
   *  fragment is held back for the next push or flush(). */
  push(chunk: string): string[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const out: string[] = [];
    SENTENCE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(this.buffer)) !== null) {
      const matchStr = m[0];
      const matchEnd = m.index + matchStr.length;
      // Paragraph break is always a boundary — emit and continue.
      if (matchStr === "\n\n") {
        const sentence = this.buffer.slice(0, matchEnd).trim();
        this.buffer = this.buffer.slice(matchEnd);
        if (sentence) out.push(sentence);
        SENTENCE_END.lastIndex = 0;
        continue;
      }
      // Single-char terminator: ., !, ?
      const periodIdx = m.index;
      const next = this.buffer[matchEnd];
      // (1) Mid-buffer with a non-whitespace, non-EOL follower →
      //     this terminator is INSIDE a token (decimals like "2.5",
      //     URLs, version strings). Skip it; keep scanning past it.
      if (next !== undefined && !/\s/.test(next)) {
        // continue scanning at matchEnd
        SENTENCE_END.lastIndex = matchEnd;
        continue;
      }
      // (2) End-of-buffer: we don't know whether the next chunk
      //     will continue the token (e.g. "2." followed by "5") or
      //     start a new sentence. If the char immediately before
      //     the `.` is a digit, hold off — wait for more input or
      //     flush(). Keeps `2.5` intact across chunk boundaries.
      if (next === undefined && matchStr === ".") {
        const prev = this.buffer[periodIdx - 1];
        if (isDigit(prev)) {
          // Stop scanning; the trailing-digit ambiguity is resolved
          // by the next push() (continues the number) or by flush()
          // (sentence ended for real).
          break;
        }
      }
      // (3) Abbreviation guard: `Dr.`, `e.g.`, etc. The terminator
      //     is then *not* a sentence boundary — drop through and
      //     keep scanning past it.
      if (matchStr === "." && isAbbreviation(this.buffer, periodIdx)) {
        // For multi-period abbreviations like "e.g." we want to
        // also skip the *next* terminator in the same token: after
        // matching the second `.`, `tokenBefore` sees "e.g" and we
        // skip again — handled by the same code path on the next
        // iteration.
        SENTENCE_END.lastIndex = matchEnd;
        continue;
      }
      // (4) Genuine boundary — emit.
      const sentence = this.buffer.slice(0, matchEnd).trim();
      this.buffer = this.buffer.slice(matchEnd);
      if (sentence) out.push(sentence);
      SENTENCE_END.lastIndex = 0;
    }
    return out;
  }

  /** Drain the remaining buffer as a final sentence (the LLM ended
   *  mid-clause, e.g. a list item without trailing punctuation).
   *  Returns "" when the buffer is empty. After flush() the buffer
   *  is empty and ready for a new utterance. */
  flush(): string {
    const tail = this.buffer.trim();
    this.buffer = "";
    return tail;
  }

  /** True when the buffer holds an unterminated fragment — the
   *  conversation loop's "did the LLM stream end mid-sentence"
   *  check uses this. */
  hasPending(): boolean {
    return this.buffer.length > 0;
  }

  /** Test/observation hook: the current unterminated buffer. */
  pendingText(): string {
    return this.buffer;
  }
}

/**
 * Convenience async generator that wraps an upstream delta stream
 * with sentence-boundary buffering. Yields each sentence as soon as
 * its terminator lands, then yields any trailing fragment when the
 * upstream finishes. Honors an optional AbortSignal so a barge-in
 * stops emitting promptly even if the upstream is still producing.
 */
export async function* sentencesFromDeltas(
  deltas: AsyncIterable<string>,
  signal?: AbortSignal
): AsyncIterable<string> {
  const buf = new SentenceBuffer();
  for await (const delta of deltas) {
    if (signal?.aborted) return;
    for (const sentence of buf.push(delta)) {
      if (signal?.aborted) return;
      yield sentence;
    }
  }
  if (signal?.aborted) return;
  const tail = buf.flush();
  if (tail) yield tail;
}
