// Task 14.2: sidebar status pill replaces the daemon-up indicator.
//
// The pill cycles through five coarse states and shows the
// user-facing label for each:
//   idle      → "Ready"
//   down      → "Daemon down"
//   listening → "I'm listening…"
//   thinking  → "Buddy is thinking…"
//   speaking  → "Buddy is speaking…"
//
// Coverage:
//   (a) setBuddyState posts {type:"buddyState", state, label}
//       with the right label for each state.
//   (b) Re-opening the webview re-hydrates the pill with the
//       cached state (no flash of "Ready" after reload).
//   (c) onSpeechEnded callback fires when the webview posts
//       speechEnded — wires the pill back from "speaking" to
//       whatever the host wants next.
//   (d) HTML carries the pill markup and a CSS class for each
//       state — drift guard for future restyles.
//
// Run: node --test extension/test/sidebar-status-pill.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

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

const STATE_LABELS = {
  idle: "Ready",
  listening: "I'm listening…",
  thinking: "Buddy is thinking…",
  speaking: "Buddy is speaking…",
  down: "Daemon down",
};

test("14.2 (a) setBuddyState posts the right label for each state", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);

  for (const [state, label] of Object.entries(STATE_LABELS)) {
    view.posted.length = 0;
    provider.setBuddyState(state);
    const msg = view.posted.find((m) => m.type === "buddyState");
    assert.ok(msg, `expected buddyState message for state=${state}`);
    assert.equal(msg.state, state);
    assert.equal(msg.label, label, `wrong label for state=${state}`);
  }
});

test("14.2 (a) getBuddyState returns the cached state", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);

  assert.equal(provider.getBuddyState(), "idle", "default is idle");
  provider.setBuddyState("listening");
  assert.equal(provider.getBuddyState(), "listening");
  provider.setBuddyState("speaking");
  assert.equal(provider.getBuddyState(), "speaking");
});

test("14.2 (b) re-opening the webview re-hydrates the pill", () => {
  const provider = new BuddySidebarProvider();
  // First view receives initial idle.
  const v1 = makeFakeView();
  provider.resolveWebviewView(v1);
  // Simulate the user being mid-thinking when the view re-renders.
  provider.setBuddyState("thinking");

  // Now re-open (fresh view, fresh post buffer).
  const v2 = makeFakeView();
  provider.resolveWebviewView(v2);
  const hydration = v2.posted.find((m) => m.type === "buddyState");
  assert.ok(hydration, "fresh view should receive a buddyState hydration");
  assert.equal(hydration.state, "thinking");
  assert.equal(hydration.label, "Buddy is thinking…");
});

test("14.2 (c) onSpeechEnded fires when the webview posts speechEnded", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);

  let count = 0;
  provider.onSpeechEnded(() => {
    count += 1;
  });

  // Simulate the webview firing utterance.onend.
  view.webview._handler({ type: "speechEnded" });
  assert.equal(count, 1);

  // Idempotent — multiple events are passed through (host can
  // decide what to do).
  view.webview._handler({ type: "speechEnded" });
  assert.equal(count, 2);
});

test("14.2 (d) HTML carries the pill markup + CSS hooks for each state", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  const html = view.webview.html;

  assert.match(html, /id=["']buddy-state["']/, "pill element present");
  assert.match(html, /data-state=["']idle["']/, "default state attribute");
  // CSS rules for each state — drift guard.
  for (const state of Object.keys(STATE_LABELS)) {
    const re = new RegExp(`#buddy-state\\[data-state=["']${state}["']\\]`);
    assert.match(html, re, `CSS rule for state=${state}`);
  }
  // JS handler routes type="buddyState" into the DOM updater.
  assert.match(html, /m\.type === 'buddyState'/, "buddyState handler");
  assert.match(html, /setBuddyState\(m\.state, m\.label\)/, "label drives DOM");
  // SpeechSynthesisUtterance.onend posts back to the extension.
  assert.match(html, /speechEnded/, "speech-end signal wired");
});

test("14.2 (d) extension exposes a BuddyState type with the documented states", async () => {
  // The compiled .js doesn't carry the type, but the file should
  // still export the BuddySidebarProvider class with the methods
  // the spec requires. Lightweight check: the class methods exist.
  const provider = new BuddySidebarProvider();
  assert.equal(typeof provider.setBuddyState, "function");
  assert.equal(typeof provider.getBuddyState, "function");
  assert.equal(typeof provider.onSpeechEnded, "function");
});
