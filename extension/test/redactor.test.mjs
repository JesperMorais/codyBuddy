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
  // Issue #163: with the relaxed SHOUTING_NAME=value rule (zero-or-more
  // prefix), the bare `KEY="…"` form ALSO matches after the sk- rule
  // has already redacted the inner value. That's safe — the secret is
  // gone after the first pass, and the second hit just re-redacts the
  // placeholder. Hits is therefore 2; the visible bytes "sk-ant-abc123"
  // are still gone.
  const input = 'export const KEY = "sk-ant-abc123def456ghi789jkl012mno345pq";';
  const result = scrubSecrets(input);
  assert.match(result.text, /<REDACTED-SECRET>/);
  assert.equal(result.text.includes("sk-ant-abc123"), false);
  assert.equal(result.hits, 2);
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

// --------------------------------------------------------------------------
// 16.6 — extended coverage (new SECRET_REGEXES + DENY_PATTERNS)
// --------------------------------------------------------------------------

test("16.6 isDeniedFile rejects new credential file shapes", () => {
  // SSH legacy/modern keys (id_rsa already covered above; cover the rest).
  assert.equal(isDeniedFile("/home/u/.ssh/id_ed25519"), true);
  assert.equal(isDeniedFile("/home/u/.ssh/id_ecdsa"), true);
  assert.equal(isDeniedFile("/home/u/.ssh/id_dsa"), true);
  assert.equal(isDeniedFile("/home/u/.ssh/id_ed25519.pub"), true);
  assert.equal(isDeniedFile("/home/u/.ssh/config"), true);
  // Package/registry credential files.
  assert.equal(isDeniedFile("/home/u/.npmrc"), true);
  assert.equal(isDeniedFile("/home/u/.netrc"), true);
  assert.equal(isDeniedFile("C:\\Users\\u\\_netrc"), true);
  // DB / git credential helpers.
  assert.equal(isDeniedFile("/home/u/.pgpass"), true);
  assert.equal(isDeniedFile("/home/u/.git-credentials"), true);
  assert.equal(isDeniedFile("/repo/.git/config"), true);
  // Cloud/k8s configs.
  assert.equal(isDeniedFile("/home/u/.aws/credentials"), true);
  assert.equal(isDeniedFile("/home/u/.aws/config"), true);
  assert.equal(isDeniedFile("/home/u/.kube/config"), true);
  assert.equal(isDeniedFile("/tmp/staging.kubeconfig"), true);
  assert.equal(isDeniedFile("/etc/kubernetes/kubeconfig"), true);
  // VPN configs.
  assert.equal(isDeniedFile("/etc/openvpn/client.ovpn"), true);
  assert.equal(isDeniedFile("/etc/wireguard/wg0.conf"), true);
  assert.equal(isDeniedFile("/etc/wireguard/wg.conf"), true);
  // PuTTY / KeePass.
  assert.equal(isDeniedFile("C:\\keys\\session.ppk"), true);
  assert.equal(isDeniedFile("vault.kdbx"), true);
  assert.equal(isDeniedFile("legacy.kdb"), true);
  // Container/composer auth.
  assert.equal(isDeniedFile("/home/u/.docker/config.json"), true);
  assert.equal(isDeniedFile("/home/u/.composer/auth.json"), true);
  assert.equal(isDeniedFile("/home/u/composer/auth.json"), true);
});

test("16.6 isDeniedFile still allows ordinary files that look superficially close", () => {
  // We do not want package.json, tsconfig.json, server.config.json blocked.
  assert.equal(isDeniedFile("config.json"), false);
  assert.equal(isDeniedFile("server/config.json"), false);
  assert.equal(isDeniedFile("auth.json"), false);
  assert.equal(isDeniedFile("client/auth.json"), false);
  assert.equal(isDeniedFile("kube.ts"), false);
  assert.equal(isDeniedFile("ssh-helper.ts"), false);
});

test("16.6 scrubSecrets redacts Google API keys", () => {
  const input = "GOOGLE = 'AIza" + "B".repeat(35) + "'";
  const result = scrubSecrets(input);
  assert.ok(!result.text.includes("AIzaB"));
  assert.ok(result.text.includes("<REDACTED-SECRET>"));
  assert.ok(result.hits >= 1);
});

test("16.6 scrubSecrets redacts Stripe live keys (sk/rk/pk live)", () => {
  const input = "sk_live_abcdefghijklmnop and rk_live_ABCDEFGHIJKLMNOP and pk_live_0123456789ABCDEF";
  const result = scrubSecrets(input);
  assert.ok(!result.text.includes("sk_live_abcdefghijklmnop"));
  assert.ok(!result.text.includes("rk_live_"));
  assert.ok(!result.text.includes("pk_live_"));
  assert.equal(result.hits, 3);
});

test("16.6 scrubSecrets redacts JWTs (three base64url segments separated by dots)", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJBbGljZSJ9.signaturepartXyZ";
  const result = scrubSecrets("Authorization: Bearer " + jwt);
  assert.ok(!result.text.includes(jwt));
  assert.ok(result.text.includes("<REDACTED-SECRET>"));
});

