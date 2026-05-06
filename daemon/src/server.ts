import { WebSocketServer, WebSocket } from "ws";
import type { Session } from "./session.js";
import type { TtsBridge } from "./tts-bridge.js";
import type { SttBridge } from "./stt.js";
import type { Recorder } from "./recorder.js";
import type { VoteStore } from "./votes.js";
import type { PersonalityConfig } from "./personality-config.js";
import type { RollingCostRate } from "./cost-rate.js";

export interface ServerDeps {
  session: Session;
  tts: TtsBridge;
  stt: SttBridge;
  recorder: Recorder;
  port: number;
  votes?: VoteStore;
  /**
   * Personality names that exist on disk but are deliberately not
   * loaded for this provider, mapped to a human-readable reason.
   * The setPersonality WS handler surfaces these via the modeSet
   * ack so the sidebar can explain *why* a switch was refused
   * (e.g. nsfw on the Anthropic provider).
   */
  gatedPersonalities?: Map<string, string>;
  /**
   * Optional `personality name → kokoro voice id` lookup (Task 12.2).
   * On a successful setPersonality, the server pushes the configured
   * voice into TtsBridge so subsequent synth calls go to that voice.
   * Personalities absent from this map fall back to the bridge's
   * sidecar default. Wired by index.ts from the loaded personality
   * configs.
   */
  kokoroVoiceFor?: Map<string, string>;
  /**
   * Optional `personality name → full voice config` lookup
   * (Task 12.4). On a successful setPersonality, the server pushes
   * the matching config into TtsBridge so XTTS routing
   * (voice_engine="xtts" + xtts_ref) takes effect immediately.
   * Personalities absent from this map fall through to the bridge's
   * configured backend.
   */
  personalityVoiceConfigs?: Map<string, PersonalityConfig>;
  /**
   * Optional rolling-cost-rate observer (Task 13.3). When wired,
   * the WS handler responds to `{type: "getCostRate"}` with a
   * snapshot for the sidebar's $/hr counter. Absent → handler
   * replies with zeros.
   */
  costRate?: RollingCostRate;
}

