# OpenVessel

[English](README.md) · [デモ](https://kobesoft-labs.github.io/openvessel-demo/)（タブの中で動く Node.js で、Astro のサイトをその場で編集できます）
· [リファレンス](docs/reference/README.ja.md) · [製品ページ](https://kobesoft.co.jp/oss/openvessel/)（神戸ソフト）

## OpenVessel とは

OpenVessel は、ブラウザのタブの中だけで動く Node.js の実行環境です。
Web ページの中に、本物の `node`、POSIX 互換のシェル、`npm`/`pnpm`/`yarn`/`bun`、ファイルシステムとプロセスを用意します。
npm レジストリから実際の JavaScript プロジェクトをインストールし、ビルドして、ライブリロード付きで表示するところまでを、
サーバー側の処理なしで、実際のネットワークポートを 1 つも開かずに行えます。

[Astro](https://astro.build) のサイト（Astro 7・6・5）向けに開発しました。`npm install`、`astro build`、
HMR 付きの `astro dev`、起動中の開発サーバーの iframe でのプレビューに対応しています。
Node.js 自身のコードを実行しているので、Astro 以外の Node のツールの多くもそのまま動きます。

![OpenVessel: ブラウザのタブの中の Node.js の仮想マシン](docs/images/overview.svg)

タブの中で動く、Node.js 用の小さな仮想マシンと考えてください。独自の OS（ファイルシステム・プロセス・シェルを持つ
カーネル）と、独自のプログラム（Node.js・npm・Astro）、そして制御された出入り口を持っています。各部分の説明は
[仕組み](docs/how-it-works.ja.md) にあります。

主な用途:

- 訪問者のブラウザの中でサイトをビルドしてプレビューする、オンラインエディタや CMS
- 読者 1 人ずつに隔離された Node.js 環境を用意する、チュートリアルや playground
- サーバーを用意せずに行う、プルリクエストやテンプレートのプレビュー

OpenVessel はクリーンルーム方式で開発しています（ほかのブラウザ内ランタイムのソースコードは参照していません）。
[Apache License 2.0](LICENSE) のオープンソースソフトウェアです。

## ほかと違うところ

- Node.js を模倣したものではなく、Node.js そのものを動かします。Node.js v22 の `lib/`（Node の JavaScript で書かれた部分）を
  変更せずに実行し、Node が C++ で実装している部分（`internalBinding()`）を、小さなカーネルの上に TypeScript で
  実装し直しています。そのため、エラーメッセージ・スタックトレース・引数のチェック・イベントループの順序が Node と同じになります。
  Node の新しいバージョンへの追従は、そのソースを読み直す作業になります（[docs/NODE-VERSION.md](docs/NODE-VERSION.md)）。
- ネイティブモジュールは WebAssembly に置き換えます。ネイティブバイナリを配布しているパッケージは、その WebAssembly 版を
  インストールします（esbuild・rollup・rolldown・lightningcss・sharp・napi-rs の `wasm32-wasi` 版など）。WebAssembly 版が
  無いパッケージには互換パッケージを用意しています。多くは同じプロジェクトを `wasm32-wasi` 向けにコンパイルしたものです
  （Pagefind など）。
- 外部からは一切アクセスできません。サーバーはカーネル内の仮想ポートで待ち受け、プレビューの iframe は
  Service Worker を経由して接続します。外部への通信は、埋め込む側のページが設定するネットワークポリシーで制御します。
- オリジンで隔離しています。ページ・ランタイム・プレビューはそれぞれ別のオリジンなので、プレビュー中のサイトの
  コードからランタイムやページにはアクセスできません（[docs/SECURITY.md](docs/SECURITY.md)）。

## いまの状態

- バージョン: 1.1.1。[変更履歴](CHANGELOG.md)・[リリース手順](docs/RELEASING.md) を参照してください。バージョン番号は
  OpenVessel 独自の semver で、移植している Node.js のバージョンは各リリースのタイトルに記載します。
- Node.js: v22.23.4（`src/node/version.ts`）
- Node 自身のテストスイート: 対象モジュールの 1271 本のうち、ブラウザで通せる 1237 本すべて（100%）が通ります。
  残りの 34 本は理由とともに対象外として [docs/compatibility.ja.md](docs/compatibility.ja.md) に記載しています。
- Astro のサイト: 実際のサイト 147 本のうち 131 本がビルドできます（Astro 5・6・7）。[docs/compatibility.ja.md](docs/compatibility.ja.md) を参照してください。
- ブラウザ: Chromium 系のブラウザ。Firefox（現行版）でも移植版ランタイムが動き、シェル・npm・Astro のビルドと開発サーバー・
  プレビューが使えます。Node のテストは 1237 本中 1200 本が通ります（[注意点](docs/compatibility.ja.md#firefox)）。
  クロスオリジン分離（`SharedArrayBuffer`）が必要です。

ブラウザでは動作しないものとその理由は、[docs/compatibility.ja.md](docs/compatibility.ja.md) にまとめています。

## 始め方

```bash
npm install
npm run build        # → dist/（ランタイム・Node の lib のバンドル・互換パッケージ）
npm run serve        # ホスト :5170（playground）・ランタイム :5171・プレビュー :5172
```

http://localhost:5170 を開き、ターミナルの作業ディレクトリに Astro のプロジェクトを配置して
`npm install && npm run dev` を実行します。

Node の lib のバンドルをビルドするには `vendor/node/` が必要です（`node scripts/gen-node-data.mjs` で 1 度だけ作成します。
公式の Linux 版 Node.js を読み込むために Docker を使います）。Pagefind の互換パッケージを再ビルドするには、
Rust と `wasm32-wasip1` ターゲットが必要です（ビルド結果は `vendor/compat/` にキャッシュされます）。

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
`Cross-Origin-Embedder-Policy: require-corp`（または `credentialless`）のヘッダーを付けて配信してください。
3 つのオリジンそれぞれに必要なヘッダーは `scripts/serve.mjs` で確認できます。

## 仕組み

```
 host page (your origin)          runtime origin (hidden iframe)                 preview origin
 ───────────────────────          ──────────────────────────────────            ──────────────
 OpenVessel API  ──postMessage──▶ kernel (Web Worker)                            iframe + service worker
                                   VFS · processes · pipes · TTY · sh · npm      ▲  HTTP / WebSocket
                                   virtual ports · network policy                │
                                     │ sync syscalls (SharedArrayBuffer+Atomics) │
                                   node processes (one Web Worker each) ─────────┘
                                   Node.js lib/ + TypeScript internalBinding()
```

| 部分 | 場所 |
|---|---|
| カーネル: メモリ上のファイルシステム・プロセス・パイプ・TTY・ソケット・`sh`・coreutils・npm クライアント・仮想ポート・外部への HTTP | `src/kernel/` |
| Node.js: 起動処理・イベントループ・`internalBinding()` の各モジュール | `src/nodejs/` |
| ランタイムのオリジン: Service Worker（ES モジュールの配信・ネットワークポリシーの確認） | `src/runtime/` |
| プレビューのオリジン: HTTP/WebSocket を仮想ポートに中継する Service Worker | `src/preview/` |
| ホスト API | `src/host/` |
| ネイティブ専用パッケージの代わりになる互換パッケージ | `compat/`・`scripts/build-compat.mjs` |

詳しくは [仕組み](docs/how-it-works.ja.md)・[互換性](docs/compatibility.ja.md)・[リファレンス](docs/reference/README.ja.md)（ホスト API・デプロイ・カーネル・シェル・npm・Node.js ランタイムなど）と、設計メモの [docs/DESIGN.md](docs/DESIGN.md)・[docs/NODE-PORT.md](docs/NODE-PORT.md) を参照してください。

## 開発

```bash
npm test                                                   # 単体テスト（バインディングは本物の Node の結果と比較）
node test/e2e/harness.mjs 'echo hi; node -v'               # ヘッドレスの Chrome で 1 行実行
node test/e2e/project.mjs <dir> 'npm install && npm run build'
node test/node-compat/run.mjs --port [モジュール…]           # Node 自身のテストを OpenVessel で実行
node test/node-compat/run.mjs --port --report              # モジュールごとの 通過数 / 目標
node corpus/run.mjs [絞り込み]                              # Astro のサイト集をビルド
```

E2E テストは `playwright-core` でシステムの Chrome を操作します（`OV_BROWSER=firefox` を指定すると Playwright の Firefox を使います。
Firefox は `npx playwright-core install firefox` で 1 度だけインストールしておきます）。`HEADED=1` でブラウザの画面を表示し、
`OV_CONSOLE=1` でブラウザのコンソール出力を表示します。`OV_PORT_BASE=<port>` を使うと複数のテストスイートを並行して実行できます。

## ライセンス

Apache License 2.0（[LICENSE](LICENSE)）。同梱しているサードパーティのソフトウェアとそのライセンスは [NOTICE](NOTICE) に記載しています。
