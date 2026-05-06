// Conversational-mode prompt loader — Task 11.3.
//
// The daemon ships two parallel prompt sets:
//   daemon/prompts/{tutor,reviewer,architect,explainer}.md
//     — the existing JSON-mode prompts used by Session.handleTrigger
//       (the chat / sidebar path).
//   daemon/prompts/conversational/{tutor,reviewer,architect,explainer}.md
//     — plain-text, 1-2-sentence-default prompts the conversation loop
//       (Task 10.6) hands to AnthropicClient.askStream (Task 11.1).
//
// Splitting the loader from the existing index.ts walker keeps the
// chat-path bootstrap unaware of the audio-path prompts — they're
// only loaded when the audio host wires the conversation loop.

import { loadPromptDir } from "./personalities-loader.js";
import { join } from "node:path";

/**
 * Load every conversational mode prompt under
 * `<promptsDir>/conversational/`. The returned map is keyed by mode
 * name (without the `.md` extension), matching the shape of the
 * chat-path mode map. Missing directory yields an empty map — the
 * audio host is expected to refuse to boot in that case rather than
 * silently using the chat-path prompts.
 */
export function loadConversationalPrompts(promptsDir: string): Map<string, string> {
  return loadPromptDir(join(promptsDir, "conversational"));
}
