import * as vscode from "vscode";

export interface SidebarMessage {
  trigger: string;
  reply: { mode: string; text: string };
}

export interface SidebarControls {
  mode: string;
  available: string[];
  personality: string;
  availablePersonalities: string[];
  shuffle: boolean;
}

export class BuddySidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "coding-buddy.sidebar";

  private view?: vscode.WebviewView;
  private pending: SidebarMessage[] = [];
  private askInputHandler?: (text: string) => void;
  private micToggleHandler?: () => void;
  private voteHandler?: (trigger: string, replyText: string, vote: "up" | "down") => void;
  private modeChangeHandler?: (mode: string) => void;
  private personalityChangeHandler?: (personality: string) => void;
  private shuffleChangeHandler?: (shuffle: boolean) => void;
  private voiceEnabled = true;
  private voiceRate = 1.05;
  private lastControls?: SidebarControls;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ask" && this.askInputHandler) {
        this.askInputHandler(String(msg.text ?? ""));
      } else if (msg.type === "micToggle") {
        this.micToggleHandler?.();
      } else if (msg.type === "vote" && this.voteHandler) {
        const v = msg.vote === "down" ? "down" : "up";
        this.voteHandler(String(msg.trigger ?? ""), String(msg.reply_text ?? ""), v);
      } else if (msg.type === "setMode" && this.modeChangeHandler) {
        this.modeChangeHandler(String(msg.mode ?? ""));
      } else if (msg.type === "setPersonality" && this.personalityChangeHandler) {
        this.personalityChangeHandler(String(msg.personality ?? ""));
      } else if (msg.type === "setShuffle" && this.shuffleChangeHandler) {
        this.shuffleChangeHandler(!!msg.shuffle);
      }
    });
    this.view.webview.postMessage({ type: "voiceConfig", enabled: this.voiceEnabled, rate: this.voiceRate });
    if (this.lastControls) {
      this.view.webview.postMessage({ type: "controls", ...this.lastControls });
    }
    while (this.pending.length) this.post(this.pending.shift()!);
  }

  onAsk(h: (text: string) => void): void {
    this.askInputHandler = h;
  }

  onMicToggle(h: () => void): void {
    this.micToggleHandler = h;
  }

  onVote(h: (trigger: string, replyText: string, vote: "up" | "down") => void): void {
    this.voteHandler = h;
  }

  onModeChange(h: (mode: string) => void): void {
    this.modeChangeHandler = h;
  }

  onPersonalityChange(h: (personality: string) => void): void {
    this.personalityChangeHandler = h;
  }

  onShuffleChange(h: (shuffle: boolean) => void): void {
    this.shuffleChangeHandler = h;
  }

  /** Push the latest mode + personality + shuffle state into the webview
   *  so the dropdowns and checkbox reflect the daemon's truth. The last
   *  payload is cached so a webview that opens later can re-hydrate
   *  without an extra round-trip. */
  setControls(controls: SidebarControls): void {
    this.lastControls = controls;
    this.view?.webview.postMessage({ type: "controls", ...controls });
  }

  getControls(): SidebarControls | undefined {
    return this.lastControls;
  }

  setVoice(enabled: boolean): void {
    this.voiceEnabled = enabled;
    this.view?.webview.postMessage({ type: "voiceConfig", enabled, rate: this.voiceRate });
  }

  isVoiceEnabled(): boolean {
    return this.voiceEnabled;
  }

  push(msg: SidebarMessage): void {
    if (this.view) {
      this.post(msg);
    } else {
      this.pending.push(msg);
    }
  }

  pushStatus(text: string): void {
    if (this.view) {
      this.view.webview.postMessage({ type: "status", text });
    }
  }

  focusInput(): void {
    void this.view?.show?.(true);
    this.view?.webview.postMessage({ type: "focus" });
  }

  stopSpeech(): void {
    this.view?.webview.postMessage({ type: "stop" });
  }

  testVoice(text = "Hi, I'm your coding buddy. If you can hear this, voice output is working."): void {
    this.view?.webview.postMessage({ type: "testVoice", text });
  }

  setRecordingState(recording: boolean): void {
    this.view?.webview.postMessage({ type: "recordState", recording });
  }

  notifyTranscribing(): void {
    this.view?.webview.postMessage({ type: "transcribing" });
  }

  /** Render a finalised user-side transcript as its own message
   *  bubble in the live transcript view (Task 14.1). The webview
   *  styles user turns gray so the transcript-vs-buddy distinction
   *  is unambiguous.
   *
   *  Backchannels (Task 10.7) are intentionally NOT routed through
   *  this method — they're pre-recorded acks the daemon plays
   *  locally without text reaching the sidebar at all. Keep this
   *  contract: only call notifyTranscribed for the user's actual
   *  speech-to-text output, not low-level audio cues. */
  notifyTranscribed(text: string): void {
    if (!text) return;
    this.view?.webview.postMessage({
      type: "transcript",
      speaker: "user",
      text,
      ts: Date.now(),
    });
  }

  isReady(): boolean {
    return !!this.view;
  }

  private post(msg: SidebarMessage): void {
    this.view!.webview.postMessage({ type: "reply", ...msg });
  }

  private html(): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 13px/1.4 var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 8px; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .trigger { font-size: 10px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; }
  .text { margin-top: 2px; }
  .text p { margin: 0 0 6px 0; white-space: pre-wrap; }
  .text p:last-child { margin-bottom: 0; }
  .text pre { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2)); padding: 6px 8px; border-radius: 3px; overflow-x: auto; margin: 6px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .text code { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2)); padding: 1px 4px; border-radius: 2px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .text pre code { background: transparent; padding: 0; }
  .text strong { font-weight: 600; }
  .speak { border-left: 3px solid var(--vscode-charts-green); }
  .chat { border-left: 3px solid var(--vscode-charts-blue); }
  /* Task 14.1: live transcript view. User turns are gray; buddy
     turns inherit the default bubble background (effectively
     "white" against the editor's foreground color). The .speaker
     micro-label sits above the text so screen readers announce
     who's talking. */
  .msg.user { background: var(--vscode-input-background); opacity: 0.9; border-left: 3px solid var(--vscode-descriptionForeground); }
  .msg.user .text p { color: var(--vscode-descriptionForeground); }
  .speaker { font-size: 10px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .status { font-size: 11px; opacity: 0.6; font-style: italic; margin: 4px 0; }
  .votes { margin-top: 4px; display: flex; gap: 4px; }
  .vote-btn { background: transparent; border: 1px solid var(--vscode-input-border); color: inherit; cursor: pointer; padding: 1px 6px; border-radius: 3px; font-size: 12px; opacity: 0.6; }
  .vote-btn:hover { opacity: 1; }
  .vote-btn.voted { opacity: 1; background: var(--vscode-button-secondaryBackground); }
  #ask-row { display: flex; gap: 4px; margin-top: 8px; align-items: stretch; }
  #ask { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
  #mic { width: 32px; padding: 0; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-input-border); cursor: pointer; font-size: 14px; }
  #mic:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #mic.recording { background: var(--vscode-errorForeground); color: var(--vscode-button-foreground); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  #voice-status { font-size: 10px; opacity: 0.5; margin-top: 4px; }
  #controls { display: flex; gap: 6px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--vscode-input-border); margin-bottom: 6px; flex-wrap: wrap; }
  #controls label { font-size: 11px; opacity: 0.75; }
  #controls select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 4px; font-size: 12px; }
  #controls .shuffle-row { display: flex; align-items: center; gap: 3px; font-size: 11px; }
  #controls input[type=checkbox] { margin: 0; }
</style></head>
<body>
  <div id="controls">
    <label for="mode-select">Mode</label>
    <select id="mode-select"></select>
    <label for="personality-select">Personality</label>
    <select id="personality-select"></select>
    <label class="shuffle-row" for="shuffle"><input type="checkbox" id="shuffle"> Shuffle</label>
  </div>
  <div id="log"></div>
  <div id="ask-row">
    <input id="ask" placeholder="Ask the buddy (Enter to send)..." />
    <button id="mic" title="Click or press Ctrl+Alt+V to record">🎤</button>
  </div>
  <div id="voice-status">voice: ?</div>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const ask = document.getElementById('ask');
  const voiceStatus = document.getElementById('voice-status');
  let voiceEnabled = true;
  let voiceRate = 1.05;
  let englishVoice = null;

  function pickEnglishVoice() {
    if (!('speechSynthesis' in window)) return;
    const voices = window.speechSynthesis.getVoices();
    englishVoice =
      voices.find(v => /^en[-_]US/i.test(v.lang)) ||
      voices.find(v => /^en[-_]GB/i.test(v.lang)) ||
      voices.find(v => /^en/i.test(v.lang)) ||
      null;
    const enCount = voices.filter(v => /^en/i.test(v.lang)).length;
    const total = voices.length;
    voiceStatus.textContent = 'voice: ' + (voiceEnabled ? 'on' : 'muted')
      + '  (' + enCount + ' EN / ' + total + ' total'
      + (englishVoice ? ', using ' + englishVoice.name : ', NO English voice — falling back')
      + ')';
  }
  if ('speechSynthesis' in window) {
    pickEnglishVoice();
    window.speechSynthesis.onvoiceschanged = pickEnglishVoice;
  }

  function updateVoiceStatus() {
    const supported = 'speechSynthesis' in window;
    voiceStatus.textContent = 'voice: ' + (supported ? (voiceEnabled ? 'on' : 'muted') : 'unsupported');
  }
  updateVoiceStatus();

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdown(src) {
    const parts = [];
    let rest = src;
    const fence = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
    let last = 0;
    let m;
    while ((m = fence.exec(src)) !== null) {
      if (m.index > last) parts.push({ type: 'prose', text: src.slice(last, m.index) });
      parts.push({ type: 'code', lang: m[1], text: m[2] });
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push({ type: 'prose', text: src.slice(last) });

    return parts.map(p => {
      if (p.type === 'code') {
        return '<pre><code>' + escapeHtml(p.text) + '</code></pre>';
      }
      let html = escapeHtml(p.text);
      html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      const paras = html.split(/\\n{2,}/).map(s => '<p>' + s + '</p>').join('');
      return paras;
    }).join('');
  }

  function stripForSpeech(src) {
    let t = src.replace(/\`\`\`[\\s\\S]*?\`\`\`/g, ' ');
    t = t.replace(/\`[^\`\\n]+\`/g, ' ');
    t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '$1');
    t = t.replace(/\\s+/g, ' ').trim();
    if (t.length > 600) t = t.slice(0, 600) + '…';
    return t;
  }

  function speak(text) {
    if (!voiceEnabled) return;
    if (!('speechSynthesis' in window)) return;
    const cleaned = stripForSpeech(text);
    if (!cleaned) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(cleaned);
      u.rate = voiceRate;
      u.lang = 'en-US';
      if (englishVoice) u.voice = englishVoice;
      window.speechSynthesis.speak(u);
    } catch (e) {
      // ignore
    }
  }

  const mic = document.getElementById('mic');
  let recording = false;

  function pushStatus(text) {
    const div = document.createElement('div');
    div.className = 'status';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function setRecordingUi(on) {
    recording = on;
    if (on) {
      mic.classList.add('recording');
      mic.textContent = '⏺';
    } else {
      mic.classList.remove('recording');
      mic.textContent = '🎤';
    }
  }

  mic.addEventListener('click', () => {
    vscode.postMessage({ type: 'micToggle' });
  });

  const modeSelect = document.getElementById('mode-select');
  const personalitySelect = document.getElementById('personality-select');
  const shuffleCheckbox = document.getElementById('shuffle');

  function fillSelect(select, options, current) {
    if (!select) return;
    // Avoid the brief flash of "no options" by only rebuilding when the
    // option set actually changed; just re-pin the selected value when
    // the list is identical.
    const desired = options.join('\\n');
    if (select.dataset.options !== desired) {
      select.innerHTML = '';
      for (const value of options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
      }
      select.dataset.options = desired;
    }
    select.value = current;
  }

  modeSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setMode', mode: modeSelect.value });
  });
  personalitySelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setPersonality', personality: personalitySelect.value });
  });
  shuffleCheckbox.addEventListener('change', () => {
    vscode.postMessage({ type: 'setShuffle', shuffle: shuffleCheckbox.checked });
  });

  ask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && ask.value.trim()) {
      vscode.postMessage({ type: 'ask', text: ask.value });
      ask.value = '';
    }
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'reply') {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.reply.mode || 'chat');
      const text = m.reply.text || '(no_op)';
      const triggerHtml = '<div class="trigger">' + escapeHtml(m.trigger + ' · ' + m.reply.mode) + '</div>';
      const textHtml = '<div class="text">' + (m.reply.text ? renderMarkdown(text) : '<p>(no_op)</p>') + '</div>';
      div.innerHTML = triggerHtml + textHtml;
      if (m.reply.text && m.reply.mode !== 'no_op') {
        const votes = document.createElement('div');
        votes.className = 'votes';
        const up = document.createElement('button');
        up.className = 'vote-btn';
        up.title = 'Useful';
        up.textContent = '👍';
        const down = document.createElement('button');
        down.className = 'vote-btn';
        down.title = 'Not useful';
        down.textContent = '👎';
        const cast = (vote, btn) => {
          vscode.postMessage({ type: 'vote', trigger: m.trigger, reply_text: m.reply.text, vote });
          up.classList.remove('voted');
          down.classList.remove('voted');
          btn.classList.add('voted');
        };
        up.addEventListener('click', () => cast('up', up));
        down.addEventListener('click', () => cast('down', down));
        votes.appendChild(up);
        votes.appendChild(down);
        div.appendChild(votes);
      }
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      if (m.reply.text && m.reply.mode !== 'no_op') speak(text);
    } else if (m.type === 'status') {
      const div = document.createElement('div');
      div.className = 'status';
      div.textContent = m.text;
      log.appendChild(div);
    } else if (m.type === 'focus') {
      ask.focus();
    } else if (m.type === 'voiceConfig') {
      voiceEnabled = !!m.enabled;
      voiceRate = m.rate || 1.05;
      updateVoiceStatus();
    } else if (m.type === 'stop') {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    } else if (m.type === 'recordState') {
      setRecordingUi(!!m.recording);
      if (m.recording) pushStatus('🔴 Listening… click mic again or press Ctrl+Alt+V to send.');
    } else if (m.type === 'transcribing') {
      pushStatus('Transcribing audio…');
    } else if (m.type === 'transcript') {
      // Task 14.1: live transcript bubble. Stays scrolled to bottom.
      // Backchannels never reach this branch — the daemon plays
      // them as pre-recorded clips without surfacing any text.
      const div = document.createElement('div');
      const speaker = m.speaker === 'user' ? 'user' : 'buddy';
      div.className = 'msg ' + speaker;
      const label = speaker === 'user' ? 'You' : 'Buddy';
      div.innerHTML = '<div class="speaker">' + label + '</div>'
        + '<div class="text"><p>' + escapeHtml(m.text || '') + '</p></div>';
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    } else if (m.type === 'controls') {
      fillSelect(modeSelect, m.available || [], m.mode || '');
      // Personality picker always offers "nice" — it's the no-overlay
      // baseline and may not appear in availablePersonalities if the
      // daemon has no nice.md loaded.
      const personalityOptions = (m.availablePersonalities || []).slice();
      if (!personalityOptions.includes('nice')) personalityOptions.unshift('nice');
      fillSelect(personalitySelect, personalityOptions, m.personality || 'nice');
      shuffleCheckbox.checked = !!m.shuffle;
    } else if (m.type === 'testVoice') {
      const div = document.createElement('div');
      div.className = 'status';
      div.textContent = '🔊 ' + m.text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      const wasEnabled = voiceEnabled;
      voiceEnabled = true;
      speak(m.text);
      voiceEnabled = wasEnabled;
    }
  });
</script>
</body></html>`;
  }
}
