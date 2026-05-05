import * as vscode from "vscode";

export type TriggerName =
  | "EXPLICIT_ASK"
  | "STUCK_LOOP"
  | "BAD_PATH"
  | "MISCONCEPTION"
  | "NEW_TOPIC"
  | "IDLE_LONG";

export interface TriggerEvent {
  trigger: TriggerName;
  reason: string;
  userQuestion?: string;
}

interface DiagnosticState {
  uri: string;
  signature: string;
  firstSeen: number;
}

interface TerminalRun {
  cmd: string;
  exit: number;
  ts: number;
}

const TRIGGER_COMMENT = /(\bAI[?!]|\bWHY\?|\bSTUCK\b)\s*$/;

const ERROR_SEVERITY = 0;

const ANTI_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "await-in-non-async", re: /^(?!.*async).*\bawait\b/m },
  { name: "mutate-during-iteration", re: /for\s*\(.+?\)\s*\{[\s\S]{0,400}?\.(push|splice|shift|unshift|pop)\(/ },
  { name: "double-equals", re: /[^=!<>]==[^=]/ },
];

export class TriggerEngine {
  private lastDiagnostic?: DiagnosticState;
  private lastEditAt: number;
  private lastSpokenAt = 0;
  private knownDirs = new Set<string>();
  private lastNewTopicAt = 0;
  private terminalRuns: TerminalRun[] = [];
  private now: () => number;

  constructor(clock: () => number = Date.now) {
    this.now = clock;
    this.lastEditAt = clock();
  }

  noteEdit(): void {
    this.lastEditAt = this.now();
  }

  noteSpoken(): void {
    this.lastSpokenAt = this.now();
  }

  noteTerminalRun(cmd: string, exit: number): void {
    this.terminalRuns.push({ cmd, exit, ts: this.now() });
    if (this.terminalRuns.length > 10) this.terminalRuns.shift();
  }

  recentTerminal(): TerminalRun[] {
    return this.terminalRuns.slice(-5);
  }

  evaluateExplicit(line: string): TriggerEvent | null {
    if (TRIGGER_COMMENT.test(line)) {
      return {
        trigger: "EXPLICIT_ASK",
        reason: "trigger comment",
        userQuestion: line.replace(TRIGGER_COMMENT, "").trim(),
      };
    }
    return null;
  }

  evaluateDiagnostics(uri: vscode.Uri, diags: vscode.Diagnostic[]): { event: TriggerEvent | null; debug: string } {
    const errors = diags.filter((d) => d.severity === (ERROR_SEVERITY as unknown as vscode.DiagnosticSeverity));
    if (errors.length === 0) {
      this.lastDiagnostic = undefined;
      return { event: null, debug: "no errors" };
    }

    const sig = `${uri.toString()}#${errors.length}`;

    if (!this.lastDiagnostic || this.lastDiagnostic.signature !== sig) {
      this.lastDiagnostic = { uri: uri.toString(), signature: sig, firstSeen: this.now() };
      return { event: null, debug: `new sig=${sig} firstSeen=now` };
    }

    const stuckMs = this.now() - this.lastDiagnostic.firstSeen;
    const noEditMs = this.now() - this.lastEditAt;
    const sinceSpoken = this.now() - this.lastSpokenAt;
    const reasons: string[] = [];
    if (stuckMs <= 90_000) reasons.push(`stuckMs=${Math.round(stuckMs/1000)}s<=90`);
    if (noEditMs <= 60_000) reasons.push(`noEditMs=${Math.round(noEditMs/1000)}s<=60`);
    if (sinceSpoken <= 60_000) reasons.push(`sinceSpoken=${Math.round(sinceSpoken/1000)}s<=60`);
    if (reasons.length > 0) {
      return { event: null, debug: `holding: ${reasons.join(", ")}` };
    }
    this.lastDiagnostic.firstSeen = this.now();
    return {
      event: { trigger: "STUCK_LOOP", reason: `stuck on ${errors.length} errors for ${Math.round(stuckMs / 1000)}s` },
      debug: "FIRE",
    };
  }

  evaluateBadPath(diagCount: number): TriggerEvent | null {
    if (diagCount < 5) return null;
    const failedRuns = this.terminalRuns.slice(-2).filter((r) => r.exit !== 0);
    if (failedRuns.length >= 2 && this.canSpeakAgain()) {
      return {
        trigger: "BAD_PATH",
        reason: `${diagCount} diagnostics + ${failedRuns.length} failed runs`,
      };
    }
    return null;
  }

  evaluateMisconception(text: string): TriggerEvent | null {
    for (const ap of ANTI_PATTERNS) {
      if (ap.re.test(text) && this.canSpeakAgain()) {
        return { trigger: "MISCONCEPTION", reason: `anti-pattern: ${ap.name}` };
      }
    }
    return null;
  }

  evaluateNewTopic(uri: vscode.Uri): TriggerEvent | null {
    const dir = uri.path.replace(/\/[^/]+$/, "");
    if (this.knownDirs.has(dir)) return null;
    this.knownDirs.add(dir);
    if (this.knownDirs.size <= 1) return null;
    if (this.now() - this.lastNewTopicAt < 10 * 60_000) return null;
    this.lastNewTopicAt = this.now();
    return { trigger: "NEW_TOPIC", reason: `entered ${dir}` };
  }

  evaluateIdle(idleSeconds: number): TriggerEvent | null {
    if (this.now() - this.lastEditAt < idleSeconds * 1000) return null;
    if (this.now() - this.lastSpokenAt < 15 * 60_000) return null;
    return { trigger: "IDLE_LONG", reason: `idle ${idleSeconds}s` };
  }

  private canSpeakAgain(): boolean {
    return this.now() - this.lastSpokenAt > 60_000;
  }
}
