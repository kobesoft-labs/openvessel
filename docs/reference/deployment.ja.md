# デプロイ

[English](deployment.md)

OpenVessel を本番環境にデプロイする方法を説明します。`dist/` の中身、どのディレクトリをどのオリジンに配置するか、各オリジンに必要な
HTTP ヘッダーとその理由、キャッシュ、ヘッダーを設定できないホスティング、パスの下での配信、セッションごとのプレビューの
オリジン、サーバーの設定例を扱います。

## 3 つのオリジン

OpenVessel は 3 つのオリジンで動きます。ブラウザから見ると、それぞれが別のサイトです。

| オリジン | 配信するもの | 読み込まれ方 | 動くもの |
|---|---|---|---|
| ホスト | 埋め込む側のアプリケーション（`dist/host/index.js` は通常アプリケーションにバンドルする） | トップレベルのページ | UI とホスト API |
| ランタイム | `dist/runtime/` | `OpenVessel.boot()` が作る非表示の iframe（`runtime.html`） | カーネルの Worker、プロセスの Worker、ネットワークポリシーの確認 |
| プレビュー | `dist/preview/` | 非表示の中継用 iframe（`__ov/relay.html`）と、プレビューごとの iframe | 開発中のサイト（仮想ポートから配信） |

[../SECURITY.md](../SECURITY.md) で説明している分離を成り立たせるには、3 つを別々のオリジンにする必要があります。ランタイムが
ホストと同じオリジンにある場合、ホストは警告（`console.warn('OpenVessel: the runtime should be served from its own origin')`）
を出すだけで、起動は止めません。自分だけが使うデモであれば、3 つを 1 つのオリジンにまとめても構いません（公開デモはそうしています。
[GitHub Pages](#ヘッダーを付けられないホストgithub-pages) を参照）。自分で管理していないコードを動かす場合は、まとめないでください。

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://runtime.example.com/',   // "/" で終わるディレクトリか、runtime.html の URL そのもの
  previewUrl: 'https://preview.example.com/',   // "/" で終わるディレクトリ
});
```

`runtimeUrl` は `new URL('runtime.html', runtimeUrl)`、`previewUrl` は `new URL('./', previewUrl)` で解決します
（`src/host/index.ts`）。そのため、末尾に `/` のない URL は親ディレクトリを指します。たとえば
`https://example.com/runtime` を渡すと `https://example.com/runtime.html` を読み込みます。末尾に `/` を付けたディレクトリか、
`…/runtime.html` の完全な URL を渡してください。

## `dist/` の中身

`npm run build`（`scripts/build.mjs`）が `dist/` を書き出します。静的ファイルとしてデプロイするのは `dist/runtime/` と
`dist/preview/` だけです。`dist/host/` は、アプリケーションが import する npm パッケージのエントリーポイントです。

### `dist/runtime/`（ランタイムのオリジン）

