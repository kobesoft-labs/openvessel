# ビルドと保守

[English](building.md)

OpenVessel をソースからビルドし、最新の状態に保つための手順です。必要なツール、npm スクリプト、各ビルドスクリプトが読み書きするファイル、Node.js の新しいバージョンへの追従、リリースの手順を説明します。テストの実行方法は [テスト](testing.ja.md) を参照してください。

## 要るもの

| ツール | 用途 |
|---|---|
| Node.js と npm | すべて。単体テストのバンドルは `node22` 向けにビルドする。fixture とベースラインのスクリプトは `npx -y node@<固定したバージョン>` を取得するため、npm レジストリへの通信が必要 |
| Docker（`linux/amd64` のイメージを実行できること） | `scripts/gen-node-data.mjs`・`scripts/gen-builtins.mjs`・`scripts/node-upgrade-check.mjs`。Node のバージョンごとに 1 回実行し、`vendor/node/`・`src/node/data/`・`src/shared/builtin-exports.json` を生成する |
| `curl` | `gen-node-data.mjs`（Node の `LICENSE` をダウンロードする）、zlib の WebAssembly のビルド |
| Rust（`cargo`）と `rustup target add wasm32-wasip1` | `vendor/compat/pagefind/` が無いときの、Pagefind の互換パッケージのビルド |
| wasm32 ターゲット対応の LLVM `clang` と `wasm-ld` | brotli／zstd の WebAssembly をビルドし直すときのみ（`src/nodejs/bindings/zlib/wasm/build.mjs`） |
| Google Chrome | E2E テスト、Node のテストスイート、コーパス（`playwright-core` から `channel: 'chrome'` で起動する） |
| `git` | `test/node-compat/fetch.mjs`（nodejs/node の sparse clone） |
| ログイン済みの GitHub CLI `gh` | `corpus/collect.mjs`（新しく clone したリポジトリで `corpus/sites/` を復元するときも）、リリース時の `gh release create` |

新しく clone したリポジトリは、次の手順でビルドします。

```bash
npm install
node scripts/gen-node-data.mjs   # 1 回だけ（Docker）。vendor/node/ と src/node/data/
npm run build                    # dist/
npm run serve                    # ホスト :5170、ランタイム :5171、プレビュー :5172
```

## npm のスクリプト

| スクリプト | コマンド | 内容 |
|---|---|---|
| `build` | `node scripts/build.mjs` | `dist/` へフルビルドする |
| `dev` | `node scripts/build.mjs --watch & node scripts/serve.mjs` | 変更のたびにビルドし直して配信する |
| `serve` | `node scripts/serve.mjs` | `dist/` を 3 つのオリジンで配信する |
| `test` | `node scripts/test.mjs` | 単体テスト（[テスト](testing.ja.md)） |
| `typecheck` | `tsc --noEmit -p .` | `src/`・`test/`・`playground/` の型チェック（`tsconfig.json`） |
| `build:types` | `node scripts/build-types.mjs` | ホスト API の型宣言を `dist/types/` に出力する |

## scripts/build.mjs

esbuild ですべてをバンドルします。フラグは次のとおりです。

| フラグ | 動作 |
|---|---|
| （なし） | `dist/` を削除し、静的ファイルをコピーし、esbuild のビルドをすべて 1 回ずつ実行する。そのあと `nodelib.js` を生成し、amaro をコピーし、互換パッケージをビルドする |
| `--watch` | `dist/` を削除しない。静的ファイルをコピーし、エントリーごとに esbuild の watch を開始する。このモードでは `nodelib.js`・`amaro.js`・互換パッケージを生成（再生成）しないため、事前にフルビルドで生成しておく必要がある |
| `--minify` | すべてのバンドルを minify する |

esbuild の共通オプションは `bundle`、`sourcemap: 'linked'`、`target: 'es2022'`、`platform: 'browser'`、`legalComments: 'none'`、`define: { global: 'globalThis' }` です。旧ランタイムとその他のバンドルでは、`events`・`process`・`string_decoder`・`abort-controller` を `src/node/` の shim に alias し、`process/`・`string_decoder/`・`cjs-module-lexer/lexer.js` を小さなプラグインで解決します。移植版ランタイムのバンドルは alias を使いません。

