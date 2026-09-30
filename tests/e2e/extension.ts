import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const EXTENSION_DIR = resolve(process.cwd(), "dist-e2e");

export interface Launched {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  close(): Promise<void>;
}

export async function launchWithExtension(extraArgs: string[] = []): Promise<Launched> {
  const userDataDir = await mkdtemp(join(tmpdir(), "bae-e2e-"));
  const headed = process.env.HEADED === "1";
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !headed,
    // Playwright disables background throttling by default; we need the real
    // behaviour to show that the replacement is not throttled.
    ignoreDefaultArgs: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      ...extraArgs,
    ],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = new URL(sw.url()).host;
  return {
    context,
    sw,
    extensionId,
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Writes settings (merged with defaults by the extension) and waits until registrations are applied. */
export async function configure(sw: Worker, settings: unknown, apiKey?: string): Promise<void> {
  await sw.evaluate(
    async ({ settings, apiKey }) => {
      await chrome.storage.local.remove("registrationStatus");
      const data: Record<string, unknown> = { settings };
      if (apiKey !== undefined) data.groqApiKey = apiKey;
      await chrome.storage.local.set(data);
      for (let i = 0; i < 100; i++) {
        const { registrationStatus } = await chrome.storage.local.get("registrationStatus");
        if (registrationStatus) {
          const status = registrationStatus as { ok: boolean; error?: string };
          if (!status.ok) throw new Error(status.error);
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("registration timeout");
    },
    { settings, apiKey },
  );
}
