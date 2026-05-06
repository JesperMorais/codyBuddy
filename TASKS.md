# Coding Buddy — Task List

Ordered, executable backlog. Work top-to-bottom; do one task per run. Tick (`[ ]` → `[x]`) when the task is merged. Each task is self-contained: every change must include or update tests, pass `pnpm typecheck` and `pnpm test`, and ship as one PR.

Source spec: `RESEARCH.md` §5.2 (MVP), §5.3 (post-MVP), §5.4 (cost model).

---

## Phase 0 — Floor

- [x] **0.1** Add `test` script (`node --test test/*.test.mjs`) to `daemon/package.json` and `extension/package.json`. Add a root `pnpm test` that runs `pnpm -r test`. Verify all existing test files run green.
- [x] **0.2** Add `typecheck` script (`tsc --noEmit`) to `daemon/package.json` and `extension/package.json`. Add a root `pnpm typecheck` aggregating both. Fix any latent type errors that surface.
- [x] **0.3** Add `.github/workflows/ci.yml` running pnpm install → typecheck → test on `windows-latest`, triggered on push and pull_request. Use `actions/setup-node@v4` (Node 20) and pnpm via `pnpm/action-setup@v3`.
- [x] **0.4** Reconcile env-var drift: README mentions `BUDDY_TTS_ENABLED`, daemon uses `BUDDY_TTS_BACKEND`. Pick `BUDDY_TTS_BACKEND` (values: `none|piper|kokoro`), update README, `.env.example`, and any code references. Add a unit test that the daemon refuses to start with an unknown backend.

## Phase 1 — Mechanically verify MVP DoD (RESEARCH §5.2)

- [x] **1.1** Refactor `AnthropicClient` so `Session` accepts an interface; add a `FakeAnthropicClient` test fixture returning deterministic `BuddyReply` payloads.
- [x] **1.2** Daemon WS integration test: boot the WS server in-process with the fake client, send `{type: "trigger", trigger: "EXPLICIT_ASK", payload: {...}}`, assert a `reply` message arrives with `mode !== "no_op"`.
- [x] **1.3** Extend `extension/test/triggers.test.mjs` to cover all four trigger comment suffixes (` AI?`, ` AI!`, ` WHY?`, ` STUCK`) plus negative cases (no trigger, mid-line occurrence).
- [x] **1.4** STUCK_LOOP timing test using the existing injectable `clock` arg: verify it does NOT fire under 90s with the same diagnostic, DOES fire after 90s with no edit, and DOES NOT fire if an edit was made within 60s.
- [x] **1.5** Mute test on `Session`: after `mute(30)`, non-`EXPLICIT_ASK` triggers return `{mode: "no_op"}`; `EXPLICIT_ASK` still goes through.
- [x] **1.6** Redactor test: `isDeniedFile` rejects `.env`, `id_rsa`, `*.pem`, `*.key`, `**/secrets/**`. `scrubSecrets` replaces `sk-…`, AWS access key, GitHub PAT, Slack tokens with `<REDACTED-SECRET>` and reports a hit count.
- [x] **1.7** Optional real-API smoke test gated on `ANTHROPIC_API_KEY` env. Skipped in CI; runnable locally. Asserts the tutor system prompt + a synthetic trigger payload returns a parseable `BuddyReply`.

## Phase 2 — Reconcile voice paths

- [x] **2.1** Add `kokoro` backend to `tts-bridge.ts`: when `BUDDY_TTS_BACKEND=kokoro`, POST to `http://127.0.0.1:31416/tts` instead of spawning Piper. Keep `piper` and `none` paths intact.
- [x] **2.2** Unit test for `tts-bridge.ts`: stub `fetch`/`spawn`; verify the right backend is invoked for each value of `BUDDY_TTS_BACKEND`, including `none` (no-op).
- [x] **2.3** Voice sidecar smoke test: spawn `voice/main.py` (FastAPI), hit `/health`, assert 200. Skip if Python or uvicorn unavailable. Verify `/tts` degrades gracefully when `kokoro_onnx` not installed (returns `skipped: kokoro-not-installed`).

## Phase 3 — Lifecycle + UX polish

- [x] **3.1** Add `codingBuddy.autoSpawnDaemon` setting (default `true`). When enabled, the extension spawns the daemon via `child_process.spawn` on activation, pipes stderr to the existing output channel, and reaps it on `deactivate`. Skip if a daemon is already listening on the configured port.
- [x] **3.2** Bridge health probe: send `{type: "ping"}` on connect, surface `daemon down` / `daemon up` in the sidebar status pill. Test with mock WS endpoint.
- [x] **3.3** Persist mute state to `MemoryStore` so a daemon restart inside the 30-min mute window stays muted. Test mute persistence across `Session` reinstantiation.

