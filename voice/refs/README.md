# XTTS-v2 reference clips

Each `<personality>.wav` here is the reference voice that XTTS-v2 clones
when synthesising for that personality (Task 12.4).

## What's shipped

The committed files (`drill_sergeant.wav`, `pirate.wav`,
`shakespearean.wav`, `rude.wav`) are **1-second silent placeholders**
sized identically (24 kHz mono Int16 PCM). They make the daemon's
routing tests pass without bloating the repository — they are NOT
useful for actual voice cloning. XTTS-v2 will accept them but
produce garbage output.

## Recommended replacements

Replace the placeholders with **5-7 seconds** of clean, in-character
speech for each personality. Sources:

- **Public domain**: LibriVox, Internet Archive, U.S. government PSAs,
  pre-1928 recordings. Match the personality's vibe.
- **Self-recorded**: 5-7s of you (or a willing friend) speaking
  in-character. Plain microphone in a quiet room is enough.

XTTS-v2 hard requirements for the reference clip:
- 24 kHz mono. Other rates work but get resampled internally.
- Clean — no background music, no overlapping speakers.
- Single emotion / pace — XTTS clones whatever's in the clip.
- 5-15 seconds. Under 5s gives the model too little; over 15s
  bogs down loading.

## How to record one (Audacity, ~2 minutes)

1. File → New, set sample rate to 24000 Hz.
2. Tracks → Add New → Mono Track.
3. Hit record, speak 5-7 seconds in character.
4. Stop, trim silence at both ends (Edit → Remove Special →
   Trim Audio if you've selected a region; otherwise drag-select
   the silence and Delete).
5. File → Export → Export as WAV → "Signed 16-bit PCM" →
   sample rate 24000 → save as `<personality>.wav`.

## Drop-in

Replace the file in this directory; the personality's
`personality.json` already points at `refs/<personality>.wav`. The
daemon picks up the new clip on the next `setPersonality` call —
no daemon restart required.

## Why placeholders ship at all

XTTS-v2 needs a real on-disk file path to even start. Without these
placeholders, every CI run that spins up the XTTS sidecar would have
to fabricate a fixture WAV in tmp first. Shipping placeholders makes
the routing tests deterministic across machines.
