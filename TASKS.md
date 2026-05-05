# Coding Buddy — Task List

Ordered, executable backlog. Work top-to-bottom; do one task per run. Tick (`[ ]` → `[x]`) when the task is merged. Each task is self-contained: every change must include or update tests, pass `pnpm typecheck` and `pnpm test`, and ship as one PR.

Source spec: `RESEARCH.md` §5.2 (MVP), §5.3 (post-MVP), §5.4 (cost model).

---

## Phase 0 — Floor

- [x] **0.1** Add `test` script (`node --test test/*.test.mjs`) to `daemon/package.json` and `extension/package.json`. Add a root `pnpm test` that runs `pnpm -r test`. Verify all existing test files run green.
- [x] **0.2** Add `typecheck` script (`tsc --noEmit`) to `daemon/package.json` and `extension/package.json`. Add a root `pnpm typecheck` aggregating both. Fix any latent type errors that surface.
- [ ] **0.3** Add `.github/workflows/ci.yml` running pnpm install → typecheck → test on `windows-latest`, triggered on push and pull_request. Use `actions/setup-node@v4` (Node 20) and pnpm via `pnpm/action-setup@v3`.
- [ ] **0.4** Reconcile env-var drift: README mentions `BUDDY_TTS_ENABLED`, daemon uses `BUDDY_TTS_BACKEND`. Pick `BUDDY_TTS_BACKEND` (values: `none|piper|kokoro`), update README, `.env.example`, and any code references. Add a unit test that the daemon refuses to start with an unknown backend.

## Phase 1 — Mechanically verify MVP DoD (RESEARCH §5.2)

- [ ] **1.1** Refactor `AnthropicClient` so `Session` accepts an interface; add a `FakeAnthropicClient` test fixture returning deterministic `BuddyReply` payloads.
- [ ] **1.2** Daemon WS integration test: boot the WS server in-process with the fake client, send `{type: "trigger", trigger: "EXPLICIT_ASK", payload: {...}}`, assert a `reply` message arrives with `mode !== "no_op"`.
- [ ] **1.3** Extend `extension/test/triggers.test.mjs` to cover all four trigger comment suffixes (` AI?`, ` AI!`, ` WHY?`, ` STUCK`) plus negative cases (no trigger, mid-line occurrence).
- [ ] **1.4** STUCK_LOOP timing test using the existing injectable `clock` arg: verify it does NOT fire under 90s with the same diagnostic, DOES fire after 90s with no edit, and DOES NOT fire if an edit was made within 60s.
- [ ] **1.5** Mute test on `Session`: after `mute(30)`, non-`EXPLICIT_ASK` triggers return `{mode: "no_op"}`; `EXPLICIT_ASK` still goes through.
- [ ] **1.6** Redactor test: `isDeniedFile` rejects `.env`, `id_rsa`, `*.pem`, `*.key`, `**/secrets/**`. `scrubSecrets` replaces `sk-…`, AWS access key, GitHub PAT, Slack tokens with `<REDACTED-SECRET>` and reports a hit count.
- [ ] **1.7** Optional real-API smoke test gated on `ANTHROPIC_API_KEY` env. Skipped in CI; runnable locally. Asserts the tutor system prompt + a synthetic trigger payload returns a parseable `BuddyReply`.

## Phase 2 — Reconcile voice paths

- [ ] **2.1** Add `kokoro` backend to `tts-bridge.ts`: when `BUDDY_TTS_BACKEND=kokoro`, POST to `http://127.0.0.1:31416/tts` instead of spawning Piper. Keep `piper` and `none` paths intact.
- [ ] **2.2** Unit test for `tts-bridge.ts`: stub `fetch`/`spawn`; verify the right backend is invoked for each value of `BUDDY_TTS_BACKEND`, including `none` (no-op).
- [ ] **2.3** Voice sidecar smoke test: spawn `voice/main.py` (FastAPI), hit `/health`, assert 200. Skip if Python or uvicorn unavailable. Verify `/tts` degrades gracefully when `kokoro_onnx` not installed (returns `skipped: kokoro-not-installed`).