## Phase 4 — Cost optimization (two-tier classifier)

- [x] **4.1** Add `AnthropicClient.shouldSpeak(payload, summary)` using Haiku 4.5 returning `speak | chat | no_op`. Wire `Session.handleTrigger` to skip the Sonnet call when Haiku returns `no_op`.
- [x] **4.2** Test: with a stub Haiku returning `no_op`, the Sonnet `ask` method is never invoked. With `speak`, both are called.
- [x] **4.3** Token-cost telemetry: log `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` from each API response to `~/.claude-buddy/telemetry.jsonl`. Add a daemon test that the file is appended to per turn.

## Phase 5 — Trigger quality + misconception memory

- [x] **5.1** Expand `ANTI_PATTERNS` in `triggers.ts`: add Python (`mutable default arg`, `bare except`), TypeScript (`as any`, unawaited `Promise<…>`), and generic (`while (true)` with no `break`). Each pattern needs a positive and negative unit test.
- [x] **5.2** Replace `MemoryStore` free-text history with a `{ pattern -> {count, last_seen, sample} }` map for misconceptions, alongside the existing transcript log. Migrate `distillLearnerProfile` to receive counts directly.
- [x] **5.3** Test: triggering the same anti-pattern 3 times across separate `handleTrigger` calls produces a "Recurring misconceptions" entry with count ≥ 3 in the next learner profile distill.

## Phase 6 — Multi-mode validation

- [x] **6.1** Mode-switch integration test: `setMode("architect")` then trigger; assert the system block content matches `daemon/prompts/architect.md`. Repeat for `explainer` and `reviewer`.
- [x] **6.2** Add `daemon/test/fixtures/` with one canonical trigger payload per mode. Snapshot-test the assembled `system` + `messages` array sent to Anthropic (against the fake client).

## Phase 7 — Post-MVP integrations (optional, prioritize by ROI)

- [x] **7.1** Screenpipe MCP integration: add a `screenpipe.queryRecent(seconds)` tool to the daemon, invoked only on `EXPLICIT_ASK` when `recent_diff` is empty. Test against a stub MCP server.
- [x] **7.2** Ollama fallback: add `BUDDY_PROVIDER=ollama|anthropic` env, swap `AnthropicClient` for an OpenAI-compatible client at `http://localhost:11434/v1` when set to `ollama`. Default model `qwen2.5-coder:32b`. Test with a mocked Ollama HTTP endpoint.
- [x] **7.3** Telemetry-driven tuning: add thumbs-up/thumbs-down buttons to the sidebar webview; persist `{trigger, reply_text, vote, ts}` to JSONL. Add a `scripts/tune-triggers.mjs` that reads the log and prints suggested threshold deltas.

## Phase 8 — Docs

- [x] **8.1** Rewrite `README.md` to match real behavior post-Phase 2 and Phase 3: document `BUDDY_TTS_BACKEND` values, the auto-spawn behavior, all hotkeys, and the test commands. Keep "Definition of done" but link each checkbox to its automated test.
- [x] **8.2** Generate `CHANGELOG.md` from git log (Keep-a-Changelog format). Add a CI step or script to refresh it.

## Phase 9 — Personalities

Personality is a tone overlay orthogonal to mode (global, not per-mode). Mode prompts keep all hard rules; personality only governs voice/vocabulary. Default `nice`. NSFW is explicitly NOT supported on the Anthropic path — see 9.9.

