// Task 11.5: per-turn telemetry tests.
//
// Spec: "one full turn appends one line with all fields populated."
// Plus edge cases: Haiku-only turn, upfront-Sonnet turn, USD math,
// JSONL append semantics.
//
// Run: node --test daemon/test/turn-telemetry.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  TurnTelemetry,
  estimateUsd,
  PRICING_USD_PER_MTOK,
} = await import("../dist/turn-telemetry.js");

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-11.5-"));
  return join(dir, "turns.jsonl");
}

test("11.5 one full turn appends one line with all fields populated", () => {
  // "Full turn" = both tiers ran (Haiku flagged escalate, Sonnet
  // produced the reply), all metadata dimensions set.
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  const entry = tel.record({
    ts: 1_700_000_000_000,
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: {
      input_tokens: 200,
      output_tokens: 8,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 0,
    },
    sonnetModel: "claude-sonnet-4-6",
    sonnetUsage: {
      input_tokens: 1500,
      output_tokens: 120,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    },
    routerReason: "haiku_flagged_escalate",
    endToEndMs: 1240,
    wakeWord: "hey buddy",
    personality: "drill_sergeant",
    mode: "tutor",
  });

  // File contains exactly one line.
  assert.ok(existsSync(path));
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);

  // Each spec'd field is present and populated (not the default).
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, entry);

  // Spec dimensions
  assert.equal(parsed.method, "turn");
  assert.equal(parsed.haiku_tier, true);
  assert.equal(parsed.sonnet_tier, true);
  assert.equal(parsed.router_reason, "haiku_flagged_escalate");
  // Tokens — both per-tier and aggregated.
  assert.equal(parsed.haiku_input_tokens, 200);
  assert.equal(parsed.haiku_output_tokens, 8);
  assert.equal(parsed.haiku_cache_read_input_tokens, 50);
  assert.equal(parsed.sonnet_input_tokens, 1500);
  assert.equal(parsed.sonnet_output_tokens, 120);
  assert.equal(parsed.input_tokens, 200 + 1500);
  assert.equal(parsed.output_tokens, 8 + 120);
  assert.equal(parsed.cache_read_input_tokens, 50 + 800);
  assert.equal(parsed.cache_creation_input_tokens, 0 + 100);
  // USD non-zero, latency, models, buddy state
  assert.ok(parsed.usd_estimate > 0);
  assert.equal(parsed.end_to_end_ms, 1240);
  assert.equal(parsed.haiku_model, "claude-haiku-4-5-20251001");
  assert.equal(parsed.sonnet_model, "claude-sonnet-4-6");
  assert.equal(parsed.wake_word, "hey buddy");
  assert.equal(parsed.personality, "drill_sergeant");
  assert.equal(parsed.mode, "tutor");
  assert.equal(parsed.ts, 1_700_000_000_000);
});

test("11.5 Haiku-only turn (no escalation): sonnet_tier=false, sonnet fields zero/null", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  const entry = tel.record({
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: { input_tokens: 80, output_tokens: 12 },
    routerReason: "no_escalation",
    endToEndMs: 380,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });

  assert.equal(entry.haiku_tier, true);
  assert.equal(entry.sonnet_tier, false);
  assert.equal(entry.sonnet_model, null);
  assert.equal(entry.sonnet_input_tokens, 0);
  assert.equal(entry.sonnet_output_tokens, 0);
  assert.equal(entry.sonnet_cache_read_input_tokens, 0);
  assert.equal(entry.sonnet_cache_creation_input_tokens, 0);
  // Aggregated tokens reflect Haiku-only.
  assert.equal(entry.input_tokens, 80);
  assert.equal(entry.output_tokens, 12);
});

test("11.5 upfront-escalation turn (Haiku skipped): haiku_tier=false", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  const entry = tel.record({
    sonnetModel: "claude-sonnet-4-6",
    sonnetUsage: { input_tokens: 800, output_tokens: 200 },
    routerReason: "trigger=EXPLICIT_ASK",
    endToEndMs: 980,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });

  assert.equal(entry.haiku_tier, false);
  assert.equal(entry.sonnet_tier, true);
  assert.equal(entry.haiku_model, null);
  assert.equal(entry.haiku_input_tokens, 0);
  assert.equal(entry.haiku_output_tokens, 0);
  assert.equal(entry.input_tokens, 800);
  assert.equal(entry.output_tokens, 200);
});

test("11.5 multiple turns append multiple lines (JSONL semantics)", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  for (let i = 0; i < 3; i++) {
    tel.record({
      haikuModel: "claude-haiku-4-5-20251001",
      haikuUsage: { input_tokens: 10, output_tokens: 5 },
      routerReason: "no_escalation",
      endToEndMs: 100 + i,
      wakeWord: "off",
      personality: "nice",
      mode: "tutor",
    });
  }

  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  // Each line is independently valid JSON.
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.equal(obj.method, "turn");
  }
});

