# ビルドと保守

[English](building.md)

OpenVessel をソースからビルドし、新しく保つ方法です。要る道具、npm のスクリプト、ビルドのスクリプトがそれぞれ何を読んで何を書くか、Node.js の新しい版への追従、リリースの出し方を扱います。試験の動かし方は [試験](testing.ja.md) にあります。

## 要るもの

| 道具 | 何に要るか |
|---|---|
| Node.js と npm | すべて。単体の試験の束は `node22` 向けにビルドする。記録と基準のスクリプトは `npx -y node@<固定した版>` を取ってくるので、npm のレジストリへの通信が要る |
| Docker（`linux/amd64` のイメージを動かせること） | `scripts/gen-node-data.mjs`・`scripts/gen-builtins.mjs`・`scripts/node-upgrade-check.mjs`。Node の版ごとに 1 回、`vendor/node/`・`src/node/data/`・`src/shared/builtin-exports.json` を作る |
| `curl` | `gen-node-data.mjs`（Node の `LICENSE` を取る）、zlib の WebAssembly のビルド |
| Rust（`cargo`）と `rustup target add wasm32-wasip1` | `vendor/compat/pagefind/` が無いときの、Pagefind の互換パッケージのビルド |
| wasm32 向けの LLVM の `clang` と `wasm-ld` | brotli／zstd の WebAssembly を作り直すときだけ（`src/nodejs/bindings/zlib/wasm/build.mjs`） |
| Google Chrome | 端から端までの試験・Node の試験・コーパス（`playwright-core` から `channel: 'chrome'` で動かす） |
| `git` | `test/node-compat/fetch.mjs`（nodejs/node の一部だけの clone） |
| ログイン済みの GitHub CLI `gh` | `corpus/collect.mjs`（取ってきたばかりのリポジトリで `corpus/sites/` を取り直すときも）、リリースの `gh release create` |

取ってきたばかりのリポジトリは、次のようにビルドします。

```bash
npm install
node scripts/gen-node-data.mjs   # 1 回だけ（Docker）。vendor/node/ と src/node/data/
npm run build                    # dist/
npm run serve                    # ホスト :5170、ランタイム :5171、プレビュー :5172
```

## npm のスクリプト

| スクリプト | コマンド | すること |
|---|---|---|
| `build` | `node scripts/build.mjs` | `dist/` へ全部ビルドする |
| `dev` | `node scripts/build.mjs --watch & node scripts/serve.mjs` | 変更のたびにビルドし直して配る |
| `serve` | `node scripts/serve.mjs` | `dist/` を 3 つのオリジンで配る |
| `test` | `node scripts/test.mjs` | 単体の試験（[試験](testing.ja.md)） |
| `typecheck` | `tsc --noEmit -p .` | `src/`・`test/`・`playground/` の型を確かめる（`tsconfig.json`） |
| `build:types` | `node scripts/build-types.mjs` | ホストの API の型の宣言を `dist/types/` に出す |

## scripts/build.mjs

esbuild で全部を束ねます。フラグ:

| フラグ | 効き目 |
|---|---|
| （なし） | `dist/` を消し、静的なファイルを写し、esbuild のビルドを全部 1 回ずつ実行し、そのあと `nodelib.js` を作り、amaro を写し、互換パッケージを作る |
| `--watch` | `dist/` を消さ**ない**。静的なファイルを写し、入口ごとに esbuild の watch を始める。この形では `nodelib.js`・`amaro.js`・互換パッケージは作らない（作り直さない）ので、前の全部のビルドで作ってある必要がある |
| `--minify` | すべての束を小さくする |

esbuild の共通の設定: `bundle`・`sourcemap: 'linked'`・`target: 'es2022'`・`platform: 'browser'`・`legalComments: 'none'`・`define: { global: 'globalThis' }`。旧ランタイムとほかの束は、`events`・`process`・`string_decoder`・`abort-controller` を `src/node/` の代わりの物に読み替え、`process/`・`string_decoder/`・`cjs-module-lexer/lexer.js` を小さなプラグインで解決します。移植版ランタイムの束は読み替えを使いません。

