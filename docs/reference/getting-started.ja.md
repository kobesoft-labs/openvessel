# はじめに

[English](getting-started.md)

空の Web ページから、OpenVessel の中でプロジェクトを動かすところまでを順に説明します。パッケージを入れ、3 つの
オリジンにファイルを置き、起動し、Node.js の層を選び、プロジェクトを書き込み、`npm install`・ビルド・開発サーバーと
プレビュー・対話のターミナル・後片付けまでです。ここで使う呼び出しの細かい仕様は [ホスト API](host-api.ja.md) に、
本番での配信は [配信](deployment.ja.md) にあります。

## 必要なもの

| 必要なもの | 理由 |
|---|---|
| Chromium 系のブラウザ | OpenVessel を試験しているブラウザです（[README](../../README.ja.md)）。 |
| ホストのページの cross-origin isolation（`Cross-Origin-Opener-Policy: same-origin` と、`Cross-Origin-Embedder-Policy: require-corp` か `credentialless`） | カーネルとプロセスは `SharedArrayBuffer` と `Atomics.wait` でやり取りします。ブラウザはこれを cross-origin isolated なページでしか使わせません。`OpenVessel.boot()` は最初に `crossOriginIsolated` を確かめ、偽なら失敗します。 |
| 3 つのオリジン: 自分のページ・ランタイム・プレビュー | ランタイム（カーネル・プロセス・通信の関所）とプレビュー（作っているサイト）は、自分のページとも、お互いとも、オリジンを分けます（[しくみ](../how-it-works.ja.md#3-つのオリジン)）。 |

手元で試すときは、`localhost` の 3 つのポートを 3 つのオリジンにできます。OpenVessel のリポジトリの
`npm run serve` がそうしています。

## 入れる

パッケージは、[GitHub のリリース](https://github.com/kobesoft-labs/openvessel/releases)ごとに付けている tarball
（`openvessel-<版>.tgz`）です。npm のレジストリには載せていません。リリースの URL か、ダウンロードしたファイルから入れます。

```bash
npm install https://github.com/kobesoft-labs/openvessel/releases/download/v1.1.1/openvessel-1.1.1.tgz
```

パッケージは ES モジュールで、入口は 1 つです。

| `package.json` の項目 | 値 | 中身 |
|---|---|---|
| `exports["."].default`・`main` | `./dist/host/index.js` | ホスト API。1 つにまとめてあり、実行時の依存はありません。 |
| `exports["."].types`・`types` | `./dist/types/host/index.d.ts` | TypeScript の型の宣言（`dist/types/shared/policy.d.ts` を読みます）。 |
| `openvessel.node` | `22.23.4` | 移植した Node.js の層が追っている Node.js の版。 |

```ts
import { OpenVessel, PRESETS, type BootOptions, type Process } from 'openvessel';
```

## `dist/` の中身

公開するのは `dist/` だけです。ディレクトリごとに置き場所が違います。

| ディレクトリ | 中身 | 置き場所 |
|---|---|---|
| `dist/host/` | `index.js`（ホスト API） | 自分のページのバンドルの中（`import 'openvessel'` で）。 |
| `dist/types/` | `.d.ts` | TypeScript だけが使います。 |
| `dist/runtime/` | `runtime.html`・`runtime.js`・`sw.js`・`kernel.js`・`process.js`（旧来の層）・`node-process.js` と `nodelib.js`（移植した層）・`ts-strip.js`・`amaro.js`・`chunks/`・`compat/`（互換パッケージの tarball と `index.json`）・ライセンスのファイル | **ランタイムのオリジン**に、1 つのディレクトリのまま。パスの下に置いてもかまいません（例: `https://example.com/ov/runtime/`）。 |
| `dist/preview/` | `__ov-sw.js`・`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js` | **プレビューのオリジン**に、1 つのディレクトリのまま。こちらもパスの下に置けます。 |
| `dist/playground/` | リポジトリの試し書きのページ | 埋め込みには要りません。 |

ランタイムとプレビューのディレクトリは、そのままコピーしてください。ファイルどうしは相対 URL で見つけ合います。

## 3 つのオリジンで配る

ヘッダーの手本は、リポジトリの `scripts/serve.mjs` です。`dist/playground`・`dist/runtime`・`dist/preview` を
ポート 5170・5171・5172 で配ります（`OV_PORT_BASE` で 3 つまとめてずらし、`OV_HOST_PORT`・`OV_RUNTIME_PORT`・
`OV_PREVIEW_PORT` で 1 つずつ決められます）。

| オリジン | `scripts/serve.mjs` が付けるヘッダー |
|---|---|
| ホストのページ | `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Embedder-Policy: require-corp`・`Cross-Origin-Resource-Policy: same-origin` |
| ランタイム | `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Embedder-Policy: require-corp`・`Cross-Origin-Resource-Policy: cross-origin`。さらに `sw.js` 以外のすべてのファイルに `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors <ホストのオリジン>` |
| プレビュー | `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Embedder-Policy: require-corp`・`Cross-Origin-Resource-Policy: cross-origin`・`Service-Worker-Allowed: /` |

ランタイムの `connect-src 'self'` が、プロセスの中のコードを関所の外から通信させないための仕掛けです。`sw.js` には
付けません。Service Worker 自身が関所だからです。ヘッダーを付けられない静的な配信先、埋め込めるオリジンの絞り方など、
配信のことは [配信](deployment.ja.md) にまとめてあります。

`dist/runtime/runtime.html` には `<meta name="openvessel-allowed-hosts" content="*">` があります。`*` を、ランタイムを
埋め込んでよいオリジンに書き換えてください（空白かカンマで区切る）。ほかのオリジンからの `boot()` は
`origin … is not allowed to use this runtime` で失敗します。

埋め込む前に OpenVessel 自体を試すには、リポジトリを clone して `npm install`・`npm run build`・`npm run serve` を
実行し、http://localhost:5170 を開きます。

## いちばん小さいホストのページ

```text
<!doctype html>
<html>
<head><meta charset="utf-8"><title>OpenVessel</title></head>
<body>
  <pre id="log"></pre>
  <div id="preview" style="height:480px"></div>
  <script type="module" src="./main.js"></script>
</body>
</html>
```

上のホストのページのヘッダーを付けて配ります。`boot()` は見えない iframe を `document.body` に足すので、body が
できてから呼んでください（body の最後のモジュールのスクリプトか、`DOMContentLoaded` のあと）。

## 起動する

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://rt.example.com/',   // runtime.html のあるディレクトリ（か runtime.html そのもの）
  previewUrl: 'https://pv.example.com/',   // __ov-sw.js のあるディレクトリ。最後は "/"
  network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'] },
});
```

`boot()` は見えない iframe に `runtime.html` を読み込みます。そのページがランタイムの Service Worker を登録し、
カーネルの Worker を起動します。カーネルの準備ができると解決し、`timeout`（既定は 30 000 ms）を過ぎると失敗します。
オプションとエラーはすべて [ホスト API](host-api.ja.md#openvesselboot) にあります。通信の方針は
[通信の方針](network-policy.ja.md) で説明しています。`mode: 'ask'` で `onPermissionRequest` を渡さないと、
用意したセットに無いホストについて、組み込みのダイアログが利用者に尋ねます。

1 つのブラウザのプロファイルで同時に使えるのは、ランタイムのオリジンごとに 1 つです。ランタイムの Service Worker は
いちばん新しいカーネルへの接続しか持たないので、同じランタイムのオリジンで 2 つ目のタブや 2 回目の `boot()` を
始めると、モジュールの読み込みと通信の判定を、そちらが引き取ってしまいます。

## Node.js の層を選ぶ

ビルドには Node.js の層が 2 つ入っています。カーネルは `node` のプロセスを起動するたびに、どちらかを選びます。

| 層 | スクリプト | 使われるとき |
|---|---|---|
| 移植した層 | `dist/runtime/node-process.js`（`src/nodejs/`）。Node.js v22.23.4 自身の `lib/` を、TypeScript で書いた `internalBinding()` の上で動かす | VFS のファイル `/etc/openvessel/node` の中身が `port` のとき（前後の空白は無視） |
| 旧来の層 | `dist/runtime/process.js`（`src/node/worker.ts`）。以前の、手で書いた Node 互換の層 | それ以外（既定） |

[互換性](../compatibility.ja.md) の数字は、すべて移植した層で計ったものです。起動の直後に選んでください。

```ts
await vessel.mount({ node: 'port' }, { path: '/etc/openvessel' });
// これと同じ: await vessel.fs.writeFile('/etc/openvessel/node', 'port');
```

このファイルはプロセスを起動するたびに読まれます。もう動いているプロセスは、起動したときの層のままです。
詳しくは [Node.js の層](nodejs-runtime.ja.md) を見てください。

## プロジェクトをファイルシステムに入れる

ファイルシステムはメモリの上にあり、最初は基本のシステム（`/bin`・`/usr`・`/home/user`・`/tmp`・`/etc`・`/dev`・
`/proc` など）だけです。起動をまたいで残るものはありません。

```ts
const APP = '/home/user/app';
await vessel.mount(
  {
    'package.json': JSON.stringify({
      name: 'site', type: 'module', private: true,
      scripts: { dev: 'astro dev', build: 'astro build' },
      dependencies: { astro: '^5.18.0' },
    }, null, 2),
    'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
    'src/pages/index.astro': '<h1>Hello from OpenVessel</h1>\n',
    'public/favicon.ico': new Uint8Array([/* バイト列 */]),
  },
  { path: APP },
);
```

キーは `path`（既定は `/home/user/app`）からの相対パス、値は文字列（`string`）・バイト列（`Uint8Array`）・空の
ディレクトリなら `null`・シンボリックリンクなら `{ symlink: 先 }` です。無いディレクトリは作られます。利用者が選んだ
フォルダを入れるときは、`File` を 1 つずつ `Uint8Array` に読みます（試し書きのページは、そのとき `node_modules/` と
`.git/` を飛ばしています）。

## 依存を入れる

```ts
const install = await vessel.spawn('npm', ['install'], { cwd: APP });
install.output.pipeTo(new WritableStream({ write: (s) => log(s) }));
if ((await install.exit) !== 0) throw new Error('npm install failed');
```

`npm`・`pnpm`・`yarn`・`bun` はカーネルに入っています（[パッケージマネージャ](package-managers.ja.md)）。レジストリへの
問い合わせと tarball は通信の関所を通るので、方針でレジストリを許す必要があります。用意したセットの `npm` が
`registry.npmjs.org` とよく使われるミラーを含んでいます。ネイティブのバイナリを持つパッケージは、WebAssembly 版が
入ります（[ネイティブのモジュール](native-modules.ja.md)）。

[デモ](https://kobesoft-labs.github.io/openvessel-demo/) は、プロセスに
`env: { ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '1', NODE_NO_WARNINGS: '1' }` を渡しています。

## ビルドする

```ts
const { code, output } = await vessel.exec('npm run build', { cwd: APP });
if (code !== 0) console.error(output);

