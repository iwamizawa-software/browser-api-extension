// MAIN world, document_start: SpeechRecognition replacement.
//
// Always replaces the native (Chrome) implementation on the sites the user
// allow-listed. Only transcripts ever reach this world; the API key and the
// audio stay in the extension's offscreen document.

import { isSpeechDownToMain } from "../shared/protocol";
import { connectBridge } from "./bridge";
import { apply, defineProperty, getOwnPropertyDescriptor, markNative, nativeClearTimeout, nativeSetTimeout } from "./natives";
import { EXPORTED_CLASSES, configureSpeechRuntime, deliverSpeechMessage, failAllSessions } from "./speech/classes";

const w = window;

const bridge = connectBridge("speech", (msg) => {
  if (!isSpeechDownToMain(msg) || msg.t === "ack") return;
  if (msg.t === "reset") {
    failAllSessions("Connection to the speech recognition service was lost.");
    return;
  }
  deliverSpeechMessage(msg);
});

configureSpeechRuntime(bridge, (fn, ms) => {
  const handle = apply(nativeSetTimeout, w, [fn, ms]);
  return () => apply(nativeClearTimeout, w, [handle]);
});

// ---- expose ---------------------------------------------------------------------

const CONSTRUCTOR_LENGTHS: Record<string, number> = {
  SpeechRecognition: 0,
  SpeechRecognitionEvent: 2,
  SpeechRecognitionErrorEvent: 2,
  SpeechRecognitionResult: 0,
  SpeechRecognitionResultList: 0,
  SpeechRecognitionAlternative: 0,
  SpeechGrammar: 0,
  SpeechGrammarList: 0,
};

for (const [name, ctor] of Object.entries(EXPORTED_CLASSES)) {
  defineProperty(ctor, "length", { value: CONSTRUCTOR_LENGTHS[name] ?? 0, configurable: true });
  markNative(ctor, name);
  defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
  for (const key of Reflect.ownKeys(ctor.prototype)) {
    if (typeof key !== "string" || key === "constructor") continue;
    const d = getOwnPropertyDescriptor(ctor.prototype, key)!;
    if (typeof d.value === "function") markNative(d.value, key);
    if (d.get) markNative(d.get, `get ${key}`);
    if (d.set) markNative(d.set, `set ${key}`);
    // WebIDL attributes/operations are enumerable.
    defineProperty(ctor.prototype, key, { ...d, enumerable: true });
  }
}

const ALIASES: Record<string, keyof typeof EXPORTED_CLASSES> = {
  SpeechRecognition: "SpeechRecognition",
  webkitSpeechRecognition: "SpeechRecognition",
  SpeechRecognitionEvent: "SpeechRecognitionEvent",
  webkitSpeechRecognitionEvent: "SpeechRecognitionEvent",
  SpeechRecognitionErrorEvent: "SpeechRecognitionErrorEvent",
  webkitSpeechRecognitionError: "SpeechRecognitionErrorEvent",
  SpeechRecognitionResult: "SpeechRecognitionResult",
  SpeechRecognitionResultList: "SpeechRecognitionResultList",
  SpeechRecognitionAlternative: "SpeechRecognitionAlternative",
  SpeechGrammar: "SpeechGrammar",
  webkitSpeechGrammar: "SpeechGrammar",
  SpeechGrammarList: "SpeechGrammarList",
  webkitSpeechGrammarList: "SpeechGrammarList",
};

for (const [globalName, className] of Object.entries(ALIASES)) {
  defineProperty(w, globalName, {
    value: EXPORTED_CLASSES[className],
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
