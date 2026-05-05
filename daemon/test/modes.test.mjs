// Test each mode against an EXPLICIT_ASK trigger.
// Run: BUDDY_DEBUG_RAW=true node daemon/test/modes.test.mjs

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { AnthropicClient } = await import("../dist/anthropic.js");
const { Session } = await import("../dist/session.js");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY missing");
  process.exit(1);
}

const promptsDir = resolve(__dirname, "../prompts");
const prompts = new Map();
for (const f of readdirSync(promptsDir)) {
  if (!f.endsWith(".md")) continue;
  prompts.set(basename(f, ".md"), readFileSync(resolve(promptsDir, f), "utf8"));
}

const client = new AnthropicClient(apiKey, "claude-sonnet-4-6");

const samplePayload = {
  active_file: "hello.c",
  selection: { line: 30, text: '    scanf("%s", userinput);' },
  diagnostics: [],
  recent_diff: "",
  recent_terminal: [],
  user_question: "should I extract a randomString function?",
  reason: "Ctrl+Alt+Q",
  file_content: `#include <stdio.h>
#include <stdlib.h>
int main() {
  int n;
  scanf("%d", &n);
  char* captha = malloc(n);
  for (int i = 0; i < n; i++) captha[i] = ('a' + (rand() % 26));
  captha[n] = '\\0';
  printf("%s\\n", captha);
  char* userinput;
  scanf("%s", userinput);
  free(captha);
  return 0;
}`,
};

for (const mode of ["tutor", "architect", "explainer", "reviewer"]) {
  console.log(`\n=== mode=${mode} ===`);
  const session = new Session(client, prompts, { defaultMode: mode });
  const reply = await session.handleTrigger("EXPLICIT_ASK", samplePayload);
  console.log(`  parsed → mode=${reply.mode} text="${reply.text.slice(0, 200)}${reply.text.length > 200 ? "..." : ""}"`);
}
