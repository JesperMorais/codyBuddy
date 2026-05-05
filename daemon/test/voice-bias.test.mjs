// Verify prompts now choose mode=speak for short proactive triggers.
// Run: node daemon/test/voice-bias.test.mjs

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { AnthropicClient } = await import("../dist/anthropic.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("ANTHROPIC_API_KEY missing"); process.exit(1); }

const promptsDir = resolve(__dirname, "../prompts");
const prompts = new Map();
for (const f of readdirSync(promptsDir)) {
  if (f.endsWith(".md")) prompts.set(basename(f, ".md"), readFileSync(resolve(promptsDir, f), "utf8"));
}

const client = new AnthropicClient(apiKey, "claude-sonnet-4-6");

const stuckPayload = {
  active_file: "hello.c",
  selection: { line: 17, text: '    scanf("%d", &numberOfChar)' },
  diagnostics: [
    { severity: "Error", message: "expected ';' before 'int'", line: 17 },
    { severity: "Error", message: "expected expression", line: 18 },
  ],
  recent_diff: "",
  recent_terminal: [],
  user_question: null,
  reason: "stuck on 2 errors for 95s",
  recent_chat: [],
};

const explicitPayload = {
  ...stuckPayload,
  user_question: "what is malloc?",
  reason: "Ctrl+Alt+Q",
};

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  → " + detail : ""}`);
  ok ? pass++ : fail++;
};

const tmpdir1 = mkdtempSync(join(tmpdir(), "buddy-bias-"));
try {
  for (const mode of ["tutor", "architect", "explainer", "reviewer"]) {
    const memory = new MemoryStore(join(tmpdir1, mode));
    const session = new Session(client, prompts, { defaultMode: mode, memory });
    const stuck = await session.handleTrigger("STUCK_LOOP", stuckPayload);
    check(`${mode} STUCK_LOOP picks speak`, stuck.mode === "speak", `mode=${stuck.mode} text="${stuck.text.slice(0, 80)}"`);

    const explicit = await session.handleTrigger("EXPLICIT_ASK", explicitPayload);
    check(
      `${mode} EXPLICIT_ASK speak text has no line-numbers`,
      explicit.mode !== "speak" || !/line\s*\d|line\s+\d/i.test(explicit.text),
      `mode=${explicit.mode} text="${explicit.text.slice(0, 80)}"`
    );
  }
  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  rmSync(tmpdir1, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
