// Redactor tests — file-glob deny + secret scrub.
// Contract: README "Safety / cost defaults" + RESEARCH.md §3.4.
// Run: node --test extension/test/redactor.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { isDeniedFile, scrubSecrets } = await import("../out/redactor.js");

// --------------------------------------------------------------------------
// isDeniedFile
// --------------------------------------------------------------------------

test("isDeniedFile rejects .env at repo root", () => {
  assert.equal(isDeniedFile(".env"), true);
  assert.equal(isDeniedFile("/repo/.env"), true);
  assert.equal(isDeniedFile("C:\\repo\\.env"), true);
});

test("isDeniedFile rejects .env.local and other .env.* variants", () => {
  assert.equal(isDeniedFile(".env.local"), true);
  assert.equal(isDeniedFile("project/.env.production"), true);
  assert.equal(isDeniedFile("C:\\repo\\.env.test"), true);
});

test("isDeniedFile rejects id_rsa and id_rsa.pub", () => {
  assert.equal(isDeniedFile("id_rsa"), true);
  assert.equal(isDeniedFile("id_rsa.pub"), true);
  assert.equal(isDeniedFile("/home/user/.ssh/id_rsa"), true);
});

test("isDeniedFile rejects *.pem files", () => {
  assert.equal(isDeniedFile("cert.pem"), true);
  assert.equal(isDeniedFile("/etc/ssl/certs/server.pem"), true);
  assert.equal(isDeniedFile("C:\\certs\\client.pem"), true);
});

test("isDeniedFile rejects *.key files", () => {
  assert.equal(isDeniedFile("private.key"), true);
  assert.equal(isDeniedFile("/etc/ssl/private/server.key"), true);
  assert.equal(isDeniedFile("C:\\certs\\client.key"), true);
});

test("isDeniedFile rejects **/secrets/** paths", () => {
  assert.equal(isDeniedFile("/repo/secrets/db.json"), true);
  assert.equal(isDeniedFile("project/secrets/api.txt"), true);
  assert.equal(isDeniedFile("C:\\repo\\secrets\\anything"), true);
  assert.equal(isDeniedFile("repo/secret.json"), true);
});

test("isDeniedFile allows ordinary source files", () => {
  assert.equal(isDeniedFile("src/index.ts"), false);
  assert.equal(isDeniedFile("README.md"), false);
  assert.equal(isDeniedFile("C:\\repo\\src\\extension.ts"), false);
  assert.equal(isDeniedFile("environment.ts"), false);
  assert.equal(isDeniedFile("keyboard-shortcuts.md"), false);
});

// --------------------------------------------------------------------------
// scrubSecrets
// --------------------------------------------------------------------------

test("scrubSecrets returns input unchanged with hit count 0 when clean", () => {
  const input = "no secrets here, just regular text and code";
  const result = scrubSecrets(input);
  assert.equal(result.text, input);
  assert.equal(result.hits, 0);
});

test("scrubSecrets redacts sk-… style API keys", () => {
  const input = 'export const KEY = "sk-ant-abc123def456ghi789jkl012mno345pq";';
  const result = scrubSecrets(input);
  assert.match(result.text, /<REDACTED-SECRET>/);
  assert.equal(result.text.includes("sk-ant-abc123"), false);
  assert.equal(result.hits, 1);
});

test("scrubSecrets redacts AWS access keys (AKIA and ASIA prefixes)", () => {
  const input = "AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE";
  const result = scrubSecrets(input);
  assert.equal(result.text.includes("AKIA"), false);
  assert.equal(result.text.includes("ASIA"), false);
  assert.equal(result.hits, 2);
});

test("scrubSecrets redacts GitHub personal-access and server tokens", () => {
  const input =
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789 and ghs_abcdefghijklmnopqrstuvwxyz0123456789";
  const result = scrubSecrets(input);
  assert.equal(result.text.includes("ghp_"), false);
  assert.equal(result.text.includes("ghs_"), false);
  assert.equal(result.hits, 2);
});

test("scrubSecrets redacts Slack tokens (xoxa/xoxb/xoxp)", () => {
  const input =
    "xoxa-1234567890-abcd and xoxb-1234567890-efgh and xoxp-1234567890-ijkl";
  const result = scrubSecrets(input);
  assert.equal(result.text.includes("xoxa-"), false);
  assert.equal(result.text.includes("xoxb-"), false);
  assert.equal(result.text.includes("xoxp-"), false);
  assert.equal(result.hits, 3);
});

test("scrubSecrets reports hit count across multiple secrets in one input", () => {
  const input =
    'sk-ant-abc123def456ghi789jkl012mno345pq plus AKIAIOSFODNN7EXAMPLE plus ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const result = scrubSecrets(input);
  assert.equal(result.hits, 3);
  // every original secret string is gone
  assert.equal(result.text.includes("sk-ant-"), false);
  assert.equal(result.text.includes("AKIA"), false);
  assert.equal(result.text.includes("ghp_"), false);
  // and the placeholder replaces each one
  const placeholderCount = (result.text.match(/<REDACTED-SECRET>/g) ?? []).length;
  assert.equal(placeholderCount, 3);
});

test("scrubSecrets leaves short look-alikes that don't match the patterns", () => {
  // sk- prefix but too short to match the {20,} guard
  const input = "sk-shorty";
  const result = scrubSecrets(input);
  assert.equal(result.text, input);
  assert.equal(result.hits, 0);
});
