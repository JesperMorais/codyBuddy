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

## Quickstart — five minutes from clone to first voice turn

> **Just want chat?** [Skip ahead](#minimal-install--chat-only-60-seconds) — the chat-only path takes ~60 seconds and skips Python, voice models, and the venv.

> **Prefer video?** Watch the 5-minute screencast: [`docs/screencasts/quickstart.mp4`](docs/screencasts/quickstart.mp4). (Recording brief in [`docs/screencasts/README.md`](docs/screencasts/README.md). The MP4 isn't tracked yet — see the brief for the recording recipe.)

Aimed at a fresh checkout on Windows 11, macOS, or Linux. The only manual step is pasting your Anthropic API key.

1. **Clone and run the installer.**
   ```bash
   # Windows (PowerShell)
   git clone https://github.com/JesperMorais/codyBuddy.git
   cd codyBuddy
   pwsh -File setup.ps1
   ```
   ```bash
   # macOS / Linux
   git clone https://github.com/JesperMorais/codyBuddy.git
   cd codyBuddy
   bash setup.sh
   ```
   `setup.{ps1,sh}` checks Node ≥20, pnpm, and Python ≥3.11 (each missing tool prints the exact install command), runs `pnpm install`, creates `voice/.venv`, and copies `.env.example` → `.env`. Idempotent — safe to re-run.

2. **Drop your API key into `.env`.**
   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Skip if you're running Ollama — set `BUDDY_PROVIDER=ollama` instead. (See [Configuration](#configuration-env) for the full list.)

3. **Verify with `pnpm doctor`.**
   ```bash
   pnpm doctor
   ```
   Every line should be `[OK]` (green) or `[--]` (yellow advisory). If anything is `[XX]` red, fix it before continuing — the message tells you what's missing.

4. **Open the extension folder in VS Code and press <kbd>F5</kbd>** to launch the debug Extension Development Host. The **Coding Buddy** view appears in the activity bar; the daemon auto-spawns on activation.

   ![Sidebar at idle — red mic dot, status pill says "Ready".](docs/screenshots/sidebar-idle.png)

5. **Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> to talk.** The first time you'll see the OS mic-permission prompt; allow it. The mic dot turns green, the pill flips to "I'm listening…".

   ![Sidebar listening — green pulsing mic dot, "I'm listening…".](docs/screenshots/sidebar-listening.png)

6. **Ask a question.** When you stop talking, the pill cycles through "Buddy is thinking…" → "Buddy is speaking…" and you'll hear the reply via your configured TTS backend.

   ![Sidebar speaking — purple pulsing dot, "Buddy is speaking…".](docs/screenshots/sidebar-speaking.png)

That's it. Total runtime once `setup.{ps1,sh}` finishes: under five minutes.

> Screenshots above are placeholders described in [`docs/screenshots/README.md`](docs/screenshots/README.md). They render as broken-image icons until someone drops in the actual PNGs — the prose still tells you what to expect.

## Minimal install — chat only (60 seconds)

If you only want the editor-trigger chat replies — no spoken voice, no mic, no Python — skip the voice sidecar entirely:

```bash
# Windows (PowerShell)
git clone https://github.com/JesperMorais/codyBuddy.git
cd codyBuddy
pwsh -File setup.ps1 -SkipVoice
```

```bash
# macOS / Linux
git clone https://github.com/JesperMorais/codyBuddy.git
cd codyBuddy
bash setup.sh --skip-voice
```

`-SkipVoice` / `--skip-voice` skip the `voice/.venv` step and the pip install entirely. Then edit `.env`:

```bash
BUDDY_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
BUDDY_TTS_BACKEND=none
BUDDY_VOICE_LOOP=off
```

`BUDDY_VOICE_LOOP=off` is the authoritative kill-switch — even if `BUDDY_VAD_SPAWN=true` is set, the daemon won't try to spawn the voice sidecar. `BUDDY_TTS_BACKEND=none` keeps the daemon silent. The buddy still answers your trigger comments (`AI?` / `AI!` / `WHY?` / `STUCK`) and the sidebar input box — replies render as text only.

You don't need Python ≥3.11, the voice venv, or any of the model files in `voice/models.json`. `pnpm doctor` will yellow-flag the voice-related lines (advisory) but still exit 0.

What you get:
- ✅ Sidebar chat (text in, text out).
- ✅ Editor trigger comments + auto-detected anti-patterns.
- ✅ Mode switching (tutor / architect / explainer / reviewer).
- ✅ Personality switching (no voice rendering).
- ❌ Spoken replies (TTS off).
- ❌ Voice input (no microphone path).
- ❌ Wake word, conversation loop, backchannels.

Add voice later by re-running setup without `--skip-voice` and flipping `BUDDY_TTS_BACKEND=auto` and `BUDDY_VOICE_LOOP=auto` in `.env`.

## Troubleshooting

The five most common ways onboarding fails. If your symptom isn't here, run `pnpm doctor` first — it pinpoints most of them automatically.

### 1. "We need permission to access the microphone"

The most common silent failure mode. Pressing <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> does nothing — no error, no audio, the sidebar stays on "Ready" instead of flipping to "I'm listening…". The OS denied mic access without the daemon ever being asked.

Walk through your OS below.

#### Windows 11

1. Open **Settings** → **Privacy & Security** → **Microphone**.
2. Set **Microphone access** to **On** (top of the page).
3. Scroll down and set **Let desktop apps access your microphone** to **On**.
4. Restart VS Code (close every window, then reopen — Windows checks the policy on launch).

![Windows 11 Settings → Privacy & Security → Microphone showing both toggles On.](docs/screenshots/mic/win11-mic-settings.png)

If the toggles are already on but the mic still doesn't engage, try a different USB port for the mic — Windows occasionally remembers per-device denials.

#### macOS

1. Open **System Settings** → **Privacy & Security** → **Microphone**.
2. Find **Visual Studio Code** (or **Cursor** / **Code - Insiders** / **VSCodium**, whichever app you launched) in the list and tick the toggle.
3. **macOS-specific gotcha**: macOS scopes mic permission to the *signed binary*, not the user. Updating VS Code, switching to Insiders, or installing a new build invalidates the prior grant — you'll see VS Code disappear from the list and need to re-tick on next launch.
   - **Workaround**: relaunching VS Code re-prompts and the dialog re-adds the entry. If the dialog doesn't appear, run `tccutil reset Microphone com.microsoft.VSCode` in a Terminal (substitute the bundle id for Cursor / Code Insiders / VSCodium) and relaunch.

![macOS System Settings → Privacy & Security → Microphone with VS Code toggled on.](docs/screenshots/mic/macos-mic-settings.png)

#### Linux (PulseAudio / PipeWire)

Most modern distros ship **PipeWire** with a PulseAudio compatibility layer (`pipewire-pulse`). Both layers expose mic state through `pavucontrol`.

1. Install if missing: `sudo apt install pavucontrol` (Debian/Ubuntu) / `sudo dnf install pavucontrol` (Fedora) / `sudo pacman -S pavucontrol` (Arch).
2. Run `pavucontrol`. Open the **Recording** tab.
3. Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> in VS Code to start a recording. The daemon's whisper subprocess should appear in the Recording tab.
4. Confirm the input source isn't muted (no red strikethrough on the mic icon) and the volume bar moves when you speak.

![pavucontrol Recording tab with the daemon visible and live volume movement.](docs/screenshots/mic/linux-pavucontrol-recording.png)

PipeWire-specific debug:
- `pw-cli list-objects | grep -i source` — list active audio sources. The mic name should appear.
- `wpctl status` (`wireplumber`) — quick policy summary; check that the default source isn't `(none)`.
- If only PulseAudio is installed (older systems), the same `pavucontrol` UI works against the legacy server.

If the daemon never appears in the Recording tab, the OS isn't even routing mic data to it. Most often this means `pipewire` / `pulseaudio` isn't running for your user session — `systemctl --user status pipewire pipewire-pulse` (PipeWire) or `systemctl --user status pulseaudio` (legacy) tells you which service is down.

### 2. "GPU not found" (XTTS personality silent or slow)

Symptom: switching to a heavyweight personality (drill_sergeant / pirate / shakespearean / rude) produces no audio for ~10s, then plays at 1/3 real-time.

Fix:
- XTTS-v2 needs an NVIDIA GPU with CUDA for live use. CPU works but is ~3× slower than real-time — fine for testing, useless for live voice.
- Check what XTTS picked up: `BUDDY_DEBUG_RAW=true` then look for `xtts-v2 loaded on cuda` vs `cpu` in the daemon log.
- Workaround: pin a Kokoro personality (nice / dry / passive_aggressive) — those run real-time on CPU.
- Permanent fix: install the CUDA build of torch BEFORE running `voice/setup-xtts.ps1`. Coqui's docs cover the matrix.

### 3. Model download interrupted / corrupted

Symptom: daemon errors with `model checksum mismatch: <name>` (Task 15.10) or the sidecar crashes mid-load.

Fix:
- Delete the partial file under `voice/models/<name>` (or whatever the error reported) and re-run `setup.{ps1,sh}`. The setup script's downloader is idempotent — it only fetches what's missing or fails the SHA256 check.
- If your network keeps dropping, the model URLs in `voice/models.json` are HTTPS — try a different network or use a wired connection. The XTTS-v2 checkpoint alone is ~1.5 GB.

### 4. Port 31415 already in use

Symptom: daemon log shows `EADDRINUSE: 127.0.0.1:31415` and the extension status pill flips to "Daemon down".

Fix:
- Something else is listening — usually a stale daemon from a previous VS Code session that didn't clean up.
- Find it:
  ```bash
  # Windows
  netstat -ano | findstr :31415
  ```
  ```bash
  # macOS / Linux
  lsof -iTCP:31415 -sTCP:LISTEN
  ```
- Kill the process by PID, or set `BUDDY_DAEMON_PORT=31416` (or any free port) in `.env` AND in VS Code Settings → `codingBuddy.daemonPort`.

### 5. Anthropic 401 / "invalid x-api-key"

Symptom: daemon log shows `401` from Anthropic, sidebar reply mode is `no_op`, no spoken reply.

Fix:
- Open `.env` — the most common cause is leaving the placeholder `ANTHROPIC_API_KEY=sk-ant-...` from `.env.example`. `pnpm doctor` flags this as red.
- Paste a real key from <https://console.anthropic.com/settings/keys>. Restart the daemon (`Coding Buddy: Restart daemon` or just <kbd>F5</kbd>-relaunch the extension host).
- If you're running on Ollama (`BUDDY_PROVIDER=ollama`), the Anthropic key is irrelevant and you can leave the placeholder — but check that `BUDDY_OLLAMA_URL` points at a running endpoint.

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
| `BUDDY_XTTS_URL` | `http://127.0.0.1:31417/synth` | XTTS-v2 FastAPI sidecar (`voice/buddy_voice/xtts.py`) when the effective engine is `xtts`. |
| `BUDDY_TTS_VOLUME` | `0.5` | 0.0–1.0. Applied by the Piper backend; Kokoro plays at sidecar default. |
| `BUDDY_WHISPER_EXE` / `BUDDY_WHISPER_MODEL` | — | whisper.cpp paths for voice input (Ctrl+Alt+V). Run `voice/setup-whisper.sh` (Linux/macOS) or `voice/setup-whisper.ps1` (Windows) to fetch the binary + `ggml-base.en` model; the script prints the two paths to set here. |
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
codyBuddy/
  package.json              # workspace root
  pnpm-workspace.yaml
  .env.example
  TASKS.md                  # ordered backlog (autonomous loop reads this)
  setup.ps1 / setup.sh      # one-shot installer (Task 15.1)
  scripts/
    tune-triggers.mjs       # vote-log → suggested threshold deltas
    doctor.mjs              # `pnpm doctor` health-check (Task 15.2)
  /extension
    package.json            # commands, hotkeys, sidebar view, settings
    src/
      extension.ts          # activate(), wires events, auto-spawns daemon
      daemon-spawn.ts       # probeDaemonPort + findDaemonScript + spawnDaemon
      triggers.ts           # 6 rules + 8 anti-patterns
      redactor.ts           # glob deny + secret scrub + mini-diff
      bridge.ts             # WS client w/ ping/pong health probe
      onboarding.ts         # first-run guidance flow
      env-writer.ts         # safe .env mutations
      payload.ts            # request payload assembly
      ui/sidebar.ts         # webview chat UI + 👍/👎 buttons
  /daemon
    package.json
    src/
      index.ts              # CLI bootstrap
      server.ts             # WS server (extracted for in-process tests)
      session.ts            # mute, hour-budget, summary, gate, screenpipe
      anthropic.ts          # AnthropicClient + AiClient interface
      ollama.ts             # OllamaClient (OpenAI-compatible local fallback)
      config.ts             # env parsing (TTS backend, provider, etc.)
      memory.ts             # MemoryStore (events, summary, mute, misconceptions)
      telemetry.ts          # token-cost JSONL log
      turn-telemetry.ts     # per-turn cost ledger (turns.jsonl)
      cost-rate.ts          # rolling-window cost rate
      daily-cost-cap.ts     # hard daily ceiling
      votes.ts              # 👍/👎 JSONL log
      vote-phrase-matcher.ts# spoken thumbs-up/down phrase detection
      screenpipe.ts         # OCR fallback context provider
      tts-bridge.ts         # piper / kokoro / xtts / none routing
      tts-stream.ts         # streaming TTS adapter
      stt.ts                # whisper.cpp wrapper (one-shot)
      stt-stream.ts         # streaming whisper / sidecar adapter
      recorder.ts           # mic capture
      audio-host.ts         # host-side audio playback
      audio-devices.ts      # input/output device enumeration
      playback.ts           # PCM playback primitive
      vad-bridge.ts         # Silero VAD sidecar bridge
      voice-sidecar.ts      # uvicorn lifecycle for voice/
      wake-word.ts          # WakeWordGate (openWakeWord)
      conversation.ts       # ConversationLoop state machine
      conversational-prompts.ts # conversation-mode system prompts
      barge-in.ts           # cancel registry + 100ms budget
      backchannel.ts        # short backchannel clip scheduler
      sentence-buffer.ts    # streaming-sentence boundary detector
      auto-quiet.ts         # auto-mute heuristics
      tiered-router.ts      # Haiku gate → Sonnet escalation
      haiku-classifier.ts   # gate verdict (speak/chat/no_op)
      payload-assembler.ts  # context blocks → API payload
      personalities-loader.ts # load /daemon/prompts/personalities/*
      personality-config.ts # personality→TTS routing config
      models-manifest.ts    # voice/models.json reader/checksum
      demo-client.ts / demo-fallback.ts # offline demo helpers
    prompts/
      tutor.md architect.md explainer.md reviewer.md
      personalities/        # tone overlays (Anthropic-safe)
      personalities-ollama/ # Ollama-only overlays (incl. nsfw)
      conversational/       # conversation-mode system prompts
    test/
      fixtures/             # one trigger payload per mode
      *.test.mjs            # node:test suites
  /voice
    buddy_voice/            # Python package (Kokoro/XTTS sidecars)
    main.py                 # FastAPI /tts entry
    models.json             # pinned model URLs + SHA256
    refs/                   # XTTS reference clips per personality
    backchannels/           # short *.wav clips for the loop
    setup-piper.ps1 / setup-piper.sh
    setup-whisper.ps1 / setup-whisper.sh
    setup-xtts.ps1 / setup-xtts.sh
  /docs
    screenshots/            # sidebar/mic-permission stills (placeholders)
    screencasts/            # quickstart screencast (recording brief)
```

## Next steps (post-MVP)

See `TASKS.md` Phases 9–15 (personalities, live conversation loop with VAD/streaming whisper, voice acting via XTTS-v2, cost discipline, sidebar polish, setup & onboarding).
