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

// Trigger comment recognition

// Positive cases — all four documented suffixes
const aiQ = engine.evaluateExplicit("char* p = malloc(n); // AI?");
check("// AI? trigger fires", "EXPLICIT_ASK", aiQ?.trigger ?? "");
check("// AI? user_question stripped", "char* p = malloc(n); //", aiQ?.userQuestion ?? "");

const aiBang = engine.evaluateExplicit("foo(bar); // AI!");
check("// AI! trigger fires", "EXPLICIT_ASK", aiBang?.trigger ?? "");

// Python-style # comment, since the regex only anchors on the suffix
const why = engine.evaluateExplicit("def add(a, b): # WHY?");
check("# WHY? trigger fires", "EXPLICIT_ASK", why?.trigger ?? "");

const stuck = engine.evaluateExplicit("for i in range(10): # STUCK");
check("# STUCK trigger fires", "EXPLICIT_ASK", stuck?.trigger ?? "");

// Trailing whitespace is allowed by the regex (`\s*$`)
const trailing = engine.evaluateExplicit("foo // AI?   ");
check("trailing whitespace still fires", "EXPLICIT_ASK", trailing?.trigger ?? "");

// Negative cases
const plain = engine.evaluateExplicit("normal line of code");
check("non-trigger line returns null", "null", plain === null ? "null" : plain.trigger);

const midline = engine.evaluateExplicit("// AI? but I keep going");
check("mid-line AI? does not fire", "null", midline === null ? "null" : midline.trigger);

const midlineWhy = engine.evaluateExplicit("WHY? did this break, see notes");
check("mid-line WHY? does not fire", "null", midlineWhy === null ? "null" : midlineWhy.trigger);

const lookalike = engine.evaluateExplicit("// FAIL");
check("non-keyword suffix does not fire", "null", lookalike === null ? "null" : lookalike.trigger);

const empty = engine.evaluateExplicit("");
check("empty line does not fire", "null", empty === null ? "null" : empty.trigger);

// === Task 1.4: focused STUCK_LOOP timing contract ===
// Each scenario uses a fresh engine + fresh clock to isolate the three
// conditions documented in the task: stuckMs > 90s, noEditMs > 60s, and
// the negative case where a recent edit (<60s) suppresses the fire.

// (A) Same diagnostic, 89s elapsed → must NOT fire (stuckMs <= 90s).
{
  let nowA = 1_000_000;
  const eA = new TriggerEngine(() => nowA);
  eA.noteEdit();
  eA.evaluateDiagnostics(uri, errs); // first sight, records firstSeen
  nowA += 89_000;                    // 89s later, same sig
  const rA = eA.evaluateDiagnostics(uri, errs);
  check("1.4 (A) 89s with same diag does NOT fire", "stuckMs=89s", rA.debug);
  check("1.4 (A) no event", "null", rA.event === null ? "null" : rA.event.trigger);
}

// (B) Same diagnostic, 91s elapsed, no edits since first sight → MUST fire.
{
  let nowB = 2_000_000;
  const eB = new TriggerEngine(() => nowB);
  eB.noteEdit();
  eB.evaluateDiagnostics(uri, errs); // first sight
  nowB += 91_000;                    // past both 90s stuck and 60s noEdit
  const rB = eB.evaluateDiagnostics(uri, errs);
  check("1.4 (B) >90s with no edit fires", "FIRE", rB.debug);
  check("1.4 (B) STUCK_LOOP event", "STUCK_LOOP", rB.event?.trigger ?? "");
}

// (C) Same diagnostic, >90s elapsed, but a fresh edit landed within 60s →
//     must NOT fire (held by noEditMs).
{
  let nowC = 3_000_000;
  const eC = new TriggerEngine(() => nowC);
  eC.noteEdit();
  eC.evaluateDiagnostics(uri, errs); // first sight
  nowC += 91_000;                    // 91s elapsed total
  eC.noteEdit();                     // fresh edit right now → noEditMs == 0
  const rC = eC.evaluateDiagnostics(uri, errs);
  check("1.4 (C) recent edit holds despite 91s stuck", "noEditMs=0s<=60", rC.debug);
  check("1.4 (C) no event", "null", rC.event === null ? "null" : rC.event.trigger);
}

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
