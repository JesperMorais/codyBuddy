// Personality voice configuration — Task 12.1.
//
// Personality stops being just a tone-overlay prompt and becomes
// "voice + prosody + script". The prompt (personalities/<name>.md)
// covers the script half; this module covers the voice + prosody
// half via a small JSON config file alongside each .md.
//
// Why a separate file instead of embedding in the .md frontmatter:
//   - The TTS bridge needs structured numeric values (rate / energy /
//     pause_factor multipliers), not Markdown.
//   - Engineers tuning a personality's voice usually don't want to
//     touch the prompt at the same time, and vice versa.
//   - JSON validates cheaply.
//
// Schema:
//   {
//     "voice_engine": "kokoro" | "xtts",
//     "kokoro_voice"?: string,   // present when engine=kokoro (Task 12.2 fills these in)
//     "xtts_ref"?: string,        // path to reference clip (Task 12.4)
//     "rate": number,             // playback rate multiplier (1.0 = baseline)
//     "energy": number,           // loudness/energy multiplier
//     "pause_factor": number      // pause-between-sentences multiplier
//   }
//
// The loader rejects:
//   - missing config files
//   - invalid JSON
//   - unknown voice_engine values (must be exactly "kokoro" or "xtts")
//   - missing or non-finite numeric fields
//
// Wiring into TtsBridge happens in Tasks 12.2 / 12.6; this module is
// a pure loader so it can be exercised on its own.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VOICE_ENGINES = ["kokoro", "xtts"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

export interface PersonalityConfig {
  voice_engine: VoiceEngine;
  kokoro_voice?: string;
  xtts_ref?: string;
  rate: number;
  energy: number;
  pause_factor: number;
}

/** Parse a single config object. Throws with a human-readable
 *  message that names the personality and the specific problem. */
export function parsePersonalityConfig(
  raw: unknown,
  name: string
): PersonalityConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `personality '${name}': config must be a JSON object`
    );
  }
  const r = raw as Record<string, unknown>;

  const engine = r.voice_engine;
  if (
    typeof engine !== "string" ||
    !(VOICE_ENGINES as readonly string[]).includes(engine)
  ) {
    throw new Error(
      `personality '${name}': unknown voice_engine ${JSON.stringify(
        engine
      )}, expected one of: ${VOICE_ENGINES.join(", ")}`
    );
  }

  if (typeof r.rate !== "number" || !Number.isFinite(r.rate)) {
    throw new Error(`personality '${name}': rate must be a finite number`);
  }
  if (typeof r.energy !== "number" || !Number.isFinite(r.energy)) {
    throw new Error(`personality '${name}': energy must be a finite number`);
  }
  if (
    typeof r.pause_factor !== "number" ||
    !Number.isFinite(r.pause_factor)
  ) {
    throw new Error(
      `personality '${name}': pause_factor must be a finite number`
    );
  }

  const cfg: PersonalityConfig = {
    voice_engine: engine as VoiceEngine,
    rate: r.rate,
    energy: r.energy,
    pause_factor: r.pause_factor,
  };
  if (typeof r.kokoro_voice === "string") cfg.kokoro_voice = r.kokoro_voice;
  if (typeof r.xtts_ref === "string") cfg.xtts_ref = r.xtts_ref;
  return cfg;
}

/** Read `<dir>/<name>.json` for each given personality name and
 *  return a `name → PersonalityConfig` map. Throws on the FIRST
 *  bad config (missing file, invalid JSON, schema violation) so a
 *  bad config can never silently degrade the live audio path. */
export function loadPersonalityConfigs(
  dir: string,
  names: Iterable<string>
): Map<string, PersonalityConfig> {
  const out = new Map<string, PersonalityConfig>();
  for (const name of names) {
    const path = join(dir, `${name}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `personality '${name}': config file missing at ${path}`
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(
        `personality '${name}': invalid JSON at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    out.set(name, parsePersonalityConfig(raw, name));
  }
  return out;
}
