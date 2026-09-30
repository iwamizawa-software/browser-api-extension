// Maps content-script ports to recognition sessions.
//
// Security checks (the content scripts and everything behind them are
// untrusted):
//   * every message is schema-validated,
//   * the requesting frame's URL must match the user's speech allow-list
//     (defense in depth on top of the content script registration),
//   * session counts are capped per frame and globally,
//   * the API key is fetched from the service worker per session and is only
//     used for the Authorization header; it is never sent to content scripts.

import { resolveLanguage } from "../../shared/lang";
import { urlAllowedBy } from "../../shared/match-pattern";
import { isSpeechUpToOffscreen, type SpeechDownFromOffscreen, type SpeechUpToOffscreen } from "../../shared/protocol";
import { isPlausibleApiKey, type Settings } from "../../shared/settings";
import { interpretTranscription } from "./filter";
import { SttError, transcribeWithGroq } from "./groq";
import { AudioHub, FRAME_MS, SAMPLE_RATE } from "./hub";
import { RecognitionSession, type PrepareResult } from "./session";
import { encodeWav } from "./wav";

const MAX_SESSIONS_PER_FRAME = 8;
const MAX_SESSIONS_TOTAL = 32;

export interface OffscreenConfig {
  settings: Settings;
  apiKey: string;
  setupUrl: string;
}

export interface ManagerDeps {
  hub: AudioHub;
  getConfig(): Promise<OffscreenConfig>;
  micPermission(): Promise<PermissionState | "unknown">;
  groqBase: string;
}

export class SpeechManager {
  private total = 0;

  constructor(private readonly deps: ManagerDeps) {}

  attach(port: chrome.runtime.Port, sender: chrome.runtime.MessageSender): void {
    const sessions = new Map<number, RecognitionSession>();
    const frameUrl = sender.url ?? "";
    let alive = true;

    const post = (msg: SpeechDownFromOffscreen) => {
      if (!alive) return;
      try {
        port.postMessage(msg);
      } catch {
        alive = false;
      }
    };

    port.onMessage.addListener((msg: unknown) => {
      if (!isSpeechUpToOffscreen(msg)) return;
      if (msg.t === "start") {
        if (sessions.has(msg.sid)) return;
        if (sessions.size >= MAX_SESSIONS_PER_FRAME || this.total >= MAX_SESSIONS_TOTAL) {
          post({ t: "error", sid: msg.sid, error: "service-not-allowed", message: "Too many concurrent recognitions." });
          post({ t: "ev", sid: msg.sid, type: "end" });
          return;
        }
        const sid = msg.sid;
        const session = new RecognitionSession(msg.continuous, {
          emit: (out) => {
            post({ ...out, sid } as SpeechDownFromOffscreen);
            if (out.t === "ev" && out.type === "end" && sessions.get(sid) === session) {
              sessions.delete(sid);
              this.total--;
            }
          },
          prepare: () => this.prepare(msg, frameUrl, post),
          acquireAudio: (sub) => this.deps.hub.subscribe(sub),
        });
        sessions.set(sid, session);
        this.total++;
        void session.start();
        return;
      }
      const session = sessions.get(msg.sid);
      if (!session) return;
      if (msg.t === "stop") session.stop();
      else session.abort();
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      alive = false;
      for (const s of sessions.values()) s.dispose();
      this.total -= sessions.size;
      sessions.clear();
    });
  }

  private async prepare(
    msg: Extract<SpeechUpToOffscreen, { t: "start" }>,
    frameUrl: string,
    post: (m: SpeechDownFromOffscreen) => void,
  ): Promise<PrepareResult> {
    let config: OffscreenConfig;
    try {
      config = await this.deps.getConfig();
    } catch {
      return { ok: false, error: "network", message: "Extension configuration unavailable." };
    }
    const { settings, apiKey, setupUrl } = config;
    const speech = settings.speech;
    if (!speech.enabled || !urlAllowedBy(frameUrl, speech.matches, speech.excludeMatches)) {
      return { ok: false, error: "service-not-allowed", message: "Speech recognition is not enabled for this site." };
    }
    if (!isPlausibleApiKey(apiKey)) {
      post({ t: "log", level: "warn", message: `Groq API key is not configured. Open the setup page: ${setupUrl}` });
      return { ok: false, error: "service-not-allowed", message: "Speech recognition service is not configured." };
    }
    const lang = resolveLanguage(msg.lang, msg.documentLang, msg.navigatorLang);
    if (!lang.ok) return { ok: false, error: lang.error, message: "" };

    const permission = await this.deps.micPermission();
    if (permission === "denied" || permission === "prompt") {
      post({
        t: "log",
        level: "warn",
        message: `Microphone permission is not granted to the extension. Open the setup page: ${setupUrl}`,
      });
      return { ok: false, error: "not-allowed", message: "Microphone permission has not been granted." };
    }

    const language = lang.code;
    const filterOptions = {
      noSpeechProbThreshold: speech.noSpeechProbThreshold,
      avgLogprobThreshold: speech.avgLogprobThreshold,
      blocklistEnabled: speech.blocklistEnabled,
      blocklist: speech.blocklist,
    };
    const groqBase = this.deps.groqBase;
    return {
      ok: true,
      segmenter: {
        frameMs: FRAME_MS,
        positiveThreshold: speech.vadPositiveThreshold,
        negativeThreshold: Math.max(0.01, speech.vadPositiveThreshold - 0.15),
        redemptionMs: speech.vadRedemptionMs,
        preSpeechPadMs: 300,
        minSpeechMs: speech.minSpeechMs,
        maxSegmentMs: speech.maxUtteranceSec * 1000,
      },
      async transcribe(audio, signal) {
        const wav = new Blob([encodeWav(audio, SAMPLE_RATE)], { type: "audio/wav" });
        try {
          const resp = await transcribeWithGroq(wav, { apiKey, language, baseUrl: groqBase }, signal);
          return interpretTranscription(resp, language, filterOptions);
        } catch (e) {
          if (e instanceof SttError && e.code === "not-allowed") {
            post({ t: "log", level: "warn", message: `Groq rejected the API key (HTTP ${e.status}). Open the setup page: ${setupUrl}` });
          }
          throw e;
        }
      },
    };
  }
}
