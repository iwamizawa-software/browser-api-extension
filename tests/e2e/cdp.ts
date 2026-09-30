// Minimal raw Chrome DevTools Protocol harness. Used where Playwright's own
// page instrumentation changes the behaviour under test (Playwright keeps every
// page "visible", so background-tab throttling cannot be observed through it).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class RawBrowser {
  private id = 0;
  private pending = new Map<number, Pending>();

  private constructor(
    private readonly proc: ChildProcess,
    private readonly ws: WebSocket,
    private readonly userDataDir: string,
  ) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    };
  }

  static async launch(extensionDir: string, extraArgs: string[] = []): Promise<RawBrowser> {
    const userDataDir = await mkdtemp(join(tmpdir(), "bae-raw-"));
    const args = [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      ...extraArgs,
      "about:blank",
    ];
    if (process.env.HEADED !== "1") args.unshift("--headless=new");
    const proc = spawn(chromium.executablePath(), args, { stdio: "ignore" });
    let port: string | undefined;
    for (let i = 0; i < 200 && !port; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const f = join(userDataDir, "DevToolsActivePort");
      if (existsSync(f)) port = readFileSync(f, "utf8").split("\n")[0];
    }
    if (!port) throw new Error("chromium did not start");
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return new RawBrowser(proc, ws, userDataDir);
  }

  /** Attaches to the extension service worker and waits until it evaluates. */
  async attachServiceWorker(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = await this.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
      const session = await this.attach(id);
      await this.send("Runtime.runIfWaitingForDebugger", {}, session).catch(() => {});
      const ok = await this.send("Runtime.evaluate", { expression: "typeof chrome.storage", returnByValue: true }, session, 3_000)
        .then(() => true)
        .catch(() => false);
      if (ok) return session;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("service worker not responsive");
  }

  /**
   * Force-stops the extension service worker, like Chrome does after ~30s idle.
   * Uses an extension page's session (ServiceWorker domain is per origin).
   */
  async stopServiceWorker(extensionPageSession: string): Promise<void> {
    await this.send("ServiceWorker.enable", {}, extensionPageSession);
    await this.send("ServiceWorker.stopAllWorkers", {}, extensionPageSession);
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = await this.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
      if (!targetInfos.some((t) => t.type === "service_worker")) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("service worker did not stop");
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async attach(targetId: string): Promise<string> {
    const r = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    return r.sessionId;
  }

  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async waitForTarget(pred: (t: { type: string; url: string; targetId: string }) => boolean): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const { targetInfos } = await this.send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
      const t = targetInfos.find(pred);
      if (t) return t.targetId;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("target not found");
  }

  async newTab(url: string): Promise<string> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url });
    const session = await this.attach(targetId);
    for (let i = 0; i < 200; i++) {
      const state = await this.evaluate<string>(session, "document.readyState").catch(() => "");
      if (state === "complete") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return session;
  }

  async close(): Promise<void> {
    this.ws.close();
    this.proc.kill();
    await new Promise((r) => setTimeout(r, 200));
    await rm(this.userDataDir, { recursive: true, force: true });
  }
}
