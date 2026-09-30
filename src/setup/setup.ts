// Setup / options page (normal extension page opened in a tab).
// All dynamic text is set with textContent (never innerHTML).

import { STORAGE_KEYS, defaultSettings, isPlausibleApiKey, sanitizeSettings, type Settings } from "../shared/settings";
import { formatBlocklist, maskKey, parseBlocklist, parsePatternList } from "./forms";

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

function say(el: HTMLElement, text: string, kind: "ok" | "err" | "" = ""): void {
  el.textContent = text;
  el.className = kind;
}

// ---- microphone ---------------------------------------------------------------------

const micState = $<HTMLOutputElement>("mic-state");
const micResult = $<HTMLParagraphElement>("mic-result");

const MIC_STATE_TEXT: Record<string, string> = {
  granted: "許可済み",
  denied: "拒否されています（アドレスバー左のアイコン、または chrome://settings/content/microphone から許可してください）",
  prompt: "未許可",
};

async function refreshMicState(): Promise<void> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    const update = () => say(micState, MIC_STATE_TEXT[status.state] ?? status.state, status.state === "granted" ? "ok" : "err");
    update();
    status.onchange = update;
  } catch {
    say(micState, "不明");
  }
}

$("mic-grant").addEventListener("click", async () => {
  say(micResult, "許可を要求しています…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const label = stream.getAudioTracks()[0]?.label ?? "";
    for (const t of stream.getTracks()) t.stop();
    say(micResult, `マイクの使用が許可されました${label ? `（${label}）` : ""}。`, "ok");
  } catch (e) {
    const name = (e as DOMException)?.name ?? "";
    say(
      micResult,
      name === "NotAllowedError"
        ? "マイクの使用が拒否されました。サイト設定から許可してください。"
        : name === "NotFoundError"
          ? "マイクが見つかりません。"
          : `マイクを取得できませんでした: ${name || String(e)}`,
      "err",
    );
  }
  void refreshMicState();
});

// ---- API key ---------------------------------------------------------------------------

const keyState = $<HTMLOutputElement>("key-state");
const keyInput = $<HTMLInputElement>("key-input");
const keyResult = $<HTMLParagraphElement>("key-result");
const saveUnverified = $<HTMLButtonElement>("key-save-unverified");

async function refreshKeyState(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.apiKey);
  const key = stored[STORAGE_KEYS.apiKey];
  if (typeof key === "string" && key) say(keyState, `設定済み (${maskKey(key)})`, "ok");
  else say(keyState, "未設定", "err");
}

type Verification = "valid" | "invalid" | "unreachable";

async function verifyKey(key: string): Promise<{ result: Verification; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${__GROQ_BASE__}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (res.ok) return { result: "valid", detail: "" };
    if (res.status === 401 || res.status === 403) return { result: "invalid", detail: `HTTP ${res.status}` };
    return { result: "unreachable", detail: `HTTP ${res.status}` };
  } catch (e) {
    return { result: "unreachable", detail: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function storeKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.apiKey]: key });
  keyInput.value = "";
  saveUnverified.hidden = true;
  await refreshKeyState();
}

$<HTMLFormElement>("key-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const key = keyInput.value.trim();
  saveUnverified.hidden = true;
  if (!isPlausibleApiKey(key)) {
    say(keyResult, "API キーの形式が正しくありません。", "err");
    return;
  }
  say(keyResult, "検証しています…");
  const { result, detail } = await verifyKey(key);
  if (result === "valid") {
    await storeKey(key);
    say(keyResult, "API キーを検証して保存しました。", "ok");
  } else if (result === "invalid") {
    say(keyResult, `API キーが拒否されました (${detail})。保存していません。`, "err");
  } else {
    say(keyResult, `検証できませんでした (${detail})。キーを確認のうえ「検証せずに保存」もできます。`, "err");
    saveUnverified.hidden = false;
  }
});

saveUnverified.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (!isPlausibleApiKey(key)) return;
  await storeKey(key);
  say(keyResult, "検証せずに保存しました。", "ok");
});

$("key-delete").addEventListener("click", async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
  keyInput.value = "";
  say(keyResult, "API キーを削除しました。", "ok");
  await refreshKeyState();
});

// ---- settings --------------------------------------------------------------------------

const f = {
  timersEnabled: $<HTMLInputElement>("timers-enabled"),
  timersMatches: $<HTMLTextAreaElement>("timers-matches"),
  timersExclude: $<HTMLTextAreaElement>("timers-exclude"),
  speechEnabled: $<HTMLInputElement>("speech-enabled"),
  speechMatches: $<HTMLTextAreaElement>("speech-matches"),
  speechExclude: $<HTMLTextAreaElement>("speech-exclude"),
  nsp: $<HTMLInputElement>("nsp"),
  alp: $<HTMLInputElement>("alp"),
  blocklistEnabled: $<HTMLInputElement>("blocklist-enabled"),
  blocklist: $<HTMLTextAreaElement>("blocklist"),
  vadThreshold: $<HTMLInputElement>("vad-threshold"),
  vadRedemption: $<HTMLInputElement>("vad-redemption"),
  vadMin: $<HTMLInputElement>("vad-min"),
  vadMax: $<HTMLInputElement>("vad-max"),
};
const settingsResult = $<HTMLParagraphElement>("settings-result");
const registrationState = $<HTMLOutputElement>("registration-state");