// 結果を読み出す: { 'index.html': Uint8Array, '_astro/…': Uint8Array, … }
const files = await vessel.export(`${APP}/dist`);
```

`exec()` はコマンド行を `/bin/sh -c` で実行し、終了コードと、標準出力と標準エラーを合わせた出力で解決します。
解決するのは、プロセスが終わり、**しかも**出力のパイプが閉じたときです。出力を握ったままの裏のジョブを残す
コマンド（`npm run dev &`）だと待ち続けます。ずっと動くサーバーは `spawn()` で起動してください。

## 開発サーバーを動かしてプレビューを出す

```ts
vessel.on('server-ready', async ({ port }) => {
  const frame = await vessel.createPreview(port, { container: document.getElementById('preview')! });
  // frame はプレビューのオリジンの sandbox 付き <iframe>。http://localhost:<port>/ を表示する
});
const dev = await vessel.spawn('npm', ['run', 'dev'], { cwd: APP });
```

リスナーは、サーバーを起動する前に登録します。`server-ready` は、プロセスが仮想ポートで待ち受けたときに届きます
（Astro の開発サーバーは 4321）。止まると `port-closed` が届きます。`createPreview()` は、初めて使うときにプレビューの
中継を起動し、iframe を作って `container` に足します。iframe を自分で置くなら `await vessel.previewUrl(port, '/about/')`
を使います。HMR はプレビューの Service Worker を通して動きます（[プレビュー](preview.ja.md)）。

## xterm.js で対話のターミナル

`terminal` を付けて起動したプロセスは TTY を持ちます。標準入力・標準出力・標準エラーが端末になり、行の規律が入力を
エコーして編集させ、Ctrl-C が前面のプロセスグループに `SIGINT` を送り、出力の `\n` は `\r\n` になります。試し書きの
ページ（`playground/app.ts`）とデモは、[xterm.js](https://xtermjs.org)（`@xterm/xterm` と `@xterm/addon-fit`）を
次のようにつないでいます。

```ts
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const term = new Terminal({ fontSize: 13, cursorBlink: true });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term')!);
fit.fit();

