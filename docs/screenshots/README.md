# Sidebar screenshots — Task 15.3

Three PNGs the Quickstart in the root README references. They render
as broken-image icons until someone drops them in. The README's alt
text describes what each should show, so the prose stays useful in
the meantime.

| Path                             | What it should show |
|----------------------------------|---------------------|
| `sidebar-idle.png`               | Sidebar at idle. Red mic dot in the input row (mic permission not yet granted), status pill at the top reads **Ready** with the blue swatch. Mode dropdown set to `tutor`, Personality `nice`. |
| `sidebar-listening.png`          | After pressing <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>: mic dot turns green and pulses, status pill reads **I'm listening…** with the green pulsing swatch. The transcript area is empty (or contains the user's prior turns). |
| `sidebar-speaking.png`           | Buddy is mid-reply: status pill reads **Buddy is speaking…** with the purple pulsing swatch. The latest assistant turn appears in the transcript above the input. |

## How to capture them

The Quickstart README walks the new user through exactly the moments
each screenshot represents — at step 4, 5, and 6 respectively. Capture
each via your OS's snipping tool (Win+Shift+S / Cmd+Shift+4) once the
sidebar is in the documented state.

Conventions:
- 1× DPI (no Retina doubling) — keeps the images small.
- Crop tightly around the sidebar webview; no editor pane, no title
  bar.
- PNG, ≤200 KB each. Optimise via `pngcrush` / `oxipng` if needed.
- Use the default VS Code dark theme so the colour swatches match
  what the sidebar HTML in `extension/src/ui/sidebar.ts` defines for
  `.msg.user`, `#buddy-state[data-state="listening"]`, etc.

## Why these aren't tracked yet

The repo's CI doesn't have a screen / mic, and Coding Buddy's loop
agent can't synthesise UI screenshots that look right. A follow-up
contributor with a real machine should drop these in via a tiny PR
that only adds the three PNGs — no other changes needed.
