# 互換性

[English](compatibility.md)

OpenVessel は Node.js 自身の JavaScript（`lib/`）を動かし、ネイティブの部分を TypeScript で作り直しています。
そのため「X は動くか」は、たいてい「ブラウザのタブが用意できないものを要るか」で決まります。
このページには、何を測っているか、何が動くか、何が動かないかを、どれも理由と一緒に書いています。

## Node.js 自身の試験

測り方（`test/node-compat/run.mjs`）:

- 対象は、OpenVessel が扱うモジュール（fs・stream・buffer・events・child_process・process・worker_threads・
  crypto・zlib・vm・timers・モジュールの読み込み・util・url・readline など）の、Node.js 自身の
  `test/parallel` の試験です。版は同じ Node（v22.23.4）のもの。
- 本物の Node.js（Linux）で通る試験だけを数えます（`--baseline`）。
- Node の公開された振る舞いではなく内部を試すものは、範囲の外として流しません。
  `--expose-internals` が要るもの、`internalBinding`/`process.binding` を呼ぶもの、V8 のフラグを使うもの、
  inspector・プロファイラ・スナップショット・レポート・単一実行ファイル・パーミッションモデルを使うものです。
- ブラウザでは通せない試験は、理由と一緒に `test/node-compat/limits/*.json` に書きます。
  **目標はそれ以外のすべて**で、集計は「通過 / 目標」を出し、100% を目指します。

結果（2026-10-24・Chrome）:

| モジュール | 通過 | 目標 | 対象外（理由つき） |
|---|---:|---:|---:|
| fs | 173 | 173 | 4 |
| stream | 165 | 165 | 1 |
| worker_threads | 118 | 118 | 11 |
| crypto | 96 | 96 | 2 |
| child_process | 94 | 94 | 1 |
| vm | 78 | 78 | 11 |
| process | 73 | 73 | 1 |
| buffer | 60 | 60 | 1 |
| zlib | 60 | 60 | 0 |
| timers | 47 | 47 | 0 |
| module, require | 48 | 48 | 0 |
| events, event-emitter | 33 | 33 | 0 |
| stream2, stream3, readable | 35 | 35 | 0 |
| url, whatwg-url | 36 | 36 | 0 |
| console | 19 | 19 | 0 |
| util | 18 | 18 | 0 |
| assert | 17 | 17 | 1 |
| path | 16 | 16 | 0 |
| readline | 13 | 13 | 0 |
| process.nextTick, microtasks, promises | 18 | 18 | 0 |
| async_hooks (AsyncLocalStorage) | 7 | 7 | 1 |
| os | 6 | 6 | 0 |
| querystring | 4 | 4 | 0 |
| string_decoder | 3 | 3 | 0 |
| **合計** | **1237** | **1237 (100%)** | **34** |

対象外にした 34 本の理由の内訳です（試験ごとの理由は `test/node-compat/limits/` の各ファイルにあります）。

| 理由 | 本数 |
|---|---:|
| 動いている JavaScript を止める（`vm` の `timeout`・`breakOnSigint`）、または専用のマイクロタスクキューを持つコンテキスト（`microtaskMode`） | 9 |
| inspector・ヒープスナップショット・スレッドごとのヒープ上限 | 7 |
| 専用の組み込みオブジェクトを持つコンテキスト（別の V8 realm） | 4 |
| HTTP/2。ブラウザの制約ではなく未実装です（nghttp2 の上の `node_http2.cc` の移植は、それだけで大きな仕事です） | 4 |
| 下に OS がない: 別のプログラム（`python3`）・`RLIMIT_FSIZE`・実行中のタイムゾーン変更・UDP | 4 |
| 2 GiB 以上を一度に確保する | 2 |
| macOS だけの試験（OpenVessel は Linux として振る舞うので、試験が自分で飛ばします） | 2 |
| `await` の後の `AsyncLocalStorage`（V8 の promise hooks） | 1 |
| OpenSSL の設定ファイル | 1 |

測り直すには `node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report`
（表は `test/node-compat/results/port/REPORT.md` に出ます）。
<!-- numbers: updated with each full run -->

## ブラウザでは動かせないものと、その理由

作業が足りないのではなく、場の制約です。どれにも、ブラウザのタブが課す理由があります。

### 通信

| 動かないもの | 理由 | 代わりに起きること |
|---|---|---|
| インターネットへの、HTTP 以外のプロトコルの生の TCP（DB・SMTP・SSH・Redis など） | Web ページはソケットを開けない | 外への `net.connect` はカーネルが受け、HTTP/1.1 を `fetch` で話す。HTTP でなければ切る |
| クロスオリジンの要求を許さないサーバー | 外への要求はブラウザの `fetch` で行い、CORS がかかる | `fetch failed`（`ECONNREFUSED`）になり、CORS と分かる文言を出す。Google Fonts の一覧や多くの RSS がこれ |
| UDP（`dgram`）・生の DNS の問い合わせ | ブラウザに UDP は無い | ホスト名は仮の番地に解決し、HTTP の橋渡しが名前に戻す |
| `net`/`tls` 経由の外への WebSocket | HTTP の橋渡しは要求と応答だけ | `501 Not Implemented` を返す（グローバルの `WebSocket` は使える） |
| 独自の CA・クライアント証明書・TLS の細部 | TLS とその確認はブラウザの `fetch` が行い、プロセスには平文が届く | ブラウザが証明書を受け入れれば `tls.connect` は `authorized: true` でつながる。`getPeerCertificate()` は本物の証明書ではなく要約を返す |
| 実際のポートでの待ち受け | タブの外からはつなげない | サーバーは仮想ポートで待ち受け、プレビューの iframe は Service Worker 経由でつながる |
| HTTP/2（`node:http2`） | ブラウザの制約ではなく未実装（nghttp2 の上の `node_http2.cc` の移植は、それだけで大きな仕事） | `require('node:http2')` は読み込める。サーバーやセッションを作ると「HTTP/2 is not supported in OpenVessel」を投げる。HTTP/1.1 のサーバーとクライアントは動く |

