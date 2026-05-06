// Task 10.9: payload-assembler tests.
//
// Spec headline: "assemble a payload from a fixture turn; assert
// redactor ran and editor context is present."
//
// We exercise the pure assembler with hand-built fixtures so the
// expected output is exact. The redactor canary uses real secret-
// shaped strings so a regression in the shared pattern list (the
// daemon copy of extension/src/redactor.ts patterns) shows up here.
//
// Run: node --test daemon/test/payload-assembler.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { assembleConversationPayload } = await import("../dist/payload-assembler.js");

test("10.9 (a) spec headline: fixture turn → editor context present and recent_diff scrubbed", () => {
  const out = assembleConversationPayload({
    conversationTranscript: [
      { role: "user", text: "what does this error mean?" },
    ],
    editorContext: {
      activeFile: "src/api.ts",
      diagnostics: [
        { severity: "error", message: "Type 'string' is not assignable to 'number'", line: 42 },
      ],
      // A real-shape secret in the diff content. The assembler must
      // scrub it before sending to the LLM.
      recentDiff:
        "+ const apiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaa';\n- const apiKey = 'old';\n",
    },
  });

  assert.equal(out.user_question, "what does this error mean?");
  assert.equal(out.active_file, "src/api.ts");
  assert.ok(out.recent_diff, "recent_diff must be present");
  assert.match(out.recent_diff, /<REDACTED-SECRET>/, "secret must be scrubbed");
  assert.ok(!/sk-ant-/.test(out.recent_diff), "raw secret must not survive");
  assert.equal(out.redaction.secret_hits, 1, "exactly one secret hit");
  assert.equal(out.redaction.active_file_denied, false);
  assert.deepEqual(out.diagnostics, [
    { severity: "error", message: "Type 'string' is not assignable to 'number'", line: 42 },
  ]);
});

test("10.9 (b) denied active file drops the entire editor block; conversation still flows", () => {
  const out = assembleConversationPayload({
    conversationTranscript: [{ role: "user", text: "what about this" }],
    editorContext: {
      activeFile: ".env.production",
      recentDiff: "+ ANTHROPIC_API_KEY=sk-...\n",
      diagnostics: [{ severity: "warning", message: "missing", line: 1 }],
    },
  });
  assert.equal(out.user_question, "what about this");
  assert.equal(out.redaction.active_file_denied, true);
  assert.equal(out.active_file, undefined);
  assert.equal(out.recent_diff, undefined);
  assert.equal(out.diagnostics, undefined);
  // Importantly the secret never even gets scrubbed — the whole field was dropped.
  assert.equal(out.redaction.secret_hits, 0);
});

test("10.9 (c) diagnostics messages are scrubbed individually", () => {
  const out = assembleConversationPayload({
    conversationTranscript: [{ role: "user", text: "?" }],
    editorContext: {
      activeFile: "src/handler.ts",
      diagnostics: [
        { severity: "error", message: "Unexpected token in 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'", line: 10 },
        { severity: "warning", message: "AKIAIOSFODNN7EXAMPLE looks unused", line: 12 },
      ],
    },
  });
  assert.equal(out.redaction.secret_hits, 2);
  for (const d of out.diagnostics) {
    assert.match(d.message, /<REDACTED-SECRET>/);
    assert.ok(!/sk-ant-/.test(d.message));
    assert.ok(!/AKIA/.test(d.message));
  }
});

test("10.9 (d) conversation transcript is preserved verbatim (NOT scrubbed)", () => {
  // The user's own spoken/typed words shouldn't be modified — if
  // they say "my key is sk-..." the LLM needs the real string to
  // answer. Matches the chat path's behaviour.
  const out = assembleConversationPayload({
    conversationTranscript: [
      { role: "user", text: "my key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaa is the issue" },
      { role: "assistant", text: "ok, let me check" },
    ],
  });
  assert.equal(out.recent_chat.length, 2);
  assert.match(out.recent_chat[0].text, /sk-ant-/, "transcript must NOT be scrubbed");
  assert.equal(out.user_question, "my key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaa is the issue");
});

