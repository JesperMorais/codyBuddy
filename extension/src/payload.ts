// Task 16.4: pure helper that decides which fields the trigger
// payload may carry. When the active/target file matches the deny
// list (`.env`, `*.pem`, …), we drop `active_file`, `selection`,
// `recent_diff`, `file_content`, and `file_excerpt` entirely so the
// daemon never sees secrets the regex-based `scrubSecrets` cannot
// catch (generic `PASSWORD=`, multi-line PEMs, JWTs, etc.).
//
// The actual VS Code wiring lives in `extension.ts`. This module is
// pure so it can be unit-tested without spinning up a fake editor.

import { isDeniedFile, makeMiniDiff } from "./redactor";

export type DiagInput = { severity: string; message: string; line: number };

export type PayloadInputs = {
  /** Workspace-relative path of the target document, if any. */
  activeFileRel: string | null;
  /** Absolute filesystem path of the target document, if any. Used
   *  for deny-list matching. */
  activeFileFs: string | null;
  /** Cursor line + visible text on that line. Null when there is no
   *  active editor (e.g. trigger fired from a watcher with no UI). */
  selection: { line: number; text: string | undefined } | null;
  /** Severity / message / line for up to ten diagnostics. The caller
   *  is responsible for the slice + severity-name mapping (those use
   *  vscode enums). */
  diagnostics: DiagInput[];
  /** Stable key for snapshot lookup (typically `uri.toString()`). */
  fileKey: string | null;
  /** Current document text. Empty string when no target. */
  fileText: string;
  /** Previous document text from snapshot (callee's responsibility
   *  to default to `fileText` on first sight). */
  prevFileText: string;
  /** Cursor line for `file_excerpt` window. */
  cursorLine: number;
  /** Configured cap for the recent_diff line count. */
  maxDiffLines: number;
  /** Recent terminal commands (engine state). The exact shape is
   *  whatever `TriggerEngine.recentTerminal()` returns — we treat it
   *  as opaque here since it's never inspected by the deny-list logic. */
  recentTerminal: unknown;
  /** Free-form trigger payload: user question + reason. */
  userQuestion: string | null;
  reason: string;
};

export type SafePayload = Record<string, unknown>;

/**
 * Build the trigger payload, applying the `isDeniedFile` rule. Returns
 * a plain object suitable for JSON.stringify + scrubSecrets.
 *
 * Contract:
 *  - When `activeFileFs` matches the deny list, the result MUST omit
 *    `active_file`, `selection`, `recent_diff`, `file_content`, and
 *    `file_excerpt`. Diagnostics, recent terminal, and the user
 *    question still flow — those don't leak file content.
 *  - When there is no target at all, `active_file` is `null` and the
 *    file-content fields are absent (preserves the pre-16.4 shape).
 */
export function buildTriggerPayload(input: PayloadInputs): SafePayload {
  const denied =
    input.activeFileFs !== null && isDeniedFile(input.activeFileFs);

  const payload: SafePayload = {
    active_file: denied ? null : input.activeFileRel,
    selection: denied ? null : input.selection,
    diagnostics: input.diagnostics,
    recent_terminal: input.recentTerminal,
    user_question: input.userQuestion,
    reason: input.reason,
  };

  if (input.activeFileFs !== null && !denied) {
    payload.recent_diff = makeMiniDiff(
      input.prevFileText,
      input.fileText,
      input.maxDiffLines
    );
    const lines = input.fileText.split("\n");
    if (lines.length <= 300 && input.fileText.length <= 12_000) {
      payload.file_content = input.fileText;
    } else {
      const start = Math.max(0, input.cursorLine - 40);
      const end = Math.min(lines.length, input.cursorLine + 40);
      payload.file_excerpt = {
        start_line: start,
        end_line: end,
        text: lines.slice(start, end).join("\n"),
      };
    }
  } else if (denied) {
    // Surface the drop to operators inspecting payloads. `secret_warning`
    // is the existing channel for "we redacted something"; this reuses
    // it so consumers don't need a new field.
    payload.secret_warning =
      "Active file is on the deny list (.env, *.pem, etc); file content / diff dropped.";
  }

  return payload;
}
