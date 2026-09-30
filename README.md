# Unthrottled Timers & Whisper SpeechRecognition (Chrome MV3)

ページに非常に厳しい CSP（`script-src` / `worker-src` / `connect-src` がほぼ全拒否、`blob:` / `data:` も不可）が付いていても、拡張機能の特権コンテキストを使って次の 2 つを提供する Chrome 拡張機能です。

1. `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` を、**バックグラウンドタブでもスロットリングされない**タイマーに置き換える。
2. `SpeechRecognition` / `webkitSpeechRecognition` 互換の実装を提供し、内部で **Silero VAD（発話区間検出）→ Groq `whisper-large-v3`（文字起こし）** を行う。

配布は少人数向け（ストア非公開）を想定しています。

---

## 目次

- [セットアップ](#セットアップ)
- [アーキテクチャ](#アーキテクチャ)
- [互換性の限界（割り切り）](#互換性の限界割り切り)
- [セキュリティ上の設計](#セキュリティ上の設計)
- [設計メモ](#設計メモ)
- [テスト](#テスト)
- [手動確認チェックリスト](#手動確認チェックリスト)
- [ファイル構成](#ファイル構成)

---

## セットアップ

要件: Node.js 20 以上（22 で確認）、Chrome / Chromium 116 以上。

```sh
npm ci
npm run build        # -> dist/
```

1. `chrome://extensions` を開き「デベロッパー モード」を ON にする。
2. 「パッケージ化されていない拡張機能を読み込む」で `dist/` を選ぶ。
3. 初回インストール時にセットアップページ（`setup.html`）が新しいタブで開きます。拡張機能アイコンのクリック、または拡張機能の「オプション」からも開けます。
4. セットアップページで次を行います。
   - **マイク許可を取得**: 拡張機能オリジンにマイク権限を付与します（Offscreen Document は許可プロンプトを出せないため）。
   - **Groq API キー**: 入力して「検証して保存」。`GET https://api.groq.com/openai/v1/models` で検証してから `chrome.storage.local` に保存します。キーはビルドに埋め込みません。
   - **音声認識を有効にするサイト**: match pattern で登録します（例 `https://example.com/*`）。**既定では空（どのサイトでも無効）** です。理由は[セキュリティ上の設計](#セキュリティ上の設計)を参照。
   - 必要に応じてタイマー置換の対象 / 除外サイト、幻覚フィルタの閾値、VAD パラメータを変更します。
5. 設定変更は **変更後に読み込んだ（再読み込みした）ページ** から反映されます。

`dist/` 以外に `npm run build:e2e` が作る `dist-e2e/` がありますが、これは Groq の代わりにローカルのモックサーバー（`http://127.0.0.1:8787`）へ送るテスト専用ビルドです。**配布には使わないでください。**

---

## アーキテクチャ

```
 Web ページ (厳しい CSP)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ MAIN world  (content script, world:"MAIN", document_start, all_frames)│
 │   main-timers.js : setTimeout 等の置換。最小ヒープで最早期限のみ管理       │
 │   main-speech.js : SpeechRecognition 互換クラス群（状態と DOM イベントのみ）│
 │   ※ API キー・生音声は一切持たない                                        │
 │        ▲ 専用 MessagePort（document_start に window.postMessage で転送）  │
 │        ▼                                                              │
 │ ISOLATED world (content script)                                       │
 │   isolated-timers.js / isolated-speech.js : 検証付きの中継のみ              │
 └────────┬─────────────────────────────────────────────────────────────┘
          │ chrome.runtime.sendMessage({t:"ensure-offscreen"}) ──────────┐
          │ chrome.runtime.connect({name:"bae-timers"|"bae-speech"})      │
          ▼                                                              ▼
 ┌─────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ Offscreen Document (拡張オリジン, 1 個だけ)   │◀──────▶│ Service Worker (常駐しない)      │
 │ reasons: WORKERS, USER_MEDIA             │ get-   │ - Offscreen の作成/存在確認       │
 │  TimerHost ─ Dedicated Worker            │ config │   (offscreen / getContexts)     │
 │    (ポートごとに相対 ms の timeout 1 本)       │        │ - content script の動的登録      │
 │  SpeechManager                           │        │ - 設定+API キーを Offscreen にだけ │
 │    AudioHub: getUserMedia 1 本 + Silero   │        │   渡す / MIC バッジ表示           │
 │      VAD 1 個 (vad-web, ORT wasm 同梱)     │        └──────────────────────────────┘
 │    RecognitionSession × n (セッションごとに  │                    ▲ chrome.storage.local
 │      Segmenter → WAV → Groq → フィルタ)     │                    │
 └──────────────────┬──────────────────────┘        ┌──────────────────────────────┐
                    │ HTTPS (Bearer キー)             │ Setup ページ (setup.html)       │
                    ▼                                 │ マイク許可 / API キー / 各種設定    │
             api.groq.com/openai/v1                   └──────────────────────────────┘
             /audio/transcriptions
```

### タイマーの流れ

- MAIN world に Chrome 準拠のスケジューラ（`src/main/timers/scheduler.ts`）があり、コールバックは **常にページのメインスレッド** で実行されます。
- 起床手段は二重化しています。
  - (a) `document_start` に退避したネイティブ `setTimeout`（最早期限 1 本だけ）。
  - (b) **ドキュメントが hidden のときだけ**、Offscreen 内 Worker による起床（MAIN → ISOLATED → Port → Worker → Port → ISOLATED → MAIN）。
  - 先に届いた方で処理し、もう一方は何もせず再アームするだけです（冪等）。
- 1 回の起床で実行するコールバックは 1 つだけで、続きは専用 `MessageChannel` 経由の別タスクで実行します（ネイティブ同様、コールバック間でマイクロタスクが実行される）。
- ネイティブ `setTimeout` の起床時も、まず専用 `MessageChannel` に 1 ホップしてから処理・再アームします（後述: ネイティブ側のネストクランプ回避）。
- Port の切断（Offscreen 再作成、bfcache、フレーム破棄）時は ISOLATED が自動で再接続し、MAIN が最早期限を再送します。Offscreen 側はポート切断時に Worker のタイマーを自動で破棄します。

### 音声認識の流れ

1. ページが `start()` → MAIN が `{t:"start", sid, lang, continuous, maxAlternatives}` を送信。
2. ISOLATED が Permissions Policy（`microphone`）を確認し、`<html lang>` と `navigator.language` を付けて Offscreen へ。
3. Offscreen が Service Worker から設定と API キーを取得し、送信元フレーム URL が許可リストに入っているか再確認、言語解決、拡張機能のマイク権限確認。
4. 共有 `AudioHub`（マイク 1 本 + Silero VAD 1 個）からフレーム（16 kHz, 512 サンプル = 32 ms）と発話確率を受け取り、セッションごとの `Segmenter` で発話区間を切り出し。
5. 発話区間を 16bit PCM WAV にして Groq に送信 → `verbose_json` を幻覚フィルタにかけ → 結果だけを MAIN に返す。
6. 全セッション終了から 3 秒後にマイクを解放します（`onend` で再 `start()` するアプリでマイクが点滅しないように）。

---

## 互換性の限界（割り切り）

### SpeechRecognition

| 項目 | 内容 |
| --- | --- |
| **interimResults** | Whisper は暫定結果を出せないため、`interimResults` の値に関わらず **発話終了後に `isFinal === true` の結果のみ** を返します（プロパティ自体は読み書き可能）。 |
| **confidence** | Whisper は信頼度を返さないため、**保持したセグメントの `avg_logprob` を区間長で重み付け平均し `exp()` した近似値** です。`segments` が無い応答では 0.5 を返します。Chrome の値とは意味が異なります。 |
| **レイテンシ** | 発話終了の判定（既定で 800 ms の無音）＋ WAV アップロード ＋ Groq の処理時間がかかります。Chrome の単発モードより結果は遅れます。 |
| **maxAlternatives** | 常に候補は最大 1 個（`maxAlternatives` が 0 の場合は 0 個）。 |
| **イベント順序** | Chromium の実装に合わせています（[設計メモ](#音声認識のイベント順序)）。ただし `start` は設定・権限チェック通過後に発火するため、API キー未設定などのエラーは `start` 無しで `error → end` になります。 |
| **nomatch** | 単発モードで発話を検出したのに結果が空/フィルタで除外された場合に `nomatch → end` を発火します（Chrome は通常 `end` のみ）。連続モードでは黙って捨てます。 |
| **isTrusted** | スクリプトから生成したイベントなので `event.isTrusted === false` です。 |
| **grammars** | `SpeechGrammarList` はスタブです（Chrome 同様、認識には使いません）。 |
| **未実装** | 新しい仕様の `start(MediaStreamTrack)`、`processLocally`、`SpeechRecognition.available()/install()`、`phrases` などは未実装です。 |
| **transcript の空白** | Chrome は連続モードの 2 件目以降に先頭スペースを付けることがありますが、本実装は前後の空白を除去します。 |
| **複数タブ** | マイクと VAD は共有しますが、文字起こしはセッションごとに行うため、同時に聞いている各セッションが同じ音声を個別に Groq に送ります。 |
| **ページ** | Chrome のネイティブ実装は登録サイト上では常に置き換えます（ネイティブがあっても）。 |

### タイマー

| 項目 | 内容 |
| --- | --- |
| **順序の非厳密性** | 同時刻に期限を迎えたタイマーは「期限 → スケジュール順（初回は ID 順）」で実行します。Chrome 内部の複数タスクキュー間の優先度（即時タイマーと遅延タイマーの別キュー、ページの他タスクとの優先度など）までは再現しません。ネイティブと比べて ±1 ms 程度の差は出ます。 |
| **バックグラウンド** | hidden 中は Worker 経由で起床するため、3 ホップ分（通常 1 ms 未満〜数 ms）の遅延が乗ります。Chrome がタブ自体を凍結（Memory Saver / タブ破棄 / Energy Saver の freeze）した場合は、ページのスクリプト自体が動かないので回避できません。 |
| **可視時** | 可視タブではネイティブ `setTimeout` のみで起床します（通信コスト削減）。可視のまま Chrome にスロットリングされる状況（非表示のクロスオリジン iframe など）では Worker 経由の起床は使われません。 |
| **文字列ハンドラ** | CSP が `unsafe-eval` を許さないページでは、ネイティブ同様 `setTimeout("code")` は 0 を返します。Trusted Types（`require-trusted-types-for 'script'`）の強制はネイティブと細部が異なる可能性があります。 |
| **対象外** | `requestAnimationFrame`、Worker 内のタイマー、`scheduler.postTask` などは置換しません。 |
| **about:blank 等** | `matchOriginAsFallback` に対応した Chrome（Chrome 141 の E2E で登録成功を確認）では同一オリジンの about:blank / srcdoc iframe にも注入を試みますが、非対応の Chrome や、パスが `/*` でない match pattern では登録を付け直して注入しません（そのフレームのネイティブ `setTimeout` を使うコードはスロットリングされ得ます）。 |

### 検出可能性

完全な偽装は目標にしていません。ページは例えば次の方法で拡張機能の存在を検出できます。

- エラーの `stack` に `chrome-extension://<id>/main-*.js` のフレームが現れる。
- `Function.prototype.toString` が Proxy に置き換わっている（`toString` の結果自体は `[native code]` 風に見せています）。
- 独自クラスの挙動差（`isTrusted`、プロパティ記述子の細部など）、`setTimeout` の ID の進み方、タイミングの差。
- `web_accessible_resources` は公開していないため、リソース URL の取得による検出はできません。

---

## セキュリティ上の設計

- **API キーと生音声は MAIN world に一切渡しません。** MAIN に届くのはイベント種別と文字起こし結果（およびエラーコード）だけです。
- API キーは `chrome.storage.local` に保存し、Service Worker が **送信元が自拡張の Offscreen Document（URL 一致・タブ無し）であることを確認したときだけ** 渡します。content script からの `get-config` は拒否します。
- `chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})` で content script からストレージを読めなくしています（Chromium の現行実装では local でも有効・永続化されることをソースで確認。古い Chrome で未対応の場合は警告ログのみ）。
- **音声認識は許可リスト方式（既定は空）です。** 置換した `SpeechRecognition` は拡張機能のマイク権限を使うため、登録したサイトは **サイトごとの許可プロンプトなしで** マイクを使い、文字起こし結果を受け取れます。そこで:
  - 登録は match pattern の許可リストで行い、`<all_urls>` の登録時は確認ダイアログを出します。
  - content script の登録範囲に加え、Offscreen 側でも送信元フレーム URL を許可リストと照合します（多層防御）。
  - iframe の Permissions Policy（`allow="microphone"`）が無ければ `not-allowed` にします（ネイティブと同じ挙動）。
  - マイク使用中は拡張機能アイコンに赤い **MIC** バッジを表示します。
  - 同時セッション数を 1 フレーム 8 / 全体 32 に制限します。
- MAIN ↔ ISOLATED は専用 `MessagePort` で通信し、ハンドシェイクは `document_start` に capture フェーズで登録したリスナーが `stopImmediatePropagation()` してページのリスナーから隠します。MAIN 側で使うネイティブ関数（`postMessage`、`MessagePort` のメソッド/セッター、`MessageEvent` のゲッター、`addEventListener` 等）は `document_start` 時点で退避し、後からページがプロトタイプを書き換えてもポートが漏れにくいようにしています。これは防御であって完全ではありません（漏れても得られるのは公開 API と同等の操作だけです）。
- ISOLATED と Offscreen はすべての受信メッセージをスキーマ検証します。ページに見えるエラーメッセージからは `chrome-extension://` URL を除去します（拡張 ID の露出防止）。
- 拡張ページの CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://api.groq.com; ...`。Groq 以外への通信を拡張ページからできないようにしています。
- Setup ページは動的な文字列を `textContent` だけで表示し、保存済みキーは先頭 4 文字と末尾 4 文字しか表示しません。
- ログに API キーを出しません（`Authorization` ヘッダ以外では使いません）。
- 許可リストに入れたサイトは、ユーザーの Groq の利用枠を消費できます。信頼できるサイトだけを登録してください。

---

## 設計メモ

依頼文の内容で Chrome の実挙動と食い違っていた点・判断が割れた点を、根拠とともに記録します。Chromium のソースは 2026-09 時点の `main` を参照しました。

### タイマー（Chromium `third_party/blink/renderer/core/scheduler/dom_timer.cc`, `platform/timer.cc`）

- **ネストクランプの閾値**: 依頼文は「閾値を超えたら 4 ms」でしたが、Chromium の現行実装は `kSpecCompliantMaxTimerNestingLevel = 6`、ネストレベル（非タイマー文脈から作ると 1 から始まる）が **6 を超えたとき**（= 7 段目以降）に 4 ms 未満を 4 ms にします。これは HTML 仕様（0 始まりで「5 を超えたら」）と同じ結果です。本実装も同じです。
- **setInterval**: Chromium は各発火のたびにネストレベルを 1 増やし、**ちょうど 7 になった時点で** 間隔を 4 ms に引き上げます（`AugmentRepeatInterval`）。インターバル中に作られたタイマーのネストレベルは「インクリメント前の値 + 1」です。これも再現しています。
- **setInterval の 1 ms クランプ**: `kSetIntervalWithoutClamp` が既定で有効なため、現行 Chrome には 1 ms クランプはありません（`setTimeout` にもありません）。
- **次回スケジュールのタイミング**: 依頼文は「コールバック実行後に次回を再登録」でしたが、Chromium は `TimerBase::RunInternal` で **コールバック実行前に** 次回時刻を計算します（`(now + interval/20).SnappedToNextTick(前回の予定時刻, interval)` によるドリフトしない格子）。本実装はこれに合わせました。コールバック内で `clearInterval` された場合は再登録済みのエントリが無効になるため、「実行中に clear されたら再登録しない」という要件は満たします。
- **遅延値の変換**: 依頼文は「32bit 符号付き整数を超える値はオーバーフローして即時扱い」でしたが、正確には WebIDL `long`（`[EnforceRange]` なし）変換 = ECMAScript `ToInt32` です。`2**31` → 負数 → 0（即時）ですが、`2**32 + 5` → **5 ms** になります（即時ではない）。`"100"` → 100、`undefined/null/NaN/±Infinity` → 0。E2E でネイティブと一致することを確認済みです。
- **ID**: `DOMTimerCoordinator::NextID` と同じく 1 から始まる循環カウンタで、`INT_MAX` の次は 1 に戻り、使用中の ID を飛ばします。単発タイマーはコールバック実行 **前** に登録解除されます（コールバック内での `clearTimeout(自分)` は何もしない）。
- **文字列ハンドラ**: Chromium は **スケジュール時** に CSP の eval 許可を確認し、拒否なら（違反レポートを出して）0 を返します。空文字列も 0 を返します。本実装はスケジュール時に `new Function(code)` でコンパイルだけ行って CSP 判定し（`EvalError` なら 0）、実行時は間接 `eval` を使います。MAIN world の content script にもページの CSP が適用されることを E2E で確認しました。
  - 注意: Playwright の `page.evaluate`（CDP `Runtime.evaluate`）は呼び出しスタック上の CSP eval チェックを無効にするため、E2E ではシナリオを実クリックから起動しています。
- **起床手段の最適化（実測で判断）**:
  - ネイティブ `setTimeout` のコールバック内から次のネイティブ `setTimeout` をアームすると、Chrome がそれを「ネストしたタイマー」と数えるため、起床チェーン自体にクランプ/優先度低下がかかり、ネストした 4 ms タイマーが実測で 9〜13 ms 間隔に劣化しました。ネイティブ起床後はまず専用 `MessageChannel` に 1 ホップしてから再アームする方式にしたところ、ネイティブとの差は約 1 ms 以内になりました。
  - 可視タブでは Worker 起床を使わず、`visibilitychange`（`window` の capture で先頭登録）で hidden になったときだけ Worker をアームします。可視時の毎回の 3 ホップ通信を避けるためです。hidden 中は「既に期限が来ている」タイマーもネイティブ `setTimeout(0)` ではなく `MessageChannel` で実行します。
  - 実測（ヘッドレス Chromium 141、10 秒間 hidden、`setInterval(…, 100)`）: **置換版 100 回（最大間隔 約 102〜107 ms）、ネイティブ 10 回**。Offscreen Document を途中で閉じても自動再作成・再接続して 100 回。
- **退避**: 各 MAIN バンドルはモジュール評価時（`document_start`）にネイティブ関数を退避します。

### MAIN ↔ ISOLATED ハンドシェイク

- 方式: MAIN が `MessageChannel` を作り、`window.postMessage({magic, kind:"hello", channel}, "*", [port2])` で転送。ISOLATED は `document_start` に capture リスナーを登録し、最初の HELLO だけを受理して ACK を返します。ISOLATED は起動時に READY を 1 回投げ、MAIN は ACK 前に READY を見たら新しいチャネルで HELLO を再送します。これで **どちらのスクリプトが先に実行されても** 成立します。以降の HELLO は ISOLATED が `port.close()` して破棄します。
- `magic` はビルドごとのランダム値です（汎用的な検出・偽装を少し難しくするだけで、秘密ではありません）。
- **Chrome の実挙動で成立することを E2E で確認済み**（厳しい CSP のページ、iframe 内でも動作）。
- 成立しなかった場合の代替案（検討のみ・未実装）:
  1. ISOLATED → MAIN の向きで同様に転送する（対称なので同じ性質）。
  2. `CustomEvent` の `detail` は world 間で構造化複製されるが `MessagePort` を転送できないため、ポートを使わずビルド時 `magic` を含むイベント名で `document` 上の `CustomEvent` をやり取りする（ページからの盗聴耐性は下がる）。
  3. Service Worker から `chrome.scripting.executeScript({world:"MAIN", func, args})` で設定を注入する（非同期のため `document_start` の保証が無い）。
- 既知の弱点: `page.js` が外部スクリプトである E2E では、ページのリスナーがハンドシェイクを観測しないことを確認していますが、これはハンドシェイクの配送がページのスクリプト実行より先に終わることが多いためでもあり、強い証明ではありません。防御の本体は「`document_start` に登録した capture リスナーが先に `stopImmediatePropagation()` する」ことです。

### content script の登録

- `document_start` の時点で ON/OFF・サイト別の設定を同期的に反映する必要があり、content script から `chrome.storage` を非同期に読むと間に合わないため、**`chrome.scripting.registerContentScripts` による動的登録** にしました（設定変更時に Service Worker が登録し直す）。このため `host_permissions` に `<all_urls>` が必要です（`https://api.groq.com/*` も明示）。
- タイマーは `matchOriginAsFallback: true` で about:blank 系フレームにも注入を試み、登録に失敗（非対応の Chrome、パスが `/*` でないパターン等）したら付けずに登録し直し、Setup の「登録状態」に注記を出します。音声認識には付けません（Offscreen 側の URL 照合で about:blank は許可されないため）。
- 機能ごとに MAIN / ISOLATED の 2 本を同じ条件で登録し、ISOLATED のバンドルもチャネル別（`isolated-timers.js` / `isolated-speech.js`）です。したがって Port は「フレームごと・content script ごとに 1 本」です。

### Offscreen Document / Service Worker

- Offscreen Document は **`chrome.runtime` 以外の拡張 API を使えない** ため、設定と API キーは Service Worker に `get-config` で都度問い合わせます（キャッシュしない）。
- Service Worker は `runtime.onConnect` を持たないようにしています（content script の Port は Offscreen だけが受ける）。content script は接続前に `ensure-offscreen` を送り、Service Worker を起こして Offscreen を作らせます。Offscreen が `onConnect` を登録する前に接続してしまった場合は、Offscreen から `hello` が来ないまま切断されるので ISOLATED が再試行します。
- `reasons: ["WORKERS", "USER_MEDIA"]`。どちらも Chrome が自動で閉じる理由ではありませんが、閉じられても上記の仕組みで再作成されます。
- Service Worker はステートレスで、30 秒で停止しても問題ありません（登録は永続、Offscreen はオンデマンド作成、設定は毎回ストレージから読む）。

### 音声認識のイベント順序

Chromium の `content/browser/speech/speech_recognizer_impl.cc` と `third_party/blink/renderer/modules/speech/speech_recognition.cc` を確認しました。

- Blink は `soundstart` と `speechstart` を連続で、`speechend` と `soundend` を連続で発火します。
- 単発モードの発話終了は `StopCaptureAndWaitForResult`: `speechend, soundend → audioend →（最終結果）result → end`。依頼文の「result → speechend → soundend → audioend → end」とは異なり、**本物は result が audioend の後** です。本実装は本物に合わせました（Whisper は発話終了後にしか結果を出せないので、この順序が自然でもあります）。
- `abort()` / エラー（`Abort()`）: `[speechend, soundend]（音声検出後なら）→ [audioend]（キャプチャ中なら）→ error → end`。
- `no-speech`: 音声キャプチャ開始から `kNoSpeechTimeoutMs = 8000` ms 発話が無ければ `audioend → error(no-speech) → end`。
- 単発モードの発話終了判定は Chrome では 0.5〜1 秒の無音。本実装は VAD の `vadRedemptionMs`（既定 800 ms）。
- 連続モードは Chrome と同様、発話後 **15 秒無音で自動終了** します。
- `start()` の二重呼び出しは `InvalidStateError`（メッセージも Chrome と同じ "recognition has already started."）。`stop()` / `abort()` は開始前・停止処理中は何もしません（`stop()` 後の `abort()` も無視 = Chrome と同じ）。`end` の前に内部状態を idle に戻すので、`onend` 内から再 `start()` できます。
- 拡張との接続が切れた場合は Chrome の `OnConnectionError` と同じく `error(network) → end`。

### 言語

- 決定順: `recognition.lang` → `<html lang>` → `navigator.language`。
- Groq の対応言語一覧は公式 SDK（`groq-python` の `transcription_create_params.py`、OpenAPI から生成）から取得しました。ISO-639-1 の 2 文字が基本ですが `haw`、`yue` の 3 文字があり、ジャワ語は Whisper 本家の `jw` ではなく **`jv`** です。旧コード（`iw`→`he`、`in`→`id`、`nb`→`no`、`fil`→`tl` 等）は変換します。
- `recognition.lang` が **明示的に** 未対応言語なら `language-not-supported`。`<html lang>` / `navigator.language` 由来で未対応の場合はページの責任ではないので、`language` を送らず Whisper の自動判定に任せます。

### 音声処理

- `@ricky0123/vad-web` 0.0.31 の `MicVAD` を使用（Silero **v5** モデル、AudioWorklet、onnxruntime-web 1.23 の wasm）。モデル・worklet・`ort-wasm-simd-threaded.{wasm,mjs}` はビルドスクリプトで `dist/vad/` にコピーし、CDN からは読みません。`ort.env.wasm.numThreads = 1`、`proxy = false`（cross-origin isolation が無いため）。
- マイクストリームは自前で取得して `getStream` に渡し、`pauseStream/resumeStream` を無効化（MicVAD にストリームを止めさせない）。vad-web 内部の区間検出は使わず（閾値 1 で実質無効化）、`onFrameProcessed` の確率をセッションごとの `Segmenter` に流します。これで **マイクと VAD（ステートフルなモデル）は 1 つ、区間検出はセッションごと** にでき、`stop()` 時にその時点までの音声を確定させられます。
- 1 発話の最大長は既定 25 秒（16 kHz・16bit で約 800 KB。Groq の上限 25 MB に十分収まる）。超えたら強制分割します。`minSpeechMs`（既定 250 ms）未満の発話はノイズとして捨てます。
- 発話前 300 ms のパディングを付けます。
- マイク権限は Offscreen で `navigator.permissions.query({name:"microphone"})` を確認し、未許可なら `not-allowed`（Setup ページへの誘導ログを出す）。`getUserMedia` の `NotAllowedError` も `not-allowed`、それ以外は `audio-capture`。

### Groq / 幻覚対策

- `POST /openai/v1/audio/transcriptions`（multipart）、`model=whisper-large-v3`、`response_format=verbose_json`、`temperature=0`、`language=`（自動判定時は省略）。
- 429 / 5xx / ネットワークエラーは最大 3 回リトライ（500 ms・1 s・2 s ＋ジッタ、`Retry-After` があれば優先、上限 10 s）、1 回あたり 30 秒でタイムアウト → 最終的に `network`。401 / 403 は即 `not-allowed` にし、ISOLATED world のコンソールに Setup ページの URL を案内します（ページのスクリプトからはフックできないコンソール）。
- 幻覚フィルタはセグメント単位で、`no_speech_prob > 閾値`（既定 0.6）**または** `avg_logprob < 閾値`（既定 -1.0）のものを捨てます。Whisper 本家は「かつ」で判定しますが、無音で出る定型フレーズは `avg_logprob` が高いことがあり「かつ」では残るため、「または」にしました（閾値は Setup で変更可）。さらに NFKC・小文字化・空白と記号除去で正規化した **言語別ブロックリスト**（既定で「ご視聴ありがとうございました」等）と完全一致したセグメント/全文を捨てます。言語が自動判定のときは全言語のリストを適用します。

---

## テスト

```sh
npm run typecheck   # tsc (src と tests)
npm test            # vitest: 単体テスト
npm run test:e2e    # dist-e2e をビルドして Playwright + Chromium で E2E
```

E2E は Playwright 1.56 同梱の Chromium（141）をヘッドレス（`--headless=new` 相当）で使い、拡張を `--load-extension` で読み込みます。`HEADED=1 xvfb-run -a npm run test:e2e` で headed でも実行できます。

| 種別 | ファイル | 内容 |
| --- | --- | --- |
| 単体 | `tests/unit/scheduler.test.ts` | ヒープ、ID 共有・循環、clear の共通化、クランプ（ネスト/インターバル）、順序、ドリフトしない格子、例外、WebIDL 変換 |
| 単体 | `tests/unit/stt.test.ts` | Segmenter、WAV、Groq クライアント（リクエスト形式、リトライ、401、中断）、幻覚フィルタ、セッションのイベント順序（単発/連続/stop/abort/no-speech/15 秒無音/エラー） |
| 単体 | `tests/unit/shared.test.ts`, `forms.test.ts` | match pattern、言語解決、設定のサニタイズ、プロトコル検証、Setup の入力解析 |
| E2E | `tests/e2e/timers.spec.ts` | 厳しい CSP のページで **同じ操作列をネイティブ（除外パス）と置換版で実行して結果を比較**（ID、cross-clear、引数/this、文字列ハンドラ、例外報告、遅延値変換、マイクロタスク順、ネストクランプ、iframe） |
| E2E | `tests/e2e/background.spec.ts` | 生 CDP で Chromium を起動し、非アクティブタブで `setInterval(100)` を比較（置換 100 回 / ネイティブ 10 回）。Offscreen を閉じても復旧 |
| E2E | `tests/e2e/speech.spec.ts` | Chromium の偽マイク（espeak-ng で生成した英語音声 WAV）＋モック Groq で、単発/連続/abort/二重 start/ブロックリスト/429 リトライ/401/未対応言語/API キー未設定/iframe と複数タブ同時/許可リスト外/no-speech |
| E2E | `tests/e2e/setup.spec.ts` | インストール時の自動オープン、マイク許可、キー検証（不正/正常）、パターン検証、登録内容、機能 OFF |

補足:
- Playwright はページのフォーカスエミュレーション等によりタブを常に visible に見せ、既定で `--disable-background-timer-throttling` 等を付けるため、バックグラウンドの検証は Playwright を使わず **生の CDP**（`tests/e2e/cdp.ts`）で行っています。
- 実際の Groq API、実マイク、実際の日本語音声はテストしていません（下のチェックリスト参照）。

---

## 手動確認チェックリスト

自動テストで確認できていない、または実ブラウザ・実マイク・実 API でしか確認できない項目です。

### 必須項目

- [ ] **厳しい CSP のテストページ**（別拡張で CSP を付与、または `Content-Security-Policy` ヘッダ / `<meta http-equiv>` で `default-src 'none'; script-src 'self'; worker-src 'none'; connect-src 'none'` 程度を再現）で、タイマー置換と SpeechRecognition（実マイク・実 Groq）が動くこと。
  - 特に「対象ページに CSP を付けている既存の他拡張」と同時に入れた状態で確認すること（E2E はサーバーのヘッダで再現したもののみ）。
- [ ] **バックグラウンドタブで `setInterval(…, 100)` が実際にスロットリングされないこと**（通常の Chrome で、タブを切り替えた状態 / ウィンドウを最小化した状態 / 別ウィンドウで覆った状態のそれぞれで、ネイティブ（除外サイト）と回数を比較）。
- [ ] **長時間（30 分以上）放置後** も、タイマーと認識が動くこと。バックグラウンド 5 分以降の Chrome の「集中的なスロットリング」下でも回数が落ちないこと。`chrome://extensions` の Service Worker が停止した後でも動くこと。途中で Offscreen Document が破棄された場合（`chrome://inspect/#other` から offscreen を閉じる等）も再作成されること。
- [ ] **複数タブ同時の音声認識**、および **iframe 内での動作**（同一オリジン / クロスオリジン。クロスオリジン iframe は `allow="microphone"` が無いと `not-allowed` になること）。
- [ ] **日本語・英語での認識**（`lang="ja-JP"` / `"en-US"`、未指定で `<html lang>` / `navigator.language` が使われること）、**無音・環境音だけのときに幻覚が出ないこと**（「ご視聴ありがとうございました」等が出ない）、**no-speech エラーの挙動**（約 8 秒で `audioend → error(no-speech) → end`）。
- [ ] **API キー未設定・不正・レート制限時のエラー挙動**: 未設定 → `service-not-allowed`、不正 → `not-allowed`、429 → 数回リトライ後に成功 or `network`。いずれもページの DevTools コンソール（拡張機能のコンテキスト）に Setup ページへの案内が出て、キーがログに出ないこと。

### その他

- [ ] 初回インストールで Setup ページが開くこと。拡張機能アイコンのクリックで Setup が開くこと。
- [ ] Setup の「マイク許可を取得」で実際の許可プロンプトが出て、許可後に状態が「許可済み」になること。拒否した場合の案内。
- [ ] マイク使用中に拡張機能アイコンに **MIC** バッジが出て、全セッション終了の約 3 秒後に消えること。OS のマイク使用インジケーターも同様に消えること。
- [ ] 実 Groq で `verbose_json` の `segments` に `no_speech_prob` / `avg_logprob` が含まれること、フィルタ閾値の変更が反映されること。
- [ ] 実マイクでの発話区間検出（`vadPositiveThreshold` / `vadRedemptionMs` / `minSpeechMs` の既定値が妥当か）、25 秒を超える連続発話が分割されること。
- [ ] Offscreen Document で `AudioContext` が `running` になること（自動再生ポリシー。E2E のヘッドレス環境では問題なし）。`audio-capture` になる場合は error イベントの `message` が `AudioContext is suspended.` になる。
- [ ] ネイティブ `SpeechRecognition` と同じページで、イベント順序（`start, audiostart, soundstart, speechstart, speechend, soundend, audioend, result, end`）が期待どおりであること。`onend` 内から再 `start()` するアプリ（常時聞き取り型）が動くこと。
- [ ] 同じページで他の拡張が `setTimeout` を置き換えている場合の共存。
- [ ] 設定変更（ON/OFF、サイトの追加・除外）が再読み込み後のページに反映されること。
- [ ] bfcache（戻る/進む）から復帰したページでタイマー・認識が動くこと。
- [ ] 拡張機能を更新/再読み込みした後、既存タブ（古い content script）がエラーを出し続けないこと（再読み込みで復旧すること）。
- [ ] 最低バージョン付近の Chrome（116〜）で、`matchOriginAsFallback` 非対応時に登録が「注記あり OK」になり動作すること。

---

## ファイル構成

```
src/
  manifest.json                 ビルド時に version 等を埋めて dist/ に出力
  shared/                       全コンテキスト共通（設定, match pattern, 言語, メッセージ検証）
  main/                         MAIN world（ページと同じ world）
    natives.ts                  document_start でのネイティブ退避, toString 偽装
    bridge.ts                   MAIN 側ハンドシェイクと専用ポート
    timers/                     scheduler.ts（純ロジック）, heap.ts, webidl.ts, install.ts
    speech/classes.ts           SpeechRecognition 互換クラス群
    timers-entry.ts, speech-entry.ts
  isolated/relay.ts             ISOLATED world の中継（チャネルごとにビルド）
  background/                   Service Worker, content script 動的登録
  offscreen/                    Offscreen Document, タイマー Worker
    stt/                        hub（マイク+VAD）, segmenter, session, manager, groq, filter, wav
  setup/                        Setup / Options ページ
scripts/build.mjs               esbuild + 同梱アセットのコピー
tests/unit/                     vitest
tests/e2e/                      Playwright（+ 生 CDP ハーネス, 偽マイク用 WAV）
```

ライセンス: CC0-1.0（`LICENSE`）。同梱する `@ricky0123/vad-web`（ISC）、`onnxruntime-web`（MIT）、Silero VAD モデル（MIT）はそれぞれのライセンスに従います。
