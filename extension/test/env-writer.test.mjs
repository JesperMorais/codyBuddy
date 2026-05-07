// Task 15.8: env-writer tests.
//
// applyEnvUpdates / updateEnvFile must be a) idempotent, b)
// preserve everything we don't touch (comments, ordering,
// other keys), and c) handle three input states for any given
// key: live (`KEY=val`), commented out (`# KEY=val`), or absent.
//
// Run: node --test extension/test/env-writer.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyEnvUpdates, updateEnvFile } = require("../out/env-writer.js");

function tempEnvPath(content = "") {
  const dir = mkdtempSync(join(tmpdir(), "buddy-15.8-"));
  const path = join(dir, ".env");
  if (content) writeFileSync(path, content);
  return path;
}

test("15.8 applyEnvUpdates: appends keys when absent", () => {
  const out = applyEnvUpdates(
    "BUDDY_PROVIDER=anthropic\n",
    { BUDDY_AUDIO_INPUT_ID: "mic1", BUDDY_AUDIO_OUTPUT_ID: "spk1" }
  );
  assert.match(out, /^BUDDY_PROVIDER=anthropic$/m);
  assert.match(out, /^BUDDY_AUDIO_INPUT_ID=mic1$/m);
  assert.match(out, /^BUDDY_AUDIO_OUTPUT_ID=spk1$/m);
  // Trailing newline preserved.
  assert.equal(out.endsWith("\n"), true);
});

test("15.8 applyEnvUpdates: replaces live keys in place", () => {
  const out = applyEnvUpdates(
    "FOO=bar\nBUDDY_AUDIO_INPUT_ID=oldmic\nBAZ=qux\n",
    { BUDDY_AUDIO_INPUT_ID: "newmic" }
  );
  assert.match(out, /^FOO=bar$/m);
  assert.match(out, /^BUDDY_AUDIO_INPUT_ID=newmic$/m);
  assert.match(out, /^BAZ=qux$/m);
  assert.doesNotMatch(out, /oldmic/);
  // Lines stayed in original order.
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "FOO=bar");
  assert.equal(lines[1], "BUDDY_AUDIO_INPUT_ID=newmic");
  assert.equal(lines[2], "BAZ=qux");
});

test("15.8 applyEnvUpdates: uncomments + sets value when key is commented out", () => {
  const out = applyEnvUpdates(
    "# BUDDY_AUDIO_INPUT_ID=placeholder\n",
    { BUDDY_AUDIO_INPUT_ID: "mic-2" }
  );
  assert.match(out, /^BUDDY_AUDIO_INPUT_ID=mic-2$/m);
  assert.doesNotMatch(out, /^# BUDDY_AUDIO_INPUT_ID=/m);
});

test("15.8 applyEnvUpdates: handles tight `#KEY=` (no space after hash)", () => {
  const out = applyEnvUpdates(
    "#BUDDY_AUDIO_OUTPUT_ID=foo\n",
    { BUDDY_AUDIO_OUTPUT_ID: "spk-99" }
  );
  assert.match(out, /^BUDDY_AUDIO_OUTPUT_ID=spk-99$/m);
});

test("15.8 applyEnvUpdates: idempotent — second run with same updates is a no-op", () => {
  const start = "FOO=bar\nBUDDY_AUDIO_INPUT_ID=mic1\n";
  const once = applyEnvUpdates(start, { BUDDY_AUDIO_INPUT_ID: "mic1" });
  const twice = applyEnvUpdates(once, { BUDDY_AUDIO_INPUT_ID: "mic1" });
  assert.equal(once, twice);
});

test("15.8 applyEnvUpdates: preserves comments and blank lines", () => {
  const start = `# top comment

BUDDY_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-real

# audio
# BUDDY_AUDIO_INPUT_ID=oldhint
`;
  const out = applyEnvUpdates(start, {
    BUDDY_AUDIO_INPUT_ID: "newmic",
    BUDDY_AUDIO_OUTPUT_ID: "newspk",
  });
  // Comments above are preserved.
  assert.match(out, /^# top comment$/m);
  assert.match(out, /^# audio$/m);
  // Other keys untouched.
  assert.match(out, /^BUDDY_PROVIDER=anthropic$/m);
  assert.match(out, /^ANTHROPIC_API_KEY=sk-ant-real$/m);
  // Audio inputs landed.
  assert.match(out, /^BUDDY_AUDIO_INPUT_ID=newmic$/m);
  assert.match(out, /^BUDDY_AUDIO_OUTPUT_ID=newspk$/m);
});

test("15.8 applyEnvUpdates: empty starting content gets keys appended", () => {
  const out = applyEnvUpdates("", { BUDDY_AUDIO_INPUT_ID: "mic" });
  assert.match(out, /^BUDDY_AUDIO_INPUT_ID=mic$/m);
});

test("15.8 updateEnvFile: writes the file (creates it if missing) and returns content", () => {
  const path = tempEnvPath();
  const content = updateEnvFile(path, {
    BUDDY_AUDIO_INPUT_ID: "mic-42",
    BUDDY_AUDIO_OUTPUT_ID: "spk-42",
  });
  const onDisk = readFileSync(path, "utf8");
  assert.equal(content, onDisk);
  assert.match(onDisk, /^BUDDY_AUDIO_INPUT_ID=mic-42$/m);
  assert.match(onDisk, /^BUDDY_AUDIO_OUTPUT_ID=spk-42$/m);
});

test("15.8 spec: stubbed device list updates .env with chosen IDs", () => {
  // The end-to-end contract from the spec — programmatic dispatch
  // with a stubbed device list, assert .env updates with the
  // selected ID. The picker's UI is wrapped in vscode APIs we
  // can't drive in node:test, so this exercises the underlying
  // helper directly with the values the picker would pass in.
  const path = tempEnvPath("BUDDY_PROVIDER=anthropic\n");
  const stubbedSelection = {
    BUDDY_AUDIO_INPUT_ID: "alsa_input.usb-Blue_Microphones_Yeti",
    BUDDY_AUDIO_OUTPUT_ID: "alsa_output.platform-snd_aloop.0.analog-stereo",
  };
  updateEnvFile(path, stubbedSelection);
  const onDisk = readFileSync(path, "utf8");
  assert.match(
    onDisk,
    /^BUDDY_AUDIO_INPUT_ID=alsa_input\.usb-Blue_Microphones_Yeti$/m
  );
  assert.match(
    onDisk,
    /^BUDDY_AUDIO_OUTPUT_ID=alsa_output\.platform-snd_aloop\.0\.analog-stereo$/m
  );
});
