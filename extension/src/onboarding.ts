// First-run onboarding helpers — Task 15.12.
//
// When the extension activates and the workspace has no `.env`
// (or it's missing a real `ANTHROPIC_API_KEY`), we show a four-step
// quickpick wizard:
//   (1) paste API key
//   (2) pick a personality
//   (3) pick wake-word mode (off / "hey buddy" / custom phrase)
//   (4) optional "say something to test the mic"
//
// On completion we write the picked values into .env via the
// existing env-writer (Task 15.8) and stash a workspace-state flag
// so we don't re-prompt on the next activation.
//
// This module is structured around three pure functions so the
// vscode-API-bound parts (showInputBox / showQuickPick) can be
// driven by tests that stub the wizard runner.

import { existsSync, readFileSync } from "node:fs";
import { applyEnvUpdates, updateEnvFile } from "./env-writer.js";

export type WakeWordMode = "off" | "hey buddy" | string;

export interface OnboardingResult {
  apiKey: string;
  personality: string;
  wakeWord: WakeWordMode;
}

/** Read .env at `envPath` and decide if we should run the wizard.
 *  Reasons:
 *    - file missing → show
 *    - ANTHROPIC_API_KEY unset → show
 *    - ANTHROPIC_API_KEY is the literal `.env.example` placeholder
 *      (`sk-ant-...`) → show
 *  Returns false when the user is running the Ollama provider —
 *  no Anthropic key needed in that case. */
export function shouldShowOnboarding(envPath: string): boolean {
  if (!existsSync(envPath)) return true;
  const text = readFileSync(envPath, "utf8");
  const provider = readEnvVar(text, "BUDDY_PROVIDER")?.toLowerCase() ?? "anthropic";
  if (provider !== "anthropic") return false;
  const key = readEnvVar(text, "ANTHROPIC_API_KEY");
  if (!key) return true;
  if (key === "sk-ant-..." || key.startsWith("sk-ant-...")) return true;
  return false;
}

/** Pure validator: an Anthropic key the wizard should accept. */
export function isValidApiKey(input: string): boolean {
  if (!input) return false;
  const trimmed = input.trim();
  // Real Anthropic keys are sk-ant-<random> with substantial length.
  if (!trimmed.startsWith("sk-ant-")) return false;
  if (trimmed === "sk-ant-..." || trimmed.startsWith("sk-ant-...")) return false;
  if (trimmed.length < 30) return false;
  return true;
}

/** Persist the onboarding choices to .env. Returns the resulting
 *  file content (handy for tests). The wakeWord value goes through
 *  verbatim so users with a custom phrase ("hey jane") get exactly
 *  what they typed. The literal "off" value lands as-is — the
 *  daemon's BUDDY_WAKEWORD parser treats it as "no wake word". */
export function applyOnboardingResult(
  envPath: string,
  result: OnboardingResult
): string {
  return updateEnvFile(envPath, {
    ANTHROPIC_API_KEY: result.apiKey.trim(),
    BUDDY_PERSONALITY: result.personality,
    BUDDY_WAKEWORD: result.wakeWord,
    // BUDDY_PROVIDER may already be set; updateEnvFile leaves
    // existing keys alone unless we explicitly set them, so we
    // default it when absent without clobbering.
    BUDDY_PROVIDER: "anthropic",
  });
}

/** Re-export for callers that want to drive the same env-write
 *  contract from the wizard's done-handler without going through disk. */
export { applyEnvUpdates };

/** Workspace-state key the runtime uses to suppress re-prompting
 *  after a user explicitly skipped the wizard. */
export const ONBOARDING_DISMISSED_KEY = "buddy.onboardingDismissed";

function readEnvVar(text: string, name: string): string | null {
  const re = new RegExp(`^\\s*${escapeRe(name)}\\s*=\\s*(.*?)\\s*$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
