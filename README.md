# Monitor Teacher — Coding Buddy

A pedagogical pair-programmer that watches your VS Code editor (no screen capture by default) and asks the right Socratic question at the right time. Built per `RESEARCH.md`.

## Architecture

```
extension (VS Code) ──ws──▶ daemon (Node + AiClient) ──http──▶ voice (Python + Kokoro)
                                       │
                                       ├─▶ Anthropic Sonnet 4.6 + Haiku 4.5 (default)
                                       │     • prompt caching, two-tier gate, token telemetry
                                       └─▶ OR Ollama / OpenAI-compatible (BUDDY_PROVIDER=ollama)
```

- **`extension/`** — VS Code extension. Listens to editor / diagnostics / terminal events, runs the trigger engine, redacts secrets, opens a sidebar webview, auto-spawns the daemon.
- **`daemon/`** — Node WebSocket server. Owns the AI session, prompt cache, mute state, summarizer, learner profile, vote log, and TTS bridge. Provider-pluggable: Anthropic by default, Ollama as a local fallback.
- **`voice/`** — FastAPI sidecar that turns text into Kokoro speech and plays it on the host. Optional — Piper and "none" backends ship alongside.

## Setup (Windows 11, PowerShell)

```powershell
# 1. Install pnpm if missing
npm install -g pnpm

# 2. Install workspace deps
pnpm install

# 3. Configure secrets
Copy-Item .env.example .env
# edit .env, paste your Anthropic key (skip if BUDDY_PROVIDER=ollama)

# 4. (Optional) install Kokoro voice sidecar
cd voice
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
# Download Kokoro model files into ./voice/ per https://github.com/thewh1teagle/kokoro-onnx
```

## Run

```powershell
# T1 — daemon (the extension auto-spawns it too; running manually is useful for logs)
pnpm dev:daemon

# T2 — voice (only when BUDDY_TTS_BACKEND=kokoro)
pnpm dev:voice

# T3 — extension: open the extension folder in VS Code, press F5 to launch
#      a debug Extension Development Host
```

In the dev-host VS Code window, the **Coding Buddy** view appears in the activity bar. By default `codingBuddy.autoSpawnDaemon` is `true`, so the extension spawns its own daemon on activation if nothing is listening on the configured port — manual `pnpm dev:daemon` is only needed to tail logs.

## Hotkeys

| Key | Action |
|-----|--------|
| `Ctrl+Alt+Q` | Ask the buddy something (input box → answer in sidebar) |
| `Ctrl+Alt+Shift+M` | Quiet for 30 minutes (toggle, persisted across daemon restarts) |
| `Ctrl+Shift+M` | **Hard mute** — kills mic input and any in-flight TTS in <50ms (Task 10.4) |
| `Ctrl+Alt+V` | Push-to-talk — start/stop recording for voice ask |

Plus these **Command Palette** entries (no default keybinding):

- `Coding Buddy: Switch mode` — pick `tutor` / `architect` / `explainer` / `reviewer`
- `Coding Buddy: Show learning report` / `Refresh learning report`
- `Coding Buddy: Toggle voice output` / `Set voice volume` / `Test voice`
- `Coding Buddy: Open sidebar`

## Trigger comments

End any line with one of these and save the file — buddy will respond:

- `// AI?` or `# AI?` — open-ended question about this line
- `// AI!` or `# AI!` — strong nudge for an answer
- `// WHY?` — explain this line
- `// STUCK` — admit you're stuck

The trigger comment is recognized by suffix; the rest of the line is sent as your question.

## Personalities

A personality is a *tone overlay* layered on top of the active mode prompt. Mode (`tutor` / `architect` / `explainer` / `reviewer`) governs *what* the buddy says; personality governs *how*. The same misconception explanation comes out as a clipped imperative under `drill_sergeant` or as a deadpan one-liner under `dry` — but the underlying judgement is identical.

**Shipped overlays** (load on every provider):

| Name | Vibe |
|---|---|
| `nice` | Neutral baseline. The overlay block is omitted entirely — pure mode prompt. Default. |
| `dry` | Deadpan, terse, lightly sardonic. |
| `rude` | Blunt. No corporate softeners. |
| `drill_sergeant` | Clipped, imperative, high-tempo. |
| `passive_aggressive` | Polite on the surface, pointed underneath. |
| `pirate` | Full pirate cadence. |
| `shakespearean` | Early-modern English. |

**Gated overlay** (Ollama-only):

| Name | Why gated |
|---|---|
| `nsfw` | Uncensored register: profanity for emphasis, edgier similes, no platform-side moderation. **Requires `BUDDY_PROVIDER=ollama`** because hosted Anthropic models will refuse most of what this overlay asks for. On `BUDDY_PROVIDER=anthropic`, `setPersonality("nsfw")` returns `false` and the sidebar shows `Could not switch: personality 'nsfw' requires BUDDY_PROVIDER=ollama (current provider does not support uncensored output)`. |

