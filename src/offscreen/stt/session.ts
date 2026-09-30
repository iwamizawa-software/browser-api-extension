// One SpeechRecognition session (one start() ... end). Pure state machine with
// injected I/O so it can be unit tested.
//
// Event order follows Chromium (content/browser/speech/speech_recognizer_impl.cc
// and third_party/blink/renderer/modules/speech/speech_recognition.cc):
//   start -> audiostart -> soundstart, speechstart -> ...
//   end of capture: speechend, soundend (if sound started) -> audioend
//   -> result(s) -> end
//   abort / error while capturing: [speechend, soundend] [audioend] error end
//   no-speech after 8s of audio without speech: audioend, error(no-speech), end
//   continuous mode ends by itself after 15s of silence after speech.

import type { SpeechErrorCode, SpeechEventType } from "../../shared/protocol";
import { Segmenter, type SegmenterEvent, type SegmenterOptions } from "./segmenter";
import { SttError } from "./groq";
import type { Transcript } from "./filter";

export const NO_SPEECH_TIMEOUT_MS = 8_000; // Chromium kNoSpeechTimeoutMs
export const CONTINUOUS_SILENCE_TIMEOUT_MS = 15_000; // Chromium continuous endpointer

export type SessionOutput =
  | { t: "ev"; type: SpeechEventType }
  | { t: "result"; transcript: string; confidence: number }
  | { t: "error"; error: SpeechErrorCode; message: string };

export interface AudioSubscriber {
  onFrame(frame: Float32Array, speechProbability: number): void;
  onError(code: SpeechErrorCode, message: string): void;
}

export type PrepareResult =
  | {
      ok: true;
      transcribe: (audio: Float32Array, signal: AbortSignal) => Promise<Transcript | null>;
      segmenter: SegmenterOptions;
    }
  | { ok: false; error: SpeechErrorCode; message: string };

export interface SessionDeps {
  emit(out: SessionOutput): void;
  /** Validates the request and resolves settings / credentials. */
  prepare(): Promise<PrepareResult>;
  /** Subscribes to the shared microphone; resolves to an unsubscribe function. */
  acquireAudio(sub: AudioSubscriber): Promise<() => void>;
}

type State = "preparing" | "starting" | "capturing" | "finishing" | "ended";

