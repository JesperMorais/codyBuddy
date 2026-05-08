// Task 16.5: Daemon stdout logs raw STT transcripts. Verify the helper
// used by the WS server's [transcribe] log lines scrubs known secret
// shapes and truncates to a bounded preview, so a dictated/quoted secret
// never lands in journalctl unredacted.
//
// Run: node --test daemon/test/transcript-log-redaction.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { transcriptLogPreview, TRANSCRIPT_LOG_PREVIEW_CHARS } = await import(
  "../dist/server.js"
);

test("transcriptLogPreview scrubs Anthropic-style key from transcript", () => {
  const secret = "sk-ant-" + "a".repeat(40);
  const text = `here is the key ${secret} please`;
  const out = transcriptLogPreview(text);
  assert.ok(!out.includes(secret), `preview must not contain raw secret: ${out}`);
  assert.ok(out.includes("<REDACTED-SECRET>"), `expected redaction marker: ${out}`);
  assert.ok(out.startsWith(`len=${text.length} `), `expected len prefix: ${out}`);
});

test("transcriptLogPreview scrubs AWS access key", () => {
  const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
  const text = `key is ${secret}`;
  const out = transcriptLogPreview(text);
  assert.ok(!out.includes(secret));
  assert.ok(out.includes("<REDACTED-SECRET>"));
});

test("transcriptLogPreview truncates long transcripts to a fixed preview", () => {
  const text = "x".repeat(TRANSCRIPT_LOG_PREVIEW_CHARS + 50);
  const out = transcriptLogPreview(text);
  assert.ok(out.includes(`len=${text.length}`));
  // The body of the preview between the first `"` and the last `"` should
  // be at most TRANSCRIPT_LOG_PREVIEW_CHARS chars plus a single ellipsis.
  const m = out.match(/preview="(.*)"$/);
  assert.ok(m, `preview must end with quoted body: ${out}`);
  const body = m[1];
  assert.ok(body.endsWith("…"), `truncated preview should end with ellipsis: ${body}`);
  assert.equal(body.length, TRANSCRIPT_LOG_PREVIEW_CHARS + 1);
});

test("transcriptLogPreview leaves short clean transcripts intact (no ellipsis)", () => {
  const text = "ship it";
  const out = transcriptLogPreview(text);
  assert.equal(out, `len=${text.length} preview="${text}"`);
});

test("transcriptLogPreview length always reflects original (pre-scrub) byte count", () => {
  // The redaction marker is longer than the secret being replaced, but
  // the reported `len=` should reflect the *original* transcript length
  // so log readers can spot anomalously large transcripts even when
  // their contents are mostly redacted.
  const secret = "ghp_" + "a".repeat(36);
  const text = `key=${secret}`;
  const out = transcriptLogPreview(text);
  assert.ok(out.startsWith(`len=${text.length} `));
});
