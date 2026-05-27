// #102: the sidebar is the only reply surface on the chat-only path, so
// screen-reader users need live regions + accessible names. This guards
// the markup/JS that announces state changes and labels the icon buttons.
//
// The webview HTML is a static template, so we inspect the rendered string
// (same approach as sidebar-status-pill.test.mjs / sidebar-demo-mode.test.mjs).
//
// Run: node --test extension/test/sidebar-a11y.test.mjs

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
  let messageHandler;
  return {
    webview: {
      options: {},
      html: "",
      postMessage: () => {},
      onDidReceiveMessage: (h) => {
        messageHandler = h;
      },
      get _handler() {
        return messageHandler;
      },
    },
  };
}

function html() {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  return view.webview.html;
}

test("#102 status pill is a focusable polite live region", () => {
  const h = html();
  // The buddy-state div carries role=status + aria-live=polite + tabindex.
  const pill = /<div id="buddy-state"[^>]*>/.exec(h);
  assert.ok(pill, "buddy-state element present");
  const tag = pill[0];
  assert.match(tag, /role="status"/, "pill needs role=status");
  assert.match(tag, /aria-live="polite"/, "pill needs aria-live=polite");
  assert.match(tag, /tabindex="0"/, "pill should be focusable");
});

test("#102 reply log is a polite log live region", () => {
  const log = /<div id="log"[^>]*>/.exec(html());
  assert.ok(log, "log element present");
  assert.match(log[0], /role="log"/, "log needs role=log");
  assert.match(log[0], /aria-live="polite"/, "log needs aria-live=polite");
});

test("#102 demo banner is an assertive alert region", () => {
  const banner = /<div id="demo-banner"[^>]*>/.exec(html());
  assert.ok(banner, "demo-banner element present");
  assert.match(banner[0], /role="alert"/, "banner needs role=alert");
  assert.match(banner[0], /aria-live="assertive"/, "banner needs aria-live=assertive");
});

test("#102 mic button has an accessible name that flips with state", () => {
  const h = html();
  const mic = /<button id="mic"[^>]*>/.exec(h);
  assert.ok(mic, "mic button present");
  assert.match(mic[0], /aria-label="Start recording \(Ctrl\+Alt\+V\)"/);
  // setRecordingUi updates the accessible name in both directions.
  assert.match(h, /setAttribute\('aria-label', 'Stop recording \(Ctrl\+Alt\+V\)'\)/);
  assert.match(h, /setAttribute\('aria-label', 'Start recording \(Ctrl\+Alt\+V\)'\)/);
});

test("#102 vote buttons get aria-labels (title alone is unreliable)", () => {
  const h = html();
  assert.match(h, /setAttribute\('aria-label', 'Mark this reply useful'\)/);
  assert.match(h, /setAttribute\('aria-label', 'Mark this reply not useful'\)/);
});

test("#102 the misleading 'read it on focus' comment is gone", () => {
  // The old comment claimed the pill was accessible without a live
  // region — the bug this issue fixed. Guard against it creeping back.
  assert.doesNotMatch(html(), /read it on focus/i);
});
