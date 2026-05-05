import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { AnthropicClient } from "./anthropic.js";
import { Session } from "./session.js";
import { TtsBridge } from "./tts-bridge.js";
import { SttBridge } from "./stt.js";
import { Recorder } from "./recorder.js";
import { parseTtsBackend } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY missing. Copy .env.example → .env.");
  process.exit(1);
}

const port = Number(process.env.BUDDY_DAEMON_PORT ?? 31415);
let ttsBackend;
try {
  ttsBackend = parseTtsBackend(process.env.BUDDY_TTS_BACKEND);
} catch (err) {
  console.error(`[buddy-daemon] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const piperExe = process.env.BUDDY_PIPER_EXE;
const piperVoice = process.env.BUDDY_PIPER_VOICE;
const ttsVolume = Number(process.env.BUDDY_TTS_VOLUME ?? "0.5");
const whisperExe = process.env.BUDDY_WHISPER_EXE;
const whisperModel = process.env.BUDDY_WHISPER_MODEL;
const model = process.env.BUDDY_MODEL ?? "claude-sonnet-4-6";

const promptsDir = resolve(__dirname, "../prompts");
const prompts = new Map<string, string>();
for (const f of readdirSync(promptsDir)) {
  if (!f.endsWith(".md")) continue;
  const name = basename(f, ".md");
  prompts.set(name, readFileSync(resolve(promptsDir, f), "utf8"));
}
console.log(`[buddy-daemon] loaded modes: ${[...prompts.keys()].join(", ")}`);

const client = new AnthropicClient(apiKey, model);
const session = new Session(client, prompts);
const tts = new TtsBridge({
  backend: ttsBackend,
  piperExe,
  piperVoice,
  volume: ttsVolume,
});
const stt = new SttBridge({ exe: whisperExe, model: whisperModel });
const recorder = new Recorder();

const wss = new WebSocketServer({ host: "127.0.0.1", port });
console.log(
  `[buddy-daemon] listening on ws://127.0.0.1:${port} (model=${model}, tts=${tts.describe()}, stt=${stt.describe()})`
);

wss.on("connection", (ws: WebSocket) => {
  console.log("[buddy-daemon] extension connected");
  ws.send(
    JSON.stringify({
      type: "modeSet",
      ok: true,
      mode: session.getMode(),
      available: session.listModes(),
    })
  );
  ws.send(
    JSON.stringify({
      type: "audioOwner",
      owner: tts.isActive() ? "daemon" : "webview",
      backend: tts.describe(),
    })
  );

  ws.on("message", async (raw) => {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "bad json" }));
      return;
    }

    try {
      switch (msg.type) {
        case "trigger": {
          const { trigger, payload } = msg as unknown as {
            trigger: string;
            payload: object;
          };
          const payloadStr = JSON.stringify(payload);
          const hasRedaction = payloadStr.includes("<REDACTED-SECRET>");
          console.log(
            `[trigger] ${trigger} bytes=${payloadStr.length}${hasRedaction ? " [scrubbed]" : ""}`
          );
          const reply = await session.handleTrigger(trigger, payload);
          ws.send(JSON.stringify({ type: "reply", trigger, reply }));
          if (reply.mode !== "no_op" && reply.text) void tts.speak(reply.text);
          break;
        }
        case "mute": {
          const minutes = Number((msg as { minutes?: number }).minutes ?? 30);
          session.mute(minutes);
          tts.cancel();
          ws.send(JSON.stringify({ type: "muted", minutes }));
          break;
        }
        case "unmute": {
          session.unmute();
          ws.send(JSON.stringify({ type: "unmuted" }));
          break;
        }
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "setVolume": {
          const v = Number((msg as { volume?: number }).volume ?? 0.5);
          tts.setVolume(v);
          ws.send(JSON.stringify({ type: "volumeSet", volume: v, backend: tts.describe() }));
          break;
        }
        case "recordStart": {
          const r = recorder.start();
          ws.send(JSON.stringify({ type: "recordStarted", ok: r.ok, error: r.ok ? undefined : (r as { error: string }).error }));
          break;
        }
        case "recordStop": {
          const requestId = (msg as { requestId?: string }).requestId ?? "";
          if (!recorder.isRecording()) {
            ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: "not recording" }));
            break;
          }
          try {
            const r = await recorder.stop();
            if (!r.ok) {
              ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: (r as { error: string }).error }));
              break;
            }
            console.log(`[recorder] captured ${r.wav.length} bytes in ${r.durationMs}ms`);
            const text = await stt.transcribe(r.wav);
            console.log(`[transcribe] → "${text}"`);
            ws.send(JSON.stringify({ type: "transcribed", requestId, ok: true, text }));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("[recordStop] failed:", errMsg);
            ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: errMsg }));
          }
          break;
        }
        case "transcribe": {
          const requestId = (msg as { requestId?: string }).requestId ?? "";
          const b64 = (msg as { audio?: string }).audio ?? "";
          if (!b64) {
            ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: "no audio" }));
            break;
          }
          const buf = Buffer.from(b64, "base64");
          console.log(`[transcribe] received ${buf.length} bytes`);
          try {
            const text = await stt.transcribe(buf);
            console.log(`[transcribe] → "${text}"`);
            ws.send(JSON.stringify({ type: "transcribed", requestId, ok: true, text }));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("[transcribe] failed:", errMsg);
            ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: errMsg }));
          }
          break;
        }
        case "setMode": {
          const target = String((msg as { mode?: string }).mode ?? "");
          const ok = session.setMode(target);
          ws.send(
            JSON.stringify({
              type: "modeSet",
              ok,
              mode: session.getMode(),
              available: session.listModes(),
            })
          );
          break;
        }
        case "getMode":
          ws.send(
            JSON.stringify({
              type: "modeSet",
              ok: true,
              mode: session.getMode(),
              available: session.listModes(),
            })
          );
          break;
        case "getReport": {
          const summary = session.getMemory().getSummary();
          const paths = session.getMemory().paths();
          ws.send(JSON.stringify({ type: "report", summary, paths }));
          break;
        }
        case "refreshReport": {
          const summary = await session.forceDistillProfile();
          const paths = session.getMemory().paths();
          ws.send(JSON.stringify({ type: "report", summary, paths, refreshed: true }));
          break;
        }
        default:
          ws.send(JSON.stringify({ type: "error", error: `unknown type ${msg.type}` }));
      }
    } catch (err) {
      console.error("[buddy-daemon] handler error", err);
      ws.send(
        JSON.stringify({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  });

  ws.on("close", () => console.log("[buddy-daemon] extension disconnected"));
});

process.on("SIGINT", () => {
  console.log("\n[buddy-daemon] shutting down");
  wss.close();
  process.exit(0);
});
