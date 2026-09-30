// MAIN-world side of the private MAIN <-> ISOLATED channel.
//
// At document_start (before page scripts run) we create a MessageChannel and
// transfer one end to the ISOLATED world with window.postMessage. Afterwards
// all traffic uses the private port, which page scripts cannot reach.
//
// The handshake does not depend on which world's script runs first:
//  * MAIN posts HELLO(port) immediately.
//  * ISOLATED posts READY once when it starts; if MAIN sees READY before it was
//    acknowledged, it sends another HELLO with a fresh channel.
//  * ISOLATED accepts only the first HELLO per channel, closes the rest, and
//    ACKs over the accepted port. MAIN adopts the first port that is ACKed and
//    closes the others.
// Both sides stop propagation of handshake messages, and their capturing
// window listeners are registered before any page listener can be, so page
// scripts normally never see them.

import type { Channel, HelloMessage } from "../shared/protocol";
import {
  NativeMessageChannel,
  apply,
  eventData,
  eventSource,
  hasOwn,
  listen,
  nativePostMessage,
  portCloseSafe,
  portOnMessage,
  portPost,
  stopEvent,
  unlisten,
} from "./natives";

export interface MainBridge {
  readonly ready: boolean;
  /** Queued until the handshake completes. */
  post(msg: unknown): void;
}

const MAX_QUEUE = 256;

function isOurs(d: unknown, kind: string, channel: Channel): boolean {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  // Own-property reads only: structured clones have no inherited props, and
  // this avoids consulting (possibly page-polluted) Object.prototype.
  return (
    hasOwn(o, "magic") &&
    o.magic === __MAGIC__ &&
    o.kind === kind &&
    o.channel === channel
  );
}

export function connectBridge(channel: Channel, onMessage: (msg: unknown) => void): MainBridge {
  let active: MessagePort | null = null;
  const pending: MessagePort[] = [];
  const queue: unknown[] = [];
  const w = window;

  function adopt(port: MessagePort): void {
    active = port;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]!;
      if (p !== port) portCloseSafe(p);
    }
    pending.length = 0;
    unlisten(w, "message", onWindowMessage as (ev: Event) => void, true);
    for (let i = 0; i < queue.length; i++) portPost(port, queue[i]);
    queue.length = 0;
  }

  function sendHello(): void {
    const ch = new NativeMessageChannel();
    const port = ch.port1;
    portOnMessage(port, (ev) => {
      const data = eventData(ev);
      if (active === null) {
        if (typeof data === "object" && data !== null && (data as { t?: unknown }).t === "ack") {
          adopt(port);
          onMessage(data);
        }
        return;
      }
      if (active === port) onMessage(data);
    });
    pending[pending.length] = port;
    const hello: HelloMessage = { magic: __MAGIC__, kind: "hello", channel };
    apply(nativePostMessage, w, [hello, "*", [ch.port2]]);
  }

  function onWindowMessage(ev: MessageEvent): void {
    if (active !== null || eventSource(ev) !== w) return;
    const data = eventData(ev);
    if (!isOurs(data, "ready", channel)) return;
    stopEvent(ev);
    sendHello();
  }

  listen(w, "message", onWindowMessage as (ev: Event) => void, true);
  sendHello();

  return {
    get ready() {
      return active !== null;
    },
    post(msg: unknown) {
      if (active !== null) portPost(active, msg);
      else if (queue.length < MAX_QUEUE) queue[queue.length] = msg;
    },
  };
}
