# 互換性

[English](compatibility.md)

OpenVessel は Node.js 本体の JavaScript（`lib/`）をそのまま動かし、ネイティブの部分を TypeScript で実装し直しています。
そのため、ある機能が動くかどうかは、たいてい「ブラウザのタブでは用意できないものが必要かどうか」で決まります。
このページでは、何をどう計測しているか、何が動いて何が動かないかを、それぞれの理由とあわせて説明します。

## Node.js 自身のテスト

計測には `test/node-compat/run.mjs` を使います。

- 対象は、OpenVessel が対応するモジュール（fs、stream、buffer、events、child_process、process、worker_threads、
  crypto、zlib、vm、timers、モジュールの読み込み、util、url、readline など）についての、Node.js 本体の
  `test/parallel` のテストです。Node のバージョンも同じもの（v22.23.4）を使います。
- 本物の Node.js（Linux）で通るテストだけを数えます（`--baseline`）。
- Node の公開された動作ではなく内部を確認するテストは対象外とし、実行しません。具体的には、
  `--expose-internals` が必要なもの、`internalBinding`/`process.binding` を呼ぶもの、V8 のフラグを設定するもの、
  inspector、プロファイラ、スナップショット、レポート、単一実行ファイル、パーミッションモデルを使うものです。
- ブラウザでは通せないテストは、理由とあわせて `test/node-compat/limits/*.json` に記載しています。
  目標はそれ以外のすべてのテストです。レポートには「通過 / 目標」を表示し、100% を目指します。

結果（2026-10-24、Chrome）:

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

対象外にした 34 本の内訳は次のとおりです（テストごとの理由は `test/node-compat/limits/` の各ファイルにあります）。

| 理由 | 本数 |
|---|---:|
| 実行中の JavaScript を止める（`vm` の `timeout`・`breakOnSigint`）、または専用のマイクロタスクキューを持つコンテキスト（`microtaskMode`） | 9 |
| inspector、ヒープスナップショット、スレッドごとのヒープ上限 | 7 |
| 専用の組み込みオブジェクトを持つコンテキスト（別の V8 realm） | 4 |
| HTTP/2。ブラウザの制約ではなく未実装です（nghttp2 を使う `node_http2.cc` の移植は、それだけで大きな作業になります） | 4 |
| 下に OS がない: 別のプログラム（`python3`）、`RLIMIT_FSIZE`、実行中のタイムゾーン変更、UDP | 4 |
| 2 GiB 以上の一括確保 | 2 |
| macOS 専用のテスト（OpenVessel は Linux として動くので、テスト側でスキップされます） | 2 |
| `await` の後の `AsyncLocalStorage`（V8 の promise hooks） | 1 |
| OpenSSL の設定ファイル | 1 |

計測し直すには `node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report` を実行します。
表は `test/node-compat/results/port/REPORT.md` に出力されます。
<!-- numbers: updated with each full run -->

## Firefox

移植版ランタイム（デフォルト）は、現行の Firefox で動きます。起動、シェル、`node`
（CommonJS、ES モジュール、TypeScript、`worker_threads`、`child_process`、zlib、crypto）、`npm install`、
`npx`、プレビューでの HTTP サーバー、Astro のビルド、WebSocket でホットリロードする `astro dev` を
確認しています。Node 本体のテストは、Chrome で通る 1237 本のうち 1200 本が通ります（2026-10-26、
Playwright の Firefox 157）。残りが通らない理由は次のとおりです。

- エラーメッセージが V8 ではなく SpiderMonkey のものになります（`Cannot convert a Symbol value to a string`
  ではなく `can't convert symbol to string`、スタックオーバーフローは `RangeError: Maximum call stack size
  exceeded` ではなく `InternalError: too much recursion`）。メッセージを比較するテストは失敗し、
  スタックオーバーフローを `instanceof RangeError` で判定するコードは検出できません。
- V8 のスタックトレース API は、Firefox のスタック文字列からエミュレートしています。`Error.prepareStackTrace`、
  `Error.captureStackTrace`、V8 形式のスタックは使えますが、CallSite にはレシーバーと型名
  （`getThis()`・`getTypeName()`）がありません。そのため `util.inspect` は null プロトタイプのオブジェクトの
  クラス名を表示できず、非同期のフレームやメソッド名の表記も少し変わります。
- ワーカーの最後のメッセージ、`exit` イベント、ハンドルのクローズが届く順序に依存するテストがあり、
  Firefox ではこの順序が異なります。
- 一部の crypto のテスト（Diffie-Hellman の鍵生成、多数回の暗号処理）は 30 秒の制限を超えます。
  また、プロキシや変更できないプロパティについて V8 とまったく同じ動作を前提とする `vm` のテストもあります。