function fill(s: Settings): void {
  f.timersEnabled.checked = s.timers.enabled;
  f.timersMatches.value = s.timers.matches.join("\n");
  f.timersExclude.value = s.timers.excludeMatches.join("\n");
  f.speechEnabled.checked = s.speech.enabled;
  f.speechMatches.value = s.speech.matches.join("\n");
  f.speechExclude.value = s.speech.excludeMatches.join("\n");
  f.nsp.value = String(s.speech.noSpeechProbThreshold);
  f.alp.value = String(s.speech.avgLogprobThreshold);
  f.blocklistEnabled.checked = s.speech.blocklistEnabled;
  f.blocklist.value = formatBlocklist(s.speech.blocklist);
  f.vadThreshold.value = String(s.speech.vadPositiveThreshold);
  f.vadRedemption.value = String(s.speech.vadRedemptionMs);
  f.vadMin.value = String(s.speech.minSpeechMs);
  f.vadMax.value = String(s.speech.maxUtteranceSec);
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  fill(sanitizeSettings(stored[STORAGE_KEYS.settings]));
}

async function refreshRegistration(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.registrationStatus);
  const st = stored[STORAGE_KEYS.registrationStatus] as { ok: boolean; at: number; error?: string; note?: string } | undefined;
  if (!st) say(registrationState, "未登録");
  else if (st.ok) say(registrationState, `OK (${new Date(st.at).toLocaleString()})${st.note ? ` – 注記: ${st.note}` : ""}`, "ok");
  else say(registrationState, `エラー: ${st.error ?? "不明"}`, "err");
}

$<HTMLFormElement>("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const lists = {
    "タイマー対象": parsePatternList(f.timersMatches.value),
    "タイマー除外": parsePatternList(f.timersExclude.value),
    "音声認識対象": parsePatternList(f.speechMatches.value),
    "音声認識除外": parsePatternList(f.speechExclude.value),
  };
  const bl = parseBlocklist(f.blocklist.value);
  const errors = Object.entries(lists)
    .filter(([, v]) => v.invalid.length)
    .map(([k, v]) => `${k}: 不正な match pattern: ${v.invalid.join(", ")}`);
  if (bl.invalid.length) errors.push(`ブロックリスト: 形式が不正な行: ${bl.invalid.join(", ")}`);
  if (errors.length) {
    say(settingsResult, errors.join("\n"), "err");
    return;
  }
  const raw = {
    timers: {
      enabled: f.timersEnabled.checked,
      matches: lists["タイマー対象"].patterns,
      excludeMatches: lists["タイマー除外"].patterns,
    },
    speech: {
      enabled: f.speechEnabled.checked,
      matches: lists["音声認識対象"].patterns,
      excludeMatches: lists["音声認識除外"].patterns,
      noSpeechProbThreshold: f.nsp.valueAsNumber,
      avgLogprobThreshold: f.alp.valueAsNumber,
      blocklistEnabled: f.blocklistEnabled.checked,
      blocklist: bl.blocklist,
      vadPositiveThreshold: f.vadThreshold.valueAsNumber,
      vadRedemptionMs: f.vadRedemption.valueAsNumber,
      minSpeechMs: f.vadMin.valueAsNumber,
      maxUtteranceSec: f.vadMax.valueAsNumber,
    },
  };
  // sanitize clamps numbers and drops anything invalid; show what is stored.
  const settings = sanitizeSettings(raw);
  if (settings.speech.enabled && settings.speech.matches.includes("<all_urls>")) {
    const ok = confirm(
      "音声認識を <all_urls> で有効にすると、あらゆるサイトが許可プロンプトなしでマイクを使い文字起こし結果を受け取れます。よろしいですか？",
    );
    if (!ok) return;
  }
  await chrome.storage.local.remove(STORAGE_KEYS.registrationStatus);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  fill(settings);
  say(settingsResult, "保存しました。", "ok");
});

$("settings-reset").addEventListener("click", () => {
  fill(defaultSettings());
  say(settingsResult, "既定値を読み込みました（まだ保存されていません）。");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (STORAGE_KEYS.registrationStatus in changes) void refreshRegistration();
  if (STORAGE_KEYS.apiKey in changes) void refreshKeyState();
});

void refreshMicState();
void refreshKeyState();
void loadSettings();
void refreshRegistration();
