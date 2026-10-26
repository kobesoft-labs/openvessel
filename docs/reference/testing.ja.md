# テスト

[English](testing.md)

OpenVessel のテストは 4 種類あります。Node.js で実行する単体テスト（バインディングを本物の Node と比較する差分テストを含む）、ヘッドレスの Chrome でプレイグラウンドを操作する E2E テスト、OpenVessel の中で実行する Node.js 自身のテストスイート、実在する Astro のサイトを集めたコーパスです。以下では、それぞれのランナーの引数・環境変数・タイムアウト・結果ファイルと、テストの追加方法を説明します。

| テスト | ランナー | 必要なもの | よく使うコマンド |
|---|---|---|---|
| 単体 | `scripts/test.mjs` | Node.js | `npm test` |
| E2E | `test/e2e/*.mjs` | ビルド（`dist/`）・Google Chrome | `node test/e2e/harness.mjs 'node -v'` |
| Node のテストスイート | `test/node-compat/run.mjs` | ビルド・Chrome・`test/node-compat/.node/` | `node test/node-compat/run.mjs --port fs` |
| Astro のコーパス | `corpus/run.mjs` | ビルド・Chrome・`corpus/sites/`・ネットワーク | `node corpus/run.mjs basics` |

ブラウザを使うテストの実行中は `dist/` をビルドし直さないでください。実行中のテストが古いファイルと新しいファイルを混ぜて読み込んでしまいます。

## 環境変数

