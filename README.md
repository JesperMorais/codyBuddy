# Monitor Teacher — Coding Buddy MVP

A pedagogical pair-programmer that watches your VS Code editor (no screen capture) and asks the right Socratic question at the right time. Built per `RESEARCH.md` §5.2.

## Architecture

```
extension (VS Code) ──ws──▶ daemon (Node + Anthropic) ──http──▶ voice (Python + Kokoro)
                                       │
                                       └─▶ Anthropic API (Sonnet 4.6, prompt caching)
```

- **`extension/`** — VS Code extension. Listens to editor / diagnostics / terminal events, runs the 6-rule trigger engine, redacts secrets, opens a sidebar webview.
- **`daemon/`** — Node WebSocket server. Owns the Claude session, prompt cache, mute state, hourly summarizer, and TTS bridge.
- **`voice/`** — FastAPI sidecar that turns text into Kokoro speech and plays it on the host.

## Setup (Windows 11, PowerShell)

```powershell
# 1. Install pnpm if missing
npm install -g pnpm

# 2. Install workspace deps
pnpm install

# 3. Configure secrets
Copy-Item .env.example .env
# edit .env, paste your Anthropic key

# 4. (Optional) install voice sidecar
cd voice
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
# Download Kokoro model files into ./voice/ per https://github.com/thewh1teagle/kokoro-onnx
```

## Run

Three terminals (or one with `wt` split panes):

```powershell
# T1 — daemon
pnpm dev:daemon

# T2 — voice (optional; set BUDDY_TTS_ENABLED=true in .env to actually use it)
pnpm dev:voice

# T3 — extension: open the extension folder in VS Code, press F5 to launch
#      a debug Extension Development Host
```

In the dev-host VS Code window, the **Coding Buddy** view appears in the activity bar (speech-bubble icon).

## Hotkeys

| Key | Action |
|-----|--------|
| `Ctrl+Alt+Q` | Ask the buddy something (input box → answer in sidebar) |
| `Ctrl+Alt+M` | Quiet for 30 minutes (toggle) |

## Trigger comments

End any line with one of these and save the file — buddy will respond:

- `// AI?` or `# AI?` — open-ended question about this line
- `// AI!` or `# AI!` — strong nudge for an answer
- `// WHY?` — explain this line
- `// STUCK` — admit you're stuck

The trigger comment is recognized by suffix; the rest of the line is sent as your question.

## Definition of done (weekend MVP)

Per `RESEARCH.md` §5.2 — verify each:

- [ ] Type ` # AI?` at end of any line in any file → ~2s later, a sentence appears in the sidebar.
- [ ] Press `Ctrl+Alt+Q` → input box → type or paste → response in sidebar (and spoken via Kokoro if voice enabled).
- [ ] Trigger an intentional TypeScript error → buddy stays silent. Leave it for 90s without editing → buddy asks one question.
- [ ] Press `Ctrl+Alt+M` → buddy says nothing for 30 minutes regardless of triggers.
- [ ] Open `.env` containing `OPENAI_KEY=sk-fake-...` → buddy refuses to include its content (file is glob-denied; secrets in any other file are scrubbed before send).

## Safety / cost defaults

- **Default-deny globs**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `**/secrets/**` are never sent.
- **Secret regex scrub**: AWS, GitHub PAT, Slack, generic `sk-*` patterns replaced with `<REDACTED-SECRET>` before send.
- **Spoken-interruption budget**: max 2 unprompted spoken interruptions per hour (explicit asks always go through).
- **Diff payloads**: only the editor diff since last send is transmitted, capped at 200 lines.
- **Prompt caching**: tutor prompt + rolling session summary marked `cache_control: ephemeral` → ~10× cheaper on repeat hits.

Expected cost with Sonnet 4.6 on a typical hour: **~$0.08–$0.30**. See `RESEARCH.md` §5.4 for the full model.

## Layout

```
monitor-teacher/
  package.json              # workspace root
  pnpm-workspace.yaml
  .env.example
  /extension
    package.json            # commands, hotkeys, sidebar view
    src/
      extension.ts          # activate(), wires events
      triggers.ts           # 6 rules from RESEARCH §2.4
      redactor.ts           # glob deny + secret scrub + mini-diff
      bridge.ts             # WS client to daemon
      ui/sidebar.ts         # webview chat UI
  /daemon
    package.json
    src/
      index.ts              # WS server on 127.0.0.1:31415
      session.ts            # mute, hour-budget, summary cadence
      anthropic.ts          # Anthropic SDK with cache_control
      tts-bridge.ts         # POST → voice sidecar
    prompts/
      tutor.md              # system prompt (8 hard rules)
  /voice
    pyproject.toml
    main.py                 # FastAPI /tts (Kokoro)
```

## Next steps (post-MVP)

See `RESEARCH.md` §5.3 — voice input via faster-whisper, multi-mode (Tutor/Architect/Reviewer), trained trigger classifier, Screenpipe MCP integration, local Ollama fallback for sensitive repos.
