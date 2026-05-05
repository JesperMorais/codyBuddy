import WebSocket from "ws";
import * as vscode from "vscode";

export interface BuddyReply {
  mode: "speak" | "chat" | "no_op";
  text: string;
  wants_followup: boolean;
}

type ReplyHandler = (reply: BuddyReply, trigger: string) => void;
type ModeHandler = (info: { mode: string; available: string[]; ok: boolean }) => void;
type ReportHandler = (info: { summary: string; refreshed?: boolean }) => void;
type AudioOwnerHandler = (info: { owner: "daemon" | "webview"; backend: string }) => void;
type TranscribedHandler = (info: { ok: boolean; text?: string; error?: string; requestId?: string }) => void;
type RecordStartedHandler = (info: { ok: boolean; error?: string }) => void;

export class DaemonBridge {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private outbox: string[] = [];
  private handler?: ReplyHandler;
  private modeHandler?: ModeHandler;
  private reportHandler?: ReportHandler;
  private audioOwnerHandler?: AudioOwnerHandler;
  private transcribedHandler?: TranscribedHandler;
  private recordStartedHandler?: RecordStartedHandler;

  constructor(private port: number, private output: vscode.OutputChannel) {
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "reply" && this.handler) {
          this.handler(msg.reply as BuddyReply, msg.trigger as string);
        } else if (msg.type === "modeSet" && this.modeHandler) {
          this.modeHandler({
            mode: String(msg.mode ?? "tutor"),
            available: Array.isArray(msg.available) ? (msg.available as string[]) : [],
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
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.output.appendLine(`[bridge] socket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 3000);
  }
}
