// Timer content scripts are registered dynamically (chrome.scripting) instead
// of in manifest.json, so that the ON/OFF switch and the per-site
// target/exclude lists take effect at document_start without any async
// settings lookup in the page. Changes apply to documents loaded afterwards.
//
// Speech content scripts are NOT registered here: they are static
// content_scripts in manifest.json, whose matches are the speech allow-list
// (see src/shared/speech-allowlist.ts). Runtime settings cannot widen it.

import type { FeatureScope, Settings } from "../shared/settings";

export const SCRIPT_ID_PREFIX = "bae-";

type Registered = chrome.scripting.RegisteredContentScript;

function scriptsFor(feature: "timers", scope: FeatureScope, fallbackOrigin: boolean): Registered[] {
  if (!scope.enabled || scope.matches.length === 0) return [];
  const base = {
    matches: scope.matches,
    ...(scope.excludeMatches.length ? { excludeMatches: scope.excludeMatches } : {}),
    runAt: "document_start" as const,
    allFrames: true,
    persistAcrossSessions: true,
    // Also inject into about:blank / srcdoc frames of matching origins, which
    // pages could otherwise use to obtain unpatched natives.
    ...(fallbackOrigin ? { matchOriginAsFallback: true } : {}),
  };
  return [
    { ...base, id: `${SCRIPT_ID_PREFIX}${feature}-main`, js: [`main-${feature}.js`], world: "MAIN" },
    { ...base, id: `${SCRIPT_ID_PREFIX}${feature}-isolated`, js: [`isolated-${feature}.js`], world: "ISOLATED" },
  ] as Registered[];
}

export function desiredScripts(settings: Settings, withFallbackOrigin: boolean): Registered[] {
  return scriptsFor("timers", settings.timers, withFallbackOrigin);
}

export interface RegistrationStatus {
  ok: boolean;
  at: number;
  error?: string;
  note?: string;
}

export async function applyRegistrations(settings: Settings): Promise<RegistrationStatus> {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.map((s) => s.id).filter((id) => id.startsWith(SCRIPT_ID_PREFIX));
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });

  const withFallback = desiredScripts(settings, true);
  if (withFallback.length === 0) return { ok: true, at: Date.now() };
  try {
    await chrome.scripting.registerContentScripts(withFallback);
    return { ok: true, at: Date.now() };
  } catch (e) {
    // matchOriginAsFallback needs Chrome 119+ and patterns whose path is "/*".
    const first = String((e as Error)?.message ?? e);
    try {
      await chrome.scripting.registerContentScripts(desiredScripts(settings, false));
      return { ok: true, at: Date.now(), note: `about:blank frames not covered (${first})` };
    } catch (e2) {
      return { ok: false, at: Date.now(), error: String((e2 as Error)?.message ?? e2) };
    }
  }
}
