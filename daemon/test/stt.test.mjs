// #89: when whisper isn't configured, the "not configured" error must
// point Linux/macOS users at setup-whisper.sh too — not only the
// Windows-only setup-whisper.ps1. Linux/macOS push-to-talk users were
// otherwise stranded by a Windows-only hint.
//
// Run: node --test daemon/test/stt.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { SttBridge } = await import("../dist/stt.js");

test("#89 unconfigured transcribe() rejects with a platform-neutral hint", async () => {
  const bridge = new SttBridge({}); // no exe/model
  assert.equal(bridge.isAvailable(), false);

  await assert.rejects(
    () => bridge.transcribe(Buffer.from([])),
    (err) => {
      assert.match(err.message, /Whisper not configured/);
      // Both platforms' setup scripts are mentioned…
      assert.match(err.message, /setup-whisper\.sh/, "missing Linux/macOS script");
      assert.match(err.message, /setup-whisper\.ps1/, "missing Windows script");
      // …and the env vars to set.
      assert.match(err.message, /BUDDY_WHISPER_EXE/);
      assert.match(err.message, /BUDDY_WHISPER_MODEL/);
      return true;
    }
  );
});

test("#89 describe() reports off-state without crashing when unconfigured", () => {
  assert.match(new SttBridge({}).describe(), /off \(missing exe\/model\)/);
});
