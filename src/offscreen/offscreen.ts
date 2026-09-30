// Offscreen document (extension origin, not affected by any page CSP).
// Hosts the timer worker and the speech-to-text pipeline. Only chrome.runtime
// is available here; settings and the API key are fetched from the service
// worker per recognition session and never cached.

import { PORT_NAME_PREFIX } from "../shared/protocol";
import { TimerHost } from "./timer-host";
import { AudioHub } from "./stt/hub";
import { SpeechManager, type OffscreenConfig } from "./stt/manager";

const timerHost = new TimerHost(chrome.runtime.getURL("timer-worker.js"));

const hub = new AudioHub({
  assetBase: chrome.runtime.getURL("vad/"),
  onMicState: (active) => {
    chrome.runtime.sendMessage({ t: "mic-state", active }).catch(() => {});
  },
});

const speech = new SpeechManager({
  hub,
  groqBase: __GROQ_BASE__,
  async getConfig() {
    const r = (await chrome.runtime.sendMessage({ t: "get-config" })) as ({ ok: true } & OffscreenConfig) | { ok: false };
    if (!r || !r.ok) throw new Error("config unavailable");
    return r;
  },
  async micPermission() {
    try {
      return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
    } catch {
      return "unknown";
    }
  },
});

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  // Only our own content scripts (which always run in a tab).
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || typeof sender.frameId !== "number") {
    port.disconnect();
    return;
  }
  if (port.name === PORT_NAME_PREFIX + "timers") timerHost.attach(port);
  else if (port.name === PORT_NAME_PREFIX + "speech") speech.attach(port, sender);
  else {
    port.disconnect();
    return;
  }
  port.postMessage({ t: "hello" });
});
