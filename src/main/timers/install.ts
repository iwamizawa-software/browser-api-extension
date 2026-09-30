// Replaces window.setTimeout/setInterval/clearTimeout/clearInterval.
//
// Callbacks always run on the page's main thread. Two independent wake-up
// sources are kept armed for the earliest deadline only:
//   (a) the native setTimeout captured at document_start (precise while the
//       tab is visible), and
//   (b) while the document is hidden, a Dedicated Worker in the extension's
//       offscreen document (not subject to background-tab throttling), reached
//       via MAIN -> ISOLATED -> runtime.Port.
// Whichever arrives first runs due timers; the other one finds nothing due
// and just re-arms. Each wake runs at most one timer callback and continues
// through a private MessageChannel, so microtasks run between callbacks like
// they do between native timer tasks.

import type { MainBridge } from "../bridge";
import {
  NativeMessageChannel,
  NativeTypeError,
  NativeFunction,
  apply,
  defineProperty,
  getOwnPropertyDescriptor,
  isDocumentHidden,
  listen,
  nativeClearTimeout,
  nativeEval,
  nativeSetTimeout,
  now,
  portOnMessage,
  portPost,
  reportError,
  shapeFunction,
} from "../natives";
import { TimerScheduler } from "./scheduler";
import { toLong, toTimerHandler } from "./webidl";
import { isTimerDown } from "../../shared/protocol";

const ceil = Math.ceil;

export interface InstalledTimers {
  scheduler: TimerScheduler;
  onBridgeMessage(msg: unknown): void;
}

export function installTimers(getBridge: () => MainBridge | null): InstalledTimers {
  const w = window;

  function invoke(handler: unknown, args: readonly unknown[]): void {
    try {
      if (typeof handler === "function") apply(handler, w, args);
      // Indirect eval: global scope, and still subject to the page's CSP.
      else apply(nativeEval, w, [handler]);
    } catch (e) {
      reportError(e);
    }
  }

  let draining = false;
  let nativeArmed: { deadline: number; handle: number } | null = null;
  let workerArmed: { deadline: number; seq: number } | null = null;
  let workerSeq = 0;
  let continuationPending = false;

  const continuation = new NativeMessageChannel();
  portOnMessage(continuation.port1, () => {
    continuationPending = false;
    drain();
  });

  function postContinuation(): void {
    if (continuationPending) return;
    continuationPending = true;
    portPost(continuation.port2, 0);
  }

  function sync(): void {
    const d = scheduler.nextDeadline();
    if (d === null) {
      if (nativeArmed) {
        apply(nativeClearTimeout, w, [nativeArmed.handle]);
        nativeArmed = null;
      }
      return;
    }
    const diff = d - now();
    const delay = diff > 0 ? ceil(diff) : 0;
    const hidden = isDocumentHidden();
    if (delay === 0 && (draining || hidden)) {
      // Backlog inside a wake, or hidden tab: do not depend on native timers.
      postContinuation();
      return;
    }
    if (!nativeArmed || d < nativeArmed.deadline) {
      if (nativeArmed) apply(nativeClearTimeout, w, [nativeArmed.handle]);
      const handle = apply(nativeSetTimeout, w, [onNativeWake, delay]) as number;
      nativeArmed = { deadline: d, handle };
    }
    const bridge = getBridge();
    if (hidden && bridge && bridge.ready && (!workerArmed || d < workerArmed.deadline)) {
      workerSeq = workerSeq >= 0x7fffffff ? 1 : workerSeq + 1;
      workerArmed = { deadline: d, seq: workerSeq };
      bridge.post({ t: "arm", seq: workerSeq, delay });
    }
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      scheduler.runNextDue();
    } finally {
      draining = false;
    }
    sync();
  }

  function onNativeWake(): void {
    nativeArmed = null;
    drain();
  }

  const scheduler = new TimerScheduler({ now, invoke, onChange: () => draining || sync() });

  // Pages that go to the background need the worker path armed.
  listen(w, "visibilitychange", () => sync(), true);
  listen(w, "pageshow", () => {
    workerArmed = null;
    sync();
  }, true);

  function cspAllowsStringCompilation(): boolean {
    try {
      // Chrome checks (and reports) eval permission when a string handler is
      // scheduled and returns 0 if blocked; `new Function` hits the same check.
      new NativeFunction("");
      return true;
    } catch {
      return false;
    }
  }

  function create(name: string, argc: number, handlerArg: unknown, timeoutArg: unknown, rest: unknown[], repeat: boolean): number {
    if (argc < 1) {
      throw new NativeTypeError(`Failed to execute '${name}' on 'Window': 1 argument required, but only 0 present.`);
    }
    // Bindings convert all arguments before the operation runs.
    const handler = toTimerHandler(handlerArg);
    const timeout = toLong(timeoutArg);
    if (typeof handler === "string") {
      if (!cspAllowsStringCompilation()) return 0;
      if (handler === "") return 0;
    }
    return scheduler.add(handler, timeout, rest, repeat);
  }

  // Method shorthand -> not constructible, no `prototype`, like native operations.
  const api = {
    setTimeout(handler: unknown, timeout?: unknown, ...args: unknown[]): number {
      return create("setTimeout", arguments.length, handler, timeout, args, false);
    },
    setInterval(handler: unknown, timeout?: unknown, ...args: unknown[]): number {
      return create("setInterval", arguments.length, handler, timeout, args, true);
    },
    clearTimeout(id?: unknown): void {
      scheduler.clear(toLong(id));
    },
    clearInterval(id?: unknown): void {
      scheduler.clear(toLong(id));
    },
  };

  for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const) {
    const original = getOwnPropertyDescriptor(w, name);
    const fn = api[name];
    shapeFunction(fn, name, typeof original?.value === "function" ? (original.value as Function).length : name.startsWith("set") ? 1 : 0);
    defineProperty(w, name, {
      value: fn,
      writable: original?.writable ?? true,
      enumerable: original?.enumerable ?? true,
      configurable: original?.configurable ?? true,
    });
  }

  return {
    scheduler,
    onBridgeMessage(msg: unknown) {
      if (!isTimerDown(msg)) return;
      if (msg.t === "wake") {
        if (workerArmed && workerArmed.seq === msg.seq) workerArmed = null;
        drain();
      } else {
        // "ack" (bridge up) or "reset" (extension side reconnected): re-arm.
        workerArmed = null;
        sync();
      }
    },
  };
}
