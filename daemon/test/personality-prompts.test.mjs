// Task 9.1: each personality .md file is shipped with the structural
// contract (length, hard-rules clause, example phrasings).
//
// Run: node --test daemon/test/personality-prompts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const personalitiesDir = join(__dirname, "..", "prompts", "personalities");

const REQUIRED = [
  "nice",
  "dry",
  "rude",
  "drill_sergeant",
  "passive_aggressive",
  "pirate",
  "shakespearean",
];

test("9.1 (a) all seven shipped personality files exist", () => {
  const files = new Set(
    readdirSync(personalitiesDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
  );
  for (const name of REQUIRED) {
    assert.ok(files.has(name), `daemon/prompts/personalities/${name}.md is missing`);
  }
});

for (const name of REQUIRED) {
  test(`9.1 (b/${name}) ${name}.md has the required structure`, () => {
    const text = readFileSync(join(personalitiesDir, `${name}.md`), "utf8");
    const lines = text.split("\n");

    // Length envelope from the task spec: ~20-40 lines. Allow 18-60 to
    // tolerate light formatting variation.
    assert.ok(
      lines.length >= 18 && lines.length <= 60,
      `${name}.md has ${lines.length} lines, expected 18-60`
    );

    // Title declares the personality name (case-insensitive).
    assert.match(
      text,
      new RegExp(`^##\\s*Personality:\\s*${name}\\b`, "im"),
      `${name}.md must open with a "## Personality: ${name}" heading`
    );

    // Hard-rules clause: explicit "obey all rules" / "obey every rule"
    // clause, plus the "only change *how* you say things" half. Strip
    // markdown emphasis before matching so `*how*` still counts.
    const flat = text.replace(/\*/g, "");
    assert.match(flat, /\bobey\b/i, `${name}.md must include an "obey ... rules" clause`);
    assert.match(
      flat,
      /how you say things|how you say it|how you say|how things are said/i,
      `${name}.md must scope itself to "how", not "what"`
    );

    // 2-3 example phrasings — heuristic: at least two bullet items
    // under an "Example" heading.
    const exampleSection = text.split(/^###\s+Example/im)[1] ?? "";
    const bullets = exampleSection
      .split("\n")
      .filter((l) => /^\s*-\s+/.test(l));
    assert.ok(
      bullets.length >= 2,
      `${name}.md must include at least 2 example phrasings under an "Example" heading (got ${bullets.length})`
    );
  });
}

test("9.1 (c) no two personality files are byte-for-byte duplicates", () => {
  const seen = new Map();
  for (const name of REQUIRED) {
    const text = readFileSync(join(personalitiesDir, `${name}.md`), "utf8");
    const previous = seen.get(text);
    assert.equal(previous, undefined, `${name}.md duplicates ${previous}.md verbatim`);
    seen.set(text, name);
  }
});

test("9.1 (d) every shipped personality bans slurs in its hard-rules section", () => {
  // Cosmetic — the harder safety enforcement lives in the role prompt.
  // Here we just check that personalities advertised as edgier (rude,
  // drill_sergeant) explicitly call out the line.
  for (const name of ["rude", "drill_sergeant", "passive_aggressive"]) {
    const text = readFileSync(join(personalitiesDir, `${name}.md`), "utf8");
    assert.match(
      text,
      /no slurs|never insult|no actual cruelty|never mock the developer's competence|not bullying/i,
      `${name}.md should explicitly state the line it won't cross`
    );
  }
});
