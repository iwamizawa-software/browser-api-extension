// Utterance segmentation on top of per-frame Silero speech probabilities.
//
// The algorithm follows @ricky0123/vad-web's FrameProcessor (positive/negative
// thresholds, redemption frames, pre-speech padding, minimum speech length),
// with two additions we need for Whisper:
//   * a hard maximum utterance length (forced split), and
//   * `flush()` so stop() can submit the speech captured so far.
// Each recognition session owns one Segmenter; the Silero model itself (which
// is stateful) runs once per frame in the shared AudioHub.

export interface SegmenterOptions {
  frameMs: number;
  positiveThreshold: number;
  negativeThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
}

export type SegmenterEvent =
  | { type: "speech-start" }
  | { type: "segment"; audio: Float32Array; reason: "end" | "max" | "flush" }
  | { type: "misfire" };

interface Frame {
  samples: Float32Array;
  isSpeech: boolean;
}

function concat(frames: Frame[]): Float32Array {
  let n = 0;
  for (const f of frames) n += f.samples.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const f of frames) {
    out.set(f.samples, o);
    o += f.samples.length;
  }
  return out;
}

export class Segmenter {
  private readonly redemptionFrames: number;
  private readonly preSpeechPadFrames: number;
  private readonly minSpeechFrames: number;
  private readonly maxFrames: number;
  private buffer: Frame[] = [];
  private speakingState = false;
  private realStartFired = false;
  private speechFrames = 0;
  private redemption = 0;

  constructor(private readonly o: SegmenterOptions) {
    this.redemptionFrames = Math.max(1, Math.floor(o.redemptionMs / o.frameMs));
    this.preSpeechPadFrames = Math.floor(o.preSpeechPadMs / o.frameMs);
    this.minSpeechFrames = Math.max(1, Math.ceil(o.minSpeechMs / o.frameMs));
    this.maxFrames = Math.max(this.minSpeechFrames + 1, Math.floor(o.maxSegmentMs / o.frameMs));
  }

  /** True while a (possibly tentative) utterance is open. */
  get speaking(): boolean {
    return this.speakingState;
  }

  push(samples: Float32Array, probability: number): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    const isSpeech = probability >= this.o.positiveThreshold;
    this.buffer.push({ samples, isSpeech });
    if (isSpeech) {
      this.speechFrames++;
      this.redemption = 0;
      if (!this.speakingState) this.speakingState = true;
    }
    if (this.speakingState && !this.realStartFired && this.speechFrames >= this.minSpeechFrames) {
      this.realStartFired = true;
      events.push({ type: "speech-start" });
    }
    if (this.speakingState && probability < this.o.negativeThreshold && ++this.redemption >= this.redemptionFrames) {
      events.push(this.close("end"));
      return events;
    }
    if (this.speakingState && this.buffer.length >= this.maxFrames) {
      // Forced split: emit what we have and keep listening to the same utterance.
      const count = this.countSpeech();
      if (count >= this.minSpeechFrames) {
        events.push({ type: "segment", audio: concat(this.buffer), reason: "max" });
      }
      this.buffer = [];
      this.speechFrames = 0;
      this.redemption = 0;
      return events;
    }
    if (!this.speakingState) {
      while (this.buffer.length > this.preSpeechPadFrames) this.buffer.shift();
      this.speechFrames = 0;
    }
    return events;
  }

  /** Ends capture: submits the open utterance if it has enough speech. */
  flush(): SegmenterEvent[] {
    if (!this.speakingState) {
      this.reset();
      return [];
    }
    return [this.close("flush")];
  }

  private countSpeech(): number {
    let n = 0;
    for (const f of this.buffer) if (f.isSpeech) n++;
    return n;
  }

  private close(reason: "end" | "flush"): SegmenterEvent {
    const count = this.countSpeech();
    const frames = this.buffer;
    // A forced split may have left a tail with little speech but the utterance
    // was real: still submit tails with some speech in that case.
    const enough = count >= this.minSpeechFrames || (this.realStartFired && count > 0);
    this.reset();
    return enough ? { type: "segment", audio: concat(frames), reason } : { type: "misfire" };
  }

  private reset(): void {
    this.buffer = [];
    this.speakingState = false;
    this.realStartFired = false;
    this.speechFrames = 0;
    this.redemption = 0;
  }
}
