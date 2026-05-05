import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicClient } from "./anthropic.js";
import { Session } from "./session.js";
import { TtsBridge } from "./tts-bridge.js";
import { SttBridge } from "./stt.js";
import { Recorder } from "./recorder.js";
import { parseTtsBackend } from "./config.js";
import { startServer } from "./server.js";

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

const wss = startServer({ session, tts, stt, recorder, port });
console.log(
  `[buddy-daemon] listening on ws://127.0.0.1:${port} (model=${model}, tts=${tts.describe()}, stt=${stt.describe()})`
);

process.on("SIGINT", () => {
  console.log("\n[buddy-daemon] shutting down");
  wss.close();
  process.exit(0);
});