test("11.5 USD estimate matches the documented pricing formula", () => {
  // Sonnet 4.6 turn: 1M input + 1M output should cost
  //   1 * input_rate + 1 * output_rate.
  const sonnetRate = PRICING_USD_PER_MTOK["claude-sonnet-4-6"];
  const usd = estimateUsd("claude-sonnet-4-6", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  // Floating-point tolerance: within 1e-6.
  assert.ok(Math.abs(usd - (sonnetRate.input + sonnetRate.output)) < 1e-6);

  // Cache reads are charged at cache_read rate.
  const cacheUsd = estimateUsd("claude-sonnet-4-6", {
    input_tokens: 0,
    cache_read_input_tokens: 1_000_000,
  });
  assert.ok(Math.abs(cacheUsd - sonnetRate.cache_read) < 1e-6);

  // Cache creation at cache_creation rate.
  const createUsd = estimateUsd("claude-sonnet-4-6", {
    input_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
  });
  assert.ok(Math.abs(createUsd - sonnetRate.cache_creation) < 1e-6);

  // Unknown model falls back to default rates (not zero).
  const fallbackUsd = estimateUsd("some-future-model", {
    input_tokens: 1_000_000,
  });
  assert.ok(fallbackUsd > 0);
});

// Task 16.7(c): local Ollama-shaped model ids price at $0.
test("16.7 estimateUsd returns $0 for Ollama-shaped local model ids", () => {
  // qwen2.5-coder:32b — the daemon's DEFAULT_OLLAMA_MODEL.
  const qwenUsd = estimateUsd("qwen2.5-coder:32b", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  assert.equal(qwenUsd, 0, "qwen local model should be free");

  // Other common Ollama model shapes.
  for (const id of ["llama3.1:8b", "mistral:7b", "gemma2:27b"]) {
    const usd = estimateUsd(id, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    assert.equal(usd, 0, `${id} should price at $0`);
  }
});

test("16.7 turn record with Ollama model has usd_estimate=0", () => {
  // A turn that ran entirely on a local model: the resulting record
  // should report $0, not the Sonnet-fallback fictional dollar amount.
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const entry = tel.record({
    sonnetModel: "qwen2.5-coder:32b",
    sonnetUsage: { input_tokens: 5_000, output_tokens: 800 },
    routerReason: "trigger=EXPLICIT_ASK",
    endToEndMs: 2200,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });
  assert.equal(entry.usd_estimate, 0);
});

test("11.5 USD estimate sums across tiers in a single turn", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  const entry = tel.record({
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: { input_tokens: 1_000_000, output_tokens: 0 },
    sonnetModel: "claude-sonnet-4-6",
    sonnetUsage: { input_tokens: 1_000_000, output_tokens: 0 },
    routerReason: "haiku_flagged_escalate",
    endToEndMs: 1500,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });

  const haikuInput = PRICING_USD_PER_MTOK["claude-haiku-4-5-20251001"].input;
  const sonnetInput = PRICING_USD_PER_MTOK["claude-sonnet-4-6"].input;
  // 1M input * (haiku rate + sonnet rate) = sum.
  assert.ok(
    Math.abs(entry.usd_estimate - (haikuInput + sonnetInput)) < 1e-6,
    `expected haiku($${haikuInput}) + sonnet($${sonnetInput}) ≈ ${entry.usd_estimate}`
  );
});

test("11.5 read() round-trips written entries", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  // No entries yet — empty file.
  assert.deepEqual(tel.read(), []);

  const e1 = tel.record({
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: { input_tokens: 50, output_tokens: 10 },
    routerReason: "no_escalation",
    endToEndMs: 200,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });
  const e2 = tel.record({
    sonnetModel: "claude-sonnet-4-6",
    sonnetUsage: { input_tokens: 1000, output_tokens: 100 },
    routerReason: "trigger=EXPLICIT_ASK",
    endToEndMs: 800,
    wakeWord: "off",
    personality: "nice",
    mode: "reviewer",
  });

  const all = tel.read();
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], e1);
  assert.deepEqual(all[1], e2);
});

test("11.5 disk-write failure does not throw (matches Telemetry contract)", () => {
  // Point at a file inside a non-existent and unwritable path.
  // mkdirSync recursive should create it for any reasonable temp
  // location, so we instead break the append by passing a directory
  // path as the file (appendFileSync to a directory throws on every
  // platform). The constructor's recursive mkdir handles that fine
  // (the directory already exists). The record() call is what hits
  // the broken path.
  const dir = mkdtempSync(join(tmpdir(), "buddy-11.5-fail-"));
  const tel = new TurnTelemetry(dir); // file path == directory path

  // Should NOT throw.
  assert.doesNotThrow(() =>
    tel.record({
      haikuModel: "claude-haiku-4-5-20251001",
      haikuUsage: { input_tokens: 1, output_tokens: 1 },
      routerReason: "no_escalation",
      endToEndMs: 100,
      wakeWord: "off",
      personality: "nice",
      mode: "tutor",
    })
  );
});