| ファイル | 内容 | 読み込まれるタイミング |
|---|---|---|
| `runtime.html` | ランタイムの iframe のドキュメント。`<meta name="openvessel-allowed-hosts" content="*">` を含む | ホストが `OpenVessel.boot()` を呼んだとき |
| `runtime.js` | `runtime.html` のクラシックスクリプト（IIFE）。オリジンの確認、Service Worker の登録、カーネルの起動、ホストへのチャネルの受け渡しを行う（`src/runtime/runtime.ts`） | `runtime.html` と一緒に |
| `sw.js` | ランタイムの Service Worker（`src/runtime/sw.ts`）。`/__ov/esm/`・`/__ov/builtin/`・`/__ov/mw/`・`/__ov/esm-error` での ES モジュールの配信、ネットワークポリシーを確認する外部通信のプロキシ `/__ov/net`、`/__ov/ping`、カーネルごとの `/__ov/k/<id>/` の下でのランタイム自身のファイルの配信、ランタイム自身のファイルへの分離用ヘッダーの付与を行う | `runtime.js` がスコープ `./` で登録 |
| `kernel.js` | カーネル。ES モジュールの Worker（`src/kernel/index.ts`） | 起動ごとに 1 回、`new Worker('__ov/k/<id>/kernel.js', { type: 'module' })` として。`<id>` はランタイムのフレームごとにランダムに決まるカーネル ID で、Service Worker が `kernel.js` の中身を返す |
| `process.js` | 旧ランタイム: 以前からある手書きの Node 互換レイヤー（`src/node/worker.ts`）。プロセスごとに 1 つのモジュール Worker | VFS のファイル `/etc/openvessel/node` が `legacy` のとき、すべての `node` プロセスで |
| `node-process.js` | 移植版ランタイム: Node.js 自身の `lib/` を、再実装した `internalBinding()` の上で動かす（`src/nodejs/boot.ts`）。プロセスごとに 1 つのモジュール Worker | 既定で、すべての `node` プロセスで |
| `nodelib.js` | Node.js v22.23.4 の `lib/`（と `deps/`）のソースを文字列として持つファイル。`scripts/gen-nodelib.mjs` が生成する（約 4.5 MB）。ビルド時に `vendor/node/` があった場合だけ書き出される | `node-process.js` が静的に import |
| `ts-strip.js` | sucrase（クラシックスクリプト）。移植版ランタイムが `require(esm)` で ESM → CommonJS に書き換えるときに使う | 移植版ランタイムで初めて使うとき。同期の `XMLHttpRequest` で取得して評価する |
| `amaro.js` | Node 自身の `amaro`（swc を WebAssembly にしたもの。JavaScript に埋め込まれていて約 3.4 MB）。Node が同梱しているのと同じバージョン | 移植版ランタイムで初めて TypeScript の型を除去するとき。同期の `XMLHttpRequest` |
| `chunks/chunk-<hash>.js` | `kernel.js` と `process.js` が共有するコード（esbuild のコード分割） | その 2 つが静的に import |
| `chunks/esm-<hash>.js` | 分割した sucrase | カーネルか旧ランタイムが初めて TypeScript の型を除去するとき、または ESM を書き換えるときに動的 `import()` |
| `chunks/legacy-<hash>.js` | `@noble/hashes` のレガシーなハッシュ | 組み込みの `md5sum` が動的 `import()` |
| `compat/index.json` | 互換パッケージの一覧。パッケージ名 → `{ range, file, integrity, pkg }` | npm のインストーラー（`src/kernel/npm/install.ts`）が 1 回だけ取得 |
| `compat/<id>-<version>.tgz` | ネイティブバイナリしか提供していないパッケージの代わりになる互換パッケージ（npm の tarball）。このビルドでは `pagefind-1.5.2.tgz`・`cn-font-split-7.4.3.tgz`・`resvg-js-2.6.2.tgz` | `npm install` がそのパッケージを置き換えるとき。整合性（`sha512`）を検証する |
| `NODE-LICENSE.txt` | Node.js のライセンスと、同梱している依存ライブラリの告知（`nodelib.js` と一緒に配布する） | 読み込まれない。ただしデプロイには含める |
| `AMARO-LICENSE.txt` | amaro と swc のライセンス（`amaro.js` と一緒に配布する） | 読み込まれない。ただしデプロイには含める |
| `*.map` | ソースマップ（`sourcemap: 'linked'`） | 開発者ツールのみ。省略可 |

チャンクのハッシュはビルドごとに変わります。ファイル名を列挙するのではなく、ディレクトリをまるごとデプロイしてください。

`node` プロセスにどちらのスクリプトを使うかは、プロセスを起動するたびに決まります。カーネルは
`/etc/openvessel/node` を読み、前後の空白を除いた内容が `legacy` なら `process.js`、それ以外なら `node-process.js`
を起動します（`src/kernel/index.ts` の `processScript()`）。公開している互換性の数値は移植版ランタイムのもので、
こちらは設定なしで使われます。プロセスを旧ランタイムで動かしたい場合は、プロセスを起動する前にこのファイルを書き込みます。

```ts
await vessel.mount({ node: 'legacy' }, { path: '/etc/openvessel' });
```

カーネルは、最後に起動したスクリプトの Worker を 2 つ待機させておきます（`WARM = 2`）。そのため、最初の `node` プロセス以降は、
読み込み済みの Worker から起動します。

### `dist/preview/`（プレビューのオリジン）

| ファイル | 内容 |
|---|---|
| `__ov-sw.js` | プレビューの Service Worker（`src/preview/sw.ts`）。プレビューのディレクトリの最上位にあるので、既定のスコープがプレビュー全体になる |
| `__ov/relay.html` | 非表示の中継用 iframe のドキュメント |
| `__ov/relay.js` | 中継用のクラシックスクリプト。`../__ov-sw.js` をスコープ `../` で登録し、カーネルへのチャネルを渡す（`src/preview/relay.ts`） |
| `__ov/inject.js` | プレビューで表示するすべての HTML ページに注入する。WebSocket のトンネリングと、パスの下で配信するときの `fetch`/`XMLHttpRequest` のパス補正を行う（`src/preview/inject.ts`） |
| `*.map` | ソースマップ。省略可 |

