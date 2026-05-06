import "dotenv/config";
import { resolve, dirname } from "node:path";
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
import { loadPromptDir, loadPersonalities } from "./personalities-loader.js";
import { loadPersonalityConfigs } from "./personality-config.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { findVoiceDir, spawnVoiceSidecar } from "./voice-sidecar.js";

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
const prompts = loadPromptDir(promptsDir);
console.log(`[buddy-daemon] loaded modes: ${[...prompts.keys()].join(", ")}`);

const { personalities, gated: gatedPersonalities } = loadPersonalities(
  promptsDir,
  provider
);
console.log(
  `[buddy-daemon] loaded personalities: ${[...personalities.keys()].join(", ") || "(none)"}`
);
if (gatedPersonalities.size > 0) {
  console.log(
    `[buddy-daemon] gated personalities (provider=${provider}): ${[...gatedPersonalities.keys()].join(", ")}`
  );
}

// Task 12.2: load each loaded personality's voice config to build a
// `name → kokoro_voice` lookup the server uses to retarget the TTS
// bridge on setPersonality. A bad config is fatal (the live audio
// path can't silently degrade); a missing config for a given
// personality leaves it unmapped and the bridge falls back to its
// sidecar default. We only require configs for personalities the
// daemon will actually accept (i.e. the loaded ones — gated names
// don't need a voice mapping).
const personalitiesDir = join(promptsDir, "personalities");
const personalityConfigs = loadPersonalityConfigs(
  personalitiesDir,
  personalities.keys()
);
const kokoroVoiceFor = new Map<string, string>();
for (const [name, cfg] of personalityConfigs) {
  if (cfg.voice_engine === "kokoro" && cfg.kokoro_voice) {
    kokoroVoiceFor.set(name, cfg.kokoro_voice);
  }
}
if (kokoroVoiceFor.size > 0) {
  console.log(
    `[buddy-daemon] kokoro voices: ${[...kokoroVoiceFor.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
}

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
// `BUDDY_PERSONALITY=random` is a sentinel for the shuffle toggle, not
// a personality name. The seed personality falls back to "nice" — the
// first trigger will rotate to something else immediately.
const envPersonality = process.env.BUDDY_PERSONALITY ?? "nice";
const defaultShuffle = envPersonality === "random";
const defaultPersonality = defaultShuffle ? "nice" : envPersonality;
const session = new Session(client, prompts, {
  screenpipe,
  personalities,
  defaultPersonality,
  defaultShuffle,
});
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
const wss = startServer({
  session,
  tts,
  stt,
  recorder,
  port,
  votes,
  gatedPersonalities,
  kokoroVoiceFor,
});
console.log(
  `[buddy-daemon] listening on ws://127.0.0.1:${port} (model=${model}, tts=${tts.describe()}, stt=${stt.describe()})`
);

// Optional: supervise the voice sidecar from the daemon. Off by
// default — voice is still typically run via `pnpm dev:voice` in a
// dedicated terminal during development. BUDDY_VAD_SPAWN=true flips
// the daemon into "I own the python process" mode for /vad consumers.
let voiceSidecar: ReturnType<typeof spawnVoiceSidecar> | undefined;
if ((process.env.BUDDY_VAD_SPAWN ?? "").toLowerCase() === "true") {
  const voiceDir = findVoiceDir(__dirname, existsSync);
  if (!voiceDir) {
    console.warn(
      "[buddy-daemon] BUDDY_VAD_SPAWN=true but voice/main.py not found — skipping sidecar spawn"
    );
  } else {
    const voicePort = Number(process.env.BUDDY_VOICE_PORT ?? 31416);
    const pythonBin = process.env.BUDDY_PYTHON ?? "python3";
    console.log(
      `[buddy-daemon] spawning voice sidecar (cwd=${voiceDir} port=${voicePort} python=${pythonBin})`
    );
    voiceSidecar = spawnVoiceSidecar({
      voiceDir,
      port: voicePort,
      pythonBin,
      log: (line) => console.log(line),
    });
  }
}

process.on("SIGINT", () => {
  console.log("\n[buddy-daemon] shutting down");
  voiceSidecar?.dispose();
  wss.close();
  process.exit(0);
});
