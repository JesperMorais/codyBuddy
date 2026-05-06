// Task 9.8 (extension side): the bridge now exposes setShuffle and the
// onMode handler receives the shuffle dimension from the daemon's
// modeSet ack. Together with the existing setMode / setPersonality
// methods this gives the sidebar one round-trip per user toggle.
//
// Run: node --test extension/test/bridge-personality.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

const { DaemonBridge } = await import("../out/bridge.js");

function makeOutput() {
  const lines = [];
  return { lines, appendLine: (l) => lines.push(l) };
}

async function listen(server) {
  await new Promise((r) => server.on("listening", r));
  return server.address().port;
}

function makeServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const received = [];
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      received.push(JSON.parse(raw.toString()));
    });
  });
  return { wss, received };
}

test("9.8 bridge.setShuffle(true) sends {type:setShuffle,shuffle:true}", async () => {
  const { wss, received } = makeServer();
  const port = await listen(wss);
  const bridge = new DaemonBridge(port, makeOutput());
  try {
    // Wait for the bridge to connect + finish its initial ping.
    await new Promise((r) => setTimeout(r, 100));
    bridge.setShuffle(true);
    await new Promise((r) => setTimeout(r, 50));
    const shuffleMsg = received.find((m) => m.type === "setShuffle");
    assert.ok(shuffleMsg, "setShuffle message must reach the daemon");
    assert.equal(shuffleMsg.shuffle, true);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("9.8 bridge.setShuffle(false) sends shuffle:false", async () => {
  const { wss, received } = makeServer();
  const port = await listen(wss);
  const bridge = new DaemonBridge(port, makeOutput());
  try {
    await new Promise((r) => setTimeout(r, 100));
    bridge.setShuffle(false);
    await new Promise((r) => setTimeout(r, 50));
    const shuffleMsg = received.find((m) => m.type === "setShuffle");
    assert.ok(shuffleMsg);
    assert.equal(shuffleMsg.shuffle, false);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("9.8 bridge.onMode receives the shuffle dimension from modeSet", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await listen(wss);
  wss.on("connection", (sock) => {
    sock.send(
      JSON.stringify({
        type: "modeSet",
        ok: true,
        mode: "tutor",
        available: ["tutor", "reviewer"],
        personality: "dry",
        availablePersonalities: ["nice", "dry", "pirate"],
        shuffle: true,
      })
    );
  });

  const bridge = new DaemonBridge(port, makeOutput());
  try {
    const seen = await new Promise((resolve) => {
      bridge.onMode((info) => resolve(info));
    });
    assert.equal(seen.mode, "tutor");
    assert.deepEqual(seen.available, ["tutor", "reviewer"]);
    assert.equal(seen.personality, "dry");
    assert.deepEqual(seen.availablePersonalities, ["nice", "dry", "pirate"]);
    assert.equal(seen.shuffle, true);
    assert.equal(seen.ok, true);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("9.8 bridge.onMode defaults shuffle to false when the daemon omits it", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await listen(wss);
  wss.on("connection", (sock) => {
    // An older daemon (or a mocked one) might not include the new
    // shuffle field — the bridge must coerce it to a boolean cleanly.
    sock.send(
      JSON.stringify({
        type: "modeSet",
        ok: true,
        mode: "tutor",
        available: ["tutor"],
        personality: "nice",
        availablePersonalities: ["nice"],
      })
    );
  });

  const bridge = new DaemonBridge(port, makeOutput());
  try {
    const seen = await new Promise((resolve) => {
      bridge.onMode((info) => resolve(info));
    });
    assert.equal(seen.shuffle, false);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("10.4 bridge.hardMute() sends {type:'hardMute'} over the WS", async () => {
  const { wss, received } = makeServer();
  const port = await listen(wss);
  const bridge = new DaemonBridge(port, makeOutput());
  try {
    await new Promise((r) => setTimeout(r, 100));
    bridge.hardMute();
    await new Promise((r) => setTimeout(r, 50));
    const hm = received.find((m) => m.type === "hardMute");
    assert.ok(hm, "hardMute frame must reach the daemon");
    // Hard-mute is a one-shot kill switch; no payload required.
    assert.equal(Object.keys(hm).length, 1, "hardMute frame should carry no extra fields");
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});

test("9.8 bridge.setMode/setPersonality still send the correct WS message types", async () => {
  const { wss, received } = makeServer();
  const port = await listen(wss);
  const bridge = new DaemonBridge(port, makeOutput());
  try {
    await new Promise((r) => setTimeout(r, 100));
    bridge.setMode("reviewer");
    bridge.setPersonality("pirate");
    bridge.setShuffle(true);
    await new Promise((r) => setTimeout(r, 50));
    const types = received.map((m) => m.type);
    assert.ok(types.includes("setMode"));
    assert.ok(types.includes("setPersonality"));
    assert.ok(types.includes("setShuffle"));
    assert.equal(received.find((m) => m.type === "setMode").mode, "reviewer");
    assert.equal(received.find((m) => m.type === "setPersonality").personality, "pirate");
    assert.equal(received.find((m) => m.type === "setShuffle").shuffle, true);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});
