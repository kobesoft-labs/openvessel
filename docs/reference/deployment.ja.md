# 配信

[English](deployment.md)

OpenVessel を本番に置く方法です。`dist/` の中身、どのディレクトリをどのオリジンに置くか、各オリジンに必要な
HTTP ヘッダーとその理由、キャッシュ、ヘッダーを付けられないホスト、パスの下での配信、セッションごとのプレビューの
オリジン、サーバーの設定例をまとめます。

## 3 つのオリジン

OpenVessel は 3 つのオリジンで動きます。ブラウザから見ると、それぞれが別のサイトです。

| オリジン | 置くもの | 読み込まれ方 | 持つもの |
|---|---|---|---|
| ホスト | 埋め込む側のアプリ（`dist/host/index.js` はふつうアプリに同梱） | 一番上のページ | 画面とホスト API |
| ランタイム | `dist/runtime/` | `OpenVessel.boot()` が作る見えない iframe（`runtime.html`） | カーネルの Worker・プロセスの Worker・通信の出口 |
| プレビュー | `dist/preview/` | 見えない中継の iframe（`__ov/relay.html`）と、プレビューごとの iframe | 開発中のサイト（仮想ポートから配信） |

[../SECURITY.md](../SECURITY.md) にある分離が成り立つには、3 つを別のオリジンにする必要があります。ランタイムが
ホストと同じオリジンにあっても、ホストは警告（`console.warn('OpenVessel: the runtime should be served from its own origin')`）
を出すだけで、起動は止めません。自分だけが使うデモなら 3 つを 1 つのオリジンに置けます（公開デモはそうしています。
[GitHub Pages](#ヘッダーを付けられないホストgithub-pages) を参照）。自分で管理していないコードを動かすなら、そうしないでください。

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://runtime.example.com/',   // "/" で終わるディレクトリか、runtime.html の URL そのもの
  previewUrl: 'https://preview.example.com/',   // "/" で終わるディレクトリ
});
```

`runtimeUrl` は `new URL('runtime.html', runtimeUrl)`、`previewUrl` は `new URL('./', previewUrl)` で解決します
（`src/host/index.ts`）。そのため、最後に `/` のない URL は親のディレクトリを指します。
`https://example.com/runtime` なら `https://example.com/runtime.html` を読みます。最後に `/` を付けたディレクトリか、
`…/runtime.html` の URL を渡してください。

## `dist/` の中身

`npm run build`（`scripts/build.mjs`）が `dist/` を書き出します。静的なファイルとして配置するのは `dist/runtime/` と
`dist/preview/` だけです。`dist/host/` は、アプリが import する npm パッケージの入口です。

### `dist/runtime/`（ランタイムのオリジン）

