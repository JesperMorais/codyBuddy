// Task 11.4: two-tier router tests.
//
// Pinned contract (per the TASKS.md spec):
//   - Haiku returns escalate:false → only Haiku is used; Sonnet is
//     never invoked.
//   - Each escalation condition (a/b/c/d) on its own → Sonnet is
//     invoked exactly once.
//
// Run: node --test daemon/test/tiered-router.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { TieredRouter } = await import("../dist/tiered-router.js");

function makeStubs(opts = {}) {
  const haikuCalls = [];
  const sonnetCalls = [];
  const haiku = {
    async classify(payload, systemBlocks) {
      haikuCalls.push({ payload, systemBlocks });
      return opts.haikuVerdict ?? { escalate: false, text: "haiku-reply" };
    },
  };
  const sonnet = {
    askStream(systemBlocks, payload, signal) {
      sonnetCalls.push({ systemBlocks, payload, signal });
      return (async function* () {
        yield "sonnet-";
        yield "reply";
      })();
    },
  };
  return { haiku, sonnet, haikuCalls, sonnetCalls };
}

async function collect(iter) {
  const out = [];
  for await (const c of iter) out.push(c);
  return out;
}

test("11.4 Haiku says escalate:false → router yields Haiku reply, Sonnet never called", async () => {
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "yeah, makes sense" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  const out = await collect(router.route(["sys"], { user_question: "ok?" }));

  assert.deepEqual(out, ["yeah, makes sense"]);
  assert.equal(haikuCalls.length, 1, "haiku consulted exactly once");
  assert.equal(sonnetCalls.length, 0, "sonnet must not be invoked");
  assert.deepEqual(router.getLastOutcome(), {
    tier: "haiku",
    reason: "no_escalation",
  });
});

test("11.4 (a) trigger=EXPLICIT_ASK forces Sonnet — Haiku skipped", async () => {
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs();
  const router = new TieredRouter({ haiku, sonnet });

  const out = await collect(
    router.route(["sys"], { trigger: "EXPLICIT_ASK", user_question: "explain this" })
  );

  assert.deepEqual(out, ["sonnet-", "reply"]);
  assert.equal(haikuCalls.length, 0, "haiku skipped on upfront escalation");
  assert.equal(sonnetCalls.length, 1, "sonnet invoked exactly once");
  assert.equal(router.getLastOutcome()?.tier, "sonnet");
  assert.equal(router.getLastOutcome()?.reason, "trigger=EXPLICIT_ASK");
});

test("11.4 (a) trigger=BAD_PATH forces Sonnet exactly once", async () => {
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs();
  const router = new TieredRouter({ haiku, sonnet });

  await collect(router.route(["sys"], { trigger: "BAD_PATH" }));

  assert.equal(haikuCalls.length, 0);
  assert.equal(sonnetCalls.length, 1);
  assert.equal(router.getLastOutcome()?.reason, "trigger=BAD_PATH");
});

test("11.4 (a) trigger=MISCONCEPTION forces Sonnet exactly once", async () => {
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs();
  const router = new TieredRouter({ haiku, sonnet });

  await collect(router.route(["sys"], { trigger: "MISCONCEPTION" }));

  assert.equal(haikuCalls.length, 0);
  assert.equal(sonnetCalls.length, 1);
  assert.equal(router.getLastOutcome()?.reason, "trigger=MISCONCEPTION");
});

test("11.4 (a) non-escalating trigger (e.g. STUCK_LOOP) does NOT force Sonnet", async () => {
  // STUCK_LOOP isn't in the escalation set — it's a soft nudge that
  // Haiku can usually handle. The spec deliberately excludes it.
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "still on the same diff?" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  await collect(router.route(["sys"], { trigger: "STUCK_LOOP" }));

  assert.equal(haikuCalls.length, 1);
  assert.equal(sonnetCalls.length, 0);
});

