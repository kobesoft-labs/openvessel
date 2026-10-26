# はじめに

[English](getting-started.md)

空の Web ページに OpenVessel を埋め込み、その中でプロジェクトを動かすまでの手順です。パッケージのインストール、
3 つのオリジンでのファイルの配信、起動、Node.js ランタイムの選択、プロジェクトの配置、`npm install`、ビルド、
開発サーバーとプレビュー、対話型のターミナル、終了処理までを順に説明します。ここで使う API の詳しい仕様は
[ホスト API](host-api.ja.md) に、本番環境での配信は [配信](deployment.ja.md) にあります。

## 必要なもの

- Chromium 系のブラウザか Firefox。OpenVessel のテストはこれらのブラウザで行っています（[README](../../README.ja.md)）。
  Firefox では移植版ランタイムを使ってください。いくつか動作の違いがあります（[互換性](../compatibility.ja.md#firefox)）。
- ホストページの cross-origin isolation（`Cross-Origin-Opener-Policy: same-origin` と、
  `Cross-Origin-Embedder-Policy: require-corp` または `credentialless`）。カーネルとプロセスは `SharedArrayBuffer` と
  `Atomics.wait` で通信しますが、ブラウザはこれらを cross-origin isolated なページでしか使えないようにしています。
  `OpenVessel.boot()` は最初に `crossOriginIsolated` を確認し、偽であれば失敗します。
- 3 つのオリジン（ホストページ、ランタイム、プレビュー）。ランタイム（カーネル、プロセス、外部通信の制御）と
  プレビュー（開発中のサイト）は、ホストページとも互いとも別のオリジンにする必要があります
  （[仕組み](../how-it-works.ja.md#3-つのオリジン)）。

ローカルでは、`localhost` の 3 つのポートを 3 つのオリジンとして使えます。OpenVessel のリポジトリの
`npm run serve` もこの方法です。

## インストール

パッケージは、[GitHub のリリース](https://github.com/kobesoft-labs/openvessel/releases)ごとに添付している tarball
（`openvessel-<バージョン>.tgz`）で配布しています。npm のレジストリには公開していません。リリースの URL か、
ダウンロードしたファイルからインストールしてください。

```bash
npm install https://github.com/kobesoft-labs/openvessel/releases/download/v1.1.1/openvessel-1.1.1.tgz
```

パッケージは ES モジュールで、エントリポイントは 1 つです。`package.json` の主な項目は次のとおりです。

- `exports["."].default`・`main`: `./dist/host/index.js`。ホスト API を 1 ファイルにバンドルしたもので、実行時の依存は
  ありません。
- `exports["."].types`・`types`: `./dist/types/host/index.d.ts`。TypeScript の型定義です（`dist/types/shared/policy.d.ts`
  を import しています）。
- `openvessel.node`: `22.23.4`。移植版の Node.js ランタイムが追従している Node.js のバージョンです。

```ts
import { OpenVessel, PRESETS, type BootOptions, type Process } from 'openvessel';
```

## `dist/` の中身

公開しているのは `dist/` だけです。ディレクトリごとに配置先が異なります。

| ディレクトリ | 中身 | 配置先 |
|---|---|---|
| `dist/host/` | `index.js`（ホスト API） | 自分のページのバンドル（`import 'openvessel'` で取り込む）。 |
| `dist/types/` | `.d.ts` | TypeScript だけが使います。 |
| `dist/runtime/` | `runtime.html`・`runtime.js`・`sw.js`・`kernel.js`・`process.js`（旧ランタイム）・`node-process.js` と `nodelib.js`（移植版ランタイム）・`ts-strip.js`・`amaro.js`・`chunks/`・`compat/`（互換パッケージの tarball と `index.json`）・ライセンスのファイル | ランタイムのオリジンに、ディレクトリごと配置します。パスの下に置いてもかまいません（例: `https://example.com/ov/runtime/`）。 |
| `dist/preview/` | `__ov-sw.js`・`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js` | プレビューのオリジンに、ディレクトリごと配置します。こちらもパスの下に置けます。 |
| `dist/playground/` | リポジトリのテスト用ページ | 埋め込みには不要です。 |

ランタイムとプレビューのディレクトリは、中身を変えずにそのままコピーしてください。ファイル同士は相対 URL で
互いを参照しています。

## 3 つのオリジンで配信する

ヘッダーの設定は、リポジトリの `scripts/serve.mjs` を参考にしてください。このスクリプトは `dist/playground`・
`dist/runtime`・`dist/preview` をポート 5170・5171・5172 で配信します（`OV_PORT_BASE` で 3 つまとめてずらせます。
`OV_HOST_PORT`・`OV_RUNTIME_PORT`・`OV_PREVIEW_PORT` で個別に指定することもできます）。付けているヘッダーは次のとおりです。

- ホストページ: `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Embedder-Policy: require-corp`・
  `Cross-Origin-Resource-Policy: same-origin`
- ランタイム: `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Embedder-Policy: require-corp`・
  `Cross-Origin-Resource-Policy: cross-origin`。さらに `sw.js` 以外のすべてのファイルに
  `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors <ホストのオリジン>`
- プレビュー: `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Embedder-Policy: require-corp`（Service Worker の
  `__ov-sw.js` だけ `credentialless`）・`Cross-Origin-Resource-Policy: cross-origin`

ランタイムの `connect-src 'self'` は、プロセス内のコードがネットワークポリシーの確認を経ずに外部と通信するのを
防ぐためのものです。`sw.js` にこのヘッダーを付けてはいけません。その確認を行っているのが Service Worker 自身だからです。
ヘッダーを設定できない静的ホスティング、埋め込めるオリジンの制限など、配信に関することは [配信](deployment.ja.md) に
まとめています。

`dist/runtime/runtime.html` には `<meta name="openvessel-allowed-hosts" content="*">` が入っています。`*` を、ランタイムの
埋め込みを許可するオリジンに書き換えてください（空白またはカンマ区切り）。それ以外のオリジンから `boot()` を呼ぶと、
`origin … is not allowed to use this runtime` で失敗します。

埋め込む前に OpenVessel 単体で試したい場合は、リポジトリを clone して `npm install`・`npm run build`・`npm run serve` を
実行し、http://localhost:5170 を開いてください。

## 最小構成のホストページ

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

このページは、上で説明したホストページ用のヘッダーを付けて配信します。`boot()` は非表示の iframe を `document.body` に
追加するため、body が作られてから呼んでください（body の末尾に置いたモジュールスクリプトから呼ぶか、
`DOMContentLoaded` の後に呼びます）。

## 起動する

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://rt.example.com/',   // runtime.html のあるディレクトリ（か runtime.html そのもの）
  previewUrl: 'https://pv.example.com/',   // __ov-sw.js のあるディレクトリ
  network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'] },
});
```

`boot()` は非表示の iframe に `runtime.html` を読み込みます。このページがランタイムの Service Worker を登録し、
カーネルの Worker を起動します。カーネルの準備ができると解決し、`timeout`（既定は 30 000 ms）を過ぎると失敗します。
オプションとエラーの一覧は [ホスト API](host-api.ja.md#openvesselboot) を参照してください。ネットワークポリシーについては
[ネットワークポリシー](network-policy.ja.md) で説明しています。`mode: 'ask'` で `onPermissionRequest` を渡さない場合、
プリセットに含まれないホストへの接続は、組み込みのダイアログでユーザーに確認します。

`boot()` が解決した後に、API 呼び出しとは関係なく発生したエラーは `error` イベントで通知されます（1.2.0 で追加）。
`fatal: true` は、カーネルが失われてインスタンスが停止したことを示します。

```ts
vessel.on('error', ({ message, fatal }) => console.error(message, fatal ? '(stopped)' : ''));
```

1 つのブラウザプロファイルで同時に使えるインスタンスは、ランタイムのオリジンごとに 1 つまでです。ランタイムの
Service Worker は最新のカーネルとの接続しか保持しないため、同じランタイムのオリジンで 2 つ目のタブを開いたり
`boot()` をもう一度呼んだりすると、モジュールの読み込みと通信の判定は新しい側に引き継がれます。

## Node.js ランタイムを選ぶ

ビルドには 2 つの Node.js ランタイムが含まれています。カーネルは `node` プロセスを起動するたびに、どちらを使うかを決めます。

- 移植版ランタイム: `dist/runtime/node-process.js`（`src/nodejs/`）。Node.js v22.23.4 の `lib/` をそのまま、TypeScript で
  書いた `internalBinding()` の上で動かします。既定はこちらです。
- 旧ランタイム: `dist/runtime/process.js`（`src/node/worker.ts`）。以前から使っていた、手書きの Node 互換レイヤーです。
  VFS のファイル `/etc/openvessel/node` の中身が `legacy` のときに使われます（前後の空白は無視します）。

[互換性](../compatibility.ja.md) の数値はすべて移植版ランタイムで計測したものなので、通常は何も設定する必要はありません。
旧ランタイムでプロセスを動かしたい場合は、起動後にこのファイルを書き込みます。

```ts
await vessel.mount({ node: 'legacy' }, { path: '/etc/openvessel' });
// これと同じ: await vessel.fs.writeFile('/etc/openvessel/node', 'legacy');
```

このファイルはプロセスの起動のたびに読まれます。すでに動いているプロセスは、起動したときのランタイムのまま動き続けます。
詳しくは [Node.js ランタイム](nodejs-runtime.ja.md) を参照してください。

## プロジェクトをファイルシステムに入れる

ファイルシステムはメモリ上にあり、起動直後は基本のシステム（`/bin`・`/usr`・`/home/user`・`/tmp`・`/etc`・`/dev`・
`/proc` など）しかありません。起動をまたいでデータが残ることはありません。

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

キーは `path`（既定は `/home/user/app`）からの相対パスです。値には文字列（`string`）、バイト列（`Uint8Array`）、
空のディレクトリを表す `null`、シンボリックリンクを表す `{ symlink: 先 }` を指定できます。存在しないディレクトリは
自動で作成されます。ユーザーが選んだフォルダを読み込む場合は、各 `File` を `Uint8Array` に読み込んで渡します
（playground では、このとき `node_modules/` と `.git/` をスキップしています）。

## 依存パッケージをインストールする

```ts
const install = await vessel.spawn('npm', ['install'], { cwd: APP });
install.output.pipeTo(new WritableStream({ write: (s) => log(s) }));
if ((await install.exit) !== 0) throw new Error('npm install failed');
```

`npm`・`pnpm`・`yarn`・`bun` はカーネルに組み込まれています（[パッケージマネージャ](package-managers.ja.md)）。
レジストリへのリクエストと tarball の取得はネットワークポリシーで確認されるため、ポリシーでレジストリを許可しておく
必要があります。プリセットの `npm` には `registry.npmjs.org` と主なミラーが含まれています。ネイティブバイナリを含む
パッケージは、WebAssembly 版がインストールされます（[ネイティブモジュール](native-modules.ja.md)）。

[デモ](https://kobesoft-labs.github.io/openvessel-demo/) では、プロセスに
`env: { ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '1', NODE_NO_WARNINGS: '1' }` を渡しています。

## ビルドする

```ts
const { code, output } = await vessel.exec('npm run build', { cwd: APP });
if (code !== 0) console.error(output);

// 結果を読み出す: { 'index.html': Uint8Array, '_astro/…': Uint8Array, … }
const files = await vessel.export(`${APP}/dist`);
```

`exec()` はコマンドラインを `/bin/sh -c` で実行し、終了コードと、標準出力・標準エラーをまとめた出力で解決します。
解決するのは、プロセスが終了し、かつ出力のパイプが閉じたときです。そのため、出力を握ったままのバックグラウンドジョブを
残すコマンド（`npm run dev &`）では待ち続けることになります。常駐するサーバーは `spawn()` で起動してください。

## 開発サーバーを起動してプレビューを表示する

```ts
vessel.on('server-ready', async ({ port }) => {
  const frame = await vessel.createPreview(port, { container: document.getElementById('preview')! });
  // frame はプレビューのオリジンの sandbox 付き <iframe>。http://localhost:<port>/ を表示する
});
const dev = await vessel.spawn('npm', ['run', 'dev'], { cwd: APP });
```

リスナーはサーバーを起動する前に登録してください。`server-ready` はプロセスが仮想ポートで待ち受けを始めたときに
発生し（Astro の開発サーバーは 4321）、停止すると `port-closed` が発生します。`createPreview()` は、初回の呼び出しで
プレビューの中継を起動し、iframe を作って `container` に追加します。iframe を自分で配置する場合は
`await vessel.previewUrl(port, '/about/')` か、イベントの `url` を使ってください。`previewUrl` を設定していれば
`server-ready` は中継の起動後に発生するので、`url` はすぐに読み込めます。HMR はプレビューの Service Worker を経由して
動作します（[プレビュー](preview.ja.md)）。

## xterm.js で対話型ターミナル

`terminal` を指定して起動したプロセスには TTY が割り当てられます。標準入力・標準出力・標準エラーが端末になり、
ラインディシプリンが入力のエコーと行編集を行い、Ctrl-C でフォアグラウンドのプロセスグループに `SIGINT` が送られ、出力の `\n` は
`\r\n` に変換されます。playground（`playground/app.ts`）とデモでは、[xterm.js](https://xtermjs.org)（`@xterm/xterm` と
`@xterm/addon-fit`）を次のようにつないでいます。

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

ユーザーの代わりにコマンドを入力するには、末尾に CR を付けて書き込みます（`shell.write('npm run dev\r')`）。
端末のプロセスに対する `shell.end()` は、ラインディシプリンに Ctrl-D（`^D`）を送ります。行頭であれば、プログラムは EOF を
受け取ります（対話モードの `sh` は終了します）。パイプのプロセスでは標準入力を閉じます。

## 動かしながらファイルを書き換える

```ts
await vessel.fs.writeFile(`${APP}/src/pages/index.astro`, '<h1>Edited</h1>\n');

const stop = await vessel.fs.watch(APP, (ev) => {
  // ev.type は 'rename'（作成・削除・名前の変更）か 'change'。ev.path は変わったパス
  console.log(ev.type, ev.path);
});
// あとで: await stop();
```

ホストからの書き込みは、カーネル内のすべての監視に通知されます。そのため開発サーバーのファイル監視（Node の
`fs.watch`）が変更を検知し、プレビューが更新されます。ホスト側の `fs.watch` には、プロセスによる変更（ターミナルで
作ったファイルや `npm install`）も通知されます。

## 終了処理

```ts
vessel.teardown();
```

`teardown()` はランタイムと中継の iframe を削除し、カーネルとの通信チャネルを閉じます。カーネルの Worker とすべての
プロセスはランタイムの iframe とともに終了し、メモリ上のファイルシステムも破棄されます。応答待ちの呼び出しは失敗し、
実行中のプロセスの `exit` は `137` で解決します。自分のページに配置したプレビューの iframe は削除しません。
ランタイムとプレビューのオリジンの Service Worker の登録と、npm の tarball のキャッシュ（ランタイムのオリジンの
Cache Storage `openvessel-npm-v1`）はブラウザに残ります。

## うまく動かないとき

| 症状 | 原因 |
|---|---|
| `OpenVessel: the host page must be cross-origin isolated (…)` | ホストページに `Cross-Origin-Opener-Policy: same-origin` か `Cross-Origin-Embedder-Policy` が付いていません。 |
| `OpenVessel: OpenVessel needs a cross-origin isolated page (…)` | ランタイムのページが cross-origin isolated になっていません。ランタイム自身の COOP/COEP ヘッダーがない（ランタイムの Service Worker がこれを付けるのはインストール後だけです）か、ホストページの COEP でブロックされています（ランタイムは `Cross-Origin-Resource-Policy: cross-origin` を返す必要があります）。 |
| `OpenVessel: runtime did not start in time` | `runtime.html` が読み込めなかったか、`timeout` までに応答しませんでした。`runtimeUrl`（`runtime.html` のあるディレクトリか `runtime.html` そのもの）と `frame-ancestors` を確認してください。 |
| `OpenVessel: origin … is not allowed to use this runtime` | ホストのオリジンが `runtime.html` の `openvessel-allowed-hosts` に含まれていません。 |
| `OpenVessel: the runtime must be embedded directly by the host page` | `boot()` を呼んだページ自体がフレームの中にあります。 |
| `OpenVessel: previewUrl was not configured` | `boot()` に `previewUrl` を渡さずに `createPreview()`・`previewUrl()` を呼びました。 |
| `OpenVessel: preview relay did not start` | プレビューのオリジンの `__ov/relay.html` が、20 秒以内に読み込みと Service Worker の登録を完了しませんでした。 |
| プロセスが `fetch failed` と `EACCES` を出力する | ネットワークポリシーがそのホストへの接続を拒否しました。 |
| プロセスが `fetch failed` と `ECONNREFUSED`、CORS についての説明を出力する | ポリシーでは許可されましたが、接続先のサーバーがブラウザからのクロスオリジンリクエストを許可していません（[ネットワークポリシー](network-policy.ja.md#cors)）。 |
| `node` が `Error: module … is not registered` を出力する | 同じランタイムのオリジンで、別のタブまたは別の `boot()` がランタイムの Service Worker を引き継ぎました。 |

## 次に読むもの

- [ホスト API](host-api.ja.md): すべてのメソッド、オプション、イベント、エラー
- [ネットワークポリシー](network-policy.ja.md): タブの外への通信で何を許可するか、ユーザーにどう確認するか
- [配信](deployment.ja.md): 本番環境のオリジン、ヘッダー、静的ホスティング
- [プレビュー](preview.ja.md): iframe から開発サーバーにリクエストが届く仕組み
