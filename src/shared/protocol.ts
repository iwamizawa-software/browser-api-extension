// Message shapes for every hop, plus strict validators.
//
//  MAIN world  <-- MessagePort -->  ISOLATED world  <-- runtime.Port -->  offscreen
//
// Every receiver validates what it gets: the MAIN world is shared with page
// scripts, so the ISOLATED relay treats everything coming from it as untrusted,
// and the offscreen document treats everything from content scripts as
// untrusted (a compromised renderer can send arbitrary messages).

export const CHANNELS = ["timers", "speech"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PORT_NAME_PREFIX = "bae-";

// ---- handshake (window.postMessage, MAIN <-> ISOLATED) ----------------------

export interface HelloMessage {
  magic: string;
  kind: "hello";
  channel: Channel;
}
export interface ReadyMessage {
  magic: string;
  kind: "ready";
  channel: Channel;
}

// ---- timers -------------------------------------------------------------------

export type TimerUp = { t: "arm"; seq: number; delay: number } | { t: "disarm" };
export type TimerDown = { t: "wake"; seq: number } | { t: "reset" } | { t: "ack" };

// ---- speech -------------------------------------------------------------------

export const SPEECH_ERROR_CODES = [
  "no-speech",
  "aborted",
  "audio-capture",
  "network",
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
  "bad-grammar",
] as const;
export type SpeechErrorCode = (typeof SPEECH_ERROR_CODES)[number];

export const SPEECH_EVENT_TYPES = [
  "start",
  "audiostart",
  "soundstart",
  "speechstart",
  "speechend",
  "soundend",
  "audioend",
  "nomatch",
  "end",
] as const;
export type SpeechEventType = (typeof SPEECH_EVENT_TYPES)[number];

export type SpeechUpFromMain =
  | { t: "start"; sid: number; lang: string; continuous: boolean; maxAlternatives: number }
  | { t: "stop"; sid: number }
  | { t: "abort"; sid: number };

export type SpeechUpToOffscreen =
  | {
      t: "start";
      sid: number;
      lang: string;
      documentLang: string;
      navigatorLang: string;
      continuous: boolean;
      maxAlternatives: number;
    }
  | { t: "stop"; sid: number }
  | { t: "abort"; sid: number };

export type SpeechSessionEvent =
  | { t: "ev"; sid: number; type: SpeechEventType }
  | { t: "result"; sid: number; transcript: string; confidence: number }
  | { t: "error"; sid: number; error: SpeechErrorCode; message: string };

export type SpeechDownFromOffscreen = SpeechSessionEvent | { t: "log"; level: "warn" | "info"; message: string };

export type SpeechDownToMain = SpeechSessionEvent | { t: "reset" } | { t: "ack" };

/** Sent by the offscreen document right after accepting a runtime.Port. */
export interface OffscreenHello {
  t: "hello";
}
export function isOffscreenHello(v: unknown): v is OffscreenHello {
  return isObj(v) && v.t === "hello";
}

// ---- extension-internal runtime messages ------------------------------------

export type RuntimeRequest =
  | { t: "ensure-offscreen" }
  | { t: "get-config" }
  | { t: "mic-state"; active: boolean };

// ---- validators -----------------------------------------------------------------

const MAX_STRING = 256;
const MAX_TRANSCRIPT = 100_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
export function isUint31(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;
}
function isShortString(v: unknown, max = MAX_STRING): v is string {
  return typeof v === "string" && v.length <= max;
}

export function isChannel(v: unknown): v is Channel {
  return v === "timers" || v === "speech";
}

export function isTimerUp(v: unknown): v is TimerUp {
  if (!isObj(v)) return false;
  if (v.t === "disarm") return true;
  return (
    v.t === "arm" &&
    isUint31(v.seq) &&
    typeof v.delay === "number" &&
    Number.isFinite(v.delay) &&
    v.delay >= 0 &&
    v.delay <= 0x7fffffff
  );
}

export function isTimerDown(v: unknown): v is TimerDown {
  if (!isObj(v)) return false;
  if (v.t === "reset" || v.t === "ack") return true;
  return v.t === "wake" && isUint31(v.seq);
}

export function isSpeechUpFromMain(v: unknown): v is SpeechUpFromMain {
  if (!isObj(v) || !isUint31(v.sid)) return false;
  if (v.t === "stop" || v.t === "abort") return true;
  return (
    v.t === "start" &&
    isShortString(v.lang) &&
    typeof v.continuous === "boolean" &&
    typeof v.maxAlternatives === "number" &&
    Number.isInteger(v.maxAlternatives) &&
    v.maxAlternatives >= 0 &&
    v.maxAlternatives <= 0xffffffff
  );
}

export function isSpeechUpToOffscreen(v: unknown): v is SpeechUpToOffscreen {
  if (!isSpeechUpFromMain(v)) return false;
  if (v.t !== "start") return true;
  const o = v as unknown as Record<string, unknown>;
  return isShortString(o.documentLang) && isShortString(o.navigatorLang);
}

export function isSpeechErrorCode(v: unknown): v is SpeechErrorCode {
  return typeof v === "string" && (SPEECH_ERROR_CODES as readonly string[]).includes(v);
}

export function isSpeechSessionEvent(v: unknown): v is SpeechSessionEvent {
  if (!isObj(v) || !isUint31(v.sid)) return false;
  switch (v.t) {
    case "ev":
      return typeof v.type === "string" && (SPEECH_EVENT_TYPES as readonly string[]).includes(v.type);
    case "result":
      return (
        isShortString(v.transcript, MAX_TRANSCRIPT) &&
        typeof v.confidence === "number" &&
        v.confidence >= 0 &&
        v.confidence <= 1
      );
    case "error":
      return isSpeechErrorCode(v.error) && isShortString(v.message, 1000);
    default:
      return false;
  }
}

export function isSpeechDownFromOffscreen(v: unknown): v is SpeechDownFromOffscreen {
  if (isObj(v) && v.t === "log") {
    return (v.level === "warn" || v.level === "info") && isShortString(v.message, 2000);
  }
  return isSpeechSessionEvent(v);
}

export function isSpeechDownToMain(v: unknown): v is SpeechDownToMain {
  if (isObj(v) && (v.t === "reset" || v.t === "ack")) return true;
  return isSpeechSessionEvent(v);
}
