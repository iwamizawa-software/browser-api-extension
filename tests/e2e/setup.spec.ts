import { expect, test } from "@playwright/test";
import { launchWithExtension, type Launched } from "./extension";
import { serveMockGroq, type MockRequest, type Served } from "./server";

const GOOD = "gsk_valid_key_for_e2e_0123456789";
const BAD = "gsk_revoked_key_for_e2e_0123456789";

let ext: Launched;
let groq: Served & { requests: MockRequest[] };

test.beforeAll(async () => {
  groq = await serveMockGroq(8787, (r) =>
    r.path === "/openai/v1/models" && r.authorization === `Bearer ${GOOD}`
      ? { status: 200, json: { data: [{ id: "whisper-large-v3" }] } }
      : { status: 401, json: { error: { message: "Invalid API Key" } } },
  );
  ext = await launchWithExtension(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
});

test.afterAll(async () => {
  await ext?.close();
  await groq?.close();
});

test("setup page opens on install and manages key, microphone and settings", async () => {
  // onInstalled opened the page.
  await expect.poll(() => ext.context.pages().some((p) => p.url().endsWith("/setup.html"))).toBe(true);
  const page = ext.context.pages().find((p) => p.url().endsWith("/setup.html"))!;
  await page.bringToFront();
  await expect(page.locator("#key-state")).toHaveText("未設定");

  // Microphone.
  await page.click("#mic-grant");
  await expect(page.locator("#mic-result")).toContainText("許可されました");
  await expect(page.locator("#mic-state")).toHaveText("許可済み");

  // Invalid key is verified and rejected.
  await page.fill("#key-input", BAD);
  await page.click("#key-save");
  await expect(page.locator("#key-result")).toContainText("拒否されました");
  expect(await ext.sw.evaluate(() => chrome.storage.local.get("groqApiKey"))).toEqual({});

  // Valid key is stored and masked.
  await page.fill("#key-input", GOOD);
  await page.click("#key-save");
  await expect(page.locator("#key-result")).toContainText("保存しました");
  await expect(page.locator("#key-state")).toHaveText("設定済み (gsk_…6789)");
  await expect(page.locator("#key-input")).toHaveValue("");
  expect(await ext.sw.evaluate(() => chrome.storage.local.get("groqApiKey"))).toEqual({ groqApiKey: GOOD });

  // Invalid patterns are refused.
  await page.fill("#speech-matches", "not a pattern");
  await page.click("#settings-save");
  await expect(page.locator("#settings-result")).toContainText("不正な match pattern");

  // Valid settings register content scripts.
  await page.fill("#speech-matches", "https://example.com/*");
  await page.fill("#timers-exclude", "https://no-timers.example/*");
  await page.click("#settings-save");
  await expect(page.locator("#settings-result")).toHaveText("保存しました。");
  await expect(page.locator("#registration-state")).toContainText("OK");
  const scripts = await ext.sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  const byId = Object.fromEntries(scripts.map((s) => [s.id, s]));
  expect(Object.keys(byId).sort()).toEqual(["bae-speech-isolated", "bae-speech-main", "bae-timers-isolated", "bae-timers-main"]);
  expect(byId["bae-speech-main"]!.matches).toEqual(["https://example.com/*"]);
  expect(byId["bae-speech-main"]!.world).toBe("MAIN");
  expect(byId["bae-timers-main"]!.excludeMatches).toEqual(["https://no-timers.example/*"]);
  expect(byId["bae-timers-main"]!.runAt).toBe("document_start");
  expect(byId["bae-timers-main"]!.allFrames).toBe(true);

  // Content scripts cannot read extension storage (API key) any more.
  const level = await ext.sw.evaluate(async () => {
    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      return "ok";
    } catch (e) {
      return String(e);
    }
  });
  expect(level).toBe("ok");

  await page.screenshot({ path: "test-results/setup.png", fullPage: true });

  // Disabling a feature unregisters it.
  await page.uncheck("#speech-enabled");
  await page.click("#settings-save");
  await expect(page.locator("#registration-state")).toContainText("OK");
  const after = await ext.sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  expect(after.map((s) => s.id).sort()).toEqual(["bae-timers-isolated", "bae-timers-main"]);

  // Delete the key.
  await page.click("#key-delete");
  await expect(page.locator("#key-state")).toHaveText("未設定");
});
