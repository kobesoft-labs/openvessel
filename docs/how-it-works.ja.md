# OpenVessel のしくみ

[English](how-it-works.md)

OpenVessel は、**ブラウザのタブの中に住む、Node.js のための小さな仮想マシン**だと考えると分かりやすいです。
仮想マシンと同じように、自分の OS（ファイルシステム・プロセス・シェルを持つカーネル）と、自分のプログラム
（Node.js・npm・Astro）と、決まった出入り口（外への通信の関所と、プレビューのための仮想ポート）を持っています。
ただし仮想マシンと違って CPU は再現しません。JavaScript と WebAssembly は、ブラウザのエンジンでそのまま動きます。

![OpenVessel: ブラウザのタブの中の Node.js の仮想マシン](images/overview.svg)

## 部品

### カーネル — 「OS」

Web Worker 1 つが OS の役をします。持っているものは次のとおりです。

- **メモリ上のファイルシステム**（ディレクトリ・ファイル・シンボリックリンク・権限のビット・時刻・監視）
- **プロセス**（pid・ファイル記述子・作業ディレクトリ・環境変数・終了コード・シグナル）
- **パイプ・端末・ソケット**（端末のための行の規律を持つ TTY、プロセスどうしの TCP と Unix ソケットのための socketpair）
- **シェルと coreutils**（`sh`・`ls`・`cat`・`grep`・`ps` など）と**パッケージマネージャ**（`npm`・`pnpm`・`yarn`・`bun`。4 つの lockfile の形式を 1 つのクライアントで扱う）
- **仮想ポート**: プロセスがポート 4321 で待ち受けても、手元のマシンには何も開きません。カーネルが待ち受けを記録し、プレビューをそこにつなぎます
- **通信の関所**: インターネットへ出る唯一の道です。何を許すかは、埋め込む側のページが決めます（npm のレジストリなどの組み合わせ、ホストごとの確認、全部許可）

### プロセス — Node.js そのもの

`node` のプロセスは、それぞれが 1 つの Web Worker です。**Node.js v22 自身の JavaScript**（`lib/`）を、書き換えずに動かします。
Node の `lib/` は、ふだんは C++ の上に乗っています。50 ほどの `internalBinding()` のモジュール（ファイル・ストリーム・TCP・
タイマー・crypto・zlib・モジュール・worker など）と、libuv のイベントループと、OS です。OpenVessel が作り直しているのは、
ちょうどその部分で、TypeScript で書いています。

![本物の Node.js と OpenVessel の Node.js の層](images/layers.svg)

- **システムコールは同期です**（本物の OS と同じ）。プロセスは要求を `SharedArrayBuffer` に書き、カーネルが答えるまで
  `Atomics.wait` で眠ります。ブラウザで `fs.readFileSync`・`child_process.spawnSync`・同期の `require()` が動くのはこのためです。
- **イベントループ**（タイマー・immediate・`process.nextTick`・プロセスを生かしておくハンドル・`beforeExit`/`exit`）は、
  `src/nodejs/loop.ts` で Node と同じ順番に再現しています。
- **ES モジュールはブラウザの本物のモジュールです。** ソースをランタイムの Service Worker に渡し、そこから配信するので、
  `import`・`import.meta`・最上位の `await` はブラウザそのものです。
- **ネイティブのアドオンは WebAssembly に。** WebAssembly 版のあるパッケージ（esbuild・rollup・rolldown・lightningcss・sharp・
  napi-rs の `wasm32-wasi` 版）は npm がそれを入れ、`node:wasi` で動かします。無いものには、OpenVessel が互換パッケージを
  作ります。多くはそのプロジェクトを自分で `wasm32-wasi` にコンパイルしたものです（Pagefind はこの作り方）。

JavaScript の側が Node 自身のものなので、振る舞いも Node のとおりになります。エラーの文言とコード、引数の検査、
`node:fs:441:20` のようなスタックトレース、ストリームの背圧、イベントの順番です。バインディングは 1 つずつ、本物の Node で
同じ呼び出しをした結果と突き合わせて試験しています。Node 自身の試験も OpenVessel で流しています（[互換性](compatibility.ja.md)）。

### プレビュー