プレビューのオリジンでそれ以外の URL への要求には、すべて Service Worker が仮想ポートから応答します。そのため、プレビューする
サイトでは（プレビューのディレクトリからの相対で）`__ov-sw.js`・`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js`・
`__ov/open` のパスを使えません。詳しくは [プレビュー](preview.ja.md) を参照してください。

### `dist/host/` と `dist/types/`

- `dist/host/index.js` は、ホスト API の ES モジュールです（`package.json` の `main`/`exports`）。アプリケーションから import します。通常はアプリケーションにバンドルします。
- `dist/types/host/index.d.ts` と `dist/types/shared/policy.d.ts` は TypeScript の型宣言です（`package.json` の `types`）。

`dist/playground/` は `npm run serve` で配信する開発用の playground で、デプロイには含めません。

## ヘッダー

### まとめ

| ヘッダー | ホストのページ | ランタイム（`dist/runtime/`） | プレビュー（`dist/preview/`） |
|---|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin`（必須） | `same-origin` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` か `credentialless`（必須） | `require-corp` | `require-corp`。`__ov-sw.js` だけ `credentialless` |
| `Cross-Origin-Resource-Policy` | アプリケーションに合わせる（`scripts/serve.mjs` は `same-origin`） | `cross-origin` | `cross-origin` |
| `Content-Security-Policy` | アプリケーション独自のもの | 後述のランタイムの CSP を、`sw.js` を除くすべてのファイルに | 不要 |
| `Content-Security-Policy: frame-ancestors` | — | ホストのオリジン | — |
| `Service-Worker-Allowed` | — | 不要 | 不要 |

これは `scripts/serve.mjs` が使っているヘッダーの組み合わせです。serve.mjs ではエラーレスポンスにも同じヘッダーを付けています。

プレビューの `__ov-sw.js` だけを `credentialless` で配信するのは、Service Worker がページの `no-cors` の読み込み（ほかの
サーバーの画像やクラシックスクリプト）を自身の `fetch()` で中継するためです。`require-corp` の場合、相手のサーバーが
`Cross-Origin-Resource-Policy` を返さない限り、その読み込みは失敗します。`credentialless` なら認証情報なしで送信されるので、CORP は不要です。
`credentialless` に対応していないブラウザ（Safari）では、こうした読み込みは拒否されます。

### それぞれのヘッダーが要る理由

#### cross-origin isolation（COOP + COEP）

