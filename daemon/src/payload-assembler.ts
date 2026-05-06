// Conversation-context payload assembler — Task 10.9.
//
// Every time the conversation loop hits THINKING (whether the trigger
// was a voice transcript or an editor opportunity) it needs to hand
// the LLM ONE coherent payload combining:
//
//   (a) the conversation transcript so far (so context isn't reset
//       per turn)
//   (b) editor context: active file, diagnostics, recent diff —
//       redacted (denied files dropped, secrets scrubbed) before
//       inclusion
//   (c) the most recent editor trigger if one is in flight
//
// This module owns step (b)'s redaction and the assembly. The chat
// path (Session.handleTrigger) already builds a similar payload but
// trusts the extension's pre-redaction; the audio path can't, so
// it routes through scrubSecrets / isDeniedFile here directly.

import { isDeniedFile, scrubSecrets } from "./redactor.js";

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface EditorContext {
  /** Absolute or workspace-relative path of the file the user is
   *  currently editing. Dropped from the payload entirely when it
   *  matches a deny pattern (.env, *.pem, secrets/, etc.). */
  activeFile?: string;
  /** Compiler / linter diagnostics for the active file. Each
   *  message is scrubbed for secrets. */
  diagnostics?: Array<{
    severity?: string;
    message: string;
    line?: number;
  }>;
  /** Recent edit diff (unified format). Scrubbed for secrets. */
  recentDiff?: string;
}

export interface EditorTrigger {
  /** Trigger name e.g. "MISCONCEPTION", "STUCK_LOOP", "EXPLICIT_ASK". */
  trigger: string;
  /** Human-readable rationale, displayed in the sidebar. */
  reason?: string;
  /** Trigger-specific payload (anti-pattern name, stuck signature, etc). */
  payload?: object;
}

export interface AssembleInput {
  /** Full back-and-forth so far for this conversation. The
   *  assembler keeps the last N turns (default 8) so token budget
   *  doesn't blow up across long sessions. */
  conversationTranscript: ConversationTurn[];
  /** Editor state at the moment the loop entered THINKING. May be
   *  omitted when the trigger is voice-only and there's no editor
   *  context to attach. */
  editorContext?: EditorContext;
  /** Most recent editor trigger, if any. Voice-only turns leave this
   *  undefined. */
  recentTrigger?: EditorTrigger;
  /** How many recent transcript turns to include. Default 8. */
  maxTranscriptTurns?: number;
}

export interface AssembledPayload {
  /** The "what to actually answer" line. For voice turns this is
   *  the latest user transcript; for opportunity turns it's the
   *  trigger reason. Always present. */
  user_question: string;
  /** Compact prior conversation turns, oldest-first. Empty for the
   *  first turn of a session. */
  recent_chat: ConversationTurn[];
  /** Path of the active file. Omitted when no file context or when
   *  the file matched a deny pattern. */
  active_file?: string;
  /** Recent diff with secrets scrubbed. Omitted when there's no
   *  diff or the active file was denied. */
  recent_diff?: string;
  /** Diagnostics with secret-scrubbed messages. Empty array means
   *  "explicitly checked, none found"; missing means "no editor
   *  context provided". */
  diagnostics?: Array<{ severity?: string; message: string; line?: number }>;
  /** The trigger that brought us into THINKING, if any. Voice turns
   *  emit `EXPLICIT_ASK` here so downstream prompts can branch
   *  uniformly. */
  trigger?: string;
  trigger_reason?: string;
  trigger_payload?: object;
  /** Bookkeeping for telemetry / audits — total secret hits across
   *  every redacted field, plus a boolean for whether the active
   *  file was rejected outright. */
  redaction: {
    secret_hits: number;
    active_file_denied: boolean;
  };
}

/**
 * Build the unified payload. Pure — no I/O, no clock — so tests can
 * pin the exact output for a fixture turn.
 *
 * Redaction rules:
 *   - If `editorContext.activeFile` matches a deny pattern, the entire
 *     editor context is dropped (file path, diff, diagnostics) and
 *     `redaction.active_file_denied` is true. The conversation is
 *     still useful — the user may have asked a generic question
 *     unrelated to that file — so we don't bail.
 *   - `recentDiff` and each `diagnostics[i].message` are passed
 *     through `scrubSecrets`; the cumulative hit count lands in
 *     `redaction.secret_hits`.
 *   - The conversation transcript is NOT scrubbed: it's the user's
 *     own spoken/typed words, scrubbing them would change semantics.
 *     If a user dictates "my key is sk-..." the LLM needs that
 *     verbatim to answer. (Matches the chat path.)
 *
 * Trigger / question precedence:
 *   - The latest user turn becomes `user_question` if present.
 *   - If there's no user turn (opportunity-only), the trigger.reason
 *     is used; if there's no reason either, we fall back to a
 *     generic "what should I look at?" so the LLM always has SOMETHING.
 */
export function assembleConversationPayload(input: AssembleInput): AssembledPayload {
  const max = input.maxTranscriptTurns ?? 8;
  const allTurns = input.conversationTranscript ?? [];
  const lastUser = [...allTurns].reverse().find((t) => t.role === "user");
  const recent = allTurns.slice(-max);

  let user_question = "";
  if (lastUser?.text?.trim()) {
    user_question = lastUser.text.trim();
  } else if (input.recentTrigger?.reason?.trim()) {
    user_question = input.recentTrigger.reason.trim();
  } else {
    user_question = "what should I look at?";
  }

  let secretHits = 0;
  let activeFileDenied = false;
  let activeFile: string | undefined;
  let recentDiff: string | undefined;
  let diagnostics: AssembledPayload["diagnostics"] | undefined;

  if (input.editorContext) {
    const ec = input.editorContext;
    if (ec.activeFile && isDeniedFile(ec.activeFile)) {
      activeFileDenied = true;
      // Drop the whole editor block — see header doc.
    } else {
      if (ec.activeFile) activeFile = ec.activeFile;
      if (ec.recentDiff) {
        const r = scrubSecrets(ec.recentDiff);
        secretHits += r.hits;
        recentDiff = r.text;
      }
      if (ec.diagnostics) {
        diagnostics = ec.diagnostics.map((d) => {
          const r = scrubSecrets(d.message);
          secretHits += r.hits;
          return { ...d, message: r.text };
        });
      }
    }
  }

  const out: AssembledPayload = {
    user_question,
    recent_chat: recent,
    redaction: {
      secret_hits: secretHits,
      active_file_denied: activeFileDenied,
    },
  };
  if (activeFile !== undefined) out.active_file = activeFile;
  if (recentDiff !== undefined) out.recent_diff = recentDiff;
  if (diagnostics !== undefined) out.diagnostics = diagnostics;
  if (input.recentTrigger) {
    out.trigger = input.recentTrigger.trigger;
    if (input.recentTrigger.reason) out.trigger_reason = input.recentTrigger.reason;
    if (input.recentTrigger.payload) out.trigger_payload = input.recentTrigger.payload;
  }
  return out;
}
