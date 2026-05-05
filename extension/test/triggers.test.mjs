// Unit test for TriggerEngine. Runs without VS Code.
// Run: node extension/test/triggers.test.mjs

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

let now = 1_000_000;
const clock = () => now;
const advance = (ms) => {
  now += ms;
};

const uri = { toString: () => "file:///cee/hello.c", path: "/cee/hello.c" };
const errs = [
  { severity: 0, range: { start: { line: 17 } }, message: "expected ;" },
  { severity: 0, range: { start: { line: 18 } }, message: "expected expression" },
  { severity: 0, range: { start: { line: 22 } }, message: "use of undeclared identifier" },
];

const results = [];
let pass = 0;
let fail = 0;
function check(label, want, got) {
  const ok = got.includes(want);
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}  → ${got}`);
  ok ? pass++ : fail++;
}

const engine = new TriggerEngine(clock);

engine.noteEdit();

// t=0: errors first appear
let r = engine.evaluateDiagnostics(uri, errs);
check("t=0   first sight of errors", "new sig", r.debug);

// t=30s: still stuck, but only 30s elapsed and recent edit
advance(30_000);
r = engine.evaluateDiagnostics(uri, errs);
check("t=30s  not yet stuck enough", "stuckMs=30s<=90", r.debug);

// t=70s: 70s stuck, 70s no edit (passes 60s) but still <90s stuck
advance(40_000);
r = engine.evaluateDiagnostics(uri, errs);
check("t=70s  still under 90s threshold", "stuckMs=70s<=90", r.debug);

// t=120s: 120s stuck, 120s no edit → should FIRE
advance(50_000);
r = engine.evaluateDiagnostics(uri, errs);
check("t=120s STUCK_LOOP fires", "FIRE", r.debug);
if (r.event) {
  check("        event payload", "STUCK_LOOP", r.event.trigger);
}

// After firing, mark spoken so canSpeakAgain logic kicks in
engine.noteSpoken();

// t=130s: just spoke, even though stuck still true, should hold on sinceSpoken
advance(10_000);
r = engine.evaluateDiagnostics(uri, errs);
check("t=130s suppress while spoken-recently", "sinceSpoken=10s<=60", r.debug);

// User edits → resets noEdit timer; even with long elapsed, should hold on noEdit
advance(200_000);
engine.noteEdit();
r = engine.evaluateDiagnostics(uri, errs);
check("t=330s after fresh edit, hold on noEdit", "noEditMs=0s<=60", r.debug);

// Errors disappear → state resets
r = engine.evaluateDiagnostics(uri, []);
check("clean: no errors", "no errors", r.debug);

// Trigger comment recognition — all four suffixes
const ev = engine.evaluateExplicit("char* p = malloc(n); // AI?");
check("trigger suffix  AI?",  "EXPLICIT_ASK", ev?.trigger ?? "");

const evAIBang = engine.evaluateExplicit("int x = getVal(); // AI!");
check("trigger suffix  AI!",  "EXPLICIT_ASK", evAIBang?.trigger ?? "");

const evWHY = engine.evaluateExplicit("return result * 2; // WHY?");
check("trigger suffix  WHY?", "EXPLICIT_ASK", evWHY?.trigger ?? "");

const evSTUCK = engine.evaluateExplicit("while (queue.length) { // STUCK");
check("trigger suffix  STUCK","EXPLICIT_ASK", evSTUCK?.trigger ?? "");

// Negative: no trigger keyword anywhere
const ev2 = engine.evaluateExplicit("normal line of code");
check("no trigger keyword", "null", ev2 === null ? "null" : "not-null");

// Negative: trigger keyword appears mid-line (not at line end)
const evMidAI = engine.evaluateExplicit("if (x === 0) { /* AI? */ doSomething(); }");
check("AI? mid-line does not trigger", "null", evMidAI === null ? "null" : "not-null");

const evMidWHY = engine.evaluateExplicit("// WHY? I chose this approach, let me explain.");
check("WHY? mid-line does not trigger", "null", evMidWHY === null ? "null" : "not-null");

const evMidSTUCK = engine.evaluateExplicit("// STUCK between two words here");
check("STUCK mid-line does not trigger", "null", evMidSTUCK === null ? "null" : "not-null");

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
