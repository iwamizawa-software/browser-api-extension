// BCP-47 -> Groq/Whisper language code mapping.
//
// The list is copied from the `language` literal union in the official Groq
// SDK (groq-python: src/groq/types/audio/transcription_create_params.py), which
// is generated from Groq's OpenAPI spec. Note Groq uses "jv" (ISO-639-1) where
// upstream Whisper uses "jw", and includes the 3-letter codes "haw" and "yue".
export const GROQ_LANGUAGES: ReadonlySet<string> = new Set([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
  "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
  "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
  "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
  "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
  "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha",
  "ba", "jv", "su", "yue",
]);

// Deprecated / alternative primary subtags that browsers and sites still use.
const ALIASES: Record<string, string> = {
  iw: "he",
  in: "id",
  ji: "yi",
  jw: "jv",
  nb: "no",
  fil: "tl",
  cmn: "zh",
  zho: "zh",
  jpn: "ja",
  eng: "en",
};

const TAG_RE = /^[a-zA-Z]{2,8}([-_][a-zA-Z0-9]{1,8})*$/;

/** Returns the Groq code for a BCP-47 tag, or null when unsupported/invalid. */
export function toGroqLanguage(tag: string): string | null {
  const t = tag.trim();
  if (!TAG_RE.test(t)) return null;
  const parts = t.toLowerCase().split(/[-_]/);
  let primary = parts[0]!;
  primary = ALIASES[primary] ?? primary;
  // "zh-yue" / "zh-HK" style Cantonese tags.
  if (primary === "zh" && parts.includes("yue")) return "yue";
  return GROQ_LANGUAGES.has(primary) ? primary : null;
}

export type LanguageResolution =
  | { ok: true; code: string | null; source: "explicit" | "document" | "navigator" | "none" }
  | { ok: false; error: "language-not-supported" };

/**
 * Order: recognition.lang -> <html lang> -> navigator.language.
 * An explicit, unsupported recognition.lang is an error (like Chrome's
 * language-not-supported). An unsupported *fallback* language is not the
 * page's fault, so we let Whisper auto-detect instead (code: null).
 */
export function resolveLanguage(explicit: string, documentLang: string, navigatorLang: string): LanguageResolution {
  if (explicit.trim() !== "") {
    const code = toGroqLanguage(explicit);
    return code ? { ok: true, code, source: "explicit" } : { ok: false, error: "language-not-supported" };
  }
  for (const [value, source] of [
    [documentLang, "document"],
    [navigatorLang, "navigator"],
  ] as const) {
    if (value.trim() !== "") return { ok: true, code: toGroqLanguage(value), source };
  }
  return { ok: true, code: null, source: "none" };
}
