import type { TtsBackend } from "./tts-bridge.js";

const TTS_BACKENDS: readonly TtsBackend[] = [
  "none",
  "auto",
  "piper",
  "kokoro",
  "xtts",
];

/**
 * Parse `BUDDY_TTS_BACKEND` into a concrete TtsBackend value.
 *   - empty / unset → "none" (back-compat: existing users without the
 *     env var keep silent behavior; new users opt into voice via
 *     `BUDDY_TTS_BACKEND=auto`).
 *   - "auto" → personality-driven routing (Task 12.6).
 *   - explicit values ("kokoro", "xtts", "piper", "none") → exact
 *     override that wins over personality config.
 */
export function parseTtsBackend(raw: string | undefined): TtsBackend {
  if (raw === undefined || raw === "") return "none";
  if ((TTS_BACKENDS as readonly string[]).includes(raw)) {
    return raw as TtsBackend;
  }
  throw new Error(
    `Unknown BUDDY_TTS_BACKEND="${raw}". Expected one of: ${TTS_BACKENDS.join(", ")}.`
  );
}

export const ttsRequestTimeoutMs = (() => {
  const raw = process.env.BUDDY_TTS_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return 30000;
  return parsed;
})();
