// Task 16.4: deny-list guard for trigger payload assembly.
// Run: node --test extension/test/payload.test.mjs
//
// Contract: when the active/target file matches `isDeniedFile`,
// the payload sent to the daemon MUST omit `active_file`,
// `selection`, `recent_diff`, `file_content`, and `file_excerpt`.
// Diagnostics, recent_terminal, user_question, and reason still flow.

import test from "node:test";
import assert from "node:assert/strict";

const { buildTriggerPayload } = await import("../out/payload.js");

const baseInput = {
  activeFileRel: "src/index.ts",
  activeFileFs: "/repo/src/index.ts",
  selection: { line: 10, text: "console.log('hi');" },
  diagnostics: [],
  fileKey: "file:///repo/src/index.ts",
  fileText: "line 1\nline 2\nline 3",
  prevFileText: "line 1\nline 2\nline 3",
  cursorLine: 0,
  maxDiffLines: 50,
  recentTerminal: [],
  userQuestion: "what's wrong here?",
  reason: "sidebar input",
};

// --------------------------------------------------------------------------
// Non-denied (baseline) — file content + active_file flow through.
// --------------------------------------------------------------------------

test("non-denied path keeps active_file, selection, file_content", () => {
  const payload = buildTriggerPayload(baseInput);
  assert.equal(payload.active_file, "src/index.ts");
  assert.deepEqual(payload.selection, {
    line: 10,
    text: "console.log('hi');",
  });
  assert.equal(payload.file_content, "line 1\nline 2\nline 3");
  assert.equal(payload.user_question, "what's wrong here?");
  assert.equal(payload.reason, "sidebar input");
  assert.equal(payload.secret_warning, undefined);
});

test("non-denied path falls back to file_excerpt for large files", () => {
  const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const payload = buildTriggerPayload({
    ...baseInput,
    fileText: big,
    prevFileText: big,
    cursorLine: 200,
  });
  assert.equal(payload.file_content, undefined);
  assert.ok(
    typeof payload.file_excerpt === "object" && payload.file_excerpt !== null,
    "file_excerpt object present"
  );
  assert.equal(payload.file_excerpt.start_line, 160);
  assert.equal(payload.file_excerpt.end_line, 240);
});

// --------------------------------------------------------------------------
// Denied — drop file content, drop active_file, drop selection.
// --------------------------------------------------------------------------

test("denied .env drops active_file, selection, file_content", () => {
  const payload = buildTriggerPayload({
    ...baseInput,
    activeFileRel: ".env",
    activeFileFs: "/repo/.env",
    fileText: "DB_URL=postgres://user:hunter2@db.example.com/prod\nAPI_KEY=plain",
    prevFileText: "",
  });
  assert.equal(payload.active_file, null, "active_file dropped");
  assert.equal(payload.selection, null, "selection dropped");
  assert.equal(payload.file_content, undefined, "file_content omitted");
  assert.equal(payload.file_excerpt, undefined, "file_excerpt omitted");
  assert.equal(payload.recent_diff, undefined, "recent_diff omitted");
  assert.match(
    String(payload.secret_warning ?? ""),
    /deny list/i,
    "secret_warning explains the drop"
  );
  // Non-file fields still present.
  assert.equal(payload.user_question, "what's wrong here?");
  assert.equal(payload.reason, "sidebar input");
});

test("denied .env.production also drops file fields", () => {
  const payload = buildTriggerPayload({
    ...baseInput,
    activeFileRel: ".env.production",
    activeFileFs: "/repo/.env.production",
  });
  assert.equal(payload.active_file, null);
  assert.equal(payload.file_content, undefined);
});

test("denied id_rsa drops file fields", () => {
  const payload = buildTriggerPayload({
    ...baseInput,
    activeFileRel: ".ssh/id_rsa",
    activeFileFs: "/home/user/.ssh/id_rsa",
    fileText:
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt...\n-----END OPENSSH PRIVATE KEY-----",
  });
  assert.equal(payload.active_file, null);
  assert.equal(payload.file_content, undefined);
  // Make sure the PEM body never appears in any payload field.
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("BEGIN OPENSSH"), false);
});

test("denied *.pem drops file fields", () => {
  const payload = buildTriggerPayload({
    ...baseInput,
    activeFileRel: "certs/server.pem",
    activeFileFs: "/etc/ssl/certs/server.pem",
  });
  assert.equal(payload.active_file, null);
  assert.equal(payload.file_content, undefined);
});

test("denied secrets/ path drops file fields", () => {
  const payload = buildTriggerPayload({
    ...baseInput,
    activeFileRel: "secrets/db.json",
    activeFileFs: "/repo/secrets/db.json",
    fileText: '{"password": "hunter2"}',
  });
  assert.equal(payload.active_file, null);
  assert.equal(payload.file_content, undefined);
  assert.equal(JSON.stringify(payload).includes("hunter2"), false);
});

// --------------------------------------------------------------------------
// Edge: no target at all (sidebar ask with no editor open).
// --------------------------------------------------------------------------

test("no target file → active_file null and no file_* fields", () => {
  const payload = buildTriggerPayload({
    ...baseInput,
    activeFileRel: null,
    activeFileFs: null,
    selection: null,
    fileKey: null,
    fileText: "",
    prevFileText: "",
  });
  assert.equal(payload.active_file, null);
  assert.equal(payload.selection, null);
  assert.equal(payload.file_content, undefined);
  assert.equal(payload.recent_diff, undefined);
  // No deny-list warning either — there's no file to deny.
  assert.equal(payload.secret_warning, undefined);
});

// --------------------------------------------------------------------------
// Diagnostics + recent_terminal + non-file fields always present.
// --------------------------------------------------------------------------

test("diagnostics flow regardless of deny status", () => {
  const diags = [
    { severity: "Error", message: "expected ;", line: 17 },
    { severity: "Warning", message: "unused var", line: 22 },
  ];
  const denied = buildTriggerPayload({
    ...baseInput,
    activeFileRel: ".env",
    activeFileFs: "/repo/.env",
    diagnostics: diags,
  });
  assert.deepEqual(denied.diagnostics, diags);
  const allowed = buildTriggerPayload({ ...baseInput, diagnostics: diags });
  assert.deepEqual(allowed.diagnostics, diags);
});
