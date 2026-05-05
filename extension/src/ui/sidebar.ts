import * as vscode from "vscode";

export interface SidebarMessage {
  trigger: string;
  reply: { mode: string; text: string };
}

export class BuddySidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "coding-buddy.sidebar";

  private view?: vscode.WebviewView;
  private pending: SidebarMessage[] = [];
  private askInputHandler?: (text: string) => void;
  private micToggleHandler?: () => void;
  private voiceEnabled = true;
  private voiceRate = 1.05;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ask" && this.askInputHandler) {
        this.askInputHandler(String(msg.text ?? ""));
      } else if (msg.type === "micToggle") {
        this.micToggleHandler?.();
      }
    });
    this.view.webview.postMessage({ type: "voiceConfig", enabled: this.voiceEnabled, rate: this.voiceRate });
    while (this.pending.length) this.post(this.pending.shift()!);
  }

  onAsk(h: (text: string) => void): void {
    this.askInputHandler = h;
  }

  onMicToggle(h: () => void): void {
    this.micToggleHandler = h;
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

  notifyTranscribed(text: string): void {
    this.view?.webview.postMessage({ type: "transcribed", text });
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
  .status { font-size: 11px; opacity: 0.6; font-style: italic; margin: 4px 0; }
  #ask-row { display: flex; gap: 4px; margin-top: 8px; align-items: stretch; }
  #ask { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
  #mic { width: 32px; padding: 0; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-input-border); cursor: pointer; font-size: 14px; }
  #mic:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #mic.recording { background: var(--vscode-errorForeground); color: var(--vscode-button-foreground); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  #voice-status { font-size: 10px; opacity: 0.5; margin-top: 4px; }
</style></head>
<body>
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
    } else if (m.type === 'transcribed') {
      pushStatus('You: ' + m.text);
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
