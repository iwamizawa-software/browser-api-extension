import { expect, test } from "@playwright/test";
import { configure, launchWithExtension, type Launched } from "./extension";
import { serveSite, type Served } from "./server";

const page = (title: string) => ({
  type: "text/html",
  body: `<!doctype html><html lang="en"><head><title>${title}</title><script src="/page.js"></script><script src="/scenario.js"></script></head><body style="height:100vh"><iframe src="/frame.html"></iframe></body></html>`,
});

let ext: Launched;
let site: Served;

test.beforeAll(async () => {
  site = await serveSite({
    "/replaced.html": page("replaced"),
    "/native.html": page("native"),
    "/frame.html": { type: "text/html", body: `<!doctype html><title>frame</title>` },
    "/page.js": { type: "text/javascript", body: `window.pageScriptRan = true;` },
    // Started by a real click (not page.evaluate): DevTools evaluation bypasses
    // CSP eval checks for everything on its call stack.
    "/scenario.js": {
      type: "text/javascript",
      body: `document.addEventListener("click", async () => { window.__log = await (${scenario.toString()})(); }, { once: true });`,
    },
  });
  ext = await launchWithExtension();
  await configure(ext.sw, {
    timers: { enabled: true, matches: ["<all_urls>"], excludeMatches: ["*://*/native.html*"] },
  });
});

test.afterAll(async () => {
  await ext?.close();
  await site?.close();
});

// Runs in the page's main world. Returns an ordered log that should be
// identical for native and replaced timers.
async function scenario(): Promise<string[]> {
  const log: string[] = [];
  const w = window as unknown as Record<string, unknown>;
  window.addEventListener("error", (e) => {
    log.push("error-event:" + e.message + ":" + (e.error instanceof Error));
    e.preventDefault();
  });
  log.push("lengths:" + [setTimeout.length, setInterval.length, clearTimeout.length, clearInterval.length].join());
  log.push("names:" + [setTimeout.name, setInterval.name, clearTimeout.name, clearInterval.name].join());
  log.push("toString:" + Function.prototype.toString.call(setTimeout));
  log.push("prototype:" + ("prototype" in setTimeout));
  try {
    // @ts-expect-error intentionally wrong
    setTimeout();
  } catch (e) {
    log.push("noargs:" + (e as Error).constructor.name);
  }
  try {
    // @ts-expect-error intentionally wrong
    new setTimeout(() => {});
  } catch (e) {
    log.push("new:" + (e as Error).constructor.name);
  }
  // String handlers are blocked by the strict CSP (no 'unsafe-eval').
  log.push("string-handler:" + setTimeout("window.__x = 1", 0));
  log.push("empty-string:" + setTimeout("", 0));

  // Shared ID space and cross-clearing.
  const a = window.setTimeout(() => log.push("A should not run"), 0);
  const b = window.setInterval(() => log.push("B should not run"), 1);
  const c = window.setTimeout(() => log.push("c ran"), 0);
  log.push("ids-increase:" + (b === a + 1 && c === b + 1));
  clearInterval(a);
  clearTimeout(b);
  clearTimeout(String(9e9) as unknown as number);
  const s = setTimeout(() => log.push("string-id should not run"), 1);
  clearTimeout(String(s) as unknown as number);

  setTimeout((x: string, y: string) => log.push("args:" + x + y), 0, "x", "y");
  setTimeout(function (this: unknown) {
    log.push("this-is-window:" + (this === window));
  }, 0);

  // Microtasks run between timer callbacks.
  setTimeout(() => {
    Promise.resolve().then(() => log.push("micro after first"));
    log.push("first");
  }, 3);
  setTimeout(() => log.push("second"), 3);

  // Errors are reported but do not stop other timers.
  setTimeout(() => {
    throw new Error("boom");
  }, 5);
  setTimeout(() => log.push("after boom"), 5);

  // Delay conversion.
  setTimeout(() => log.push("2^31 -> immediate"), 2 ** 31);
  setTimeout(() => log.push("2^32+5 -> 5ms"), 2 ** 32 + 5);
  setTimeout(() => log.push("NaN -> 0"), NaN);
  setTimeout(() => log.push("'8' -> 8ms"), "8" as unknown as number);

  // Interval cleared from its own callback.
  let k = 0;
  const iv = setInterval(() => {
    log.push("interval " + k);
    if (++k === 3) clearInterval(iv);
  }, 20);

  // Let everything above settle before the timing-sensitive part.
  await new Promise((r) => setTimeout(r, 150));

  // Nesting clamp: count how many of 12 nested 0ms timeouts were delayed >= 3ms.
  await new Promise<void>((resolve) => {
    const stamps: number[] = [];
    const step = () => {
      stamps.push(performance.now());
      if (stamps.length < 12) setTimeout(step, 0);
      else {
        let clamped = 0;
        for (let i = 1; i < stamps.length; i++) if (stamps[i]! - stamps[i - 1]! >= 3.5) clamped++;
        log.push("nested-clamped>=5:" + (clamped >= 5));
        resolve();
      }
    };
    setTimeout(step, 0);
  });

  log.push("__x:" + String(w.__x));
  return log;
}

async function callbackStack(): Promise<string> {
  return new Promise((r) => setTimeout(() => r(new Error().stack ?? ""), 0));
}

test("replaced timers behave like native ones under a strict CSP", async () => {
  const replaced = await ext.context.newPage();
  await replaced.goto(site.url + "/replaced.html");
  const native = await ext.context.newPage();
  await native.goto(site.url + "/native.html");

  expect(await replaced.evaluate(() => (window as unknown as { pageScriptRan: boolean }).pageScriptRan)).toBe(true);
  // The replacement is active on one page and not on the other.
  expect(await replaced.evaluate(callbackStack)).toContain("chrome-extension://");
  expect(await native.evaluate(callbackStack)).not.toContain("chrome-extension://");
  // ... and in the iframe of the replaced page.
  const frame = replaced.frames().find((f) => f.url().endsWith("/frame.html"))!;
  expect(await frame.evaluate(callbackStack)).toContain("chrome-extension://");

  const run = async (p: typeof native) => {
    await p.bringToFront();
    await p.mouse.click(5, 300);
    await p.waitForFunction(() => (window as unknown as { __log?: string[] }).__log, null, { timeout: 10_000 });
    return p.evaluate(() => (window as unknown as { __log: string[] }).__log);
  };
  const nativeLog = await run(native);
  const replacedLog = await run(replaced);
  console.log(nativeLog.join("\n"));
  expect(replacedLog).toEqual(nativeLog);
});