- [x] **9.1** Add `daemon/prompts/personalities/{nice,dry,rude,drill_sergeant,passive_aggressive,pirate,shakespearean}.md`. Each ~20-40 lines: tone, vocab cues, 2-3 example phrasings, explicit "obey all rules in the role prompt; only change *how* you say things" clause. `nice` is the neutral baseline.
- [x] **9.2** Loader: scan `daemon/prompts/personalities/` in `daemon/src/index.ts` into a second `Map<string,string>`. Pass to `Session` constructor alongside existing mode prompts.
- [x] **9.3** Extend `Session`: add `personality` field, `getPersonality/setPersonality/listPersonalities`. Replace the single `systemPrompt: string` with `systemBlocks: string[]` returning `[modePrompt, personalityOverlay]` (overlay omitted when `nice`). Update `AnthropicClient.ask` signature to accept ordered system text blocks; each block keeps its own `cache_control`. Initial value from `BUDDY_PERSONALITY` env, default `nice`.
- [x] **9.4** WS protocol: add `setPersonality` / `getPersonality` message types. Include `personality` and `availablePersonalities` in the existing `modeSet` ack payload so the sidebar gets both dimensions in one message.
- [x] **9.5** Persist personality to `MemoryStore` (same mechanism as mute persistence in 3.3). On daemon restart, restore the last-selected personality. Test: set personality, reinstantiate `Session` against the same `MemoryStore`, assert it survives.
- [x] **9.6** Random-personality opt-in: add `BUDDY_PERSONALITY=random` (and a sidebar toggle). When enabled, pick a different personality per `handleTrigger` from `listPersonalities()`, excluding the previous one. Off by default. Test: with a seeded RNG, two consecutive triggers receive different personalities.
- [x] **9.7** Tests:
  - Snapshot: `setMode("tutor") + setPersonality("rude")` produces the expected ordered system blocks sent to the fake client. Repeat for `nice` (overlay omitted) and one more combo.
  - `setPersonality("does_not_exist")` returns `false`, leaves state unchanged, no throw.
  - Switching personality mid-session does not corrupt `recent_chat` or memory.
  - Random mode produces a different personality across N=10 triggers (seeded RNG).
- [x] **9.8** Sidebar UI: add a personality dropdown next to the existing mode picker plus a "shuffle" checkbox for random mode. Persist to workspace state. Wire to the new WS messages. Minimal styling.
- [x] **9.9** Uncensored path via Ollama (depends on 7.2): when `BUDDY_PROVIDER=ollama`, allow an `nsfw` personality file to load (gated behind the local provider). On `BUDDY_PROVIDER=anthropic`, `setPersonality("nsfw")` returns `false` with a clear error. Test: provider switch correctly enables/disables the personality.
- [x] **9.10** README + `.env.example`: document `BUDDY_PERSONALITY`, list shipped personalities, document the shuffle toggle, and explicitly note that `nsfw` requires `BUDDY_PROVIDER=ollama` and is unavailable on Anthropic.

---

## Phase 10 — Local conversation loop

The daemon becomes the conductor of a continuous voice session: mic → VAD → streaming STT → streaming LLM → streaming TTS → speaker, with barge-in. This phase replaces the trigger-then-respond model for the live audio path. The chat/sidebar path keeps working alongside it.

End-to-end latency target: **<800ms from end-of-speech to start-of-buddy-audio**. Every task that touches the loop must include a latency assertion or document why it can't.

- [x] **10.1** Add silero-vad to `voice/` sidecar (FastAPI). Long-lived endpoint accepting an audio stream over WebSocket; emits `{type: "speech.start"|"speech.end", ts}` events. Daemon spawns and supervises it. Test: feed a fixture WAV with known speech segments; assert event timestamps within ±100ms.
- [x] **10.2** Replace one-shot whisper with **streaming whisper.cpp**. Long-lived subprocess fed by mic chunks; emits partial transcripts ~300ms cadence and a final transcript on `speech.end`. Test: fixture WAV produces a final transcript within 400ms of `speech.end`.
- [x] **10.3** Streaming Kokoro TTS in `voice/` sidecar. Sentence-in / audio-out chunked. Daemon plays first sentence while later sentences are still synthesising. Test: synth a 4-sentence input; first audio chunk arrives <150ms after first sentence sent.
- [ ] **10.4** Hard-mute hotkey: extension command `coding-buddy.hardMute` bound to `Ctrl+Shift+M`. Sends `{type: "hardMute"}`; daemon kills mic input AND any in-flight TTS in <50ms. Visible mic indicator in the sidebar (red when muted, green dot when listening, pulsing when buddy is speaking). Test: dispatch the WS message, assert mic stream closed and TTS subprocess sent SIGINT.
- [ ] **10.5** **Barge-in handler**. On `speech.start` from VAD: cancel TTS audio output AND truncate any in-flight LLM stream. Buddy stops mid-sentence. Test: with a fake long-running TTS and LLM stream, dispatch a `speech.start` event; assert both terminate within 100ms.
- [ ] **10.6** `ConversationLoop` state machine in `daemon/src/conversation.ts` replacing `Session.handleTrigger` for the live audio path. States: `IDLE → LISTENING → THINKING → SPEAKING → INTERRUPTED → IDLE`. Editor triggers (anti-pattern, stuck-loop, EXPLICIT_ASK) feed in as *opportunities*: queued and consumed when the loop is `IDLE`. `Session` survives as the chat-path wrapper. Test: drive the state machine through each transition with mocked I/O; assert correct state sequence and no orphaned audio.
- [ ] **10.7** **Backchannel module**. Pre-recorded clips (`voice/backchannels/{mhm,right,yeah,go-on,hmm}.wav` × 3 takes each, varied prosody). When user has been speaking >3s and the loop is `LISTENING`, daemon plays a random backchannel locally, no LLM call. Cooldown ≥8s between backchannels to avoid spam. Configurable via `BUDDY_BACKCHANNEL=on|off` (default `on`). Test: with a 10s synthetic transcript, assert exactly one backchannel plays and the cooldown is honoured.
- [ ] **10.8** **Wake word, configurable**. New env `BUDDY_WAKEWORD=off|"hey buddy"|<custom>`. When `off` (default), open-mic always-listening. When set, daemon runs a lightweight on-device wake-word detector (openWakeWord) gating the LLM path; audio still streams to Whisper but transcripts are only forwarded to Anthropic after the wake word has fired (with a 30s active window, then back to gated). Test: with `BUDDY_WAKEWORD="hey buddy"` and a fixture transcript "hello world hey buddy what time is it", assert only "what time is it" reaches the LLM path.
- [ ] **10.9** Conversation-context payload assembler: every time the loop hits `THINKING`, build a unified payload combining (a) conversation transcript so far, (b) editor context (active file, diagnostics, recent_diff — same redactor as 1.6 runs first), (c) most recent editor trigger if any. Sent to the LLM as a single message. Test: assemble a payload from a fixture turn; assert redactor ran and editor context is present.