| 変数 | 読むもの | 効果 |
|---|---|---|
| `OV_PORT_BASE` | `scripts/serve.mjs`・`test/e2e/harness.mjs` | 3 つのサーバーのポートが base・base + 1・base + 2 になり（既定は 5170）、ブラウザのプロファイルが `node_modules/.cache/ov-chrome-<base>`（5170 のときは `ov-chrome`）になる。複数のテストを並行して実行できる |
| `OV_HOST_PORT`・`OV_RUNTIME_PORT`・`OV_PREVIEW_PORT` | `scripts/serve.mjs` | ポートを個別に指定する。ハーネスは `OV_PORT_BASE` しか知らないので、テスト用のスクリプトとは併用しない |
| `HEADED` | `harness.mjs`（直接実行するとき）・`project.mjs`・`dev.mjs`・`preview-port.mjs` | 空でなければブラウザのウィンドウを表示する |
| `OV_CONSOLE` | `harness.mjs` | 空でなければ、ページのコンソールメッセージを `[console.<type>] <text>` の形で出力する（ページのエラーは常に `[pageerror] …` と出力する） |
| `OV_TRACE` | `harness.mjs` | 空でなければカーネルのトレース（`debug.trace`）を有効にする。プロセスの起動、パイプのクローズ、読み取りでの EOF、fd 0 の同期読み取りのたびに `[trace]` の行をコンソールに出す（`OV_CONSOLE=1` で見える） |
| `SETUP` | `run-file.mjs` | ファイルを書き込む前に実行するコマンドライン |
| `PRINT` | `port-fs.mjs` | 空でなければ、すべてのシナリオの実際の出力を表示する |
| `OV_TIMING` | 移植版ランタイム | ホストではなく OpenVessel の中で使う。起動時間の内訳を出力する（[Node.js ランタイム](nodejs-runtime.ja.md#ov_timing)） |

## 単体テスト

`npm test` は `scripts/test.mjs` を実行します。処理の流れは次のとおりです。

1. `test/unit/*.test.ts` を集めます。最初の引数を渡すと、ファイル名にその文字列を含むものだけに絞り込みます（例: `npm test -- zlib`）。
2. esbuild で `node_modules/.cache/ov-tests/*.mjs` にバンドルします（`platform: 'node'`・ESM・`target: 'node22'`・インラインのソースマップ・npm パッケージは external のまま）。出力先のディレクトリは先に削除します。
3. `node --enable-source-maps --test <ファイル>` を実行し、その終了コードで終了します。

| ファイル | テスト対象 |
|---|---|
| `bindings-*.test.ts` | 本物の Node で記録したフィクスチャとバインディングを比較する。[バインディング](bindings.ja.md#バインディングを本物の-node-と比較する) を参照 |
| `bindings-v8.test.ts` | `internalBinding('v8')` が `lib/v8.js` の読むバッファを埋めること、`heap_utils` がスナップショットを利用できないと報告すること |
| `npm-wasm-runtime.test.ts` | `pickWasmRuntime`（バインディングと emnapi の peer が一致する `@napi-rs/wasm-runtime` を選ぶ処理） |
| `policy.test.ts` | ネットワークポリシーの `decide`／`normalizePolicy`（プリセット・ask・allowlist・deny の優先・外に出るのは http(s) だけ） |
| `resolve.test.ts` | モジュールの解決（CJS の探索・`exports` の条件とパターン・`imports`・クエリ文字列） |
| `semver.test.ts` | npm クライアントの semver（範囲・プレリリース・`maxSatisfying`・`minVersion`） |
| `sh.test.ts` | Worker を使わないカーネル上でのシェルと coreutils（`helpers.ts` の `makeKernel()`・`run()`） |

補助ファイルは次の 3 つです。

- `helpers.ts`: `sh`・`bash`・coreutils を登録した `Kernel` を用意します。`run(kernel, script, cwd, argv)` は `{ stdout, stderr, code }` を返します。
- `binding-fixtures.ts`: `compareFixtures` を提供します。
- `zlib-loop-shim.ts`: `bindings-zlib.test.ts` が最初に import します。イベントループの `MessageChannel` のせいでテストのプロセスが終わらなくなるのを防ぎます。

### フィクスチャの再生成

`node scripts/regen-fixtures.mjs [name…]` は、固定したバージョンの Node を `npx -y node@<version> -p process.execPath` で取得し、各ジェネレーターを `--expose-internals --no-warnings` 付きで実行します。ジョブごとに `<name>… ok` を、最後に `fixtures recorded from node v<version>` を出力します。ジョブは `encoding`・`string_decoder`・`url`・`icu`・`icu-width-table`・`http_parser`・`zlib`・`serdes`・`histogram`・`crypto`・`crypto-asym`・`crypto-tables` です。どのジェネレーターも、別のバージョンの Node では実行を拒否します（`run with node@<version> (got <version>)`）。

## E2E テスト

`test/e2e/` のスクリプトはすべて `harness.mjs` を使います。ハーネスは `scripts/serve.mjs` を起動し（`OV_PORT_BASE` に従う）、ローカルの Chrome を `playwright-core` で起動して（`channel: 'chrome'`・永続プロファイル・`--js-flags=--stack-size=4000`）、`http://localhost:<base>/` のプレイグラウンドを開きます。`window.ovReady` を待ってから、プレイグラウンドの `window.ov`（`OpenVessel` のインスタンス）を使います。プレイグラウンドは `/home/user/app` に Astro 5 のサンプルプロジェクトをマウントします。コマンドが `/etc/openvessel/node` に `legacy` を書き込まない限り、移植版ランタイムで実行します（[Node.js ランタイム](nodejs-runtime.ja.md#ランタイムの選び方) を参照）。

`harness.mjs` がエクスポートする関数:

| 関数 | 処理 |
|---|---|
| `startServer()` | `scripts/serve.mjs` を起動し、何か出力があった時点で resolve する |
| `openBrowser({ headless = true, profile })` | Chrome を起動してプレイグラウンドを開き、`ovReady` を待つ。`OV_CONSOLE`・`OV_TRACE` が有効 |
| `exec(page, cmd, { cwd = '/home/user/app', timeout = 600000, allowAll = true })` | ネットワークポリシーを `allow-all` にし（`allowAll: false` のときを除く）、`ov.exec(cmd, { cwd })` を実行して `{ code, output, ms }` を返す |
| `useLegacyRuntime(page)` | `/etc/openvessel/node` に `legacy` を書き込む。以後に起動する node のプロセスは旧ランタイムで動く |
| `usePortedRuntime(page)` | `/etc/openvessel/node` に `port` を書き込む。移植版ランタイムは既定なので、選択を明示するだけ |

| スクリプト | 引数 | 処理 |
|---|---|---|
| `harness.mjs` | `[コマンド]`（既定は `echo hello; node -e "console.log(process.version)"`） | コマンドラインを 1 つ実行し、出力と `[exit <code> in <ms>ms]` を表示する |
| `run-file.mjs` | `<ローカルのファイル> <VFS のパス> '<コマンド>'` | `SETUP` があれば実行し、ローカルのファイルを VFS に書き込んでからコマンドを実行する |
| `watch.mjs` | `[--mount <dir>] '<コマンド>' [秒=20]` | `/bin/sh -c <コマンド>` を起動し（cwd は `/home/user`。`--mount` を付けると、先にローカルのプロジェクトをコピーした `/home/user/app`）、200 ms ごとに出力を流す。終了すれば `[exit <code>]` を、時間切れなら `[still running after <n>s] ps:` とプロセス一覧を表示する |
| `project.mjs` | `<dir> ['<コマンド>']`（既定は `npm install && npm run build`） | `/home/user/app` をローカルのプロジェクトで置き換えてコマンドを実行する（タイムアウト 15 分）。`node_modules`・`.git`・`dist`・`.astro`・`.vercel`・`.netlify`・`.cache`・`.turbo`・`.output` と 64 MiB を超えるファイルはスキップし、シンボリックリンクは保持する。`collectFiles()` と `mountProject()` をエクスポートする |
| `dev.mjs` | `[--legacy]` | `/home/user/app` で `npm install` を実行し、`npm run dev` を起動して `server-ready` を待つ。プレビューの `<h1>` を確認し、`src/pages/index.astro` を編集して HMR による更新を最大 30 秒待つ |
| `preview-port.mjs` | — | 移植版ランタイムで、ポート 4000 に `http` サーバーを立て、プレビューの iframe に読み込み（70000 バイトの chunked の本文）、iframe から POST する。`OK` か `FAIL` を表示し、0／1 で終了する |
| `port-fs.mjs` | `[シナリオ…]` | 移植版ランタイムで fs のシナリオ `dir`・`watch`・`watch2`・`cp`・`cp2`・`misc`・`misc2`（opendir と Dir・`fs.watch`・`fs.watchFile`・`fs.cp`／`cpSync`・readv／writev・FileHandle）を実行し、それぞれの出力を Linux 上の Node v22.23.4（Docker の `node:22.23.4-bookworm-slim`）で記録した期待値と比較する。`ok`／`FAIL` と行単位の差分、`all passed` または `<n> failed` を表示し、0／1 で終了する |
| `esm-graph.mjs` | `[--port] <プロジェクトのディレクトリ> <VFS 上のエントリのパス> [インストールのコマンド='npm install']` | プロジェクトをマウントしてインストールし、カーネルが `/__ov/esm` で配信する ES モジュールのグラフ（旧ランタイムの ESM 配信）をたどって、読み込めないモジュールを報告する |
| `debug-esm.mjs` | `[--port] <VFS のパス…>` | `npm install` を実行したあと、各パスについて `/__ov/esm<パス>` の先頭 3000 文字を表示する |

`dev.mjs` は移植版ランタイムで動きます。`--legacy` を付けると、最初に `harness.mjs` の `useLegacyRuntime(page)` で旧ランタイムに切り替えます。`esm-graph.mjs` と `debug-esm.mjs` は逆で、読み出す ESM 配信を使うのは旧ランタイムだけなので、`--port` を付けない限り `useLegacyRuntime(page)` で旧ランタイムを選びます。`--port` を付けた場合、インストールは移植版ランタイムで実行します。

```bash
OV_PORT_BASE=5270 node test/e2e/harness.mjs \
  'mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node; node -p process.versions.node'
HEADED=1 node test/e2e/project.mjs ~/sites/blog 'npm install && npm run build'
node test/e2e/watch.mjs --mount ~/sites/blog 'npm run dev' 60
```

## Node のテストスイート

`test/node-compat/run.mjs` は、Node.js 自身の `test/parallel` のテストを OpenVessel の中で実行し、本物の Node の結果と比較します。数値の意味と現在の結果は [互換性](../compatibility.ja.md) のページにあります。

### テストの取得

`node test/node-compat/fetch.mjs` は、`nodejs/node` のタグ `v<NODE_VERSION>` を `test/node-compat/.node/` に sparse clone します（`git clone --depth 1 --filter=blob:none --sparse`）。チェックアウトするのは `test/common`・`test/parallel`・`test/fixtures` だけです。すでにチェックアウトがあれば、固定したタグに切り替えます。リポジトリの `"type": "module"` が Node の CommonJS のテストに適用されないよう、`.node/package.json` を `{ "private": true, "type": "commonjs" }` として書き込みます。

### テストの選択

ファイル名から `test-` と拡張子 `.js`／`.mjs` を除いた部分が、次のモジュール名のいずれかと一致するか、モジュール名に `-` が続く形で始まるテストを選びます（最も長く一致するものを採用）: `fs`・`path`・`events`・`event-emitter`・`eventemitter`・`stream`・`stream2`・`stream3`・`readable`・`buffer`・`util`・`worker`・`crypto`・`child-process`・`url`・`whatwg-url`・`string-decoder`・`zlib`・`timers`・`process`・`module`・`require`・`readline`・`os`・`querystring`・`assert`・`abortcontroller`・`console`・`vm`・`async-local-storage`・`next-tick`・`promises`・`microtask`・`queue-microtask`・`wasi`。

選ばれたテストでも、ソースに次のいずれかを含むものはスキップします: `expose-internals`／`expose_internals`・`internalBinding`・`--expose-gc`・`common/inspector`・`--inspect`・`--cpu-prof`・`--heap-prof`・`--prof`・`--trace-`・`--report`・`--diagnostic`・`--allow-natives-syntax`・`--max-old-space`・`--abort-on-uncaught`・`common/sea`・`common/v8`・`v8.setFlagsFromString`・`--experimental-permission`・`--permission`・`process.binding`・`--snapshot`・`--build-snapshot`・`--frozen-intrinsics`・`--icu`・`common/shared-lib-util`・`common/wpt`・`common/benchmark`・`common/debugger`・`--watch`。

### フラグ

| 実行方法 | 処理 |
|---|---|
| `node test/node-compat/run.mjs --baseline [prefix…]` | 選んだテストを本物の Node で実行し（`npx -y node@<NODE_VERSION>`、8 本ずつ並行、cwd は `.node/`、`NODE_TEST_DIR` は未設定、1 本 30 秒で `SIGKILL`）、`results/baseline.json` に書き込む |
| `node test/node-compat/run.mjs [--port] [prefix…]` | OpenVessel の中で実行して結果を書き込み、レポートを表示する |
| `node test/node-compat/run.mjs [--port] --report` | 保存済みの結果からレポートだけを作り直す |
| `--port` | 移植版ランタイムで実行し、結果を `results/` ではなく `results/port/` に保存する（公開している数値は `results/port/` のもの）。付けない場合、ハーネスは `/etc/openvessel/node` に `legacy` を書き込み、旧ランタイムで実行する |
| `prefix…` | それ以外の引数。ファイル名が `test-<prefix>` で始まるテストだけに絞る |

### 実行の流れ

- `results/baseline.json` がある場合は、そこで成功したテストだけを実行します。選ばれたテストのうちベースラインに無いものは、`--baseline` を実行し直すまで実行しません。その場合、実行の最初に `warning: <n> selected tests are not in results/baseline.json and are skipped (run --baseline to add them): <ファイル>` と表示します。
- ハーネスは VFS の `/node` に、`package.json`、`test/common` と `test/fixtures` の 8 MiB までのファイルすべて、選んだテストをマウントします。ページでの評価 1 回あたり約 4 MB ずつ送ります。
- ポリシーを `allow-all` にし、`window.ovNoAutoPreview` を設定して、テストが listen するポートのプレビューをプレイグラウンドが開かないようにします。
- 1 つのページで 4 本ずつ並行して、それぞれ `node test/parallel/<file>` を cwd `/node`・`TEST_THREAD_ID=<0〜3>` で実行します。こうすると、Node のテストランナーと同様に、`test/common/tmpdir.js` がスロットごとに別の `.tmp.<id>` を使います。1 本あたり 30 秒で `SIGKILL` し、ハーネスはさらに 3 秒待ちます。ページでの評価には、さらに 15 秒の余裕を持たせます。
- `limits/` に載っているテストは最後に実行します（ブラウザをクラッシュさせるものがあるためです）。ブラウザがクラッシュした場合は、実行中だったテストのためにブラウザを 1 回だけ起動し直し（OS の一時ディレクトリに使い捨てのプロファイルを作る。最大 5 回試行）、そのテストをもう一度だけ実行します。
- 出力に `1..0 # Skipped` を含むテストは、成功ではなくスキップとして数えます。
- 結果は 25 本ごと（進捗の行 `<done>/<total> (<pass> pass so far, <s>s)` も表示）と最後に書き込みます。ファイルにある以前の結果は残すので、異なる prefix で実行した結果が蓄積されます。

### 結果

| ファイル | 内容 |
|---|---|
| `results/baseline.json` | 本物の Node での `{ "<テストファイル>": { pass, skipped, code } }`（`code` は終了コードまたはシグナル） |
| `results[/port]/ov.json` | `{ "<テストファイル>": { mod, pass, skipped, code, timedOut, ms, error } }`。`code` が −1 ならタイムアウトまでに終了しなかったこと、−2 ならハーネスのエラーを表す。`error` は `TIMEOUT` か、最初のエラーの行 |
| `results[/port]/logs/<テストファイル>.log` | テストの出力の末尾 20000 文字 |
| `results[/port]/REPORT.md` | レポート |

`test/node-compat/results/` は git の管理外です。

レポートでは、`ov.json` にあるテストのうち本物の Node で成功したものを、モジュールごとに数えます。

| 列 | 意味 |
|---|---|
| `pass` | OpenVessel で成功した数（`limits/` のテストは除く） |
| `target` | total から `limits` を引いた数 |
| `%` | pass ÷ target |
| `limits`・`total` | `limits/` に載っているテスト・数えたテストの総数 |
| `crash` | 予期しない例外で失敗した |
| `value` | アサーションが異なる結果を検出した |
| `timeout` | 応答が無くなった（30 秒） |
| `shape` | エラーの `code`／`message`／`name`／`errno`／`syscall`、または引数の検証だけが異なる（「Missing expected exception」もここに入る） |

表の下には、失敗を種類ごと、さらに最初のエラーの行ごと（数値と引用符内の文字列は正規化する）にまとめ、1 グループにつき 8 ファイルまで載せます。`limits/` に載っているのに成功したテストは **Listed as limits but passing** として表示するので、一覧から外すことができます。

### limits/*.json

`test/node-compat/limits/<module>.json` には、ブラウザでは成功しようがないテストを理由とともに記載します。各ファイルはテストのファイル名から理由の文への対応を表す 1 つの JSON オブジェクトで、すべてのファイルをマージして使います。

```json
{
  "test-process-env-tz.js": "Date's local time zone is the browser's, fixed for the page by its JS engine; setting process.env.TZ can't change it at runtime (Node calls tzset() and tells V8 to re-detect it)."
}
```

現在あるファイル: `assert`・`async-local-storage`・`buffer`・`child-process`・`crypto`・`fs`・`process`・`stream`・`vm`・`worker`。

## Astro のコーパス

`corpus/` には、E2E テストに使う実在の Astro サイトの一覧があります。

### corpus/sites.json

サイトの配列です。公式の examples は次の形です。

```json
{ "id": "astro-5-examples__blog", "repo": "withastro/astro", "ref": "astro@5.18.2", "path": "examples/blog", "astro": 5 }
```

コミュニティのサイトは、`id`（`<owner>__<repo>`）・`repo`・`ref`（デフォルトブランチ）・`sha`（ダウンロードしたコミット。記録するようになる前に集めたサイトは `null`）・`astro`（メジャーバージョン）・`stars` を持ちます。各サイトのファイルは `corpus/sites/<id>/` にあります（git の管理外。後述の `--restore` を参照）。

### corpus/collect.mjs

`node corpus/collect.mjs [target=100] [majors=5,6,7]` を実行するには、ログイン済みの `gh` が必要です。一覧が `target` 件になるまで、次の順にサイトを追加します。

1. Astro のリリースタグ `astro@7.4.2`・`astro@6.4.8`・`astro@5.18.2` の `examples/*` のうち、`build` スクリプトと `astro.config.*` があるもの（ID は `astro-<major>-examples__<name>`）
2. GitHub の検索（`topic:astro-theme`・`topic:astro-template`・`topic:astro-blog`・`topic:astro language:Astro`・`astro theme in:name,description language:Astro`・`astro portfolio language:Astro`・`starlight docs language:MDX`。いずれも `pushed:>2025-03-01` を付け、スター数の多い順に 50 件ずつ最大 5 ページ）で見つかったコミュニティのリポジトリ。アーカイブ済み、fork、200 MB を超えるもの、`build` スクリプトが無いもの、`astro` の依存のメジャーバージョンが `majors` に含まれないもの、ルートに `astro.config.*` が無いものはスキップする。ダウンロードするのはデフォルトブランチの現在のコミットで、それを `sha` に記録する

`astro.config.*` の無いディレクトリはサイトではない（`examples/toolbar-app` はツールバーのインテグレーション）ので、追加しません。`sites.json` はサイトを 1 件追加するたびに書き直します。`sites.json` にすでにある ID はスキップするので、この使い方ではサイトが増えるだけです。

`node corpus/collect.mjs --restore` は、一覧にあって `corpus/sites/` に無いサイトをすべてダウンロードします（clone した直後なら全サイト）。公式の examples はリリースタグごとに 1 つの tarball から、コミュニティのサイトは `sha` のコミットから取得します。`sha` が `null` の場合は `ref` の現在の先頭を取得するので、結果を計測したときのファイルと異なることがあります。最後に `<restored> of <missing> missing sites restored (<listed> listed)` と表示し、失敗があれば終了コード 1 で終了します。`corpus/sites/` にあっても `sites.json` に載っていないディレクトリは、そのまま残し、実行もしません。

### corpus/run.mjs

`node corpus/run.mjs [--legacy] [filter…]` は、ID にいずれかの filter を含むサイト（filter が無ければ全サイト）について、次の処理を行います。

1. プレイグラウンドを再読み込みし（新しいカーネルになる）、`corpus/sites/<id>` を `/home/user/app` にマウントする
2. パッケージマネージャを決める。`package.json` の `packageManager` フィールド（`npm`・`pnpm`・`yarn`・`bun`）があればそれを使い、無ければ `pnpm-lock.yaml` → pnpm、`yarn.lock` → yarn、`bun.lock`／`bun.lockb` → bun、どれも無ければ npm
3. `<pm> install` を実行し、成功すれば `<pm> run build` を実行する。どちらも `export CI=1 ASTRO_TELEMETRY_DISABLED=1`（`--legacy` のときは旧ランタイムを選ぶ行も）を付け、タイムアウトは 15 分

ハーネス自体が失敗した場合は、ブラウザを起動し直して次のサイトに進みます。

結果は `corpus/results/port/`（既定の移植版ランタイム）に、`--legacy` のときは `corpus/results/` に書き込みます。次のパスの `[/port]` は、この違いを表します。

- `corpus/results[/port]/results.json`: `{ "<id>": { id, astro, install, build, ms, error } }`。`install`／`build` は真偽値で、インストールに失敗したときは `build` が `null` のままです。`error` には、ビルドの出力の空でない最後の 12 行、またはインストールの出力の最後の 8 行が入ります。
- `corpus/results[/port]/logs/<id>.log`: `$ <pm> install`・その出力・`[exit <code> <ms>ms]` に続けて、ビルドについて同じものが入ります。

`results.json` の既存の項目は残し、サイトごとに上書きします。サイトごとに `[<i>/<n>] OK|FAIL|INST <id> (<s>s)`（FAIL はビルドの失敗、INST はインストールの失敗）と最後のエラーの行を表示し、最後に `build ok: <x>/<total>, install ok: <y>` と表示します。`corpus/results/logs/` と `corpus/results/port/` は git の管理外です。

## テストの追加

- 単体テスト: `node:test` と `node:assert/strict` を使って `test/unit/<name>.test.ts` を追加します。ファイル名の末尾で自動的に対象になります。ソースは直接 import し（`../../src/…`）、npm パッケージは external のままです。
- バインディングの差分テスト: `{ 区分: [{ args, r }] }` を返す `run(binding)` をエクスポートする `test/fixtures-gen/<name>.cases.mjs` と、`generate('<バインディング名>', run)` を呼ぶジェネレーター `test/fixtures-gen/<name>.mjs` を書きます。`scripts/regen-fixtures.mjs` にジョブを追加して実行し、`compareFixtures(run(createX()), fixture.results, known)` を呼ぶ `test/unit/bindings-<name>.test.ts` を書きます。許容する差異は、理由をキーにして `known` に並べます。
- E2E のチェック: `harness.mjs` の `startServer`・`openBrowser`・`exec` を使うスクリプトを `test/e2e/` に書きます。既定では移植版ランタイムで動きます（旧ランタイムで動かすときは `useLegacyRuntime(page)`）。`port-fs.mjs` や `preview-port.mjs` と同じように、結果をわかりやすく表示し、失敗したら 0 以外で終了するようにします。
- ブラウザでは成功しようがない Node のテスト: 理由を添えて `test/node-compat/limits/<module>.json` に追加します。以後は target に数えません。レポートで成功と表示されたら一覧から外します。
- コーパスのサイト: `corpus/collect.mjs` を実行するか、`corpus/sites.json` に項目を追加してファイルを `corpus/sites/<id>/` に置きます。

## 関連するページ

- [ビルド](building.ja.md): 前提条件、Node のバージョンアップの手順の中の `regen-fixtures.mjs`
- [バインディング](bindings.ja.md): 差分テストが比較するもの
- [互換性](../compatibility.ja.md): 現在の結果