| エントリー | ソース | 出力 | 形式 |
|---|---|---|---|
| `kernel` | `src/kernel/index.ts` | `dist/runtime/kernel.js` | ESM。`dist/runtime/chunks/[name]-[hash].js` にコード分割 |
| `process` | `src/node/worker.ts` | `dist/runtime/process.js`（旧ランタイム） | ESM。`kernel` とチャンクを共有 |
| `runtime` | `src/runtime/runtime.ts` | `dist/runtime/runtime.js` | IIFE |
| `sw` | `src/runtime/sw.ts` | `dist/runtime/sw.js`（ランタイムの Service Worker） | IIFE |
| `node-process` | `src/nodejs/boot.ts` | `dist/runtime/node-process.js`（移植版ランタイム）。`./nodelib.js` は外部の import のまま | ESM |
| `ts-strip` | `src/nodejs/ts-strip.ts` | `dist/runtime/ts-strip.js`（`require(esm)` 用の sucrase） | IIFE |
| `relay`・`inject` | `src/preview/relay.ts`・`src/preview/inject.ts` | `dist/preview/__ov/relay.js`・`dist/preview/__ov/inject.js` | IIFE |
| `__ov-sw` | `src/preview/sw.ts` | `dist/preview/__ov-sw.js`（プレビューのディレクトリの最上位に配置する。`Service-Worker-Allowed` ヘッダーなしでディレクトリ全体をスコープにできるため） | IIFE |
| `index` | `src/host/index.ts` | `dist/host/index.js`（パッケージの `main`） | ESM |
| `app` | `playground/app.ts` | `dist/playground/app.js`（CSS は `css` ローダーで読み込む） | ESM |

コピーする静的ファイルは、`src/runtime/runtime.html` → `dist/runtime/runtime.html`、`src/preview/relay.html` → `dist/preview/__ov/relay.html`、`playground/index.html` と `playground/app.css` → `dist/playground/`、`node_modules/@xterm/xterm/css/xterm.css` → `dist/playground/xterm.css` です。

フルビルドのときだけ、esbuild のビルドのあとに次の処理を行います。

- `genNodeLib()` は、`vendor/node/natives.json` があれば `dist/runtime/nodelib.js` と `dist/runtime/NODE-LICENSE.txt`（Node の `LICENSE`。同梱している依存ライブラリの告知も含む）を書き出します。`vendor/node` が無い場合は `vendor/node missing: run node scripts/gen-node-data.mjs to build the ported Node runtime` と表示され、移植版ランタイムは起動できません。
- amaro をコピーします。`node_modules/amaro/dist/index.js` → `dist/runtime/amaro.js` と、`dist/runtime/AMARO-LICENSE.txt`（amaro と swc のライセンス）です。
- `buildCompat()` が `dist/runtime/compat/*.tgz` と `dist/runtime/compat/index.json` を書き出します。

最後に `built dist/` と表示されます。

## Node のデータ

### gen-node-data.mjs

`node scripts/gen-node-data.mjs` は、固定したバージョン（`src/node/version.ts` の `NODE_VERSION`）の実際の Node.js から、OpenVessel に必要なデータをすべて抽出します。公式イメージの中で、抽出用のスクリプトを標準入力から実行します。

```bash
docker run --rm -i --platform linux/amd64 --hostname openvessel -e HOME=/home/user \
  node:<version>-bookworm-slim node --expose-internals --no-warnings -
```

OpenVessel は自身を Linux x64 として報告するため、errno・シグナル・`O_*` の値がカーネルと一致するよう Linux x64 のイメージを使います。スクリプトはあらかじめ決めた 68 個のバインディング名について `internalBinding()` を呼び（そのバージョンに存在しない名前は `__missing` として記録）、それぞれの形を記録します。`internalBinding('builtins').natives` とプロセスのデータも記録します。

