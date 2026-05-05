# Live Coding Buddy — Research

*Compiled May 3, 2026. Verified against vendor docs as of that date.*

## TL;DR

- **The exact thing you want does not exist as a polished product.** Cursor/Cline/Continue are transactional ("write me code"), not conversational/pedagogical. Cluely-class overlays watch the screen but target interview-cheating, not learning. Aider's `--watch` mode is the closest spiritual sibling but is text-trigger-driven, not proactive. Real gap; defensible side project.
- **Build it as a hybrid: VS Code extension as the primary signal source (cheap, structured, low-latency), Claude Sonnet 4.6 as the brain, Whisper+Kokoro for the voice loop, and screenshots only as a fallback when the editor signal is insufficient.** Plain screen-capture-every-N-seconds with a vision model is a money pit ($5–15/hour) and laggy on Windows.
- **Realistic cost with caching done right: ~$0.30–$1.20 per active coding hour using Sonnet 4.6.** A weekend MVP using Claude Code SDK + a thin VS Code extension + push-to-talk Whisper is achievable in 1–2 days. The hard problem isn't the wiring — it's the proactive-trigger heuristics (the "Clippy problem"). That's where to invest.

---

## 1. Landscape

### 1.1 Table of existing projects

Rated 1–5 against the user's actual goal: *learning-focused, conversational, proactive coding buddy on Windows 11*. Higher = closer to the goal.

