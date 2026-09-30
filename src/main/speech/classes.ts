// SpeechRecognition-compatible classes for the MAIN world.
//
// Internal state lives in #private fields (unreachable from page scripts).
// Events are dispatched as untrusted events (isTrusted === false) - that is
// unavoidable for script-created events and documented in the README.
//
// The recognition itself happens in the extension's offscreen document; this
// file only keeps per-instance state and turns messages into DOM events.

import type { SpeechErrorCode, SpeechSessionEvent, SpeechUpFromMain } from "../../shared/protocol";
import { SPEECH_ERROR_CODES } from "../../shared/protocol";
import { NativeDOMException, NativeTypeError, dispatch, freeze, markNative } from "../natives";

export interface SpeechTransport {
  post(msg: SpeechUpFromMain): void;
}

/** Guards constructors that pages must not call ("Illegal constructor"). */
const INTERNAL = Symbol("internal");

function illegal(): never {
  throw new NativeTypeError("Illegal constructor");
}

function defineIndexed(target: object, items: readonly unknown[]): void {
  for (let i = 0; i < items.length; i++) {
    Object.defineProperty(target, i, { value: items[i], writable: false, enumerable: true, configurable: true });
  }
}

// ---- result objects -------------------------------------------------------------

export class SpeechRecognitionAlternative {
  readonly #transcript: string;
  readonly #confidence: number;
  constructor(token?: unknown, transcript = "", confidence = 0) {
    if (token !== INTERNAL) illegal();
    this.#transcript = transcript;
    this.#confidence = confidence;
  }
  get transcript(): string {
    return this.#transcript;
  }
  get confidence(): number {
    return this.#confidence;
  }
}

