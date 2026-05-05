import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SttConfig {
  exe?: string;
  model?: string;
}

export class SttBridge {
  constructor(private cfg: SttConfig) {}

  isAvailable(): boolean {
    return !!(this.cfg.exe && this.cfg.model && existsSync(this.cfg.exe) && existsSync(this.cfg.model));
  }

  describe(): string {
    if (!this.cfg.exe || !this.cfg.model) return "off (missing exe/model)";
    if (!this.isAvailable()) return `off (paths invalid: exe=${this.cfg.exe} model=${this.cfg.model})`;
    return `whisper.cpp (${this.cfg.model})`;
  }

  async transcribe(wavBytes: Buffer): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("Whisper not configured. Run voice/setup-whisper.ps1 and set BUDDY_WHISPER_EXE / BUDDY_WHISPER_MODEL.");
    }
    const dir = mkdtempSync(join(tmpdir(), "buddy-stt-"));
    const wav = join(dir, "in.wav");
    const txtBase = join(dir, "out");
    writeFileSync(wav, wavBytes);

    try {
      const stdout = await runWhisper(this.cfg.exe!, this.cfg.model!, wav, txtBase);

      const txtPath = txtBase + ".txt";
      let text = "";
      if (existsSync(txtPath)) {
        text = readFileSync(txtPath, "utf8").trim();
        try { unlinkSync(txtPath); } catch { /* ignore */ }
      } else {
        text = parseStdout(stdout);
      }

      return text;
    } finally {
      try { unlinkSync(wav); } catch { /* ignore */ }
    }
  }
}

function runWhisper(exe: string, model: string, wav: string, txtBase: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m", model,
      "-f", wav,
      "-otxt",
      "-of", txtBase,
      "-nt",
    ];
    const p = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`whisper exit ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`))
    );
  });
}

function parseStdout(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("[")) {
      const idx = line.indexOf("]");
      if (idx >= 0) {
        const t = line.slice(idx + 1).trim();
        if (t) out.push(t);
        continue;
      }
    }
    if (/^whisper_|^system_|^load_|^main:|^ggml/.test(line)) continue;
    out.push(line.trim());
  }
  return out.join(" ").trim();
}
