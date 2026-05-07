// Audio device enumeration — Task 15.8.
//
// The daemon fronts the OS-specific device-listing logic for the
// extension's "Select Audio Devices" command. The interface is
// deliberately small so a future PR can swap in a real per-OS
// implementation (Linux: pactl / aplay -L, macOS: system_profiler,
// Windows: Get-CimInstance Win32_SoundDevice).
//
// For 15.8 we ship a stub provider that returns an empty list on
// every platform. The extension's quickpick falls back to "system
// default" in that case so users can still wire up the .env file.
// The real-OS enumeration is intentionally deferred — getting it
// right means a non-trivial amount of native code per platform,
// and the .env-write contract works regardless of which device
// IDs come back.

export interface AudioDevice {
  /** Stable identifier — what gets written to BUDDY_AUDIO_*_ID. */
  id: string;
  /** Human-readable label for the quickpick. */
  name: string;
  /** Optional: marks the OS's current default. The picker can
   *  preselect this. */
  isDefault?: boolean;
}

export interface AudioDeviceList {
  input: AudioDevice[];
  output: AudioDevice[];
}

/**
 * Default provider — returns an empty list on every platform.
 * The extension UI must still work: when the list is empty, the
 * picker offers "system default" as the only choice and writes
 * the literal string `default` to .env.
 *
 * Real per-OS enumeration is the follow-up. Until then this stub
 * makes the WS contract testable end-to-end without forcing the
 * daemon to depend on a native module.
 */
export async function enumerateAudioDevices(): Promise<AudioDeviceList> {
  return { input: [], output: [] };
}