| 出力 | 内容 | git 管理 |
|---|---|---|
| `vendor/node/natives.json` | すべての組み込みモジュールのソース（`lib/` と `deps/`）。Node が埋め込んでいるものと同一 | いいえ |
| `vendor/node/lib/<id>.js` | 同じソースをファイルにしたもの。読んだり grep したりするため | いいえ |
| `vendor/node/LICENSE` | Node のライセンス。`raw.githubusercontent.com/nodejs/node/v<version>/LICENSE` から `curl` でダウンロードする | いいえ |
| `src/node/data/bindings.json` | 各バインディングの定数と API の形（関数、クラスとそのプロトタイプのメソッド、型付き配列、Map、Symbol）と `uv.__errmap` | はい |
| `src/node/data/process.json` | `versions`・`release`・`features`・`config`・`optionValues`・`optionInfo`（オプションと別名）・`embedderOptions`・`envSettings`・`types`・`builtinCategories`・`globals`（起動後の各グローバル名 → 列挙可能かどうか） | はい |

形のエンコード方法は次のとおりです（`src/nodejs/bindings/shape.ts` が読み戻します。[バインディング](bindings.ja.md) を参照）。関数は `{ __fn, proto?, statics? }`、型付き配列は `{ __typed, length, values? }`（値は 64 要素まで）になり、それ以外のケースには `__num`・`__bigint`・`__symbol`・`__map`・`__set`・`__ref`・`__object`・`__array`・`__throws`・`__missing` を使います。深く入れ子になった値は途中で打ち切ります（`__object`・`__array`）。スクリプトを実行したこと自体による変化は元に戻します。具体的には `--expose-internals`・`--no-warnings`・`--require` をリセットし、標準入力のスクリプトのグローバル `__filename`・`__dirname`・`module`・`exports`・`require`・`shape` を `globals` から除きます。最後に `node v<version>: <n> builtins, <m> bindings` と表示します。

### gen-nodelib.mjs

