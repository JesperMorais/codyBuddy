// Task 15.4: demo-mode tests.
//
// Spec contract:
//   "With BUDDY_DEMO=true and no API key, three triggers produce
//    three different canned replies and audio plays via the
//    configured TTS backend."
//
// Coverage:
//   (a) DemoClient — rotation, shouldSpeak/summarize/distill
//       defaults, model label.
//   (b) DemoFallbackClient — promotes to real-only on first
//       success; falls back to demo on failure; auto-disable hook
//       fires exactly once.
//   (c) End-to-end through Session: three EXPLICIT_ASK triggers
//       produce three distinct canned replies, each with non-empty
//       text so the TTS bridge would speak them.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

const { DemoClient, CANNED_REPLIES } = await import(
  "../dist/demo-client.js"
);
const { DemoFallbackClient } = await import("../dist/demo-fallback.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { loadPromptDir, loadPersonalities } = await import(
  "../dist/personalities-loader.js"
);

// --- (a) DemoClient unit ----------------------------------------

test("15.4 (a) DemoClient ships at least 10 canned replies", () => {
  assert.ok(
    CANNED_REPLIES.length >= 10,
    `expected >=10 canned replies, got ${CANNED_REPLIES.length}`
  );
  for (const r of CANNED_REPLIES) {
    assert.ok(r.length > 0, "no empty canned replies");
  }
});

test("15.4 (a) DemoClient.ask rotates through replies", async () => {
  const client = new DemoClient();
  const got = [];
  for (let i = 0; i < CANNED_REPLIES.length + 2; i++) {
    const r = await client.ask([], "", {});
    got.push(r.text);
  }
  // First N are unique.
  const uniqueFirstPass = new Set(got.slice(0, CANNED_REPLIES.length));
  assert.equal(
    uniqueFirstPass.size,
    CANNED_REPLIES.length,
    "first N replies should be unique"
  );
  // After full cycle, the rotation wraps.
  assert.equal(got[CANNED_REPLIES.length], got[0]);
});

test("15.4 (a) DemoClient.ask returns mode=speak with non-empty text", async () => {
  const c = new DemoClient();
  const reply = await c.ask([], "", {});
  assert.equal(reply.mode, "speak");
  assert.ok(reply.text.length > 0);
  assert.equal(reply.wants_followup, false);
});

test("15.4 (a) DemoClient.shouldSpeak always says speak", async () => {
  const c = new DemoClient();
  assert.equal(await c.shouldSpeak({}, ""), "speak");
});

test("15.4 (a) DemoClient.askStream yields the rotating text", async () => {
  const c = new DemoClient({ replies: ["alpha", "beta", "gamma"] });
  const collected = [];
  for await (const chunk of c.askStream([], {})) collected.push(chunk);
  assert.deepEqual(collected, ["alpha"]);
  // Rotation also affects stream.
  const collected2 = [];
  for await (const chunk of c.askStream([], {})) collected2.push(chunk);
  assert.deepEqual(collected2, ["beta"]);
});

test("15.4 (a) DemoClient model label is 'demo' by default", () => {
  assert.equal(new DemoClient().modelName(), "demo");
  assert.equal(new DemoClient({ model: "demo-fast" }).modelName(), "demo-fast");
});

// --- (b) DemoFallbackClient -------------------------------------

class FakeReal {
  constructor({
    askResults = [], // sequence of: "ok", "throw", "empty"
  } = {}) {
    this.askResults = [...askResults];
    this.askCalls = 0;
    this.shouldSpeakCalls = 0;
  }
  async shouldSpeak() {
    this.shouldSpeakCalls += 1;
    return "speak";
  }
  async ask() {
    this.askCalls += 1;
    const next = this.askResults.shift() ?? "ok";
    if (next === "throw") throw new Error("simulated 401");
    if (next === "empty")
      return { mode: "no_op", text: "", wants_followup: false };
    return { mode: "speak", text: "real reply", wants_followup: false };
  }
  async *askStream() {
    yield "real reply";
  }
  async summarize() {
    return "real summary";
  }
  async distillLearnerProfile() {
    return "real profile";
  }
}