| ファイル | 中身 | 読み込まれるとき |
|---|---|---|
| `runtime.html` | ランタイムの iframe の文書。`<meta name="openvessel-allowed-hosts" content="*">` を含む | ホストが `OpenVessel.boot()` を呼んだとき |
| `runtime.js` | `runtime.html` のふつうのスクリプト（IIFE）。オリジンの確認、Service Worker の登録、カーネルの起動、ホストへの通り道の受け渡し（`src/runtime/runtime.ts`） | `runtime.html` と一緒に |
| `sw.js` | ランタイムの Service Worker（`src/runtime/sw.ts`）。`/__ov/esm/`・`/__ov/builtin/`・`/__ov/mw/`・`/__ov/esm-error` の ES モジュールの配信、通信の出口 `/__ov/net`、`/__ov/ping`、カーネルごとの `/__ov/k/<id>/` の下のランタイム自身のファイル、ランタイム自身のファイルへの分離のヘッダー | `runtime.js` がスコープ `./` で登録 |
| `kernel.js` | カーネル。ES モジュールの Worker（`src/kernel/index.ts`） | 起動ごとに 1 回、`new Worker('__ov/k/<id>/kernel.js', { type: 'module' })`。`<id>` はランタイムのフレームごとのでたらめなカーネルの id で、Service Worker が `kernel.js` を返す |
| `process.js` | **旧ランタイム**: 以前からの手書きの Node 互換の層（`src/node/worker.ts`）。プロセスごとに 1 つのモジュール Worker | 既定で、すべての `node` プロセス |
| `node-process.js` | **移植ランタイム**: Node.js 自身の `lib/` を、作り直した `internalBinding()` の上で動かす（`src/nodejs/boot.ts`）。プロセスごとに 1 つのモジュール Worker | VFS のファイル `/etc/openvessel/node` が `port` のとき、すべての `node` プロセス |
| `nodelib.js` | Node.js v22.23.4 の `lib/`（と `deps/`）のソースを文字列で持つもの。`scripts/gen-nodelib.mjs` が作る（約 4.5 MB）。ビルドのときに `vendor/node/` があった場合だけ書き出される | `node-process.js` が静的に import |
| `ts-strip.js` | sucrase（ふつうのスクリプト）。移植ランタイムが `require(esm)` の ESM → CommonJS の書き換えに使う | 移植ランタイムで初めて使うとき。同期の `XMLHttpRequest` で取って評価 |
| `amaro.js` | Node 自身の `amaro`（swc を WebAssembly にしたもの。JavaScript に埋め込み、約 3.4 MB）。Node が同梱するのと同じ版 | 移植ランタイムで初めて TypeScript の型を取り除くとき。同期の `XMLHttpRequest` |
| `chunks/chunk-<hash>.js` | `kernel.js` と `process.js` が共有するコード（esbuild の分割） | その 2 つが静的に import |
| `chunks/esm-<hash>.js` | 分割した sucrase | カーネルか旧ランタイムが初めて TypeScript を取り除く、または ESM を書き換えるときに動的 `import()` |
| `chunks/legacy-<hash>.js` | `@noble/hashes` の古いハッシュ | 組み込みの `md5sum` が動的 `import()` |
| `compat/index.json` | 互換パッケージの一覧。パッケージ名 → `{ range, file, integrity, pkg }` | npm のインストーラ（`src/kernel/npm/install.ts`）が 1 回だけ取る |
| `compat/<id>-<version>.tgz` | ネイティブのバイナリしか出していないパッケージの代わりの互換パッケージ（npm の tarball）。このビルドでは `pagefind-1.5.2.tgz`・`cn-font-split-7.4.3.tgz`・`resvg-js-2.6.2.tgz` | `npm install` がそのパッケージを置き換えるとき。完全性（`sha512`）を確かめる |
| `NODE-LICENSE.txt` | Node.js のライセンスと、同梱する依存の告知（`nodelib.js` と一緒に配る） | 読み込まれない。配置からは外さない |
| `AMARO-LICENSE.txt` | amaro と swc のライセンス（`amaro.js` と一緒に配る） | 読み込まれない。配置からは外さない |
| `*.map` | ソースマップ（`sourcemap: 'linked'`） | 開発者ツールだけ。なくてもよい |

チャンクのハッシュはビルドごとに変わります。名前の一覧ではなく、ディレクトリをまるごと配置してください。

`node` のプロセスにどちらのスクリプトを使うかは、プロセスを起動するたびに決まります。カーネルは
`/etc/openvessel/node` を読み、前後の空白を除いた中身が `port` なら `node-process.js`、そうでなければ `process.js`
を起動します（`src/kernel/index.ts` の `processScript()`）。公開している互換性の数字は移植ランタイムのものです。
移植ランタイムを使うには、プロセスを起動する前にこのファイルを書きます。

```ts
await vessel.mount({ node: 'port' }, { path: '/etc/openvessel' });
```

カーネルは、最後に起動したスクリプトの Worker を 2 つ待機させておきます（`WARM = 2`）。最初の `node` のあとは、
読み込み済みの Worker から始まります。

### `dist/preview/`（プレビューのオリジン）

| ファイル | 中身 |
|---|---|
| `__ov-sw.js` | プレビューの Service Worker（`src/preview/sw.ts`）。プレビューのディレクトリの一番上にあるので、既定のスコープがプレビュー全体になる |
| `__ov/relay.html` | 見えない中継の iframe の文書 |
| `__ov/relay.js` | 中継のふつうのスクリプト。`../__ov-sw.js` をスコープ `../` で登録し、カーネルへの通り道を渡す（`src/preview/relay.ts`） |
| `__ov/inject.js` | プレビューが表示するすべての HTML に差し込む。WebSocket のトンネルと、パスの下で配信するときの `fetch`/`XMLHttpRequest` のパスの補正（`src/preview/inject.ts`） |
| `*.map` | ソースマップ。なくてもよい |

プレビューのオリジンのそれ以外の URL は、すべて Service Worker が仮想ポートから答えます。そのため、プレビューする
サイトは（プレビューのディレクトリから見て）`__ov-sw.js`・`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js`・
`__ov/open` のパスを使えません。[プレビュー](preview.ja.md) を参照してください。

