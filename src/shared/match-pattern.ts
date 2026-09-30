// Minimal implementation of Chrome extension match patterns.
// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
//
// Used for (1) validating user input in the setup page before it is handed to
// chrome.scripting.registerContentScripts (Chrome remains the final judge), and
// (2) a defense-in-depth check in the offscreen document that a speech request
// really comes from a frame the user allow-listed.

const SCHEMES = ["http", "https", "ws", "wss", "ftp", "file"] as const;
const ALL_URLS_SCHEMES = new Set<string>(SCHEMES);

export interface ParsedPattern {
  allUrls: boolean;
  /** "*" means http or https (and ws/wss for Chrome, we keep http/https/ws/wss). */
  scheme: string;
  /** "" for file scheme, "*" for any host, "*.example.com" for subdomains. */
  host: string;
  /** undefined = any port. */
  port: string | undefined;
  path: string;
}

export function parseMatchPattern(pattern: string): ParsedPattern | null {
  if (typeof pattern !== "string") return null;
  if (pattern === "<all_urls>") {
    return { allUrls: true, scheme: "*", host: "*", port: undefined, path: "/*" };
  }
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return null;
  const scheme = m[1]!;
  const hostPort = m[2]!;
  const path = m[3]!;
  if (scheme !== "*" && !(SCHEMES as readonly string[]).includes(scheme)) return null;
  if (scheme === "file") {
    if (hostPort !== "") return null;
    return { allUrls: false, scheme, host: "", port: undefined, path };
  }
  if (hostPort === "") return null;
  let host = hostPort;
  let port: string | undefined;
  const portMatch = /^(.*):(\*|\d{1,5})$/.exec(hostPort);
  if (portMatch) {
    host = portMatch[1]!;
    port = portMatch[2]!;
    if (port !== "*" && Number(port) > 65535) return null;
  }
  if (host !== "*") {
    const bare = host.startsWith("*.") ? host.slice(2) : host;
    if (bare.includes("*")) return null;
    // IPv6 literals are allowed in brackets.
    if (!/^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.?)$/.test(bare)) return null;
  }
  return { allUrls: false, scheme, host: host.toLowerCase(), port, path };
}

export function isValidMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null;
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (const ch of glob) {
    re += ch === "*" ? ".*" : ch.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }
  return new RegExp(re + "$", "s");
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };

export function urlMatchesPattern(url: string, pattern: ParsedPattern): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (pattern.allUrls) return ALL_URLS_SCHEMES.has(scheme);
  if (pattern.scheme === "*") {
    if (!["http", "https", "ws", "wss"].includes(scheme)) return false;
  } else if (pattern.scheme !== scheme) {
    return false;
  }
  if (scheme !== "file") {
    const host = u.hostname.toLowerCase();
    if (pattern.host !== "*") {
      if (pattern.host.startsWith("*.")) {
        const base = pattern.host.slice(2);
        if (host !== base && !host.endsWith("." + base)) return false;
      } else if (host !== pattern.host) {
        return false;
      }
    }
    if (pattern.port !== undefined && pattern.port !== "*") {
      const port = u.port || DEFAULT_PORTS[scheme] || "";
      if (port !== pattern.port) return false;
    }
  }
  // Chrome matches the path (including the query string) against the glob.
  return globToRegExp(pattern.path).test(u.pathname + u.search);
}

/** true iff `url` matches any of `matches` and none of `excludes`. */
export function urlAllowedBy(url: string, matches: readonly string[], excludes: readonly string[]): boolean {
  const test = (p: string) => {
    const parsed = parseMatchPattern(p);
    return parsed !== null && urlMatchesPattern(url, parsed);
  };
  return matches.some(test) && !excludes.some(test);
}