システムコールは、`SharedArrayBuffer` 上で `Atomics.wait` を使ってブロックします
（[通信の形式](protocol.ja.md#同期のシステムコールのチャネル)）。`SharedArrayBuffer` は cross-origin isolated な環境でしか使えません。

- ホストのページは isolated である必要があります。`crossOriginIsolated` が false の場合、`OpenVessel.boot()` は
  `OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).`
  を投げます。
- ランタイムのドキュメントも isolated である必要があります。`runtime.js` はまず `sw.js` を登録します（この Worker がランタイムのファイルに
  分離用のヘッダーを付けます。[後述](#ヘッダーを付けられないホストgithub-pages)を参照）。Worker の制御下に入っても isolated で
  なければ 1 回だけリロードします（`sessionStorage` のフラグで 1 回に制限）。それでも isolated にならなければ
  `OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).`
  というエラーで失敗します。ホストはランタイムの iframe を `allow="cross-origin-isolated"` 付きで作成します。
- COEP のページに埋め込むドキュメントは、それ自身も COEP 付きで配信する必要があり、別オリジンの場合は `Cross-Origin-Resource-Policy: cross-origin`
  も必要です。`runtime.html` とプレビューのドキュメントの両方に COEP と CORP `cross-origin` を付けているのはこのためです。
- カーネルとプロセスの Worker は、ランタイムのオリジンから読み込むモジュール Worker です。ランタイムのほかのファイルと
  同じヘッダーで配信します。

#### ランタイムの CSP

この CSP は、ランタイム内のコード（プロジェクトとその依存パッケージ）がアクセスできる範囲を制限します。`scripts/serve.mjs` は
次の内容を送ります。

```text
default-src 'self';
script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:;
connect-src 'self' data: blob:;
worker-src 'self' blob:;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
frame-ancestors <ホストのオリジン>
```

| ディレクティブ | 必要な理由 |
|---|---|
| `script-src 'unsafe-eval'` | Node の組み込みモジュールは、`nodelib.js` から間接 `eval` でコンパイルする（`src/nodejs/boot.ts` の `compileBuiltin()`）。`vm`、CommonJS のラッパー、`amaro.js`、`ts-strip.js` も同じ方法で評価する |
| `script-src 'wasm-unsafe-eval'` | esbuild・rollup・rolldown・lightningcss・amaro（swc）・互換パッケージは WebAssembly で動く |
| `script-src data:` | 移植版ランタイムのモジュールローダーは `data:text/javascript,…` のモジュールを import する（`src/nodejs/bindings/module_wrap.ts`）。旧ランタイムも、`eval` と ES モジュールを使う `worker_threads` で使う |
| `connect-src 'self'` | この CSP の目的。プロセスは `fetch` や `WebSocket` でランタイムのオリジン以外に接続できないため、外へ出る経路は `/__ov/net` だけになる。そこで Service Worker がネットワークポリシーと照合する |
| `frame-ancestors` | `runtime.html` を埋め込めるのをホストのページだけに限る |

#### `sw.js` には CSP を付けない

Service Worker 自身の `fetch()` には、Worker のスクリプトと一緒に配信された CSP が適用されます。
ランタイムの Service Worker は外部通信のプロキシで、ポリシーで許可されたあとに実際の外部リクエストを送ります。`sw.js` に `connect-src 'self'`
が付いていると、許可したリクエストがすべて失敗します。`scripts/serve.mjs` は `/sw.js` に対してだけ CSP を外しています。

#### `frame-ancestors` とランタイム自身のオリジンの確認

ランタイムは、自分を埋め込んでいる相手を 3 つの方法で確認します。

| 確認 | 場所 | 失敗したとき |
|---|---|---|
| CSP の `frame-ancestors` | サーバー | ブラウザが iframe を表示しない。その結果 `boot()` はタイムアウトする |
| `runtime.html` の `<meta name="openvessel-allowed-hosts">`。オリジンを空白かカンマで区切る。`*` は任意のオリジン（配布時の既定） | `runtime.js` が `openvessel-connect` メッセージの `origin` と比較する | `origin <origin> is not allowed to use this runtime` |
| `location.ancestorOrigins`（ブラウザが対応している場合）のエントリーが 2 つ以上ないこと | `runtime.js` | `the runtime must be embedded directly by the host page` |

ホスト側では、どれも `boot()` の reject になります。下の 2 つは `OpenVessel: <メッセージ>`、1 つ目は（`timeout`、既定 30000 ms
の経過後に）`OpenVessel: runtime did not start in time` です。デプロイする `runtime.html` の meta タグを書き換えてください。

```html
<meta name="openvessel-allowed-hosts" content="https://app.example.com https://staging.example.com">
```

#### プレビューのオリジン

プレビューの静的ファイルには、前述の COOP/COEP/CORP が必要です。プレビューで表示するものは
すべて Service Worker から返されます。Service Worker は、各レスポンスに `cross-origin-embedder-policy: credentialless`・
`cross-origin-resource-policy: cross-origin`・`cross-origin-opener-policy: same-origin` が無ければ付けます。
そのため、開発サーバーがこれらのヘッダーを送る必要はありません。また `credentialless` なので、CORP を返さない外部の画像やスクリプトも
読み込めます。プレビューのオリジンにはランタイムの CSP を付けないでください。プレビューは Service Worker で独自にポリシーを
確認します（[プレビュー](preview.ja.md#外部へのリクエストとネットワークポリシー)）。

#### `Service-Worker-Allowed`

このヘッダーは不要です。ランタイムは `sw.js` をスコープ `./`（自身のディレクトリ）で、中継は
`../__ov-sw.js` をスコープ `../`（プレビューのディレクトリ。Worker のスクリプトがあるディレクトリでもある）で登録するためです。

### MIME タイプ

| 拡張子 | タイプ | 備考 |
|---|---|---|
| `.html` | `text/html; charset=utf-8` | |
| `.js` | `text/javascript; charset=utf-8` | 必須。JavaScript 以外のタイプだと、モジュール Worker・`import`・Service Worker のスクリプトは拒否される |
| `.json` | `application/json` | `compat/index.json`・ソースマップ |
| `.map` | `application/json` | |
| `.tgz` | `application/gzip` か `application/octet-stream` | `fetch().arrayBuffer()` で読む。タイプはチェックしない |
| `.txt` | `text/plain; charset=utf-8` | ライセンスファイル |

`dist/` に `.wasm` ファイルはありません。WebAssembly は JavaScript に埋め込まれている（`amaro.js`）か、互換パッケージの
tarball に含まれているか、npm からメモリ上のファイルシステムにインストールしてバイト列からコンパイルするかのいずれかです。独自にファイルを追加する場合は、
`.wasm` を `application/wasm` で配信してください。

## キャッシュ

ファイルの命名規則から、次のように設定することをおすすめします。

| ファイル | 推奨 | 理由 |
|---|---|---|
| `runtime/chunks/*-<hash>.js` | 長期、`immutable` | 内容が変わると名前も変わる |
| `runtime/compat/<id>-<version>.tgz` | 長期 | 名前にバージョンを含む。いずれにしても `index.json` の `integrity` で検証する |
| `runtime/sw.js`・`preview/__ov-sw.js` | `no-cache` | Service Worker の更新を確実に反映する必要がある。ランタイムは `updateViaCache: 'none'` で登録する |
| その他すべて（`runtime.html`・`runtime.js`・`kernel.js`・`process.js`・`node-process.js`・`nodelib.js`・`amaro.js`・`ts-strip.js`・`compat/index.json`・`__ov/*`） | `no-cache`（`ETag`/`Last-Modified` で再検証） | 名前は固定で、内容はリリースごとに変わる。`kernel.js` と `process.js` は同じビルドのハッシュ付きチャンクを名前で参照している |

`scripts/serve.mjs` はすべてのファイルに `cache-control: no-cache` を付けます。Service Worker が自身で生成するレスポンスはキャッシュされません。
`/__ov/esm/`・`/__ov/builtin/`・`/__ov/mw/`・`/__ov/esm-error` のモジュールと `/__ov/net` のレスポンスには `cache-control: no-store` が付きます。

npm クライアントは、検証済みの tarball をランタイムのオリジンの Cache Storage（キャッシュ名 `openvessel-npm-v1`）に保存し、
読み出すときにも整合性を再検証します。このキャッシュはブラウザごと、ランタイムのオリジンごとに分かれます。

## ヘッダーを付けられないホスト（GitHub Pages）

2 つの Service Worker は、自身が配信するファイルに分離用のヘッダーを付けます。サーバーが送ったヘッダーはそのまま残し、足りないものだけを追加します。

- ランタイムの `sw.js` は、スコープ内の同一オリジンへの `GET` のうち `/__ov/…` のエンドポイント以外のすべてに、
  `cross-origin-opener-policy: same-origin`・`cross-origin-embedder-policy: require-corp`・`cross-origin-resource-policy: cross-origin`
  を付けます。opaque なレスポンスとステータス 0 のレスポンスはそのまま返します。
- プレビューの `__ov-sw.js` は、自身のファイル（`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js`・`__ov-sw.js`）、
  `__ov/open` のリダイレクト、仮想ポートからのすべてのレスポンスに、`cross-origin-embedder-policy: credentialless`・
  `cross-origin-resource-policy: cross-origin`・`cross-origin-opener-policy: same-origin` を付けます。

Service Worker が制御するのは、インストール後に読み込まれたドキュメントだけです。`runtime.html` と `__ov/relay.html` の
最初の読み込みは、これらの Worker の制御下にありません。`runtime.js` は `sw.js` を登録してからフレームを 1 回リロードするので、
リロード後の `runtime.html` には Worker がヘッダーを付けます。ただし、これが役に立つのはフレームをそもそも読み込めた場合だけで、
isolated なホストのページの中では、最初の読み込みにも COEP と CORP が必要です。そのため、ヘッダーをまったく送らない
ホスティングでは、最初の読み込みを isolated にする仕組みが別に必要です。
デモ（[openvessel-demo](https://github.com/kobesoft-labs/openvessel-demo)）では、次のようにしています。

- ページ・`runtime/`・`preview/` を 1 つのオリジン（GitHub Pages）の、1 つのサイトディレクトリの下に配置する。`runtime/` は
  `dist/runtime` のコピー、`preview/` は `dist/preview` のコピー。
- ページはサイトのルートから独自の `coi-sw.js` を登録する。そのスコープ（サイトディレクトリ）は `runtime/` と
  `preview/` も含むので、それぞれの Worker がインストールされるまでは、`coi-sw.js` が同一オリジンへのすべての `GET`（`runtime.html` と
  `relay.html` を含む）に `cross-origin-opener-policy: same-origin`・`cross-origin-embedder-policy: require-corp`・
  `cross-origin-resource-policy: cross-origin` を付ける。登録が済むと、ランタイムとプレビューの Worker が、それぞれのより狭い
  スコープを引き継ぐ。
- ページは `coi-sw.js` を登録したあと 1 回だけリロードする（`sessionStorage` のフラグで 1 回に制限）。それでも isolated に
  ならなければ「非対応」のメッセージを表示する。

```html
<script>
  // GitHub Pages sends no isolation headers: let coi-sw.js add them, then reload once
  if (!crossOriginIsolated && 'serviceWorker' in navigator && !sessionStorage.getItem('ov-coi-reload')) {
    navigator.serviceWorker.register('coi-sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      sessionStorage.setItem('ov-coi-reload', '1');
      location.reload();
    });
  } else sessionStorage.removeItem('ov-coi-reload');
</script>
```

```js
// coi-sw.js
const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'cross-origin',
};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.type === 'opaque' || res.status === 0) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION)) if (!headers.has(k)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
```

デモは、ページからの相対 URL で起動します。

```ts
const here = new URL('./', location.href);
const vessel = await OpenVessel.boot({
  runtimeUrl: new URL('runtime/runtime.html', here).href,
  previewUrl: new URL('preview/', here).href,
  network: { mode: 'allowlist', presets: ['npm', 'fonts', 'cdn'] },
});
```

デモの `build.mjs` は `dist/runtime` を `site/runtime` に、`dist/preview` を `site/preview` にコピーし、空の `.nojekyll`
（GitHub Pages がすべてのファイルをそのまま配信するようにするため）を追加します。`deploy.mjs` は `site/` を `gh-pages` ブランチに
force push します。ヘッダーを送れないので、ランタイムの CSP も `frame-ancestors` もありません。つまりこの構成では、
`connect-src` による外部通信の制限と、埋め込み元の制限が効きません。オリジンも 1 つなので、オリジンの分離も
ありません。デモ以外では使わないでください。

## パスの下での配信

ランタイムとプレビューは、どちらもサブディレクトリから配信できます（例: `https://example.com/demo/runtime/` と
`https://example.com/demo/preview/`）。

ランタイムのオリジンでは、カーネルは自身のベース URL を `kernel.js` のディレクトリから取得し（`src/kernel/base.ts` の `RUNTIME_BASE`）、
各ランタイムは自身の Worker スクリプト（`node-process.js`・`process.js`）のディレクトリから取得します。
Service Worker は、リクエストのパスからスコープ（とカーネルの `/__ov/k/<id>/` プレフィックス）を取り除いてから `/__ov/…` と照合します。
npm クライアントの `/__ov/net` へのリクエストと `compat/` のダウンロード、移植版ランタイムの `/__ov/net` と `/__ov/mw/` の URL、旧ランタイムの
`/__ov/esm/`・`/__ov/builtin/`・`/__ov/net` の URL（カーネルが配信するモジュールに書き込むものも含む）は、すべてこのベースからの相対です。
`kernel.js` は `__ov/k/<id>/kernel.js` として起動され、プロセスの Worker を自身と同じ場所から起動するので、ベースは
`<ランタイムのディレクトリ>/__ov/k/<id>` になります。Service Worker はその下の `/__ov/…` のエンドポイントをカーネル `<id>` へのリクエストとして
処理し、その下のランタイム自身のファイルはランタイムのディレクトリから返します。これにより、複数のランタイムのフレーム
（複数のタブや、1 つのページでの複数回の `boot()`）が、それぞれ別のカーネルを持ちながら Service Worker を共有できます。プレフィックスの無い
`/__ov/…` のリクエストは、リファラー（あるカーネルのプレフィックスの下にあるファイルか、そのカーネルが返したモジュール）から判断したカーネルへ送り、
判断できなければ最後に接続したカーネルへ送ります。

プレビューのオリジンでは、Service Worker のスコープはプレビューのディレクトリです。一方、OpenVessel 内の開発サーバーは、サイトを
あくまで `/` で配信するので、Service Worker が両者の間を変換します。

- リクエストのパスからスコープを取り除いてから仮想ポートに渡す。
- HTML ページでは、ルート相対の `src`・`href`・`action`・`poster`・`formaction`・`srcset` の値の先頭にスコープを
  付ける。また、注入するスクリプトと一緒に import map `{"imports": {"/": "<scope>", "<scope>": "<scope>"}}` を挿入し、ルート相対の
  モジュール指定子（`/@vite/client`・`/src/…`）がスコープの下に解決されるようにする。
- ルート相対の `Location` ヘッダーも同じように書き換える。
- `inject.js` が `fetch()` と `XMLHttpRequest.prototype.open` をラップし、ルート相対の文字列の URL にもスコープを付ける。

それ以外の方法で組み立てた URL（たとえば `fetch` に渡した `new URL('/x', location.href)` や、CSS の `url(/…)`）は書き換えません。
プレビューを専用のオリジンのルートで配信すれば、こうした変換はすべて不要になります。

## セッションごとのプレビューのオリジン

マルチテナントで使う場合は、セッション（ユーザーやワークスペース）ごとにプレビューのオリジンを分けてください。たとえば
`https://<session>.preview.example.com/` のようにします（[../SECURITY.md](../SECURITY.md)）。サブドメインが違えばオリジンも別になるので、
あるセッションのプレビューのページから、ほかのセッションの Cookie・ストレージ・Service Worker の状態は読めません。

- すべてのサブドメインで同じ `dist/preview/` のファイルを配信します（ワイルドカードの DNS レコードと証明書、ワイルドカードの
  `server_name` を持つ 1 つの server ブロック）。
- 起動時に、セッションの URL を `previewUrl` として渡します。ホストはそこからプレビューのオリジンを求め、中継からのメッセージは
  そのオリジンのその iframe からのものだけを受け付けます。
- 各サブドメインは、初めて使われるときにプレビューの Service Worker を個別に登録します。
- ランタイムのオリジンは共有できます。ランタイムのインスタンスは `boot()` ごとに作られ、プレビューへのチャネルはホストが直接カーネルに
  渡すので、カーネルがプレビューのオリジンを知る必要はありません。

```ts
const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://runtime.example.com/',
  previewUrl: `https://${sessionId}.preview.example.com/`,
});
```

## Service Worker の更新

| | ランタイムの `sw.js` | プレビューの `__ov-sw.js` |
|---|---|---|
| install | `skipWaiting()` | `skipWaiting()` |
| activate | `clients.claim()` | `clients.claim()` |
| 登録 | `register('./sw.js', { scope: './', updateViaCache: 'none' })` のあと `reg.update()` | 中継から `register('../__ov-sw.js', { scope: '../' })` |
| 起動時 | Worker が installing か waiting の間、`runtime.js` は `controllerchange` を待つ。古い Worker の制御下でカーネルを起動することはない | 中継は `navigator.serviceWorker.ready` を待つ |
| 実行中の更新 | `controllerchange` のとき、`runtime.js` が新しい Worker にカーネルへの新しいチャネルを渡す | 新しい Worker は、初めて必要になったときにチャネルを要求する |

どちらの Worker も、カーネルへのチャネルをメモリ上に保持します。ブラウザがアイドル状態の Worker を停止して再起動すると、Worker は
新しいチャネルを要求します（`need-kernel-port`）。ランタイムの Worker は `runtime.html` に要求し、プレビューの Worker は中継に要求し、
中継はさらにホストに要求します。リクエストはチャネルを最大 15 秒待ちます。プレビューの Worker がメモリ上に持つ状態（どのプレビューの
ページがどのポートに属するか、許可したホスト）は、このような再起動のあとは空に戻ります。詳しくは [通信の形式](protocol.ja.md) を参照してください。

## ブラウザの条件

OpenVessel は Chromium 系のブラウザで開発・テストしています（E2E テストは Chrome で実行しています）。
コードは次の機能を前提にしています。

- cross-origin isolation、`SharedArrayBuffer`、Worker 内での `Atomics.wait`
- モジュール Worker（`new Worker(url, { type: 'module' })`）と、カーネルの Worker から作成するネストした Worker
- 別オリジンの iframe 内での、ランタイムとプレビューのオリジンの Service Worker
- iframe の `allow="cross-origin-isolated"` パーミッション
- Worker 内での同期 `XMLHttpRequest`（移植版ランタイム: `amaro.js`・`ts-strip.js`）
- 組み込みの許可ダイアログ用の `<dialog>`（`onPermissionRequest` を指定しない場合のみ）

`location.ancestorOrigins` は、ある場合に使います。

## 設定例

以下の設定は、上記のヘッダーの組み合わせをそのまま送ります。ホスト名は置き換えてください。`app.example.com` がホストのページです。

### nginx

nginx では、独自の `add_header` を持つ `location` の中では、server レベルの `add_header` が無視されます。そのため、共通の
ヘッダーは snippet にまとめ、必要な箇所で include しています。

```text
# /etc/nginx/snippets/openvessel-isolation.conf
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Resource-Policy "cross-origin" always;

# /etc/nginx/snippets/openvessel-runtime-csp.conf
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors https://app.example.com" always;
```

```text
# runtime origin
server {
    listen 443 ssl;
    server_name runtime.example.com;
    root /srv/openvessel/dist/runtime;

    location / {
        include snippets/openvessel-isolation.conf;
        include snippets/openvessel-runtime-csp.conf;
        add_header Cache-Control "no-cache" always;
    }
    location = /sw.js {
        # the network policy checks happen here: no CSP
        include snippets/openvessel-isolation.conf;
        add_header Cache-Control "no-cache" always;
    }
    location /chunks/ {
        include snippets/openvessel-isolation.conf;
        include snippets/openvessel-runtime-csp.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
}

# preview origin (one block for every session subdomain)
server {
    listen 443 ssl;
    server_name preview.example.com *.preview.example.com;
    root /srv/openvessel/dist/preview;

    location / {
        include snippets/openvessel-isolation.conf;
        add_header Cache-Control "no-cache" always;
    }
}

# host page
server {
    listen 443 ssl;
    server_name app.example.com;
    root /srv/app;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
}
```

nginx の既定の `mime.types` では `.js` が `application/javascript` になりますが、ブラウザはこれも JavaScript として受け付けます。

### Caddy

```text
runtime.example.com {
    root * /srv/openvessel/dist/runtime
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
        Cross-Origin-Resource-Policy "cross-origin"
    }
    @notSw not path /sw.js
    header @notSw Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors https://app.example.com"
    @chunks path /chunks/*
    header @chunks Cache-Control "public, max-age=31536000, immutable"
    @other not path /chunks/*
    header @other Cache-Control "no-cache"
    file_server
}

preview.example.com, *.preview.example.com {
    root * /srv/openvessel/dist/preview
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
        Cross-Origin-Resource-Policy "cross-origin"
        Cache-Control "no-cache"
    }
    file_server
}

app.example.com {
    root * /srv/app
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
    }
    file_server
}
```

（`*.preview.example.com` のワイルドカード証明書を取得するには、Caddy の DNS チャレンジが必要です。）

### Node.js（`scripts/serve.mjs`）

リポジトリの開発用サーバーが、ヘッダーの組み合わせのリファレンスです。`dist/playground`（ホスト）・`dist/runtime`・`dist/preview` を
3 つのポート、つまり `OV_PORT_BASE`（既定 5170）とそれに続く 2 つのポートで配信します。`OV_HOST_PORT`・`OV_RUNTIME_PORT`・
`OV_PREVIEW_PORT` でそれぞれを個別に変更できます。待ち受けるのは `127.0.0.1` だけで、`frame-ancestors` は
`http://localhost:<ホストのポート>` に設定します。

## 確認の一覧

- [ ] ホスト・ランタイム・プレビューが 3 つの別々のオリジンになっている（複数のユーザーで 1 つの環境を共有する場合は、プレビューの
      オリジンがセッションごとに分かれている）
- [ ] ホストのページが `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp`
      （または `credentialless`）を送り、`crossOriginIsolated` が `true` になっている
- [ ] `dist/runtime/` と `dist/preview/` のすべてのファイルが、COOP `same-origin`・COEP `require-corp`・CORP `cross-origin`
      を送っている
- [ ] `sw.js` を除くランタイムのすべてのファイルがランタイムの CSP を送り、`frame-ancestors` にホストのオリジンが入っている
- [ ] `runtime.html` の `openvessel-allowed-hosts` が `*` ではなく、ホストのオリジンになっている
- [ ] `.js` を JavaScript の MIME タイプで配信している
- [ ] `dist/runtime/` ディレクトリ全体をデプロイしている（`chunks/`・`compat/`・`nodelib.js`・`amaro.js`・`ts-strip.js`・ライセンス
      ファイルを含む）
- [ ] `runtimeUrl` と `previewUrl` が `/` で終わっている（または `runtimeUrl` が `runtime.html` の URL になっている）
- [ ] ハッシュ付きのチャンクは長期間キャッシュしてよい。それ以外、特に Service Worker は再検証させている
- [ ] 旧ランタイムで動かすつもりがなければ、`/etc/openvessel/node` が `legacy` になっていない
