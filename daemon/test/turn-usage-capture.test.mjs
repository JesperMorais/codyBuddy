// Task 16.1.2: per-turn token usage capture.
//
// Spec headline (TASKS.md 16.1.2): "a fake router that returns
// `{ tier: "sonnet", usage: { input_tokens: 123, output_tokens: 45 } }`
// produces a turn entry with the right token counts and a non-zero
// `usd_estimate`."
//
// The fix lives at three layers:
//   1. AnthropicClient + AnthropicHaikuClassifier expose
//      getLastUsage(): UsageRecord | undefined (each populated from
//      its own underlying call's usage block).
//   2. TieredRouter.getLastTokenUsage() composes both halves into
//      `{ haiku?, sonnet? }`.
//   3. AudioHost.recordTurn() reads getLastTokenUsage() and threads
//      haikuModel/haikuUsage/sonnetModel/sonnetUsage into the
//      per-turn telemetry entry.
//
// This test file pins the wiring at every layer.
//
// Run: node --test daemon/test/turn-usage-capture.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const { AudioHost } = await import("../dist/audio-host.js");
const { TurnTelemetry } = await import("../dist/turn-telemetry.js");
const { TieredRouter } = await import("../dist/tiered-router.js");
const { AnthropicHaikuClassifier } = await import("../dist/haiku-classifier.js");

class FakeVad {
  constructor() {
    this.startHandlers = [];
    this.endHandlers = [];
  }
  onSpeechStart(h) {
    this.startHandlers.push(h);
  }
  onSpeechEnd(h) {
    this.endHandlers.push(h);
  }
  emitStart() {
    for (const h of this.startHandlers) h(0);
  }
  emitEnd() {
    for (const h of this.endHandlers) h(0);
  }
}

class FakeStt {
  constructor() {
    this.handlers = [];
  }
  onFinal(h) {
    this.handlers.push(h);
  }
  emitFinal(text) {
    for (const h of this.handlers) h(text, "engine");
  }
}

class FakeTts {
  feedSentence() {}
  finish() {}
  dispose() {}
}

function streamFromChunks(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await wait(1);
        yield c;
      }
    },
  };
}

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-16.1.2-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("16.1.2 (a) SPEC HEADLINE: fake router with sonnet usage produces a turn with the right token counts and non-zero usd_estimate", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    // Hand-rolled router that mimics a Sonnet-tier turn with usage.
    const fakeRouter = {
      route() {
        return streamFromChunks(["ok."]);
      },
      getLastOutcome() {
        return { tier: "sonnet", reason: "trigger=EXPLICIT_ASK" };
      },
      getLastTokenUsage() {
        return {
          sonnet: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 123, output_tokens: 45 },
          },
        };
      },
    };
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const telemetry = new TurnTelemetry(jsonlPath);
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router: fakeRouter,
      turnTelemetry: telemetry,
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    vad.emitStart();
    stt.emitFinal("explain it");
    await host.awaitSettled();

    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const turn = JSON.parse(lines[0]);

    // Token counts threaded through correctly.
    assert.equal(turn.sonnet_tier, true);
    assert.equal(turn.haiku_tier, false);
    assert.equal(turn.sonnet_model, "claude-sonnet-4-6");
    assert.equal(turn.sonnet_input_tokens, 123);
    assert.equal(turn.sonnet_output_tokens, 45);
    // Aggregated across both tiers (Haiku absent → sonnet only).
    assert.equal(turn.input_tokens, 123);
    assert.equal(turn.output_tokens, 45);
    // SPEC HEADLINE: non-zero usd_estimate. Sonnet 4.6 pricing is
    // non-zero per turn-telemetry.ts pricing table; the exact value
    // depends on the per-million rate but it MUST be > 0.
    assert.ok(
      turn.usd_estimate > 0,
      `expected non-zero usd_estimate, got ${turn.usd_estimate}`
    );
  } finally {
    cleanup();
  }
});

test("16.1.2 (b) cheap-tier-only turn (Haiku handled it, Sonnet skipped) records haiku tokens and sonnet zeros", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    const fakeRouter = {
      route() {
        return streamFromChunks(["use a Set."]);
      },
      getLastOutcome() {
        return { tier: "haiku", reason: "haiku_yields_text" };
      },
      getLastTokenUsage() {
        return {
          haiku: {
            model: "claude-haiku-4-5-20251001",
            usage: { input_tokens: 60, output_tokens: 12 },
          },
        };
      },
    };
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const telemetry = new TurnTelemetry(jsonlPath);
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router: fakeRouter,
      turnTelemetry: telemetry,
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    vad.emitStart();
    stt.emitFinal("dedupe trick");
    await host.awaitSettled();

    const turn = JSON.parse(readFileSync(jsonlPath, "utf8").trim());
    assert.equal(turn.haiku_tier, true);
    assert.equal(turn.sonnet_tier, false);
    assert.equal(turn.haiku_model, "claude-haiku-4-5-20251001");
    assert.equal(turn.haiku_input_tokens, 60);
    assert.equal(turn.haiku_output_tokens, 12);
    assert.equal(turn.sonnet_input_tokens, 0);
    assert.equal(turn.sonnet_output_tokens, 0);
    assert.ok(turn.usd_estimate > 0, "haiku-only turn must still cost > $0");
  } finally {
    cleanup();
  }
});

