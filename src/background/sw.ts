// Service worker. Deliberately stateless: it may be stopped at any time
// (e.g. after 30s idle) and everything still works, because
//  * content script registrations persist on their own,
//  * the offscreen document is (re)created on demand by `ensure-offscreen`,
//  * settings / API key are read from storage on every request.
//
// It must NOT listen to runtime.onConnect: content-script Ports are meant for
// the offscreen document only.

import { applyRegistrations } from "./registration";
import { STORAGE_KEYS, sanitizeSettings } from "../shared/settings";
import type { RuntimeRequest } from "../shared/protocol";

const OFFSCREEN_PATH = "offscreen.html";
const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

// ---- offscreen document ---------------------------------------------------------

let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.USER_MEDIA],
        justification:
          "Runs an unthrottled timer worker for background tabs, and captures the microphone for voice activity detection and speech-to-text.",
      })
      .catch(async (e: unknown) => {
        // Lost a race with another creation (e.g. SW restarted mid-create).
        if (!(await hasOffscreenDocument())) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

// ---- registrations ------------------------------------------------------------------

let syncChain: Promise<unknown> = Promise.resolve();

function syncRegistrations(): Promise<unknown> {
  syncChain = syncChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const status = await applyRegistrations(sanitizeSettings(stored[STORAGE_KEYS.settings]));
      await chrome.storage.local.set({ [STORAGE_KEYS.registrationStatus]: status });
      if (!status.ok) console.error("content script registration failed:", status.error);
    });
  return syncChain;
}

async function restrictStorageToTrustedContexts(): Promise<void> {
  // Content scripts never need storage; keep the API key away from them even
  // if a renderer is compromised. Older Chrome versions only support this for
  // storage.session, hence the catch.
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_CONTEXTS });
  } catch (e) {
    console.warn("storage.local.setAccessLevel not supported:", (e as Error)?.message ?? e);
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void restrictStorageToTrustedContexts();
  void syncRegistrations();
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    void chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void restrictStorageToTrustedContexts();
  void syncRegistrations();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && STORAGE_KEYS.settings in changes) void syncRegistrations();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

// ---- messages -------------------------------------------------------------------------

function isFromOffscreen(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === offscreenUrl;
}

async function handle(msg: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.t) {
    case "ensure-offscreen":
      // Any of our content scripts may ask; creating the document is harmless.
      await ensureOffscreen();
      return { ok: true };
    case "get-config": {
      // The API key is only ever handed to the offscreen document.
      if (!isFromOffscreen(sender)) throw new Error("forbidden");
      const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.apiKey]);
      const apiKey = stored[STORAGE_KEYS.apiKey];
      return {
        ok: true,
        settings: sanitizeSettings(stored[STORAGE_KEYS.settings]),
        apiKey: typeof apiKey === "string" ? apiKey : "",
        setupUrl: chrome.runtime.getURL("setup.html"),
      };
    }
    case "mic-state": {
      if (!isFromOffscreen(sender)) throw new Error("forbidden");
      // Visible indicator: any allow-listed site can start recognition
      // without a per-site prompt, so show when the microphone is live.
      await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
      await chrome.action.setBadgeText({ text: msg.active ? "MIC" : "" });
      await chrome.action.setTitle({
        title: msg.active
          ? "Microphone in use for speech recognition (click for setup)"
          : "Unthrottled Timers & Whisper SpeechRecognition (open setup)",
      });
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (typeof msg !== "object" || msg === null) return false;
  const t = (msg as { t?: unknown }).t;
  if (t !== "ensure-offscreen" && t !== "get-config" && t !== "mic-state") return false;
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg as RuntimeRequest, sender).then(
    (r) => sendResponse(r),
    (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
  );
  return true;
});