### ネイティブのコード

| 動かないもの | 理由 | 代わりに起きること |
|---|---|---|
| ネイティブのアドオン（`.node`）全般 | ブラウザは機械語を読み込めない | WebAssembly 版のあるものはそれを入れる（esbuild・rollup・rolldown・lightningcss・sharp・napi-rs の `wasm32-wasi` 版）。ほかは、あれば互換パッケージ（下）を入れる |
| `workerd`（Cloudflare の実行系。`@astrojs/cloudflare` が事前描画と `astro dev` に使う） | V8 を中に抱えた C++ のプログラムで、WebAssembly 版は無く、作ることもできない | install は通り、アダプターが workerd を起動するところでビルドが落ちる |
| Koffi などの FFI | ネイティブの共有ライブラリを呼ぶ | サイト集で Koffi を要する `cn-font-split` には、その WebAssembly 版を使う互換パッケージがある |
| ヘッドレスブラウザ（Playwright/Puppeteer のブラウザ。例: Chromium で図を描く `rehype-mermaid`） | ブラウザのバイナリはブラウザの中では動かない | `playwright-core` 自体は読み込める（それを import する設定は動く）。ブラウザの起動で落ちる |
| 依存パッケージの install スクリプト | ほとんどがネイティブのバイナリの取得かコンパイル | 走らせない。プロジェクト自身の `prepare`/`postinstall` は走る |

OpenVessel が作る互換パッケージ（`compat/`・`scripts/build-compat.mjs`）:

| パッケージ | 作り方 |
|---|---|
| `@pagefind/linux-x64`（Pagefind の索引作り） | 公開されている crate に小さなパッチ（単一スレッドの tokio、1 本のループの `--service`）を当て、`wasm32-wasip1` にコンパイル。CLI も Node の API も動く |
| `cn-font-split` | プロジェクト自身の `wasm32-wasip1` 版を、Koffi の代わりに `node:wasi` で動かす |
| `@resvg/resvg-js` | 同じ API を `@resvg/resvg-wasm` の上に作る |

これから互換パッケージを作る候補: `@myriaddreamin/typst-ts-node-compiler`（napi-rs 製。Typst は WebAssembly に
できるが、Node 用のバインディングに WASI 版がまだ無い）。

### JavaScript のエンジン

| 動かないもの | 理由 | 代わりに起きること |
|---|---|---|
| `await` をまたぐ `AsyncLocalStorage` の文脈 | Node は V8 の promise hooks で引き継ぐが、ブラウザはそれを出していない | 同期のコード・コールバック・`process.nextTick`・タイマー・immediate では見えるが、`await` の後で失われる |
| `vm` の `timeout` と `breakOnSigint` | ブラウザの同期の JavaScript は外から止められない | オプションは受け付ける。戻ってこないスクリプトは止まらない |
| 別の realm としての `vm` の文脈（`microtaskMode`、独自の組み込み） | 文脈は worker の realm の中で再現している（プロキシのグローバルと `with` のスコープ） | グローバル・`var`/関数の宣言・`runInContext` は Node と同じに振る舞う。`Array` などの組み込みは本体と共有 |
| inspector のプロトコル・ヒープのスナップショット・CPU プロファイル | つなぐ先の V8 の inspector が無い | `node:inspector` は読み込める。セッションは「未対応」と答える |

### OS

| 動かないもの | 理由 | 代わりに起きること |
|---|---|---|
| ユーザー・グループ・権限（`setuid`、ほかのユーザーへの `chown`、モードによる `EACCES`） | メモリ上のファイルシステムのユーザーは 1 人 | その 1 人として成功するか、何もしない |
| OS が送るシグナル（`SIGSEGV`・`SIGXFSZ` など）・資源の上限 | 下に本物の OS が無い | `process.kill`/`child.kill` によるプロセス間のシグナルは動く |
| `node`・シェルの組み込み・coreutils・パッケージマネージャ以外のプログラム（`git`・`python` など） | カーネル向けに書いたプログラムしか無い | `command not found` |

## Astro のサイト集

`corpus/` には、実際の Astro のサイト 147 本（Astro 5・6・7 の公式の例と、よく使われるテーマ）があります。
`node corpus/run.mjs --port` で、それぞれ install と build を行います。

ビルドできないサイトと、その理由:

| 理由 | サイト |
|---|---|
| 外への要求が CORS で止まる（Google Fonts の一覧・RSS・外の画像） | bekturaslan/syntro-astro・lin-stephanie/astro-antfustyle-theme・radishzzz/astro-theme-retypeset・satnaing/astro-paper（OG 画像のフォント）・themefisher/dockit-astro・mnyorba/astro-starter（`codeload.github.com` からの依存） |
| workerd が要る（Cloudflare のアダプター） | webrating/starfolio・CuteLeaf/Firefly |
| ヘッドレスブラウザで図を描く | huangmingche/astro-theme-aither |
| 互換パッケージがまだ無いネイティブだけの依存（Typst） | LemonAdorable/astro-theme-iris |
| リポジトリに無い準備が要る（環境変数・生成するファイル・コメントのサービスの設定） | SolitudeRA/Solitude-Interface・unfolding-io/nebulix・vic/awesome-gh-repos・Liksium/astro-theme-sora・louisescher/spectre |
| 調査中 | izmttk/astro-mecure（事前描画中の CommonJS の依存の名前付き export） |

<!-- corpus: updated with each full run -->
