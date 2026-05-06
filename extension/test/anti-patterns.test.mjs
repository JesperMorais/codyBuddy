// Task 5.1: positive + negative coverage for the new ANTI_PATTERNS
// (Python mutable default arg, bare except; TypeScript `as any`, unawaited
// .then; generic while(true) with no break). Run via the existing
// vscode-mock harness so the test loads extension/out without VS Code.
//
// Run: node --test extension/test/anti-patterns.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

const fakeVscode = {
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
};
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

const { TriggerEngine } = require("../out/triggers.js");

// Use a clock past 60s so canSpeakAgain() is true on first call.
function freshEngine() {
  let now = 1_000_000;
  return new TriggerEngine(() => now);
}

function expectMatch(label, text, antiPatternName) {
  test(label, () => {
    const ev = freshEngine().evaluateMisconception(text);
    assert.ok(ev, `expected MISCONCEPTION for ${antiPatternName}, got null`);
    assert.equal(ev.trigger, "MISCONCEPTION");
    assert.match(ev.reason, new RegExp(antiPatternName));
  });
}

function expectMiss(label, text) {
  test(label, () => {
    const ev = freshEngine().evaluateMisconception(text);
    assert.equal(ev, null, `expected null, got ${JSON.stringify(ev)}`);
  });
}

// --------------------------------------------------------------------------
// Python: mutable default argument
// --------------------------------------------------------------------------
expectMatch(
  "py-mutable-default-arg fires on def foo(x=[])",
  "def append_one(items=[]):\n    items.append(1)\n    return items\n",
  "py-mutable-default-arg"
);
expectMatch(
  "py-mutable-default-arg fires on def foo(x={})",
  "def with_dict(cfg={}):\n    return cfg\n",
  "py-mutable-default-arg"
);
expectMiss(
  "py-mutable-default-arg does NOT fire on default None",
  "def append_one(items=None):\n    if items is None: items = []\n    return items\n"
);

// --------------------------------------------------------------------------
// Python: bare except
// --------------------------------------------------------------------------
expectMatch(
  "py-bare-except fires on bare `except:`",
  "try:\n    do_thing()\nexcept:\n    pass\n",
  "py-bare-except"
);
expectMiss(
  "py-bare-except does NOT fire on `except Exception:`",
  "try:\n    do_thing()\nexcept Exception:\n    pass\n"
);
expectMiss(
  "py-bare-except does NOT fire on `except (A, B) as e:`",
  "try:\n    x = 1\nexcept (ValueError, TypeError) as e:\n    print(e)\n"
);

// --------------------------------------------------------------------------
// TypeScript: as any
// --------------------------------------------------------------------------
expectMatch(
  "ts-as-any fires on `value as any`",
  "const x = something() as any;\n",
  "ts-as-any"
);
expectMiss(
  "ts-as-any does NOT fire on `as Anything` (different type)",
  "const x = something() as Anything;\n"
);

// --------------------------------------------------------------------------
// TypeScript: unawaited .then
// --------------------------------------------------------------------------
expectMatch(
  "ts-unawaited-then fires on bare `foo().then(...);`",
  "function go() {\n  doStuff().then(() => log('ok'));\n}\n",
  "ts-unawaited-then"
);
// Use a single-line async arrow so the existing `await-in-non-async`
// pattern (which lints per line) doesn't fire alongside.
expectMiss(
  "ts-unawaited-then does NOT fire on `await foo().then(...)`",
  "const go = async () => { await doStuff().then(cb); };\n"
);
expectMiss(
  "ts-unawaited-then does NOT fire on `return foo().then(...)`",
  "function go() {\n  return doStuff().then(cb);\n}\n"
);
expectMiss(
  "ts-unawaited-then does NOT fire on `void foo().then(...)`",
  "function go() {\n  void doStuff().then(cb);\n}\n"
);

// --------------------------------------------------------------------------
// Generic: while (true) without break
// --------------------------------------------------------------------------
expectMatch(
  "while-true-no-break fires when no break exists anywhere",
  "function loop() {\n  while (true) {\n    process();\n  }\n}\n",
  "while-true-no-break"
);
expectMiss(
  "while-true-no-break does NOT fire when a break exists",
  "function loop() {\n  while (true) {\n    if (done) break;\n    process();\n  }\n}\n"
);
expectMiss(
  "while-true-no-break does NOT fire on `while (cond)` non-true loops",
  "function loop() {\n  while (cond) {\n    process();\n  }\n}\n"
);
