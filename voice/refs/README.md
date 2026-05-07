# XTTS-v2 reference clips

Each `<personality>.wav` here is the 5-7 second reference XTTS-v2
clones when synthesising for that personality. Tasks 12.4 and 15.7
established the contract; this README is the shipped index.

## Files in this directory

| File                  | Length | Purpose | Provider gate |
|-----------------------|--------|---------|---------------|
| `drill_sergeant.wav`  | 5s     | clipped, imperative, high-tempo voice (Task 12.4) | any |
| `pirate.wav`          | 5s     | pirate cadence (Task 12.4)                        | any |
| `shakespearean.wav`   | 5s     | early-modern English actor (Task 12.4)            | any |
| `rude.wav`            | 5s     | blunt, no-softener delivery (Task 12.4)           | any |
| `nsfw.wav`            | 5s     | uncensored register (Task 15.7)                   | `BUDDY_PROVIDER=ollama` only |

All files are 24 kHz mono Int16 PCM WAVs — the format XTTS-v2
expects (Task 12.3 sidecar resamples anything else internally,
but a clean 24 kHz mono input is friendliest).

## What's currently shipped

The committed files are **5-second silent placeholders** sized
identically to make the test contract pass and the build/CI
pipeline green. They are NOT useful for actual voice cloning —
XTTS-v2 will accept them but produce monotonic output. Replace
each with real character speech.

## Attribution

Project-shipped placeholders: synthesised programmatically (silent
WAVs) — no third-party audio. No attribution is owed for the
shipped files.

When you replace a placeholder with real audio, follow one of
these paths:

1. **Public-domain sources** (preferred for the upstream repo).
   - LibriVox readings (CC-PDM 1.0).
   - Internet Archive movie/PSA clips with explicit PD status.
   - Pre-1928 phonograph recordings (US public-domain default).
   Always cite the source URL + date in this README's
   "Replacement attributions" subsection (template below).

2. **Self-recorded** by you or a willing performer. The performer
   grants the project permission via a one-line "I, _, grant
   monitor-teacher project permission to redistribute this clip
   under MIT" note kept under `voice/refs/.attributions/`. The
   `.gitignore` keeps that subdir out of the public tree.

3. **Generated** by a TTS that allows downstream redistribution
   (Coqui XTTS-v2's terms allow this for the project's own use).

## Audacity recipe (Windows / macOS / Linux, ~2 minutes)

1. **File → New** to create an empty project.
2. **Edit → Preferences → Quality** → Default Sample Rate: 24000 Hz.
3. **Tracks → Add New → Mono Track**.
4. Hit the red record button. Speak in character for 6 seconds —
   one or two sentences is plenty. Stop when done.
5. Drag-select any silence at the start and end, **Edit → Delete**.
   The remaining audio should be 5-7 seconds.
6. **Effect → Normalize** → -1.0 dB peak amplitude. Click OK.
   (Removes loudness drift between takes; XTTS clones whatever's
   in the clip, so consistent levels matter.)
7. **File → Export → Export as WAV**:
   - Format: WAV (Microsoft)
   - Encoding: Signed 16-bit PCM
   - Sample rate: 24000 Hz
   - Channels: Mono
   - Filename: `<personality>.wav` (e.g. `drill_sergeant.wav`)
8. Drop the file into `voice/refs/`. The personality already
   points at it via `daemon/prompts/personalities/<name>.json`'s
   `xtts_ref` field — no daemon restart needed.

## Replacement attributions

Add an entry here when you swap in real audio. One row per file.

| File | Source | Date acquired | Notes |
|------|--------|---------------|-------|
| _none yet — placeholders are project-generated silence_ | — | — | — |

## XTTS-v2 hard requirements (reminder)

- 24 kHz mono. Other rates work but get resampled internally.
- Clean — no background music, no overlapping speakers.
- Single emotion / pace — XTTS clones whatever's in the clip.
- 5-15 seconds. Under 5s gives the model too little; over 15s
  bogs down loading.
- WAV (PCM s16le). MP3/FLAC will be re-decoded; lossy formats
  hurt clone quality.

## Why the placeholders ship at all

XTTS-v2 needs a real on-disk file path to even start. Without
these placeholders, every CI run that spins up the XTTS sidecar
would have to fabricate a fixture WAV in tmp first. Shipping
placeholders makes the routing tests deterministic across machines.