## Phase 3 — Lifecycle + UX polish

- [ ] **3.1** Add `codingBuddy.autoSpawnDaemon` setting (default `true`). When enabled, the extension spawns the daemon via `child_process.spawn` on activation, pipes stderr to the existing output channel, and reaps it on `deactivate`. Skip if a daemon is already listening on the configured port.
- [ ] **3.2** Bridge health probe: send `{type: "ping"}` on connect, surface `daemon down` / `daemon up` in the sidebar status pill. Test with mock WS endpoint.
- [ ] **3.3** Persist mute state to `MemoryStore` so a daemon restart inside the 30-min mute window stays muted. Test mute persistence across `Session` reinstantiation.

## Phase 4 — Cost optimization (two-tier classifier)

- [ ] **4.1** Add `AnthropicClient.shouldSpeak(payload, summary)` using Haiku 4.5 returning `speak | chat | no_op`. Wire `Session.handleTrigger` to skip the Sonnet call when Haiku returns `no_op`.
- [ ] **4.2** Test: with a stub Haiku returning `no_op`, the Sonnet `ask` method is never invoked. With `speak`, both are called.
- [ ] **4.3** Token-cost telemetry: log `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` from each API response to `~/.claude-buddy/telemetry.jsonl`. Add a daemon test that the file is appended to per turn.

## Phase 5 — Trigger quality + misconception memory

- [ ] **5.1** Expand `ANTI_PATTERNS` in `triggers.ts`: add Python (`mutable default arg`, `bare except`), TypeScript (`as any`, unawaited `Promise<…>`), and generic (`while (true)` with no `break`). Each pattern needs a positive and negative unit test.
- [ ] **5.2** Replace `MemoryStore` free-text history with a `{ pattern -> {count, last_seen, sample} }` map for misconceptions, alongside the existing transcript log. Migrate `distillLearnerProfile` to receive counts directly.
- [ ] **5.3** Test: triggering the same anti-pattern 3 times across separate `handleTrigger` calls produces a "Recurring misconceptions" entry with count ≥ 3 in the next learner profile distill.

## Phase 6 — Multi-mode validation

- [ ] **6.1** Mode-switch integration test: `setMode("architect")` then trigger; assert the system block content matches `daemon/prompts/architect.md`. Repeat for `explainer` and `reviewer`.
- [ ] **6.2** Add `daemon/test/fixtures/` with one canonical trigger payload per mode. Snapshot-test the assembled `system` + `messages` array sent to Anthropic (against the fake client).

## Phase 7 — Post-MVP integrations (optional, prioritize by ROI)

- [ ] **7.1** Screenpipe MCP integration: add a `screenpipe.queryRecent(seconds)` tool to the daemon, invoked only on `EXPLICIT_ASK` when `recent_diff` is empty. Test against a stub MCP server.
- [ ] **7.2** Ollama fallback: add `BUDDY_PROVIDER=ollama|anthropic` env, swap `AnthropicClient` for an OpenAI-compatible client at `http://localhost:11434/v1` when set to `ollama`. Default model `qwen2.5-coder:32b`. Test with a mocked Ollama HTTP endpoint.
- [ ] **7.3** Telemetry-driven tuning: add thumbs-up/thumbs-down buttons to the sidebar webview; persist `{trigger, reply_text, vote, ts}` to JSONL. Add a `scripts/tune-triggers.mjs` that reads the log and prints suggested threshold deltas.

## Phase 8 — Docs

- [ ] **8.1** Rewrite `README.md` to match real behavior post-Phase 2 and Phase 3: document `BUDDY_TTS_BACKEND` values, the auto-spawn behavior, all hotkeys, and the test commands. Keep "Definition of done" but link each checkbox to its automated test.
- [ ] **8.2** Generate `CHANGELOG.md` from git log (Keep-a-Changelog format). Add a CI step or script to refresh it.

---

## Working agreement

- **One task per PR.** Don't bundle.
- **Tests are not optional.** Every task has an automated assertion of the outcome.
- **Tick the box in the same commit** that delivers the task.
- **Stop and explain** if a task is blocked or ambiguous; do not invent scope.
