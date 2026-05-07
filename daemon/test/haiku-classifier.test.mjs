// Task 16.1.1: AnthropicHaikuClassifier tests.
//
// Spec headline (TASKS.md 16.1.1): "round-trip a fixture turn against
// a stub Haiku that returns `{escalate: false, text: "ok"}`; assert
// Sonnet is never invoked and the router-yielded text is exactly
// "ok"."
//
// Coverage layered top-to-bottom:
//   (a)–(c) parseVerdict() pure-function tests, deterministic
//   (d)     classifier.classify() with a fake Anthropic messages
//           client — no network
//   (e)     SPEC HEADLINE — wired through TieredRouter end-to-end:
//           classifier returns {escalate:false,text:"ok"}, the
//           router yields "ok" and never calls the (would-be) Sonnet
//   (f)     classifier failure → escalate (safe fallback)
//   (g)     classifier records its call to Telemetry
//
// Run: node --test daemon/test/haiku-classifier.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { AnthropicHaikuClassifier, parseVerdict } = await import(
  "../dist/haiku-classifier.js"
);
const { TieredRouter } = await import("../dist/tiered-router.js");
const { Telemetry } = await import("../dist/telemetry.js");

/** Build a fake Anthropic-shaped `messages` client that returns the
 *  given raw text as a content_block. Captures every request. */
function makeFakeClient({ replyText, throws }) {
  const calls = [];
  return {
    messages: {
      async create(req) {
        calls.push(req);
        if (throws) throw new Error(throws);
        return {
          content: [{ type: "text", text: replyText }],
          usage: { input_tokens: 100, output_tokens: 25 },
        };
      },
    },
    calls,
  };
}

test("16.1.1 (a) parseVerdict accepts a clean escalate:false reply", () => {
  const v = parseVerdict('{"escalate": false, "text": "hello there"}');
  assert.deepEqual(v, { escalate: false, text: "hello there" });
});

test("16.1.1 (b) parseVerdict accepts an escalate:true reply (no text required)", () => {
  assert.deepEqual(parseVerdict('{"escalate": true}'), { escalate: true });
  // text is allowed but ignored when escalate=true
  assert.deepEqual(parseVerdict('{"escalate": true, "text": "ignored"}'), {
    escalate: true,
  });
});

test("16.1.1 (c) parseVerdict defaults to escalate on every malformed shape", () => {
  // empty
  assert.deepEqual(parseVerdict(""), { escalate: true });
  // no JSON
  assert.deepEqual(parseVerdict("just words"), { escalate: true });
  // invalid JSON
  assert.deepEqual(parseVerdict("{escalate: true,}"), { escalate: true });
  // missing field
  assert.deepEqual(parseVerdict("{}"), { escalate: true });
  // wrong type
  assert.deepEqual(parseVerdict('{"escalate": "false"}'), { escalate: true });
  // escalate:false but missing/empty text → escalate (don't yield empty)
  assert.deepEqual(parseVerdict('{"escalate": false}'), { escalate: true });
  assert.deepEqual(parseVerdict('{"escalate": false, "text": ""}'), {
    escalate: true,
  });
  assert.deepEqual(parseVerdict('{"escalate": false, "text": "   "}'), {
    escalate: true,
  });
});

test("16.1.1 (d) classify() round-trips request + response shape", async () => {
  const fake = makeFakeClient({
    replyText: '{"escalate": false, "text": "use a Set."}',
  });
  const classifier = new AnthropicHaikuClassifier({
    client: fake,
    log: () => {},
  });
  const verdict = await classifier.classify(
    { user_question: "how do I dedupe?" },
    ["TUTOR-PROMPT", "DRY-OVERLAY"]
  );
  assert.deepEqual(verdict, { escalate: false, text: "use a Set." });
  assert.equal(fake.calls.length, 1);
  // System blocks come AFTER the router prompt, in order, with cache_control.
  const sys = fake.calls[0].system;
  assert.equal(sys[0].type, "text");
  assert.match(sys[0].text, /routing gate/i);
  assert.equal(sys[1].text, "TUTOR-PROMPT");
  assert.equal(sys[1].cache_control.type, "ephemeral");
  assert.equal(sys[2].text, "DRY-OVERLAY");
  // The user-turn payload is JSON-stringified.
  assert.equal(
    fake.calls[0].messages[0].content,
    JSON.stringify({ user_question: "how do I dedupe?" })
  );
});

test("16.1.1 (e) SPEC HEADLINE: router yields Haiku's text and Sonnet is never invoked", async () => {
  // Stub Haiku returning the exact verdict the spec calls for.
  const fakeHaikuClient = makeFakeClient({
    replyText: '{"escalate": false, "text": "ok"}',
  });
  const haiku = new AnthropicHaikuClassifier({
    client: fakeHaikuClient,
    log: () => {},
  });

  // A Sonnet that explodes if reached — proves the router never
  // calls it. (askStream is the only method TieredRouter uses.)
  const sonnet = {
    async *askStream() {
      throw new Error("Sonnet must NOT be invoked when Haiku handled the turn");
    },
  };
  const router = new TieredRouter({
    haiku,
    sonnet,
    log: () => {},
  });

  // Use a payload that won't trip any upfront-escalation rule:
  // - trigger NOT in {EXPLICIT_ASK, BAD_PATH, MISCONCEPTION}
  // - small transcript
  // - no editor context drift (this is the first call)
  const chunks = [];
  for await (const chunk of router.route(
    ["sys"],
    { trigger: "NEW_TOPIC", user_question: "explain recursion" }
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, ["ok"]);
  const outcome = router.getLastOutcome();
  assert.equal(outcome?.tier, "haiku");
});

test("16.1.1 (f) classifier failure (network / SDK throw) defaults to escalate", async () => {
  const fake = makeFakeClient({ throws: "ECONNREFUSED" });
  const classifier = new AnthropicHaikuClassifier({
    client: fake,
    log: () => {},
  });
  const verdict = await classifier.classify({}, ["sys"]);
  assert.deepEqual(verdict, { escalate: true });
});

test("16.1.1 (g) classifier records its Haiku call to Telemetry", async () => {
  const fake = makeFakeClient({
    replyText: '{"escalate": true}',
  });
  const recorded = [];
  const telemetry = {
    record(method, model, usage) {
      recorded.push({ method, model, usage });
    },
  };
  const classifier = new AnthropicHaikuClassifier({
    client: fake,
    telemetry,
    log: () => {},
  });
  await classifier.classify({}, ["sys"]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].method, "classify");
  assert.match(recorded[0].model, /haiku/);
  assert.deepEqual(recorded[0].usage, {
    input_tokens: 100,
    output_tokens: 25,
  });
});

test("16.1.1 (h) constructor throws when neither apiKey nor test client is provided", () => {
  assert.throws(
    () => new AnthropicHaikuClassifier({}),
    /requires either apiKey or a test client/
  );
});
