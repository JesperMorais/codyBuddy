# Backchannels

Pre-recorded short audio cues the daemon plays locally (no LLM call) to
acknowledge a long stretch of user speech without taking the floor —
similar to how a human listener says *mhm* / *right* / *yeah* / *go on*
/ *hmm* while the speaker is still going.

Driven by the `BackchannelController` (`daemon/src/backchannel.ts`):
- Fires only when the conversation loop is `LISTENING` and the user has
  been speaking for >3s.
- Cooldown ≥8s between plays so the buddy doesn't spam interjections.
- Off when `BUDDY_BACKCHANNEL=off`.

## Files in this directory

Each phrase ships in **3 takes** with deliberately varied prosody so
back-to-back plays don't sound identical. Filenames are `<word>-<take>.wav`:

```
mhm-1.wav     mhm-2.wav     mhm-3.wav
right-1.wav   right-2.wav   right-3.wav
yeah-1.wav    yeah-2.wav    yeah-3.wav
go-on-1.wav   go-on-2.wav   go-on-3.wav
hmm-1.wav     hmm-2.wav     hmm-3.wav
```

## Format

- 16-bit PCM mono WAV
- 24 kHz sample rate (matches Kokoro's default output)
- 200–500 ms long (short enough to not interrupt the user)
- Peak around -6 dBFS (loud enough to be heard over the user's mic
  feed, quiet enough not to startle)

## ⚠️ Placeholder status

The files committed in this directory right now are **300 ms of
silence**. They satisfy the loader contract so the daemon boots and
the test suite passes, but the user will not hear anything when a
backchannel fires.

**Recording your own takes**, in Audacity:

1. New → Record (mic must be at the same level you'd use for normal
   conversation)
2. Say the phrase. Aim for relaxed, low-energy delivery — backchannels
   are *acknowledgements*, not statements.
3. Three takes per phrase: vary intonation slightly each time
   (rising, flat, falling) so the random rotation feels natural.
4. Edit → Truncate Silence to trim head/tail.
5. Tracks → Resample → 24000 Hz.
6. Tracks → Mix → Mix Stereo Down to Mono (if recorded in stereo).
7. Effect → Normalize → -6 dB peak.
8. File → Export Audio → 16-bit PCM WAV. Save as `<word>-<take>.wav`
   in this directory, replacing the placeholder.

Public-domain alternative: clips from [LibriVox](https://librivox.org/)
or [Mozilla Common Voice](https://commonvoice.mozilla.org/) can be
trimmed to the right phrases — just check the licence on each clip
before committing.

## Why pre-recorded, not synthesised?

Kokoro and most other neural TTS voices struggle with very short
acknowledgements: prosody planning needs surrounding text to land
naturally, and a one-syllable utterance comes out flat or robotic.
Pre-recorded human takes preserve the breath, hesitation, and
falling-tone signature that makes a backchannel actually *feel* like
a backchannel.
