// Text <-> settings conversions for the setup page (pure; unit-tested).

import { isValidMatchPattern } from "../shared/match-pattern";

export function parsePatternList(text: string): { patterns: string[]; invalid: string[] } {
  const patterns: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!isValidMatchPattern(line)) invalid.push(line);
    else if (!patterns.includes(line)) patterns.push(line);
  }
  return { patterns, invalid };
}

export function parseBlocklist(text: string): { blocklist: Record<string, string[]>; invalid: string[] } {
  const blocklist: Record<string, string[]> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\*|[a-zA-Z]{2,3})\s*[:：]\s*(.+)$/.exec(line);
    if (!m) {
      invalid.push(line);
      continue;
    }
    const lang = m[1]!.toLowerCase();
    (blocklist[lang] ??= []).push(m[2]!.trim());
  }
  return { blocklist, invalid };
}

export function formatBlocklist(blocklist: Record<string, string[]>): string {
  return Object.entries(blocklist)
    .flatMap(([lang, phrases]) => phrases.map((p) => `${lang}: ${p}`))
    .join("\n");
}

/** Shows only the last 4 characters of a stored key. */
export function maskKey(key: string): string {
  return key.length <= 8 ? "********" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