| 入口 | ソース | 出力 | 形式 |
|---|---|---|---|
| `kernel` | `src/kernel/index.ts` | `dist/runtime/kernel.js` | ESM。`dist/runtime/chunks/[name]-[hash].js` に分割 |
| `process` | `src/node/worker.ts` | `dist/runtime/process.js`（旧ランタイム） | ESM。`kernel` と分割の塊を共有 |
| `runtime` | `src/runtime/runtime.ts` | `dist/runtime/runtime.js` | IIFE |
| `sw` | `src/runtime/sw.ts` | `dist/runtime/sw.js`（ランタイムの Service Worker） | IIFE |
| `node-process` | `src/nodejs/boot.ts` | `dist/runtime/node-process.js`（移植版ランタイム）。`./nodelib.js` は外の import のまま | ESM |
| `ts-strip` | `src/nodejs/ts-strip.ts` | `dist/runtime/ts-strip.js`（`require(esm)` のための sucrase） | IIFE |
| `relay`・`inject` | `src/preview/relay.ts`・`src/preview/inject.ts` | `dist/preview/__ov/relay.js`・`dist/preview/__ov/inject.js` | IIFE |
| `__ov-sw` | `src/preview/sw.ts` | `dist/preview/__ov-sw.js`（プレビューのディレクトリの最上位に置く。`Service-Worker-Allowed` のヘッダー無しでディレクトリ全体をスコープにできるため） | IIFE |
| `index` | `src/host/index.ts` | `dist/host/index.js`（パッケージの `main`） | ESM |
| `app` | `playground/app.ts` | `dist/playground/app.js`（CSS は `css` のローダーで） | ESM |

写す静的なファイル: `src/runtime/runtime.html` → `dist/runtime/runtime.html`、`src/preview/relay.html` → `dist/preview/__ov/relay.html`、`playground/index.html` と `playground/app.css` → `dist/playground/`、`node_modules/@xterm/xterm/css/xterm.css` → `dist/playground/xterm.css`。

esbuild のビルドのあと（全部のビルドのときだけ）:

| 手順 | 出力 |
|---|---|
| `genNodeLib()`（`vendor/node/natives.json` があるとき） | `dist/runtime/nodelib.js` と `dist/runtime/NODE-LICENSE.txt`（Node の `LICENSE`。同梱の依存の告知も入っている）。`vendor/node` が無いと `vendor/node missing: run node scripts/gen-node-data.mjs to build the ported Node runtime` と出し、移植版ランタイムは起動できない |
| amaro を写す | `node_modules/amaro/dist/index.js` → `dist/runtime/amaro.js`。`dist/runtime/AMARO-LICENSE.txt`（amaro と swc のライセンス） |
| `buildCompat()` | `dist/runtime/compat/*.tgz` と `dist/runtime/compat/index.json` |

最後に `built dist/` と出します。

## Node のデータ

### gen-node-data.mjs

`node scripts/gen-node-data.mjs` は、固定した版（`src/node/version.ts` の `NODE_VERSION`）の本物の Node.js から、OpenVessel が要るものを全部吸い出します。公式のイメージの中で、吸い出すスクリプトを標準入力から実行します。

```bash
docker run --rm -i --platform linux/amd64 --hostname openvessel -e HOME=/home/user \
  node:<version>-bookworm-slim node --expose-internals --no-warnings -
```

OpenVessel は自分を Linux x64 と名乗るので、errno・シグナル・`O_*` の値がカーネルと合うよう、Linux x64 のイメージを使います。スクリプトは決まった 68 個のバインディングの名前について `internalBinding()` を呼び（その版に無い名前は `__missing` と記録）、それぞれの形を記録します。`internalBinding('builtins').natives` とプロセスのデータも記録します。