test("15.4 (b) DemoFallbackClient: real success disables demo permanently", async () => {
  const real = new FakeReal({ askResults: ["ok", "throw", "ok"] });
  const demo = new DemoClient();
  let disableCount = 0;
  const wrapper = new DemoFallbackClient({
    real,
    demo,
    onRealSuccess: () => {
      disableCount += 1;
    },
  });
  assert.equal(wrapper.isDemoActive(), true);

  const r1 = await wrapper.ask([], "", {});
  assert.equal(r1.text, "real reply", "first call hits real");
  assert.equal(wrapper.isDemoActive(), false);
  assert.equal(disableCount, 1);

  // After disable, even a thrown real call propagates — we no
  // longer fall back to demo.
  await assert.rejects(() => wrapper.ask([], "", {}), /simulated 401/);

  // Hook only fires once.
  await wrapper.ask([], "", {});
  assert.equal(disableCount, 1);
});

test("15.4 (b) DemoFallbackClient: real failure falls back to demo, demo stays active", async () => {
  const real = new FakeReal({ askResults: ["throw", "throw", "ok"] });
  const demo = new DemoClient();
  let disableCount = 0;
  const wrapper = new DemoFallbackClient({
    real,
    demo,
    onRealSuccess: () => {
      disableCount += 1;
    },
  });
  const r1 = await wrapper.ask([], "", {});
  assert.equal(wrapper.isDemoActive(), true, "demo still active after real fail");
  assert.notEqual(r1.text, "real reply");
  assert.equal(disableCount, 0);

  // Second turn — real still throwing, demo still active.
  const r2 = await wrapper.ask([], "", {});
  assert.equal(wrapper.isDemoActive(), true);
  assert.notEqual(r2.text, "real reply");
  // Demo rotated.
  assert.notEqual(r1.text, r2.text);

  // Third turn — real succeeds; demo finally disabled.
  const r3 = await wrapper.ask([], "", {});
  assert.equal(r3.text, "real reply");
  assert.equal(wrapper.isDemoActive(), false);
  assert.equal(disableCount, 1);
});

test("15.4 (b) Empty real reply (e.g. silent 401) keeps demo active for that turn", async () => {
  const real = new FakeReal({ askResults: ["empty", "ok"] });
  const demo = new DemoClient();
  const wrapper = new DemoFallbackClient({ real, demo });
  const r1 = await wrapper.ask([], "", {});
  assert.notEqual(r1.text, "", "demo replied with non-empty text");
  assert.equal(wrapper.isDemoActive(), true);
  // Next turn real returns ok → disables demo.
  const r2 = await wrapper.ask([], "", {});
  assert.equal(r2.text, "real reply");
  assert.equal(wrapper.isDemoActive(), false);
});

// --- (c) end-to-end through Session ----------------------------

test("15.4 (c) BUDDY_DEMO=true + no key: three triggers → three distinct canned replies", async () => {
  // Pinned spec test — "with BUDDY_DEMO=true and no API key, three
  // triggers produce three different canned replies and audio
  // plays via the configured TTS backend."
  const prompts = loadPromptDir(promptsDir);
  const { personalities } = loadPersonalities(promptsDir, "anthropic");
  const memDir = mkdtempSync(join(tmpdir(), "buddy-15.4-mem-"));
  const memory = new MemoryStore(memDir);
  const demo = new DemoClient();
  const session = new Session(demo, prompts, {
    personalities,
    defaultPersonality: "nice",
    memory,
  });

  const replies = [];
  for (let i = 0; i < 3; i++) {
    const r = await session.handleTrigger("EXPLICIT_ASK", {
      user_question: `q${i}`,
    });
    replies.push(r);
  }

  // All three speak (TTS would play them).
  for (const r of replies) {
    assert.equal(r.mode, "speak", `expected mode=speak, got ${r.mode}`);
    assert.ok(r.text.length > 0, "text non-empty");
  }
  // All three are distinct.
  const texts = new Set(replies.map((r) => r.text));
  assert.equal(texts.size, 3, `expected 3 distinct replies, got ${texts.size}`);
});