const shell = await vessel.spawn('/bin/sh', ['-i'], {
  cwd: APP,
  terminal: { cols: term.cols, rows: term.rows },
});

// 出力 → 端末
(async () => {
  const reader = shell.output.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    term.write(value);
  }
  term.writeln('\r\n[shell exited]');
})();

// キーボード → プロセス、大きさ → プロセス（SIGWINCH）
term.onData((d) => shell.write(d));
term.onResize(({ cols, rows }) => shell.resize(cols, rows));
new ResizeObserver(() => fit.fit()).observe(document.getElementById('term')!);
```

利用者の代わりにコマンドを打つときは、復帰（CR）を付けて書きます: `shell.write('npm run dev\r')`。
`shell.end()` はパイプ用です。端末のプロセスでは失敗します。入力の終わりは、行の先頭で `\x04`（Ctrl-D）を送ります。

## 動かしながらファイルを書き換える

```ts
await vessel.fs.writeFile(`${APP}/src/pages/index.astro`, '<h1>Edited</h1>\n');

const stop = await vessel.fs.watch(APP, (ev) => {
  // ev.type は 'rename'（作成・削除・名前の変更）か 'change'。ev.path は変わったパス
  console.log(ev.type, ev.path);
});
// あとで: await stop();
```

ホストからの書き込みは、カーネルの中のすべての監視に伝わります。開発サーバーのファイルの監視（Node の `fs.watch`）が
変更に気づき、プレビューが更新されます。ホストの `fs.watch` には、プロセスが加えた変更（ターミナルで作ったファイル、
`npm install`）も届きます。

## 後片付け

```ts
vessel.teardown();
```

`teardown()` はランタイムと中継の iframe を外し、カーネルへの通り道を閉じます。カーネルの Worker とすべての
プロセスは、ランタイムの iframe と一緒に終わります。メモリ上のファイルシステムも消えます。自分のページに置いた
プレビューの iframe は外しません。答えを待っている呼び出しは、解決も失敗もしないままです。ランタイムとプレビューの
オリジンの Service Worker の登録と、npm の tarball のキャッシュ（ランタイムのオリジンの Cache Storage
`openvessel-npm-v1`）はブラウザに残ります。

## うまく動かないとき

| 症状 | 原因 |
|---|---|
| `OpenVessel: the host page must be cross-origin isolated (…)` | ホストのページに `Cross-Origin-Opener-Policy: same-origin` か `Cross-Origin-Embedder-Policy` がありません。 |
| `OpenVessel: OpenVessel needs a cross-origin isolated page (…)` | ランタイムのページが cross-origin isolated になっていません。ランタイム自身の COOP/COEP のヘッダーが無い（ランタイムの Service Worker が足すのは、それが入ったあとだけ）か、ホストのページの COEP に止められています（ランタイムは `Cross-Origin-Resource-Policy: cross-origin` を返す必要があります）。 |
| `OpenVessel: runtime did not start in time` | `runtime.html` が読み込めないか、`timeout` までに答えませんでした。`runtimeUrl`（最後が `/` か、`runtime.html` を指す）と `frame-ancestors` を確かめてください。 |
| `OpenVessel: origin … is not allowed to use this runtime` | ホストのオリジンが、`runtime.html` の `openvessel-allowed-hosts` にありません。 |
| `OpenVessel: the runtime must be embedded directly by the host page` | `boot()` を呼んだページ自身が、フレームの中にあります。 |
| `OpenVessel: previewUrl was not configured` | `boot()` に `previewUrl` を渡さずに `createPreview()`・`previewUrl()` を呼びました。 |
| `OpenVessel: preview relay did not start` | プレビューのオリジンの `__ov/relay.html` が、20 秒以内に読み込みと Service Worker の登録を終えませんでした。 |
| プロセスが `fetch failed` と `EACCES` を出す | 通信の方針がそのホストを断りました。 |
| プロセスが `fetch failed` と `ECONNREFUSED` と CORS の説明を出す | 方針は許しましたが、相手のサーバーがブラウザからのクロスオリジンの要求を許していません（[通信の方針](network-policy.ja.md#cors)）。 |
| `node` が `Error: module … is not registered` を出す | 同じランタイムのオリジンで、別のタブか別の `boot()` がランタイムの Service Worker を引き取りました。 |

## 次に読むもの

- [ホスト API](host-api.ja.md) — すべてのメソッド・オプション・イベント・エラー。
- [通信の方針](network-policy.ja.md) — タブの外へ何を出してよいか、利用者にどう尋ねるか。
- [配信](deployment.ja.md) — 本番のオリジン・ヘッダー・静的な配信先。
- [プレビュー](preview.ja.md) — iframe が開発サーバーに届くしくみ。