旧ランタイム（`/etc/openvessel/node` に `legacy`）も起動でき、簡単なプログラムは動きますが、スタックトレースは
Firefox の形式のままです。E2E テストは `OV_BROWSER=firefox` を指定すると Firefox でも実行できます（README を参照）。

## ブラウザでは動かせないものと、その理由

ここに挙げるものは、実装が追いついていないのではなく、プラットフォームの制約によるものです。どれもブラウザの
タブという環境に理由があります。

### 通信

- インターネットへの HTTP 以外のプロトコルの生の TCP（DB、SMTP、SSH、Redis など）は使えません。Web ページは
  ソケットを開けないためです。外部ホストへの `net.connect` はカーネルが受け取り、`fetch` を使って HTTP/1.1 で
  通信します。HTTP でない通信はリセットします。
- クロスオリジンのリクエストを許可していないサーバーには接続できません。外部へのリクエストはブラウザの `fetch`
  で行うため、CORS の制限を受けます。リクエストは `fetch failed`（`ECONNREFUSED`）で失敗し、CORS が原因だと
  分かるメッセージを出します。Google Fonts のメタデータや多くの RSS フィードがこれに当たります。
- UDP（`dgram`）と生の DNS クエリは使えません。ブラウザには UDP がないためです。ホスト名は仮のアドレスに解決し、
  HTTP の中継がそのアドレスを元のホスト名に戻します。
