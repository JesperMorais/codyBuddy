# Screencasts — Task 15.13

The repo's quickstart screencast lives at
`docs/screencasts/quickstart.mp4`. The README links to it from
the Quickstart section. This README is the recording brief — what
to capture, what to say, how long each beat should run.

## File index

| Path | Length | Status |
|------|--------|--------|
| `quickstart.mp4` | ~5 min | **Not yet recorded** — manual deliverable. The repo ships without the binary; the README link is a 404 until someone drops the MP4 in. See *Recording brief* below. |

## Why the binary isn't tracked yet

Recording a believable screencast needs a real machine, a real
microphone, a real Anthropic API key, and a real OS to permission
the mic against. The loop agent has none of these, and CI has no
display / mic / camera. A follow-up contributor with all four
records the video and lands it via a one-file PR.

## Recording brief — quickstart.mp4

**Audience.** A developer who has just cloned the repo for the first
time and wants to know whether to keep going.

**Length.** 5:00 ± 0:30. Short enough that someone reading the
README will press play; long enough to actually show the buddy
respond.

**OS.** Windows 11 is the recommended primary because it's the most
tested platform and the CI matrix's first runner. macOS works too —
note up front which OS you're recording on.

**Beats** (timings approximate; aim for the totals, drop bullets if
you're over):

| Beat | Length | What to show |
|------|--------|-------------|
| Cold open — title card | 0:10 | "Coding Buddy: from `git clone` to first voice turn." Black background, monospace title, no music. |
| `git clone` + `cd` | 0:20 | Type the two commands; show the cloned tree in the file explorer briefly. |
| Run the installer | 1:00 | `pwsh -File setup.ps1` (or `bash setup.sh`). Voice-over: "Installer checks Node, pnpm, Python — prints the install command for whatever's missing. Idempotent — safe to re-run." Pause on the final "Setup complete" line. |
| Paste the API key | 0:30 | Open `.env` in VS Code, replace the placeholder, save. Mention `pnpm doctor` — show it green in passing (don't dwell). |
| Press F5 | 0:30 | Launch the Extension Development Host. Sidebar opens with "Ready" pill. |
| Press Ctrl+Alt+V | 1:00 | Mic-permission prompt → "Allow." Sidebar pill flips to "I'm listening…". Ask one short question into the mic ("walk me through this code"). |
| First voice reply | 1:00 | Buddy thinks → speaks. Status pill cycles thinking → speaking → ready. |
| Outro | 0:30 | Cut to a card listing what's next: trigger comments, mode switching, sidebar votes. Link back to the README's full Quickstart. |

Total: ~5:00.

## Voice-over

Plain narration — match the README's tone (terse, friendly, no
marketing copy). If you don't want to be on the video, an offline
TTS narration works fine; Coqui XTTS-v2 with the project's own
`voice/refs/nice.wav` reference clip is on-brand.

## Capture / encode

- **Recorder.** OBS Studio (free, cross-platform). Use the
  "Display Capture" source plus "Audio Input Capture" (mic) plus
  "Audio Output Capture" (system audio so the buddy's voice lands
  in the recording).
- **Resolution.** 1920×1080 at 30 fps. README readers default to
  1080p; higher is wasted.
- **Encoding.** H.264, 8 Mbps target, AAC audio at 192 kbps. The
  result should be ~150 MB for a 5-minute clip — comfortable for
  Git LFS once it's committed (or attached to a release if you'd
  rather not bloat the repo).

## Where to put it

- **Preferred**: commit the MP4 to `docs/screencasts/quickstart.mp4`
  via Git LFS. The README's `<video>` tag (or `<a>` link) renders
  it inline on github.com.
- **Alternative**: upload to a GitHub Release as an asset and link
  from the README. Lighter on the repo, but the link drifts if the
  release is retagged.

## Privacy + secrets

- Blur or replace your real API key on screen.
- Don't include workspace files that aren't yours.
- The mic permission dialog is OS-chrome and safe to show.

## Update the README

Once the MP4 lands, add a `<video>` block (or fall back to a
plain link) to the README's Quickstart section. The drift-guard
test in `daemon/test/screencast-link.test.mjs` checks that the
link/embed exists with the documented path.