**How to pick one:**

- `BUDDY_PERSONALITY=<name>` in `.env` seeds the *first* boot.
- The sidebar dropdown switches at runtime (next to the mode dropdown, above the message log).
- The choice is persisted to `~/.coding-buddy/personality.json` and survives daemon restarts — the env var only matters when nothing has been persisted yet.

**Shuffle mode:**

- `BUDDY_PERSONALITY=random` (or the sidebar **Shuffle** checkbox) rotates the overlay on every trigger, never repeating the previous one. Off by default.
- The shuffle toggle is independent of the seed personality and persists separately to `~/.coding-buddy/shuffle.json`.

## Sidebar votes

After each non-`no_op` reply, 👍 / 👎 buttons appear under the message. Clicks are persisted to `~/.coding-buddy/votes.jsonl`. To see per-trigger up/down rates and suggested threshold deltas:

```
node scripts/tune-triggers.mjs              # default: ~/.coding-buddy/votes.jsonl
node scripts/tune-triggers.mjs --min 10     # ignore triggers with < 10 votes
```

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `BUDDY_PROVIDER` | `anthropic` | `anthropic` or `ollama`. Daemon refuses to start on any other value. |
| `ANTHROPIC_API_KEY` | — | Required when `BUDDY_PROVIDER=anthropic`. |
| `BUDDY_MODEL` | `claude-sonnet-4-6` | Anthropic model used for `ask`. |
| `BUDDY_OLLAMA_URL` | `http://localhost:11434/v1` | OpenAI-compatible endpoint when `BUDDY_PROVIDER=ollama`. |
| `BUDDY_OLLAMA_MODEL` | `qwen2.5-coder:32b` | Local model name. |
| `BUDDY_DAEMON_PORT` | `31415` | Loopback WS port the daemon listens on. |
| `BUDDY_PERSONALITY` | `nice` | Tone overlay on top of the active mode prompt. See [Personalities](#personalities) for the full list, the `random` shuffle mode, and the Ollama-only `nsfw` overlay. |
| `BUDDY_TTS_BACKEND` | `none` | `none` / `auto` / `kokoro` / `xtts` / `piper`. `auto` lets the active personality pick the engine (XTTS-v2 for drill_sergeant / pirate / shakespearean / rude, Kokoro for everything else); explicit values override personality routing. Daemon refuses to start on anything else. |
| `BUDDY_PIPER_EXE` / `BUDDY_PIPER_VOICE` | — | Piper executable + voice file when `BUDDY_TTS_BACKEND=piper`. |
| `BUDDY_KOKORO_URL` | `http://127.0.0.1:31416/tts` | Kokoro FastAPI sidecar when the effective engine is `kokoro`. |
| `BUDDY_XTTS_URL` | `http://127.0.0.1:31417/synth` | XTTS-v2 FastAPI sidecar (`voice/xtts.py`) when the effective engine is `xtts`. |
| `BUDDY_TTS_VOLUME` | `0.5` | 0.0–1.0. Applied by the Piper backend; Kokoro plays at sidecar default. |
| `BUDDY_WHISPER_EXE` / `BUDDY_WHISPER_MODEL` | — | whisper.cpp paths for voice input (Ctrl+Alt+V). |
| `BUDDY_BACKCHANNEL` | `on` | When the conversation loop is `LISTENING` and the user has been speaking >3s, plays a short `voice/backchannels/*.wav` clip (cooldown ≥8s). `off` disables. |
| `BUDDY_WAKEWORD` | `off` | `off` keeps the daemon open-mic. Set to a phrase (e.g. `"hey buddy"`) to gate LLM forwarding behind it; transcripts pass for 30s after each fire. |
| `BUDDY_SCREENPIPE_URL` | — (disabled) | When set, OCR'd recent screen activity is added to `EXPLICIT_ASK` triggers when `recent_diff` is empty. |

VS Code settings (Settings → Coding Buddy):

- `codingBuddy.daemonPort` (default `31415`)
- `codingBuddy.autoSpawnDaemon` (default `true`) — spawn the daemon on extension activation; skip if the port is already in use
- `codingBuddy.idleSeconds` (default `300`) — `IDLE_LONG` trigger threshold
- `codingBuddy.maxDiffLines` (default `200`) — cap on diff payload size
- `codingBuddy.voiceEnabled` (default `true`)
- `codingBuddy.voiceVolume` (default `0.5`)

## Definition of done — verified by tests

The MVP contract from `RESEARCH.md` §5.2 is now mechanically verified by automated tests. Each checkbox links to the suite that covers it.

- [x] Type ` # AI?` at end of any line → trigger fires, payload reaches the daemon → [`extension/test/triggers.test.mjs`](extension/test/triggers.test.mjs)
- [x] `Ctrl+Alt+Q` → input box → response in sidebar (and spoken if voice enabled) → [`daemon/test/ws.test.mjs`](daemon/test/ws.test.mjs) (round-trip), [`daemon/test/tts-bridge-routing.test.mjs`](daemon/test/tts-bridge-routing.test.mjs) (TTS path)
- [x] Diagnostic lingers >90s without an edit → buddy asks one question; <90s or recent edit → silent → [`extension/test/triggers.test.mjs`](extension/test/triggers.test.mjs) (`1.4 (A)/(B)/(C)`)
- [x] `Ctrl+Alt+Shift+M` → buddy stays quiet for 30 min regardless of triggers; survives daemon restart → [`daemon/test/session-mute.test.mjs`](daemon/test/session-mute.test.mjs), [`daemon/test/mute-persistence.test.mjs`](daemon/test/mute-persistence.test.mjs)
- [x] `.env` and other secret-bearing files refuse to send; in-content secrets get scrubbed → [`extension/test/redactor.test.mjs`](extension/test/redactor.test.mjs)
- [x] Real Anthropic round-trip returns a parseable `BuddyReply` (gated on `ANTHROPIC_API_KEY`) → [`daemon/test/anthropic-smoke.test.mjs`](daemon/test/anthropic-smoke.test.mjs)

## Safety / cost defaults

- **Provider-pluggable** — `BUDDY_PROVIDER=ollama` keeps every byte of code on your machine. Useful for sensitive repos.
- **Default-deny globs**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `**/secrets/**` are never sent.
- **Secret regex scrub**: AWS, GitHub PAT, Slack, generic `sk-*` patterns replaced with `<REDACTED-SECRET>` before send.
- **Two-tier gate** — Haiku 4.5 decides whether the buddy should speak at all (`speak` / `chat` / `no_op`); Sonnet only runs on non-`no_op` verdicts. `EXPLICIT_ASK` always bypasses the gate.
- **Spoken-interruption budget**: max 2 unprompted spoken interruptions per hour (explicit asks always go through).
- **Diff payloads**: only the editor diff since last send is transmitted, capped at 200 lines.
- **Prompt caching**: tutor prompt + rolling session summary marked `cache_control: ephemeral` → ~10× cheaper on repeat hits.
- **Token telemetry** — every API response logs `input/output/cache_read/cache_creation` tokens to `~/.coding-buddy/telemetry.jsonl`.
- **Misconception memory** — repeated anti-patterns accumulate counts; surfaced in the next learner-profile distill under "Recurring misconceptions".

Expected cost with Sonnet 4.6 + Haiku gate on a typical hour: **~$0.08–$0.30**. See `RESEARCH.md` §5.4 for the full model.

## Tests

```powershell
pnpm install
pnpm typecheck     # tsc --noEmit across both workspaces
pnpm test          # node --test across both workspaces
```

CI runs the same three steps on `windows-latest` for every push and PR (`.github/workflows/ci.yml`).

## Layout

```
monitor-teacher/
  package.json              # workspace root
  pnpm-workspace.yaml
  .env.example
  TASKS.md                  # ordered backlog (autonomous loop reads this)
  scripts/
    tune-triggers.mjs       # vote-log → suggested threshold deltas
  /extension
    package.json            # commands, hotkeys, sidebar view, settings
    src/
      extension.ts          # activate(), wires events, auto-spawns daemon
      daemon-spawn.ts       # probeDaemonPort + findDaemonScript + spawnDaemon
      triggers.ts           # 6 rules + 8 anti-patterns
      redactor.ts           # glob deny + secret scrub + mini-diff
      bridge.ts             # WS client w/ ping/pong health probe
      ui/sidebar.ts         # webview chat UI + 👍/👎 buttons
  /daemon
    package.json
    src/
      index.ts              # CLI bootstrap
      server.ts             # WS server (extracted for in-process tests)
      session.ts            # mute, hour-budget, summary, gate, screenpipe
      anthropic.ts          # AnthropicClient + AiClient interface
      ollama.ts             # OllamaClient (OpenAI-compatible local fallback)
      config.ts             # parseTtsBackend
      memory.ts             # MemoryStore (events, summary, mute, misconceptions)
      telemetry.ts          # token-cost JSONL log
      votes.ts              # 👍/👎 JSONL log
      screenpipe.ts         # OCR fallback context provider
      tts-bridge.ts         # piper / kokoro / none routing
      stt.ts                # whisper.cpp wrapper
      recorder.ts           # mic capture
    prompts/
      tutor.md  architect.md  explainer.md  reviewer.md
    test/
      fixtures/             # one trigger payload per mode
      *.test.mjs            # node:test suites
  /voice
    main.py                 # FastAPI /tts (Kokoro)
    setup-piper.ps1
    setup-whisper.ps1
```

## Next steps (post-MVP)

See `TASKS.md` Phases 9–15 (personalities, live conversation loop with VAD/streaming whisper, voice acting via XTTS-v2, cost discipline, sidebar polish, setup & onboarding).
