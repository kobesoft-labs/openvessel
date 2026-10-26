# OpenVessel の仕組み

[English](how-it-works.md)

OpenVessel は、ブラウザのタブの中で動く Node.js 用の小さな仮想マシンと考えると分かりやすいです。
仮想マシンと同じように、独自の OS（ファイルシステム・プロセス・シェルを持つカーネル）、独自のプログラム
（Node.js・npm・Astro）、そして制御された出入り口（ネットワークポリシーで制御する外部通信と、プレビュー用の仮想ポート）を持っています。
ただし、仮想マシンと違って CPU はエミュレートしません。JavaScript と WebAssembly はブラウザのエンジン上で直接実行されます。

![OpenVessel: ブラウザのタブの中の Node.js の仮想マシン](images/overview.svg)

## 部品

### カーネル（OS の役割）

1 つの Web Worker が OS の役割を担います。カーネルが持っているものは次のとおりです。

- メモリ上のファイルシステム（ディレクトリ・ファイル・シンボリックリンク・パーミッションのビット・タイムスタンプ・ファイル監視）
- プロセス（pid・ファイル記述子・作業ディレクトリ・環境変数・終了コード・シグナル）
- パイプ・端末・ソケット（端末用のライン規律を持つ TTY と、プロセス間の TCP ソケットと Unix ソケットのための socketpair）
- シェルと coreutils（`sh`・`ls`・`cat`・`grep`・`ps` など）とパッケージマネージャ（`npm`・`pnpm`・`yarn`・`bun`。4 種類の lockfile の形式を 1 つのクライアントで扱います）
- 仮想ポート: プロセスがポート 4321 で待ち受けても、手元のマシンではポートは開きません。カーネルが待ち受けを記録し、プレビューをそこに接続します
- 外部通信の制御: インターネットへの通信はすべてネットワークポリシーで確認されます。何を許可するかは埋め込む側のページが決めます（npm レジストリなどのプリセット、ホストごとの確認、すべて許可）

### プロセス（Node.js そのもの）

`node` のプロセスは、それぞれが独立した Web Worker です。Node.js v22 自身の JavaScript（`lib/`）を変更せずに実行します。
Node の `lib/` は、通常は C++ の上で動いています。その下にあるのは、50 ほどの `internalBinding()` モジュール（ファイル・ストリーム・TCP・
タイマー・crypto・zlib・モジュール・worker など）、libuv のイベントループ、そして OS です。OpenVessel は、ちょうどこの部分を
TypeScript で実装し直しています。

![本物の Node.js と OpenVessel の Node.js の層](images/layers.svg)

- システムコールは、実際の OS と同じく同期的に処理されます。プロセスはリクエストを `SharedArrayBuffer` に書き込み、カーネルが応答するまで
  `Atomics.wait` で待機します。ブラウザで `fs.readFileSync`・`child_process.spawnSync`・同期の `require()` が動くのはこのためです。
- イベントループ（タイマー・immediate・`process.nextTick`・プロセスを終了させないハンドル・`beforeExit`/`exit`）は、
  `src/nodejs/loop.ts` で Node と同じ順序になるようにエミュレートしています。
- ES モジュールは、ブラウザ本来のモジュールとして読み込みます。ソースをランタイムの Service Worker に渡し、そこからプロセスに配信するので、
  `import`・`import.meta`・トップレベルの `await` はブラウザの機能がそのまま使われます。
- ネイティブアドオンは WebAssembly に置き換えます。WebAssembly 版があるパッケージ（esbuild・rollup・rolldown・lightningcss・sharp・
  napi-rs の `wasm32-wasi` 版）は npm がその版をインストールし、`node:wasi` で実行します。WebAssembly 版が無いパッケージには、OpenVessel が互換パッケージを
  用意します。多くは、そのプロジェクトを自前で `wasm32-wasi` 向けにコンパイルしたものです（Pagefind はこの方法で作っています）。

JavaScript の部分は Node 自身のコードなので、動作も Node と同じになります。エラーメッセージとエラーコード、引数のチェック、
`node:fs:441:20` のようなスタックトレース、ストリームのバックプレッシャー、イベントの順序などです。バインディングは 1 つずつ、本物の Node で
同じ呼び出しをした結果と比較してテストしています。Node 自身のテストスイートも OpenVessel 上で実行しています（[互換性](compatibility.ja.md)）。

