// One microphone stream + one Silero VAD model shared by every recognition
// session (all tabs/frames/instances). Each session gets every 16 kHz frame
// with its speech probability and runs its own Segmenter.
//
// The microphone is opened on the first subscription and released a few
// seconds after the last one (so apps that restart recognition from `onend`
// do not make the mic indicator flicker).

import { MicVAD } from "@ricky0123/vad-web";
import type { SpeechErrorCode } from "../../shared/protocol";
import { SttError } from "./groq";
import type { AudioSubscriber } from "./session";

/** Silero v5 frames are 512 samples at 16 kHz. */
export const FRAME_SAMPLES = 512;
export const SAMPLE_RATE = 16_000;
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const IDLE_RELEASE_MS = 3_000;

interface Running {
  stream: MediaStream;
  context: AudioContext;
  vad: MicVAD;
}

export interface AudioHubOptions {
  assetBase: string;
  onMicState(active: boolean): void;
}

function mapMediaError(e: unknown): SttError {
  const name = (e as DOMException)?.name ?? "";
  const message = String((e as Error)?.message ?? e);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new SttError("not-allowed", "Microphone permission has not been granted to the extension.");
  }
  return new SttError("audio-capture", `Microphone unavailable: ${name || message}`);
}

export class AudioHub {
  private readonly subscribers = new Set<AudioSubscriber>();
  private running: Promise<Running> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: AudioHubOptions) {}

  async subscribe(sub: AudioSubscriber): Promise<() => void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.running) this.running = this.open();
    const running = this.running;
    try {
      await running;
    } catch (e) {
      if (this.running === running) this.running = null;
      throw e instanceof SttError ? e : mapMediaError(e);
    }
    this.subscribers.add(sub);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.subscribers.delete(sub);
      if (this.subscribers.size === 0) this.scheduleIdleClose();
    };
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subscribers.size === 0) void this.close();
    }, IDLE_RELEASE_MS);
  }

  private broadcastError(code: SpeechErrorCode, message: string): void {
    const subs = [...this.subscribers];
    this.subscribers.clear();
    for (const s of subs) s.onError(code, message);
    void this.close();
  }

  private async open(): Promise<Running> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      throw mapMediaError(e);
    }
    this.o.onMicState(true);
    const context = new AudioContext();
    try {
      await context.resume();
      if (context.state !== "running") throw new SttError("audio-capture", `AudioContext is ${context.state}.`);
      const vad = await MicVAD.new({
        model: "v5",
        baseAssetPath: this.o.assetBase,
        onnxWASMBasePath: this.o.assetBase,
        audioContext: context,
        getStream: async () => stream,
        // We own the stream; MicVAD must not stop or re-open it.
        pauseStream: async () => {},
        resumeStream: async (s) => s,
        startOnLoad: true,
        processorType: "AudioWorklet",
        // vad-web's own segmentation is unused (each session segments on its
        // own); make it as cheap as possible.
        positiveSpeechThreshold: 1,
        negativeSpeechThreshold: 0.5,
        preSpeechPadMs: 0,
        redemptionMs: 0,
        minSpeechMs: 0,
        submitUserSpeechOnPause: false,
        ortConfig: (ort) => {
          // No cross-origin isolation here -> no SharedArrayBuffer threads.
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.proxy = false;
          ort.env.logLevel = "error";
        },
        onFrameProcessed: (probs, frame) => {
          for (const s of [...this.subscribers]) s.onFrame(frame, probs.isSpeech);
        },
      });
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => this.broadcastError("audio-capture", "Microphone was disconnected."));
      }
      return { stream, context, vad };
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      void context.close().catch(() => {});
      this.o.onMicState(false);
      throw e instanceof SttError ? e : new SttError("audio-capture", `VAD initialisation failed: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private async close(): Promise<void> {
    const running = this.running;
    this.running = null;
    if (!running) return;
    let r: Running;
    try {
      r = await running;
    } catch {
      return;
    }
    try {
      await r.vad.destroy();
    } catch {
      /* ignore */
    }
    for (const t of r.stream.getTracks()) t.stop();
    await r.context.close().catch(() => {});
    this.o.onMicState(false);
  }
}
