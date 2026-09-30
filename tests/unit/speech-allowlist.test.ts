import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSpeechAllowedByManifest,
  speechAllowlistFromManifest,
  validateSpeechAllowlist,
  type ManifestContentScript,
} from "../../src/shared/speech-allowlist";

const entry = (js: string, over: Partial<ManifestContentScript> = {}): ManifestContentScript => ({
  matches: ["https://example.com/*"],
  exclude_matches: [],
  js: [js],
  world: js.startsWith("main") ? "MAIN" : "ISOLATED",
  run_at: "document_start",
  all_frames: true,
  ...over,
});
const manifest = (...content_scripts: ManifestContentScript[]) => ({ content_scripts });

describe("speech allow-list from manifest.json", () => {
  it("ships allowing only https://example.com/*", () => {
    const m = JSON.parse(readFileSync("src/manifest.json", "utf8"));
    const a = speechAllowlistFromManifest(m);
    expect(validateSpeechAllowlist(a)).toEqual([]);
    expect(a.main!.matches).toEqual(["https://example.com/*"]);
    expect(isSpeechAllowedByManifest("https://example.com/", a)).toBe(true);
    expect(isSpeechAllowedByManifest("https://example.com/app?x=1", a)).toBe(true);
    expect(isSpeechAllowedByManifest("http://example.com/", a)).toBe(false);
    expect(isSpeechAllowedByManifest("https://sub.example.com/", a)).toBe(false);
    expect(isSpeechAllowedByManifest("https://example.org/", a)).toBe(false);
  });

  it("requires both entries to allow the URL (fails closed)", () => {
    const a = speechAllowlistFromManifest(
      manifest(entry("main-speech.js"), entry("isolated-speech.js", { matches: ["https://other.test/*"] })),
    );
    expect(isSpeechAllowedByManifest("https://example.com/", a)).toBe(false);
    expect(isSpeechAllowedByManifest("https://other.test/", a)).toBe(false);
    expect(validateSpeechAllowlist(a)).toHaveLength(1);
  });

  it("honours exclude_matches", () => {
    const ex = { exclude_matches: ["https://example.com/private/*"] };
    const a = speechAllowlistFromManifest(manifest(entry("main-speech.js", ex), entry("isolated-speech.js", ex)));
    expect(isSpeechAllowedByManifest("https://example.com/private/x", a)).toBe(false);
    expect(isSpeechAllowedByManifest("https://example.com/public", a)).toBe(true);
  });

  it("refuses globs and missing entries", () => {
    const g = speechAllowlistFromManifest(
      manifest(entry("main-speech.js", { include_globs: ["*"] }), entry("isolated-speech.js", { include_globs: ["*"] })),
    );
    expect(isSpeechAllowedByManifest("https://example.com/", g)).toBe(false);
    expect(validateSpeechAllowlist(g).length).toBeGreaterThan(0);
    const half = speechAllowlistFromManifest(manifest(entry("main-speech.js")));
    expect(isSpeechAllowedByManifest("https://example.com/", half)).toBe(false);
    expect(validateSpeechAllowlist(half)).toEqual(["content_scripts entry for isolated-speech.js is missing"]);
    // Both removed = speech disabled, which is valid.
    expect(validateSpeechAllowlist(speechAllowlistFromManifest(manifest()))).toEqual([]);
  });

  it("flags wrong world / run_at", () => {
    const a = speechAllowlistFromManifest(
      manifest(entry("main-speech.js", { world: "ISOLATED" }), entry("isolated-speech.js", { run_at: "document_idle" })),
    );
    expect(validateSpeechAllowlist(a)).toEqual([
      'main-speech.js must have "world": "MAIN"',
      'isolated-speech.js must have "run_at": "document_start"',
    ]);
  });
});
