import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicClient } from "./anthropic.js";
import { OllamaClient, DEFAULT_OLLAMA_MODEL } from "./ollama.js";
import { Session } from "./session.js";
import type { AiClient } from "./anthropic.js";
import { TtsBridge } from "./tts-bridge.js";
import { SttBridge } from "./stt.js";
import { Recorder } from "./recorder.js";
import { parseTtsBackend } from "./config.js";
import { startServer } from "./server.js";
import { HttpScreenpipeClient } from "./screenpipe.js";
import { VoteStore } from "./votes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const provider = (process.env.BUDDY_PROVIDER ?? "anthropic").toLowerCase();
if (provider !== "anthropic" && provider !== "ollama") {
  console.error(`[buddy-daemon] BUDDY_PROVIDER must be "anthropic" or "ollama" (got "${provider}").`);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (provider === "anthropic" && !apiKey) {
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
const kokoroUrl = process.env.BUDDY_KOKORO_URL;
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

let client: AiClient;
if (provider === "ollama") {
  const ollamaUrl = process.env.BUDDY_OLLAMA_URL ?? "http://localhost:11434/v1";
  const ollamaModel = process.env.BUDDY_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  client = new OllamaClient({ baseUrl: ollamaUrl, model: ollamaModel });
  console.log(`[buddy-daemon] provider=ollama url=${ollamaUrl} model=${ollamaModel}`);
} else {
  client = new AnthropicClient(apiKey!, model);
  console.log(`[buddy-daemon] provider=anthropic model=${model}`);
}
const screenpipeUrl = process.env.BUDDY_SCREENPIPE_URL;
const screenpipe = screenpipeUrl
  ? new HttpScreenpipeClient({ baseUrl: screenpipeUrl })
  : undefined;
if (screenpipe) {
  console.log(`[buddy-daemon] Screenpipe enabled at ${screenpipeUrl}`);
}
const session = new Session(client, prompts, { screenpipe });
const tts = new TtsBridge({
  backend: ttsBackend,
  piperExe,
  piperVoice,
  kokoroUrl,
  volume: ttsVolume,
});
const stt = new SttBridge({ exe: whisperExe, model: whisperModel });
const recorder = new Recorder();

const votes = new VoteStore();
const wss = startServer({ session, tts, stt, recorder, port, votes });
console.log(
  `[buddy-daemon] listening on ws://127.0.0.1:${port} (model=${model}, tts=${tts.describe()}, stt=${stt.describe()})`
);

process.on("SIGINT", () => {
  console.log("\n[buddy-daemon] shutting down");
  wss.close();
  process.exit(0);
});
