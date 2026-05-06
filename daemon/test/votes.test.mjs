// Task 7.3: vote persistence + WS plumbing.
//
// Run: node --test daemon/test/votes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const { VoteStore, DEFAULT_VOTES_PATH } = await import("../dist/votes.js");
const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { SttBridge } = await import("../dist/stt.js");
const { Recorder } = await import("../dist/recorder.js");
const { MemoryStore } = await import("../dist/memory.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-7.3-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------
// VoteStore
// --------------------------------------------------------------------------

test("7.3 (a) VoteStore.record appends one JSONL line per call", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const store = new VoteStore(join(dir, "votes.jsonl"));
    const before = Date.now();
    const row = store.record({ trigger: "STUCK_LOOP", reply_text: "have you tried await?", vote: "up" });
    const after = Date.now();
    assert.equal(row.vote, "up");
    assert.equal(row.trigger, "STUCK_LOOP");
    assert.equal(row.reply_text, "have you tried await?");
    assert.ok(row.ts >= before && row.ts <= after);

    const lines = readFileSync(join(dir, "votes.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual({ ...parsed, ts: undefined }, { ts: undefined, ...row, ts: undefined });
  } finally {
    cleanup();
  }
});

test("7.3 (b) read() round-trips multiple votes; corrupt lines are skipped", () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const filePath = join(dir, "votes.jsonl");
    const store = new VoteStore(filePath);
    store.record({ trigger: "STUCK_LOOP", reply_text: "a", vote: "up" });
    store.record({ trigger: "STUCK_LOOP", reply_text: "b", vote: "down" });
    // Manually inject a corrupt line in the middle
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8") + "{not json\n",
      "utf8"
    );
    store.record({ trigger: "MISCONCEPTION", reply_text: "c", vote: "up" });

    const entries = store.read();
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => [e.trigger, e.vote, e.reply_text]),
      [
        ["STUCK_LOOP", "up", "a"],
        ["STUCK_LOOP", "down", "b"],
        ["MISCONCEPTION", "up", "c"],
      ]
    );
  } finally {
    cleanup();
  }
});

test("7.3 (c) DEFAULT_VOTES_PATH is under the home dir", () => {
  assert.match(DEFAULT_VOTES_PATH, /votes\.jsonl$/);
  assert.match(DEFAULT_VOTES_PATH, /[\\/]\.coding-buddy[\\/]/);
});

// --------------------------------------------------------------------------
// WS server: vote message round-trip
// --------------------------------------------------------------------------

function buildDeps(votesPath) {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor"]]);
  const session = new Session(fake, prompts);
  const tts = new TtsBridge({ backend: "none" });
  const stt = new SttBridge({});
  const recorder = new Recorder();
  const votes = new VoteStore(votesPath);
  return { session, tts, stt, recorder, votes };
}

function waitListening(wss) {
  return new Promise((r) => (wss.address() ? r() : wss.once("listening", r)));
}

function openClient(port) {
  return new Promise((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => r(ws));
  });
}

function nextMessage(ws, predicate) {
  return new Promise((r) => {
    function onMsg(data) {
      const m = JSON.parse(data.toString());
      if (predicate(m)) {
        ws.off("message", onMsg);
        r(m);
      }
    }
    ws.on("message", onMsg);
  });
}

function closeServer(wss) {
  return new Promise((r) => wss.close(() => r()));
}