test("10.9 (e) opportunity-only turn (no transcript) uses trigger.reason as user_question", () => {
  const out = assembleConversationPayload({
    conversationTranscript: [],
    recentTrigger: {
      trigger: "MISCONCEPTION",
      reason: "Mutating array while iterating",
      payload: { line: 42, file: "src/x.ts" },
    },
  });
  assert.equal(out.user_question, "Mutating array while iterating");
  assert.equal(out.trigger, "MISCONCEPTION");
  assert.equal(out.trigger_reason, "Mutating array while iterating");
  assert.deepEqual(out.trigger_payload, { line: 42, file: "src/x.ts" });
});

test("10.9 (f) empty everything still produces a non-empty user_question fallback", () => {
  const out = assembleConversationPayload({ conversationTranscript: [] });
  assert.ok(out.user_question.length > 0, "must always have a user_question");
  assert.deepEqual(out.recent_chat, []);
  assert.equal(out.active_file, undefined);
  assert.equal(out.recent_diff, undefined);
  assert.equal(out.diagnostics, undefined);
  assert.equal(out.trigger, undefined);
  assert.equal(out.redaction.secret_hits, 0);
  assert.equal(out.redaction.active_file_denied, false);
});

test("10.9 (g) maxTranscriptTurns limits recent_chat without losing user_question's source", () => {
  const turns = [];
  for (let i = 0; i < 20; i++) {
    turns.push({ role: i % 2 === 0 ? "user" : "assistant", text: `turn-${i}` });
  }
  const out = assembleConversationPayload({
    conversationTranscript: turns,
    maxTranscriptTurns: 4,
  });
  // Only the last 4 turns ride along.
  assert.equal(out.recent_chat.length, 4);
  assert.equal(out.recent_chat[0].text, "turn-16");
  assert.equal(out.recent_chat[3].text, "turn-19");
  // user_question is the LAST user turn (turn-18) regardless of the cap.
  assert.equal(out.user_question, "turn-18");
});

test("10.9 (h) editor context with all secret variants in the diff lands a high hit count", () => {
  const out = assembleConversationPayload({
    conversationTranscript: [{ role: "user", text: "what's wrong?" }],
    editorContext: {
      activeFile: "src/secrets-test.ts",
      recentDiff: [
        "+ const a = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaa';",
        "+ const b = 'AKIAIOSFODNN7EXAMPLE';",
        "+ const c = 'ASIAEXAMPLEEXAMPLEXX';",
        "+ const d = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
        "+ const e = 'xoxb-1234567890-abcdefghijkl';",
      ].join("\n"),
    },
  });
  // 5 secret patterns, one each.
  assert.equal(out.redaction.secret_hits, 5);
  for (const raw of ["sk-ant", "AKIA", "ASIA", "ghp_", "xoxb-"]) {
    assert.ok(!out.recent_diff.includes(raw), `raw '${raw}' must not survive`);
  }
});

test("10.9 (i) the daemon's redactor patterns match the extension's (drift canary)", async () => {
  // Both files re-implement the same regexes; this canary catches a
  // copy-paste drift before the next audio-path PR ships secrets.
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const a = readFileSync(resolve(repoRoot, "daemon/src/redactor.ts"), "utf8");
  const b = readFileSync(resolve(repoRoot, "extension/src/redactor.ts"), "utf8");

  // Extract the SECRET_REGEXES block from each and compare.
  function extractSecretRegexes(src) {
    const m = src.match(/const SECRET_REGEXES[^=]*=\s*\[([^\]]+)\]/);
    return m ? m[1].replace(/\s+/g, " ").trim() : null;
  }
  const aSecrets = extractSecretRegexes(a);
  const bSecrets = extractSecretRegexes(b);
  assert.ok(aSecrets, "daemon SECRET_REGEXES block missing");
  assert.ok(bSecrets, "extension SECRET_REGEXES block missing");
  assert.equal(aSecrets, bSecrets, "secret regexes must stay in sync between daemon and extension");

  function extractDeny(src) {
    const m = src.match(/const DENY_PATTERNS[^=]*=\s*\[([^\]]+)\]/);
    return m ? m[1].replace(/\s+/g, " ").trim() : null;
  }
  assert.equal(extractDeny(a), extractDeny(b), "deny patterns must stay in sync");
});
