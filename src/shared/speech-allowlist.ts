// The speech-recognition allow-list lives in manifest.json, not in settings:
// it is the `matches` / `exclude_matches` of the two static content_scripts
// entries that inject main-speech.js (MAIN world) and isolated-speech.js
// (ISOLATED world). Nothing at runtime (setup page, storage, page scripts)
// can widen it; changing it means editing manifest.json and reloading the
// extension.
//
// The offscreen document re-checks every request against the same entries
// (defense in depth). A frame is allowed only if BOTH entries match it, so a
// half-edited manifest fails closed.

import { urlAllowedBy } from "./match-pattern";

export const SPEECH_MAIN_SCRIPT = "main-speech.js";
export const SPEECH_ISOLATED_SCRIPT = "isolated-speech.js";

export interface ManifestContentScript {
  js?: string[];
  matches?: string[];
  exclude_matches?: string[];
  include_globs?: string[];
  exclude_globs?: string[];
  world?: string;
  run_at?: string;
  all_frames?: boolean;
}

export interface SpeechAllowlist {
  main: ManifestContentScript | undefined;
  isolated: ManifestContentScript | undefined;
}

export function speechAllowlistFromManifest(manifest: { content_scripts?: ManifestContentScript[] }): SpeechAllowlist {
  const entries = manifest.content_scripts ?? [];
  return {
    main: entries.find((e) => e.js?.includes(SPEECH_MAIN_SCRIPT)),
    isolated: entries.find((e) => e.js?.includes(SPEECH_ISOLATED_SCRIPT)),
  };
}

function entryAllows(url: string, e: ManifestContentScript | undefined): boolean {
  // Globs are not evaluated here; refuse rather than guess.
  if (!e || e.include_globs?.length || e.exclude_globs?.length) return false;
  return urlAllowedBy(url, e.matches ?? [], e.exclude_matches ?? []);
}

export function isSpeechAllowedByManifest(url: string, allowlist: SpeechAllowlist): boolean {
  return entryAllows(url, allowlist.main) && entryAllows(url, allowlist.isolated);
}

/** Problems a user can introduce while editing manifest.json by hand. */
export function validateSpeechAllowlist(allowlist: SpeechAllowlist): string[] {
  const problems: string[] = [];
  const { main, isolated } = allowlist;
  if (!main && !isolated) return problems; // speech disabled entirely
  if (!main) problems.push(`content_scripts entry for ${SPEECH_MAIN_SCRIPT} is missing`);
  if (!isolated) problems.push(`content_scripts entry for ${SPEECH_ISOLATED_SCRIPT} is missing`);
  if (!main || !isolated) return problems;
  if (main.world !== "MAIN") problems.push(`${SPEECH_MAIN_SCRIPT} must have "world": "MAIN"`);
  if (isolated.world !== undefined && isolated.world !== "ISOLATED") {
    problems.push(`${SPEECH_ISOLATED_SCRIPT} must run in the ISOLATED world`);
  }
  for (const e of [main, isolated]) {
    if (e.run_at !== "document_start") problems.push(`${e.js?.join(",")} must have "run_at": "document_start"`);
    if (e.include_globs?.length || e.exclude_globs?.length) {
      problems.push(`${e.js?.join(",")}: include_globs/exclude_globs are not supported; use matches/exclude_matches`);
    }
  }
  const same = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(main.matches, isolated.matches) || !same(main.exclude_matches, isolated.exclude_matches)) {
    problems.push(
      `${SPEECH_MAIN_SCRIPT} and ${SPEECH_ISOLATED_SCRIPT} must have identical "matches" and "exclude_matches"`,
    );
  }
  if (main.all_frames !== isolated.all_frames) problems.push(`both speech entries must have the same "all_frames"`);
  return problems;
}