OpenVessel の中の開発サーバーは、仮想ポートで待ち受けます。それを見せるために、3 つ目のオリジンに iframe を開きます。
その Service Worker が、すべての要求（と HMR の WebSocket）をカーネルに送り、カーネルがそれをソケットの上のバイト列として
サーバーのプロセスに渡します。TCP から届いたのとまったく同じ形です。

```
プレビューの iframe ──fetch──▶ プレビューの Service Worker ──▶ カーネル: 仮想ポート 4321 ──▶ node（astro dev）
                                                         socketpair、HTTP/1.1 のバイト列 ◀──
```

### 外への道

外のホストに `fetch`・`http.get`・`net.connect` するプロセスは、実はカーネルと話しています。カーネルは通信の方針を確かめ、
ブラウザの `fetch` で要求を出します。生のソケットのときは、ソケットから HTTP/1.1 の要求を読み、応答をバイト列で書き戻します。
そのため、自前の HTTP クライアントを持つライブラリ（undici・axios・got）もそのまま動きます。TLS はブラウザが行い、
証明書の確認もブラウザがします。

## 3 つのオリジン

| オリジン | 持つもの | 分ける理由 |
|---|---|---|
| ホストのページ | あなたの画面と OpenVessel の API | 仮想マシンの中のコードが、あなたのページに触れないように |
| ランタイム | カーネル・プロセス・通信の関所 | 外に出られるのはここだけ。しかも関所を通るときだけ |
| プレビュー | 開発中のサイト | サイト自身の JavaScript が、ランタイムやあなたのページに届かないように |

3 つは `postMessage` のチャネルで話します。ランタイムとプレビューは、`SharedArrayBuffer` のためにクロスオリジン分離
（`Cross-Origin-Opener-Policy`・`Cross-Origin-Embedder-Policy`）が要ります。ヘッダーを付けられない配信先（GitHub Pages）では、
Service Worker がそれを付けます。[SECURITY.md](SECURITY.md) も見てください。

## `npm install && npm run dev` で起きること

1. ホストのページが `vessel.exec(...)` を呼びます。カーネルが `sh` を起動し、`sh` がコマンドを読み解きます。
2. `npm install` はカーネルの中で動きます。npm と同じように依存の木を解き（持ち上げ・peer 依存・lockfile）、通信の関所を
   通して tarball を取り、整合性を確かめ、メモリ上のファイルシステムに展開します。ネイティブのパッケージは、WebAssembly 版
   か互換パッケージに差し替えます。
3. `npm run dev` は `node node_modules/.bin/astro dev` を起動します。新しい Web Worker で Node.js が立ち上がり（温めておいた
   worker なら約 50 ミリ秒）、Astro と Vite を ES モジュールとして読み込み、Vite が esbuild と rolldown を WebAssembly で動かします。
4. Astro がポート 4321 で待ち受けます。カーネルがホストのページに知らせ（`server-ready`）、ページがプレビューの iframe を作ります。
5. ファイルを編集します。ホストが `vessel.fs.writeFile` で書き、カーネルが監視しているものに知らせます。Vite のファイルの監視
   （Node の `fs.watch`）が反応し、Astro がモジュールを作り直し、WebSocket で HMR の知らせを送り、プレビューが変わります。

## ソースのどこに何があるか

| ディレクトリ | 中身 |
|---|---|
| `src/kernel/` | カーネル: `vfs.ts`・`proc.ts`・`io.ts`・`syscalls.ts`・`net.ts`・`tcp.ts`・`outbound.ts`・`sh/`・`coreutils.ts`・`npm/` |
| `src/nodejs/` | worker の中の Node.js: `boot.ts`・`loop.ts`・`options.ts`・`bindings/`（`internalBinding` ごとに 1 ファイル） |
| `src/runtime/` | ランタイムの iframe とその Service Worker |
| `src/preview/` | プレビューの relay とその Service Worker |
| `src/host/` | 埋め込む側のページのための API |
| `compat/` | ネイティブだけの npm パッケージの互換パッケージ |
| `test/node-compat/` | Node 自身の試験を OpenVessel で流す |
| `corpus/` | 端から端まで試すための、実際の Astro のサイト |
