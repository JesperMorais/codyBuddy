#!/usr/bin/env node
/**
 * scripts/gen-changelog.mjs
 *
 * Builds CHANGELOG.md from git log in Keep-a-Changelog format
 * (https://keepachangelog.com/en/1.1.0/). All commits land under
 * [Unreleased] until the project starts cutting tagged releases.
 *
 * Categorisation by commit subject prefix:
 *   - "Task N.M: …"   → Added (most product work)
 *   - "Plan: …"       → Added (backlog extensions)
 *   - "Fix:" / "fix:" → Fixed
 *   - "Refactor:"     → Changed
 *   - everything else → Notes (still listed, just unsorted)
 *
 * Run: node scripts/gen-changelog.mjs           # writes ./CHANGELOG.md
 *      node scripts/gen-changelog.mjs --check   # exit 1 if file is stale
 *      node scripts/gen-changelog.mjs --stdout  # print, don't write
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outPath = resolve(repoRoot, "CHANGELOG.md");
const SEP = "";

export function readCommits() {
  const raw = execFileSync(
    "git",
    ["log", "--reverse", `--pretty=format:%h${SEP}%s`],
    { cwd: repoRoot, encoding: "utf8" }
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(SEP);
      if (idx === -1) return { hash: line, subject: "" };
      return { hash: line.slice(0, idx), subject: line.slice(idx + 1) };
    });
}

export function categorize(commits) {
  const added = [];
  const changed = [];
  const fixed = [];
  const notes = [];
  for (const c of commits) {
    const s = c.subject;
    if (/^Task\s+\d+\.\d+/i.test(s)) added.push(c);
    else if (/^Plan:/i.test(s)) added.push(c);
    else if (/^Fix(?:up)?[:\s]|^fix(?:up)?:/i.test(s)) fixed.push(c);
    else if (/^Refactor[:\s]/i.test(s)) changed.push(c);
    else notes.push(c);
  }
  return { added, changed, fixed, notes };
}

function renderSection(label, items) {
  if (items.length === 0) return "";
  const lines = items.map((c) => `- ${c.subject} (${c.hash})`);
  return `### ${label}\n${lines.join("\n")}`;
}

export function render(sections) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    "# Changelog",
    "",
    "All notable changes to this project are documented here.",
    "",
    "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),",
    "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).",
    "Generated from `git log` by `scripts/gen-changelog.mjs`.",
    "",
    `## [Unreleased] — generated ${today}`,
  ];
  for (const block of [
    renderSection("Added", sections.added),
    renderSection("Changed", sections.changed),
    renderSection("Fixed", sections.fixed),
    renderSection("Notes", sections.notes),
  ]) {
    if (block) {
      parts.push("");
      parts.push(block);
    }
  }
  return parts.join("\n").trimEnd() + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const stdout = args.includes("--stdout");

  const commits = readCommits();
  const sections = categorize(commits);
  const next = render(sections);

  if (stdout) {
    process.stdout.write(next);
    return;
  }

  if (check) {
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    // Compare ignoring the "generated YYYY-MM-DD" date so a CI run on a
    // different day doesn't spuriously fail on an otherwise-current file.
    const stripDate = (s) => s.replace(/generated \d{4}-\d{2}-\d{2}/, "generated <date>");
    if (stripDate(current) !== stripDate(next)) {
      process.stderr.write(
        "CHANGELOG.md is stale. Run `pnpm changelog` and commit the result.\n"
      );
      process.exit(1);
    }
    return;
  }

  writeFileSync(outPath, next, "utf8");
  process.stderr.write(`Wrote ${outPath} (${commits.length} commits)\n`);
}

const isMain = import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isMain) main();