test("16.6 scrubSecrets redacts DB connection strings with embedded credentials", () => {
  const input =
    "DB=postgres://alice:hunter2@db.example.com:5432/app and " +
    "MONGO=mongodb+srv://u:p@cluster.mongodb.net/x and " +
    "MY=mysql://root:rootpw@localhost/db";
  const result = scrubSecrets(input);
  assert.ok(!result.text.includes("hunter2"));
  assert.ok(!result.text.includes(":p@"));
  assert.ok(!result.text.includes("rootpw"));
});

test("16.6 scrubSecrets redacts GitLab and npm tokens", () => {
  const input = "glpat-aaaaaaaaaaaaaaaaaaaa and npm_" + "a".repeat(36);
  const result = scrubSecrets(input);
  assert.ok(!result.text.includes("glpat-a"));
  assert.ok(!result.text.includes("npm_aaaaa"));
  assert.equal(result.hits, 2);
});

test("16.6 scrubSecrets generic UPPER_CASE_KEY=value catches misc env-style secrets", () => {
  const input =
    'MY_SERVICE_API="abc123xyz"\n' +
    "OTHER_TOKEN=plain-token-value\n" +
    "APP_PASSWORD='topsecret'\n" +
    "FOO_SECRET=hunter2";
  const result = scrubSecrets(input);
  // Each of the four lines should produce one hit.
  assert.ok(result.hits >= 4, `expected at least 4 hits, got ${result.hits}`);
  assert.ok(!result.text.includes("abc123xyz"));
  assert.ok(!result.text.includes("plain-token-value"));
  assert.ok(!result.text.includes("topsecret"));
  assert.ok(!result.text.includes("hunter2"));
});

test("issue #163 scrubSecrets catches bare PASSWORD=/TOKEN=/SECRET=/KEY=/API= without a prefix", () => {
  // Before #163, the SHOUTING_NAME=value rule used `[A-Z][A-Z0-9_]*`
  // (one-or-more), so an unqualified `PASSWORD=hunter2` slipped through
  // because no character preceded the suffix. The fix relaxes the
  // prefix to `[A-Z0-9_]*` (zero-or-more); the leading `\b` keeps it
  // anchored and prevents mid-identifier matches.
  const cases = [
    ["PASSWORD=hunter2", "hunter2"],
    ["TOKEN=ghp_xxx", "ghp_xxx"],
    ["SECRET=foo", "foo"],
    ["API=bar", "bar"],
    ["KEY=abc", "abc"],
  ];
  for (const [input, value] of cases) {
    const result = scrubSecrets(input);
    assert.ok(
      !result.text.includes(value),
      `bare suffix '${input}' should be redacted; got '${result.text}'`
    );
    assert.equal(result.hits, 1, `expected 1 hit for '${input}', got ${result.hits}`);
  }
});

test("issue #163 scrubSecrets still matches the qualified PREFIX_SUFFIX=value form", () => {
  // Regression guard: relaxing the prefix to `*` must not lose the
  // existing 16.6 behaviour for qualified env-style names.
  const result = scrubSecrets("DB_PASSWORD=baz API_TOKEN=qux MY_KEY=v");
  assert.ok(!result.text.includes("baz"));
  assert.ok(!result.text.includes("qux"));
  assert.equal(result.hits, 3);
});

test("issue #163 scrubSecrets does not fire mid-identifier (lowercase prefix blocks the boundary)", () => {
  // `\b` between two word characters is no boundary, so a lowercase
  // prefix like `myPASSWORD=foo` must NOT match. This guards against
  // a regression where a too-aggressive change drops `\b` entirely.
  const result = scrubSecrets("myPASSWORD=foo");
  assert.equal(result.hits, 0);
  assert.equal(result.text, "myPASSWORD=foo");
});

test("16.6 scrubSecrets handles a .env-style fixture with one of each new pattern", () => {
  // One representative value per new pattern. Total expected hits =
  // 7 distinct new-pattern matches in this fixture (Google, Stripe, JWT,
  // DB-conn, GitLab, npm, generic UPPER_KEY=). We verify that count
  // exactly so future drift is loud.
  const fixture = [
    "GOOGLE_API_KEY=AIza" + "C".repeat(35),
    "STRIPE=sk_live_abcdefghijklmnopqr",
    "JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.zzz",
    "DATABASE_URL=postgres://user:pass@host/db",
    "GITLAB_TOKEN=glpat-abcdefghijklmnopqrst",
    "NPM_TOKEN=npm_" + "z".repeat(36),
    "OTHER_SECRET=plain-value",
  ].join("\n");
  const result = scrubSecrets(fixture);
  // The generic UPPER_KEY= pattern overlaps with the targeted ones above
  // (e.g. STRIPE=…, GITLAB_TOKEN=…). The targeted patterns run first in
  // order, so each line resolves to exactly one redaction. Expect one
  // redaction marker per fixture line.
  const placeholders = (result.text.match(/<REDACTED-SECRET>/g) ?? []).length;
  assert.equal(placeholders, 7, `each line should produce one redaction; got ${placeholders} in: ${result.text}`);
  assert.ok(!result.text.includes("AIzaC"));
  assert.ok(!result.text.includes("sk_live_abc"));
  assert.ok(!result.text.includes("eyJhbGciOiJIUzI1NiJ9.eyJ"));
  assert.ok(!result.text.includes("user:pass@"));
  assert.ok(!result.text.includes("glpat-abc"));
  assert.ok(!result.text.includes("npm_zzz"));
  assert.ok(!result.text.includes("plain-value"));
});