## Phase 11 — Anthropic streaming + tiered routing

Streams Sonnet/Haiku replies sentence-by-sentence into Kokoro. Two-tier router keeps fast turns cheap.

- [ ] **11.1** `AnthropicClient.askStream(systemBlocks, payload)`: returns an async iterator of text deltas. Replaces `ask` for the conversation loop; the chat path keeps using `ask` for now.
- [ ] **11.2** Sentence-buffer adapter: consume deltas, emit on sentence boundaries (`.`, `?`, `!`, double newline). Hand each sentence to the Kokoro stream from 10.3. Test: feed a fixture stream of deltas; assert sentences are emitted as soon as their terminator arrives, not at end-of-stream.
- [ ] **11.3** Add `daemon/prompts/conversational/{tutor,reviewer,architect,explainer}.md`. Plain-text replies (no JSON), 1-2 sentences default, conversational tone, "you are speaking aloud — don't say file paths, line numbers, or symbols longer than one identifier" rule. Existing JSON-mode prompts stay for the chat path. Test: snapshot the assembled system blocks for `conversational/tutor + drill_sergeant`.
- [ ] **11.4** **Two-tier router** (folds in old Phase 4): Haiku-first for conversational turns; escalate to Sonnet when (a) trigger ∈ {EXPLICIT_ASK, BAD_PATH, MISCONCEPTION}, (b) editor context changed since last turn, (c) transcript token count >threshold, or (d) Haiku itself flagged `escalate: true`. Test: with a stub Haiku returning `escalate: false`, Sonnet is never invoked. With each escalation condition, Sonnet is invoked exactly once.
- [ ] **11.5** Telemetry per turn: log Haiku tier, Sonnet tier (if reached), input/output/cache tokens, USD estimate, end-to-end latency, wake-word state, personality, mode. To `~/.claude-buddy/telemetry.jsonl`. Test: one full turn appends one line with all fields populated.

## Phase 12 — Voice acting (Kokoro + XTTS-v2 from day one)

Personality stops being just-a-prompt and becomes voice + prosody + script. Both Kokoro and XTTS-v2 ship together — XTTS for the heavyweight character voices, Kokoro for the lightweight everyday ones.

