# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Generated from `git log` by `scripts/gen-changelog.mjs`.

## [Unreleased] — generated 2026-05-06

### Added
- Task 0.1: add test scripts and make all existing tests green (#1) (bfc72e7)
- Task 0.2: add typecheck scripts (#2) (11d2fc3)
- Task 0.3: add GitHub Actions CI (#3) (f5c0b58)
- Task 0.4: validate BUDDY_TTS_BACKEND, drop BUDDY_TTS_ENABLED (#4) (06bd450)
- Task 1.1: extract AiClient interface, add FakeAnthropicClient fixture (#5) (a86f742)
- Plan: add Phase 9 (Personalities) (29f1399)
- Task 1.2: WS integration test with FakeAnthropicClient (#6) (4b67faa)
- Plan: add Phases 10-14 (conversation loop, streaming, voice acting, cost, UI) (c6a4143)
- Task 1.3: cover all four trigger comment suffixes + negatives (#7) (9f5d555)
- Task 1.4: focused STUCK_LOOP timing tests (#9) (b751cca)
- Plan: add Phase 15 (Setup & onboarding) (78a9520)
- Task 1.5: focused Session.mute() tests via FakeAnthropicClient (#10) (bb2f35f)
- Task 1.6: redactor tests for file deny + secret scrub (#11) (c116fdb)
- Task 1.7: real-API smoke test gated on ANTHROPIC_API_KEY (#12) (6994663)
- Task 2.1: wire kokoro HTTP backend in tts-bridge (#13) (dcb232d)
- Task 2.2: comprehensive routing tests for TtsBridge (#14) (8cb441e)
- Task 2.3: voice sidecar /health and /tts smoke test (#15) (b2d3a09)
- Task 3.1: auto-spawn daemon on extension activation (#16) (2b6e3ff)
- Task 3.2: bridge health probe + status pill (#17) (d06b487)
- Task 3.3: persist mute state across daemon restarts (#18) (3e9f5a6)
- Task 4.1: Haiku gate (shouldSpeak) before Sonnet ask (#19) (93b2c95)
- Task 4.2: behavioural coverage of the Haiku→Sonnet gate (#20) (5aa52be)
- Task 4.3: token-cost telemetry per API response (#21) (16736ee)
- Task 5.1: expand ANTI_PATTERNS with five new detectors (#22) (48983b8)
- Task 5.2: misconception map alongside the transcript log (#23) (8535c0e)
- Task 5.3: 3-hits-recurring → count >= 3 in next distill (#24) (e9383e2)
- Task 6.1: mode-switch integration test (#25) (5be0df8)
- Task 6.2: per-mode fixture + snapshot-style request assertions (#26) (539b1c1)
- Task 7.1: Screenpipe context provider for EXPLICIT_ASK fallback (#27) (a06f670)
- Task 7.2: Ollama (OpenAI-compatible) provider (#28) (0a1e02d)
- Task 7.3: thumbs-up/down votes + tune-triggers report (#29) (c1f340f)
- Task 8.1: rewrite README to match shipped behaviour + DoD test links (#30) (b7d537b)

### Notes
- Initial commit: Coding Buddy MVP scaffolding (0723290)
- Add TASKS.md — ordered backlog for autonomous routine (e062bfd)