export function startServer(deps: ServerDeps): WebSocketServer {
  const { session, tts, stt, recorder, port, votes } = deps;
  const gated = deps.gatedPersonalities ?? new Map<string, string>();
  const kokoroVoiceFor = deps.kokoroVoiceFor ?? new Map<string, string>();
  const personalityVoiceConfigs =
    deps.personalityVoiceConfigs ?? new Map<string, PersonalityConfig>();
  // Apply the initial personality's voice config immediately so the
  // first synth call after boot already routes to the right engine —
  // without this the bridge would fall back to its constructor's
  // backend until the user (re-)selected a personality.
  const initialVoice = kokoroVoiceFor.get(session.getPersonality());
  if (initialVoice) tts.setKokoroVoice(initialVoice);
  const initialCfg = personalityVoiceConfigs.get(session.getPersonality());
  if (initialCfg) tts.setPersonalityVoiceConfig(initialCfg);
  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  // The modeSet ack carries every personality-axis dimension (mode,
  // personality, shuffle) so the sidebar updates them in one round-trip
  // whether the user changed any of them or just connected. `reason`
  // rides along on rejections so the user sees *why* a switch failed.
  const modeAck = (ok: boolean, reason?: string): string =>
    JSON.stringify({
      type: "modeSet",
      ok,
      mode: session.getMode(),
      available: session.listModes(),
      personality: session.getPersonality(),
      availablePersonalities: session.listPersonalities(),
      shuffle: session.isShuffle(),
      ...(reason ? { reason } : {}),
    });

  wss.on("connection", (ws: WebSocket) => {
    console.log("[buddy-daemon] extension connected");
    ws.send(modeAck(true));
    ws.send(
      JSON.stringify({
        type: "audioOwner",
        owner: tts.isActive() ? "daemon" : "webview",
        backend: tts.describe(),
      })
    );

    ws.on("message", async (raw) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "bad json" }));
        return;
      }

      try {
        switch (msg.type) {
          case "trigger": {
            const { trigger, payload } = msg as unknown as {
              trigger: string;
              payload: object;
            };
            const payloadStr = JSON.stringify(payload);
            const hasRedaction = payloadStr.includes("<REDACTED-SECRET>");
            console.log(
              `[trigger] ${trigger} bytes=${payloadStr.length}${hasRedaction ? " [scrubbed]" : ""}`
            );
            const reply = await session.handleTrigger(trigger, payload);
            ws.send(JSON.stringify({ type: "reply", trigger, reply }));
            if (reply.mode !== "no_op" && reply.text) void tts.speak(reply.text);
            break;
          }
          case "mute": {
            const minutes = Number((msg as { minutes?: number }).minutes ?? 30);
            session.mute(minutes);
            tts.cancel();
            ws.send(JSON.stringify({ type: "muted", minutes }));
            break;
          }
          case "unmute": {
            session.unmute();
            ws.send(JSON.stringify({ type: "unmuted" }));
            break;
          }
          case "hardMute": {
            // Task 10.4: kill mic input AND any in-flight TTS in <50ms.
            // Both ops are synchronous so the work happens before we
            // even hit the ws.send below — the round-trip is dominated
            // by the WS client→server frame, not us.
            const startedAt = Date.now();
            const wasRecording = recorder.isRecording();
            recorder.cancel();
            const ttsResult = tts.cancel();
            const elapsedMs = Date.now() - startedAt;
            ws.send(
              JSON.stringify({
                type: "hardMuted",
                micCancelled: wasRecording,
                ttsSignaled: ttsResult.signaled,
                elapsedMs,
              })
            );
            break;
          }
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "vote": {
            if (!votes) {
              ws.send(JSON.stringify({ type: "voteAck", ok: false, error: "votes disabled" }));
              break;
            }
            const v = msg as { trigger?: string; reply_text?: string; vote?: string };
            const value = v.vote === "down" ? "down" : "up";
            const entry = votes.record({
              trigger: String(v.trigger ?? "unknown"),
              reply_text: String(v.reply_text ?? ""),
              vote: value,
            });
            ws.send(JSON.stringify({ type: "voteAck", ok: true, ts: entry.ts }));
            break;
          }
          case "setVolume": {
            const v = Number((msg as { volume?: number }).volume ?? 0.5);
            tts.setVolume(v);
            ws.send(JSON.stringify({ type: "volumeSet", volume: v, backend: tts.describe() }));
            break;
          }
          case "recordStart": {
            const r = recorder.start();
            ws.send(
              JSON.stringify({
                type: "recordStarted",
                ok: r.ok,
                error: r.ok ? undefined : (r as { error: string }).error,
              })
            );
            break;
          }
          case "recordStop": {
            const requestId = (msg as { requestId?: string }).requestId ?? "";
            if (!recorder.isRecording()) {
              ws.send(
                JSON.stringify({ type: "transcribed", requestId, ok: false, error: "not recording" })
              );
              break;
            }
            try {
              const r = await recorder.stop();
              if (!r.ok) {
                ws.send(
                  JSON.stringify({
                    type: "transcribed",
                    requestId,
                    ok: false,
                    error: (r as { error: string }).error,
                  })
                );
                break;
              }
              console.log(`[recorder] captured ${r.wav.length} bytes in ${r.durationMs}ms`);
              const text = await stt.transcribe(r.wav);
              console.log(`[transcribe] → "${text}"`);
              ws.send(JSON.stringify({ type: "transcribed", requestId, ok: true, text }));
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error("[recordStop] failed:", errMsg);
              ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: errMsg }));
            }
            break;
          }
          case "transcribe": {
            const requestId = (msg as { requestId?: string }).requestId ?? "";
            const b64 = (msg as { audio?: string }).audio ?? "";
            if (!b64) {
              ws.send(
                JSON.stringify({ type: "transcribed", requestId, ok: false, error: "no audio" })
              );
              break;
            }
            const buf = Buffer.from(b64, "base64");
            console.log(`[transcribe] received ${buf.length} bytes`);
            try {
              const text = await stt.transcribe(buf);
              console.log(`[transcribe] → "${text}"`);
              ws.send(JSON.stringify({ type: "transcribed", requestId, ok: true, text }));
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error("[transcribe] failed:", errMsg);
              ws.send(JSON.stringify({ type: "transcribed", requestId, ok: false, error: errMsg }));
            }
            break;
          }
          case "setMode": {
            const target = String((msg as { mode?: string }).mode ?? "");
            const ok = session.setMode(target);
            ws.send(modeAck(ok));
            break;
          }
          case "getMode":
            ws.send(modeAck(true));
            break;
          case "setPersonality": {
            const target = String((msg as { personality?: string }).personality ?? "");
            const ok = session.setPersonality(target);
            let reason: string | undefined;
            if (!ok) {
              reason =
                gated.get(target) ??
                `unknown personality '${target}' (available: ${session.listPersonalities().join(", ") || "none"})`;
              console.warn(`[server] setPersonality rejected: ${reason}`);
            } else {
              // Task 12.2: apply the personality's configured Kokoro voice
              // to the bridge immediately. Personalities without a config
              // entry leave the previous voice in place — the bridge
              // already fell back to the sidecar default before the
              // user changed personality.
              const voice = kokoroVoiceFor.get(target);
              if (voice) tts.setKokoroVoice(voice);
              // Task 12.4: also push the full personality voice config
              // so the bridge can route to XTTS when voice_engine=xtts.
              // We pass the new config unconditionally — when missing,
              // the bridge falls through to its constructor backend.
              tts.setPersonalityVoiceConfig(personalityVoiceConfigs.get(target));
            }
            ws.send(modeAck(ok, reason));
            break;
          }
          case "getPersonality":
            ws.send(modeAck(true));
            break;
          case "setShuffle": {
            const value = Boolean((msg as { shuffle?: boolean }).shuffle);
            session.setShuffle(value);
            ws.send(modeAck(true));
            break;
          }
          case "getReport": {
            const summary = session.getMemory().getSummary();
            const paths = session.getMemory().paths();
            ws.send(JSON.stringify({ type: "report", summary, paths }));
            break;
          }
          case "refreshReport": {
            const summary = await session.forceDistillProfile();
            const paths = session.getMemory().paths();
            ws.send(JSON.stringify({ type: "report", summary, paths, refreshed: true }));
            break;
          }
          case "getCostRate": {
            // Task 13.3: live $/hr counter for the sidebar pill.
            // The sidebar polls this on a timer (5-10s cadence is
            // plenty); when no costRate observer is wired the
            // server replies with zeros so the sidebar can render
            // a stable "—" or "$0.00/hr" placeholder.
            const snap = deps.costRate?.snapshot();
            ws.send(
              JSON.stringify({
                type: "costRate",
                spent_usd: snap?.spentUsd ?? 0,
                rate_per_hour_usd: snap?.ratePerHourUsd ?? 0,
                window_ms: snap?.windowMs ?? 0,
                turns_in_window: snap?.turnsInWindow ?? 0,
                computed_at: snap?.computedAt ?? Date.now(),
              })
            );
            break;
          }
          default:
            ws.send(JSON.stringify({ type: "error", error: `unknown type ${msg.type}` }));
        }
      } catch (err) {
        console.error("[buddy-daemon] handler error", err);
        ws.send(
          JSON.stringify({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    });

    ws.on("close", () => console.log("[buddy-daemon] extension disconnected"));
  });

  return wss;
}
