import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TtsBackend = "none" | "piper" | "kokoro";

/**
 * Test seams. Production code passes none of these — defaults to the real
 * node:child_process.spawn, node:fs.existsSync, and globalThis.fetch.
 */
export interface TtsTestHooks {
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  existsImpl?: (path: string) => boolean;
}

export interface TtsConfig extends TtsTestHooks {
  backend: TtsBackend;
  piperExe?: string;
  piperVoice?: string;
  /** Endpoint of the Kokoro FastAPI sidecar (voice/main.py). Default: http://127.0.0.1:31416/tts */
  kokoroUrl?: string;
  volume?: number;
}

const DEFAULT_KOKORO_URL = "http://127.0.0.1:31416/tts";

export class TtsBridge {
  private busy = false;
  private queue: string[] = [];
  /** In-flight subprocess (Piper synth or PowerShell playback). Held
   *  so cancel() can SIGINT it for the hard-mute hotkey (Task 10.4),
   *  not just clear the queue. */
  private activeProc?: ChildProcess;
  /** AbortController for the in-flight Kokoro fetch. Same role as
   *  activeProc, for the HTTP path. */
  private activeAbort?: AbortController;
  /** Active Kokoro voice id (Task 12.2). Set by the server whenever
   *  setPersonality succeeds, looked up from each personality's
   *  kokoro_voice config. Undefined = let the sidecar pick its
   *  own default. */
  private kokoroVoice?: string;

  constructor(private cfg: TtsConfig) {}

  /** Update the Kokoro voice for subsequent synth calls. The next
   *  speak() will include it in the request body; in-flight requests
   *  are not retroactively retargeted. Empty / undefined clears the
   *  override (sidecar default voice). */
  setKokoroVoice(voice?: string): void {
    this.kokoroVoice = voice && voice.length > 0 ? voice : undefined;
  }

  /** Read the active Kokoro voice. Mostly for tests / introspection. */
  getKokoroVoice(): string | undefined {
    return this.kokoroVoice;
  }

  isActive(): boolean {
    return this.cfg.backend !== "none";
  }

  describe(): string {
    if (this.cfg.backend === "none") return "off";
    if (this.cfg.backend === "piper")
      return `piper (vol=${this.volume().toFixed(2)})`;
    if (this.cfg.backend === "kokoro")
      return `kokoro (${this.cfg.kokoroUrl ?? DEFAULT_KOKORO_URL})`;
    return this.cfg.backend;
  }

  setVolume(v: number): void {
    this.cfg.volume = Math.max(0, Math.min(1, v));
  }

  private volume(): number {
    const v = this.cfg.volume;
    if (v === undefined || isNaN(v)) return 0.5;
    return Math.max(0, Math.min(1, v));
  }

  async speak(text: string): Promise<void> {
    if (!text || this.cfg.backend === "none") return;
    const cleaned = stripForSpeech(text);
    if (!cleaned) return;
    this.queue.push(cleaned);
    if (!this.busy) void this.drain();
  }