- `net`/`tls` を使った外部ホストへの WebSocket 接続には `501 Not Implemented` を返します。HTTP の中継は
  リクエストとレスポンスしか扱わないためです。グローバルの `WebSocket` はブラウザのものですが、ランタイムの
  Content-Security-Policy（`connect-src 'self' data: blob:`）により接続先はランタイムのオリジン自身に限られるので、
  こちらも外部ホストには接続できません（[詳細](reference/network-policy.ja.md#websocket)）。
- 独自の CA、クライアント証明書、TLS の細かい設定は使えません。TLS の処理と証明書の検証はブラウザの `fetch` が
  行い、プロセスには平文が届きます。ブラウザが証明書を受け入れれば、`tls.connect` は `authorized: true` で
  接続に成功します。`getPeerCertificate()` は本物の証明書ではなく、その要約を返します。
- 実際のポートで待ち受けることはできません。タブの外からは接続できないためです。サーバーは仮想ポートで待ち受け、
  プレビューの iframe は Service Worker を経由して接続します。
- HTTP/2（`node:http2`）は、ブラウザの制約ではなく未実装です。バインディング（nghttp2 を使う `node_http2.cc`）の
  移植はそれだけで大きな作業で、まだ終わっていません。移植版ランタイムでは `node:http2` を読み込めてサーバーも
  待ち受けますが、セッション（接続の受け付け、`http2.connect()`）はすべて `ERR_NOT_IMPLEMENTED`
  （`Http2Session`。[詳細](reference/nodejs-runtime.ja.md#実装していないもの)）で失敗します。旧ランタイムでは
  `createServer()`、`createSecureServer()`、`connect()` が `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`
  （`HTTP/2 is not supported in OpenVessel`）を投げます。HTTP/1.1 のサーバーとクライアントは動きます。

### ネイティブのコード

- ネイティブアドオン（`.node` ファイル）は基本的に読み込めません。ブラウザは機械語を読み込めないためです。
  WebAssembly ビルドがあるパッケージはそちらをインストールします（esbuild、rollup、rolldown、lightningcss、sharp、
  napi-rs の `wasm32-wasi` ビルド）。それ以外は、互換パッケージ（後述）があればそれをインストールします。
- `workerd`（Cloudflare のランタイム。`@astrojs/cloudflare` がプリレンダリングと `astro dev` に使います）は
  V8 を組み込んだ C++ のプログラムで、WebAssembly ビルドはなく、作ることもできません。インストールは成功しますが、
  アダプターが workerd を起動する時点でビルドが失敗します。
- Koffi などの FFI ライブラリは、ネイティブの共有ライブラリを呼び出すため動きません。コーパスの中で Koffi を
  必要とする `cn-font-split` には、その WebAssembly ビルドを使う互換パッケージがあります。
- ヘッドレスブラウザ（Playwright/Puppeteer のブラウザ。たとえば Chromium で図を描画する `rehype-mermaid`）は
  動きません。ブラウザのバイナリはブラウザのタブの中では実行できないためです。`playwright-core` 自体は
  読み込めるので、これを import する設定ファイルは動きますが、ブラウザの起動で失敗します。
- 依存パッケージのインストールスクリプトは実行しません。ほとんどがネイティブバイナリのダウンロードやコンパイルを
  行うものだからです。プロジェクト自身の `prepare`/`postinstall` スクリプトは実行します。

OpenVessel では次の互換パッケージをビルドしています（`compat/`、`scripts/build-compat.mjs`）。

- `@pagefind/linux-x64`（Pagefind のインデクサ）: 公開されている crate に小さなパッチ（シングルスレッドの tokio、
  ループ 1 本の `--service`）を当て、`wasm32-wasip1` 向けにコンパイルしたもの。CLI と Node の API のどちらも動きます。
- `cn-font-split`: プロジェクト自身の `wasm32-wasip1` ビルドを、Koffi の代わりに `node:wasi` で動かすもの。
- `@resvg/resvg-js`: 同じ API を `@resvg/resvg-wasm` の上に実装したもの。

今後の互換パッケージの候補には `@myriaddreamin/typst-ts-node-compiler` があります（napi-rs 製。Typst は
WebAssembly にコンパイルできますが、Node 用のバインディングにはまだ WASI ビルドがありません）。

### JavaScript のエンジン

- `AsyncLocalStorage` のコンテキストは `await` をまたいで引き継がれません。Node は V8 の promise hooks で
  引き継ぎますが、ブラウザはこれを公開していないためです。同期コード、コールバック、`process.nextTick`、タイマー、
  immediate の中ではストアを参照できますが、`await` の後では失われます。
- `vm` の `timeout` と `breakOnSigint` は効きません。ブラウザでは同期的に実行中の JavaScript を外から中断できない
  ためです。オプションは受け付けますが、戻ってこないスクリプトはそのまま止まりません。
- `vm` のコンテキストは別の realm にはなりません（`microtaskMode`、独自の組み込みオブジェクト）。コンテキストは
  worker の realm の中で、プロキシのグローバルと `with` スコープを使ってエミュレートしています。グローバル変数、
  `var`/関数の宣言、`runInContext` は Node と同じように動きますが、`Array` などの組み込みオブジェクトはメインの
  コンテキストと共有されます。
- inspector プロトコル、ヒープスナップショット、CPU プロファイルは使えません。接続先となる V8 の inspector が
  ないためです。`node:inspector` は読み込めますが、セッションは「未対応」と応答します。

### OS

- ユーザー、グループ、権限（`setuid`、他のユーザーへの `chown`、モードによる `EACCES`）はありません。
  メモリ上のファイルシステムのユーザーは 1 人だけだからです。呼び出しは、その 1 人のユーザーとして成功するか、
  何もせずに終わります。
- OS から送られるシグナル（`SIGSEGV`、`SIGXFSZ` など）やリソースの上限はありません。下に本物の OS がないためです。
  `process.kill`/`child.kill` によるプロセス間のシグナルは動きます。
- `node`、シェルの組み込みコマンド、coreutils、パッケージマネージャ以外のプログラム（`git`、`python` など）は
  使えません。カーネル向けに書かれたプログラムしか存在しないためで、実行すると `command not found` になります。

## Astro のサイト集

`corpus/` には、実在する Astro のサイトを 147 本（Astro 5・6・7 の公式サンプルと、よく使われているコミュニティの
テーマ）収録しています。`node corpus/run.mjs` で、それぞれに対して install と build を実行します。

ビルドできないサイトとその理由は次のとおりです。

| 理由 | サイト |
|---|---|
| 外部へのリクエストが CORS で止まる（Google Fonts のメタデータ、RSS フィード、外部の画像） | bekturaslan/syntro-astro・lin-stephanie/astro-antfustyle-theme・radishzzz/astro-theme-retypeset・satnaing/astro-paper（OG 画像のフォント）・themefisher/dockit-astro・mnyorba/astro-starter（`codeload.github.com` からの依存） |
| workerd が必要（Cloudflare のアダプター） | webrating/starfolio・CuteLeaf/Firefly |
| ヘッドレスブラウザで図を描画する | huangmingche/astro-theme-aither |
| 互換パッケージがまだないネイティブ専用の依存（Typst） | LemonAdorable/astro-theme-iris |
| リポジトリに含まれていない準備が必要（環境変数、生成ファイル、コメントサービスの設定） | SolitudeRA/Solitude-Interface・unfolding-io/nebulix・vic/awesome-gh-repos・Liksium/astro-theme-sora・louisescher/spectre |
| 調査中 | izmttk/astro-mecure（プリレンダリング中の CommonJS の依存の名前付き export） |

<!-- corpus: updated with each full run -->