### `dist/host/` と `dist/types/`

| ファイル | 中身 |
|---|---|
| `dist/host/index.js` | ホスト API の ES モジュール（`package.json` の `main`/`exports`）。アプリから import する。ふつうはバンドルする |
| `dist/types/host/index.d.ts`・`dist/types/shared/policy.d.ts` | TypeScript の型宣言（`package.json` の `types`） |

`dist/playground/` は `npm run serve` が出す開発用の playground で、配置には含めません。

## ヘッダー

### まとめ

| ヘッダー | ホストのページ | ランタイム（`dist/runtime/`） | プレビュー（`dist/preview/`） |
|---|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin`（必須） | `same-origin` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` か `credentialless`（必須） | `require-corp` | `require-corp` |
| `Cross-Origin-Resource-Policy` | アプリに合わせて（`scripts/serve.mjs` は `same-origin`） | `cross-origin` | `cross-origin` |
| `Content-Security-Policy` | アプリのもの | 下のランタイムの CSP を、**`sw.js` を除く**すべてのファイルに | 要らない |
| `Content-Security-Policy: frame-ancestors` | — | ホストのオリジン | — |
| `Service-Worker-Allowed` | — | 要らない | 要らない |

`scripts/serve.mjs` が使うヘッダーの組と同じです。serve.mjs はエラーの応答にも同じヘッダーを付けます。

### それぞれのヘッダーが要る理由

