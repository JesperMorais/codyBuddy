// Task 7.2: Ollama (OpenAI-compatible) provider.
//
// All assertions stub fetch and inspect the request bodies / response
// parsing. No real Ollama server required.
//
// Run: node --test daemon/test/ollama.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { OllamaClient, DEFAULT_OLLAMA_MODEL } = await import("../dist/ollama.js");
const { Telemetry } = await import("../dist/telemetry.js");
const { Session } = await import("../dist/session.js");
const { MemoryStore } = await import("../dist/memory.js");

function makeFakeFetch(responses) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = responses.shift() ?? { choices: [{ message: { content: "" } }], usage: {} };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fakeFetch, calls };
}

function chatBody(content, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return { choices: [{ message: { role: "assistant", content } }], usage };
}

function freshTelemetry() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-7.2-tel-"));
  return {
    telemetry: new Telemetry(join(dir, "telemetry.jsonl")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// --------------------------------------------------------------------------
// Construction defaults
// --------------------------------------------------------------------------

test("7.2 (a) DEFAULT_OLLAMA_MODEL is qwen2.5-coder:32b", () => {
  assert.equal(DEFAULT_OLLAMA_MODEL, "qwen2.5-coder:32b");
});

// --------------------------------------------------------------------------
// ask()
// --------------------------------------------------------------------------

test("7.2 (b) ask() POSTs to /chat/completions with the configured model + system+user messages", async () => {
  const { fakeFetch, calls } = makeFakeFetch([
    chatBody('{"mode":"chat","text":"hello","wants_followup":false}'),
  ]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    const reply = await client.ask(["system text"], "(no summary)", { trigger: "EXPLICIT_ASK" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "qwen2.5-coder:32b");
    assert.equal(body.max_tokens, 400);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "system text");
    assert.equal(body.messages[1].role, "user");
    assert.match(body.messages[1].content, /Trigger event:/);

    assert.equal(reply.mode, "chat");
    assert.equal(reply.text, "hello");
    assert.equal(reply.wants_followup, false);
  } finally {
    cleanup();
  }
});

test("7.2 (c) ask() concatenates multiple system blocks into one Ollama system message", async () => {
  const { fakeFetch, calls } = makeFakeFetch([
    chatBody('{"mode":"chat","text":"ok","wants_followup":false}'),
  ]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    await client.ask(
      [
        "base prompt",
        "What I've noticed about this developer over time:\nRecurring: forgets await.",
      ],
      "",
      {}
    );
    const body = JSON.parse(calls[0].init.body);
    assert.match(body.messages[0].content, /^base prompt/);
    assert.match(body.messages[0].content, /What I've noticed about this developer over time:/);
    assert.match(body.messages[0].content, /Recurring: forgets await\./);
  } finally {
    cleanup();
  }
});

test("7.2 (d) ask() falls back to mode=chat for non-JSON output", async () => {
  const { fakeFetch } = makeFakeFetch([chatBody("plain text response, not JSON")]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    const reply = await client.ask(["sys"], "", {});
    assert.equal(reply.mode, "chat");
    assert.equal(reply.text, "plain text response, not JSON");
  } finally {
    cleanup();
  }
});

test("7.2 (e) ask() returns no_op on empty / NO_OP responses", async () => {
  const { fakeFetch } = makeFakeFetch([chatBody("NO_OP"), chatBody("")]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    const r1 = await client.ask(["sys"], "", {});
    const r2 = await client.ask(["sys"], "", {});
    assert.equal(r1.mode, "no_op");
    assert.equal(r2.mode, "no_op");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// shouldSpeak()
// --------------------------------------------------------------------------

test("7.2 (f) shouldSpeak() round-trips speak/chat/no_op (case-insensitive)", async () => {
  const { fakeFetch } = makeFakeFetch([chatBody("speak"), chatBody("CHAT"), chatBody("no_op")]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    assert.equal(await client.shouldSpeak({}, ""), "speak");
    assert.equal(await client.shouldSpeak({}, ""), "chat");
    assert.equal(await client.shouldSpeak({}, ""), "no_op");
  } finally {
    cleanup();
  }
});

test("7.2 (g) shouldSpeak() defaults to chat on garbled output", async () => {
  const { fakeFetch } = makeFakeFetch([chatBody("maybe yes who knows")]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    assert.equal(await client.shouldSpeak({}, ""), "chat");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Telemetry passthrough
// --------------------------------------------------------------------------

test("7.2 (h) usage tokens are recorded under input_tokens / output_tokens", async () => {
  const { fakeFetch } = makeFakeFetch([
    chatBody("{}", { prompt_tokens: 250, completion_tokens: 30 }),
  ]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    await client.ask(["sys"], "", {});
    const entries = telemetry.read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].method, "ask");
    assert.equal(entries[0].model, "qwen2.5-coder:32b");
    assert.equal(entries[0].input_tokens, 250);
    assert.equal(entries[0].output_tokens, 30);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// distillLearnerProfile passes counts through
// --------------------------------------------------------------------------

test("7.2 (i) distillLearnerProfile serializes count=N into the user message", async () => {
  const { fakeFetch, calls } = makeFakeFetch([chatBody("(distilled)")]);
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    await client.distillLearnerProfile("(history)", "(prior)", {
      "ts-as-any": { count: 4, last_seen: 1700000000000 },
    });
    const userMsg = JSON.parse(calls[0].init.body).messages[1].content;
    assert.match(userMsg, /ts-as-any: count=4/);
    assert.match(userMsg, /Detected anti-patterns/);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Session can use OllamaClient like AnthropicClient
// --------------------------------------------------------------------------

test("7.2 (j) Session works end-to-end with OllamaClient (AiClient interface)", async () => {
  const { fakeFetch } = makeFakeFetch([
    chatBody("speak"),
    chatBody('{"mode":"speak","text":"have you tried await?","wants_followup":true}'),
  ]);
  const { telemetry, cleanup: cleanTel } = freshTelemetry();
  const memDir = mkdtempSync(join(tmpdir(), "buddy-7.2-mem-"));
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    const memory = new MemoryStore(memDir);
    const prompts = new Map([["tutor", "fake tutor"]]);
    const session = new Session(client, prompts, { memory });

    const reply = await session.handleTrigger("STUCK_LOOP", { active_file: "x.ts" });
    assert.equal(reply.mode, "speak");
    assert.equal(reply.text, "have you tried await?");
  } finally {
    cleanTel();
    rmSync(memDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Error paths
// --------------------------------------------------------------------------

test("7.2 (k) chat() throws on non-2xx — surfaces in ask()", async () => {
  const fakeFetch = async () =>
    new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
  const { telemetry, cleanup } = freshTelemetry();
  try {
    const client = new OllamaClient({ fetchImpl: fakeFetch, telemetry });
    await assert.rejects(() => client.ask(["sys"], "", {}), /ollama HTTP 502/);
  } finally {
    cleanup();
  }
});