ここで説明しているのは移植版ランタイム（`src/nodejs/`）で、`node` のプロセスはデフォルトでこれを使います。ビルドには、以前の
手書きの旧ランタイム（`src/node/`）も残っています。`/etc/openvessel/node` に `legacy` と書き込むと、それ以降に起動する
プロセスは旧ランタイムで動きます（[Node.js ランタイム](reference/nodejs-runtime.ja.md#2-つのランタイム)）。

### プレビュー

OpenVessel の中の開発サーバーは、仮想ポートで待ち受けます。これを表示するために、OpenVessel は 3 つ目のオリジンに iframe を開きます。
そのオリジンの Service Worker が、すべてのリクエスト（と HMR の WebSocket）をカーネルに転送し、カーネルはそれをソケット上のバイト列として
サーバーのプロセスに渡します。サーバーから見ると、TCP で届いたリクエストとまったく同じです。

```
プレビューの iframe ──fetch──▶ プレビューの Service Worker ──▶ カーネル: 仮想ポート 4321 ──▶ node（astro dev）
                                                         socketpair、HTTP/1.1 のバイト列 ◀──
```

### 外部への通信

外部のホストに `fetch`・`http.get`・`net.connect` で接続するプロセスは、実際にはカーネルと通信しています。カーネルはネットワークポリシーを確認し、
ブラウザの `fetch` でリクエストを送ります。生のソケットの場合は、ソケットから HTTP/1.1 のリクエストを読み取り、レスポンスをバイト列として書き戻します。
そのため、独自の HTTP クライアントを持つライブラリ（undici・axios・got）も変更なしで動きます。TLS の処理と証明書の検証は
ブラウザが行います。

## 3 つのオリジン

| オリジン | 持つもの | 分ける理由 |
|---|---|---|
| ホストのページ | アプリの画面と OpenVessel の API | 仮想マシンの中のコードが、ホストのページに触れられないようにするため |
| ランタイム | カーネル・プロセス・外部通信の制御 | 外部と通信できるのはここだけで、それもネットワークポリシーで許可された通信に限られる |
| プレビュー | 開発中のサイト | サイト自身の JavaScript が、ランタイムやホストのページに届かないようにするため |

3 つのオリジンは `postMessage` のチャネルで通信します。ランタイムとプレビューでは、`SharedArrayBuffer` を使うためにクロスオリジン分離
（`Cross-Origin-Opener-Policy`・`Cross-Origin-Embedder-Policy`）が必要です。ヘッダーを設定できない配信先（GitHub Pages）では、
Service Worker がこれらのヘッダーを付けます。詳しくは [SECURITY.md](SECURITY.md) を参照してください。

## `npm install && npm run dev` で起きること

1. ホストのページが `vessel.exec(...)` を呼びます。カーネルが `sh` を起動し、`sh` がコマンドラインを解析します。
2. `npm install` はカーネルの中で実行されます。npm と同じように依存関係のツリーを解決し（巻き上げ・peer 依存・lockfile）、ネットワークポリシーで
   許可された範囲で tarball を取得し、整合性を検証してから、メモリ上のファイルシステムに展開します。ネイティブのパッケージは、WebAssembly 版
   か互換パッケージに差し替えます。
3. `npm run dev` は `node node_modules/.bin/astro dev` を起動します。新しい Web Worker で Node.js が起動し（ウォームプールの
   worker なら起動処理は約 50 ミリ秒）、Astro と Vite を ES モジュールとして読み込み、Vite が esbuild と rolldown を WebAssembly で起動します。
4. Astro がポート 4321 で待ち受けます。カーネルがホストのページに通知し（`server-ready`）、ページがプレビューの iframe を作成します。
5. ファイルを編集すると、ホストが `vessel.fs.writeFile` で書き込み、カーネルがファイル監視に通知します。Vite のファイル監視
   （Node の `fs.watch`）が反応し、Astro がモジュールを再ビルドして WebSocket で HMR のメッセージを送り、プレビューが更新されます。

## ソースのどこに何があるか

| ディレクトリ | 内容 |
|---|---|
| `src/kernel/` | カーネル: `vfs.ts`・`proc.ts`・`io.ts`・`syscalls.ts`・`net.ts`・`tcp.ts`・`outbound.ts`・`sh/`・`coreutils.ts`・`npm/` |
| `src/nodejs/` | worker の中の Node.js: `boot.ts`・`loop.ts`・`options.ts`・`bindings/`（`internalBinding` ごとに 1 ファイル） |
| `src/runtime/` | ランタイムの iframe とその Service Worker |
| `src/preview/` | プレビューの relay とその Service Worker |
| `src/host/` | 埋め込む側のページ向けの API |
| `compat/` | ネイティブ専用の npm パッケージ向けの互換パッケージ |
| `test/node-compat/` | Node 自身のテストスイートを OpenVessel で実行する |
| `corpus/` | E2E テストに使う実際の Astro のサイト |