- [ ] **12.1** Add a `personality.json` next to each `daemon/prompts/personalities/*.md`: `{voice_engine: "kokoro"|"xtts", kokoro_voice?: string, xtts_ref?: string, rate: number, energy: number, pause_factor: number}`. Test: each shipped personality has a valid config; loader rejects unknown engines.
- [ ] **12.2** Map shipped personalities to Kokoro voices: `nice → af_bella`, `dry → am_adam`, `passive_aggressive → af_sarah` (or whichever fits). Test: `setPersonality("dry")` results in TTS calls using the configured Kokoro voice.
- [ ] **12.3** **XTTS-v2 sidecar** (`voice/xtts.py`, FastAPI). Long-lived process; loads coqui XTTS-v2; accepts `{text, ref_clip, language}` and streams 24kHz PCM. Document GPU expectation in setup notes (CPU fallback works but is ~3× slower). Add to `voice/requirements.txt` and `setup.ps1`. Test: spawn xtts.py, hit `/health`, assert 200; smoke-test synth with a fixture ref clip.
- [ ] **12.4** Ship reference clips: `voice/refs/{drill_sergeant,pirate,shakespearean,rude}.wav` (5-7s each, public-domain or self-recorded). Map these personalities to `voice_engine: "xtts"` in their `personality.json`. Test: `setPersonality("drill_sergeant")` routes synth requests to XTTS with the correct ref clip.
- [ ] **12.5** Prosody application: pass `rate`, `energy`, `pause_factor` from `personality.json` through to Kokoro/XTTS params at synth time. Test: same input text under `drill_sergeant` vs `nice` produces audio with measurably different duration.
- [ ] **12.6** TTS engine selector wired into `tts-bridge.ts`: `BUDDY_TTS_BACKEND` becomes `auto` (let personality decide), with explicit overrides `kokoro`, `xtts`, `piper`, `none` still honoured. Test: `auto` + drill_sergeant uses XTTS; `auto` + nice uses Kokoro; explicit `kokoro` overrides all.

## Phase 13 — Cost discipline

Always-on voice is unviable without aggressive quieting and budget caps.

- [ ] **13.1** Auto-quiet detector: 5 min of no `speech.end` events AND no editor edits → drop the loop into `QUIET` (Haiku-tier polling only, mic still open but transcripts dropped unless wake word matches; if wake word is `off`, Haiku still gates by transcript length >N). Resume on first speech-end or first edit. Test: simulate 6 minutes of silence; assert no Sonnet calls fired and the loop transitioned to `QUIET`.
- [ ] **13.2** Per-day USD cap: `BUDDY_DAILY_USD=5.00` (default). Tracked from telemetry (11.5). When hit, the loop downgrades to chat-only (TTS off, voice loop suspended) until midnight local. Sidebar shows the cap state. Test: with a low cap and stubbed token costs, assert downgrade after the threshold.
- [ ] **13.3** Live $/hr counter in the sidebar pill. Rolling 10-min window from telemetry. Test: feed synthetic telemetry; assert the displayed rate matches.

## Phase 14 — Conversational sidebar polish

- [ ] **14.1** Live transcript view in the sidebar: shows your speech (gray) and the buddy's replies (white) as they happen. Stays scrolled to bottom. Backchannels are not shown.
- [ ] **14.2** "Buddy is thinking…" / "Buddy is speaking…" / "I'm listening…" status pill replacing the current daemon-up indicator.
- [ ] **14.3** Voice-detected feedback: short utterances "good buddy" / "shut up buddy" / "useful" / "wrong" are recognised by a tiny phrase-match layer (no LLM) and logged as votes (replaces old Phase 7.3). Test: feed each phrase as a transcript; assert the corresponding vote is appended.

## Phase 15 — Setup & onboarding

Goal: a stranger can clone the repo and have a working voice-driven buddy in under 5 minutes. Cross-platform: Windows primary (most tested), macOS and Linux supported. Every task has a CI assertion or a manual verification recipe documented inline.

