// Settings schema shared by the service worker, the offscreen document (via the
// service worker) and the setup page. Everything read from storage goes
// through `sanitizeSettings`, so a corrupted or hand-edited value can never
// produce an out-of-range threshold or an invalid match pattern.

import { isValidMatchPattern } from "./match-pattern";

export const STORAGE_KEYS = {
  settings: "settings",
  apiKey: "groqApiKey",
  registrationStatus: "registrationStatus",
} as const;

export interface FeatureScope {
  enabled: boolean;
  /** Match patterns where the feature is injected. */
  matches: string[];
  /** Match patterns excluded even if they match `matches`. */
  excludeMatches: string[];
}

export interface SpeechSettings extends FeatureScope {
  /** Segments whose no_speech_prob is above this are discarded (0..1). */
  noSpeechProbThreshold: number;
  /** Segments whose avg_logprob is below this are discarded (<= 0). */
  avgLogprobThreshold: number;
  blocklistEnabled: boolean;
  /** language code (ISO-639-1 as sent to Groq) or "*" -> phrases. */
  blocklist: Record<string, string[]>;
  /** Silero speech probability threshold (0..1). */
  vadPositiveThreshold: number;
  /** Silence needed to close an utterance. */
  vadRedemptionMs: number;
  /** Utterances with less speech than this are treated as noise. */
  minSpeechMs: number;
  /** Utterances longer than this are split. */
  maxUtteranceSec: number;
}

export interface Settings {
  timers: FeatureScope;
  speech: SpeechSettings;
}

export const DEFAULT_BLOCKLIST: Record<string, string[]> = {
  ja: [
    "ご視聴ありがとうございました",
    "最後までご視聴いただきありがとうございました",
    "ご清聴ありがとうございました",
    "チャンネル登録よろしくお願いします",
    "チャンネル登録をお願いします",
    "おやすみなさい",
  ],
  en: [
    "Thank you for watching.",
    "Thanks for watching!",
    "Thank you for watching!",
    "Please subscribe to my channel.",
    "Thank you.",
    "you",
  ],
};

export function defaultSettings(): Settings {
  return {
    timers: { enabled: true, matches: ["<all_urls>"], excludeMatches: [] },
    speech: {
      enabled: true,
      // Deliberately empty: any site on this list can turn the microphone on
      // and read transcripts without a per-site permission prompt.
      matches: [],
      excludeMatches: [],
      noSpeechProbThreshold: 0.6,
      avgLogprobThreshold: -1.0,
      blocklistEnabled: true,
      blocklist: structuredClone(DEFAULT_BLOCKLIST),
      vadPositiveThreshold: 0.5,
      vadRedemptionMs: 800,
      minSpeechMs: 250,
      maxUtteranceSec: 25,
    },
  };
}

export const LIMITS = {
  maxPatterns: 200,
  maxPatternLength: 2048,
  maxBlocklistEntries: 500,
  maxPhraseLength: 500,
  vadRedemptionMs: [100, 5000],
  minSpeechMs: [0, 5000],
  maxUtteranceSec: [3, 60],
} as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function sanitizePatterns(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== "string") continue;
    const s = p.trim();
    if (s && s.length <= LIMITS.maxPatternLength && isValidMatchPattern(s) && !out.includes(s)) out.push(s);
    if (out.length >= LIMITS.maxPatterns) break;
  }
  return out;
}

function sanitizeBlocklist(v: unknown, fallback: Record<string, string[]>): Record<string, string[]> {
  if (!isObject(v)) return structuredClone(fallback);
  const out: Record<string, string[]> = Object.create(null);
  let count = 0;
  for (const [lang, phrases] of Object.entries(v)) {
    if (!/^(\*|[a-z]{2,3})$/.test(lang) || !Array.isArray(phrases)) continue;
    const list: string[] = [];
    for (const p of phrases) {
      if (typeof p !== "string") continue;
      const s = p.trim();
      if (!s || s.length > LIMITS.maxPhraseLength || count >= LIMITS.maxBlocklistEntries) continue;
      list.push(s);
      count++;
    }
    if (list.length) out[lang] = list;
  }
  // Plain object for structured cloning / JSON.
  return { ...out };
}

function sanitizeScope(v: unknown, d: FeatureScope): FeatureScope {
  const o = isObject(v) ? v : {};
  return {
    enabled: bool(o.enabled, d.enabled),
    matches: sanitizePatterns(o.matches, d.matches),
    excludeMatches: sanitizePatterns(o.excludeMatches, d.excludeMatches),
  };
}

export function sanitizeSettings(v: unknown): Settings {
  const d = defaultSettings();
  const o = isObject(v) ? v : {};
  const s = isObject(o.speech) ? o.speech : {};
  return {
    timers: sanitizeScope(o.timers, d.timers),
    speech: {
      ...sanitizeScope(o.speech, d.speech),
      noSpeechProbThreshold: num(s.noSpeechProbThreshold, d.speech.noSpeechProbThreshold, 0, 1),
      avgLogprobThreshold: num(s.avgLogprobThreshold, d.speech.avgLogprobThreshold, -20, 0),
      blocklistEnabled: bool(s.blocklistEnabled, d.speech.blocklistEnabled),
      blocklist: sanitizeBlocklist(s.blocklist, d.speech.blocklist),
      vadPositiveThreshold: num(s.vadPositiveThreshold, d.speech.vadPositiveThreshold, 0.05, 0.95),
      vadRedemptionMs: num(s.vadRedemptionMs, d.speech.vadRedemptionMs, ...LIMITS.vadRedemptionMs),
      minSpeechMs: num(s.minSpeechMs, d.speech.minSpeechMs, ...LIMITS.minSpeechMs),
      maxUtteranceSec: num(s.maxUtteranceSec, d.speech.maxUtteranceSec, ...LIMITS.maxUtteranceSec),
    },
  };
}

/** Groq keys look like "gsk_..." but we only enforce a conservative charset/length. */
export function isPlausibleApiKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_\-.]{20,200}$/.test(key);
}
