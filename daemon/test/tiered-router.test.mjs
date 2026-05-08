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

test("16.19 (b) very large recent_diff: identical across turns does NOT escalate", async () => {
  // Regression: fingerprint hashes long diffs to bound memory. The
  // hash branch must still treat byte-identical diffs as equal so a
  // long-running edit session that holds the same diff string between
  // turns doesn't pay the (b) escalation tax on every turn.
  const { haiku, sonnet, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "ok" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  const bigDiff = "x".repeat(10_000); // > 4 KiB threshold
  const ctx = { active_file: "a.ts", recent_diff: bigDiff };
  await collect(router.route(["sys"], { ...ctx }));
  await collect(router.route(["sys"], { ...ctx }));
  await collect(router.route(["sys"], { ...ctx }));

  assert.equal(sonnetCalls.length, 0, "identical hashed diff across turns: never escalate");
});

test("16.19 (b) very large recent_diff: a single-byte change still flips the fingerprint", async () => {
  // The whole point of the hash branch: a tiny tweak inside a 50KB
  // diff must still flip the digest and trigger (b). A naive bound
  // (e.g. truncate-to-first-N-bytes) would lose this property.
  const { haiku, sonnet, sonnetCalls } = makeStubs({
    haikuVerdict: { escalate: false, text: "ok" },
  });
  const router = new TieredRouter({ haiku, sonnet });

  const base = "x".repeat(50_000);
  await collect(router.route(["sys"], { active_file: "a.ts", recent_diff: base }));
  assert.equal(sonnetCalls.length, 0, "first turn must not escalate on (b)");

  // Flip exactly one byte, well past the truncation point a naive
  // implementation would use.
  const tweaked = base.slice(0, 30_000) + "y" + base.slice(30_001);
  await collect(router.route(["sys"], { active_file: "a.ts", recent_diff: tweaked }));
  assert.equal(sonnetCalls.length, 1, "single-byte change inside a long diff must escalate");
  assert.equal(router.getLastOutcome()?.reason, "editor_context_changed");
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

test("16.15 aborted Sonnet stream does NOT advance the editor fingerprint — next turn still escalates on context change", async () => {
  // Setup: turn 1 establishes a fingerprint via a clean Haiku turn.
  // Turn 2 escalates on (b) because editor changed, but the Sonnet
  // stream throws between yields (simulates barge-in/abort/network).
  // Turn 3 carries the same payload as turn 2; with the bug, the
  // fingerprint would have been updated in turn 2's `finally` and
  // turn 3 would NOT re-escalate. With the fix, the user gets their
  // answer the second time around.
  const haikuCalls = [];
  const sonnetCalls = [];
  const haiku = {
    async classify(payload, systemBlocks) {
      haikuCalls.push({ payload, systemBlocks });
      return { escalate: false, text: "haiku-ok" };
    },
  };
  const sonnet = {
    askStream(systemBlocks, payload, signal) {
      sonnetCalls.push({ systemBlocks, payload, signal });
      const callIndex = sonnetCalls.length;
      return (async function* () {
        yield "partial-";
        if (callIndex === 1) {
          // First Sonnet invocation throws mid-stream (the "aborted
          // between yields" case the task description names).
          throw new Error("aborted by barge-in");
        }
        yield "complete";
      })();
    },
  };
  const router = new TieredRouter({ haiku, sonnet });

  // Turn 1: clean Haiku turn, fingerprint = ("a.ts", diff="v1").
  await collect(router.route(["sys"], { active_file: "a.ts", recent_diff: "v1" }));
  assert.equal(haikuCalls.length, 1);
  assert.equal(sonnetCalls.length, 0);

  // Turn 2: editor changed — escalates upfront, then mid-stream throw.
  let threw = false;
  try {
    await collect(
      router.route(["sys"], { active_file: "b.ts", recent_diff: "v2" })
    );
  } catch (err) {
    threw = true;
    assert.match(String(err), /aborted by barge-in/);
  }
  assert.equal(threw, true, "turn 2 must surface the inner throw");
  assert.equal(sonnetCalls.length, 1, "sonnet attempted once on turn 2");

  // Turn 3: same context as turn 2. The bug would skip escalation
  // here because the finally-block in route() had advanced the
  // fingerprint to ("b.ts", "v2") even though the answer never landed.
  // With the fix, fingerprint is still ("a.ts", "v1") so (b) fires.
  await collect(
    router.route(["sys"], { active_file: "b.ts", recent_diff: "v2" })
  );
  assert.equal(
    sonnetCalls.length,
    2,
    "turn 3 must re-escalate to sonnet on the same drifted context"
  );
  assert.equal(
    router.getLastOutcome()?.reason,
    "editor_context_changed",
    "turn 3 escalation reason must still be (b) editor_context_changed"
  );
});

test("16.15 aborted Sonnet stream after Haiku flag does NOT advance fingerprint either", async () => {
  // Same defect surface for the haiku_flagged_escalate path.
  const sonnetCalls = [];
  const haiku = {
    async classify() {
      return { escalate: true };
    },
  };
  const sonnet = {
    askStream() {
      sonnetCalls.push({});
      const callIndex = sonnetCalls.length;
      return (async function* () {
        if (callIndex === 1) throw new Error("aborted");
        yield "ok";
      })();
    },
  };
  const router = new TieredRouter({ haiku, sonnet });

  // Turn 1: establish fingerprint via a separate non-throwing path.
  // Easiest: use a Haiku-no-escalate stub for one turn, then swap in
  // the throwing Haiku-escalate stub. We'll just call route() once
  // with a different haiku object via direct construction.
  const setupRouter = new TieredRouter({
    haiku: { async classify() { return { escalate: false, text: "ok" }; } },
    sonnet,
  });
  await collect(
    setupRouter.route(["sys"], { active_file: "a.ts", recent_diff: "v1" })
  );

  // Now exercise the real router for turn 2 (throw) + turn 3 (retry).
  let threw = false;
  try {
    await collect(
      router.route(["sys"], { active_file: "a.ts", recent_diff: "v1" })
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true);

  // Same context retry: even though the haiku-flagged path doesn't
  // depend on (b), the fingerprint advance was the bug, and we still
  // expect route() to attempt sonnet again rather than skip.
  await collect(
    router.route(["sys"], { active_file: "a.ts", recent_diff: "v1" })
  );
  assert.equal(sonnetCalls.length, 2, "both turns of the throwing router invoked sonnet");
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
