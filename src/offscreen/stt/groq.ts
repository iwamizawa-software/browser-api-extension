// Groq OpenAI-compatible transcription client.
// POST {base}/audio/transcriptions (multipart/form-data)
//
// The API key is only ever used in the Authorization header here and is never
// logged or included in error messages.

import type { SpeechErrorCode } from "../../shared/protocol";

export const GROQ_MODEL = "whisper-large-v3";

export class SttError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SttError";
  }
}

export interface GroqSegment {
  text: string;
  start: number;
  end: number;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio?: number;
}

export interface GroqVerboseResponse {
  text: string;
  language?: string;
  segments?: GroqSegment[];
}

export interface GroqRequestOptions {
  apiKey: string;
  /** ISO-639-1 (Groq code) or null for auto-detection. */
  language: string | null;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  random?: () => number;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SttError("aborted", "aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new SttError("aborted", "aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After as seconds or HTTP date; capped. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function parseVerboseResponse(json: unknown): GroqVerboseResponse {
  if (typeof json !== "object" || json === null || typeof (json as { text?: unknown }).text !== "string") {
    throw new SttError("network", "Unexpected transcription response.");
  }
  const o = json as Record<string, unknown>;
  const out: GroqVerboseResponse = { text: o.text as string };
  if (typeof o.language === "string") out.language = o.language;
  if (Array.isArray(o.segments)) {
    out.segments = [];
    for (const s of o.segments as Record<string, unknown>[]) {
      if (typeof s !== "object" || s === null || typeof s.text !== "string") continue;
      out.segments.push({
        text: s.text,
        start: isNum(s.start) ? s.start : 0,
        end: isNum(s.end) ? s.end : 0,
        avg_logprob: isNum(s.avg_logprob) ? s.avg_logprob : 0,
        no_speech_prob: isNum(s.no_speech_prob) ? s.no_speech_prob : 0,
        ...(isNum(s.compression_ratio) ? { compression_ratio: s.compression_ratio } : {}),
      });
    }
  }
  return out;
}

export async function transcribeWithGroq(
  wav: Blob,
  opts: GroqRequestOptions,
  signal: AbortSignal,
): Promise<GroqVerboseResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? abortableSleep;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const url = `${opts.baseUrl}/audio/transcriptions`;

  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new SttError("aborted", "aborted");
    const form = new FormData();
    form.append("file", wav, "audio.wav");
    form.append("model", GROQ_MODEL);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (opts.language) form.append("language", opts.language);

    const attemptCtrl = new AbortController();
    const onAbort = () => attemptCtrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => attemptCtrl.abort(), timeoutMs);
    let retryDelay: number | null = null;
    let failure: SttError;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: attemptCtrl.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new SttError("network", "Invalid JSON from transcription API.");
        }
        return parseVerboseResponse(json);
      }
      if (res.status === 401 || res.status === 403) {
        throw new SttError("not-allowed", `Transcription API rejected the API key (HTTP ${res.status}).`, res.status);
      }
      failure = new SttError("network", `Transcription API error (HTTP ${res.status}).`, res.status);
      if (!RETRYABLE(res.status)) throw failure;
      retryDelay = parseRetryAfter(res.headers.get("retry-after"));
    } catch (e) {
      if (e instanceof SttError) {
        if (!(e.status !== undefined && RETRYABLE(e.status))) throw e;
        failure = e;
      } else if (signal.aborted) {
        throw new SttError("aborted", "aborted");
      } else {
        // fetch() network failure or per-attempt timeout.
        failure = new SttError("network", attemptCtrl.signal.aborted ? "Transcription request timed out." : "Network error.");
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (attempt >= maxRetries) throw failure;
    const backoff = 500 * 2 ** attempt + Math.floor(random() * 250);
    await sleep(Math.min(10_000, retryDelay ?? backoff), signal);
  }
}