export class RecognitionSession {
  private state: State = "preparing";
  private audioStarted = false;
  private soundStarted = false;
  private release: (() => void) | null = null;
  private segmenter: Segmenter | null = null;
  private transcribe: ((audio: Float32Array, signal: AbortSignal) => Promise<Transcript | null>) | null = null;
  private frameMs = 32;
  private audioMs = 0;
  private silenceMs = 0;
  private readonly inflight = new Set<AbortController>();
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly continuous: boolean,
    private readonly deps: SessionDeps,
  ) {}

  get ended(): boolean {
    return this.state === "ended";
  }

  async start(): Promise<void> {
    let prep: PrepareResult;
    try {
      prep = await this.deps.prepare();
    } catch (e) {
      prep = { ok: false, error: "network", message: String((e as Error)?.message ?? e) };
    }
    if (this.state !== "preparing") return; // stopped/aborted meanwhile
    if (!prep.ok) {
      this.state = "ended";
      this.emitError(prep.error, prep.message);
      this.emitEv("end");
      return;
    }
    this.transcribe = prep.transcribe;
    this.segmenter = new Segmenter(prep.segmenter);
    this.frameMs = prep.segmenter.frameMs;
    this.state = "starting";
    this.emitEv("start");
    let release: () => void;
    try {
      release = await this.deps.acquireAudio({
        onFrame: (f, p) => this.onFrame(f, p),
        onError: (code, message) => this.fail(code, message),
      });
    } catch (e) {
      if (this.state !== "starting") return;
      const err = e instanceof SttError ? e : new SttError("audio-capture", String((e as Error)?.message ?? e));
      this.fail(err.code, err.message);
      return;
    }
    if (this.state !== "starting") {
      release();
      return;
    }
    this.release = release;
    this.state = "capturing";
    this.audioStarted = true;
    this.emitEv("audiostart");
  }

  /** stop(): finish capturing, deliver pending results, then end. */
  stop(): void {
    switch (this.state) {
      case "preparing":
      case "starting":
        // Chromium: stopping before audio capture started just ends.
        this.state = "ended";
        this.emitEv("end");
        return;
      case "capturing":
        this.handle(this.segmenter!.flush());
        if (this.state === "capturing") this.finishCapture();
        return;
      default:
        return;
    }
  }

  /** abort(): no further results. */
  abort(): void {
    if (this.state === "ended") return;
    this.fail("aborted", "");
  }

  /** The requesting frame went away: tear down without emitting anything. */
  dispose(): void {
    if (this.state === "ended") return;
    this.state = "ended";
    this.detach();
    this.cancelInflight();
  }

  private onFrame(frame: Float32Array, probability: number): void {
    if (this.state !== "capturing") return;
    this.audioMs += this.frameMs;
    this.handle(this.segmenter!.push(frame, probability));
    if (this.state !== "capturing") return;
    const speaking = this.segmenter!.speaking;
    if (!this.soundStarted) {
      if (!speaking && this.audioMs >= NO_SPEECH_TIMEOUT_MS) this.fail("no-speech", "");
      return;
    }
    if (this.continuous) {
      this.silenceMs = speaking ? 0 : this.silenceMs + this.frameMs;
      if (this.silenceMs >= CONTINUOUS_SILENCE_TIMEOUT_MS) this.finishCapture();
    }
  }

  private handle(events: SegmenterEvent[]): void {
    for (const ev of events) {
      if (this.state !== "capturing") return;
      if (ev.type === "speech-start") {
        if (!this.soundStarted) {
          this.soundStarted = true;
          this.emitEv("soundstart");
          this.emitEv("speechstart");
        }
      } else if (ev.type === "segment") {
        this.enqueue(ev.audio);
        if (!this.continuous) this.finishCapture();
      }
    }
  }

  private finishCapture(): void {
    this.detach();
    this.state = "finishing";
    if (this.soundStarted) {
      this.emitEv("speechend");
      this.emitEv("soundend");
    }
    this.emitEv("audioend");
    this.chain = this.chain.then(() => this.maybeEnd());
  }

  private enqueue(audio: Float32Array): void {
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    this.pending++;
    // Requests run in parallel; results are delivered in utterance order.
    const request = this.transcribe!(audio, ctrl.signal).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    this.chain = this.chain.then(async () => {
      const out = await request;
      this.inflight.delete(ctrl);
      this.pending--;
      if (this.state === "ended") return;
      if (!out.ok) {
        const err = out.e instanceof SttError ? out.e : new SttError("network", String((out.e as Error)?.message ?? out.e));
        if (err.code === "aborted") return;
        this.fail(err.code, err.message);
        return;
      }
      if (out.r) this.deps.emit({ t: "result", transcript: out.r.text, confidence: out.r.confidence });
      else if (!this.continuous) this.emitEv("nomatch");
      this.maybeEnd();
    });
  }

  private maybeEnd(): void {
    if (this.state === "finishing" && this.pending === 0) {
      this.state = "ended";
      this.emitEv("end");
    }
  }

  private fail(code: SpeechErrorCode, message: string): void {
    if (this.state === "ended") return;
    if (this.state === "capturing") {
      this.detach();
      if (this.soundStarted) {
        this.emitEv("speechend");
        this.emitEv("soundend");
      }
      if (this.audioStarted) this.emitEv("audioend");
    }
    this.state = "ended";
    this.cancelInflight();
    this.emitError(code, message);
    this.emitEv("end");
  }

  private detach(): void {
    const r = this.release;
    this.release = null;
    r?.();
  }

  private cancelInflight(): void {
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
  }

  private emitEv(type: SpeechEventType): void {
    this.deps.emit({ t: "ev", type });
  }

  private emitError(error: SpeechErrorCode, message: string): void {
    this.deps.emit({ t: "error", error, message });
  }
}