// Issue #141: a single malformed JSONL line must not nuke the whole
// read — DailyCostCap.safeRead falls back to [] on any throw, which
// silently disables the cap. Per-line tolerance (mirroring
// MemoryStore.loadRecent) keeps the cap working on the surviving
// lines.
test("#141 read() skips malformed lines instead of throwing", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);

  // Write one good entry, then a corrupt line, then another good
  // entry — simulating a mid-write crash between two clean records.
  const good1 = tel.record({
    haikuModel: "claude-haiku-4-5-20251001",
    haikuUsage: { input_tokens: 10, output_tokens: 2 },
    routerReason: "no_escalation",
    endToEndMs: 100,
    wakeWord: "off",
    personality: "nice",
    mode: "tutor",
  });
  appendFileSync(path, "this is not json\n", "utf8");
  const good2 = tel.record({
    sonnetModel: "claude-sonnet-4-6",
    sonnetUsage: { input_tokens: 500, output_tokens: 50 },
    routerReason: "trigger=EXPLICIT_ASK",
    endToEndMs: 800,
    wakeWord: "off",
    personality: "nice",
    mode: "reviewer",
  });

  // Must not throw, must return the two good entries in order.
  const entries = tel.read();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], good1);
  assert.deepEqual(entries[1], good2);
});

test("#141 read() of an entirely corrupt file returns [] without throwing", () => {
  const path = tempPath();
  // No good lines at all — pre-existing turns.jsonl from a future
  // schema migration, or a fully truncated file.
  writeFileSync(path, "garbage\n{not really json\n[]not-json\n", "utf8");
  const tel = new TurnTelemetry(path);
  assert.doesNotThrow(() => tel.read());
  assert.deepEqual(tel.read(), []);
});

test("16.19 readTail returns empty for missing file and zero maxBytes", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  // No file yet.
  assert.deepEqual(tel.readTail(1024), []);
  // File present but maxBytes=0 → no read at all.
  appendFileSync(
    path,
    JSON.stringify({ ts: 1, usd_estimate: 0.01 }) + "\n",
    "utf8"
  );
  assert.deepEqual(tel.readTail(0), []);
});

test("16.19 readTail with budget covering the whole file matches read()", () => {
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  for (let i = 0; i < 5; i++) {
    appendFileSync(
      path,
      JSON.stringify({ ts: 1_000 + i, usd_estimate: i / 100 }) + "\n",
      "utf8"
    );
  }
  const all = tel.read();
  const tail = tel.readTail(1024 * 1024);
  assert.deepEqual(tail, all);
});

test("16.19 readTail trims older entries when bytes are capped", () => {
  // Construct entries where each line is >= 50 bytes; cap at ~120
  // bytes so only the last 1-2 lines fit. The leading partial-line
  // boundary must be dropped, not parsed as malformed.
  const path = tempPath();
  const tel = new TurnTelemetry(path);
  const lineFor = (i) =>
    JSON.stringify({
      ts: 1_700_000_000_000 + i,
      idx: i,
      pad: "x".repeat(40),
    }) + "\n";
  for (let i = 0; i < 50; i++) appendFileSync(path, lineFor(i), "utf8");

  const fullCount = tel.read().length;
  assert.equal(fullCount, 50);

  // Capture stderr-dropped malformed warnings — the tail must NOT log
  // a "skipped malformed line" for the partial leading line.
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let tail;
  try {
    tail = tel.readTail(120);
  } finally {
    console.error = origErr;
  }
  assert.ok(tail.length >= 1, "should return at least one trailing entry");
  assert.ok(tail.length < fullCount, "should not return all entries");
  // Whatever it returned, the indices must come from the END of the
  // file — i.e. the largest possible idx values.
  for (const e of tail) {
    assert.ok(e.idx >= fullCount - tail.length - 1);
  }
  assert.deepEqual(
    errs.filter((m) => m.includes("malformed")),
    [],
    "no malformed-line warnings expected"
  );
});

test("16.19 readTail ignores partial leading line", () => {
  // First "line" in the byte window is partial — JSON.parse would
  // throw on it. The implementation must drop it silently.
  const path = tempPath();
  // Build a file where the byte cap lands mid-line: first record is
  // long, second short. Cap < first record's size so the window
  // starts inside record 1.
  const tel = new TurnTelemetry(path);
  appendFileSync(
    path,
    JSON.stringify({ ts: 1, idx: 1, pad: "y".repeat(200) }) + "\n",
    "utf8"
  );
  appendFileSync(path, JSON.stringify({ ts: 2, idx: 2 }) + "\n", "utf8");
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let tail;
  try {
    tail = tel.readTail(80);
  } finally {
    console.error = origErr;
  }
  // Only the second (short) record fits cleanly after dropping the
  // mid-line partial.
  assert.deepEqual(tail.map((e) => e.idx), [2]);
  assert.deepEqual(
    errs.filter((m) => m.includes("malformed")),
    []
  );
});

test("11.5 lives under ~/.coding-buddy/ by default", async () => {
  const { DEFAULT_TURN_TELEMETRY_PATH } = await import(
    "../dist/turn-telemetry.js"
  );
  // Cross-platform: just assert the suffix matches the contract.
  assert.match(
    DEFAULT_TURN_TELEMETRY_PATH.replace(/\\/g, "/"),
    /\.coding-buddy\/turns\.jsonl$/
  );
});
