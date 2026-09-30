import { describe, expect, it } from "vitest";
import { parseMatchPattern, urlAllowedBy, urlMatchesPattern } from "../../src/shared/match-pattern";
import { resolveLanguage, toGroqLanguage } from "../../src/shared/lang";
import { defaultSettings, isPlausibleApiKey, sanitizeSettings } from "../../src/shared/settings";
import { isSpeechSessionEvent, isSpeechUpFromMain, isTimerUp } from "../../src/shared/protocol";

describe("match patterns", () => {
  const m = (p: string, url: string) => {
    const parsed = parseMatchPattern(p);
    expect(parsed, p).not.toBeNull();
    return urlMatchesPattern(url, parsed!);
  };

  it("parses and rejects", () => {
    expect(parseMatchPattern("<all_urls>")).not.toBeNull();
    expect(parseMatchPattern("https://*.example.com/*")).not.toBeNull();
    expect(parseMatchPattern("http://localhost:8080/*")).not.toBeNull();
    expect(parseMatchPattern("file:///*")).not.toBeNull();
    expect(parseMatchPattern("https://exa*mple.com/*")).toBeNull();
    expect(parseMatchPattern("https://example.com")).toBeNull();
    expect(parseMatchPattern("chrome://settings/*")).toBeNull();
    expect(parseMatchPattern("javascript:alert(1)")).toBeNull();
    expect(parseMatchPattern("https:///*")).toBeNull();
  });

  it("matches like Chrome", () => {
    expect(m("<all_urls>", "https://a.b/c")).toBe(true);
    expect(m("<all_urls>", "chrome://settings")).toBe(false);
    expect(m("*://*/*", "http://x.test/")).toBe(true);
    expect(m("*://*/*", "file:///tmp/a")).toBe(false);
    expect(m("https://*.example.com/*", "https://example.com/")).toBe(true);
    expect(m("https://*.example.com/*", "https://a.b.example.com/x?y")).toBe(true);
    expect(m("https://*.example.com/*", "https://badexample.com/")).toBe(false);
    expect(m("https://example.com/app/*", "https://example.com/app/x")).toBe(true);
    expect(m("https://example.com/app/*", "https://example.com/other")).toBe(false);
    expect(m("http://localhost:8080/*", "http://localhost:8080/a")).toBe(true);
    expect(m("http://localhost:8080/*", "http://localhost:9090/a")).toBe(false);
    expect(m("http://localhost/*", "http://localhost:9090/a")).toBe(true);
    expect(m("https://example.com/*", "http://example.com/")).toBe(false);
  });

  it("applies excludes", () => {
    expect(urlAllowedBy("https://a.test/x", ["<all_urls>"], ["https://a.test/*"])).toBe(false);
    expect(urlAllowedBy("https://b.test/x", ["<all_urls>"], ["https://a.test/*"])).toBe(true);
    expect(urlAllowedBy("https://b.test/x", [], [])).toBe(false);
    expect(urlAllowedBy("https://b.test/x", ["not a pattern"], [])).toBe(false);
  });
});

describe("language", () => {
  it("maps BCP-47 to Groq codes", () => {
    expect(toGroqLanguage("ja-JP")).toBe("ja");
    expect(toGroqLanguage("en_US")).toBe("en");
    expect(toGroqLanguage("EN")).toBe("en");
    expect(toGroqLanguage("iw-IL")).toBe("he");
    expect(toGroqLanguage("zh-yue-HK")).toBe("yue");
    expect(toGroqLanguage("yue-Hant-HK")).toBe("yue");
    expect(toGroqLanguage("haw")).toBe("haw");
    expect(toGroqLanguage("jw")).toBe("jv");
    expect(toGroqLanguage("xx-YY")).toBeNull();
    expect(toGroqLanguage("ja JP")).toBeNull();
    expect(toGroqLanguage("")).toBeNull();
  });

  it("resolves in order and treats explicit unsupported as error", () => {
    expect(resolveLanguage("en-US", "ja", "de")).toEqual({ ok: true, code: "en", source: "explicit" });
    expect(resolveLanguage("", "ja", "de")).toEqual({ ok: true, code: "ja", source: "document" });
    expect(resolveLanguage(" ", "", "de-DE")).toEqual({ ok: true, code: "de", source: "navigator" });
    expect(resolveLanguage("", "tlh", "de")).toEqual({ ok: true, code: null, source: "document" });
    expect(resolveLanguage("tlh", "ja", "de")).toEqual({ ok: false, error: "language-not-supported" });
    expect(resolveLanguage("", "", "")).toEqual({ ok: true, code: null, source: "none" });
  });
});

describe("settings", () => {
  it("fills defaults and clamps", () => {
    expect(sanitizeSettings(undefined)).toEqual(defaultSettings());
    const s = sanitizeSettings({
      timers: { enabled: false, matches: ["https://a.test/*", "bogus", 3, "https://a.test/*"] },
      speech: { noSpeechProbThreshold: 5, avgLogprobThreshold: "x", maxUtteranceSec: 1000, blocklist: { ja: ["a", 1], "bad key": ["b"] } },
    });
    expect(s.timers.enabled).toBe(false);
    expect(s.timers.matches).toEqual(["https://a.test/*"]);
    expect(s.speech.noSpeechProbThreshold).toBe(1);
    expect(s.speech.avgLogprobThreshold).toBe(-1);
    expect(s.speech.maxUtteranceSec).toBe(60);
    expect(s.speech.blocklist).toEqual({ ja: ["a"] });
    expect(s.speech.matches).toEqual([]);
  });

  it("checks api key shape", () => {
    expect(isPlausibleApiKey("gsk_" + "a".repeat(40))).toBe(true);
    expect(isPlausibleApiKey("short")).toBe(false);
    expect(isPlausibleApiKey("gsk_ with space and more chars")).toBe(false);
  });
});

describe("protocol validators", () => {
  it("validates timer messages", () => {
    expect(isTimerUp({ t: "arm", seq: 1, delay: 10 })).toBe(true);
    expect(isTimerUp({ t: "arm", seq: -1, delay: 10 })).toBe(false);
    expect(isTimerUp({ t: "arm", seq: 1, delay: Infinity })).toBe(false);
    expect(isTimerUp({ t: "disarm" })).toBe(true);
    expect(isTimerUp(null)).toBe(false);
  });
  it("validates speech messages", () => {
    expect(isSpeechUpFromMain({ t: "start", sid: 1, lang: "ja", continuous: false, maxAlternatives: 1 })).toBe(true);
    expect(isSpeechUpFromMain({ t: "start", sid: 1, lang: "x".repeat(1000), continuous: false, maxAlternatives: 1 })).toBe(false);
    expect(isSpeechUpFromMain({ t: "stop", sid: 2 })).toBe(true);
    expect(isSpeechSessionEvent({ t: "ev", sid: 1, type: "end" })).toBe(true);
    expect(isSpeechSessionEvent({ t: "ev", sid: 1, type: "click" })).toBe(false);
    expect(isSpeechSessionEvent({ t: "error", sid: 1, error: "network", message: "" })).toBe(true);
    expect(isSpeechSessionEvent({ t: "error", sid: 1, error: "boom", message: "" })).toBe(false);
    expect(isSpeechSessionEvent({ t: "result", sid: 1, transcript: "a", confidence: 2 })).toBe(false);
  });
});