- [ ] **15.1** One-shot installer: `setup.ps1` (Windows) and `setup.sh` (macOS/Linux). Detects Node ≥20, pnpm, Python ≥3.11; prints exact install commands for whichever's missing. Creates `voice/.venv`, runs `pip install -r voice/requirements.txt`. Downloads pinned models (Whisper, Kokoro, XTTS-v2, silero-vad, openWakeWord) into `voice/models/` with SHA256 verification (uses 15.10's manifest). Copies `.env.example` → `.env` if missing. Idempotent. Final output: `Setup complete. Add ANTHROPIC_API_KEY to .env and run pnpm dev.` Test: CI matrix runs both scripts on `windows-latest`, `macos-latest`, `ubuntu-latest`; assert exit 0 and that `pnpm doctor` (15.2) reports green afterward.
- [ ] **15.2** `pnpm doctor`: verifies every dependency, reports versions, pings each sidecar `/health`, checks `.env` for required keys, confirms a usable audio input and output device. Colored checklist output, non-zero exit on any red. Test: in a fresh checkout, every line red; after 15.1, every line green. CI on all three OS.
- [ ] **15.3** Quickstart README: `git clone` to first voice turn in <5 minutes. Numbered steps, literal commands. Screenshots of the sidebar at each phase: red mic dot before permission, green when listening, pulsing when buddy is speaking. Troubleshooting subsection for the top 5 failures (mic permission denied, GPU not found, model download interrupted, port 31415 in use, Anthropic 401).
- [ ] **15.4** Demo mode (`BUDDY_DEMO=true`): ~10 pre-recorded canned replies hardcoded into the daemon, played in rotation. Lets a new user hear a real voice turn before paying for an API key. Sidebar watermark: *"demo mode — replies are canned, not from Claude."* Auto-disables when an API key is set and the first real Anthropic call succeeds. Test: with `BUDDY_DEMO=true` and no API key, three triggers produce three different canned replies and audio plays via the configured TTS backend.
- [ ] **15.5** VSIX packaging: `pnpm build:vsix` produces `coding-buddy-X.Y.Z.vsix` ready for `code --install-extension`. GitHub Actions release workflow: on tag push matching `v*`, build vsix + bundled daemon zip + checksums for all three OS, attach to the GitHub release. Test: workflow runs on a tag in a fork, artifacts appear on the release page.
- [ ] **15.6** Single-binary daemon: `pnpm build:daemon-bin` bundles the daemon via `node --experimental-sea-config` into one executable per platform (`buddy-daemon-{win,mac,linux}-x64`). Removes the "do you have Node installed?" question. Documented as the recommended path for non-developer users; `pnpm dev` remains the dev path. Test: built binary boots, opens its WS port, accepts a `ping`, exits cleanly on SIGINT — on all three OS in CI.
- [ ] **15.7** Reference voice clips: ship `voice/refs/{drill_sergeant,pirate,shakespearean,rude,nsfw}.wav` — 5-7s each, public-domain sourced or self-recorded by the project. Add `voice/refs/README.md` with attribution and a one-paragraph Audacity recipe for users to record their own. Test: each shipped clip exists, is mono, 24kHz, valid WAV (programmatic check via `wave` module).
- [ ] **15.8** Audio device picker: VS Code command `Coding Buddy: Select Audio Devices` shows a quickpick of input/output devices reported by the daemon, writes the chosen device IDs to `.env`. Defaults to system default. Test: programmatically dispatch the command with a stubbed device list, assert `.env` updates with the selected ID.
- [ ] **15.9** Mic-permission walkthrough: README troubleshooting section with screenshots for Windows (Settings → Privacy → Microphone), macOS (System Settings → Privacy & Security → Microphone, including the VS Code-specific gotcha), and Linux (PulseAudio + PipeWire pointers). The most common silent failure mode — covered with images, not just text.
- [ ] **15.10** Pinned model manifest: `voice/models.json` lists every model with `{name, version, url, sha256, size_bytes, license}`. Installer (15.1) reads this; daemon refuses to start if a checksum fails. Bumping a model = one PR editing this file. Test: corrupt a model file on disk, daemon exits with `model checksum mismatch: <name>` and a clear remediation hint.
- [ ] **15.11** Minimal install path (chat-only): document a no-voice install — skip 15.1's voice sidecar steps, set `BUDDY_TTS_BACKEND=none` and `BUDDY_VOICE_LOOP=off`, daemon runs without the `voice/` venv. README "I just want chat" callout linking to a 60-second setup. Test: with `BUDDY_VOICE_LOOP=off`, daemon boots and a chat trigger round-trips successfully without any voice sidecar running.
- [ ] **15.12** First-run sidebar onboarding: when the extension activates and `.env` is missing or `ANTHROPIC_API_KEY` is unset, show a four-step panel — (1) paste API key, (2) pick personality, (3) pick wake-word mode, (4) "say something to test the mic." Writes `.env` and workspace state. Replaces "open the env file and figure it out yourself." Test: with no `.env`, activate the extension; assert the panel appears and completing it produces a valid `.env`.
- [ ] **15.13** Five-minute screencast: a short video walking through clone → installer → API key → first voice turn. Embedded in the README. Source video committed to `docs/screencasts/quickstart.mp4`. Manual deliverable; no automated test, but the README must link to it.

---

## Working agreement

- **One task per PR.** Don't bundle.
- **Tests are not optional.** Every task has an automated assertion of the outcome.
- **Tick the box in the same commit** that delivers the task.
- **Stop and explain** if a task is blocked or ambiguous; do not invent scope.
