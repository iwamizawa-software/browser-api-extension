import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { configure, launchWithExtension, type Launched } from "./extension";
import { serveMockGroq, serveSite, type MockRequest, type Served } from "./server";

// Speech is fed through Chromium's fake capture device: the fixture (silence,
// an espeak-ng generated English sentence, silence) loops forever.
const SPEECH_WAV = resolve("tests/e2e/fixtures/speech.wav");
const SILENCE_WAV = resolve("tests/e2e/fixtures/silence.wav");
const API_KEY = "gsk_e2e_test_key_0123456789abcdef";

type Responder = (req: MockRequest) => { status: number; json: unknown; headers?: Record<string, string> };

const okTranscript = (text: string, avg_logprob = -0.1, no_speech_prob = 0.01) => ({
  status: 200,
  json: {
    text,
    language: "english",
    segments: [{ id: 0, text, start: 0, end: 2, avg_logprob, no_speech_prob, compression_ratio: 1 }],
  },
});

let responder: Responder = () => okTranscript(" Hello world.");
let groq: Served & { requests: MockRequest[] };
let site: Served;

// Page script: runs a recognition when the page is clicked, records events.
const pageScript = `
window.__events = [];
window.__runs = 0;
function record(rec, label) {
  for (const t of ["start","audiostart","soundstart","speechstart","speechend","soundend","audioend","nomatch","end"]) {
    rec.addEventListener(t, () => window.__events.push(label + t));
  }
  rec.onresult = (e) => {
    const r = e.results[e.resultIndex];
    window.__events.push(label + "result:" + e.resultIndex + ":" + e.results.length + ":" + r.isFinal + ":" + r.length + ":" + r[0].transcript + ":" + r[0].confidence.toFixed(3));
  };
  rec.onerror = (e) => window.__events.push(label + "error:" + e.error);
}
document.addEventListener("click", (ev) => {
  const mode = new URLSearchParams(location.search).get("mode") || "single";
  const Ctor = window.webkitSpeechRecognition;
  const rec = new Ctor();
  window.__rec = rec;
  rec.lang = new URLSearchParams(location.search).get("lang") ?? "en-US";
  rec.continuous = mode === "continuous";
  rec.interimResults = true;
  record(rec, "");
  rec.start();
  try { rec.start(); } catch (e) { window.__events.push("second-start:" + e.name); }
});
`;

function html(body = "") {
  return {
    type: "text/html",
    body: `<!doctype html><html lang="en"><head><title>speech</title><script src="/speech.js"></script></head><body style="height:100vh">${body}</body></html>`,
  };
}

async function events(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __events: string[] }).__events);
}

async function waitForEvent(page: Page, needle: string, timeout = 30_000): Promise<string[]> {
  await page.waitForFunction((n) => (window as unknown as { __events: string[] }).__events.some((e) => e.endsWith(n)), needle, {
    timeout,
  });
  return events(page);
}

