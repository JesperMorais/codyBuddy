import * as vscode from "vscode";
import { DaemonBridge } from "./bridge";
import { TriggerEngine, TriggerEvent } from "./triggers";
import { isDeniedFile, scrubSecrets, makeMiniDiff } from "./redactor";
import { BuddySidebarProvider } from "./ui/sidebar";
import { findDaemonScript, probeDaemonPort, spawnDaemon, SpawnedDaemon } from "./daemon-spawn";

let muted = false;
let muteTimer: NodeJS.Timeout | undefined;
const fileSnapshots = new Map<string, string>();
let spawnedDaemon: SpawnedDaemon | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("codingBuddy");
  const port = cfg.get<number>("daemonPort", 31415);
  const idleSeconds = cfg.get<number>("idleSeconds", 300);
  const maxDiffLines = cfg.get<number>("maxDiffLines", 200);
  const voiceEnabledInitial = cfg.get<boolean>("voiceEnabled", true);
  const voiceVolumeInitial = cfg.get<number>("voiceVolume", 0.5);
  const autoSpawnDaemon = cfg.get<boolean>("autoSpawnDaemon", true);

  const output = vscode.window.createOutputChannel("Coding Buddy");
  ctx.subscriptions.push(output);

  if (autoSpawnDaemon) {
    void (async () => {
      if (await probeDaemonPort(port)) {
        output.appendLine(`Daemon already listening on :${port} — skipping auto-spawn.`);
        return;
      }
      const script = findDaemonScript(ctx.extensionPath);
      if (!script) {
        output.appendLine(
          `Could not locate daemon/dist/index.js relative to ${ctx.extensionPath}. ` +
            `Auto-spawn disabled — start the daemon manually with "pnpm dev:daemon".`
        );
        return;
      }
      output.appendLine(`Auto-spawning daemon: ${script} on :${port}`);
      spawnedDaemon = spawnDaemon({
        script,
        port,
        log: (line) => output.appendLine(line),
      });
    })();
  }

  const bridge = new DaemonBridge(port, output);
  ctx.subscriptions.push({ dispose: () => bridge.dispose() });

  const engine = new TriggerEngine();
  const sidebar = new BuddySidebarProvider();
  sidebar.setVoice(voiceEnabledInitial);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "coding-buddy.switchMode";
  status.text = "$(comment-discussion) Buddy: tutor";
  status.tooltip = "Click to switch Coding Buddy mode";
  status.show();
  ctx.subscriptions.push(status);

  let availableModes: string[] = ["tutor"];
  let lastMode = "tutor";
  let daemonUp = false;
  const refreshStatus = () => {
    const icon = daemonUp ? "$(comment-discussion)" : "$(circle-slash)";
    const suffix = daemonUp ? "" : " · daemon down";
    status.text = `${icon} Buddy: ${lastMode}${suffix}`;
    status.tooltip = daemonUp
      ? "Click to switch Coding Buddy mode"
      : "Daemon not reachable on the configured port. Click to switch mode (will queue).";
  };
  bridge.onHealth(({ up }) => {
    daemonUp = up;
    refreshStatus();
    // Task 14.2: drive the sidebar status pill from health. Up
    // resolves to "idle" only when nothing else is in flight; the
    // record / trigger / reply paths below override it for the
    // duration of an interaction.
    sidebar.setBuddyState(up ? "idle" : "down");
  });

  bridge.onDemoMode(({ active }) => {
    // Task 15.4: daemon flipped demo mode — propagate to sidebar.
    sidebar.setDemoMode(active);
  });

  bridge.onAudioOwner(({ owner, backend }) => {
    if (owner === "daemon") {
      sidebar.setVoice(false);
      sidebar.pushStatus(`Audio: daemon (${backend}) — webview voice off.`);
      bridge.setVolume(voiceVolumeInitial);
    } else {
      sidebar.setVoice(voiceEnabledInitial);
    }
  });

  // Workspace state stores the user's last-known sidebar control values
  // so a window reload restores the dropdowns immediately, before the
  // daemon round-trip lands. The daemon is still the source of truth —
  // the modeSet ack overwrites these on connect.
  const wsState = ctx.workspaceState;
  const initialControls = {
    mode: wsState.get<string>("buddy.mode", "tutor"),
    available: wsState.get<string[]>("buddy.availableModes", ["tutor"]),
    personality: wsState.get<string>("buddy.personality", "nice"),
    availablePersonalities: wsState.get<string[]>("buddy.availablePersonalities", ["nice"]),
    shuffle: wsState.get<boolean>("buddy.shuffle", false),
  };
  sidebar.setControls(initialControls);

  bridge.onMode(({ mode, available, personality, availablePersonalities, shuffle, ok, reason }) => {
    if (available.length) availableModes = available;
    const previous = lastMode;
    lastMode = mode;
    refreshStatus();
    if (ok && mode !== previous && previous !== "") {
      void vscode.window.setStatusBarMessage(`Coding Buddy mode → ${mode}`, 2000);
    }
    if (!ok && reason) {
      // Surface the daemon's rejection so the user sees *why* the
      // dropdown snapped back (e.g. nsfw on the Anthropic provider).
      sidebar.pushStatus(`Could not switch: ${reason}`);
    }
    sidebar.setControls({ mode, available, personality, availablePersonalities, shuffle });
    void wsState.update("buddy.mode", mode);
    void wsState.update("buddy.availableModes", available);
    void wsState.update("buddy.personality", personality);
    void wsState.update("buddy.availablePersonalities", availablePersonalities);
    void wsState.update("buddy.shuffle", shuffle);
  });

  sidebar.onModeChange((mode) => bridge.setMode(mode));
  sidebar.onPersonalityChange((personality) => bridge.setPersonality(personality));
  sidebar.onShuffleChange((shuffle) => bridge.setShuffle(shuffle));

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BuddySidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  void vscode.commands.executeCommand("workbench.view.extension.coding-buddy");

  bridge.onReply((reply, trigger) => {
    if (reply.mode === "no_op") {
      output.appendLine(`[reply] ${trigger} → no_op`);
      // No content to speak — drop back to idle so the pill doesn't
      // get stuck on "thinking" after a no_op trigger.
      if (daemonUp) sidebar.setBuddyState("idle");
      return;
    }
    engine.noteSpoken();
    if (!sidebar.isReady()) {
      void vscode.commands.executeCommand("workbench.view.extension.coding-buddy");
    }
    sidebar.push({ trigger, reply: { mode: reply.mode, text: reply.text } });
    // Task 14.2: pill flips to "speaking" until the webview tells
    // us speech ended (see sidebar.onSpeechEnded below). Daemon-
    // owned TTS doesn't fire that callback — the pill stays
    // "speaking" until the next health/state event nudges it. A
    // future task can wire the daemon's TTS finish signal in.
    if (daemonUp) sidebar.setBuddyState("speaking");
  });

  sidebar.onSpeechEnded(() => {
    // SpeechSynthesisUtterance.onend in the webview — Task 14.2.
    // Only flip back to idle if we're actually still on "speaking"
    // (avoids racing a fresh trigger that already moved us to
    // "thinking").
    if (sidebar.getBuddyState() === "speaking" && daemonUp) {
      sidebar.setBuddyState("idle");
    }
  });

  sidebar.onAsk((text) => {
    if (!text.trim()) return;
    if (daemonUp) sidebar.setBuddyState("thinking");
    sendTrigger(bridge, engine, {
      trigger: "EXPLICIT_ASK",
      reason: "sidebar input",
      userQuestion: text,
    }, maxDiffLines);
  });

  sidebar.onVote((trigger, replyText, vote) => {
    bridge.vote(trigger, replyText, vote);
  });

  let recording = false;
  const toggleMic = () => {
    if (!recording) {
      bridge.recordStart();
    } else {
      sidebar.notifyTranscribing();
      bridge.recordStop(`voice-${Date.now()}`);
    }
  };

  sidebar.onMicToggle(toggleMic);

  bridge.onRecordStarted(({ ok, error }) => {
    if (!ok) {
      recording = false;
      sidebar.setRecordingState(false);
      sidebar.pushStatus(`Recording failed: ${error ?? "unknown"}`);
      if (daemonUp) sidebar.setBuddyState("idle");
      return;
    }
    recording = true;
    sidebar.setRecordingState(true);
    // Task 14.2: pill reflects active mic capture.
    sidebar.setBuddyState("listening");
  });

  bridge.onTranscribed(({ ok, text, error }) => {
    recording = false;
    sidebar.setRecordingState(false);
    if (!ok) {
      sidebar.pushStatus(`Voice failed: ${error ?? "unknown"}`);
      if (daemonUp) sidebar.setBuddyState("idle");
      return;
    }
    if (!text || !text.trim()) {
      sidebar.pushStatus("Transcription empty.");
      if (daemonUp) sidebar.setBuddyState("idle");
      return;
    }
    sidebar.notifyTranscribed(text);
    // Task 14.2: transcript landed → buddy is now thinking about it.
    if (daemonUp) sidebar.setBuddyState("thinking");
    sendTrigger(bridge, engine, {
      trigger: "EXPLICIT_ASK",
      reason: "voice (Ctrl+Alt+V)",
      userQuestion: text,
    }, maxDiffLines);
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.ask", async () => {
      sidebar.focusInput();
      const text = await vscode.window.showInputBox({
        prompt: "Ask the buddy",
        placeHolder: "What are you trying to do?",
      });
      if (text) {
        sendTrigger(bridge, engine, {
          trigger: "EXPLICIT_ASK",
          reason: "Ctrl+Alt+Q",
          userQuestion: text,
        }, maxDiffLines);
      }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.muteToggle", () => {
      if (muted) {
        muted = false;
        if (muteTimer) clearTimeout(muteTimer);
        bridge.unmute();
        sidebar.pushStatus("Buddy unmuted.");
        void vscode.window.setStatusBarMessage("Coding Buddy: listening", 3000);
      } else {
        muted = true;
        sidebar.stopSpeech();
        bridge.mute(30);
        muteTimer = setTimeout(() => {
          muted = false;
          sidebar.pushStatus("Mute expired. Buddy listening again.");
        }, 30 * 60_000);
        sidebar.pushStatus("Buddy muted for 30 minutes.");
        void vscode.window.setStatusBarMessage("Coding Buddy: quiet 30m", 3000);
      }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.openSidebar", () =>
      vscode.commands.executeCommand("workbench.view.extension.coding-buddy")
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.switchMode", async () => {
      const pick = await vscode.window.showQuickPick(availableModes, {
        placeHolder: "Pick a Coding Buddy mode",
      });
      if (pick) bridge.setMode(pick);
    })
  );

  bridge.onReport(async ({ summary, refreshed }) => {
    const body = summary?.trim()
      ? summary
      : "_No learning report yet — interact with the buddy a few times, then refresh._";
    const header = refreshed
      ? "# Coding Buddy — learning report (refreshed)\n\n"
      : "# Coding Buddy — learning report\n\n";
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: header + body,
    });
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("markdown.showPreviewToSide");
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.showReport", () => bridge.getReport())
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.refreshReport", () => {
      sidebar.pushStatus("Refreshing learning report (this may take a few seconds)…");
      bridge.refreshReport();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.toggleVoice", () => {
      const next = !sidebar.isVoiceEnabled();
      sidebar.setVoice(next);
      if (!next) sidebar.stopSpeech();
      void vscode.window.setStatusBarMessage(`Coding Buddy voice → ${next ? "on" : "off"}`, 3000);
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.setVolume", async () => {
      const choice = await vscode.window.showQuickPick(
        ["10%", "20%", "30%", "50%", "70%", "100%"],
        { placeHolder: "Pick voice volume" }
      );
      if (!choice) return;
      const v = parseInt(choice, 10) / 100;
      bridge.setVolume(v);
      await cfg.update("voiceVolume", v, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`Coding Buddy volume → ${choice}`, 3000);
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.toggleRecord", async () => {
      if (!sidebar.isReady()) {
        await vscode.commands.executeCommand("workbench.view.extension.coding-buddy");
        await new Promise((r) => setTimeout(r, 250));
      }
      toggleMic();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.hardMute", () => {
      // Task 10.4: fire-and-forget — the daemon kills mic + TTS in
      // <50ms. We optimistically clear the local recording state so
      // the sidebar's mic button stops pulsing immediately, before
      // the hardMuted ack arrives.
      bridge.hardMute();
      if (recording) {
        recording = false;
        sidebar.setRecordingState(false);
      }
      sidebar.stopSpeech();
      sidebar.pushStatus("Hard mute: mic and TTS killed.");
      void vscode.window.setStatusBarMessage("Coding Buddy: hard muted", 2000);
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("coding-buddy.testVoice", async () => {
      if (!sidebar.isReady()) {
        await vscode.commands.executeCommand("workbench.view.extension.coding-buddy");
        await new Promise((r) => setTimeout(r, 250));
      }
      sidebar.testVoice();
    })
  );

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      if (isDeniedFile(e.document.uri.fsPath)) return;
      engine.noteEdit();

      for (const change of e.contentChanges) {
        const line = e.document.lineAt(change.range.end.line).text;
        const ev = engine.evaluateExplicit(line);
        if (ev) {
          sendTrigger(bridge, engine, ev, maxDiffLines, e.document);
          return;
        }
      }

      const text = e.document.getText();
      const mc = engine.evaluateMisconception(text);
      if (mc && !muted) {
        sendTrigger(bridge, engine, mc, maxDiffLines, e.document);
      }
    })
  );

  ctx.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      for (const uri of e.uris) {
        if (uri.toString() !== editor.document.uri.toString()) continue;
        if (isDeniedFile(uri.fsPath)) continue;
        const diags = vscode.languages.getDiagnostics(uri);

        const stuck = engine.evaluateDiagnostics(uri, diags);
        if (stuck.event && !muted) {
          sendTrigger(bridge, engine, stuck.event, maxDiffLines, editor.document, diags);
          return;
        }
        const bad = engine.evaluateBadPath(diags.length);
        if (bad && !muted) {
          sendTrigger(bridge, engine, bad, maxDiffLines, editor.document, diags);
          return;
        }
      }
    })
  );

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.uri.scheme !== "file") return;
      if (isDeniedFile(editor.document.uri.fsPath)) return;
      const ev = engine.evaluateNewTopic(editor.document.uri);
      if (ev && !muted) sendTrigger(bridge, engine, ev, maxDiffLines, editor.document);
    })
  );

  const idleInterval = setInterval(() => {
    if (muted) return;
    const editor = vscode.window.activeTextEditor;

    if (editor && editor.document.uri.scheme === "file" && !isDeniedFile(editor.document.uri.fsPath)) {
      const diags = vscode.languages.getDiagnostics(editor.document.uri);
      const errCount = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
      const stuck = engine.evaluateDiagnostics(editor.document.uri, diags);
      output.appendLine(
        `[poll] file=${vscode.workspace.asRelativePath(editor.document.uri)} diags=${diags.length} errors=${errCount} stuck=${stuck.debug}`
      );
      if (stuck.event) {
        sendTrigger(bridge, engine, stuck.event, maxDiffLines, editor.document, diags);
        return;
      }
      const bad = engine.evaluateBadPath(diags.length);
      if (bad) {
        sendTrigger(bridge, engine, bad, maxDiffLines, editor.document, diags);
        return;
      }
    }

    const ev = engine.evaluateIdle(idleSeconds);
    if (ev) {
      sendTrigger(bridge, engine, ev, maxDiffLines, editor?.document);
    }
  }, 30_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(idleInterval) });

  ctx.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution?.((e) => {
      const cmd = e.execution.commandLine.value;
      engine.noteTerminalRun(cmd, e.exitCode ?? 0);
    }) ?? { dispose: () => {} }
  );

  output.appendLine(`Coding Buddy active. daemon=:${port} idle=${idleSeconds}s`);
}

