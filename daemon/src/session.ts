import type { AiClient, BuddyReply } from "./anthropic.js";
import { MemoryStore } from "./memory.js";

interface EventLogEntry {
  ts: number;
  trigger: string;
  payload: object;
  reply?: BuddyReply;
}

export class Session {
  private events: EventLogEntry[] = [];
  private summary = "";
  private mutedUntil = 0;
  private hourBucketStart = Date.now();
  private spokenInBucket = 0;
  private maxSpokenPerHour: number;
  private lastSummaryAt = Date.now();

  private mode: string;
  private memory: MemoryStore;

  constructor(
    private client: AiClient,
    private prompts: Map<string, string>,
    opts: { maxSpokenPerHour?: number; defaultMode?: string; memory?: MemoryStore } = {}
  ) {
    this.maxSpokenPerHour = opts.maxSpokenPerHour ?? 2;
    this.mode = opts.defaultMode ?? "tutor";
    this.memory = opts.memory ?? new MemoryStore();
    if (!this.prompts.has(this.mode)) {
      throw new Error(`No prompt loaded for default mode "${this.mode}"`);
    }
    // Restore mute state across daemon restarts. Stale (already-expired)
    // values are filtered out by MemoryStore.getMutedUntil itself.
    this.mutedUntil = this.memory.getMutedUntil();
  }

  getMemory(): MemoryStore {
    return this.memory;
  }

  getMode(): string {
    return this.mode;
  }

  listModes(): string[] {
    return [...this.prompts.keys()];
  }

  setMode(mode: string): boolean {
    if (!this.prompts.has(mode)) return false;
    this.mode = mode;
    return true;
  }

  private get systemPrompt(): string {
    return this.prompts.get(this.mode)!;
  }

  isMuted(): boolean {
    return Date.now() < this.mutedUntil;
  }

  mute(minutes: number): void {
    this.mutedUntil = Date.now() + minutes * 60_000;
    this.memory.setMutedUntil(this.mutedUntil);
  }

  unmute(): void {
    this.mutedUntil = 0;
    this.memory.setMutedUntil(0);
  }

  async handleTrigger(trigger: string, payload: object): Promise<BuddyReply> {
    if (this.isMuted() && trigger !== "EXPLICIT_ASK") {
      return { mode: "no_op", text: "", wants_followup: false };
    }

    // Cheap Haiku gate: skip the Sonnet call entirely when the gate says
    // no_op. EXPLICIT_ASK bypasses the gate — the user explicitly asked,
    // never silence them on a probabilistic verdict.
    if (trigger !== "EXPLICIT_ASK") {
      const decision = await this.client.shouldSpeak(payload, this.summary);
      if (decision === "no_op") {
        return { mode: "no_op", text: "", wants_followup: false };
      }
    }

    this.rolloverHourBucket();

    const recent_chat = this.events.slice(-5).map((e) => ({
      trigger: e.trigger,
      user_question: (e.payload as { user_question?: string }).user_question ?? null,
      reply_mode: e.reply?.mode ?? null,
      reply_text: e.reply?.text?.slice(0, 400) ?? "",
    }));
    const enriched = {
      ...payload,
      trigger,
      session_summary: this.summary,
      recent_chat,
    };
    const reply = await this.client.ask(
      this.systemPrompt,
      this.summary,
      enriched,
      this.memory.getSummary()
    );

    if (reply.mode === "speak") {
      if (
        trigger !== "EXPLICIT_ASK" &&
        this.spokenInBucket >= this.maxSpokenPerHour
      ) {
        reply.mode = "chat";
      } else if (reply.mode === "speak") {
        this.spokenInBucket += 1;
      }
    }

    this.events.push({ ts: Date.now(), trigger, payload, reply });

    if (reply.mode !== "no_op" && reply.text) {
      const p = payload as { active_file?: string; user_question?: string };
      this.memory.append({
        ts: Date.now(),
        mode: this.mode,
        trigger,
        file: p.active_file,
        user_question: p.user_question,
        reply_text: reply.text,
      });
    }

    if (trigger === "MISCONCEPTION") {
      const reason = (payload as { reason?: string }).reason ?? "";
      const pattern = reason.replace(/^anti-pattern:\s*/i, "").trim() || "unknown";
      const sample = JSON.stringify(payload).slice(0, 200);
      this.memory.recordMisconception(pattern, sample);
    }

    void this.maybeSummarize();
    void this.maybeDistillProfile();
    return reply;
  }

  async forceDistillProfile(): Promise<string> {
    this.memory.markRefreshed();
    await this.distillNow();
    return this.memory.getSummary();
  }

  private async maybeDistillProfile(): Promise<void> {
    if (!this.memory.shouldRefresh(20)) return;
    this.memory.markRefreshed();
    await this.distillNow();
  }

  private async distillNow(): Promise<void> {
    const recent = this.memory.loadRecent(60);
    const history = recent
      .map((e) => {
        const file = e.file ? ` (${e.file})` : "";
        const q = e.user_question ? ` Q: ${e.user_question}` : "";
        return `[${new Date(e.ts).toISOString()}] ${e.mode}/${e.trigger}${file}${q}\n  → ${e.reply_text}`;
      })
      .join("\n");
    try {
      const next = await this.client.distillLearnerProfile(
        history,
        this.memory.getSummary(),
        this.memory.getMisconceptions()
      );
      if (next) this.memory.setSummary(next);
    } catch (err) {
      console.error("[memory] distill failed", err);
    }
  }

  private rolloverHourBucket(): void {
    if (Date.now() - this.hourBucketStart > 60 * 60_000) {
      this.hourBucketStart = Date.now();
      this.spokenInBucket = 0;
    }
  }

  private async maybeSummarize(): Promise<void> {
    const elapsed = Date.now() - this.lastSummaryAt;
    if (elapsed < 10 * 60_000 && this.events.length < 30) return;
    this.lastSummaryAt = Date.now();

    const transcript = this.events
      .slice(-50)
      .map(
        (e) =>
          `[${new Date(e.ts).toISOString()}] ${e.trigger} → ${
            e.reply?.mode ?? "?"
          }: ${e.reply?.text ?? ""}`
      )
      .join("\n");

    try {
      const newSummary = await this.client.summarize(
        `Existing summary:\n${this.summary}\n\nNew events:\n${transcript}`
      );
      if (newSummary) this.summary = newSummary;
    } catch (err) {
      console.error("[summarize] failed", err);
    }
  }
}