async function grantMicrophone(ext: Launched): Promise<void> {
  // Same as the setup page's "grant microphone" button.
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/setup.html`);
  await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  });
  await page.close();
}

async function launch(wav: string): Promise<Launched> {
  const ext = await launchWithExtension([
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
  ]);
  await grantMicrophone(ext);
  await configure(
    ext.sw,
    { speech: { enabled: true, matches: [`${site.url}/*`], excludeMatches: [`${site.url}/blocked*`] } },
    API_KEY,
  );
  return ext;
}

async function open(ext: Launched, path: string): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto(site.url + path);
  return page;
}

async function click(page: Page) {
  await page.bringToFront();
  await page.mouse.click(5, 300);
}

test.beforeAll(async () => {
  groq = await serveMockGroq(8787, (r) => responder(r));
  site = await serveSite({
    "/speech.js": { type: "text/javascript", body: pageScript },
    "/index.html": html(),
    "/blocked.html": html(),
    "/with-frame.html": html(`<iframe src="/index.html?mode=single" style="width:300px;height:300px"></iframe>`),
  });
});

test.afterAll(async () => {
  await groq?.close();
  await site?.close();
});

test.describe("with speech input", () => {
  let ext: Launched;
  test.beforeAll(async () => {
    ext = await launch(SPEECH_WAV);
  });
  test.afterAll(async () => {
    await ext?.close();
  });
  test.beforeEach(() => {
    responder = () => okTranscript(" Hello world.");
    groq.requests.length = 0;
  });

  test("single-shot recognition: Chrome event order, final result, Groq request", async () => {
    const page = await open(ext, "/index.html");
    await click(page);
    const ev = await waitForEvent(page, "end");
    expect(ev).toEqual([
      "second-start:InvalidStateError",
      "start",
      "audiostart",
      "soundstart",
      "speechstart",
      "speechend",
      "soundend",
      "audioend",
      `result:0:1:true:1:Hello world.:${Math.exp(-0.1).toFixed(3)}`,
      "end",
    ]);
    expect(groq.requests).toHaveLength(1);
    const req = groq.requests[0]!;
    expect(req.path).toBe("/openai/v1/audio/transcriptions");
    expect(req.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body = req.body.toString("latin1");
    expect(body).toContain('name="model"\r\n\r\nwhisper-large-v3');
    expect(body).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(body).toContain('name="language"\r\n\r\nen');
    expect(body).toContain('name="temperature"\r\n\r\n0');
    expect(body).toMatch(/filename="audio.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF....WAVEfmt /s);
    // The page never sees the key.
    expect(await page.content()).not.toContain(API_KEY);
  });

  test("continuous recognition accumulates results; stop() ends the session", async () => {
    let n = 0;
    responder = () => okTranscript(` utterance ${++n}`);
    const page = await open(ext, "/index.html?mode=continuous");
    await click(page);
    await waitForEvent(page, ":2:true:1:utterance 2:0.905", 60_000);
    await page.evaluate(() => (window as unknown as { __rec: { stop(): void } }).__rec.stop());
    const ev = await waitForEvent(page, "end");
    const results = ev.filter((e) => e.startsWith("result:"));
    expect(results[0]).toMatch(/^result:0:1:true:1:utterance 1:/);
    expect(results[1]).toMatch(/^result:1:2:true:1:utterance 2:/);
    // soundstart/speechstart once per session, like Chrome.
    expect(ev.filter((e) => e === "speechstart")).toHaveLength(1);
    expect(ev.slice(-1)).toEqual(["end"]);
  });

  test("abort() fires error(aborted) then end and no result", async () => {
    const page = await open(ext, "/index.html?mode=continuous");
    await click(page);
    await waitForEvent(page, "audiostart");
    await page.evaluate(() => (window as unknown as { __rec: { abort(): void } }).__rec.abort());
    const ev = await waitForEvent(page, "end");
    expect(ev.slice(-3)).toEqual(["audioend", "error:aborted", "end"]);
    expect(ev.some((e) => e.startsWith("result"))).toBe(false);
  });

  test("hallucination filter: blocklisted phrase gives nomatch", async () => {
    responder = () => okTranscript("ご視聴ありがとうございました");
    const page = await open(ext, "/index.html?lang=ja-JP");
    await click(page);
    const ev = await waitForEvent(page, "end");
    expect(ev.slice(-2)).toEqual(["nomatch", "end"]);
    expect(groq.requests[0]!.body.toString("latin1")).toContain('name="language"\r\n\r\nja');
  });

  test("429 is retried with backoff", async () => {
    let n = 0;
    responder = () => (++n < 3 ? { status: 429, json: { error: "rate" }, headers: { "retry-after": "0" } } : okTranscript(" ok"));
    const page = await open(ext, "/index.html");
    await click(page);
    const ev = await waitForEvent(page, "end");
    expect(ev.some((e) => e.includes("result:0:1:true:1:ok"))).toBe(true);
    expect(groq.requests.length).toBe(3);
  });

  test("invalid API key (401) -> error not-allowed", async () => {
    responder = () => ({ status: 401, json: { error: { message: "Invalid API Key" } } });
    const page = await open(ext, "/index.html");
    const logs: string[] = [];
    page.on("console", (m) => logs.push(m.text()));
    await click(page);
    const ev = await waitForEvent(page, "end");
    expect(ev.slice(-2)).toEqual(["error:not-allowed", "end"]);
    await expect.poll(() => logs.some((l) => l.includes("setup.html"))).toBe(true);
    expect(logs.join("\n")).not.toContain(API_KEY);
  });

  test("unsupported explicit language -> language-not-supported", async () => {
    const page = await open(ext, "/index.html?lang=tlh-KL");
    await click(page);
    const ev = await waitForEvent(page, "end");
    expect(ev.slice(-2)).toEqual(["error:language-not-supported", "end"]);
    expect(groq.requests).toHaveLength(0);
  });

  test("works in an iframe and in two tabs at the same time", async () => {
    const a = await open(ext, "/with-frame.html");
    const frame = a.frames().find((f) => f.url().includes("/index.html"))!;
    const b = await open(ext, "/index.html");
    await a.bringToFront();
    await frame.evaluate(() => document.body.click());
    await click(b);
    await frame.waitForFunction(() => (window as unknown as { __events: string[] }).__events.includes("end"), null, { timeout: 30_000 });
    await waitForEvent(b, "end");
    const fe = await frame.evaluate(() => (window as unknown as { __events: string[] }).__events);
    expect(fe.some((e) => e.startsWith("result:0:1:true:1:Hello world."))).toBe(true);
    expect((await events(b)).some((e) => e.startsWith("result:0:1:true:1:Hello world."))).toBe(true);
  });

  test("sites outside the allow-list keep the native implementation", async () => {
    // Our constructors throw from extension code, so the stack names the extension.
    const probe = () =>
      (() => {
        try {
          new (window as unknown as { webkitSpeechRecognitionEvent: new (t: string) => Event }).webkitSpeechRecognitionEvent("x");
          return "no-throw";
        } catch (e) {
          return (e as Error).stack ?? "";
        }
      })();
    const blocked = await open(ext, "/blocked.html");
    expect(await blocked.evaluate(probe)).not.toContain("chrome-extension://");
    const allowed = await open(ext, "/index.html");
    expect(await allowed.evaluate(probe)).toContain("chrome-extension://");
  });

  test("missing API key -> service-not-allowed", async () => {
    await ext.sw.evaluate(() => chrome.storage.local.remove("groqApiKey"));
    try {
      const page = await open(ext, "/index.html");
      await click(page);
      const ev = await waitForEvent(page, "end");
      expect(ev.slice(-2)).toEqual(["error:service-not-allowed", "end"]);
    } finally {
      await ext.sw.evaluate((k) => chrome.storage.local.set({ groqApiKey: k }), API_KEY);
    }
  });
});

test.describe("with silence", () => {
  let ext: Launched;
  test.beforeAll(async () => {
    ext = await launch(SILENCE_WAV);
  });
  test.afterAll(async () => {
    await ext?.close();
  });

  test("no speech for 8s -> audioend, error(no-speech), end", async () => {
    const page = await open(ext, "/index.html");
    await click(page);
    const ev = await waitForEvent(page, "end", 20_000);
    expect(ev).toEqual(["second-start:InvalidStateError", "start", "audiostart", "audioend", "error:no-speech", "end"]);
    expect(groq.requests).toHaveLength(0);
  });
});
