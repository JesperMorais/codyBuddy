import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Load every `*.md` file in `dir` into a `name -> content` map.
 * Missing directories return an empty map — gating is the caller's job.
 */
export function loadPromptDir(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    map.set(basename(f, ".md"), readFileSync(join(dir, f), "utf8"));
  }
  return map;
}

export interface LoadedPersonalities {
  /** Personalities that the daemon will accept via setPersonality. */
  personalities: Map<string, string>;
  /**
   * Names that exist on disk but were deliberately *not* loaded for
   * this provider, mapped to a human-readable reason. The server
   * surfaces these reasons when setPersonality rejects, so the
   * sidebar can tell the user *why* the choice was refused rather
   * than just showing the dropdown snap back.
   */
  gated: Map<string, string>;
}

/**
 * Read personalities from `<promptsDir>/personalities/` and, when the
 * provider is `ollama`, additionally merge `<promptsDir>/personalities-ollama/`.
 * On any other provider the ollama-only directory is *gated*: its
 * names appear in `gated` (with a reason) so the daemon can produce a
 * clear rejection message instead of a generic "unknown personality".
 *
 * NSFW belongs in personalities-ollama/ specifically because the hosted
 * Anthropic models will refuse most of the overlay it asks for —
 * shipping it on that path would just generate confusing 4xx responses
 * mid-session. Local Ollama models have no such filter.
 */
export function loadPersonalities(
  promptsDir: string,
  provider: string
): LoadedPersonalities {
  const baseDir = join(promptsDir, "personalities");
  const ollamaDir = join(promptsDir, "personalities-ollama");
  const personalities = loadPromptDir(baseDir);
  const gated = new Map<string, string>();
  const ollamaPack = loadPromptDir(ollamaDir);

  if (provider === "ollama") {
    for (const [name, content] of ollamaPack) {
      personalities.set(name, content);
    }
  } else {
    for (const name of ollamaPack.keys()) {
      gated.set(
        name,
        `personality '${name}' requires BUDDY_PROVIDER=ollama (current provider does not support uncensored output)`
      );
    }
  }

  return { personalities, gated };
}
