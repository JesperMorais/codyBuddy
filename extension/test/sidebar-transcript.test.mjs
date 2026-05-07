// Task 14.1: live transcript view in the sidebar.
//
// The sidebar webview renders a transcript log of user speech (gray
// bubble) and buddy replies (default/"white" bubble), scrolled to
// the bottom. Backchannels are intentionally not surfaced — they're
// pre-recorded acks played locally by the daemon without text.
//
// Coverage:
//   (a) notifyTranscribed posts a {type:"transcript", speaker:"user",...}
//       message — not the old "You: <text>" status line.
//   (b) push() (existing buddy-reply path) is unchanged.
//   (c) Empty transcript text is dropped silently — no message.
//   (d) Backchannels do NOT have a public surface on the sidebar
//       (no method, no message type) — drift guard against a
//       future regression that would route low-level audio cues
//       into the transcript view.
//
// Run: node --test extension/test/sidebar-transcript.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

// Stub the vscode API so the BuddySidebarProvider class loads.
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

test("14.1 (a) notifyTranscribed posts a transcript message with speaker:user", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);

  // Drain init messages (voiceConfig, controls if any).
  view.posted.length = 0;

  provider.notifyTranscribed("hello world");

  const transcript = view.posted.find((m) => m.type === "transcript");
  assert.ok(transcript, "expected a transcript message");
  assert.equal(transcript.speaker, "user");
  assert.equal(transcript.text, "hello world");
  assert.equal(typeof transcript.ts, "number");

  // No old-style "You: ..." status line.
  const oldStatus = view.posted.find(
    (m) => m.type === "status" && /^You:/.test(m.text)
  );
  assert.equal(oldStatus, undefined, "old You:-prefixed status line is gone");
});

test("14.1 (a) empty/whitespace transcript text is dropped silently", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  view.posted.length = 0;

  provider.notifyTranscribed("");
  provider.notifyTranscribed(undefined);

  const transcripts = view.posted.filter((m) => m.type === "transcript");
  assert.equal(transcripts.length, 0, "no message for empty input");
});

test("14.1 (b) push(SidebarMessage) still posts a reply (back-compat)", () => {
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  view.posted.length = 0;

  provider.push({
    trigger: "EXPLICIT_ASK",
    reply: { mode: "chat", text: "here you go" },
  });

  const reply = view.posted.find((m) => m.type === "reply");
  assert.ok(reply, "buddy reply still goes through the existing reply channel");
  assert.equal(reply.trigger, "EXPLICIT_ASK");
  assert.equal(reply.reply.text, "here you go");
});

test("14.1 (c) notifyTranscribing still posts in-progress status", () => {
  // The "Transcribing audio…" line stays — it's pre-final feedback,
  // separate from the finalised transcript bubble.
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  view.posted.length = 0;

  provider.notifyTranscribing();
  const transcribing = view.posted.find((m) => m.type === "transcribing");
  assert.ok(transcribing, "transcribing notice still flows");
});

test("14.1 (d) BuddySidebarProvider exposes no backchannel surface", () => {
  // Drift guard: 14.1 spec says backchannels are not shown. The
  // sidebar must not gain a method named pushBackchannel /
  // notifyBackchannel etc. — if a future PR adds one, this fails
  // and we re-litigate the contract.
  const provider = new BuddySidebarProvider();
  const proto = Object.getPrototypeOf(provider);
  const methodNames = Object.getOwnPropertyNames(proto);
  for (const name of methodNames) {
    assert.ok(
      !/backchannel/i.test(name),
      `unexpected backchannel-related method on sidebar: ${name}`
    );
  }
});

test("14.1 (e) HTML contains the .msg.user style + transcript handler", async () => {
  // The render contract. The webview HTML should:
  //   - have a CSS rule for .msg.user (gray styling)
  //   - have a JS branch handling type === "transcript"
  //   - auto-scroll on transcript receipt
  // We don't run the HTML; we just smoke-check the source.
  const provider = new BuddySidebarProvider();
  const view = makeFakeView();
  provider.resolveWebviewView(view);
  const html = view.webview.html;

  assert.match(html, /\.msg\.user/, ".msg.user CSS rule present");
  assert.match(html, /m\.type === 'transcript'/, "transcript handler present");
  assert.match(html, /log\.scrollTop = log\.scrollHeight/, "auto-scroll present");
  // The speaker micro-label exists.
  assert.match(html, /\.speaker/, ".speaker label rule present");
  assert.match(html, /Backchannels never reach this branch/i, "doc comment kept inline");
});
