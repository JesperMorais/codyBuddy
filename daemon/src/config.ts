import type { TtsBackend } from "./tts-bridge.js";

const TTS_BACKENDS: readonly TtsBackend[] = ["none", "piper", "kokoro"];

export function parseTtsBackend(raw: string | undefined): TtsBackend {
  if (raw === undefined || raw === "") return "none";
  if ((TTS_BACKENDS as readonly string[]).includes(raw)) {
    return raw as TtsBackend;
  }
  throw new Error(
    `Unknown BUDDY_TTS_BACKEND="${raw}". Expected one of: ${TTS_BACKENDS.join(", ")}.`
  );
}