  /** Drop the queue AND interrupt any in-flight TTS. Returns true if
   *  a SIGINT was sent (i.e. there was an active Piper/playback
   *  subprocess) — the hard-mute handler uses that to confirm the
   *  spec's <50ms kill landed. */
  cancel(): { signaled: boolean } {
    this.queue.length = 0;
    let signaled = false;
    if (this.activeProc && this.activeProc.exitCode === null) {
      try {
        this.activeProc.kill("SIGINT");
        signaled = true;
      } catch {
        // already dead; nothing to do
      }
    }
    this.activeProc = undefined;
    if (this.activeAbort) {
      try {
        this.activeAbort.abort();
        signaled = true;
      } catch {
        // ignore
      }
      this.activeAbort = undefined;
    }
    return { signaled };
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        try {
          await this.speakNow(next);
        } catch (err) {
          console.error("[tts] speak failed:", err);
          break;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async speakNow(text: string): Promise<void> {
    if (this.cfg.backend === "kokoro") {
      await this.speakViaKokoro(text);
      return;
    }
    if (this.cfg.backend !== "piper") return;
    const exe = this.cfg.piperExe;
    const voice = this.cfg.piperVoice;
    const exists = this.cfg.existsImpl ?? existsSync;
    if (!exe || !voice || !exists(exe) || !exists(voice)) {
      throw new Error(`piper not configured: exe=${exe} voice=${voice}`);
    }

    const wavDir = mkdtempSync(join(tmpdir(), "buddy-tts-"));
    const wavPath = join(wavDir, "out.wav");

    const spawnFn = this.cfg.spawnImpl ?? spawn;
    await new Promise<void>((resolve, reject) => {
      const piper = spawnFn(exe, ["--model", voice, "--output_file", wavPath], {
        windowsHide: true,
      });
      this.activeProc = piper;
      let stderr = "";
      piper.stderr?.on("data", (d) => (stderr += d.toString()));
      piper.on("error", reject);
      piper.on("close", (code) => {
        if (this.activeProc === piper) this.activeProc = undefined;
        if (code === 0) resolve();
        else reject(new Error(`piper exit ${code}: ${stderr.slice(0, 200)}`));
      });
      piper.stdin?.write(text + "\n");
      piper.stdin?.end();
    });

    await this.playWavTracked(wavPath, this.volume());
    try {
      unlinkSync(wavPath);
    } catch {
      // ignore
    }
  }

  private async speakViaKokoro(text: string): Promise<void> {
    const url = this.cfg.kokoroUrl ?? DEFAULT_KOKORO_URL;
    const fetchFn = this.cfg.fetchImpl ?? fetch;
    const abort = new AbortController();
    this.activeAbort = abort;
    const body: { text: string; voice?: string } = { text };
    if (this.kokoroVoice) body.voice = this.kokoroVoice;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) {
        throw new Error(`kokoro POST ${url} → HTTP ${res.status}`);
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }

  /** Tracked wrapper around playWavWindows so cancel() can SIGINT the
   *  PowerShell playback process too — without it the post-synth
   *  audio would keep playing for the full clip duration even after
   *  hard-mute. */
  private playWavTracked(path: string, volume: number): Promise<void> {
    return new Promise((resolve) => {
      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", powershellPlayScript(path, volume)],
        { windowsHide: true }
      );
      this.activeProc = ps;
      ps.on("close", () => {
        if (this.activeProc === ps) this.activeProc = undefined;
        resolve();
      });
      ps.on("error", () => {
        if (this.activeProc === ps) this.activeProc = undefined;
        resolve();
      });
    });
  }
}

function naturalizeCode(code: string): string {
  let t = code;
  t = t.replace(/'\\0'/g, " null terminator ");
  t = t.replace(/"\\0"/g, " null terminator ");
  t = t.replace(/'\\n'/g, " newline character ");
  t = t.replace(/\\n/g, " newline ");
  t = t.replace(/\\t/g, " tab ");
  t = t.replace(/\bNULL\b/g, "null");
  t = t.replace(/->/g, " arrow ");
  t = t.replace(/::/g, " scope ");
  t = t.replace(/==/g, " equals ");
  t = t.replace(/!=/g, " not equals ");
  t = t.replace(/<=/g, " less or equal ");
  t = t.replace(/>=/g, " greater or equal ");
  t = t.replace(/&&/g, " and ");
  t = t.replace(/\|\|/g, " or ");
  t = t.replace(/(?<![=!<>])=(?!=)/g, " equals ");
  t = t.replace(/\+\+/g, " plus plus ");
  t = t.replace(/--/g, " minus minus ");
  t = t.replace(/\+/g, " plus ");
  t = t.replace(/(\w)\s*-\s*(\w)/g, "$1 minus $2");
  t = t.replace(/(\w)\s*<\s*(\w)/g, "$1 less than $2");
  t = t.replace(/(\w)\s*>\s*(\w)/g, "$1 greater than $2");
  t = t.replace(/\*/g, " ");
  t = t.replace(/&/g, " and ");
  t = t.replace(/\/\//g, ", comment, ");
  t = t.replace(/[{}\[\]<>|]/g, " ");
  t = t.replace(/[;,]/g, ", ");
  t = t.replace(/_/g, " ");
  t = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/[ \t]+/g, " ").trim();
  return t;
}

function stripForSpeech(src: string): string {
  let t = src;
  t = t.replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => " " + naturalizeCode(code) + " ");
  t = t.replace(/`([^`\n]+)`/g, (_, code) => " " + naturalizeCode(code) + " ");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/_([^_\n]+)_/g, "$1");
  t = t.replace(/^#+\s*/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  t = t.replace(/`+/g, " ");
  t = t.replace(/\*+/g, " ");
  t = t.replace(/[—–]/g, ", ");
  t = t.replace(/…/g, ".");
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/\.\s*\.\s*/g, ". ");
  t = t.replace(/[ \t]+/g, " ").trim();
  if (t.length > 800) t = t.slice(0, 800) + ".";
  return t;
}

function powershellPlayScript(path: string, volume: number): string {
  const safe = path.replace(/'/g, "''");
  const v = volume.toFixed(3);
  return (
    `Add-Type -AssemblyName PresentationCore;` +
    `$mp = New-Object System.Windows.Media.MediaPlayer;` +
    `$mp.Volume = ${v};` +
    `$mp.Open([Uri]::new('${safe}'));` +
    `$mp.Play();` +
    `$tries=0; while (-not $mp.NaturalDuration.HasTimeSpan -and $tries -lt 50) { Start-Sleep -Milliseconds 50; $tries++ };` +
    `if ($mp.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds + 100) };` +
    `$mp.Close();`
  );
}
