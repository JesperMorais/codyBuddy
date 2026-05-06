import WebSocket from "ws";

export interface BuddyReply {
  mode: "speak" | "chat" | "no_op";
  text: string;
  wants_followup: boolean;
}

/** Minimal structural type for the VS Code OutputChannel — lets the bridge
 *  be unit-tested without loading the `vscode` module at runtime. */
export interface OutputLike {
  appendLine(line: string): void;
}

type ReplyHandler = (reply: BuddyReply, trigger: string) => void;
type ModeHandler = (info: {
  mode: string;
  available: string[];
  personality: string;
  availablePersonalities: string[];
  ok: boolean;
}) => void;
type ReportHandler = (info: { summary: string; refreshed?: boolean }) => void;
type AudioOwnerHandler = (info: { owner: "daemon" | "webview"; backend: string }) => void;
type TranscribedHandler = (info: { ok: boolean; text?: string; error?: string; requestId?: string }) => void;
type RecordStartedHandler = (info: { ok: boolean; error?: string }) => void;
type HealthHandler = (info: { up: boolean }) => void;

const PING_TIMEOUT_MS = 3_000;

export class DaemonBridge {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private outbox: string[] = [];
  private handler?: ReplyHandler;
  private modeHandler?: ModeHandler;
  private reportHandler?: ReportHandler;
  private audioOwnerHandler?: AudioOwnerHandler;
  private transcribedHandler?: TranscribedHandler;
  private recordStartedHandler?: RecordStartedHandler;
  private healthHandler?: HealthHandler;
  private healthUp = false;
  private disposed = false;

  constructor(private port: number, private output: OutputLike) {
    this.connect();
  }

  onReply(h: ReplyHandler): void {
    this.handler = h;
  }

  onMode(h: ModeHandler): void {
    this.modeHandler = h;
  }

  setMode(mode: string): void {
    this.send({ type: "setMode", mode });
  }

  setPersonality(personality: string): void {
    this.send({ type: "setPersonality", personality });
  }

  getPersonality(): void {
    this.send({ type: "getPersonality" });
  }

  onReport(h: ReportHandler): void {
    this.reportHandler = h;
  }

  getReport(): void {
    this.send({ type: "getReport" });
  }

  refreshReport(): void {
    this.send({ type: "refreshReport" });
  }

  onAudioOwner(h: AudioOwnerHandler): void {
    this.audioOwnerHandler = h;
  }

  setVolume(v: number): void {
    this.send({ type: "setVolume", volume: v });
  }

  onTranscribed(h: TranscribedHandler): void {
    this.transcribedHandler = h;
  }

  transcribe(audioBase64: string, requestId: string): void {
    this.send({ type: "transcribe", audio: audioBase64, requestId });
  }

  recordStart(): void {
    this.send({ type: "recordStart" });
  }

  onRecordStarted(h: RecordStartedHandler): void {
    this.recordStartedHandler = h;
  }

  recordStop(requestId: string): void {
    this.send({ type: "recordStop", requestId });
  }

  vote(trigger: string, reply_text: string, vote: "up" | "down"): void {
    this.send({ type: "vote", trigger, reply_text, vote });
  }

  /** Subscribe to daemon up/down transitions. The handler fires whenever
   *  the bridge's view of daemon health changes (ping→pong, disconnect, etc.). */
  onHealth(h: HealthHandler): void {
    this.healthHandler = h;
    // Replay current state so newly-attached observers don't have to wait.
    h({ up: this.healthUp });
  }

  private setHealth(up: boolean): void {
    if (up === this.healthUp) return;
    this.healthUp = up;
    this.healthHandler?.({ up });
  }

  send(obj: object): void {
    const msg = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.outbox.push(msg);
      if (this.outbox.length > 50) this.outbox.shift();
    }
  }

  trigger(trigger: string, payload: object): void {
    this.send({ type: "trigger", trigger, payload });
  }

  mute(minutes: number): void {
    this.send({ type: "mute", minutes });
  }

  unmute(): void {
    this.send({ type: "unmute" });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch (err) {
      this.output.appendLine(`[bridge] connect failed: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.output.appendLine(`[bridge] connected to daemon on :${this.port}`);
      while (this.outbox.length) this.ws!.send(this.outbox.shift()!);
      // Health probe: if no pong arrives within PING_TIMEOUT_MS, treat the
      // daemon as down even though the TCP socket connected.
      this.ws!.send(JSON.stringify({ type: "ping" }));
      if (this.pingTimer) clearTimeout(this.pingTimer);
      this.pingTimer = setTimeout(() => {
        this.pingTimer = undefined;
        this.setHealth(false);
        this.output.appendLine("[bridge] no pong in 3s — marking daemon down");
      }, PING_TIMEOUT_MS);
      this.pingTimer.unref?.();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") {
          if (this.pingTimer) {
            clearTimeout(this.pingTimer);
            this.pingTimer = undefined;
          }
          this.setHealth(true);
          return;
        }
        if (msg.type === "reply" && this.handler) {
          this.handler(msg.reply as BuddyReply, msg.trigger as string);
        } else if (msg.type === "modeSet" && this.modeHandler) {
          this.modeHandler({
            mode: String(msg.mode ?? "tutor"),
            available: Array.isArray(msg.available) ? (msg.available as string[]) : [],
            personality: String(msg.personality ?? "nice"),
            availablePersonalities: Array.isArray(msg.availablePersonalities)
              ? (msg.availablePersonalities as string[])
              : [],
            ok: !!msg.ok,
          });
        } else if (msg.type === "report" && this.reportHandler) {
          this.reportHandler({
            summary: String(msg.summary ?? ""),
            refreshed: !!msg.refreshed,
          });
        } else if (msg.type === "audioOwner" && this.audioOwnerHandler) {
          this.audioOwnerHandler({
            owner: msg.owner === "daemon" ? "daemon" : "webview",
            backend: String(msg.backend ?? ""),
          });
        } else if (msg.type === "recordStarted" && this.recordStartedHandler) {
          this.recordStartedHandler({
            ok: !!msg.ok,
            error: msg.error ? String(msg.error) : undefined,
          });
        } else if (msg.type === "transcribed" && this.transcribedHandler) {
          this.transcribedHandler({
            ok: !!msg.ok,
            text: msg.text ? String(msg.text) : undefined,
            error: msg.error ? String(msg.error) : undefined,
            requestId: msg.requestId ? String(msg.requestId) : undefined,
          });
        } else if (msg.type === "error") {
          this.output.appendLine(`[bridge] daemon error: ${msg.error}`);
        }
      } catch (err) {
        this.output.appendLine(`[bridge] bad message: ${err}`);
      }
    });

    this.ws.on("close", () => {
      this.output.appendLine("[bridge] disconnected, retrying in 3s");
      this.setHealth(false);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.output.appendLine(`[bridge] socket error: ${err.message}`);
      this.setHealth(false);
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      this.connect();
    }, 3000);
    this.reconnectTimer.unref?.();
  }
}
