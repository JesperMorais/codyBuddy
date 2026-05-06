import { WebSocket } from "ws";

/**
 * Voice-activity events emitted by the voice/main.py /vad WebSocket.
 * `ts` is the audio-stream offset in milliseconds (sample-accurate),
 * not wall clock — see voice/main.py for the rationale.
 */
export interface VadSpeechStart {
  type: "speech.start";
  ts: number;
}

export interface VadSpeechEnd {
  type: "speech.end";
  ts: number;
}

export interface VadError {
  type: "error";
  reason: string;
}

export type VadEvent = VadSpeechStart | VadSpeechEnd | VadError;

export interface VadBridgeOptions {
  /** ws:// URL of the voice sidecar's /vad endpoint. */
  url: string;
  /**
   * Reconnect backoff (ms) on disconnect. Default 2_000. Set to 0 to
   * disable reconnect — useful when the upstream gracefully degraded
   * (silero-vad-not-installed) and there's no point retrying.
   */
  reconnectMs?: number;
  /** Optional logger; defaults to console.log. */
  log?: (line: string) => void;
}

type SpeechHandler = (ts: number) => void;
type ErrorHandler = (reason: string) => void;

/**
 * Daemon-side client for the voice sidecar's /vad WebSocket. Handles
 * connection, audio streaming, event parsing, and reconnect-on-drop.
 *
 * Lifecycle:
 *   const bridge = new VadBridge({ url: "ws://127.0.0.1:31416/vad" });
 *   bridge.onSpeechStart((ts) => ...);
 *   bridge.onSpeechEnd((ts) => ...);
 *   bridge.connect();           // open the WS
 *   bridge.sendAudio(pcmFrame); // raw Int16 PCM @ 16kHz mono
 *   bridge.dispose();           // stop reconnect, close the WS
 *
 * The bridge does NOT spawn the voice sidecar itself — supervision is
 * a separate concern (see voice-sidecar.ts when that lands). It also
 * deliberately stops reconnecting when the upstream sent a
 * `silero-vad-not-installed` error: the missing dependency won't fix
 * itself, and a reconnect spin would spam the user's logs.
 */
export class VadBridge {
  private ws?: WebSocket;
  private disposed = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectMs: number;
  private url: string;
  private log: (line: string) => void;
  private speechStartHandlers: SpeechHandler[] = [];
  private speechEndHandlers: SpeechHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private pendingFrames: Buffer[] = [];
  /** When the upstream told us silero-vad is missing, stop reconnecting. */
  private permanentlyDown = false;

  constructor(opts: VadBridgeOptions) {
    this.url = opts.url;
    this.reconnectMs = opts.reconnectMs ?? 2_000;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  onSpeechStart(h: SpeechHandler): void {
    this.speechStartHandlers.push(h);
  }

  onSpeechEnd(h: SpeechHandler): void {
    this.speechEndHandlers.push(h);
  }

  /** Fired when the upstream sends `{type:"error",reason}`. After this,
   *  the bridge stops reconnecting since the cause (missing dep) is
   *  not transient. */
  onError(h: ErrorHandler): void {
    this.errorHandlers.push(h);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** True after the upstream signaled an unrecoverable condition.
   *  Reset by calling reset(). */
  isPermanentlyDown(): boolean {
    return this.permanentlyDown;
  }

  /** Clear the permanent-down latch so reconnect resumes (e.g. after
   *  the user installed silero-vad and you want to retry without a
   *  daemon restart). */
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
      this.log(`[vad-bridge] connect failed: ${err}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on("open", () => {
      this.log(`[vad-bridge] connected to ${this.url}`);
      while (this.pendingFrames.length && socket.readyState === WebSocket.OPEN) {
        socket.send(this.pendingFrames.shift()!);
      }
    });

    socket.on("message", (raw) => {
      let msg: VadEvent;
      try {
        msg = JSON.parse(raw.toString()) as VadEvent;
      } catch {
        this.log(`[vad-bridge] bad message: ${raw.toString().slice(0, 200)}`);
        return;
      }
      this.dispatch(msg);
    });

    socket.on("error", (err) => {
      this.log(`[vad-bridge] socket error: ${err.message}`);
    });

    socket.on("close", () => {
      this.log("[vad-bridge] disconnected");
      if (!this.disposed && !this.permanentlyDown) this.scheduleReconnect();
    });
  }

  /** Stream raw Int16 PCM (16kHz mono) into the VAD endpoint. Frames
   *  sent before the WS is OPEN are buffered (capped) and flushed on
   *  open. */
  sendAudio(frame: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      this.pendingFrames.push(frame);
      if (this.pendingFrames.length > 64) this.pendingFrames.shift();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
  }

  private dispatch(msg: VadEvent): void {
    if (msg.type === "speech.start") {
      for (const h of this.speechStartHandlers) h(msg.ts);
    } else if (msg.type === "speech.end") {
      for (const h of this.speechEndHandlers) h(msg.ts);
    } else if (msg.type === "error") {
      this.permanentlyDown = true;
      for (const h of this.errorHandlers) h(msg.reason);
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
