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
import { TurnTelemetry } from "./turn-telemetry.js";
import { RollingCostRate } from "./cost-rate.js";
import { DemoClient } from "./demo-client.js";
import { DemoFallbackClient } from "./demo-fallback.js";
import {
  findManifest,
  loadManifest,
  ModelChecksumError,
  verifyManifest,
} from "./models-manifest.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { findVoiceDir, spawnVoiceSidecar } from "./voice-sidecar.js";
import { VadBridge } from "./vad-bridge.js";
import { StreamingSttBridge } from "./stt-stream.js";
import { StreamingTtsBridge } from "./tts-stream.js";
import { TieredRouter } from "./tiered-router.js";
import { AudioHost, AlwaysEscalateHaiku } from "./audio-host.js";
import { AnthropicHaikuClassifier } from "./haiku-classifier.js";
import { loadConversationalPrompts } from "./conversational-prompts.js";

// Resolve __dirname for both the dev path (Node ESM running from
// daemon/dist/index.js) and the SEA bundle (Task 15.6) where
// esbuild's CJS output makes import.meta empty. In the bundle we
// fall back to the binary's own location — prompts/ is shipped
// alongside it in the release zip.
const __dirname = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return dirname(process.execPath);
  }
})();

// Task 15.10: verify pinned model checksums BEFORE we boot the
// real daemon. A corrupted download must refuse startup with the
// spec'd error message rather than degrading silently. Missing
// models and TBD-pinned entries are skipped — chat-only installs
// don't ship voice models, and pre-pinned entries land before all
// SHAs are known.
try {
  const manifestPath = findManifest(__dirname);
  if (manifestPath) {
    const manifest = loadManifest(manifestPath);
    if (manifest) {
      const baseDir = dirname(dirname(manifestPath)); // …/voice/.. → repo root
      const result = verifyManifest(manifest, baseDir);
      if (result.checked > 0) {
        console.log(
          `[buddy-daemon] model manifest verified: ${result.checked} checked, ${result.skipped_tbd} TBD, ${result.skipped_missing} not downloaded.`
        );
      }
    }
  }
} catch (err) {
  if (err instanceof ModelChecksumError) {
    console.error(`[buddy-daemon] ${err.message}`);
    process.exit(1);
  }
  // Schema errors / IO errors aren't blocking — a bad manifest
  // is a maintainer bug, not the user's fault. Log and continue.
  console.error(
    `[buddy-daemon] model manifest verification skipped: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}

const provider = (process.env.BUDDY_PROVIDER ?? "anthropic").toLowerCase();
if (provider !== "anthropic" && provider !== "ollama") {
  console.error(`[buddy-daemon] BUDDY_PROVIDER must be "anthropic" or "ollama" (got "${provider}").`);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
const demoMode =
  (process.env.BUDDY_DEMO ?? "").toLowerCase() === "true";
// Treat the literal placeholder from .env.example as "no key" so
// new users hit demo mode rather than a 401 on first turn.
const placeholderKey =
  apiKey === undefined ||
  apiKey === "" ||
  apiKey === "sk-ant-..." ||
  apiKey.startsWith("sk-ant-...");
if (provider === "anthropic" && !apiKey && !demoMode) {
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
const xttsUrl = process.env.BUDDY_XTTS_URL;
const xttsLanguage = process.env.BUDDY_XTTS_LANGUAGE;
const ttsVolume = Number(process.env.BUDDY_TTS_VOLUME ?? "0.5");
const whisperExe = process.env.BUDDY_WHISPER_EXE;
const whisperModel = process.env.BUDDY_WHISPER_MODEL;
const model = process.env.BUDDY_MODEL ?? "claude-sonnet-4-6";

// Dev: daemon/dist/index.js → ../prompts.
// SEA bundle: prompts ship as a sibling of the binary.
const promptsDir = (() => {
  const sibling = resolve(__dirname, "prompts");
  if (existsSync(sibling)) return sibling;
  return resolve(__dirname, "../prompts");
})();
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
// Hook used to broadcast demoMode:false when the first real call
// succeeds (Task 15.4). Wired further down once startServer is
// constructed.
let onDemoDisable: () => void = () => {};
if (provider === "ollama") {
  const ollamaUrl = process.env.BUDDY_OLLAMA_URL ?? "http://localhost:11434/v1";
  const ollamaModel = process.env.BUDDY_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  client = new OllamaClient({ baseUrl: ollamaUrl, model: ollamaModel });
  console.log(`[buddy-daemon] provider=ollama url=${ollamaUrl} model=${ollamaModel}`);
} else if (demoMode && placeholderKey) {
  // BUDDY_DEMO=true with no real key: pure DemoClient, no network.
  client = new DemoClient();
  console.log(`[buddy-daemon] DEMO MODE active — replies are canned, not from Claude.`);
} else if (demoMode) {
  // BUDDY_DEMO=true with a key: try real, fall back to demo until
  // the first real success disables demo for the rest of the session.
  const real = new AnthropicClient(apiKey!, model);
  const demo = new DemoClient();
  client = new DemoFallbackClient({
    real,
    demo,
    onRealSuccess: () => {
      console.log(`[buddy-daemon] demo mode disabled — first real Anthropic call succeeded.`);
      try {
        onDemoDisable();
      } catch (err) {
        console.error("[buddy-daemon] onDemoDisable hook threw:", err);
      }
    },
  });
  console.log(`[buddy-daemon] DEMO MODE armed — will disable on first real Anthropic success.`);
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
  xttsUrl,
  xttsLanguage,
  volume: ttsVolume,
});
const stt = new SttBridge({ exe: whisperExe, model: whisperModel });
const recorder = new Recorder();

const votes = new VoteStore();
// Task 13.3: bring up the per-turn telemetry singleton + rolling
// $/hr observer. The recorder is unwired today (turns aren't being
// appended yet — that comes when 11.x lands the per-turn write into
// the conversation loop), so the snapshot is currently always zero.
// The wire lets the sidebar query as soon as turns start landing
// without another deploy.
const turnTelemetry = new TurnTelemetry();
const costRate = new RollingCostRate({ turnTelemetry });
const wss = startServer({
  session,
  tts,
  stt,
  recorder,
  port,
  votes,
  gatedPersonalities,
  kokoroVoiceFor,
  personalityVoiceConfigs: personalityConfigs,
  costRate,
  demoMode,
});
// Wire DemoFallbackClient's onRealSuccess hook to broadcast
// demoMode:false to every connected webview (Task 15.4).
onDemoDisable = () => wss.setDemoMode(false);
console.log(
  `[buddy-daemon] listening on ws://127.0.0.1:${port} (model=${model}, tts=${tts.describe()}, stt=${stt.describe()})`
);

// Task 15.11: chat-only minimal install (`BUDDY_VOICE_LOOP=off`)
// short-circuits every voice-side spawn so the daemon boots
// without `voice/.venv` or any Python at all. The flag is the
// authoritative kill-switch even when `BUDDY_VAD_SPAWN=true` —
// chat-only ALWAYS wins. Default `auto` keeps existing behavior.
const voiceLoop = (process.env.BUDDY_VOICE_LOOP ?? "auto").toLowerCase();
if (voiceLoop === "off") {
  console.log(
    "[buddy-daemon] voice loop disabled (BUDDY_VOICE_LOOP=off) -- chat-only install."
  );
}

// Task 16.1: minimum-viable voice-loop wiring. Constructs the
// bridges + router + AudioHost when the user opts in via
// `BUDDY_VOICE_LOOP=on`. This is the *first* time the loop classes
// are instantiated in production — until now they shipped as dead
// code with green unit tests but zero runtime presence. The
// `auto` (default) and `off` branches preserve existing behavior so
// upgrading to this build doesn't change any chat-only flow.
//
// What this wires (MVP per 16.1):
//   - VadBridge      ws://127.0.0.1:<voicePort>/vad
//   - StreamingSttBridge   subprocess: $BUDDY_STT_STREAM_EXE
//   - StreamingTtsBridge   ws://127.0.0.1:<voicePort>/tts/stream
//   - TieredRouter   sonnet=ankhrop_client; haiku=AlwaysEscalateHaiku stub
//   - AudioHost      composes all of the above; appends one turns.jsonl
//                    line per completed voice turn
//
// Deferred to 16.1.x sub-items: WakeWordGate filtering, real
// HaikuClassifier, BackchannelController scheduler, AutoQuietGate
// + DailyCostCap enforcement, real audio device wiring, sidebar
// state pill, accurate per-turn token capture.
let audioHost: AudioHost | undefined;
if (voiceLoop === "on") {
  const voicePort = Number(process.env.BUDDY_VOICE_PORT ?? 31416);
  const sttExe = process.env.BUDDY_STT_STREAM_EXE;
  if (!sttExe) {
    console.warn(
      "[buddy-daemon] BUDDY_VOICE_LOOP=on but BUDDY_STT_STREAM_EXE is unset — voice loop NOT started. Set the path to a streaming-whisper-shaped binary (see daemon/src/stt-stream.ts header)."
    );
  } else {
    const conversationalPrompts = loadConversationalPrompts(promptsDir);
    if (conversationalPrompts.size === 0) {
      console.warn(
        "[buddy-daemon] BUDDY_VOICE_LOOP=on but no conversational prompts found at daemon/prompts/conversational/ — voice loop NOT started."
      );
    } else {
      const vad = new VadBridge({
        url: `ws://127.0.0.1:${voicePort}/vad`,
        log: (line) => console.log(line),
      });
      const stt = new StreamingSttBridge({
        command: sttExe,
        log: (line) => console.log(line),
      });
      const ttsStream = new StreamingTtsBridge({
        url: `ws://127.0.0.1:${voicePort}/tts/stream`,
        log: (line) => console.log(line),
      });
      // Task 16.1.1: real Haiku classifier on the Anthropic path so
      // cheap-tier turns actually save tokens. Ollama users keep the
      // always-escalate stub — Haiku is Anthropic-only and local
      // models have no per-turn cost incentive to gate.
      const haikuClassifier =
        provider === "anthropic" && apiKey
          ? new AnthropicHaikuClassifier({
              apiKey,
              log: (line) => console.log(line),
            })
          : new AlwaysEscalateHaiku();
      const router = new TieredRouter({
        haiku: haikuClassifier,
        sonnet: client,
        log: (line) => console.log(line),
      });
      audioHost = new AudioHost({
        vad,
        stt,
        tts: ttsStream,
        router,
        turnTelemetry,
        getSystemBlocks: () => {
          // Conversational mode prompt + personality overlay (only
          // when not "nice"). Same precedence rules as the chat path.
          const mode = session.getMode();
          const blocks: string[] = [];
          const modePrompt = conversationalPrompts.get(mode);
          if (modePrompt) blocks.push(modePrompt);
          const personality = session.getPersonality();
          if (personality !== "nice") {
            const overlay = personalities.get(personality);
            if (overlay) blocks.push(overlay);
          }
          return blocks;
        },
        getMode: () => session.getMode(),
        getPersonality: () => session.getPersonality(),
        getWakeWord: () => process.env.BUDDY_WAKEWORD ?? "off",
        log: (line) => console.log(line),
      });
      vad.connect();
      ttsStream.connect();
      stt.start();
      console.log(
        `[buddy-daemon] voice loop wired (vad=ws://127.0.0.1:${voicePort}/vad, tts=ws://127.0.0.1:${voicePort}/tts/stream, stt=${sttExe})`
      );
    }
  }
}

// Optional: supervise the voice sidecar from the daemon. Off by
// default — voice is still typically run via `pnpm dev:voice` in a
// dedicated terminal during development. BUDDY_VAD_SPAWN=true flips
// the daemon into "I own the python process" mode for /vad consumers.
let voiceSidecar: ReturnType<typeof spawnVoiceSidecar> | undefined;
if (
  voiceLoop !== "off" &&
  (process.env.BUDDY_VAD_SPAWN ?? "").toLowerCase() === "true"
) {
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
