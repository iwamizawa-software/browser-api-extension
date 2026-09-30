import { expect, test } from "@playwright/test";
import { RawBrowser } from "./cdp";
import { EXTENSION_DIR } from "./extension";
import { serveSite, type Served } from "./server";

let site: Served;
let browser: RawBrowser;
let sw: string;

const html = { type: "text/html", body: "<!doctype html><title>t</title>" };

test.beforeAll(async () => {
  site = await serveSite({ "/replaced.html": html, "/native.html": html, "/front.html": html });
  browser = await RawBrowser.launch(EXTENSION_DIR);
  sw = await browser.attachServiceWorker();
  await browser.evaluate(
    sw,
    `(async () => {
      await chrome.storage.local.remove("registrationStatus");
      await chrome.storage.local.set({ settings: { timers: { enabled: true, matches: ["<all_urls>"], excludeMatches: ["*://*/native.html*"] } } });
      for (let i = 0; i < 100; i++) {
        const { registrationStatus } = await chrome.storage.local.get("registrationStatus");
        if (registrationStatus) return registrationStatus.ok;
        await new Promise((r) => setTimeout(r, 50));
      }
    })()`,
  );
});

test.afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const START = `window.__ticks = []; setInterval(() => window.__ticks.push(performance.now()), 100); true`;
const COUNT = `window.__ticks.length`;

test("background tab: setInterval(100) keeps running at ~10Hz (native is throttled)", async () => {
  const replaced = await browser.newTab(site.url + "/replaced.html");
  const native = await browser.newTab(site.url + "/native.html");
  await browser.evaluate(replaced, START);
  await browser.evaluate(native, START);
  // Opening another foreground tab hides the two above.
  await browser.newTab(site.url + "/front.html");
  await new Promise((r) => setTimeout(r, 1500));
  expect(await browser.evaluate(replaced, "document.visibilityState")).toBe("hidden");
  expect(await browser.evaluate(native, "document.visibilityState")).toBe("hidden");

  const r0 = await browser.evaluate<number>(replaced, COUNT);
  const n0 = await browser.evaluate<number>(native, COUNT);
  await new Promise((r) => setTimeout(r, 10_000));
  const r1 = await browser.evaluate<number>(replaced, COUNT);
  const n1 = await browser.evaluate<number>(native, COUNT);
  const gaps = await browser.evaluate<number[]>(
    replaced,
    `(() => { const t = window.__ticks.slice(-50); return t.slice(1).map((v, i) => v - t[i]); })()`,
  );
  const maxGap = Math.max(...gaps);
  console.log(`hidden 10s: replaced=${r1 - r0} ticks (max gap ${maxGap.toFixed(1)}ms), native=${n1 - n0} ticks`);
  expect(r1 - r0).toBeGreaterThanOrEqual(90);
  expect(maxGap).toBeLessThan(200);
  // Sanity check that the environment really throttles native timers.
  expect(n1 - n0).toBeLessThan(30);
});

test("offscreen document closed while hidden: timers reconnect and stay unthrottled", async () => {
  const replaced = await browser.newTab(site.url + "/replaced.html");
  await browser.evaluate(replaced, START);
  await browser.newTab(site.url + "/front.html");
  await new Promise((r) => setTimeout(r, 1500));
  expect(await browser.evaluate(replaced, "document.visibilityState")).toBe("hidden");
  // Simulate Chrome discarding the offscreen document.
  const closed = await browser.evaluate<boolean>(
    sw,
    `chrome.offscreen.closeDocument().then(() => true, () => false)`,
  );
  expect(closed).toBe(true);
  await new Promise((r) => setTimeout(r, 1500));
  const r0 = await browser.evaluate<number>(replaced, COUNT);
  await new Promise((r) => setTimeout(r, 10_000));
  const r1 = await browser.evaluate<number>(replaced, COUNT);
  console.log(`after offscreen close: ${r1 - r0} ticks in 10s`);
  expect(r1 - r0).toBeGreaterThanOrEqual(90);
  const contexts = await browser.evaluate<number>(
    sw,
    `chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).then((c) => c.length)`,
  );
  expect(contexts).toBe(1);
});

test("service worker stopped (30s idle) and offscreen closed: timers still recover", async () => {
  const replaced = await browser.newTab(site.url + "/replaced.html");
  await browser.evaluate(replaced, START);
  await browser.newTab(site.url + "/front.html");
  await new Promise((r) => setTimeout(r, 1500));
  expect(await browser.evaluate(replaced, "document.visibilityState")).toBe("hidden");
  await browser.evaluate(sw, "self.__oldInstance = true");
  // Worst case: both the offscreen document and the service worker are gone.
  expect(await browser.evaluate<boolean>(sw, `chrome.offscreen.closeDocument().then(() => true, () => false)`)).toBe(true);
  const setupPage = await browser.attach(
    await browser.waitForTarget((t) => t.type === "page" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/setup.html")),
  );
  await browser.stopServiceWorker(setupPage);
  await new Promise((r) => setTimeout(r, 1500));
  const r0 = await browser.evaluate<number>(replaced, COUNT);
  await new Promise((r) => setTimeout(r, 10_000));
  const r1 = await browser.evaluate<number>(replaced, COUNT);
  console.log(`after SW stop + offscreen close: ${r1 - r0} ticks in 10s`);
  expect(r1 - r0).toBeGreaterThanOrEqual(90);
  // A fresh service worker instance was started on demand and recreated the offscreen document.
  sw = await browser.attachServiceWorker();
  expect(await browser.evaluate<string>(sw, "String(self.__oldInstance)")).toBe("undefined");
  expect(
    await browser.evaluate<number>(sw, `chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).then((c) => c.length)`),
  ).toBe(1);
});
