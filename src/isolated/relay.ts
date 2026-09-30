// ISOLATED world, document_start. Pure relay between the MAIN world (private
// MessagePort, see src/main/bridge.ts) and the offscreen document
// (chrome.runtime.Port). Built twice: once per channel (__CHANNEL__).
//
// Everything from the MAIN world is untrusted (page scripts share it), so
// messages are validated here and only well-formed ones are forwarded. This
// world never touches the API key or audio.

import {
  PORT_NAME_PREFIX,
  isChannel,
  isOffscreenHello,
  isSpeechDownFromOffscreen,
  isSpeechUpFromMain,
  isTimerDown,
  isTimerUp,
  type Channel,
  type SpeechUpToOffscreen,
} from "../shared/protocol";

const CHANNEL = __CHANNEL__ as Channel;
if (!isChannel(CHANNEL)) throw new Error("bad channel");

const LOG_PREFIX = "[Unthrottled Timers & Whisper STT]";
const RETRY_DELAYS_MS = [100, 400, 1600, 5000];
const MAX_OUTBOX = 64;

let mainPort: MessagePort | null = null;
let extPort: chrome.runtime.Port | null = null;
/** Set once the offscreen document said hello on the current port. */
let established = false;
let connecting = false;
let attempt = 0;
let dead = false;
let outbox: unknown[] = [];

function toMain(msg: unknown): void {
  mainPort?.postMessage(msg);
}

// ---- MAIN handshake -------------------------------------------------------------

function isHandshake(d: unknown, kind: string): boolean {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return o.magic === __MAGIC__ && o.kind === kind && o.channel === CHANNEL;
}

window.addEventListener(
  "message",
  (ev: MessageEvent) => {
    if (ev.source !== window || !isHandshake(ev.data, "hello")) return;
    // Hide our handshake from page listeners registered after us.
    ev.stopImmediatePropagation();
    const port = ev.ports[0];
    if (!port) return;
    if (mainPort) {
      // Only the first HELLO per frame and channel is accepted.
      port.close();
      return;
    }
    mainPort = port;
    port.onmessage = (e) => onMainMessage(e.data);
    port.postMessage({ t: "ack" });
  },
  true,
);
// In case MAIN ran first and its HELLO was dispatched before we listened.
window.postMessage({ magic: __MAGIC__, kind: "ready", channel: CHANNEL }, "*");

// ---- MAIN -> extension ---------------------------------------------------------------

function micAllowedByPermissionsPolicy(): boolean {
  const d = document as unknown as {
    featurePolicy?: { allowsFeature?: (f: string) => boolean };
    permissionsPolicy?: { allowsFeature?: (f: string) => boolean };
  };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  if (policy && typeof policy.allowsFeature === "function") {
    try {
      return policy.allowsFeature("microphone");
    } catch {
      return true;
    }
  }
  return true;
}

function onMainMessage(data: unknown): void {
  if (dead) return;
  if (CHANNEL === "timers") {
    if (!isTimerUp(data)) return;
    if (data.t === "disarm" && !extPort) return;
    // Only the latest arm matters.
    outbox = outbox.filter((m) => !isTimerUp(m));
    send(data);
    return;
  }
  if (!isSpeechUpFromMain(data)) return;
  if (data.t === "start") {
    if (!micAllowedByPermissionsPolicy()) {
      toMain({ t: "error", sid: data.sid, error: "not-allowed", message: "Permissions policy disallows microphone in this frame." });
      toMain({ t: "ev", sid: data.sid, type: "end" });
      return;
    }
    const msg: SpeechUpToOffscreen = {
      t: "start",
      sid: data.sid,
      lang: data.lang,
      continuous: data.continuous,
      maxAlternatives: data.maxAlternatives,
      documentLang: (document.documentElement?.lang ?? "").slice(0, 64),
      navigatorLang: (navigator.language ?? "").slice(0, 64),
    };
    send(msg);
    return;
  }
  send(data);
}

function send(msg: unknown): void {
  if (extPort && established) {
    try {
      extPort.postMessage(msg);
      return;
    } catch {
      extPort = null;
      established = false;
    }
  }
  if (outbox.length < MAX_OUTBOX) outbox.push(msg);
  connect();
}

// ---- extension connection -------------------------------------------------------

function contextAlive(): boolean {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

let warned = false;
function giveUp(reason: string): void {
  outbox = [];
  if (!warned) {
    warned = true;
    console.warn(`${LOG_PREFIX} ${CHANNEL}: extension unavailable (${reason}).`);
  }
  // Timers keep working with native wake-ups (and retry on the next arm);
  // running recognitions must be failed.
  if (CHANNEL === "speech") toMain({ t: "reset" });
}

async function connect(): Promise<void> {
  if (connecting || extPort || dead) return;
  if (!contextAlive()) {
    dead = true;
    giveUp("extension context invalidated; reload the page");
    return;
  }
  connecting = true;
  try {
    // Wakes the service worker, which (re)creates the offscreen document.
    await chrome.runtime.sendMessage({ t: "ensure-offscreen" });
    const port = chrome.runtime.connect({ name: PORT_NAME_PREFIX + CHANNEL });
    extPort = port;
    established = false;
    port.onMessage.addListener((msg: unknown) => onExtMessage(port, msg));
    port.onDisconnect.addListener(() => onExtDisconnect(port));
  } catch (e) {
    extPort = null;
    if (!contextAlive()) {
      dead = true;
      giveUp("extension context invalidated; reload the page");
    } else {
      scheduleRetry(String((e as Error)?.message ?? e));
    }
  } finally {
    connecting = false;
  }
}

function scheduleRetry(reason: string): void {
  if (attempt >= RETRY_DELAYS_MS.length) {
    attempt = 0;
    giveUp(reason);
    return;
  }
  const delay = RETRY_DELAYS_MS[attempt++]!;
  setTimeout(() => {
    if (outbox.length) void connect();
  }, delay);
}

function onExtMessage(port: chrome.runtime.Port, msg: unknown): void {
  if (port !== extPort) return;
  if (isOffscreenHello(msg)) {
    established = true;
    attempt = 0;
    const pending = outbox;
    outbox = [];
    for (const m of pending) port.postMessage(m);
    return;
  }
  if (CHANNEL === "timers") {
    if (isTimerDown(msg) && (msg.t === "wake" || msg.t === "reset")) toMain(msg);
    return;
  }
  if (!isSpeechDownFromOffscreen(msg)) return;
  if (msg.t === "log") {
    // Logged from the ISOLATED world so page scripts cannot hook it.
    (msg.level === "warn" ? console.warn : console.info)(`${LOG_PREFIX} ${msg.message}`);
    return;
  }
  toMain(msg);
}

function onExtDisconnect(port: chrome.runtime.Port): void {
  // Reading lastError marks it as handled.
  void chrome.runtime.lastError;
  if (port !== extPort) return;
  const wasEstablished = established;
  extPort = null;
  established = false;
  if (wasEstablished) {
    // Offscreen document closed/recreated or the page entered the bfcache:
    // the MAIN side re-arms timers / fails running recognitions.
    toMain({ t: "reset" });
  } else {
    // Connected before the offscreen document listened; retry with what is queued.
    scheduleRetry("offscreen document not reachable");
  }
}

window.addEventListener(
  "pageshow",
  (ev) => {
    if ((ev as PageTransitionEvent).persisted) toMain({ t: "reset" });
  },
  true,
);
