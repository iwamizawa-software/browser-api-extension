// Local HTTP servers for E2E: a site with a very strict CSP, and a mock of
// Groq's OpenAI-compatible API.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const STRICT_CSP =
  "default-src 'none'; script-src 'self'; worker-src 'none'; connect-src 'none'; style-src 'none'; img-src 'none'; media-src 'none'; frame-src 'self'; child-src 'none'; object-src 'none'; base-uri 'none'";

export interface Served {
  url: string;
  close(): Promise<void>;
}

export async function serveSite(files: Record<string, { type: string; body: string; csp?: boolean }>): Promise<Served> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const f = files[path];
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = { "content-type": f.type, "cache-control": "no-store" };
    if (f.csp !== false) headers["content-security-policy"] = STRICT_CSP;
    res.writeHead(200, headers).end(f.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface MockRequest {
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

export async function serveMockGroq(
  port: number,
  respond: (req: MockRequest) => { status: number; json: unknown; headers?: Record<string, string> },
): Promise<Served & { requests: MockRequest[] }> {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r: MockRequest = {
        path: new URL(req.url ?? "/", "http://x").pathname,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      };
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      requests.push(r);
      const out = respond(r);
      res.writeHead(out.status, { "content-type": "application/json", ...cors, ...(out.headers ?? {}) }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