test("7.3 (d) WS round-trip: vote → voteAck + persisted JSONL line", async () => {
  const { dir, cleanup } = freshTempDir();
  const votesPath = join(dir, "votes.jsonl");
  const deps = buildDeps(votesPath);
  const wss = startServer({ ...deps, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;

  try {
    const ws = await openClient(port);
    try {
      ws.send(
        JSON.stringify({
          type: "vote",
          trigger: "STUCK_LOOP",
          reply_text: "have you tried await?",
          vote: "down",
        })
      );
      const ack = await nextMessage(ws, (m) => m.type === "voteAck");
      assert.equal(ack.ok, true);
      assert.ok(typeof ack.ts === "number");

      const persisted = deps.votes.read();
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].trigger, "STUCK_LOOP");
      assert.equal(persisted[0].vote, "down");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
    cleanup();
  }
});

test("7.3 (e) WS without a votes store ack returns ok:false", async () => {
  const fake = new FakeAnthropicClient();
  const prompts = new Map([["tutor", "fake tutor"]]);
  const session = new Session(fake, prompts);
  const tts = new TtsBridge({ backend: "none" });
  const stt = new SttBridge({});
  const recorder = new Recorder();
  const wss = startServer({ session, tts, stt, recorder, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;

  try {
    const ws = await openClient(port);
    try {
      ws.send(
        JSON.stringify({
          type: "vote",
          trigger: "X",
          reply_text: "y",
          vote: "up",
        })
      );
      const ack = await nextMessage(ws, (m) => m.type === "voteAck");
      assert.equal(ack.ok, false);
      assert.match(ack.error, /votes disabled/);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
  }
});

// --------------------------------------------------------------------------
// scripts/tune-triggers.mjs
// --------------------------------------------------------------------------

test("7.3 (f) tune-triggers.mjs aggregate + suggest", async () => {
  const { aggregate, suggest, report } = await import("../../scripts/tune-triggers.mjs");

  const entries = [
    { trigger: "STUCK_LOOP", vote: "up" },
    { trigger: "STUCK_LOOP", vote: "up" },
    { trigger: "STUCK_LOOP", vote: "up" },
    { trigger: "STUCK_LOOP", vote: "up" },
    { trigger: "STUCK_LOOP", vote: "up" },
    { trigger: "MISCONCEPTION", vote: "down" },
    { trigger: "MISCONCEPTION", vote: "down" },
    { trigger: "MISCONCEPTION", vote: "down" },
    { trigger: "MISCONCEPTION", vote: "up" },
    { trigger: "BAD_PATH", vote: "up" },
    { trigger: "BAD_PATH", vote: "down" },
  ];
  const slots = aggregate(entries);
  const byTrigger = Object.fromEntries(slots.map((s) => [s.trigger, s]));
  assert.equal(byTrigger.STUCK_LOOP.up, 5);
  assert.equal(byTrigger.STUCK_LOOP.down, 0);
  assert.equal(byTrigger.MISCONCEPTION.up, 1);
  assert.equal(byTrigger.MISCONCEPTION.down, 3);

  // 5/5 up → "lower threshold" (>= 75% upvote)
  assert.equal(suggest(byTrigger.STUCK_LOOP).suggestion, "lower threshold");
  // 3/4 down → "raise threshold" (>= 50% downvote)
  assert.equal(suggest(byTrigger.MISCONCEPTION).suggestion, "raise threshold");
  // 1/2 split → "keep"
  assert.equal(suggest(byTrigger.BAD_PATH).suggestion, "keep");
});

test("7.3 (g) tune-triggers.mjs report renders min-filtered triggers", async () => {
  const { dir, cleanup } = freshTempDir();
  try {
    const filePath = join(dir, "votes.jsonl");
    const lines = [
      ...Array(5).fill('{"trigger":"STUCK_LOOP","vote":"up","reply_text":"x","ts":1}'),
      ...Array(2).fill('{"trigger":"NEW_TOPIC","vote":"up","reply_text":"y","ts":2}'),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const { report } = await import("../../scripts/tune-triggers.mjs");
    const out = report(filePath, 5);
    assert.match(out, /STUCK_LOOP/);
    assert.match(out, /up=5 down=0/);
    assert.match(out, /lower threshold/);
    // NEW_TOPIC has only 2 votes, below min — must NOT appear
    assert.equal(out.includes("NEW_TOPIC"), false);
  } finally {
    cleanup();
  }
});
