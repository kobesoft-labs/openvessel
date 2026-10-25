# OpenVessel

[English](README.md) · **[デモ](https://kobesoft-labs.github.io/openvessel-demo/)** — Node.js がタブの中で動き、Astro のサイトをその場で編集できます
· [製品ページ](https://kobesoft.co.jp/technology/openvessel/)（神戸ソフト）

## OpenVessel とは

OpenVessel は、ブラウザのタブの中だけで動く Node.js の環境です。
Web ページの中に、本物の `node`、POSIX 風のシェル、`npm`/`pnpm`/`yarn`/`bun`、ファイルシステムとプロセスを用意します。
npm から実際の JavaScript のプロジェクトを入れ、ビルドし、ライブリロード付きで表示するところまでを、
サーバーに処理させず、実際のネットワークのポートを 1 つも開かずに行えます。

[Astro](https://astro.build) のサイト（Astro 7・6・5）のために作りました。`npm install`、`astro build`、
HMR 付きの `astro dev`、動いている開発サーバーの iframe でのプレビューができます。
Node.js 自身のコードを動かしているので、Astro 以外の Node のツールの多くもそのまま動きます。

![OpenVessel: ブラウザのタブの中の Node.js の仮想マシン](docs/images/overview.svg)

タブの中に住む、Node.js のための小さな仮想マシンだと考えてください。自分の OS（ファイルシステム・プロセス・シェルを持つ
カーネル）と、自分のプログラム（Node.js・npm・Astro）と、決まった出入り口を持っています。部品ごとの説明は
[しくみ](docs/how-it-works.ja.md) にあります。

使いみちの例:

- サイトを訪問者のブラウザの中でビルドして見せる、オンラインのエディタや CMS
- 読者ひとりずつに隔離された Node.js を用意する、チュートリアルや試し書きの場
- サーバーを用意せずに見せる、プルリクエストやテンプレートのプレビュー

OpenVessel はクリーンルームで作っています（ほかのブラウザ内ランタイムのソースは見ていません）。
[Apache License 2.0](LICENSE) のオープンソースです。

## ほかと違うところ

- **Node.js の似せ物ではなく Node.js そのもの。** Node.js v22 の `lib/`（Node の JavaScript の部分）を
  書き換えずに動かします。OpenVessel が作り直しているのは、Node が C++ で書いている部分
  （`internalBinding()`）で、小さなカーネルの上に TypeScript で書いています。エラーの文言・スタックトレース・
  引数の検査・イベントループの順番が Node と同じになり、Node の新しい版への追従はそのソースを読み直す
  作業になります（[docs/NODE-VERSION.md](docs/NODE-VERSION.md)）。
- **ネイティブのモジュールは WebAssembly に。** ネイティブのバイナリを配るパッケージは、その WebAssembly 版を
  入れます（esbuild・rollup・rolldown・lightningcss・sharp・napi-rs の `wasm32-wasi` 版など）。WebAssembly 版が
  無いものには互換パッケージを用意します。多くは同じプロジェクトを `wasm32-wasi` にコンパイルしたものです
  （たとえば Pagefind）。
- **外からは何にも届かない。** サーバーはカーネルの中の仮想のポートで待ち受け、プレビューの iframe は
  Service Worker を通してつながります。外への通信は、埋め込む側のページが決める 1 つの関所を通ります。
- **オリジンで隔離。** ページ・ランタイム・プレビューは別々のオリジンなので、プレビューしているサイトの
  コードからランタイムやページには触れません（[docs/SECURITY.md](docs/SECURITY.md)）。

## いまの状態

| | |
|---|---|
| 版 | 1.1.0 — [変更履歴](CHANGELOG.md)・[リリース手順](docs/RELEASING.md)（OpenVessel 独自の semver。移植している Node.js の版は、各リリースのタイトルに入れます） |
| Node.js | v22.23.4（`src/node/version.ts`） |
| Node 自身の試験 | 対象モジュールの 1271 本のうち、ブラウザで通せる 1237 本すべて（100%）が通る。残り 34 本は理由つきで対象外。[docs/compatibility.ja.md](docs/compatibility.ja.md) |
| Astro のサイト | 実際のサイト 147 本の中で 131 本がビルドできる（Astro 5・6・7）。[docs/compatibility.ja.md](docs/compatibility.ja.md) |
| ブラウザ | Chromium 系。クロスオリジン分離（`SharedArrayBuffer`）が必要 |

ブラウザでは動かせないものと、その理由は [docs/compatibility.ja.md](docs/compatibility.ja.md) にまとめています。

## 始め方

```bash
npm install
npm run build        # → dist/（ランタイム・Node の lib の束・互換パッケージ）
npm run serve        # ホスト :5170（試し書き）・ランタイム :5171・プレビュー :5172
```

http://localhost:5170 を開き、ターミナルの作業ディレクトリに Astro のプロジェクトを置いて
`npm install && npm run dev` を実行します。

Node の lib の束を作るには `vendor/node/` が要ります（`node scripts/gen-node-data.mjs` で 1 度だけ作る。
公式の Linux 版 Node.js を読むために Docker を使う）。Pagefind の互換パッケージを作り直すには、
Rust と `wasm32-wasip1` ターゲットが要ります（結果は `vendor/compat/` に取っておく）。

## 埋め込み

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://runtime.example.com/runtime.html',
  previewUrl: 'https://preview.example.com/',
  network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'] },
  onPermissionRequest: (req) => (confirm(`${req.host} への通信を許可しますか？`) ? 'session' : 'deny'),
});

vessel.mount({ 'package.json': '…', 'src/pages/index.astro': '…' }, { path: '/home/user/app' });
const { code, output } = await vessel.exec('npm install && npm run build', { cwd: '/home/user/app' });

vessel.on('server-ready', async ({ port }) => {
  await vessel.createPreview(port, { container: document.querySelector('#preview')! });
});
await vessel.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });
```

ホストのページは `Cross-Origin-Opener-Policy: same-origin` と
`Cross-Origin-Embedder-Policy: require-corp`（または `credentialless`）付きで配信してください。
3 つのオリジンそれぞれに要るヘッダーは `scripts/serve.mjs` にあります。

## しくみ

| 部分 | 場所 |
|---|---|
| カーネル: メモリ上のファイルシステム・プロセス・パイプ・TTY・ソケット・`sh`・coreutils・npm・仮想ポート・外への HTTP | `src/kernel/` |
| Node.js: 起動・イベントループ・`internalBinding()` の各モジュール | `src/nodejs/` |
| ランタイムのオリジン: Service Worker（ES モジュールの配信・通信の関所） | `src/runtime/` |
| プレビューのオリジン: HTTP/WebSocket を仮想ポートにつなぐ Service Worker | `src/preview/` |
| ホストの API | `src/host/` |
| ネイティブだけのパッケージの互換パッケージ | `compat/`・`scripts/build-compat.mjs` |

もっと詳しく: [しくみ](docs/how-it-works.ja.md)・[互換性](docs/compatibility.ja.md)・設計のメモ [docs/DESIGN.md](docs/DESIGN.md)・[docs/NODE-PORT.md](docs/NODE-PORT.md)。

## 開発

```bash
npm test                                                   # 単体の試験（バインディングは本物の Node と突き合わせ）
node test/e2e/harness.mjs 'echo hi; node -v'               # ヘッドレスの Chrome で 1 行実行
node test/e2e/project.mjs <dir> 'npm install && npm run build'
node test/node-compat/run.mjs --port [モジュール…]           # Node 自身の試験を OpenVessel で
node test/node-compat/run.mjs --port --report              # モジュールごとの 通過 / 目標
node corpus/run.mjs --port [絞り込み]                       # Astro のサイト集をビルド
```

## ライセンス

Apache License 2.0（[LICENSE](LICENSE)）。同梱しているほかのソフトウェアとそのライセンスは [NOTICE](NOTICE) にあります。
