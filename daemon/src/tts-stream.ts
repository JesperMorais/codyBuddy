// Streaming TTS bridge — Task 10.3.
//
// Connects to the voice sidecar's /tts/stream WebSocket. The protocol
// is sentence-in / PCM-out, interleaved with text frames marking
// sentence boundaries:
//
//   client  → server (text)  : {"text": str, "voice"?: str}
//   client  → server (text)  : {"done": true}        // end of utterance
//   server  → client (text)  : {"type":"sentence_start","idx":N,
//                                "sample_rate":24000,"channels":1}
//   server  → client (binary): <PCM frame>           // 0..M frames
//   server  → client (text)  : {"type":"sentence_done","idx":N}
//   server  → client (text)  : {"type":"done"}       // utterance flushed
//
// The bridge dispatches:
//   - onSentenceStart({idx, sampleRate, channels})  // exactly once per sentence
//   - onAudioChunk(buf, idx)                         // 0..M times per sentence
//   - onSentenceDone(idx)                            // exactly once per sentence
//   - onDone()                                       // utterance flushed
//   - onError(reason)                                // gated by upstream {type:"error"}
//
// Typical caller wires onAudioChunk into the platform audio output so
// playback starts as soon as the first chunk lands. The Task 10.3 spec
// budget is "first audio chunk arrives <150ms after first sentence
// sent" — verified by daemon/test/tts-stream.test.mjs against a mock
// upstream that emits a chunk synchronously on receiving the first
// sentence.

import { WebSocket, type RawData } from "ws";

/** ws emits messages as Buffer | ArrayBuffer | Buffer[] depending on
 *  fragmentation; collapse to a single Buffer for callers. */
function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.concat(raw as Buffer[]);
}

export interface SentenceStartFrame {
  idx: number;
  sampleRate: number;
  channels: number;
}

export interface TtsStreamOptions {
  /** ws:// URL of the voice sidecar's /tts/stream endpoint. */
  url: string;
  /**
   * Reconnect backoff (ms) on disconnect. Default 0 — TTS streams
   * are session-scoped, so the typical caller opens a fresh bridge
   * per utterance rather than relying on auto-reconnect.
   */
  reconnectMs?: number;
  /** Optional logger; defaults to console.log. */
  log?: (line: string) => void;
}

type SentenceStartHandler = (info: SentenceStartFrame) => void;
type AudioChunkHandler = (buf: Buffer, idx: number) => void;
type SentenceDoneHandler = (idx: number) => void;
type DoneHandler = () => void;
type ErrorHandler = (reason: string) => void;

interface ServerEvent {
  type?: string;
  idx?: number;
  sample_rate?: number;
  channels?: number;
  reason?: string;
}

export class StreamingTtsBridge {
  private ws?: WebSocket;
  private disposed = false;
  private reconnectTimer?: NodeJS.Timeout;
  private url: string;
  private reconnectMs: number;
  private log: (line: string) => void;

  private startHandlers: SentenceStartHandler[] = [];
  private chunkHandlers: AudioChunkHandler[] = [];
  private sentenceDoneHandlers: SentenceDoneHandler[] = [];
  private doneHandlers: DoneHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];

  /** Tracks which sentence index the next binary frame belongs to.
   *  Set on sentence_start, cleared on sentence_done. -1 means we
   *  received a binary frame outside any sentence — surfaced as an
   *  error rather than silently dropped. */
  private currentIdx = -1;

  /** Latched on upstream {type:"error"}; once set we stop reconnecting
   *  because the cause (missing kokoro) isn't transient. */
  private permanentlyDown = false;

  /** Sentences queued before the WS opened; flushed on open. */
  private pendingFrames: string[] = [];

  constructor(opts: TtsStreamOptions) {
    this.url = opts.url;
    this.reconnectMs = opts.reconnectMs ?? 0;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  onSentenceStart(h: SentenceStartHandler): void {
    this.startHandlers.push(h);
  }
  onAudioChunk(h: AudioChunkHandler): void {
    this.chunkHandlers.push(h);
  }
  onSentenceDone(h: SentenceDoneHandler): void {
    this.sentenceDoneHandlers.push(h);
  }
  onDone(h: DoneHandler): void {
    this.doneHandlers.push(h);
  }
  onError(h: ErrorHandler): void {
    this.errorHandlers.push(h);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isPermanentlyDown(): boolean {
    return this.permanentlyDown;
  }

  reset(): void {
    this.permanentlyDown = false;
  }

  connect(): void {
    if (this.disposed || this.permanentlyDown) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.log(`[tts-stream] connect failed: ${err}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on("open", () => {
      this.log(`[tts-stream] connected to ${this.url}`);
      while (this.pendingFrames.length && socket.readyState === WebSocket.OPEN) {
        socket.send(this.pendingFrames.shift()!);
      }
    });

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        const buf = toBuffer(raw);
        if (this.currentIdx < 0) {
          this.log(`[tts-stream] PCM chunk outside any sentence (${buf.length} bytes)`);
          return;
        }
        for (const h of this.chunkHandlers) h(buf, this.currentIdx);
        return;
      }
      let event: ServerEvent;
      try {
        event = JSON.parse(raw.toString()) as ServerEvent;
      } catch {
        this.log(`[tts-stream] bad text frame: ${raw.toString().slice(0, 200)}`);
        return;
      }
      this.dispatchEvent(event);
    });

    socket.on("error", (err) => {
      this.log(`[tts-stream] socket error: ${err.message}`);
    });

    socket.on("close", () => {
      this.log("[tts-stream] disconnected");
      if (!this.disposed && !this.permanentlyDown) this.scheduleReconnect();
    });
  }

  /** Send a sentence to the upstream synthesiser. Sentences sent
   *  before the WS opens are queued (capped) and flushed on open. */
  feedSentence(text: string, voice?: string): void {
    const frame = JSON.stringify(voice ? { text, voice } : { text });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      this.pendingFrames.push(frame);
      if (this.pendingFrames.length > 64) this.pendingFrames.shift();
    }
  }

  /** Tell the upstream the utterance is complete so it can flush
   *  in-flight syntheses, send {"type":"done"}, and close the WS. */
  finish(): void {
    const frame = JSON.stringify({ done: true });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      this.pendingFrames.push(frame);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
  }

  private dispatchEvent(ev: ServerEvent): void {
    if (ev.type === "sentence_start") {
      const idx = typeof ev.idx === "number" ? ev.idx : -1;
      this.currentIdx = idx;
      const info = {
        idx,
        sampleRate: typeof ev.sample_rate === "number" ? ev.sample_rate : 24000,
        channels: typeof ev.channels === "number" ? ev.channels : 1,
      };
      for (const h of this.startHandlers) h(info);
    } else if (ev.type === "sentence_done") {
      const idx = typeof ev.idx === "number" ? ev.idx : this.currentIdx;
      this.currentIdx = -1;
      for (const h of this.sentenceDoneHandlers) h(idx);
    } else if (ev.type === "done") {
      for (const h of this.doneHandlers) h();
    } else if (ev.type === "error" || ev.type === "sentence_error") {
      const reason = ev.reason ?? "unknown";
      if (ev.type === "error") {
        // Upstream errors (notably missing kokoro) are unrecoverable —
        // latch and stop reconnecting so we don't spin.
        this.permanentlyDown = true;
      }
      for (const h of this.errorHandlers) h(reason);
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.permanentlyDown || this.reconnectMs === 0) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      this.connect();
    }, this.reconnectMs);
    this.reconnectTimer.unref?.();
  }
}
