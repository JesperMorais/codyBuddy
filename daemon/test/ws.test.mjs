// WS integration test: boot the server in-process with FakeAnthropicClient,
// connect a real ws client, send a trigger message, assert a non-no_op reply.
// Run: node --test daemon/test/ws.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const { startServer } = await import("../dist/server.js");
const { Session } = await import("../dist/session.js");
const { TtsBridge } = await import("../dist/tts-bridge.js");
const { SttBridge } = await import("../dist/stt.js");
const { Recorder } = await import("../dist/recorder.js");
const { FakeAnthropicClient } = await import("./fakes.mjs");

function buildDeps(replies) {
  const fake = new FakeAnthropicClient({ replies });
  const prompts = new Map([["tutor", "fake tutor system prompt"]]);
  const session = new Session(fake, prompts);
  const tts = new TtsBridge({ backend: "none" });
  const stt = new SttBridge({});
  const recorder = new Recorder();
  return { fake, session, tts, stt, recorder };
}

function waitListening(wss) {
  return new Promise((resolve) => {
    if (wss.address()) resolve();
    else wss.once("listening", resolve);
  });
}

function openClient(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolve(ws));
  });
}

function nextMessage(ws, predicate) {
  return new Promise((resolve) => {
    function onMsg(data) {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        ws.off("message", onMsg);
        resolve(msg);
      }
    }
    ws.on("message", onMsg);
  });
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

test("WS round-trip: trigger → reply with mode !== no_op", async () => {
  const { session, tts, stt, recorder } = buildDeps([
    { mode: "chat", text: "What error are you seeing on line 47?", wants_followup: true },
  ]);
  const wss = startServer({ session, tts, stt, recorder, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;

  try {
    const ws = await openClient(port);
    try {
      ws.send(
        JSON.stringify({
          type: "trigger",
          trigger: "EXPLICIT_ASK",
          payload: { active_file: "src/foo.ts", user_question: "what's wrong here?" },
        })
      );
      const reply = await nextMessage(ws, (m) => m.type === "reply");
      assert.equal(reply.trigger, "EXPLICIT_ASK");
      assert.notEqual(reply.reply.mode, "no_op");
      assert.equal(reply.reply.mode, "chat");
      assert.equal(reply.reply.text, "What error are you seeing on line 47?");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
  }
});

test("WS round-trip: ping → pong", async () => {
  const { session, tts, stt, recorder } = buildDeps([]);
  const wss = startServer({ session, tts, stt, recorder, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;

  try {
    const ws = await openClient(port);
    try {
      ws.send(JSON.stringify({ type: "ping" }));
      const pong = await nextMessage(ws, (m) => m.type === "pong");
      assert.equal(pong.type, "pong");
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
  }
});

test("WS round-trip: muted non-EXPLICIT_ASK trigger returns no_op without consulting client", async () => {
  const { fake, session, tts, stt, recorder } = buildDeps([
    { mode: "chat", text: "should never be sent", wants_followup: false },
  ]);
  session.mute(30);
  const wss = startServer({ session, tts, stt, recorder, port: 0 });
  await waitListening(wss);
  const port = wss.address().port;

  try {
    const ws = await openClient(port);
    try {
      ws.send(
        JSON.stringify({
          type: "trigger",
          trigger: "STUCK_LOOP",
          payload: { active_file: "x.ts" },
        })
      );
      const reply = await nextMessage(ws, (m) => m.type === "reply");
      assert.equal(reply.reply.mode, "no_op");
      assert.equal(fake.calls.ask.length, 0);
    } finally {
      ws.close();
    }
  } finally {
    await closeServer(wss);
  }
});