| 出力 | 中身 | git に入るか |
|---|---|---|
| `vendor/node/natives.json` | 組み込みモジュールのソースの全部（`lib/` と `deps/`）。Node が埋め込んでいるそのまま | いいえ |
| `vendor/node/lib/<id>.js` | 同じソースをファイルにしたもの。読む・grep するため | いいえ |
| `vendor/node/LICENSE` | Node のライセンス。`raw.githubusercontent.com/nodejs/node/v<version>/LICENSE` から `curl` で取る | いいえ |
| `src/node/data/bindings.json` | 各バインディングの定数と API の形（関数、クラスとそのプロトタイプのメソッド、型付き配列、Map、Symbol）と `uv.__errmap` | はい |
| `src/node/data/process.json` | `versions`・`release`・`features`・`config`・`optionValues`・`optionInfo`（オプションと別名）・`embedderOptions`・`envSettings`・`types`・`builtinCategories`・`globals`（起動後のグローバルの名前 → 列挙されるか） | はい |

形の書き方（`src/nodejs/bindings/shape.ts` が読み戻す。[バインディング](bindings.ja.md) を参照）: 関数は `{ __fn, proto?, statics? }`、型付き配列は `{ __typed, length, values? }`（値は 64 個まで）、ほかに `__num`・`__bigint`・`__symbol`・`__map`・`__set`・`__ref`・`__object`・`__array`・`__throws`・`__missing` を使います。深く入れ子になった値は打ち切ります（`__object`・`__array`）。スクリプトを動かしたこと自体で変わったものは戻します（`--expose-internals`・`--no-warnings`・`--require` を元に戻し、標準入力のスクリプトのグローバル `__filename`・`__dirname`・`module`・`exports`・`require`・`shape` を `globals` から除く）。最後に `node v<version>: <n> builtins, <m> bindings` と出します。

### gen-nodelib.mjs

