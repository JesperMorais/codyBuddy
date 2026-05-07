// Task 15.4: sidebar demo-mode watermark + bridge wiring.
//
// Coverage:
//   (a) setDemoMode posts {type:"demoMode", active}
//   (b) watermark re-hydrates on webview reopen
//   (c) HTML carries the #demo-banner element + JS handler
//   (d) bridge exposes onDemoMode and routes incoming WS messages
//
// Run: node --test extension/test/sidebar-demo-mode.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);

const fakeVscode = {};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "vscode") return "vscode-fake";
  return origResolve.call(this, req, ...rest);
};
require.cache["vscode-fake"] = {
  id: "vscode-fake",
  filename: "vscode-fake",
  loaded: true,
  exports: fakeVscode,
};

const { BuddySidebarProvider } = require("../out/ui/sidebar.js");
const { DaemonBridge } = require("../out/bridge.js");

function makeFakeView() {
  const posted = [];
  let messageHandler;
  return {
    posted,
    webview: {
      options: {},
      html: "",
      postMessage: (m) => {
        posted.push(m);
      },
      onDidReceiveMessage: (h) => {
        messageHandler = h;
      },
      get _handler() {
        return messageHandler;
      },
    },
  };
}

test("15.4 (a) setDemoMode posts {type:demoMode, active}", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  view.posted.length = 0;

  provider.setDemoMode(true);
  const on = view.posted.find((m) => m.type === "demoMode");
  assert.ok(on);
  assert.equal(on.active, true);

  view.posted.length = 0;
  provider.setDemoMode(false);
  const off = view.posted.find((m) => m.type === "demoMode");
  assert.equal(off.active, false);
});

test("15.4 (b) watermark re-hydrates on reopen", () => {
  const provider = new BuddySidebarProvider();
  const v1 = makeFakeView();
  provider.resolveWebviewView(v1);
  provider.setDemoMode(true);

  const v2 = makeFakeView();
  provider.resolveWebviewView(v2);
  const init = v2.posted.find((m) => m.type === "demoMode");
  assert.ok(init, "fresh view should receive demoMode hydration");
  assert.equal(init.active, true);
});

test("15.4 (c) HTML carries the demo banner element + handler", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  const html = view.webview.html;

  assert.match(html, /id=["']demo-banner["']/);
  assert.match(html, /demo mode/i);
  assert.match(html, /m\.type === 'demoMode'/);
  assert.match(html, /banner\.dataset\.active/);
});

test("15.4 (d) bridge.onDemoMode routes daemon-side demoMode pushes", async () => {
  // Boot a tiny WS server that pushes a demoMode frame; assert
  // the bridge surfaces it through onDemoMode.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const port = wss.address().port;

  const seen = [];
  wss.on("connection", (sock) => {
    // Push two demo-mode frames after a tick so the bridge's
    // listener is attached.
    setTimeout(() => {
      sock.send(JSON.stringify({ type: "demoMode", active: true }));
      sock.send(JSON.stringify({ type: "demoMode", active: false }));
    }, 20);
  });

  const bridge = new DaemonBridge(port, { appendLine: () => {} });
  try {
    await new Promise((resolve) => {
      bridge.onDemoMode((info) => {
        seen.push(info.active);
        if (seen.length === 2) resolve();
      });
    });
    assert.deepEqual(seen, [true, false]);
  } finally {
    bridge.dispose();
    await new Promise((r) => wss.close(r));
  }
});
