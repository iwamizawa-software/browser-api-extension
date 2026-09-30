// Turns a Groq verbose_json response into a transcript, dropping likely
// hallucinations:
//   * segments with no_speech_prob above the threshold,
//   * segments with avg_logprob below the threshold,
//   * segments (or whole transcripts) that exactly match a blocklisted phrase
//     after normalization (e.g. "ご視聴ありがとうございました").
//
// Whisper returns no confidence value; we approximate it as
// exp(duration-weighted mean avg_logprob) of the kept segments.

import type { GroqSegment, GroqVerboseResponse } from "./groq";

export interface FilterOptions {
  noSpeechProbThreshold: number;
  avgLogprobThreshold: number;
  blocklistEnabled: boolean;
  blocklist: Record<string, string[]>;
}

export interface Transcript {
  text: string;
  confidence: number;
}

/** Confidence used when the API returns no segment information. */
export const FALLBACK_CONFIDENCE = 0.5;

export function normalizePhrase(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function blockedSet(language: string | null, opts: FilterOptions): Set<string> {
  const out = new Set<string>();
  if (!opts.blocklistEnabled) return out;
  const langs = language ? [language, "*"] : Object.keys(opts.blocklist);
  for (const l of langs) for (const p of opts.blocklist[l] ?? []) {
    const n = normalizePhrase(p);
    if (n) out.add(n);
  }
  return out;
}

function keepSegment(s: GroqSegment, opts: FilterOptions, blocked: Set<string>): boolean {
  if (s.no_speech_prob > opts.noSpeechProbThreshold) return false;
  if (s.avg_logprob < opts.avgLogprobThreshold) return false;
  const n = normalizePhrase(s.text);
  return n !== "" && !blocked.has(n);
}

export function interpretTranscription(
  resp: GroqVerboseResponse,
  language: string | null,
  opts: FilterOptions,
): Transcript | null {
  const blocked = blockedSet(language, opts);
  let text: string;
  let confidence: number;
  if (resp.segments && resp.segments.length > 0) {
    const kept = resp.segments.filter((s) => keepSegment(s, opts, blocked));
    if (kept.length === 0) return null;
    text = kept.map((s) => s.text).join("");
    let weighted = 0;
    let total = 0;
    for (const s of kept) {
      const d = Math.max(0.01, s.end - s.start);
      weighted += s.avg_logprob * d;
      total += d;
    }
    confidence = Math.exp(weighted / total);
  } else {
    text = resp.text;
    confidence = FALLBACK_CONFIDENCE;
  }
  text = text.replace(/\s+/g, " ").trim();
  const n = normalizePhrase(text);
  if (n === "" || blocked.has(n)) return null;
  return { text, confidence: Math.min(1, Math.max(0, confidence)) };
}
