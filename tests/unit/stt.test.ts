import { describe, expect, it } from "vitest";
import { Segmenter, type SegmenterOptions } from "../../src/offscreen/stt/segmenter";
import { encodeWav } from "../../src/offscreen/stt/wav";
import { SttError, parseRetryAfter, transcribeWithGroq } from "../../src/offscreen/stt/groq";
import { interpretTranscription, normalizePhrase, type FilterOptions } from "../../src/offscreen/stt/filter";
import { RecognitionSession, type AudioSubscriber, type SessionOutput } from "../../src/offscreen/stt/session";
import { DEFAULT_BLOCKLIST } from "../../src/shared/settings";

const SEG: SegmenterOptions = {
  frameMs: 32,
  positiveThreshold: 0.5,
  negativeThreshold: 0.35,
  redemptionMs: 320, // 10 frames
  preSpeechPadMs: 64, // 2 frames
  minSpeechMs: 96, // 3 frames
  maxSegmentMs: 32 * 50,
};
const frame = (v: number) => new Float32Array(4).fill(v);

function feed(s: Segmenter, probs: number[], value = 0.1) {
  return probs.flatMap((p) => s.push(frame(value), p));
}

describe("Segmenter", () => {
  it("emits speech-start after min speech and a segment after redemption", () => {
    const s = new Segmenter(SEG);
    const ev1 = feed(s, [0, 0, 0, 0.9, 0.9]);
    expect(ev1).toEqual([]);
    const ev2 = feed(s, [0.9]);
    expect(ev2).toEqual([{ type: "speech-start" }]);
    const ev3 = feed(s, Array(9).fill(0));
    expect(ev3).toEqual([]);
    const ev4 = feed(s, [0]);
    expect(ev4).toHaveLength(1);
    expect(ev4[0]!.type).toBe("segment");
    // 2 pad frames + 3 speech + 10 silence
    expect((ev4[0] as { audio: Float32Array }).audio.length).toBe(15 * 4);
  });

  it("treats short blips as misfires", () => {
    const s = new Segmenter(SEG);
    const ev = feed(s, [0.9, 0.9, ...Array(10).fill(0)]);
    expect(ev).toEqual([{ type: "misfire" }]);
  });

  it("probabilities between thresholds neither extend nor end speech", () => {
    const s = new Segmenter(SEG);
    feed(s, [0.9, 0.9, 0.9]);
    const ev = feed(s, Array(30).fill(0.4));
    expect(ev).toEqual([]);
    expect(s.speaking).toBe(true);
  });

  it("force-splits long utterances and keeps going", () => {
    const s = new Segmenter(SEG);
    const ev = feed(s, Array(120).fill(0.9));
    const segs = ev.filter((e) => e.type === "segment");
    expect(segs).toHaveLength(2);
    expect(segs.every((e) => e.type === "segment" && e.reason === "max")).toBe(true);
    expect(ev.filter((e) => e.type === "speech-start")).toHaveLength(1);
    expect(s.speaking).toBe(true);
  });

  it("flush submits an open utterance", () => {
    const s = new Segmenter(SEG);
    feed(s, [0.9, 0.9, 0.9, 0.9]);
    const ev = s.flush();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "segment", reason: "flush" });
    expect(s.flush()).toEqual([]);
  });
});

