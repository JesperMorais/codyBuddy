// Task 2.1 contract: when BUDDY_TTS_BACKEND=kokoro, the bridge POSTs the
// stripped-for-speech text to the configured Kokoro URL (default
// http://127.0.0.1:31416/tts). Comprehensive multi-backend coverage lives
// in Task 2.2 — this file pins down just the new code path.
//
// Run: node --test daemon/test/tts-kokoro.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { TtsBridge } = await import("../dist/tts-bridge.js");

function installFakeFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("kokoro backend POSTs stripped speech text to the default URL", async () => {
  const fake = installFakeFetch();
  try {
    const tts = new TtsBridge({ backend: "kokoro" });
    await tts.speak("Hello world.");
    // speak() runs the queue async; wait briefly for the drain to flush.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, "http://127.0.0.1:31416/tts");
    assert.equal(fake.calls[0].init.method, "POST");
    assert.equal(fake.calls[0].init.headers["Content-Type"], "application/json");
    const body = JSON.parse(fake.calls[0].init.body);
    assert.equal(body.text, "Hello world.");
  } finally {
    fake.restore();
  }
});

test("kokoro backend honours an explicit kokoroUrl override", async () => {
  const fake = installFakeFetch();
  try {
    const tts = new TtsBridge({
      backend: "kokoro",
      kokoroUrl: "http://kokoro.local:9000/speak",
    });
    await tts.speak("Hi there.");
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, "http://kokoro.local:9000/speak");
  } finally {
    fake.restore();
  }
});

test("kokoro describe() reports the configured URL", () => {
  const tts = new TtsBridge({ backend: "kokoro", kokoroUrl: "http://elsewhere/tts" });
  assert.match(tts.describe(), /^kokoro \(http:\/\/elsewhere\/tts\)$/);
});

test("kokoro describe() falls back to the default URL", () => {
  const tts = new TtsBridge({ backend: "kokoro" });
  assert.match(tts.describe(), /^kokoro \(http:\/\/127\.0\.0\.1:31416\/tts\)$/);
});

test("kokoro backend isActive() returns true (treated as live)", () => {
  const tts = new TtsBridge({ backend: "kokoro" });
  assert.equal(tts.isActive(), true);
});