| # | Project | Category | Context ingestion | Output surface | Maturity (May 2026) | License | Fit | Why |
|---|---------|----------|-------------------|----------------|--------------------|---------|-----|-----|
| 1 | [Cursor](https://cursor.com/) | IDE/editor | Editor API (own fork of VS Code), repo index | Inline diff, chat, agent | Mature, dominant; >50% F500 ([source](https://cursor.com/)) | Proprietary | 2/5 | Transactional; "Tab" predicts code, not concepts. Composer is do-it-for-you, not teach-you. |
| 2 | [Continue.dev](https://github.com/continuedev/continue) | VS Code ext | Editor API, file watcher | Sidebar chat, inline | 32.9k stars, last release Mar 27 2026 ([repo](https://github.com/continuedev/continue)) | Apache-2.0 | 3/5 | Open framework; you can wire your own prompts and providers. Best base if you want to build on existing extension scaffolding rather than from scratch. |
| 3 | [Cline](https://github.com/cline/cline) | VS Code ext | Editor API, terminal, browser, screenshots via Claude computer-use | Sidebar chat, plan/act | 61.3k stars, v3.82.0 May 1 2026 ([repo](https://github.com/cline/cline)) | Apache-2.0 | 3/5 | Excellent agent loop and approval UX. Borrow its tool-use harness; ignore its do-the-task framing. |
| 4 | [Roo Code](https://github.com/RooCodeInc/Roo-Code) | VS Code ext | Same as Cline (forked) | Multi-mode chat | 23.8k stars; original team handing to community; service shutdown May 15 2026 ([source](https://www.qodo.ai/blog/roo-code-vs-cline/)) | Apache-2.0 | 2/5 | Useful prior art on "modes" (Architect/Code/Ask/Debug) — directly applicable to a "Tutor mode." But the project is in transition. |
| 5 | [Augment Code](https://www.augmentcode.com/) | VS Code ext | Repo-wide semantic index ("Context Engine") | Chat, completions | Active enterprise product ([source](https://www.augmentcode.com/context-engine)) | Proprietary | 2/5 | Best-in-class context retrieval; teaches you nothing. |
| 6 | [Tabnine](https://www.tabnine.com/) | IDE plug-in | Editor API | Inline completions, chat | Mature ([source](https://www.tabnine.com/)) | Proprietary (some open) | 1/5 | Pure autocomplete + privacy story; not conversational. |
| 7 | [Codeium / Windsurf (Cognition)](https://windsurf.com/) | IDE | Editor API, project-wide | Cascade agent, chat | Acquired by Cognition Dec 2025 ([source](https://www.taskade.com/blog/windsurf-review)) | Proprietary | 2/5 | Cascade is task-completion, not pedagogy. |
| 8 | [Sourcegraph Cody](https://sourcegraph.com/docs/cody) | VS Code ext | Code-search-graph context | Chat, inline | Active ([marketplace](https://marketplace.visualstudio.com/items?itemName=sourcegraph.cody-ai)) | Proprietary (some OSS) | 2/5 | Strong code retrieval; transactional. |
| 9 | [Zed AI / Zeta](https://zed.dev/docs/ai/edit-prediction) | IDE | Editor API | Inline edit prediction | Active ([source](https://zed.dev/docs/completions)) | OSS (GPL) | 2/5 | Multi-line prediction; not chat-shaped. |
| 10 | [Supermaven](https://supermaven.com/) | Plug-in | Editor API, 1M-token ctx | Inline | Active ([source](https://supermaven.com/)) | Proprietary | 1/5 | Pure low-latency completion, no chat. |
| 11 | [Aider (`--watch-files`)](https://aider.chat/docs/usage/watch.html) | Terminal + watcher | File watcher; reacts to `AI!`/`AI?` comments | Terminal output, edits files | ~40k stars, very active ([source](https://github.com/Aider-AI/aider)) | Apache-2.0 | 4/5 | Closest spiritual sibling. Trigger-comment idea (`# AI?`) is directly stealable for "Hey, what about this?" mode. |
| 12 | [Claude Code (SDK / hooks)](https://code.claude.com/docs/en/headless) | CLI/SDK | File system, bash, web | Terminal; programmatic via SDK | Anthropic-maintained, hooks, MCP, headless mode ([source](https://platform.claude.com/docs/en/agent-sdk/overview)) | Proprietary SDK | 4/5 | The right brainstem to plug into. Hooks let you observe the agent loop; headless mode is one-shot prompt → answer. |
| 13 | [Anthropic Learning Mode](https://www.linkedin.com/posts/claude_in-learning-mode-claude-code-becomes-a-collaborative-activity-7364344340019568642-ziA1) | Built-in Claude/Claude Code mode | Chat history | Chat, inline `#TODO` prompts | Released 2025; active ([source](https://medium.com/@CherryZhouTech/claude-ais-learning-style-transform-ai-into-a-socratic-tutor-d4e48f2c9249)) | Proprietary | 4/5 | This is literally Anthropic shipping the system prompt you'd write yourself. Use it. |
| 14 | [Rewind.ai → Limitless](https://rewind.ai/) | Screen memory | Screen+audio capture | Search, ask | **Sunset**: Meta acquired Limitless Dec 2025; screen capture disabled Dec 19 2025 ([source](https://aicloudbase.com/tool/rewind-ai)) | Proprietary | 0/5 | Dead. macOS-only when alive anyway. |
| 15 | [Microsoft Recall](https://support.microsoft.com/en-us/windows/retrace-your-steps-with-recall-aa03f8a0-a78b-4b3e-b0a1-2eb8ac48701c) | Screen memory | OS-level snapshots | Search, Click-to-Do | Copilot+ PCs only, off by default; ongoing security flak ([source](https://www.geekwire.com/2026/one-year-after-its-rocky-launch-microsofts-windows-recall-still-raises-security-red-flags/)) | Proprietary | 1/5 | Wrong shape (passive memory, not real-time buddy). API access via "Recall overview" Windows app SDK exists ([source](https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/recall/)) but reportedly unstable. |
| 16 | [Highlight AI](https://highlightai.com/) | Desktop overlay | Screen, mic, app integrations | Overlay chat (Ctrl+.) | Active, native Windows ([source](https://docs.highlightai.com/interfaces/overlay-assistant)) | Proprietary | 2/5 | Closest "always-there assistant" UX on Windows; not coding-tuned. |
| 17 | [Cluely](https://en.wikipedia.org/wiki/Cluely) | Stealth overlay | Screen, audio | Invisible overlay | $20.3M funded, $7M ARR ([source](https://www.techmeme.com/250705/p14)) | Proprietary | 1/5 | Built for cheating in interviews. Wrong values, wrong shape. |
| 18 | [Glass by Pickle](https://github.com/pickle-com/glass) | Stealth overlay (OSS) | Screen, audio | Overlay | 7.5k stars, last release **Jul 13 2025** (10 months stale) ([repo](https://github.com/pickle-com/glass)) | GPL-3.0 | 2/5 | Useful Electron overlay reference code. Project momentum has stalled. |
| 19 | [Pluely](https://github.com/iamsrikanthnani/pluely) | Stealth overlay | Screen, audio | Overlay | Active ([repo](https://github.com/iamsrikanthnani/pluely)) | OSS | 1/5 | Tauri-based 10MB overlay. Useful as size/perf reference; same wrong values as Cluely. |
| 20 | [OpenCluely](https://github.com/TechyCSR/OpenCluely) | Stealth overlay | Screen, OCR | Overlay | Active ([repo](https://github.com/TechyCSR/OpenCluely)) | OSS | 1/5 | Same as above. |
| 21 | [Screenpipe](https://github.com/screenpipe/screenpipe) | Local screen memory | 24/7 screen+mic capture | MCP server, queryable | 18.5k stars, v2.4.124 May 2 2026 (very active) ([repo](https://github.com/screenpipe/screenpipe)) | MIT | 4/5 | The right primitive if you want screen context. Rust core, exposes data via MCP — Claude can already query it. Costs nothing per minute. |
| 22 | [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | Demo-record-replay | Screenshots, mouse, keyboard, time-aligned | CLI/agent | 1.6k stars, v1.2.2 Mar 4 2026 ([repo](https://github.com/OpenAdaptAI/OpenAdapt)) | MIT | 2/5 | Aimed at process automation. Capture pipeline is reusable. |
| 23 | [Open Interpreter (OS Mode)](https://docs.openinterpreter.com/guides/os-mode) | Computer-use agent | Screenshots via `computer.display.view()` | Terminal/chat | OS mode "highly experimental" ([docs](https://docs.openinterpreter.com/guides/os-mode)) | OSS | 2/5 | Mature project; OS mode has known crashes ([issue 1116](https://github.com/OpenInterpreter/open-interpreter/issues/1116)). Screen-eyes implementation reference. |
| 24 | [Self-Operating Computer](https://github.com/OthersideAI/self-operating-computer) | Vision agent | GPT-4V/Claude vision screenshots | CLI | 10.2k stars; **last commit Feb 28 2025** (~14 months stale) ([repo](https://github.com/OthersideAI/self-operating-computer)) | MIT | 1/5 | Largely abandoned. Reference only. |
| 25 | [Claude Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Vendor capability | Screenshots + click/keyboard | Tool-loop API | Beta, supported on Opus/Sonnet 4.x ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)); Anthropic explicitly says "current latency may be too slow for human-AI interactions" | Proprietary | 2/5 | Powerful but slow & expensive for *continuous* watching. Use sparingly as a fallback signal. |
| 26 | [Wispr Flow](https://wisprflow.ai/) | Voice dictation | Mic only | Types into active app | Mature, native VS Code/Cursor integration ([source](https://wisprflow.ai/)) | Proprietary, $15/mo | 3/5 | Best STT-into-IDE UX. Cloud-only; ~800MB RAM, 8–10s startup ([source](https://medium.com/@ryanshrott/best-voice-dictation-tools-for-developers-in-2026-dictaflow-vs-wispr-flow-vs-superwhisper-edc75f70de9c)). Use as the *user→AI* leg of the voice loop, not the buddy itself. |
| 27 | [Talon Voice](https://talonvoice.com/) | Voice control | Mic, eye tracker | OS commands | Mature, niche ([source](https://www.joshwcomeau.com/blog/hands-free-coding/)) | Proprietary (free) | 1/5 | Command-grammar-driven, not conversational. |
| 28 | [Serenade](https://serenade.ai/) | Voice control | Mic | IDE commands | Largely dormant per community reports (unsourced inference based on absence in 2026 reviews) | Proprietary | 1/5 | Command-driven only. |
| 29 | [vibevoice (mpaepper)](https://github.com/mpaepper/vibevoice) | Voice + LLM | Mic + screenshot on hotkey | Types into active app | 157 stars, no releases ([repo](https://github.com/mpaepper/vibevoice)) | unspecified | 4/5 | **Closest existing prototype to what you want.** Hold scroll-lock → Whisper transcribes voice → screenshot + voice go to local LLM via Ollama → response is typed/streamed. Tiny project, but the architecture is exactly the pattern to copy. |
| 30 | [VibeVoice (Microsoft)](https://github.com/microsoft/VibeVoice) | TTS model | n/a | Audio | ICLR 2026 oral; real-time 0.5B variant ([source](https://microsoft.github.io/VibeVoice/)) | OSS weights | n/a | Candidate for the buddy's *voice* (TTS), specifically the 0.5B realtime model. |
| 31 | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Local STT | Mic | Text | Active, mainstream ([repo](https://github.com/ggml-org/whisper.cpp)) | MIT | n/a | Backbone. |
| 32 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Local STT | Mic | Text | Active ([repo](https://github.com/SYSTRAN/faster-whisper)) | MIT | n/a | 4× faster than reference Whisper at same accuracy ([source](https://github.com/SYSTRAN/faster-whisper)). Pair with VAD; ~3.3s latency on streaming long-form ([source](https://github.com/ufal/whisper_streaming)). |
| 33 | [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M) | Local TTS | Text | Audio | Apache-2.0; #1 single-speaker on HF Arena despite 82M params ([source](https://kokorottsai.com/)) | Apache-2.0 | n/a | Best price/quality TTS for a side project. ~210× realtime on RTX 4090, ~90× on 3090. |
| 34 | [Piper TTS](https://github.com/rhasspy/piper) | Local TTS | Text | Audio | Active, mainstream Home Assistant default ([repo](https://github.com/rhasspy/piper)) | OSS | n/a | Fastest CPU-only option; voice quality below Kokoro. |
| 35 | [GitHub Copilot Voice](https://githubnext.com/projects/copilot-voice/) | Voice + Copilot | Mic | Code suggestions | **Killed** Mar 2024 ([source](https://visualstudiomagazine.com/articles/2024/03/04/copilot-voice.aspx)) | Proprietary | 0/5 | Telling: even GitHub couldn't make voice-driven Copilot stick. |
| 36 | [VS Code Speech extension](https://rajeevpentyala.com/2026/01/17/vs-code-speech-add-voice-support-to-github-copilot-in-vs-code/) | Voice into Copilot Chat | Mic | Text into chat box | Active, official Microsoft ([source](https://rajeevpentyala.com/2026/01/17/vs-code-speech-add-voice-support-to-github-copilot-in-vs-code/)) | Proprietary | 2/5 | Just dictation; doesn't change the conversational/proactive shape. |
| 37 | [Granola MCP](https://www.granola.ai/blog/granola-mcp) | Meeting notes → MCP | Audio (meetings) | MCP-served context | Active ([source](https://www.granola.ai/blog/granola-mcp)) | Proprietary | 1/5 | Wrong domain (meetings) but the MCP-into-Claude-Code pattern is exactly the shape your editor-context provider should take. |
| 38 | [DeepTutor](https://github.com/HKUDS/DeepTutor) | Pedagogical agent | Text | Chat | Academic ([repo](https://github.com/HKUDS/DeepTutor)) | OSS | 2/5 | Reference for tutor-shaped prompting and evaluation. Not coding-specific. |

### 1.2 Notes per category — what to copy, what to avoid

**Real-time screen-watching memory tools (Rewind, Recall, Screenpipe, Highlight).** Rewind is dead. Recall is privacy-toxic and gated to Copilot+ PCs. Screenpipe is the only one worth integrating — it's MIT, Rust, 24/7 local, and already exposes itself as an MCP server, so Claude can query "what was on screen 30 seconds ago" without you wiring anything. Use it *as a context provider*, not as the architecture. Highlight nailed the Windows overlay UX (Ctrl+. global hotkey); steal the keybinding pattern.

**VS Code-native AI extensions (Cursor, Continue, Cline, Roo, Augment, Tabnine, Cody, Windsurf, Zed, Supermaven).** All of them are transactional ("complete this," "do this task"). The Anthropic research finding that *passive acceptance of AI code drops comprehension scores 17%* ([source](https://hereandnowai.com/ai-socratic-learning-mode-claud/)) is the entire reason your project should exist. **Copy from Cline:** the Plan/Act mode toggle and the human-in-the-loop tool approval UX. **Copy from Roo Code:** the multi-mode pattern (Architect/Code/Ask/Debug → add "Tutor"). **Copy from Cursor Tab:** the idea that suggestions trigger on cursor movement, not on demand ([source](https://cursor.com/docs/tab/overview)) — but invert it: trigger *questions* on idle/struggle, not completions. **Avoid Tabnine/Supermaven shape entirely** — autocomplete UI is the wrong surface for pedagogy.

**Voice-based coding (Wispr, Talon, Serenade, vibevoice, Copilot Voice).** Voice *input* (user→AI) is solved by Wispr Flow if you're willing to pay $15/mo, by faster-whisper + VAD if you're not. Voice *output* (AI→user) is the more interesting problem because TTS-as-buddy must be *interruptible*, *low-latency-to-first-word* (<800ms feels live), and *non-overlapping* with user typing. Microsoft's VibeVoice-Realtime-0.5B is purpose-built for that. **The vibevoice (mpaepper) repo is the single closest existing prototype to what the user wants** — the architecture (push-to-talk + screenshot + local LLM + stream back) is correct in shape; just upgrade the brain to Claude and add proactive triggers. **The fact that GitHub killed Copilot Voice in 2024 is the single most important data point in this whole research** — voice as the *primary* interaction mode for coding doesn't stick. Voice should be a side channel, not the channel.

**Conversational/social pair programmers.** This is the actually-empty quadrant. PearAI is conversational but transactional. Anthropic's *Learning Mode* is the closest official thing, but it lives inside chat sessions, not as an ambient buddy. There is no shipping product whose explicit job is "be next to me, ask the right Socratic question 3 times an hour."

**Open-source agent frameworks with screen capture (Open Interpreter, Aider --watch, browser-use, Self-Operating-Computer).** Self-Operating-Computer hasn't shipped since Feb 2025 — abandoned as a product, useful as a vision-prompt reference. Open Interpreter's OS mode is buggy on Windows. **Aider's `--watch-files` trigger-comment design (`AI!` / `AI?`) is brilliant and underused** — directly steal it: `# WHY?` in a comment makes the buddy explain that line; `# STUCK` triggers a Socratic question.

**Projects using Claude computer use specifically for live coding.** Cline ships it. The latency cost (Anthropic literally warns "current latency may be too slow" in their own docs) means you should *never* poll screenshots; only fall back to vision when the editor signal is empty (e.g., user is in a browser reading docs).

---

## 2. Technical approaches

### 2.1 Comparison

| Approach | Latency (signal→spoken response) | $/active hour @ Sonnet 4.6 | Privacy | Windows gotchas |
|---|---|---|---|---|
| **Periodic screenshots → vision** at 1Hz, 1280×800 ([Anthropic vision pricing](https://platform.claude.com/docs/en/build-with-claude/vision)) | 2–6s (vision processing dominates) | **$8–20/hr** uncached, **$2–4/hr** with prompt caching of system + recent history (see cost model §5.4) | High exposure: any secret on screen ends up in API logs | DPI scaling makes coordinates flaky; Windows screenshot APIs differ per app (UWP vs Win32) |
| **Periodic screenshots @ 0.1Hz (every 10s)** | 10s+ trigger granularity | $1–3/hr | Same | Same |
| **VS Code extension API (events)** ([API ref](https://code.visualstudio.com/api/references/vscode-api)) | <500ms; events fire instantly | **$0.30–$1.20/hr** (text-only, easily cached) | User chooses what to send; secrets only leak if `.env` is open | Terminal output is *not* readable via API ([issue 190941](https://github.com/microsoft/vscode/issues/190941)) — you only get terminal *write* and exit codes |
| **LSP / DAP** | <100ms for diagnostic events | adds <$0.05/hr (small payloads) | Local | Each language server has its own quirks; consume via VS Code's diagnostics API rather than wiring LSP yourself |
| **Hybrid (editor primary, screenshot on demand)** | <500ms for 90% of events; 3–5s when vision invoked | **$0.50–$1.50/hr** typical | Mixed; vision only fires on user intent | Combines both — manageable |
| **Voice loop, fully local** (faster-whisper int8 + Kokoro 0.5B) | 1–2s end-to-end on a decent GPU; 3–4s CPU-only | $0 incremental | Best-in-class | whisper.cpp Windows builds work; CUDA wheels for faster-whisper need correct CUDA toolkit; PowerShell quirks around audio devices |
| **Voice loop, hybrid (local STT, cloud TTS ElevenLabs/OpenAI)** | 700ms–1.5s | ~$0.10–$0.30/hr at typical talk volume | Audio leaves device | None major |

### 2.2 How often to sample screenshots without exploding tokens

Anthropic charges screenshots as standard vision input: a 1568×1568 image is roughly 1,600 tokens ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). At Sonnet 4.6 input pricing of $3/MTok, each screenshot is ~$0.005. **At 1Hz uncached, that alone is $18/hr.** With prompt caching applied to the rolling window, repeated reads of the same screenshot drop to $0.30/MTok — you'd still pay full price for *new* screenshots, so caching helps the system prompt and conversation history but not the image stream itself.

**Verdict on sampling rate:** never poll. Only screenshot on these triggers:
1. User pressed the "ask" hotkey
2. Editor signal is genuinely empty (user has been in a non-IDE window for >30s and the buddy was invoked)
3. A diagnostic appeared that references a UI element (rare; defer)

### 2.3 VS Code extension API — what you can actually get

| Signal | API | Useful for |
|---|---|---|
| Active editor change | `window.onDidChangeActiveTextEditor` | Topic shift |
| Document edits | `workspace.onDidChangeTextDocument` | "User just deleted a function" |
| Selection | `window.onDidChangeTextEditorSelection` | "User is staring at line 47" |
| Diagnostics | `languages.onDidChangeDiagnostics` | Type errors, warnings → trigger Socratic question |
| Terminal | `window.onDidStartTerminalShellExecution`, `onDidEndTerminalShellExecution`, `Terminal.shellIntegration.executeCommand` | Command exit codes; **NOT** stdout content via API ([issue 190941](https://github.com/microsoft/vscode/issues/190941)). To read stdout, attach to the shell-integration `executeCommand` stream, which yields output for *commands you run yourself*; for commands the user typed, you only see start/end events |
| Tasks / debugger | `tasks.*`, `debug.*` | Test failures, breakpoint hit |
| Git | Built-in git extension API | Commit/branch context |
| Idle | Roll your own (timer reset on any of the above) | Trigger nudge after 90s of "selection unchanged" + recent diagnostic |

### 2.4 Proactive trigger heuristics — prior art

- **Cursor Tab** triggers on every keystroke or cursor movement, but is silent if the model predicts no useful completion ([source](https://cursor.com/docs/tab/overview)). Lesson: it's fine to "consider speaking" frequently as long as you almost never actually speak.
- **Copilot's research-documented invasiveness** ([arXiv:2504.06808](https://arxiv.org/html/2504.06808v1)): expert developers find suggestions invasive; invasiveness scales with block size and lack of alternatives. Microsoft has been actively *reducing* interruptions ([source](https://www.thurrott.com/dev/324885/microsoft-scales-back-the-github-copilot-interruptions-in-visual-studio)). For a *learning* assistant the bar is even higher because the user is supposed to be thinking.
- **Dr. Gloria Mark / Cal Newport**: 23 minutes 15 seconds to regain focus after an interruption ([source](https://tctecinnovation.com/blogs/daily-blog/every-distraction-costs-you-23-minutes)); programmers take 10–15 minutes to resume editing ([source](https://www.brightdevelopers.com/the-cost-of-interruption-for-software-developers/)). **Therefore default to silence**; speak only when (a) user invited it, (b) we have high confidence they're stuck, or (c) we just saw a misconception that will compound.
- **Aider's trigger-comment** (`# AI!`/`# AI?`): elegant because the *user* opts in per-question. Dual it: passive `# WHY?` etc., and an explicit hotkey for "ask me a question right now."

Concrete trigger event list (also reused in §4):

| Trigger | Heuristic | Action |
|---|---|---|
| `EXPLICIT_ASK` | User hits hotkey or types `# WHY?`/`# STUCK`/`# AI?` | Always speak |
| `STUCK_LOOP` | Same diagnostic for >90s AND no edits to that line in 60s | Ask one Socratic question |
| `BAD_PATH` | New diagnostic count > N AND test exit non-zero in last 2 runs | Suggest a step back, *not* a fix |
| `MISCONCEPTION` | User wrote code matching one of K known anti-patterns (e.g., `await` inside non-async, mutating list during iteration) | Offer a "spot the issue" prompt |
| `NEW_TOPIC` | Active editor switched to file in unfamiliar dir | Ask what they're trying to do (only if not asked in last 10 min) |
| `IDLE_LONG` | No editor activity for 5 min, user still focused on VS Code | Optional check-in (off by default) |

---

## 3. Hard problems

### 3.1 The Clippy problem (annoying interruptions)

Concrete prior art:
- [microsoft/vscode-copilot-release issue 13649 "Copilot is completely intrusive"](https://github.com/microsoft/vscode-copilot-release/issues/13649)
- [GitHub community discussion 169714 "Why does copilot stop in the middle of the work?"](https://github.com/orgs/community/discussions/169714)
- The arXiv paper ([2504.06808](https://arxiv.org/html/2504.06808v1)) directly studied this: invasiveness rises with block size and absence of alternatives.

**How to handle it (synthesized from above):**
1. **Default silent.** Buddy speaks only on explicit invocation or strong heuristic. Never on idle alone.
2. **Budget**: maximum N proactive interruptions per hour, configurable, default 2.
3. **One-strike mute**: a "Quiet for 30 min" hotkey is the very first feature.
4. **Suggestion size cap**: never push a multi-line code suggestion proactively; only ask a question or surface a tiny inline hint. Code goes through the explicit chat surface only.
5. **No alternatives → no suggestion**: if confidence is low, don't speak.

### 3.2 Context window growth over a session

A 4-hour session at moderate edit rate easily generates 50–200k tokens of "events." Strategies (cite [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):

- **Sliding window**: keep last 30 minutes of raw events; older events are summarized into a "session-so-far" bullet list every 10 minutes.
- **Prompt cache the system prompt + the last summary** with `cache_control: { type: "ephemeral" }`. Cache reads are 0.1× input price.
- **Drop screenshots aggressively**: keep only the most recent 1–2 in context; older screenshots get replaced with a one-line text description.
- **Sonnet 4.6 supports the full 1M context at standard pricing** ([source](https://platform.claude.com/docs/en/about-claude/pricing)) — long sessions are technically fine but cost-prohibitive without summarization.

### 3.3 Latency budget for screen → model → voice

| Stage | Budget | How |
|---|---|---|
| Editor event → trigger decision | <50ms | In-process JS in extension |
| Trigger → API request sent | <100ms | Pre-built request body, persistent HTTPS connection |
| API first token (Sonnet 4.6, ~600-token system prompt cached) | 400–900ms typical (unsourced inference based on Anthropic public latency norms) | Use streaming |
| First token → first TTS audio | 200–400ms | Stream tokens to TTS; Kokoro 0.5B real-time ([source](https://github.com/microsoft/VibeVoice/blob/main/docs/vibevoice-realtime-0.5b.md)) |
| **Total perceived "speak up" latency** | **~1–2s** | Acceptable for a buddy |

For voice → buddy → voice (full duplex), faster-whisper streaming sits at ~3.3s ([source](https://github.com/ufal/whisper_streaming)). That makes back-and-forth voice barely usable; design for asymmetric (text-in, voice-out is fine; voice-in is push-to-talk).

### 3.4 Privacy: secrets / .env / customer data

- **Default-deny file globs**: never send content of `.env*`, `*.pem`, `id_rsa`, `secrets.*`, `*.key`, anything under `/secrets/`. Implement client-side, before the request leaves the machine.
- **Diff-based payloads**: when sending editor state, send the diff since last send, not the whole file. Reduces accidental secret exposure and tokens simultaneously.
- **Screenshot redaction**: if you ever screenshot, run a simple regex+entropy pass for AWS-key-shaped strings before upload (or just refuse). Reference: [Microsoft Recall's filter list](https://support.microsoft.com/en-us/windows/privacy-and-control-over-your-recall-experience-d404f672-7647-41e5-886c-a3c59680af15) is a published prior art.
- **Local-only mode**: support Ollama + a local model (e.g., Qwen2.5-Coder-32B) for sensitive repos. Quality drops but the option must exist; otherwise you'll be blocked at work codebases.

### 3.5 Cost per active coding hour — realistic envelope

See worked model in §5.4. Headline: **$0.30–$1.20/hour with editor-primary architecture and prompt caching done right; $5–15/hour if you naively screenshot at 1Hz.**

---

## 4. Recommended architecture

```
                         ┌─────────────────────────────────────────────────────┐
                         │                       VS Code                       │
                         │  ┌──────────────────────────────────────────────┐   │
   ┌──────────┐          │  │       Coding-Buddy Extension (TypeScript)    │   │
   │  Mic +   │ push-to- │  │                                              │   │
   │ Whisper  │  talk    │  │  • Event listeners (editor / diag / term /   │   │
   │ (faster- ├──────────┼─►│    git / debug / tasks / idle)               │   │
   │  whisper)│          │  │  • Trigger engine (rules in §2.4 table)      │   │
   └──────────┘          │  │  • Redactor (file-glob deny + diff payload)  │   │
                         │  │  • Sidebar chat UI (acks / "Quiet 30m" btn)  │   │
                         │  └────┬─────────────────────────────────────────┘   │
                         └───────┼─────────────────────────────────────────────┘
                                 │ stdio / WebSocket
                         ┌───────▼─────────────────┐         ┌─────────────────┐
                         │   Buddy Daemon (Node)   │         │  Screenpipe     │
                         │                         │◄────────┤  (optional MCP) │
                         │  • Conversation mgr     │  MCP    │  24/7 local     │
                         │  • Prompt cache mgr     │         │  screen memory  │
                         │  • Rate limiter / budget│         └─────────────────┘
                         │  • Session summarizer   │
                         └─────┬──────────────┬────┘
                               │              │
                       Anthropic API          │  TTS
                       (Sonnet 4.6,           ▼
                        cache_control)  ┌──────────────┐
                               │        │ Kokoro / VV  │
                               │        │ Realtime-0.5B│
                               │        └─────┬────────┘
                               │              │
                               ▼              ▼
                         streaming text   audio out (interruptible)
```

**Components:**
- **`coding-buddy-vscode`** — the extension. Pure TS. Owns all event ingestion, redaction, and the "Quiet" button. Talks to the daemon over a local WebSocket (loopback 127.0.0.1:port from a token in the workspace settings). Reason for splitting: extension host has CPU/memory limits and can't ergonomically own a long-running LLM session.
- **`buddy-daemon`** — Node + `@anthropic-ai/sdk`. Owns the Claude API session, prompt cache, rate budget, conversation memory, summarizer. Spawns a side process for TTS.
- **`buddy-voice`** — Python sidecar (because both faster-whisper and Kokoro are Python). Exposes a tiny FastAPI: POST /stt (mic chunk → text), POST /tts (text → audio). Streamed.
- **(Optional) Screenpipe MCP** — already exists, just point the daemon at it; gives the buddy a "look back at what was on screen 1 min ago" tool without you writing screen-capture code.

**Data flow (hot path, no screenshot):**
1. User edits a file; extension sees `onDidChangeTextDocument`.
2. Trigger engine evaluates rules against an in-memory event window. Most events: do nothing.
3. On a triggered event: extension builds a context bundle (editor diff since last send, current diagnostics, last 5 terminal commands & exit codes, current branch & dirty status), runs redactor, sends to daemon.
4. Daemon prepends cached system prompt, posts streamed completion to Anthropic.
5. First few tokens → if response is "speak" type, sent to TTS sidecar; if "show" type, sent back to extension UI.

---

## 5. Feasibility verdict

### 5.1 Gap analysis

**There is a real gap.** Mapped against the user's primary goal (learning) × secondary goal (companionship):

| Quadrant | Existing player | Gap? |
|---|---|---|
| Transactional + solo | Cursor, Cline, Copilot | Saturated |
| Transactional + companion | Cursor agents w/ voice add-ons | Half-baked |
| Pedagogical + solo | Claude Learning Mode, Khanmigo, DeepTutor | Partial — text-only, not ambient |
| **Pedagogical + companion (ambient, voice)** | **Nothing shipped** | **Real gap** |

The closest existing artifacts are Anthropic's Learning Mode (right brain, wrong shape — chat-only, not ambient) and `vibevoice` (right shape, weak brain, no proactive triggers). **The opportunity is the ambient + pedagogical combination, with the absolute minimum lever being a good trigger heuristic.**

What kills the project if you're not careful:
1. Becoming Clippy (see §3.1). The product *is* the discipline of staying silent.
2. Becoming yet another autocomplete (the gravitational pull of "just suggest code" is huge once the wiring is there). Codify a hard rule: buddy never writes code unless explicitly invoked with a `# WRITE` directive.
3. Latency creeping past ~2s for the speak-up moment. Past that, it stops feeling alive.

### 5.2 Weekend MVP spec — concrete enough to hand to Claude Code to build

**Goal:** in a weekend, ship a VS Code extension + Node daemon that (a) reacts to a `# AI?` trigger comment and a `Ctrl+Alt+Q` hotkey, (b) speaks a single Socratic question or short explanation via TTS, (c) supports a "Quiet 30 min" toggle. Voice input deferred to v2.

**Repo layout** (single repo, npm workspaces):

```
monitor-teacher/
  package.json                # workspaces root
  pnpm-workspace.yaml
  /extension                  # VS Code extension
    package.json              # contributes hotkey, command, view
    src/
      extension.ts            # activate(), wires events
      triggers.ts             # rules from §2.4
      redactor.ts             # glob deny + diff
      bridge.ts               # WS client to daemon
      ui/sidebar.ts           # webview for chat acks
    tsconfig.json
  /daemon                     # Node service
    package.json
    src/
      index.ts                # WS server on 127.0.0.1:31415
      session.ts              # convo + cache mgr
      anthropic.ts            # API wrapper w/ cache_control
      summarizer.ts           # hourly session squashing
      tts-bridge.ts           # spawn Python sidecar
    prompts/
      tutor.md                # system prompt (see below)
  /voice                      # Python sidecar (TTS only for v1)
    pyproject.toml
    main.py                   # FastAPI: /tts streams Kokoro audio
  README.md
```

**Key dependency versions (verified May 3 2026 or pinned to "latest as of weekend"):**

- Node: 20 LTS+
- `@anthropic-ai/sdk` ≥ 0.68 (or current; the SDK has tracked the model lineup carefully)
- `vscode` extension API: target VS Code engine `^1.95.0`
- `ws` for the loopback bridge
- Python 3.11+
- `kokoro-onnx` or `kokoro` package per [hexgrad/kokoro](https://github.com/hexgrad/kokoro)
- `fastapi`, `uvicorn`
- (Defer: `faster-whisper`, `webrtcvad-wheels` — for v2 voice input)

**System prompt — `prompts/tutor.md`:**

```
You are sitting next to a developer while they work in VS Code on Windows 11.
Your role is a senior pair-programmer-tutor. The user's goal is to LEARN, not
to have code written for them.

Hard rules:
1. NEVER write or rewrite more than 3 lines of code unless the user explicitly
   invokes the `# WRITE` directive in their request.
2. Default to questions over answers. When you suspect a misconception, ask one
   short Socratic question. Wait for the user's reply.
3. If the user is stuck on a known concept (you'll see repeated diagnostics),
   first ask what they THINK is happening, then nudge with the smallest hint
   that unblocks understanding — not the answer.
4. Use the user's variables and terms. Never invent new ones to "demonstrate."
5. Keep replies to 1-3 sentences unless the user asks "explain in depth".
6. If you're going to speak (TTS) rather than chat, replies must be one sentence.
7. NEVER mention secrets, .env contents, API keys, even if you see them in
   context. If you see one, say "I noticed a secret on screen — closing my eyes."
8. If unsure or not confident, stay silent (return the literal token NO_OP).

Trigger context format (what you'll receive in user turn):
{
  "trigger": "EXPLICIT_ASK" | "STUCK_LOOP" | "BAD_PATH" | "MISCONCEPTION" | "NEW_TOPIC" | "IDLE_LONG",
  "active_file": "src/foo.ts",
  "selection": { "line": 47, "text": "..." },
  "diagnostics": [ { "severity": "error", "message": "...", "line": 47 } ],
  "recent_diff": "<unified diff since last send, max 200 lines>",
  "recent_terminal": [ { "cmd": "npm test", "exit": 1 } ],
  "session_summary": "<bullet summary of last 30 min>",
  "user_question": "<verbatim if EXPLICIT_ASK, else null>"
}

Output format: a single JSON object, no preamble:
{ "mode": "speak" | "chat" | "no_op",
  "text": "...",
  "wants_followup": true | false }
```

**Trigger event list:** the table in §2.4 verbatim. Implementation in `triggers.ts` — pure functions over a rolling event buffer; each rule returns `null` or a trigger payload.

**Hotkeys (contributes to `package.json`):**
- `Ctrl+Alt+Q` → `coding-buddy.ask` — pop sidebar, focus input
- `Ctrl+Alt+M` → `coding-buddy.muteToggle` — quiet for 30 min
- Trigger comments: extension watches `onDidChangeTextDocument` for the literal substrings ` AI?`, ` AI!`, ` WHY?`, ` STUCK` at end-of-line, then strips them and fires `EXPLICIT_ASK`.

**Anthropic call shape (TS):**

```ts
const stream = client.messages.stream({
  model: "claude-sonnet-4-6",
  max_tokens: 400,
  system: [{ type: "text", text: TUTOR_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [
      { type: "text", text: sessionSummary, cache_control: { type: "ephemeral" } },
      { type: "text", text: JSON.stringify(triggerPayload) }
    ]}
  ]
});
```

The two `cache_control` markers split prompt caching: the long static tutor prompt is one cache block, the slowly-changing session summary is another. The trigger payload changes every turn and isn't cached. Per the [pricing docs](https://platform.claude.com/docs/en/about-claude/pricing), cache hits are 0.1× input price.

**Definition of done for the weekend:**
- Type ` # AI?` at end of any line in any file → ~2s later, a sentence appears in the sidebar.
- Press Ctrl+Alt+Q → modal input → type or paste → spoken response via Kokoro.
- Trigger an intentional TypeScript error → buddy stays silent. Leave it for 90s without editing → buddy asks one question.
- Press Ctrl+Alt+M → buddy says nothing for 30 minutes regardless of triggers.
- Open `.env` → buddy refuses to include its content (tested with a fake `OPENAI_KEY=sk-fake`).

### 5.3 Serious build path

Beyond the weekend, in priority order:

1. **Voice input** (faster-whisper, push-to-talk on Right Ctrl, à la [vibevoice](https://github.com/mpaepper/vibevoice)). VAD via `webrtcvad`. Streamed transcription into chat.
2. **Trigger quality**: build a labeled dataset of "moments where a buddy *should* speak vs shouldn't" from the user's own VS Code log. Train a tiny classifier (logistic regression on hand-crafted features + last-summary embedding) — way cheaper and more controllable than asking Claude per-event.
3. **Multi-mode** (Roo-Code-style): Tutor (default), Concept-explainer, Code-reviewer (still no writing), Architect-ducky. Each mode = different system prompt, same wiring.
4. **Personal misconception memory**: persist across sessions which misconceptions the user has shown ("forgets `await` on async DB calls"). Surface trends in a weekly "what you got better at" report — this is how it stops feeling like Clippy and starts feeling like a mentor.
5. **Local model fallback** (Ollama + Qwen2.5-Coder-32B or whatever is current): same protocol, swap the `anthropic` client for an OpenAI-compatible local one. For sensitive repos.
6. **Optional Screenpipe integration** for "what was that error in the browser console you saw 5 min ago" recall. Use it as an MCP tool, not a screenshot loop.
7. **Telemetry on yourself**: log every "buddy spoke" event with a thumbs-up/down. Use that to tune trigger thresholds.

### 5.4 Cost model (verified May 3 2026)

Verified pricing from [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing):

- **Sonnet 4.6**: $3 / MTok input, $15 / MTok output, $0.30 / MTok cache hit, $3.75 / MTok 5-min cache write.
- **Opus 4.7**: $5 / MTok input, $25 / MTok output, $0.50 / MTok cache hit. (Note Opus 4.7 uses a new tokenizer that may use up to 35% more tokens for the same text.)
- **Haiku 4.5**: $1 / MTok input, $5 / MTok output, $0.10 / MTok cache hit.

**Assumptions for an "active coding hour":**
- Trigger fires ~12 times/hour (≈ once every 5 minutes — consistent with §3.1's max-2/hr *spoken* budget plus silent NO_OPs).
- Per turn:
  - 600-token static system prompt (cached, hit price)
  - 400-token rolling session summary (cached, hit price; rewritten ~6×/hour at write price)
  - 400-token live trigger payload (uncached input)
  - 200-token output average (most are NO_OP shorts, occasional longer reply)
- No screenshots in the hot path.

**Per hour with Sonnet 4.6:**

| Line item | Tokens | Rate ($/MTok) | Cost |
|---|---|---|---|
| System prompt (cache write, 6×) | 600 × 6 = 3,600 | 3.75 | $0.014 |
| System prompt (cache hits, 12×) | 600 × 12 = 7,200 | 0.30 | $0.002 |
| Session summary (cache writes, 6×) | 400 × 6 = 2,400 | 3.75 | $0.009 |
| Session summary (cache hits, 6×) | 400 × 6 = 2,400 | 0.30 | $0.001 |
| Live trigger payload (uncached, 12×) | 400 × 12 = 4,800 | 3.00 | $0.014 |
| Output (12×) | 200 × 12 = 2,400 | 15.00 | $0.036 |
| Hourly summarizer call (1× Haiku 4.5, 1k in / 200 out) | — | — | $0.002 |
| **Total** | | | **~$0.078/hr** |

That's an order of magnitude under the $0.30–$1.20 envelope I quoted in TL;DR — **the envelope is a more honest figure that bakes in heavier-use scenarios:**

- Heavier scenario: 30 triggers/hour, 50% NO_OPs, larger trigger payload (1500 tok diff context), occasional 800-token output → **~$0.30–$0.50/hr**.
- "Talking a lot, voice mode on" with longer outputs and 50 triggers/hr → **~$1.00–$1.20/hr**.
- **Worst case (you ignore advice and screenshot at 1Hz with no caching of images):** $8–20/hr — see §2.2.

**Sonnet vs. Opus:** Opus 4.7 is ~5–10× the cost (and uses ~35% more tokens for the same text per Anthropic's own note). For a tutoring use case, Sonnet 4.6 is the right default; reserve Opus for the (rare) complex-architectural-review trigger.

**Sonnet vs. Haiku 4.5:** Haiku is ~3× cheaper and likely sufficient for the trigger-classification call ("should I speak here? if yes, what kind of utterance?"). Two-tier: Haiku decides whether to speak, Sonnet writes what to say. Cuts cost roughly in half on no-op-heavy hours.

---

## 6. Sources

- Anthropic Pricing — https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic Vision docs — https://platform.claude.com/docs/en/build-with-claude/vision
- Anthropic Computer Use tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Anthropic Agent SDK overview — https://platform.claude.com/docs/en/agent-sdk/overview
- Claude Code Headless mode — https://code.claude.com/docs/en/headless
- Claude Opus 4.7 announcement — https://www.anthropic.com/news/claude-opus-4-7
- Anthropic Prompt Caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic Learning Mode write-up — https://medium.com/@CherryZhouTech/claude-ais-learning-style-transform-ai-into-a-socratic-tutor-d4e48f2c9249
- Cursor — https://cursor.com/
- Cursor Tab docs — https://cursor.com/docs/tab/overview
- Cursor "A new Tab model" blog — https://cursor.com/blog/tab-update
- Continue.dev repo — https://github.com/continuedev/continue
- Continue marketplace — https://marketplace.visualstudio.com/items?itemName=Continue.continue
- Cline repo — https://github.com/cline/cline
- Cline marketplace — https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev
- Roo Code repo — https://github.com/RooCodeInc/Roo-Code
- Roo Code vs Cline review — https://www.qodo.ai/blog/roo-code-vs-cline/
- Augment Code Context Engine — https://www.augmentcode.com/context-engine
- Tabnine — https://www.tabnine.com/
- Windsurf review (post-Cognition) — https://www.taskade.com/blog/windsurf-review
- Sourcegraph Cody docs — https://sourcegraph.com/docs/cody
- Zed completions — https://zed.dev/docs/completions
- Supermaven — https://supermaven.com/
- Aider docs — https://aider.chat/docs/
- Aider --watch docs — https://aider.chat/docs/usage/watch.html
- Aider GitHub — https://github.com/Aider-AI/aider
- Rewind / Limitless review — https://aicloudbase.com/tool/rewind-ai
- Microsoft Recall — https://support.microsoft.com/en-us/windows/retrace-your-steps-with-recall-aa03f8a0-a78b-4b3e-b0a1-2eb8ac48701c
- Microsoft Recall privacy controls — https://support.microsoft.com/en-us/windows/privacy-and-control-over-your-recall-experience-d404f672-7647-41e5-886c-a3c59680af15
- Recall security flak — https://www.geekwire.com/2026/one-year-after-its-rocky-launch-microsofts-windows-recall-still-raises-security-red-flags/
- Recall Windows app SDK — https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/recall/
- Highlight AI — https://highlightai.com/
- Highlight Assistant docs — https://docs.highlightai.com/interfaces/overlay-assistant
- Cluely Wikipedia — https://en.wikipedia.org/wiki/Cluely
- Cluely vs Glass — https://hyperlush.com/cluely-vs-glass/
- Glass repo — https://github.com/pickle-com/glass
- Pluely — https://github.com/iamsrikanthnani/pluely
- OpenCluely — https://github.com/TechyCSR/OpenCluely
- Screenpipe repo — https://github.com/screenpipe/screenpipe
- OpenAdapt repo — https://github.com/OpenAdaptAI/OpenAdapt
- Open Interpreter OS Mode — https://docs.openinterpreter.com/guides/os-mode
- Open Interpreter os-mode bug — https://github.com/OpenInterpreter/open-interpreter/issues/1116
- Self-Operating Computer — https://github.com/OthersideAI/self-operating-computer
- Wispr Flow — https://wisprflow.ai/
- Wispr Flow review (developer angle) — https://medium.com/@ryanshrott/best-voice-dictation-tools-for-developers-in-2026-dictaflow-vs-wispr-flow-vs-superwhisper-edc75f70de9c
- Talon — https://talonvoice.com/
- Talon for coding (Comeau) — https://www.joshwcomeau.com/blog/hands-free-coding/
- vibevoice (mpaepper) — https://github.com/mpaepper/vibevoice
- Microsoft VibeVoice — https://github.com/microsoft/VibeVoice
- VibeVoice Realtime 0.5B — https://github.com/microsoft/VibeVoice/blob/main/docs/vibevoice-realtime-0.5b.md
- whisper.cpp — https://github.com/ggml-org/whisper.cpp
- faster-whisper — https://github.com/SYSTRAN/faster-whisper
- whisper_streaming (latency numbers) — https://github.com/ufal/whisper_streaming
- Kokoro TTS — https://huggingface.co/hexgrad/Kokoro-82M
- Kokoro project page — https://kokorottsai.com/
- Piper TTS — https://github.com/rhasspy/piper
- GitHub Copilot Voice killed — https://visualstudiomagazine.com/articles/2024/03/04/copilot-voice.aspx
- Copilot Voice project page — https://githubnext.com/projects/copilot-voice/
- VS Code Speech extension write-up — https://rajeevpentyala.com/2026/01/17/vs-code-speech-add-voice-support-to-github-copilot-in-vs-code/
- Granola MCP — https://www.granola.ai/blog/granola-mcp
- DeepTutor — https://github.com/HKUDS/DeepTutor
- VS Code API reference — https://code.visualstudio.com/api/references/vscode-api
- VS Code terminal stdout API issue — https://github.com/microsoft/vscode/issues/190941
- Copilot invasiveness paper — https://arxiv.org/html/2504.06808v1
- Copilot intrusiveness issue — https://github.com/microsoft/vscode-copilot-release/issues/13649
- Microsoft scaling back Copilot interruptions — https://www.thurrott.com/dev/324885/microsoft-scales-back-the-github-copilot-interruptions-in-visual-studio
- 23-minute interruption cost — https://tctecinnovation.com/blogs/daily-blog/every-distraction-costs-you-23-minutes
- Cost of interruptions for developers — https://www.brightdevelopers.com/the-cost-of-interruption-for-software-developers/
- Cal Newport "Beyond Flow" — https://calnewport.com/beyond-flow/
- Top Agentic AI Tools for VS Code — https://visualstudiomagazine.com/articles/2025/10/07/top-agentic-ai-tools-for-vs-code-according-to-installs.aspx
- Techmeme: Cluely / Pickle Glass — https://www.techmeme.com/250705/p14
