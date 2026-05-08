import type { AiClient, BuddyReply } from "./anthropic.js";
import { MemoryStore } from "./memory.js";
import { type ScreenpipeClient, summarizeOcr } from "./screenpipe.js";

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
  private screenpipe?: ScreenpipeClient;
  private personalities: Map<string, string>;
  /** The user's configured personality — what the sidebar dropdown
   *  reflects and what's persisted across daemon restarts. Only changes
   *  via `setPersonality` (or constructor). The shuffle path leaves
   *  this untouched even though it rolls a different runtime overlay
   *  per turn (see `personality`). */
  private seedPersonality: string;
  /** The personality used to build the next turn's system blocks. In
   *  steady state this equals `seedPersonality`; under shuffle each
   *  trigger picks a transient overlay and writes it here so
   *  `buildSystemBlocks()` and turn telemetry see the rolled value.
   *  16.16: kept distinct from `seedPersonality` so the sidebar (via
   *  `getSeedPersonality()` → `modeAck`) doesn't visibly hop on every
   *  trigger. */
  private personality: string;
  private shuffle: boolean;
  private rng: () => number;

  constructor(
    private client: AiClient,
    private prompts: Map<string, string>,
    opts: {
      maxSpokenPerHour?: number;
      defaultMode?: string;
      memory?: MemoryStore;
      screenpipe?: ScreenpipeClient;
      personalities?: Map<string, string>;
      defaultPersonality?: string;
      defaultShuffle?: boolean;
      rng?: () => number;
    } = {}
  ) {
    this.maxSpokenPerHour = opts.maxSpokenPerHour ?? 2;
    this.mode = opts.defaultMode ?? "tutor";
    this.memory = opts.memory ?? new MemoryStore();
    this.screenpipe = opts.screenpipe;
    this.personalities = opts.personalities ?? new Map();
    // Personality precedence (highest first):
    //   1. persisted value from prior session, if still valid
    //   2. opts.defaultPersonality (typically BUDDY_PERSONALITY env)
    //   3. "nice" — the neutral baseline that always works
    // "nice" is always accepted even if it isn't in the personalities
    // map (the overlay is simply omitted in that case). An invalid
    // persisted value is silently ignored so a removed personality
    // file doesn't wedge the daemon.
    const persisted = this.memory.getPersonality();
    const fallback = opts.defaultPersonality ?? "nice";
    const valid = (name: string): boolean =>
      name === "nice" || this.personalities.has(name);
    if (persisted && valid(persisted)) {
      this.personality = persisted;
    } else if (valid(fallback)) {
      this.personality = fallback;
    } else {
      this.personality = "nice";
    }
    // The seed mirrors the resolved personality at boot. From here on,
    // only setPersonality() updates the seed; shuffle's per-trigger
    // rotation only writes to `personality`.
    this.seedPersonality = this.personality;
    // Shuffle precedence mirrors personality: persisted value beats the
    // env-driven default. Off by default so the daemon stays
    // deterministic for users who never opted in.
    const persistedShuffle = this.memory.getShuffle();
    this.shuffle = persistedShuffle ?? opts.defaultShuffle ?? false;
    this.rng = opts.rng ?? Math.random;
    if (!this.prompts.has(this.mode)) {
      throw new Error(`No prompt loaded for default mode "${this.mode}"`);
    }
    // Restore mute state across daemon restarts. Stale (already-expired)
    // values are filtered out by MemoryStore.getMutedUntil itself.
    this.mutedUntil = this.memory.getMutedUntil();
  }

  isShuffle(): boolean {
    return this.shuffle;
  }

  /** Toggle random-personality mode. Persisted so a daemon restart
   *  preserves the user's choice, matching the personality contract. */
  setShuffle(value: boolean): void {
    this.shuffle = value;
    this.memory.setShuffle(value);
  }

  /** Picks a personality from the loaded map, excluding the currently
   *  active one. Returns the current personality unchanged when fewer
   *  than two are loaded — there's nothing to switch to. */
  private pickRandomPersonality(): string {
    const all = this.listPersonalities();
    const others = all.filter((p) => p !== this.personality);
    if (others.length === 0) return this.personality;
    const idx = Math.floor(this.rng() * others.length);
    return others[idx] ?? this.personality;
  }

  listPersonalities(): string[] {
    return [...this.personalities.keys()];
  }

  getPersonality(): string {
    return this.personality;
  }

  /** The user's configured personality — what the sidebar dropdown
   *  should display. Identical to `getPersonality()` except under
   *  shuffle mode, where each trigger rolls a transient overlay
   *  exposed via `getPersonality()` while the seed surfaced here
   *  stays stable. 16.16. */
  getSeedPersonality(): string {
    return this.seedPersonality;
  }

  /** Returns true on success. "nice" is always accepted (the neutral
   *  baseline that omits any overlay). Any other name must exist in the
   *  loaded personalities map. The choice is persisted on success so a
   *  daemon restart restores it. */
  setPersonality(name: string): boolean {
    if (name === "nice") {
      this.personality = "nice";
      this.seedPersonality = "nice";
      this.memory.setPersonality("nice");
      return true;
    }
    if (!this.personalities.has(name)) return false;
    this.personality = name;
    this.seedPersonality = name;
    this.memory.setPersonality(name);
    return true;
  }

  /** Builds the ordered list of system text blocks for the next ask.
   *  blocks[0] = active mode prompt
   *  blocks[1] = personality overlay (omitted when personality === "nice")
   *  blocks[N] = learner profile (when present)
   */
  private buildSystemBlocks(): string[] {
    const blocks: string[] = [this.systemPrompt];
    if (this.personality !== "nice") {
      const overlay = this.personalities.get(this.personality);
      if (overlay) blocks.push(overlay);
    }
    const profile = this.memory.getSummary();
    if (profile) {
      blocks.push(`What I've noticed about this developer over time:\n${profile}`);
    }
    return blocks;
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

    // Optional Screenpipe context: only on EXPLICIT_ASK and only when the
    // editor signal is empty (user has been outside the IDE). Failures
    // here must never break the live trigger path — the buddy still
    // proceeds with whatever editor context it has.
    payload = await this.maybeAddScreenContext(trigger, payload);

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
    // Random-personality mode rotates *per trigger*, never repeating
    // the previous overlay. This is a transient assignment — the
    // user's seed personality stays persisted, only the runtime
    // overlay changes.
    if (this.shuffle) {
      this.personality = this.pickRandomPersonality();
    }
    const reply = await this.client.ask(
      this.buildSystemBlocks(),
      this.summary,
      enriched
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

  private async maybeAddScreenContext(
    trigger: string,
    payload: object
  ): Promise<object> {
    if (!this.screenpipe || trigger !== "EXPLICIT_ASK") return payload;
    const p = payload as { recent_diff?: string };
    const diff = (p.recent_diff ?? "").trim();
    if (diff.length > 0) return payload;
    try {
      const entries = await this.screenpipe.queryRecent(60);
      if (entries.length === 0) return payload;
      const summary = summarizeOcr(entries);
      return { ...payload, screen_context: summary };
    } catch (err) {
      console.error("[screenpipe] queryRecent failed:", err);
      return payload;
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
