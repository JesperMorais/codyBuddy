// Preview what a code-heavy reply sounds like after the speech transform.
// Run: node daemon/test/speech-strip.test.mjs
//
// We import via a sneaky route: the live transforms live inside tts-bridge.ts
// (private). For this test, we duplicate them. If they drift, this test
// stops being a faithful preview — keep them in sync when editing tts-bridge.

function naturalizeCode(code) {
  let t = code;
  t = t.replace(/'\\0'/g, " null terminator ");
  t = t.replace(/"\\0"/g, " null terminator ");
  t = t.replace(/'\\n'/g, " newline character ");
  t = t.replace(/\\n/g, " newline ");
  t = t.replace(/\\t/g, " tab ");
  t = t.replace(/\bNULL\b/g, "null");
  t = t.replace(/->/g, " arrow ");
  t = t.replace(/::/g, " scope ");
  t = t.replace(/==/g, " equals ");
  t = t.replace(/!=/g, " not equals ");
  t = t.replace(/<=/g, " less or equal ");
  t = t.replace(/>=/g, " greater or equal ");
  t = t.replace(/&&/g, " and ");
  t = t.replace(/\|\|/g, " or ");
  t = t.replace(/(?<![=!<>])=(?!=)/g, " equals ");
  t = t.replace(/\+\+/g, " plus plus ");
  t = t.replace(/--/g, " minus minus ");
  t = t.replace(/\+/g, " plus ");
  t = t.replace(/(\w)\s*-\s*(\w)/g, "$1 minus $2");
  t = t.replace(/(\w)\s*<\s*(\w)/g, "$1 less than $2");
  t = t.replace(/(\w)\s*>\s*(\w)/g, "$1 greater than $2");
  t = t.replace(/\*/g, " ");
  t = t.replace(/&/g, " and ");
  t = t.replace(/\/\//g, ", comment, ");
  t = t.replace(/[{}\[\]<>|]/g, " ");
  t = t.replace(/[;,]/g, ", ");
  t = t.replace(/_/g, " ");
  t = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/[ \t]+/g, " ").trim();
  return t;
}

function stripForSpeech(src) {
  let t = src;
  t = t.replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => " " + naturalizeCode(code) + " ");
  t = t.replace(/`([^`\n]+)`/g, (_, code) => " " + naturalizeCode(code) + " ");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/_([^_\n]+)_/g, "$1");
  t = t.replace(/^#+\s*/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  t = t.replace(/`+/g, " ");
  t = t.replace(/\*+/g, " ");
  t = t.replace(/[—–]/g, ", ");
  t = t.replace(/…/g, ".");
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/\.\s*\.\s*/g, ". ");
  t = t.replace(/[ \t]+/g, " ").trim();
  if (t.length > 800) t = t.slice(0, 800) + ".";
  return t;
}

const samples = [
  "You allocate `malloc(numberOfChar)` but write `captha[numberOfChar] = '\\0'` — that's an off-by-one.",
  "Try:\n```c\nchar* captha = malloc(numberOfChar + 1);\nfor (int i = 0; i < numberOfChar; i++) captha[i] = 'a';\n```\nThat fixes it.",
  "**Critical:** `userinput` is uninitialized; `scanf(\"%s\", userinput)` writes to a random address.",
  "Use `if (x == NULL) return -1;` to guard against null pointers.",
  "Names like `numberOfChar`, `MAX_SIZE`, `my_var` get split on case/underscore.",
];

for (const s of samples) {
  console.log("INPUT  :", s);
  console.log("SPOKEN :", stripForSpeech(s));
  console.log();
}