export function deactivate(): void {
  if (muteTimer) clearTimeout(muteTimer);
  if (spawnedDaemon) {
    spawnedDaemon.dispose();
    spawnedDaemon = undefined;
  }
}

function sendTrigger(
  bridge: DaemonBridge,
  engine: TriggerEngine,
  ev: TriggerEvent,
  maxDiffLines: number,
  doc?: vscode.TextDocument,
  diags?: readonly vscode.Diagnostic[]
): void {
  const editor = vscode.window.activeTextEditor;
  const target = doc ?? editor?.document;
  const payload: Record<string, unknown> = {
    active_file: target ? vscode.workspace.asRelativePath(target.uri) : null,
    selection: editor
      ? {
          line: editor.selection.active.line,
          text: target?.lineAt(editor.selection.active.line).text,
        }
      : null,
    diagnostics: (diags ?? (target ? vscode.languages.getDiagnostics(target.uri) : []))
      .slice(0, 10)
      .map((d) => ({
        severity: vscode.DiagnosticSeverity[d.severity],
        message: d.message,
        line: d.range.start.line,
      })),
    recent_terminal: engine.recentTerminal(),
    user_question: ev.userQuestion ?? null,
    reason: ev.reason,
  };

  if (target) {
    const key = target.uri.toString();
    const next = target.getText();
    const prev = fileSnapshots.get(key) ?? next;
    payload.recent_diff = makeMiniDiff(prev, next, maxDiffLines);
    fileSnapshots.set(key, next);

    const lines = next.split("\n");
    if (lines.length <= 300 && next.length <= 12_000) {
      payload.file_content = next;
    } else {
      const cursor = editor?.selection.active.line ?? 0;
      const start = Math.max(0, cursor - 40);
      const end = Math.min(lines.length, cursor + 40);
      payload.file_excerpt = {
        start_line: start,
        end_line: end,
        text: lines.slice(start, end).join("\n"),
      };
    }
  }

  const scrubbed = scrubSecrets(JSON.stringify(payload));
  if (scrubbed.hits > 0) {
    payload.secret_warning = `Scrubbed ${scrubbed.hits} secret-shaped strings before sending.`;
  }
  const safePayload = JSON.parse(scrubbed.text);
  bridge.trigger(ev.trigger, safePayload);
}