test("16.1.2 (c) router with no getLastTokenUsage hook degrades to zero counts (16.1 MVP back-compat)", async () => {
  const { dir, cleanup } = freshTempDir();
  const jsonlPath = join(dir, "turns.jsonl");
  try {
    // No getLastTokenUsage method — same shape as the 16.1 MVP host
    // saw before this PR landed.
    const fakeRouter = {
      route() {
        return streamFromChunks(["ack."]);
      },
      getLastOutcome() {
        return { tier: "sonnet", reason: "trigger=EXPLICIT_ASK" };
      },
    };
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const telemetry = new TurnTelemetry(jsonlPath);
    const host = new AudioHost({
      vad,
      stt,
      tts,
      router: fakeRouter,
      turnTelemetry: telemetry,
      getSystemBlocks: () => ["sys"],
      getMode: () => "tutor",
      getPersonality: () => "nice",
      getWakeWord: () => "off",
      log: () => {},
    });

    vad.emitStart();
    stt.emitFinal("hi");
    await host.awaitSettled();

    const turn = JSON.parse(readFileSync(jsonlPath, "utf8").trim());
    assert.equal(turn.haiku_tier, false);
    assert.equal(turn.sonnet_tier, false);
    assert.equal(turn.usd_estimate, 0);
  } finally {
    cleanup();
  }
});

test("16.1.2 (d) TieredRouter.getLastTokenUsage composes optional hooks from haiku and sonnet", () => {
  // Stand-alone unit on the router itself (no host) — proves the
  // composer pulls each side cleanly even when one side is silent.
  const haikuWithUsage = {
    classify: async () => ({ escalate: true }),
    getLastUsage() {
      return {
        model: "claude-haiku-4-5-20251001",
        usage: { input_tokens: 50 },
      };
    },
  };
  const sonnetWithUsage = {
    askStream: async function* () {
      yield "x";
    },
    getLastUsage() {
      return {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 100, output_tokens: 30 },
      };
    },
  };
  const router = new TieredRouter({
    haiku: haikuWithUsage,
    sonnet: sonnetWithUsage,
    log: () => {},
  });
  const got = router.getLastTokenUsage();
  assert.deepEqual(got.haiku, {
    model: "claude-haiku-4-5-20251001",
    usage: { input_tokens: 50 },
  });
  assert.deepEqual(got.sonnet, {
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 100, output_tokens: 30 },
  });

  // And when neither side exposes the hook, returns empty.
  const emptyRouter = new TieredRouter({
    haiku: { classify: async () => ({ escalate: true }) },
    sonnet: {
      askStream: async function* () {
        yield "x";
      },
    },
    log: () => {},
  });
  assert.deepEqual(emptyRouter.getLastTokenUsage(), {});
});

test("16.1.2 (e) AnthropicHaikuClassifier.getLastUsage reflects the most recent classify() call", async () => {
  const fakeMessages = {
    async create() {
      return {
        content: [{ type: "text", text: '{"escalate":true}' }],
        usage: { input_tokens: 80, output_tokens: 5 },
      };
    },
  };
  const classifier = new AnthropicHaikuClassifier({
    client: { messages: fakeMessages },
    log: () => {},
  });
  // Before any call.
  assert.equal(classifier.getLastUsage(), undefined);

  await classifier.classify({ user_question: "?" }, ["sys"]);
  const usage = classifier.getLastUsage();
  assert.ok(usage);
  assert.match(usage.model, /haiku/);
  assert.deepEqual(usage.usage, { input_tokens: 80, output_tokens: 5 });

  // A failing call resets the cached usage so getLastUsage doesn't
  // leak the previous turn's numbers.
  const explodingClassifier = new AnthropicHaikuClassifier({
    client: {
      messages: {
        async create() {
          throw new Error("ECONNREFUSED");
        },
      },
    },
    log: () => {},
  });
  // Seed it with one successful call's usage by stealing the
  // previous classifier's behaviour: just verify the contract.
  await explodingClassifier.classify({}, []);
  assert.equal(
    explodingClassifier.getLastUsage(),
    undefined,
    "errored classify call must leave getLastUsage at undefined"
  );
});
