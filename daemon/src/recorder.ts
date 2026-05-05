import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class Recorder {
  private proc?: ChildProcess;
  private wavPath?: string;
  private startedAt = 0;

  isRecording(): boolean {
    return !!this.proc;
  }

  start(): { ok: true } | { ok: false; error: string } {
    if (this.proc) return { ok: false, error: "already recording" };

    const dir = mkdtempSync(join(tmpdir(), "buddy-rec-"));
    const wavPath = join(dir, "rec.wav");
    const safe = wavPath.replace(/'/g, "''");

    const script = `$ErrorActionPreference = 'Stop';
Add-Type @'
using System.Runtime.InteropServices;
using System.Text;
public class WinMM {
  [DllImport("winmm.dll", EntryPoint="mciSendStringW", CharSet=CharSet.Unicode)]
  public static extern int SendW(string command, StringBuilder ret, int retLen, int hwnd);
}
'@
$ret = New-Object System.Text.StringBuilder 256
function MCI([string]$cmd) {
  $rc = [WinMM]::SendW($cmd, $ret, 256, 0)
  if ($rc -ne 0) { throw "MCI '$cmd' failed: $rc" }
}
MCI 'open new type waveaudio alias rec'
MCI 'record rec'
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
MCI 'stop rec'
MCI 'save rec "${safe}"'
MCI 'close rec'
[Console]::Out.WriteLine('SAVED')
`;

    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => console.error("[recorder] spawn error", err));
    proc.on("close", (code) => {
      if (code !== 0 && stderr) console.error(`[recorder] exit ${code}: ${stderr.slice(0, 300)}`);
    });

    this.proc = proc;
    this.wavPath = wavPath;
    this.startedAt = Date.now();
    return { ok: true };
  }

  async stop(): Promise<{ ok: true; wav: Buffer; durationMs: number } | { ok: false; error: string }> {
    if (!this.proc || !this.wavPath) return { ok: false, error: "not recording" };

    const proc = this.proc;
    const wavPath = this.wavPath;
    const startedAt = this.startedAt;
    this.proc = undefined;
    this.wavPath = undefined;

    try {
      proc.stdin?.write("stop\n");
      proc.stdin?.end();
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      proc.on("close", () => resolve());
    });

    if (!existsSync(wavPath)) {
      return { ok: false, error: "recording produced no wav file" };
    }
    const sz = statSync(wavPath).size;
    if (sz < 1024) {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
      return { ok: false, error: `wav too small (${sz} bytes) — mic may be muted or empty` };
    }
    const buf = readFileSync(wavPath);
    try { unlinkSync(wavPath); } catch { /* ignore */ }
    return { ok: true, wav: buf, durationMs: Date.now() - startedAt };
  }

  cancel(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.proc = undefined;
    this.wavPath = undefined;
  }
}