`build.mjs` から呼ばれます。単独で `node scripts/gen-nodelib.mjs` として実行することもでき、その場合は `dist/runtime/nodelib.js` を書き出して `{ count, bytes, overrides }` を表示します。`vendor/node/natives.json` を読み込み、`src/nodejs/overrides/<id>.js` があるモジュールはそのファイルに差し替え（[Node.js ランタイム](nodejs-runtime.ja.md#差し替え) を参照）、`internal/deps/v8/tools/*`（V8 のプロファイラー用ツール）を除いて、1 つの ES モジュールを書き出します。

```js
// Generated by scripts/gen-nodelib.mjs from Node.js 22.23.4 — see vendor/node/LICENSE.
export const ids = [/* 組み込みの ID の全部。並べ替えたもの */];
export const params = { 'fs': 'exports, require, module, process, internalBinding, primordials', /* … */ };
export const sources = { 'fs': '…ソースの文字列…', /* … */ };
```

ソースは文字列のまま保持し、初めて使うときに 1 つずつコンパイルします。詳しくは [Node.js ランタイム](nodejs-runtime.ja.md#nodelibjs-と遅延コンパイル) を参照してください（`ids` には除外した `internal/deps/v8/tools/*` の ID も残りますが、`params` と `sources` にはエントリーがありません）。

### ほかの生成の道具

| スクリプト | 入力 | 出力 | 実行するタイミング |
|---|---|---|---|
| `scripts/gen-builtins.mjs` | 固定したバージョンの `module.builtinModules`、`node:` 付きでのみ使えるモジュール（`sea`・`sqlite`・`test`・`test/reporters`）、各モジュールの export 名。`gen-node-data.mjs` と同様に公式の `node:<version>-bookworm-slim` イメージ（linux/amd64、Docker）の Node から取得する | `src/shared/builtin-exports.json`（組み込みモジュールのファサードの名前付き export。旧ランタイム向けにカーネルの ESM サービスが使う） | Node のアップグレード後 |
| `scripts/vendor-node-path.mjs [lib/path.js のパス]` | Node の `lib/path.js`（既定は `gen-node-data.mjs` が書き出す、固定したバージョンの `vendor/node/lib/path.js`） | `src/shared/node-path.ts`（primordials を通常の呼び出しに置き換え、`process.cwd()`／`process.env` と `glob` を OpenVessel に接続する） | Node のアップグレードで `lib/path.js` が変わったとき |
| `scripts/regen-fixtures.mjs [name…]` | 固定したバージョンの実際の Node（`npx -y node@<version>`） | `test/unit/fixtures/*.json`、`src/nodejs/bindings/icu.ts` 内の ICU の文字幅テーブル、`src/nodejs/bindings/crypto/tables.ts` | Node のアップグレード後（[テスト](testing.ja.md)） |
| `src/nodejs/bindings/zlib/wasm/build.mjs` | brotli 1.1.0 と zstd 1.5.7 のリリース tarball（sha256 を検証する）、`node-brotli.patch` | `src/nodejs/bindings/zlib/brotli-wasm.ts`・`zstd-wasm.ts`（raw deflate したうえで base64。git にコミットする） | ライブラリのバージョンやビルドフラグを変えるときのみ。`clang`／`wasm-ld` が必要。`CLANG`・`WASM_LD` で上書きできる。作業ディレクトリは `WORK_DIR`（既定は `<tmp>/ov-zlib-wasm`） |

## 互換パッケージ

`scripts/build-compat.mjs` は、ネイティブバイナリしか提供していない npm パッケージの代替品をビルドします。`build.mjs` からも呼ばれ、単独で `node scripts/build-compat.mjs` として実行すると `compat: <名前>` と表示します。npm のインストーラーは、要求された名前とバージョンのまま、ネイティブのパッケージの代わりにこれをインストールします（[ネイティブのモジュール](native-modules.ja.md) を参照）。

```text
compat/<id>/package/    パッケージ自身のファイル（package.json は生成する）
compat/<id>/build.mjs   任意: 成果物を vendor/compat/<id>/ にビルドする（キャッシュ。git 管理外）
```

| ID | 置き換える対象 | 範囲 | 公開名 | 成果物 |
|---|---|---|---|---|
| `pagefind` | `@pagefind/linux-x64` | `^1.0.0` | `@openvessel/pagefind-wasi` 1.5.2 | `pagefind.wasm`: crates.io の `pagefind` 1.5.2 の crate に `compat/pagefind/wasi.patch` を当て、`cargo build --release --target wasm32-wasip1 --no-default-features`（strip・LTO・codegen unit 1） |
| `cn-font-split` | `cn-font-split` | `^7.0.0` | `@openvessel/cn-font-split-wasi`（バージョンは元のパッケージの 7.4.3） | npm レジストリで公開されている 7.4.3 と、プロジェクトの GitHub リリースにある `libffi-wasm32-wasip1.wasm` 7.6.8。依存の `koffi` と `postinstall` スクリプトは取り除く |
| `resvg-js` | `@resvg/resvg-js` | `^2.0.0` | `@openvessel/resvg-js-wasm` 2.6.2（`@resvg/resvg-wasm` 2.6.2 に依存） | なし |

各パッケージについて、`vendor/compat/<id>/` に成果物が無く `build.mjs` がある場合は、それを実行します。失敗した場合は `compat <id>: not built (<理由>); <名前> will stay unavailable` と表示し、そのパッケージなしでビルドを続けます。ファイルは `package/` ディレクトリの下にまとめ、ustar 形式で固めます（`tar -czf <id>-<version>.tgz --format ustar`、`COPYFILE_DISABLE=1`）。`index.json` は置き換える名前ごとに `{ range, file, integrity, pkg }` を持ち、`integrity` は tarball の `sha512-…` です。

## 型の宣言

`node scripts/build-types.mjs` は `dist/types/` を削除してから `npx tsc -p tsconfig.types.json`（`src/host/index.ts` とその import 先の宣言のみ）を実行し、出力された `.d.ts` 内の `.ts` の import 指定子を `.js` に書き換えます。フルビルドは `dist/` を削除するので、必ず `npm run build` のあとに実行してください。`package.json` の `types` は `dist/types/host/index.d.ts` を指しています。

## 手元のサーバー: serve.mjs

`node scripts/serve.mjs` は、`dist/` を `127.0.0.1` 上の 3 つのオリジンで配信します。

| サイト | ポート | ディレクトリ | ヘッダー |
|---|---|---|---|
| ホスト | `OV_HOST_PORT`、無ければ `OV_PORT_BASE`（既定 5170） | `dist/playground` | COOP `same-origin`・COEP `require-corp`・CORP `same-origin` |
| ランタイム | `OV_RUNTIME_PORT`、無ければベース + 1 | `dist/runtime` | COOP・COEP・CORP `cross-origin` と CSP: `default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors http://localhost:<ホストのポート>`。ただし `/sw.js` には付けない（ネットワークポリシーの確認を行うので、`connect-src 'self'` を引き継いではならない） |
| プレビュー | `OV_PREVIEW_PORT`、無ければベース + 2 | `dist/preview` | COOP・COEP・CORP `cross-origin`。`/__ov-sw.js` だけ COEP を `require-corp` ではなく `credentialless` にする |

すべてのレスポンスに `cache-control: no-cache` を付けます。`/` で終わるパスには `index.html` を返します。Content-Type を設定するのは `.html`・`.js`・`.mjs`・`.css`・`.map`・`.json`・`.wasm`・`.svg`・`.png` で、それ以外は `application/octet-stream` です。存在しないファイルには、そのサイトのヘッダーを付けて `404 not found` を返します。起動時にはサイトごとに 1 行（`playground: http://localhost:5170/` など）を表示します。`OV_PORT_BASE` を使うと、1 台のマシンで複数のサーバー（やテストの実行）を同時に動かせます。本番環境へのデプロイに必要なことは [デプロイ](deployment.ja.md) にまとめています。

## Node.js の新しいバージョンに追従する

OpenVessel が移植する Node のバージョンは、`src/node/version.ts` の `NODE_VERSION` の 1 か所で固定しています。`package.json` にも同じバージョンを `openvessel.node` として記載しています。現在のバージョンと履歴は [NODE-VERSION.md](../NODE-VERSION.md) にあります。

1. 何が変わるかを確認します。`node scripts/node-upgrade-check.mjs <新しいバージョン>` は、同じ Docker の抽出スクリプトで新しいバージョンのデータを取り、固定しているデータ（`vendor/node`・`src/node/data`）と比較して、`docs/node-upgrades/<現在>-to-<新しいバージョン>.md` を書き出します。内容は次のセクションです。
   - *Builtins (lib/)*: 追加・削除・変更された組み込みモジュールと、削除・追加された行数。変更後の新しい行で `internalBinding(` を呼んでいるファイルには **(binding use changed)** の印が付く
   - *Bindings*: バインディングごとに、追加・削除されたメンバーと、種類（`function`・`class(methods)`・型付き配列と長さ・Symbol・値）が変わったメンバー
   - *CLI options*: 追加・削除されたオプション、既定値が変わったオプション
   - *process.versions*: バージョンが変わった同梱の依存ライブラリ
   最後に 1 行の要約を表示します。バージョンを指定しないと `usage: node scripts/node-upgrade-check.mjs <version>` と表示して終了コード 1 で終わります。メンバー名を変えずにシグネチャだけが変わった場合（22.23 の `ModuleWrap.link()` など）は、このレポートには現れません。
2. `src/node/version.ts` のバージョン（と `package.json` の `openvessel.node`）を書き換えます。
3. データと期待値を作り直します。
   ```bash
   node scripts/gen-node-data.mjs     # vendor/node・src/node/data（Docker）
   node scripts/gen-builtins.mjs      # src/shared/builtin-exports.json（Docker）
   node scripts/vendor-node-path.mjs  # src/shared/node-path.ts（lib/path.js が変わったとき）
   node scripts/regen-fixtures.mjs    # 新しいバージョンの実際の Node でバインディングの fixture を取り直す
   node test/node-compat/fetch.mjs    # Node のテストも同じバージョンに
   ```
4. レポートに出たバインディングの変更を `src/nodejs/bindings/` に反映し、`src/nodejs/overrides/` のファイルが新しい `lib/` と合っているかを確認します。
5. ビルドし直して計測します。
   ```bash
   node scripts/build.mjs
   node test/node-compat/run.mjs --baseline
   node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report
   node corpus/run.mjs --port
   ```
   数値が前のバージョンを下回っていないことを確認します（[テスト](testing.ja.md)）。
6. `docs/NODE-VERSION.md` の現在のバージョンと履歴を更新します。

前回のアップグレードのレポートは [node-upgrades/22.20.0-to-22.23.4.md](../node-upgrades/22.20.0-to-22.23.4.md) です。

## リリース

詳しい手順は [RELEASING.md](../RELEASING.md)（英語）にあります。概要は次のとおりです。

- バージョン番号は OpenVessel 独自の semver です。移植している Node のバージョンは、リリースのタイトル（`OpenVessel <version> — Node.js <node>`）、リリースノート、`package.json` の `openvessel.node` に記載します。バグ修正や Node のパッチリリースへの追従はパッチ、機能追加や Node のマイナーリリースへの追従はマイナーです。ホスト API や埋め込みの要件を壊す変更、Node の新しいメジャーバージョンはメジャーとします。
- リリースは、メンテナーの手元のマシンで `main` からビルドします（ビルドに `vendor/` とキャッシュ済みの互換パッケージが必要なため）。`package.json` と `package-lock.json` のバージョンを書き換え、`openvessel.node` を確認し、`CHANGELOG.md` にセクションを追加してから、`npm run build && node scripts/build-types.mjs && npm run typecheck && npm test` を実行します。ランタイムに変更があれば Node のテストスイートとコーパスを流し直し、`README.md` と `docs/compatibility.md` の数値を更新します。続いて `npm pack` を実行し、`Release <version>` としてコミットし、`v<version>` のタグを付けて両方を push します。そして `gh release create v<version> openvessel-<version>.tgz --title "OpenVessel <version> — Node.js <node>"`（リリース候補は `--prerelease`）を実行します。必要に応じて、同じ tarball を `npm publish --provenance --access public` で公開します。
- 公開するパッケージに含まれるのは `dist/` だけです（`package.json` の `files`）。semver の対象は、`dist/host` のホスト API とその型宣言、および 3 つのオリジンで埋め込むための要件です。`src/`、`dist/runtime` と `dist/preview` の中のファイル、互換パッケージの中身は対象外です。

## リポジトリの並び

| パス | 内容 | git 管理 |
|---|---|---|
| `src/host/` | ホスト API（`OpenVessel.boot` など）。[ホスト API](host-api.ja.md) を参照 | はい |
| `src/kernel/` | カーネル: VFS・プロセス・パイプ・TTY・ソケット・`sh`・coreutils・npm・ESM サービス・仮想ポート・外部への HTTP | はい |
| `src/nodejs/` | 移植版の Node.js ランタイム: `boot.ts`・`loop.ts`・`options.ts`・`env.ts`・`fetch.ts`・`typescript.ts`・`bindings/`・`overrides/` | はい |
| `src/node/` | 旧ランタイム。ほかに `version.ts`（固定した Node のバージョン）、`data/`（抽出した Node のデータ）、移植版ランタイムも使うモジュール（`sys.ts`・`native.ts`・`wasi.ts`） | はい |
| `src/runtime/` | ランタイムの iframe のページと、その Service Worker | はい |
| `src/preview/` | プレビューの中継、注入するスクリプト、Service Worker | はい |
| `src/shared/` | カーネル・ランタイム・ホストで共有するコード（パス、モジュール解決、ネットワークポリシー、errno、同期チャネル） | はい |
| `playground/` | ホストのポートで配信する開発用の playground | はい |
| `compat/` | 互換パッケージのソース | はい |
| `scripts/` | ビルド・データ生成・配信・テストのスクリプト | はい |
| `test/unit/`・`test/fixtures-gen/` | 単体テストと fixture の生成スクリプト | はい |
| `test/e2e/` | E2E テストのスクリプト（ヘッドレス Chrome） | はい |
| `test/node-compat/` | Node 本体のテストを実行するランナーと `limits/`。`.node/` と `results/` は git 管理外 | 一部 |
| `corpus/` | Astro のサイト一覧とランナー。`sites/` と実行ログは git 管理外 | 一部 |
| `docs/` | ドキュメント。`docs/node-upgrades/` にアップグレードのレポート | はい |
| `vendor/` | `vendor/node/`（Node のソースとライセンス）・`vendor/compat/`（ビルド済みの互換パッケージの成果物） | いいえ |
| `dist/` | ビルドの出力 | いいえ |

## 関連するページ

- [テスト](testing.ja.md)
- [バインディング](bindings.ja.md)・[Node.js ランタイム](nodejs-runtime.ja.md)
- [デプロイ](deployment.ja.md)・[ネイティブのモジュール](native-modules.ja.md)
