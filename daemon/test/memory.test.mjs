// Memory module tests + an integration test of distillLearnerProfile.
// Run: node daemon/test/memory.test.mjs
//      (set BUDDY_TEST_DISTILL=true to also hit the API)

import "dotenv/config";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { MemoryStore } = await import("../dist/memory.js");

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  → " + detail : ""}`);
  ok ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "buddy-mem-"));

try {
  // 1. Empty store
  const m = new MemoryStore(dir);
  check("empty store: summary is empty", m.getSummary() === "");
  check("empty store: loadRecent returns []", JSON.stringify(m.loadRecent()) === "[]");
  check("empty store: shouldRefresh false", m.shouldRefresh(20) === false);

  // 2. Append events
  for (let i = 0; i < 5; i++) {
    m.append({
      ts: Date.now() + i,
      mode: "tutor",
      trigger: "EXPLICIT_ASK",
      file: `file${i}.c`,
      reply_text: `Reply number ${i}`,
    });
  }
  const recent = m.loadRecent();
  check("loadRecent reads back 5 events", recent.length === 5);
  check("loadRecent preserves text", recent[2].reply_text === "Reply number 2");
  check("loadRecent preserves file", recent[4].file === "file4.c");

  // 3. shouldRefresh thresholding
  check("after 5 events, shouldRefresh(10) false", m.shouldRefresh(10) === false);
  check("after 5 events, shouldRefresh(5) true", m.shouldRefresh(5) === true);

  // 4. setSummary persists across instances
  m.setSummary("- finds off-by-one bugs in C\n- forgets `+1` for null terminator");
  const m2 = new MemoryStore(dir);
  check("summary persists on disk", m2.getSummary().includes("off-by-one"));

  // 5. limit param respected
  for (let i = 0; i < 80; i++) {
    m2.append({ ts: Date.now() + i, mode: "tutor", trigger: "EXPLICIT_ASK", reply_text: `e${i}` });
  }
  const last20 = m2.loadRecent(20);
  check("loadRecent(20) returns last 20", last20.length === 20);
  check("loadRecent(20) tail is correct", last20[19].reply_text === "e79");

  // 6. paths()
  const p = m2.paths();
  check("paths.dir matches", p.dir === dir);
  check("paths.log exists", existsSync(p.log));
  check("paths.summary exists", existsSync(p.summary));

  // 7. Optional API test: distill summary from fake history
  if (process.env.BUDDY_TEST_DISTILL === "true" && process.env.ANTHROPIC_API_KEY) {
    console.log("\n--- distill test (hits API) ---");
    const { AnthropicClient } = await import("../dist/anthropic.js");
    const client = new AnthropicClient(process.env.ANTHROPIC_API_KEY, "claude-sonnet-4-6");
    const fakeHistory = [
      "[2026-05-03T10:00:00Z] tutor/EXPLICIT_ASK (cee/hello.c) Q: why is malloc(n) wrong?\n  → You wrote n+1 bytes (the null terminator) but only allocated n. Off-by-one buffer overflow.",
      "[2026-05-03T10:05:00Z] tutor/STUCK_LOOP (cee/hello.c)\n  → Look at line 30 — what does `userinput` point to before you scanf into it?",
      "[2026-05-03T10:30:00Z] tutor/EXPLICIT_ASK (cee/hello2.c) Q: I got the same overflow again, why?\n  → You're allocating exactly the string length without the +1 for the null terminator. Same pattern as last time.",
      "[2026-05-03T11:00:00Z] explainer/EXPLICIT_ASK Q: what does srand do?\n  → srand seeds the pseudo-random number generator used by rand(). Without it, rand() produces the same sequence every run.",
    ].join("\n");
    const profile = await client.distillLearnerProfile(fakeHistory, "");
    console.log(profile);
    check(
      "distill mentions the recurring +1/null-terminator misconception",
      /null|\+1|terminator|off-by-one/i.test(profile)
    );
    check("distill has Recurring misconceptions section", /Recurring misconceptions/.test(profile));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(fail === 0 ? 0 : 1);
