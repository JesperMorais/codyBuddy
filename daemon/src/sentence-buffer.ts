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

const SENTENCE_END = /([.!?]|\n\n)/;

export class SentenceBuffer {
  private buffer = "";

  /** Push a chunk. Returns any sentences that just became complete
   *  (one per emit terminator in the new buffer). The trailing
   *  fragment is held back for the next push or flush(). */
  push(chunk: string): string[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(this.buffer)) !== null) {
      const end = m.index + m[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) out.push(sentence);
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
