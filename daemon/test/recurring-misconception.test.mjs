// Task 5.3: end-to-end behavioural assertion that triggering the same
// anti-pattern 3 times across separate Session.handleTrigger calls causes
// the next learner-profile distill to receive count >= 3 for that pattern.
//
// The Haiku distill prompt itself instructs the model to emit a
// "## Recurring misconceptions" section (see daemon/src/anthropic.ts
// distillLearnerProfile system prompt). We can't deterministically assert
// the model's output without a real API key, so this test pins down the
// input contract: when the user repeats the same antipattern, the call to
// distillLearnerProfile sees the accumulated count and the serialized
// "count=N" line is present in the user message the AnthropicClient would
// build.
//
// Run: node --test daemon/test/recurring-misconception.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

const prompts = new Map([["tutor", "fake tutor system prompt"]]);

function freshSession(fake) {
  const dir = mkdtempSync(join(tmpdir(), "buddy-5.3-"));
  const memory = new MemoryStore(dir);
  const session = new Session(fake, prompts, { memory });
  return {
    session,
    memory,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function fireMisconception(session, pattern, sample) {
  await session.handleTrigger("MISCONCEPTION", {
    active_file: "src/foo.ts",
    reason: `anti-pattern: ${pattern}`,
    sample,
  });
}

test("5.3 3 hits of the same pattern produce count=3 in the next distill", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["chat", "chat", "chat"],
    replies: [
      { mode: "chat", text: "noticed once", wants_followup: false },
      { mode: "chat", text: "noticed twice", wants_followup: false },
      { mode: "chat", text: "noticed thrice", wants_followup: false },
    ],
    profile: "(distilled)",
  });
  const { session, memory, cleanup } = freshSession(fake);
  try {
    await fireMisconception(session, "ts-as-any", "as any cast on line 12");
    await fireMisconception(session, "ts-as-any", "as any cast on line 27");
    await fireMisconception(session, "ts-as-any", "as any cast on line 41");

    // Sanity: store reflects the 3 hits before the distill runs.
    assert.equal(memory.getMisconceptions()["ts-as-any"].count, 3);

    await session.forceDistillProfile();

    assert.equal(fake.calls.distillLearnerProfile.length, 1);
    const call = fake.calls.distillLearnerProfile[0];
    assert.ok(call.misconceptions["ts-as-any"], "ts-as-any must be in the map");
    assert.ok(
      call.misconceptions["ts-as-any"].count >= 3,
      `expected count >= 3, got ${call.misconceptions["ts-as-any"].count}`
    );
    // Earliest sample preserved (matches 5.2 (b))
    assert.equal(
      call.misconceptions["ts-as-any"].sample.includes("line 12"),
      true,
      "first sample (line 12) must be preserved"
    );
  } finally {
    cleanup();
  }
});

test("5.3 only the recurring pattern accumulates; a one-off stays at count 1", async () => {
  const fake = new FakeAnthropicClient({
    decisions: ["chat", "chat", "chat", "chat"],
    replies: [
      { mode: "chat", text: "r1", wants_followup: false },
      { mode: "chat", text: "r2", wants_followup: false },
      { mode: "chat", text: "r3", wants_followup: false },
      { mode: "chat", text: "r4", wants_followup: false },
    ],
  });
  const { session, cleanup } = freshSession(fake);
  try {
    await fireMisconception(session, "ts-as-any");
    await fireMisconception(session, "ts-as-any");
    await fireMisconception(session, "ts-as-any");
    await fireMisconception(session, "py-bare-except");

    await session.forceDistillProfile();

    const map = fake.calls.distillLearnerProfile[0].misconceptions;
    assert.equal(map["ts-as-any"].count, 3);
    assert.equal(map["py-bare-except"].count, 1);
  } finally {
    cleanup();
  }
});

test("5.3 AnthropicClient.distillLearnerProfile serializes count=N in the user message", async () => {
  // Verifies the production AnthropicClient passes the count into the
  // model prompt — the actual rendering step the FakeAnthropicClient
  // doesn't exercise. We stub the SDK at the constructor level by
  // monkey-patching the client's internal messages.create.
  const { AnthropicClient } = await import("../dist/anthropic.js");
  const captured = [];
  const stubResponse = {
    content: [{ type: "text", text: "(distilled by stub)" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const client = new AnthropicClient("fake-key", "claude-sonnet-4-6");
  // @ts-ignore — replace the SDK's messages.create with a recorder
  client.client.messages.create = async (req) => {
    captured.push(req);
    return stubResponse;
  };

  await client.distillLearnerProfile(
    "(history)",
    "(prior profile)",
    {
      "ts-as-any": { count: 3, last_seen: 1700000000000, sample: "x as any" },
      "py-bare-except": { count: 2, last_seen: 1700000000000 },
    }
  );

  assert.equal(captured.length, 1);
  const userMsg = captured[0].messages[0].content;
  assert.match(userMsg, /ts-as-any: count=3/);
  assert.match(userMsg, /py-bare-except: count=2/);
  assert.match(userMsg, /Detected anti-patterns/);
});