describe("encodeWav", () => {
  it("writes a valid 16-bit mono header and clamps samples", () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
    const v = new DataView(buf);
    const str = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    expect(str(0)).toBe("RIFF");
    expect(str(8)).toBe("WAVE");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(12);
    expect(buf.byteLength).toBe(44 + 12);
    const samples = [0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe("transcribeWithGroq", () => {
  const ok = { text: " hello", segments: [{ text: " hello", start: 0, end: 1, avg_logprob: -0.2, no_speech_prob: 0.01 }] };
  const makeFetch = (responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };
  const base = { apiKey: "gsk_test_key_1234567890", language: "ja", baseUrl: "https://api.groq.com/openai/v1", sleep: async () => {}, random: () => 0 };
  const wav = new Blob([new Uint8Array(44)], { type: "audio/wav" });

  it("sends the documented multipart request", async () => {
    const f = makeFetch([{ status: 200, body: ok }]);
    const r = await transcribeWithGroq(wav, { ...base, fetchImpl: f.impl }, new AbortController().signal);
    expect(r.text).toBe(" hello");
    expect(f.calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const init = f.calls[0]!.init;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test_key_1234567890");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("temperature")).toBe("0");
    expect(form.get("language")).toBe("ja");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("omits language for auto-detection", async () => {
    const f = makeFetch([{ status: 200, body: ok }]);
    await transcribeWithGroq(wav, { ...base, language: null, fetchImpl: f.impl }, new AbortController().signal);
    expect((f.calls[0]!.init.body as FormData).has("language")).toBe(false);
  });

  it("retries 429/5xx/network errors then succeeds", async () => {
    const f = makeFetch([{ status: 429 }, { status: 503 }, new TypeError("net"), { status: 200, body: ok }]);
    const waits: number[] = [];
    const r = await transcribeWithGroq(
      wav,
      { ...base, fetchImpl: f.impl, sleep: async (ms) => void waits.push(ms) },
      new AbortController().signal,
    );
    expect(r.text).toBe(" hello");
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it("gives up with network after max retries and honours Retry-After", async () => {
    const f = makeFetch([{ status: 500 }, { status: 429, headers: { "retry-after": "3" } }, { status: 500 }, { status: 500 }]);
    const waits: number[] = [];
    await expect(
      transcribeWithGroq(wav, { ...base, fetchImpl: f.impl, sleep: async (ms) => void waits.push(ms) }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "network" });
    expect(waits).toEqual([500, 3000, 2000]);
  });

  it("maps 401 to not-allowed without retrying or leaking the key", async () => {
    const f = makeFetch([{ status: 401, body: { error: "invalid key" } }]);
    const err = await transcribeWithGroq(wav, { ...base, fetchImpl: f.impl }, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect(err.code).toBe("not-allowed");
    expect(err.message).not.toContain(base.apiKey);
    expect(f.calls).toHaveLength(1);
  });

  it("does not retry other 4xx", async () => {
    const f = makeFetch([{ status: 400 }]);
    await expect(transcribeWithGroq(wav, { ...base, fetchImpl: f.impl }, new AbortController().signal)).rejects.toMatchObject({
      code: "network",
      status: 400,
    });
    expect(f.calls).toHaveLength(1);
  });

  it("reports aborted when cancelled", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(transcribeWithGroq(wav, { ...base, fetchImpl: makeFetch([]).impl }, ctrl.signal)).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("parses Retry-After", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:05 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(5000);
  });
});

describe("interpretTranscription", () => {
  const opts: FilterOptions = { noSpeechProbThreshold: 0.6, avgLogprobThreshold: -1, blocklistEnabled: true, blocklist: DEFAULT_BLOCKLIST };
  const seg = (text: string, avg_logprob = -0.1, no_speech_prob = 0.01, start = 0, end = 1) => ({ text, avg_logprob, no_speech_prob, start, end });

  it("joins kept segments and approximates confidence", () => {
    const r = interpretTranscription({ text: "", segments: [seg(" Hello", -0.1, 0, 0, 1), seg(" world.", -0.3, 0, 1, 2)] }, "en", opts)!;
    expect(r.text).toBe("Hello world.");
    expect(r.confidence).toBeCloseTo(Math.exp(-0.2), 6);
  });

  it("drops no-speech and low-logprob segments", () => {
    const r = interpretTranscription(
      { text: "", segments: [seg("keep"), seg(" noise", -0.1, 0.9), seg(" garbage", -2)] },
      "en",
      opts,
    )!;
    expect(r.text).toBe("keep");
    expect(interpretTranscription({ text: "x", segments: [seg("x", -0.1, 0.95)] }, "en", opts)).toBeNull();
  });

  it("drops blocklisted phrases (normalized) for the language", () => {
    expect(interpretTranscription({ text: "", segments: [seg("ご視聴ありがとうございました。")] }, "ja", opts)).toBeNull();
    expect(interpretTranscription({ text: "", segments: [seg("ご視聴 ありがとう ございました!")] }, "ja", opts)).toBeNull();
    // Not applied to other languages when the language is known.
    expect(interpretTranscription({ text: "", segments: [seg("ご視聴ありがとうございました")] }, "en", opts)).not.toBeNull();
    // Unknown language: every list applies.
    expect(interpretTranscription({ text: "", segments: [seg(" Thanks for watching!")] }, null, opts)).toBeNull();
    // Disabled.
    expect(interpretTranscription({ text: "", segments: [seg("ご視聴ありがとうございました")] }, "ja", { ...opts, blocklistEnabled: false })).not.toBeNull();
  });

  it("falls back to text without segments", () => {
    expect(interpretTranscription({ text: " hi " }, "en", opts)).toEqual({ text: "hi", confidence: 0.5 });
    expect(interpretTranscription({ text: "  " }, "en", opts)).toBeNull();
  });

  it("normalizes phrases", () => {
    expect(normalizePhrase(" Thank you! ")).toBe("thankyou");
    expect(normalizePhrase("ＡＢＣ。")).toBe("abc");
  });
});

// ---- session ---------------------------------------------------------------------------

class FakeAudio {
  sub: AudioSubscriber | null = null;
  released = 0;
  async acquire(sub: AudioSubscriber) {
    this.sub = sub;
    return () => {
      this.released++;
      this.sub = null;
    };
  }
  frames(probs: number[]) {
    for (const p of probs) this.sub?.onFrame(frame(0.1), p);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeSession(
  continuous: boolean,
  transcribe: (a: Float32Array, s: AbortSignal) => Promise<{ text: string; confidence: number } | null> = async () => ({
    text: "hello",
    confidence: 0.9,
  }),
) {
  const out: SessionOutput[] = [];
  const audio = new FakeAudio();
  const session = new RecognitionSession(continuous, {
    emit: (o) => out.push(o),
    prepare: async () => ({ ok: true, transcribe, segmenter: SEG }),
    acquireAudio: (s) => audio.acquire(s),
  });
  const names = () => out.map((o) => (o.t === "ev" ? o.type : o.t === "error" ? `error:${o.error}` : `result:${o.transcript}`));
  return { session, audio, out, names };
}

const SPEECH = [...Array(5).fill(0.9), ...Array(10).fill(0)];

describe("RecognitionSession", () => {
  it("single-shot: Chrome event order and ends after the first utterance", async () => {
    const { session, audio, names } = makeSession(false);
    await session.start();
    audio.frames(SPEECH);
    await tick();
    await tick();
    expect(names()).toEqual([
      "start",
      "audiostart",
      "soundstart",
      "speechstart",
      "speechend",
      "soundend",
      "audioend",
      "result:hello",
      "end",
    ]);
    expect(audio.released).toBe(1);
  });

  it("single-shot with nothing recognized fires nomatch then end", async () => {
    const { session, audio, names } = makeSession(false, async () => null);
    await session.start();
    audio.frames(SPEECH);
    await tick();
    await tick();
    expect(names().slice(-2)).toEqual(["nomatch", "end"]);
  });

  it("continuous: results accumulate in utterance order even if requests finish out of order", async () => {
    let n = 0;
    const { session, audio, names } = makeSession(true, (_a) => {
      const i = ++n;
      return new Promise((r) => setTimeout(() => r({ text: `u${i}`, confidence: 1 }), i === 1 ? 30 : 1));
    });
    await session.start();
    audio.frames(SPEECH);
    audio.frames(SPEECH);
    await new Promise((r) => setTimeout(r, 50));
    expect(names()).toEqual(["start", "audiostart", "soundstart", "speechstart", "result:u1", "result:u2"]);
    session.stop();
    await tick();
    await tick();
    expect(names().slice(-4)).toEqual(["speechend", "soundend", "audioend", "end"]);
  });

  it("stop() mid-utterance submits the partial speech and waits for it", async () => {
    let resolve!: (v: { text: string; confidence: number }) => void;
    const { session, audio, names } = makeSession(true, () => new Promise((r) => (resolve = r)));
    await session.start();
    audio.frames(Array(6).fill(0.9));
    session.stop();
    await tick();
    expect(names()).toEqual(["start", "audiostart", "soundstart", "speechstart", "speechend", "soundend", "audioend"]);
    resolve({ text: "partial", confidence: 1 });
    await tick();
    await tick();
    expect(names().slice(-2)).toEqual(["result:partial", "end"]);
  });

  it("abort() cancels pending requests and emits Chrome's abort sequence", async () => {
    let signal!: AbortSignal;
    const { session, audio, names } = makeSession(true, (_a, s) => {
      signal = s;
      return new Promise(() => {});
    });
    await session.start();
    audio.frames(SPEECH);
    session.abort();
    await tick();
    expect(signal.aborted).toBe(true);
    expect(names()).toEqual([
      "start",
      "audiostart",
      "soundstart",
      "speechstart",
      "speechend",
      "soundend",
      "audioend",
      "error:aborted",
      "end",
    ]);
  });

  it("no-speech after 8s of audio", async () => {
    const { session, audio, names } = makeSession(false);
    await session.start();
    audio.frames(Array(Math.ceil(8000 / 32) - 1).fill(0));
    expect(names()).toEqual(["start", "audiostart"]);
    audio.frames([0]);
    expect(names()).toEqual(["start", "audiostart", "audioend", "error:no-speech", "end"]);
  });

  it("continuous mode ends after 15s of silence following speech", async () => {
    const { session, audio, names } = makeSession(true);
    await session.start();
    audio.frames(SPEECH);
    await tick();
    await tick();
    audio.frames(Array(Math.ceil(15000 / 32)).fill(0));
    await tick();
    expect(names().slice(-4)).toEqual(["speechend", "soundend", "audioend", "end"]);
  });

  it("transcription errors end the session with that error", async () => {
    const { session, audio, names } = makeSession(false, async () => {
      throw new SttError("not-allowed", "401");
    });
    await session.start();
    audio.frames(SPEECH);
    await tick();
    await tick();
    expect(names().slice(-2)).toEqual(["error:not-allowed", "end"]);
  });

  it("prepare failures end without start", async () => {
    const out: SessionOutput[] = [];
    const s = new RecognitionSession(false, {
      emit: (o) => out.push(o),
      prepare: async () => ({ ok: false, error: "language-not-supported", message: "" }),
      acquireAudio: async () => () => {},
    });
    await s.start();
    expect(out.map((o) => (o.t === "ev" ? o.type : o.t))).toEqual(["error", "end"]);
  });

  it("audio failures after start: start, error, end (no audioend)", async () => {
    const out: SessionOutput[] = [];
    const s = new RecognitionSession(false, {
      emit: (o) => out.push(o),
      prepare: async () => ({ ok: true, transcribe: async () => null, segmenter: SEG }),
      acquireAudio: async () => {
        throw new SttError("not-allowed", "denied");
      },
    });
    await s.start();
    expect(out.map((o) => (o.t === "ev" ? o.type : o.t === "error" ? o.error : o.t))).toEqual(["start", "not-allowed", "end"]);
  });

  it("stop() while preparing just ends without touching the microphone", async () => {
    const { session, audio, names } = makeSession(false);
    const p = session.start();
    session.stop();
    await p;
    expect(names()).toEqual(["end"]);
    expect(audio.sub).toBeNull();
  });

  it("stop() while the microphone is being acquired ends and releases it", async () => {
    const out: SessionOutput[] = [];
    let released = 0;
    let grant!: () => void;
    const s = new RecognitionSession(false, {
      emit: (o) => out.push(o),
      prepare: async () => ({ ok: true, transcribe: async () => null, segmenter: SEG }),
      acquireAudio: () => new Promise((r) => (grant = () => r(() => void released++))),
    });
    const p = s.start();
    await tick();
    s.stop();
    grant();
    await p;
    expect(out.map((o) => (o.t === "ev" ? o.type : o.t))).toEqual(["start", "end"]);
    expect(released).toBe(1);
  });

  it("dispose() emits nothing and releases", async () => {
    const { session, audio, names } = makeSession(true);
    await session.start();
    session.dispose();
    audio.frames(SPEECH);
    expect(names()).toEqual(["start", "audiostart"]);
    expect(audio.released).toBe(1);
  });
});