export class SpeechRecognitionResult {
  readonly #items: readonly SpeechRecognitionAlternative[];
  readonly #isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
  constructor(token?: unknown, items: readonly SpeechRecognitionAlternative[] = [], isFinal = true) {
    if (token !== INTERNAL) illegal();
    this.#items = freeze([...items]);
    this.#isFinal = isFinal;
    defineIndexed(this, this.#items);
  }
  get length(): number {
    return this.#items.length;
  }
  get isFinal(): boolean {
    return this.#isFinal;
  }
  item(index: number): SpeechRecognitionAlternative | null {
    return this.#items[index >>> 0] ?? null;
  }
}

export class SpeechRecognitionResultList {
  readonly #items: readonly SpeechRecognitionResult[];
  [index: number]: SpeechRecognitionResult;
  constructor(token?: unknown, items: readonly SpeechRecognitionResult[] = []) {
    if (token !== INTERNAL) illegal();
    this.#items = freeze([...items]);
    defineIndexed(this, this.#items);
  }
  get length(): number {
    return this.#items.length;
  }
  item(index: number): SpeechRecognitionResult | null {
    return this.#items[index >>> 0] ?? null;
  }
}

// WebIDL: indexed getter + integer length => @@iterator is Array.prototype.values.
for (const C of [SpeechRecognitionResult, SpeechRecognitionResultList]) {
  Object.defineProperty(C.prototype, Symbol.iterator, {
    value: Array.prototype.values,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

// ---- grammars (stubs: Chrome ignores grammars as well) ----------------------------

export class SpeechGrammar {
  #src = "";
  #weight = 1;
  get src(): string {
    return this.#src;
  }
  set src(v: string) {
    this.#src = `${v}`;
  }
  get weight(): number {
    return this.#weight;
  }
  set weight(v: number) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new NativeTypeError("The provided float value is non-finite.");
    this.#weight = n;
  }
}

export class SpeechGrammarList {
  readonly #items: SpeechGrammar[] = [];
  [index: number]: SpeechGrammar;
  get length(): number {
    return this.#items.length;
  }
  item(index: number): SpeechGrammar | null {
    return this.#items[index >>> 0] ?? null;
  }
  addFromURI(src: string, weight: number = 1): void {
    this.#add(`${src}`, weight);
  }
  addFromString(string: string, weight: number = 1): void {
    this.#add(`${string}`, weight);
  }
  #add(src: string, weight: number): void {
    const g = new SpeechGrammar();
    g.src = src;
    g.weight = weight;
    this.#items.push(g);
    defineIndexed(this, this.#items);
  }
}

// ---- events -----------------------------------------------------------------------

let internalEventConstruction = false;

export interface SpeechRecognitionEventInit extends EventInit {
  resultIndex?: number;
  results?: SpeechRecognitionResultList | null;
}

export class SpeechRecognitionEvent extends Event {
  readonly #resultIndex: number;
  readonly #results: SpeechRecognitionResultList | null;
  constructor(type: string, eventInitDict?: SpeechRecognitionEventInit) {
    if (arguments.length < 2 && !internalEventConstruction) {
      throw new NativeTypeError(
        `Failed to construct 'SpeechRecognitionEvent': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    const init = eventInitDict ?? {};
    const results = init.results ?? null;
    if (!internalEventConstruction && !(results instanceof SpeechRecognitionResultList)) {
      throw new NativeTypeError(
        "Failed to construct 'SpeechRecognitionEvent': required member results is undefined.",
      );
    }
    super(type, init);
    this.#resultIndex = (init.resultIndex ?? 0) >>> 0;
    this.#results = results;
  }
  get resultIndex(): number {
    return this.#resultIndex;
  }
  get results(): SpeechRecognitionResultList | null {
    return this.#results;
  }
}

export interface SpeechRecognitionErrorEventInit extends EventInit {
  error: SpeechErrorCode;
  message?: string;
}

export class SpeechRecognitionErrorEvent extends Event {
  readonly #error: SpeechErrorCode;
  readonly #message: string;
  constructor(type: string, eventInitDict: SpeechRecognitionErrorEventInit) {
    if (arguments.length < 2) {
      throw new NativeTypeError(
        `Failed to construct 'SpeechRecognitionErrorEvent': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    const error = eventInitDict?.error;
    if (!(SPEECH_ERROR_CODES as readonly string[]).includes(error as string)) {
      throw new NativeTypeError(
        `Failed to construct 'SpeechRecognitionErrorEvent': The provided value '${String(error)}' is not a valid enum value of type SpeechRecognitionErrorCode.`,
      );
    }
    super(`${type}`, eventInitDict);
    this.#error = error;
    this.#message = eventInitDict.message === undefined ? "" : `${eventInitDict.message}`;
  }
  get error(): SpeechErrorCode {
    return this.#error;
  }
  get message(): string {
    return this.#message;
  }
}

// ---- SpeechRecognition -------------------------------------------------------------

const HANDLER_TYPES = [
  "audiostart",
  "soundstart",
  "speechstart",
  "speechend",
  "soundend",
  "audioend",
  "result",
  "nomatch",
  "error",
  "start",
  "end",
] as const;
type HandlerType = (typeof HANDLER_TYPES)[number];
type Handler = ((this: SpeechRecognition, ev: Event) => unknown) | null;

type State = "idle" | "started" | "stopping";

interface Runtime {
  transport: SpeechTransport | null;
  nextSid: number;
  sessions: Map<number, SpeechRecognition>;
  /** Called while a session is waiting for the extension; returns a cancel fn. */
  watchdog(fn: () => void, ms: number): () => void;
}

const runtime: Runtime = {
  transport: null,
  nextSid: 1,
  sessions: new Map(),
  watchdog: () => () => {},
};

let deliverToInstance: (inst: SpeechRecognition, msg: SpeechSessionEvent) => void;
let failInstance: (inst: SpeechRecognition, error: SpeechErrorCode, message: string) => void;

/** How long start() may wait for the extension to answer before failing with "network". */
const START_WATCHDOG_MS = 15_000;

export class SpeechRecognition extends EventTarget {
  #grammars = new SpeechGrammarList();
  #lang = "";
  #continuous = false;
  #interimResults = false;
  #maxAlternatives = 1;
  #handlers = new Map<HandlerType, { value: Handler; listener: (ev: Event) => void }>();
  #state: State = "idle";
  #sid = 0;
  #results: SpeechRecognitionResult[] = [];
  #cancelWatchdog: (() => void) | null = null;

  static {
    deliverToInstance = (inst, msg) => inst.#deliver(msg);
    failInstance = (inst, error, message) => inst.#fail(error, message);
  }

  get grammars(): SpeechGrammarList {
    return this.#grammars;
  }
  set grammars(v: SpeechGrammarList) {
    if (!(v instanceof SpeechGrammarList)) {
      throw new NativeTypeError(
        "Failed to set the 'grammars' property on 'SpeechRecognition': Failed to convert value to 'SpeechGrammarList'.",
      );
    }
    this.#grammars = v;
  }
  get lang(): string {
    return this.#lang;
  }
  set lang(v: string) {
    this.#lang = `${v}`;
  }
  get continuous(): boolean {
    return this.#continuous;
  }
  set continuous(v: boolean) {
    this.#continuous = !!v;
  }
  get interimResults(): boolean {
    return this.#interimResults;
  }
  set interimResults(v: boolean) {
    // Accepted for compatibility; Whisper only produces final results.
    this.#interimResults = !!v;
  }
  get maxAlternatives(): number {
    return this.#maxAlternatives;
  }
  set maxAlternatives(v: number) {
    this.#maxAlternatives = (v as number) >>> 0;
  }

  start(): void {
    if (this.#state !== "idle") {
      throw new NativeDOMException(
        "Failed to execute 'start' on 'SpeechRecognition': recognition has already started.",
        "InvalidStateError",
      );
    }
    this.#state = "started";
    this.#results = [];
    const sid = runtime.nextSid;
    runtime.nextSid = sid >= 0x7fffffff ? 1 : sid + 1;
    this.#sid = sid;
    runtime.sessions.set(sid, this);
    this.#cancelWatchdog = runtime.watchdog(() => {
      this.#cancelWatchdog = null;
      this.#fail("network", "The speech recognition extension did not respond.");
    }, START_WATCHDOG_MS);
    if (!runtime.transport) {
      runtime.watchdog(() => this.#fail("service-not-allowed", "Speech recognition bridge is unavailable."), 0);
      return;
    }
    runtime.transport.post({
      t: "start",
      sid,
      lang: this.#lang.slice(0, 256),
      continuous: this.#continuous,
      maxAlternatives: this.#maxAlternatives,
    });
  }

  stop(): void {
    if (this.#state !== "started") return;
    this.#state = "stopping";
    runtime.transport?.post({ t: "stop", sid: this.#sid });
  }

  abort(): void {
    if (this.#state !== "started") return;
    this.#state = "stopping";
    runtime.transport?.post({ t: "abort", sid: this.#sid });
  }

  #clearWatchdog(): void {
    if (this.#cancelWatchdog) {
      this.#cancelWatchdog();
      this.#cancelWatchdog = null;
    }
  }

  #deliver(msg: SpeechSessionEvent): void {
    if (this.#state === "idle" || msg.sid !== this.#sid) return;
    // Any answer from the extension proves it is alive.
    this.#clearWatchdog();
    switch (msg.t) {
      case "ev": {
        if (msg.type === "end") {
          this.#finish();
          return;
        }
        if (msg.type === "nomatch") {
          internalEventConstruction = true;
          try {
            dispatch(this, new SpeechRecognitionEvent("nomatch", { resultIndex: 0, results: null }));
          } finally {
            internalEventConstruction = false;
          }
          return;
        }
        dispatch(this, new Event(msg.type));
        return;
      }
      case "result": {
        const alternatives =
          this.#maxAlternatives >= 1 ? [new SpeechRecognitionAlternative(INTERNAL, msg.transcript, msg.confidence)] : [];
        this.#results.push(new SpeechRecognitionResult(INTERNAL, alternatives, true));
        const list = new SpeechRecognitionResultList(INTERNAL, this.#results);
        dispatch(this, new SpeechRecognitionEvent("result", { resultIndex: this.#results.length - 1, results: list }));
        return;
      }
      case "error":
        dispatch(this, new SpeechRecognitionErrorEvent("error", { error: msg.error, message: msg.message }));
        return;
    }
  }

  /** Local failure (bridge lost, watchdog): error then end, like Chrome's OnConnectionError. */
  #fail(error: SpeechErrorCode, message: string): void {
    if (this.#state === "idle") return;
    this.#clearWatchdog();
    dispatch(this, new SpeechRecognitionErrorEvent("error", { error, message }));
    this.#finish();
  }

  #finish(): void {
    if (this.#state === "idle") return;
    this.#clearWatchdog();
    runtime.sessions.delete(this.#sid);
    // Like Chrome, the object can be restarted from within the end handler.
    this.#state = "idle";
    dispatch(this, new Event("end"));
  }

  /** EventHandler IDL attribute helpers. */
  static getHandler(inst: SpeechRecognition, type: HandlerType): Handler {
    return inst.#handlers.get(type)?.value ?? null;
  }
  static setHandler(inst: SpeechRecognition, type: HandlerType, value: unknown): void {
    const handler = typeof value === "function" || (typeof value === "object" && value !== null) ? (value as Handler) : null;
    const existing = inst.#handlers.get(type);
    if (handler === null) {
      if (existing) {
        inst.removeEventListener(type, existing.listener);
        inst.#handlers.delete(type);
      }
      return;
    }
    if (existing) {
      existing.value = handler;
      return;
    }
    const entry = {
      value: handler,
      listener: (ev: Event) => {
        const h = entry.value;
        if (typeof h === "function") h.call(inst, ev);
      },
    };
    inst.#handlers.set(type, entry);
    inst.addEventListener(type, entry.listener);
  }
}

// on* accessors on the prototype, like WebIDL event handler attributes.
for (const type of HANDLER_TYPES) {
  const name = `on${type}`;
  const get = {
    [`get ${name}`](this: SpeechRecognition) {
      if (!(this instanceof SpeechRecognition)) throw new NativeTypeError("Illegal invocation");
      return SpeechRecognition.getHandler(this, type);
    },
  }[`get ${name}`]!;
  const set = {
    [`set ${name}`](this: SpeechRecognition, v: unknown) {
      if (!(this instanceof SpeechRecognition)) throw new NativeTypeError("Illegal invocation");
      SpeechRecognition.setHandler(this, type, v);
    },
  }[`set ${name}`]!;
  markNative(get, `get ${name}`);
  markNative(set, `set ${name}`);
  Object.defineProperty(SpeechRecognition.prototype, name, { get, set, enumerable: true, configurable: true });
}

// Hide helper statics from pages.
delete (SpeechRecognition as unknown as Record<string, unknown>).getHandler;
delete (SpeechRecognition as unknown as Record<string, unknown>).setHandler;

// ---- wiring -------------------------------------------------------------------------

export function configureSpeechRuntime(transport: SpeechTransport, watchdog: Runtime["watchdog"]): void {
  runtime.transport = transport;
  runtime.watchdog = watchdog;
}

/** Routes a validated message from the extension to its instance. */
export function deliverSpeechMessage(msg: SpeechSessionEvent): void {
  const inst = runtime.sessions.get(msg.sid);
  if (inst) deliverToInstance(inst, msg);
}

/** The extension connection was lost: every running session fails with "network". */
export function failAllSessions(message: string): void {
  for (const inst of [...runtime.sessions.values()]) failInstance(inst, "network", message);
}

export const EXPORTED_CLASSES = {
  SpeechRecognition,
  SpeechRecognitionEvent,
  SpeechRecognitionErrorEvent,
  SpeechRecognitionResult,
  SpeechRecognitionResultList,
  SpeechRecognitionAlternative,
  SpeechGrammar,
  SpeechGrammarList,
};