test("11.4 (b) editor context changed since last turn → Sonnet exactly once", async () => {
  const { haiku, sonnet, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "ok" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  // First turn: establishes the fingerprint. (b) cannot fire on
  // the very first call by design — there's nothing to compare to.
  await collect(router.route(["sys"], { active_file: "a.ts", recent_diff: "old" }));
  assert.equal(sonnetCalls.length, 0, "first turn must not escalate on (b)");

  // Second turn: same shape, different file → fingerprint flips →
  // upfront escalation.
  await collect(router.route(["sys"], { active_file: "b.ts", recent_diff: "old" }));
  assert.equal(sonnetCalls.length, 1, "second turn with different editor must escalate");
  assert.equal(router.getLastOutcome()?.reason, "editor_context_changed");
});

test("11.4 (b) identical editor context across turns does NOT escalate", async () => {
  const { haiku, sonnet, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "ok" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  const ctx = { active_file: "a.ts", recent_diff: "same diff" };
  await collect(router.route(["sys"], { ...ctx }));
  await collect(router.route(["sys"], { ...ctx }));
  await collect(router.route(["sys"], { ...ctx }));

  assert.equal(sonnetCalls.length, 0, "identical editor context across N turns: never escalate");
});

test("11.4 (c) transcript over token threshold → Sonnet exactly once", async () => {
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs();
  const router = new TieredRouter({
    haiku,
    sonnet,
    // Use length as the estimator so the threshold is readable.
    transcriptTokenThreshold: 5,
    estimateTokens: (t) => t.length,
  });

  await collect(
    router.route(["sys"], {
      user_question: "1234567890", // length 10 > threshold 5
    })
  );

  assert.equal(haikuCalls.length, 0, "haiku skipped on upfront escalation");
  assert.equal(sonnetCalls.length, 1);
  assert.equal(router.getLastOutcome()?.reason, "transcript_token_threshold");
});

test("11.4 (c) transcript under threshold does NOT escalate", async () => {
  const { haiku, sonnet, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "ok" },
  });
  const router = new TieredRouter({
    haiku,
    sonnet,
    transcriptTokenThreshold: 100,
    estimateTokens: (t) => t.length,
  });

  await collect(router.route(["sys"], { user_question: "short" }));

  assert.equal(sonnetCalls.length, 0);
});

test("11.4 (d) Haiku flags escalate:true → Sonnet exactly once", async () => {
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: true },
  });
  const router = new TieredRouter({ haiku, sonnet });

  const out = await collect(router.route(["sys"], { user_question: "complex thing" }));

  assert.equal(haikuCalls.length, 1, "haiku must be consulted before escalating to sonnet");
  assert.equal(sonnetCalls.length, 1);
  assert.deepEqual(out, ["sonnet-", "reply"]);
  assert.equal(router.getLastOutcome()?.reason, "haiku_flagged_escalate");
});

test("11.4 shouldEscalateUpfront is pure and side-effect-free", () => {
  const { haiku, sonnet } = makeStubs();
  const router = new TieredRouter({ haiku, sonnet });

  assert.deepEqual(router.shouldEscalateUpfront({ trigger: "EXPLICIT_ASK" }), {
    escalate: true,
    reason: "trigger=EXPLICIT_ASK",
  });
  assert.deepEqual(router.shouldEscalateUpfront({ trigger: "BAD_PATH" }), {
    escalate: true,
    reason: "trigger=BAD_PATH",
  });
  assert.deepEqual(router.shouldEscalateUpfront({ trigger: "MISCONCEPTION" }), {
    escalate: true,
    reason: "trigger=MISCONCEPTION",
  });
  assert.deepEqual(router.shouldEscalateUpfront({ trigger: "STUCK_LOOP" }), {
    escalate: false,
    reason: "",
  });
  assert.deepEqual(router.shouldEscalateUpfront({}), { escalate: false, reason: "" });
});

test("11.4 AbortSignal threads through to Sonnet on escalation", async () => {
  const { haiku, sonnet, sonnetCalls } = makeStubs();
  const router = new TieredRouter({ haiku, sonnet });
  const ac = new AbortController();

  await collect(router.route(["sys"], { trigger: "EXPLICIT_ASK" }, ac.signal));

  assert.equal(sonnetCalls.length, 1);
  assert.equal(sonnetCalls[0].signal, ac.signal, "signal must be passed through unchanged");
});

test("11.4 router state survives across multiple turns without leak", async () => {
  // Mixed history: turn 1 haiku, turn 2 sonnet (trigger), turn 3 haiku.
  // Each turn's outcome should reflect the routing for THAT turn,
  // not be polluted by the previous one.
  const { haiku, sonnet, haikuCalls, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "ok" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  await collect(router.route(["sys"], { user_question: "first" }));
  assert.equal(router.getLastOutcome()?.tier, "haiku");

  await collect(router.route(["sys"], { trigger: "EXPLICIT_ASK", user_question: "second" }));
  assert.equal(router.getLastOutcome()?.tier, "sonnet");

  await collect(router.route(["sys"], { user_question: "third" }));
  assert.equal(router.getLastOutcome()?.tier, "haiku");

  assert.equal(haikuCalls.length, 2, "haiku consulted on turns 1 and 3");
  assert.equal(sonnetCalls.length, 1, "sonnet on turn 2 only");
});

test("11.4 asCompleteUtterance adapter shape matches ConversationLoop's completeUtterance", async () => {
  // The adapter lets the router slot directly into ConversationLoopDeps.
  const { TieredRouter, asCompleteUtterance } = await import("../dist/tiered-router.js");
  const { haiku, sonnet, sonnetCalls } = makeStubs();
  const router = new TieredRouter({ haiku, sonnet });
  const fn = asCompleteUtterance(router, () => ["sys-from-session"]);

  const ac = new AbortController();
  await collect(fn({ trigger: "EXPLICIT_ASK" }, ac.signal));

  assert.equal(sonnetCalls.length, 1);
  assert.deepEqual(sonnetCalls[0].systemBlocks, ["sys-from-session"]);
  assert.equal(sonnetCalls[0].signal, ac.signal);
});