`build.mjs` から呼ばれます（単独でも動き、`node scripts/gen-nodelib.mjs` は `dist/runtime/nodelib.js` を書いて `{ count, bytes, overrides }` を出す）。`vendor/node/natives.json` を読み、`src/nodejs/overrides/<id>.js` があるものはそれに置き換え（[Node.js ランタイム](nodejs-runtime.ja.md#差し替え) を参照）、`internal/deps/v8/tools/*`（V8 のプロファイラーの道具）を除き、1 つの ES モジュールを書きます。

```js
// Generated by scripts/gen-nodelib.mjs from Node.js 22.23.4 — see vendor/node/LICENSE.
export const ids = [/* 組み込みの ID の全部。並べ替えたもの */];
export const params = { 'fs': 'exports, require, module, process, internalBinding, primordials', /* … */ };
export const sources = { 'fs': '…ソースの文字列…', /* … */ };
```

ソースは文字列のまま持ち、使うときに 1 つずつコンパイルします。[Node.js ランタイム](nodejs-runtime.ja.md#nodelibjs-と使う時のコンパイル) を参照してください（`ids` には除いた `internal/deps/v8/tools/*` も残りますが、`params` と `sources` にはありません）。

### ほかの生成の道具

| スクリプト | 読むもの | 書くもの | いつ |
|---|---|---|---|
| `scripts/gen-builtins.mjs` | 固定した版の `module.builtinModules` と `node:` だけのモジュール（`sea`・`sqlite`・`test`・`test/reporters`）、各モジュールの export の名前。`gen-node-data.mjs` と同じく公式の `node:<版>-bookworm-slim` イメージ（linux/amd64、Docker）の Node から取る | `src/shared/builtin-exports.json`（組み込みの殻の名前つき export。旧ランタイムのためのカーネルの ESM の配信が使う） | Node を上げたとき |
| `scripts/vendor-node-path.mjs [lib/path.js のパス]` | Node の `lib/path.js`（既定は `gen-node-data.mjs` が書く `vendor/node/lib/path.js`。固定した版のもの） | `src/shared/node-path.ts`（primordials をふつうの呼び出しにし、`process.cwd()`／`process.env` と `glob` を OpenVessel につなぐ） | Node を上げて `lib/path.js` が変わったとき |
| `scripts/regen-fixtures.mjs [name…]` | 固定した版の本物の Node（`npx -y node@<version>`） | `test/unit/fixtures/*.json`、`src/nodejs/bindings/icu.ts` の中の ICU の幅の表、`src/nodejs/bindings/crypto/tables.ts` | Node を上げたあと（[試験](testing.ja.md)） |
| `src/nodejs/bindings/zlib/wasm/build.mjs` | brotli 1.1.0 と zstd 1.5.7 のリリースの tarball（sha256 を確かめる）、`node-brotli.patch` | `src/nodejs/bindings/zlib/brotli-wasm.ts`・`zstd-wasm.ts`（raw deflate と base64。git に入れる） | ライブラリの版かビルドのフラグを変えるときだけ。`clang`／`wasm-ld` が要る。`CLANG`・`WASM_LD` で置き換えられる。作業のディレクトリは `WORK_DIR`（既定は `<tmp>/ov-zlib-wasm`） |

## 互換パッケージ

`scripts/build-compat.mjs`（`build.mjs` からも呼ばれる。単独では `node scripts/build-compat.mjs` で、`compat: <名前>` と出す）は、ネイティブのバイナリだけを配っている npm のパッケージの代わりを作ります。npm のインストーラーは、頼まれた名前と版のまま、ネイティブのパッケージの代わりにこれを入れます（[ネイティブのモジュール](native-modules.ja.md) を参照）。

```text
compat/<id>/package/    パッケージ自身のファイル（package.json は作る）
compat/<id>/build.mjs   任意: 作った物を vendor/compat/<id>/ に置く（取っておく。git の外）
```

| ID | 代わるもの | 範囲 | 出す名前 | 作る物 |
|---|---|---|---|---|
| `pagefind` | `@pagefind/linux-x64` | `^1.0.0` | `@openvessel/pagefind-wasi` 1.5.2 | `pagefind.wasm`: crates.io の `pagefind` 1.5.2 の crate に `compat/pagefind/wasi.patch` を当て、`cargo build --release --target wasm32-wasip1 --no-default-features`（strip・LTO・codegen unit 1） |
| `cn-font-split` | `cn-font-split` | `^7.0.0` | `@openvessel/cn-font-split-wasi`（版は元のパッケージの 7.4.3） | npm のレジストリの公開版 7.4.3 と、プロジェクトの GitHub のリリースの `libffi-wasm32-wasip1.wasm` 7.6.8。依存の `koffi` と `postinstall` のスクリプトは外す |
| `resvg-js` | `@resvg/resvg-js` | `^2.0.0` | `@openvessel/resvg-js-wasm` 2.6.2（`@resvg/resvg-wasm` 2.6.2 に依存） | なし |

パッケージごとに: `vendor/compat/<id>/` に作る物が欠けていて `build.mjs` があれば、それを動かします。失敗すると `compat <id>: not built (<理由>); <名前> will stay unavailable` と出し、それ抜きで続けます。ファイルは `package/` のディレクトリの下に並べ、ustar で固めます（`tar -czf <id>-<version>.tgz --format ustar`、`COPYFILE_DISABLE=1`）。`index.json` は代わる名前ごとに `{ range, file, integrity, pkg }` を持ち、`integrity` は tarball の `sha512-…` です。

## 型の宣言

`node scripts/build-types.mjs` は `dist/types/` を消し、`npx tsc -p tsconfig.types.json`（宣言だけ。`src/host/index.ts` とそれが import するもの）を実行し、出てきた `.d.ts` の中の `.ts` の import を `.js` に書き換えます。全部のビルドは `dist/` を消すので、`npm run build` の**あと**に実行します。`package.json` の `types` は `dist/types/host/index.d.ts` を指します。

## 手元のサーバー: serve.mjs

`node scripts/serve.mjs` は `dist/` を 3 つのオリジンで、`127.0.0.1` で配ります。

| サイト | ポート | ディレクトリ | ヘッダー |
|---|---|---|---|
| ホスト | `OV_HOST_PORT`、無ければ `OV_PORT_BASE`（既定 5170） | `dist/playground` | COOP `same-origin`・COEP `require-corp`・CORP `same-origin` |
| ランタイム | `OV_RUNTIME_PORT`、無ければ基準 + 1 | `dist/runtime` | COOP・COEP・CORP `cross-origin` と CSP: `default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors http://localhost:<ホストのポート>`。ただしネットワークポリシーの確認をする `/sw.js` には付けない（`connect-src 'self'` を引き継いではならない） |
| プレビュー | `OV_PREVIEW_PORT`、無ければ基準 + 2 | `dist/preview` | COOP・COEP・CORP `cross-origin`。`/__ov-sw.js` だけ COEP を `require-corp` ではなく `credentialless` にする |

どの応答にも `cache-control: no-cache` を付けます。`/` で終わるパスは `index.html` を返します。Content-Type は `.html`・`.js`・`.mjs`・`.css`・`.map`・`.json`・`.wasm`・`.svg`・`.png`（ほかは `application/octet-stream`）です。無いファイルは、サイトのヘッダーを付けた `404 not found` です。起動するとサイトごとに 1 行（`playground: http://localhost:5170/` など）出します。`OV_PORT_BASE` で、1 台のマシンで複数のサーバー（と試験）を動かせます。本番の配置に要るものは [配信](deployment.ja.md) にあります。

## Node.js の新しい版に追従する

OpenVessel が移植する Node の版は、`src/node/version.ts` の `NODE_VERSION` の 1 か所で決めています。`package.json` は同じ版を `openvessel.node` に持ちます。いまの版と履歴は [NODE-VERSION.md](../NODE-VERSION.md) にあります。

1. **何が変わるかを見る。** `node scripts/node-upgrade-check.mjs <新しい版>` は、同じ Docker の吸い出しで新しい版を取り、固定しているデータ（`vendor/node`・`src/node/data`）と比べて、`docs/node-upgrades/<いま>-to-<新しい版>.md` を書きます。中身は次の区分です。
   - *Builtins (lib/)*: 増えた・消えた・変わった組み込みと、消えた行・増えた行の数。新しい行に `internalBinding(` の呼び出しがある変更には **(binding use changed)** の印
   - *Bindings*: バインディングごとに、増えた・消えた・種類（`function`・`class(メソッド)`・型付き配列と長さ・Symbol・値）の変わったメンバー
   - *CLI options*: 増えた・消えた・既定値の変わったオプション
   - *process.versions*: 変わった同梱の依存の版
   最後に 1 行の要約を出します。版を渡さないと `usage: node scripts/node-upgrade-check.mjs <version>` と出して 1 で終わります。名前を変えずに引数が変わったもの（22.23 の `ModuleWrap.link()` など）は、この報告には出ません。
2. `src/node/version.ts` の版（と `package.json` の `openvessel.node`）を変えます。
3. データと期待値を作り直します。
   ```bash
   node scripts/gen-node-data.mjs     # vendor/node・src/node/data（Docker）
   node scripts/gen-builtins.mjs      # src/shared/builtin-exports.json（Docker）
   node scripts/vendor-node-path.mjs  # src/shared/node-path.ts（lib/path.js が変わったとき）
   node scripts/regen-fixtures.mjs    # 新しい版の本物の Node でバインディングの記録を取り直す
   node test/node-compat/fetch.mjs    # Node の試験も同じ版に
   ```
4. 報告に出たバインディングの変化を `src/nodejs/bindings/` に反映し、`src/nodejs/overrides/` のファイルが新しい `lib/` に合っているか確かめます。
5. ビルドし直して計ります。
   ```bash
   node scripts/build.mjs
   node test/node-compat/run.mjs --baseline
   node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report
   node corpus/run.mjs --port
   ```
   数字が前の版より下がっていないことを確かめます（[試験](testing.ja.md)）。
6. `docs/NODE-VERSION.md` のいまの版と履歴を書き換えます。

前回の追従の報告は [node-upgrades/22.20.0-to-22.23.4.md](../node-upgrades/22.20.0-to-22.23.4.md) です。

## リリース

手順の全部は [RELEASING.md](../RELEASING.md)（英語）にあります。要点:

- 版は OpenVessel 自身の semver です。移植している Node の版は、リリースの題（`OpenVessel <version> — Node.js <node>`）・リリースノート・`package.json` の `openvessel.node` に出します。直しや Node のパッチの版への追従はパッチ、機能の追加や Node のマイナーの版への追従はマイナー、ホストの API や埋め込みの条件を壊すもの・Node のメジャーの版はメジャーです。
- リリースはメンテナーの手元で、`main` からビルドします（ビルドに `vendor/` と取っておいた互換パッケージが要るため）。`package.json` と `package-lock.json` の版を変え、`openvessel.node` を確かめ、`CHANGELOG.md` に節を足し、`npm run build && node scripts/build-types.mjs && npm run typecheck && npm test`。ランタイムが変わったなら Node の試験とコーパスを流し直して、`README.md` と `docs/compatibility.md` の数字を直します。`npm pack`、`Release <version>` でコミットし、`v<version>` のタグを付け、両方を push します。`gh release create v<version> openvessel-<version>.tgz --title "OpenVessel <version> — Node.js <node>"`（リリース候補は `--prerelease`）。必要なら同じ tarball を `npm publish --provenance --access public` します。
- 公開するパッケージに入るのは `dist/` だけです（`package.json` の `files`）。semver の対象は `dist/host` のホストの API とその宣言、3 つのオリジンでの埋め込みの条件です。対象外は `src/`、`dist/runtime` と `dist/preview` の中のファイル、互換パッケージの中身です。

## リポジトリの並び

| パス | 中身 | git に入るか |
|---|---|---|
| `src/host/` | ホストの API（`OpenVessel.boot` など） — [ホスト API](host-api.ja.md) | はい |
| `src/kernel/` | カーネル: VFS・プロセス・パイプ・TTY・ソケット・`sh`・coreutils・npm・ESM の配信・仮想ポート・外への HTTP | はい |
| `src/nodejs/` | 移植版の Node.js ランタイム: `boot.ts`・`loop.ts`・`options.ts`・`env.ts`・`fetch.ts`・`typescript.ts`・`bindings/`・`overrides/` | はい |
| `src/node/` | 旧ランタイム。ほかに `version.ts`（固定した Node の版）・`data/`（吸い出した Node のデータ）・移植版ランタイムも使うモジュール（`sys.ts`・`native.ts`・`wasi.ts`） | はい |
| `src/runtime/` | ランタイムの iframe のページと、その Service Worker | はい |
| `src/preview/` | プレビューの中継・差し込むスクリプト・Service Worker | はい |
| `src/shared/` | カーネル・ランタイム・ホストで共有するコード（パス・解決・通信の方針・errno・同期の通り道） | はい |
| `playground/` | ホストのポートで配る開発用のプレイグラウンド | はい |
| `compat/` | 互換パッケージのソース | はい |
| `scripts/` | ビルド・データ・配信・試験のスクリプト | はい |
| `test/unit/`・`test/fixtures-gen/` | 単体の試験と、記録を作るスクリプト | はい |
| `test/e2e/` | 端から端までの試験のスクリプト（ヘッドレスの Chrome） | はい |
| `test/node-compat/` | Node の試験を動かす道具と `limits/`。`.node/` と `results/` は git の外 | 一部 |
| `corpus/` | Astro のサイトの一覧と、それを流す道具。`sites/` と実行のログは git の外 | 一部 |
| `docs/` | 文書。`docs/node-upgrades/` に版の追従の報告 | はい |
| `vendor/` | `vendor/node/`（Node のソースとライセンス）・`vendor/compat/`（互換パッケージの作った物） | いいえ |
| `dist/` | ビルドの出力 | いいえ |

## 関連するページ

- [試験](testing.ja.md)
- [バインディング](bindings.ja.md)・[Node.js ランタイム](nodejs-runtime.ja.md)
- [配信](deployment.ja.md)・[ネイティブのモジュール](native-modules.ja.md)
