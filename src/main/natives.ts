// Native functions captured at document_start, before any page script runs.
// Everything the MAIN-world code needs later is called through these
// references, so page scripts that later overwrite globals or prototype
// methods can neither break us nor intercept our private MessagePorts.
//
// This is a best-effort defense: a page can still observe us in other ways
// (see README "検出可能性"). Nothing secret (API key, raw audio) ever lives in
// the MAIN world, so leaking a port would only give the page what the public
// API already gives it.

const R = Reflect;
const O = Object;
const w = window;

function getter(proto: object, name: string): (this: unknown) => unknown {
  const d = O.getOwnPropertyDescriptor(proto, name);
  if (!d || !d.get) throw new Error(`missing getter ${name}`);
  return d.get;
}
function setter(proto: object, name: string): (this: unknown, v: unknown) => void {
  const d = O.getOwnPropertyDescriptor(proto, name);
  if (!d || !d.set) throw new Error(`missing setter ${name}`);
  return d.set;
}

export const apply = R.apply;
export const defineProperty = O.defineProperty;
export const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
export const freeze = O.freeze;
export const hasOwn = O.hasOwn;

export const nativeSetTimeout = w.setTimeout;
export const nativeClearTimeout = w.clearTimeout;
export const nativeEval = w.eval;
export const NativeFunction = w.Function;
export const nativeReportError: ((e: unknown) => void) | undefined = w.reportError;
export const nativeQueueMicrotask = w.queueMicrotask;
export const nativePostMessage = w.postMessage;
export const NativeMessageChannel = w.MessageChannel;
export const NativeWeakMap = w.WeakMap;
export const NativeMap = w.Map;
export const NativeDOMException = w.DOMException;
export const NativeTypeError = w.TypeError;
export const NativeEvalError = w.EvalError;
export const NativeEvent = w.Event;
export const NativeEventTarget = w.EventTarget;

const performanceNow = w.Performance.prototype.now;
const perf = w.performance;
export function now(): number {
  return apply(performanceNow, perf, []) as number;
}

const portPostMessage = w.MessagePort.prototype.postMessage;
const portClose = w.MessagePort.prototype.close;
const portSetOnMessage = setter(w.MessagePort.prototype, "onmessage");
export function portPost(port: MessagePort, msg: unknown): void {
  apply(portPostMessage, port, [msg]);
}
export function portCloseSafe(port: MessagePort): void {
  apply(portClose, port, []);
}
export function portOnMessage(port: MessagePort, fn: (ev: MessageEvent) => void): void {
  apply(portSetOnMessage, port, [fn]);
}

const messageEventData = getter(w.MessageEvent.prototype, "data");
const messageEventSource = getter(w.MessageEvent.prototype, "source");
export function eventData(ev: MessageEvent): unknown {
  return apply(messageEventData, ev, []);
}
export function eventSource(ev: MessageEvent): unknown {
  return apply(messageEventSource, ev, []);
}

const addEventListener = w.EventTarget.prototype.addEventListener;
const removeEventListener = w.EventTarget.prototype.removeEventListener;
const dispatchEvent = w.EventTarget.prototype.dispatchEvent;
export function listen(target: EventTarget, type: string, fn: (ev: Event) => void, capture: boolean): void {
  apply(addEventListener, target, [type, fn, capture]);
}
export function unlisten(target: EventTarget, type: string, fn: (ev: Event) => void, capture: boolean): void {
  apply(removeEventListener, target, [type, fn, capture]);
}
export function dispatch(target: EventTarget, ev: Event): boolean {
  return apply(dispatchEvent, target, [ev]) as boolean;
}
export { addEventListener as nativeAddEventListener, removeEventListener as nativeRemoveEventListener };

const stopImmediatePropagation = w.Event.prototype.stopImmediatePropagation;
export function stopEvent(ev: Event): void {
  apply(stopImmediatePropagation, ev, []);
}

const visibilityStateGetter = getter(w.Document.prototype, "visibilityState");
const doc = w.document;
export function isDocumentHidden(): boolean {
  return apply(visibilityStateGetter, doc, []) === "hidden";
}

const weakMapGet = w.WeakMap.prototype.get;
const weakMapSet = w.WeakMap.prototype.set;

export function reportError(e: unknown): void {
  if (nativeReportError) {
    apply(nativeReportError, w, [e]);
  } else {
    // Rethrow asynchronously so it surfaces as an uncaught error.
    apply(nativeQueueMicrotask, w, [
      () => {
        throw e;
      },
    ]);
  }
}

// ---- Function.prototype.toString masking (best effort) ------------------------

const fakeSources = new NativeWeakMap<object, string>();
let toStringPatched = false;

/** Makes `fn.toString()` look like a native function. */
export function markNative(fn: object, name: string): void {
  apply(weakMapSet, fakeSources, [fn, `function ${name}() { [native code] }`]);
  if (toStringPatched) return;
  toStringPatched = true;
  const desc = getOwnPropertyDescriptor(w.Function.prototype, "toString");
  if (!desc || typeof desc.value !== "function") return;
  const original = desc.value as (this: unknown) => string;
  const proxy = new Proxy(original, {
    apply(target, thisArg, args) {
      const fake = apply(weakMapGet, fakeSources, [thisArg]) as string | undefined;
      return fake !== undefined ? fake : apply(target, thisArg, args);
    },
  });
  defineProperty(w.Function.prototype, "toString", { ...desc, value: proxy });
}

/** Sets name/length like a WebIDL operation and masks toString. */
export function shapeFunction(fn: object, name: string, length: number): void {
  defineProperty(fn, "name", { value: name, writable: false, enumerable: false, configurable: true });
  defineProperty(fn, "length", { value: length, writable: false, enumerable: false, configurable: true });
  markNative(fn, name);
}