**cross-origin isolation（COOP + COEP）。** システムコールは `SharedArrayBuffer` の上で `Atomics.wait` を使って待ちます
（[通信の形式](protocol.ja.md#同期のシステムコールの通り道)）。`SharedArrayBuffer` は cross-origin isolated な環境にしかありません。

- ホストのページは isolated である必要があります。`crossOriginIsolated` が false だと、`OpenVessel.boot()` は
  `OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).`
  を投げます。
- ランタイムの文書も isolated である必要があります。`runtime.js` はまず `sw.js` を登録します（ランタイムのファイルに
  分離のヘッダーを付けます。[下](#ヘッダーを付けられないホストgithub-pages)を参照）。Worker が制御したあとも isolated で
  なければ 1 回だけ読み直し（`sessionStorage` の印で 1 回に限る）、それでもだめなら
  `OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).`
  で失敗します。ホストはランタイムの iframe に `allow="cross-origin-isolated"` を付けて作ります。
- COEP のページに埋め込む文書は、それ自身にも COEP が要り、別オリジンなら `Cross-Origin-Resource-Policy: cross-origin`
  も要ります。`runtime.html` とプレビューの文書の両方に COEP と CORP `cross-origin` を付けるのはこのためです。
- カーネルとプロセスの Worker は、ランタイムのオリジンから読むモジュール Worker です。ほかのランタイムのファイルと
  同じヘッダーで配信します。

**ランタイムの CSP。** ランタイムの中のコード（プロジェクトとその依存）が届く先を絞ります。`scripts/serve.mjs` は
次を送ります。

```text
default-src 'self';
script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:;
connect-src 'self' data: blob:;
worker-src 'self' blob:;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
frame-ancestors <ホストのオリジン>
```

| ディレクティブ | コードが必要とする理由 |
|---|---|
| `script-src 'unsafe-eval'` | Node の組み込みモジュールは、`nodelib.js` から間接 `eval` でコンパイルする（`src/nodejs/boot.ts` の `compileBuiltin()`）。`vm`・CommonJS の包み・`amaro.js`・`ts-strip.js` も同じように評価する |
| `script-src 'wasm-unsafe-eval'` | esbuild・rollup・rolldown・lightningcss・amaro（swc）・互換パッケージは WebAssembly で動く |
| `script-src data:` | 移植ランタイムのモジュールローダーは `data:text/javascript,…` のモジュールを import する（`src/nodejs/bindings/module_wrap.ts`）。旧ランタイムも `eval` で ES モジュールを動かす `worker_threads` で使う |
| `connect-src 'self'` | この CSP の目的。プロセスは `fetch` や `WebSocket` でランタイムのオリジンの外へ出られないので、出口は `/__ov/net` だけになる。そこで Service Worker が通信の方針を確かめる |
| `frame-ancestors` | `runtime.html` を埋め込めるのをホストのページだけにする |

**`sw.js` には CSP を付けません。** Service Worker 自身の `fetch()` は、Worker のスクリプトと一緒に届いた CSP に従います。
ランタイムの Service Worker は通信の出口で、方針が許したあと本物の外への要求をします。`sw.js` に `connect-src 'self'`
があると、許したはずの要求がすべて失敗します。`scripts/serve.mjs` は `/sw.js` だけ CSP を外します。

**`frame-ancestors` とランタイム自身のオリジンの確認。** ランタイムは、誰が自分を埋め込んでいるかを 3 つの方法で確かめます。

| 確認 | 場所 | 失敗したとき |
|---|---|---|
| CSP の `frame-ancestors` | サーバー | ブラウザが iframe を表示しない。`boot()` は時間切れになる |
| `runtime.html` の `<meta name="openvessel-allowed-hosts">`。オリジンを空白かカンマで区切る。`*` はどこでも（配布時の既定） | `runtime.js` が `openvessel-connect` のメッセージの `origin` と比べる | `origin <origin> is not allowed to use this runtime` |
| `location.ancestorOrigins`（ブラウザにあれば）が 2 つ以上でないこと | `runtime.js` | `the runtime must be embedded directly by the host page` |

ホストではどれも `boot()` の失敗になります。下の 2 つは `OpenVessel: <メッセージ>`、1 つ目は（`timeout`、既定 30000 ms
のあと）`OpenVessel: runtime did not start in time` です。配置する `runtime.html` の meta を書き換えてください。

```html
<meta name="openvessel-allowed-hosts" content="https://app.example.com https://staging.example.com">
```

**プレビューのオリジン。** プレビューの静的なファイルには、上の COOP/COEP/CORP が要ります。プレビューが表示するものは
すべて Service Worker から来ます。Service Worker は、各応答に `cross-origin-embedder-policy: credentialless`・
`cross-origin-resource-policy: cross-origin`・`cross-origin-opener-policy: same-origin` を（まだ無ければ）付けます。
そのため開発サーバーがこれらを送る必要はありません。`credentialless` なので、CORP を送らない外の画像やスクリプトも
読めます。プレビューのオリジンにランタイムの CSP は付けないでください。プレビューは Service Worker で独自に方針を
確かめます（[プレビュー](preview.ja.md#外への要求と通信の方針)）。

**`Service-Worker-Allowed`** は要りません。ランタイムは `sw.js` をスコープ `./`（自分のディレクトリ）で、中継は
`../__ov-sw.js` をスコープ `../`（プレビューのディレクトリ。Worker のスクリプトがあるディレクトリでもある）で登録します。

### MIME タイプ

| 拡張子 | タイプ | 注意 |
|---|---|---|
| `.html` | `text/html; charset=utf-8` | |
| `.js` | `text/javascript; charset=utf-8` | 必須。JavaScript 以外のタイプだと、モジュール Worker・`import`・Service Worker のスクリプトは拒まれる |
| `.json` | `application/json` | `compat/index.json`・ソースマップ |
| `.map` | `application/json` | |
| `.tgz` | `application/gzip` か `application/octet-stream` | `fetch().arrayBuffer()` で読む。タイプは確かめない |
| `.txt` | `text/plain; charset=utf-8` | ライセンスのファイル |

`dist/` に `.wasm` のファイルはありません。WebAssembly は JavaScript に埋め込まれているか（`amaro.js`）、互換パッケージの
tarball の中にあるか、npm からメモリ上のファイルシステムに入れてバイト列からコンパイルします。自分でファイルを足すなら、
`.wasm` は `application/wasm` で配信してください。

## キャッシュ

ファイルの名前の付け方から決まります。

| ファイル | おすすめ | 理由 |
|---|---|---|
| `runtime/chunks/*-<hash>.js` | 長く、`immutable` | 中身が変わると名前も変わる |
| `runtime/compat/<id>-<version>.tgz` | 長く | 名前に版がある。どのみち `index.json` の `integrity` で確かめる |
| `runtime/sw.js`・`preview/__ov-sw.js` | `no-cache` | Service Worker の更新が届く必要がある。ランタイムは `updateViaCache: 'none'` で登録する |
| ほかのすべて（`runtime.html`・`runtime.js`・`kernel.js`・`process.js`・`node-process.js`・`nodelib.js`・`amaro.js`・`ts-strip.js`・`compat/index.json`・`__ov/*`） | `no-cache`（`ETag`/`Last-Modified` で確かめ直す） | 名前は固定で、中身はリリースごとに変わる。`kernel.js` と `process.js` は同じビルドのハッシュ付きチャンクを名前で指す |

`scripts/serve.mjs` はすべてに `cache-control: no-cache` を付けます。Service Worker が自分で作る応答はキャッシュされません。
`/__ov/esm/`・`/__ov/builtin/`・`/__ov/mw/`・`/__ov/esm-error` のモジュールと `/__ov/net` の応答には `cache-control: no-store` が付きます。

npm のクライアントは、確かめた tarball をランタイムのオリジンの Cache Storage（キャッシュ名 `openvessel-npm-v1`）に置き、
読み戻すときにも完全性を確かめ直します。これはブラウザごと、ランタイムのオリジンごとです。

## ヘッダーを付けられないホスト（GitHub Pages）

2 つの Service Worker は、自分が配信するファイルに分離のヘッダーを付けます。サーバーが送ったヘッダーはそのまま残します。

| Service Worker | 付ける対象 | 無いときに付けるヘッダー |
|---|---|---|
| ランタイムの `sw.js` | スコープの中の同じオリジンへの `GET` のうち、`/__ov/…` の窓口でないものすべて（opaque とステータス 0 の応答はそのまま） | `cross-origin-opener-policy: same-origin`・`cross-origin-embedder-policy: require-corp`・`cross-origin-resource-policy: cross-origin` |
| プレビューの `__ov-sw.js` | 自分のファイル（`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js`・`__ov-sw.js`）、`__ov/open` のリダイレクト、仮想ポートからのすべての応答 | `cross-origin-embedder-policy: credentialless`・`cross-origin-resource-policy: cross-origin`・`cross-origin-opener-policy: same-origin` |

Service Worker が制御するのは、インストールされたあとに読み込んだ文書だけです。`runtime.html` と `__ov/relay.html` の
最初の読み込みは、これらの Worker の制御の外です。`runtime.js` は `sw.js` を登録してフレームを 1 回読み直すので、
読み直した `runtime.html` には Worker がヘッダーを付けます。ただしこれが効くのはフレームがそもそも読み込めたときだけで、
isolated なホストのページの中では、最初の読み込みにも COEP と CORP が要ります。そのため、ヘッダーをまったく送らない
ホストでは、最初の読み込みを isolated にするものが別に必要です。
デモ（[openvessel-demo](https://github.com/kobesoft-labs/openvessel-demo)）は次のようにしています。

- ページ・`runtime/`・`preview/` を 1 つのオリジン（GitHub Pages）の、1 つのサイトのディレクトリに置く。`runtime/` は
  `dist/runtime` の、`preview/` は `dist/preview` のコピー。
- ページはサイトの一番上から自分の `coi-sw.js` を登録する。そのスコープ（サイトのディレクトリ）は `runtime/` と
  `preview/` も含むので、それぞれの Worker が入るまでは、`coi-sw.js` が同じオリジンへのすべての `GET`（`runtime.html` と
  `relay.html` を含む）に `cross-origin-opener-policy: same-origin`・`cross-origin-embedder-policy: require-corp`・
  `cross-origin-resource-policy: cross-origin` を付ける。登録が済むと、ランタイムとプレビューの Worker が、より狭い
  自分のスコープを引き継ぐ。
- ページは `coi-sw.js` を登録したあと 1 回だけ読み直す（`sessionStorage` の印で 1 回に限る）。それでも isolated に
  ならなければ「対応していない」と表示する。

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

デモはページからの相対 URL で起動し、プロセスを移植ランタイムに切り替えます。

```ts
const here = new URL('./', location.href);
const vessel = await OpenVessel.boot({
  runtimeUrl: new URL('runtime/runtime.html', here).href,
  previewUrl: new URL('preview/', here).href,
  network: { mode: 'allowlist', presets: ['npm', 'fonts', 'cdn'] },
});
await vessel.mount({ node: 'port' }, { path: '/etc/openvessel' });
```

デモの `build.mjs` は `dist/runtime` を `site/runtime` に、`dist/preview` を `site/preview` にコピーし、空の `.nojekyll`
（GitHub Pages がすべてのファイルをそのまま配信するように）を置きます。`deploy.mjs` は `site/` を `gh-pages` の枝に
force-push します。ヘッダーが無いので、ランタイムの CSP も `frame-ancestors` もありません。この形では、外への
`connect-src` の絞り込みと、埋め込みの制限をあきらめることになります。1 つのオリジンなので、オリジンの分離も
あきらめます。デモだけに使ってください。

## パスの下での配信

ランタイムもプレビューも、サブディレクトリから配信できます（例: `https://example.com/demo/runtime/` と
`https://example.com/demo/preview/`）。

**ランタイム。** カーネルは自分の基準の URL を `kernel.js` のディレクトリから（`src/kernel/base.ts` の `RUNTIME_BASE`）、
それぞれのランタイムは自分の Worker のスクリプト（`node-process.js`・`process.js`）のディレクトリから取ります。
Service Worker は要求のパスからスコープ（とカーネルの `/__ov/k/<id>/` の前置き）を取り除いてから `/__ov/…` と照らし合わせます。
npm のクライアントの `/__ov/net` と `compat/` の取得、移植ランタイムの `/__ov/net` と `/__ov/mw/` の URL、旧ランタイムの
`/__ov/esm/`・`/__ov/builtin/`・`/__ov/net` の URL（カーネルが配るモジュールに書き込むものも）は、どれもこの基準からの相対です。
`kernel.js` は `__ov/k/<id>/kernel.js` として起動し、プロセスの Worker を自分と同じ場所から起動するので、基準は
`<ランタイムのディレクトリ>/__ov/k/<id>` です。Service Worker はその下の `/__ov/…` をカーネル `<id>` への要求として
答え、その下のランタイム自身のファイルはランタイムのディレクトリから返します。なので、いくつものランタイムのフレーム
（複数のタブや、1 つのページでの複数の `boot()`）が、それぞれのカーネルで Service Worker を共有できます。前置きの無い
`/__ov/…` の要求は、参照元（あるカーネルの前置きの下のファイルか、そのカーネルが返したモジュール）から決めたカーネルへ、
分からなければ最後につながったカーネルへ送ります。

**プレビュー。** Service Worker のスコープはプレビューのディレクトリです。OpenVessel の中の開発サーバーは、サイトを
あくまで `/` で配信するので、Service Worker が両者を対応させます。

- 要求のパスからスコープを取り除いてから仮想ポートに渡す
- HTML のページでは、ルートからの相対の `src`・`href`・`action`・`poster`・`formaction`・`srcset` の値の前にスコープを
  付ける。差し込むスクリプトと一緒に import map `{"imports": {"/": "<scope>", "<scope>": "<scope>"}}` を入れ、ルートからの
  モジュール指定子（`/@vite/client`・`/src/…`）がスコープの下に解決されるようにする
- ルートからの相対の `Location` ヘッダーも同じように書き換える
- `inject.js` が `fetch()` と `XMLHttpRequest.prototype.open` を包み、ルートからの相対の文字列の URL にもスコープを付ける

ほかの方法で作った URL（たとえば `new URL('/x', location.href)` を `fetch` に渡す、CSS の `url(/…)`）は書き換えません。
プレビューを専用のオリジンの一番上で配信すれば、これらはすべて不要です。

## セッションごとのプレビューのオリジン

多人数で使うときは、セッション（利用者・ワークスペース）ごとにプレビューのオリジンを分けます。たとえば
`https://<session>.preview.example.com/` です（[../SECURITY.md](../SECURITY.md)）。サブドメインが違えばオリジンも違うので、
あるセッションのプレビューのページは、ほかのセッションのクッキー・ストレージ・Service Worker の状態を読めません。

- すべてのサブドメインで同じ `dist/preview/` を配信する（ワイルドカードの DNS のレコードと証明書、ワイルドカードの
  `server_name` を持つ 1 つの server ブロック）
- 起動のときにセッションの URL を `previewUrl` に渡す。ホストはそこからプレビューのオリジンを求め、中継のメッセージは
  そのオリジンのその iframe からだけ受け取る
- 各サブドメインは、初めて使うときにプレビューの Service Worker を自分で登録する
- ランタイムのオリジンは共有できる。ランタイムは `boot()` ごとに作られ、プレビューへの通り道はホストが自分でカーネルに
  渡すので、カーネルはプレビューのオリジンを知る必要がない

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
| 登録 | `register('./sw.js', { scope: './', updateViaCache: 'none' })` のあと `reg.update()` | 中継が `register('../__ov-sw.js', { scope: '../' })` |
| 起動のとき | Worker が installing か waiting のあいだ、`runtime.js` は `controllerchange` を待つ。古い Worker のままカーネルを起動しない | 中継は `navigator.serviceWorker.ready` を待つ |
| 動いている途中の更新 | `controllerchange` で、`runtime.js` が新しい Worker にカーネルへの新しい通り道を渡す | 新しい Worker は、初めて必要になったときに通り道を求める |

どちらの Worker も、カーネルへの通り道をメモリに持ちます。ブラウザが暇な Worker を止めて、また起動すると、Worker は
新しい通り道を求めます（`need-kernel-port`）。ランタイムの Worker は `runtime.html` に、プレビューの Worker は中継に
求め、中継はホストに求めます。要求は通り道を最大 15 秒待ちます。プレビューの Worker がメモリに持つ状態（どのプレビューの
ページがどのポートのものか、許可したホスト）は、こうして起動し直すと空に戻ります。[通信の形式](protocol.ja.md) を参照してください。

## ブラウザの条件

OpenVessel は Chromium 系のブラウザで開発・テストしています（エンドツーエンドのテストは Chrome を動かします）。
コードが頼っているのは次のものです。

- cross-origin isolation、`SharedArrayBuffer`、Worker の中の `Atomics.wait`
- モジュール Worker（`new Worker(url, { type: 'module' })`）と、カーネルの Worker から作る入れ子の Worker
- ランタイムとプレビューのオリジンの、別オリジンの iframe の中の Service Worker
- iframe の `allow="cross-origin-isolated"`
- Worker の中の同期の `XMLHttpRequest`（移植ランタイム: `amaro.js`・`ts-strip.js`）
- 組み込みの許可のダイアログのための `<dialog>`（`onPermissionRequest` を渡さないときだけ）

`location.ancestorOrigins` はあれば使います。

## 設定例

上のヘッダーの組をそのまま送る設定です。ホスト名は置き換えてください。`app.example.com` がホストのページです。

### nginx

nginx では、自分の `add_header` を持つ `location` の中で、server の階層の `add_header` が効かなくなります。そのため共通の
ヘッダーは snippet にして、必要な所で include します。

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
        # the network gate: no CSP here
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

nginx の既定の `mime.types` は `.js` を `application/javascript` にします。ブラウザはこれも JavaScript として受け付けます。

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

（`*.preview.example.com` のワイルドカードの証明書には、Caddy の DNS チャレンジが要ります。）

### Node.js（`scripts/serve.mjs`）

リポジトリの開発用サーバーが、ヘッダーの組の手本です。`dist/playground`（ホスト）・`dist/runtime`・`dist/preview` を
3 つのポート、`OV_PORT_BASE`（既定 5170）とその次の 2 つで配信します。`OV_HOST_PORT`・`OV_RUNTIME_PORT`・
`OV_PREVIEW_PORT` でそれぞれを変えられます。待ち受けは `127.0.0.1` だけで、`frame-ancestors` は
`http://localhost:<ホストのポート>` です。

## 確認の一覧

- [ ] ホスト・ランタイム・プレビューが 3 つの別のオリジンになっている（多人数で 1 つの配置を使うなら、プレビューの
      オリジンがセッションごとになっている）
- [ ] ホストのページが `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp`
      （か `credentialless`）を送り、`crossOriginIsolated` が `true` になる
- [ ] `dist/runtime/` と `dist/preview/` のすべてのファイルが、COOP `same-origin`・COEP `require-corp`・CORP `cross-origin`
      を送る
- [ ] `sw.js` を除くランタイムのすべてのファイルがランタイムの CSP を送り、`frame-ancestors` にホストのオリジンがある
- [ ] `runtime.html` の `openvessel-allowed-hosts` が `*` ではなくホストのオリジンになっている
- [ ] `.js` を JavaScript の MIME タイプで配信している
- [ ] `dist/runtime/` をまるごと配置している（`chunks/`・`compat/`・`nodelib.js`・`amaro.js`・`ts-strip.js`・ライセンスの
      ファイルを含む）
- [ ] `runtimeUrl` と `previewUrl` が `/` で終わっている（か、`runtimeUrl` が `runtime.html` の URL）
- [ ] ハッシュ付きのチャンクは長くキャッシュしてよい。ほか、特に Service Worker は確かめ直す
- [ ] プロセスを移植ランタイムで動かすなら、`/etc/openvessel/node` が `port` になっている
