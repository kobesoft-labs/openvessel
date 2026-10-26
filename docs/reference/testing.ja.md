# 試験

[English](testing.md)

OpenVessel の試験には 4 つの層があります。Node.js で動かす単体の試験（バインディングを本物の Node と突き合わせる差分の試験を含む）、ヘッドレスの Chrome でプレイグラウンドを動かす端から端までの試験、OpenVessel の中で動かす Node.js 自身の試験、本物の Astro のサイトのコーパスです。このページは、それぞれを動かす道具・引数・環境変数・時間の上限・結果のファイルと、試験の足し方を説明します。

| 試験 | 動かす道具 | 要るもの | よく使うコマンド |
|---|---|---|---|
| 単体 | `scripts/test.mjs` | Node.js | `npm test` |
| 端から端まで | `test/e2e/*.mjs` | ビルド（`dist/`）・Google Chrome | `node test/e2e/harness.mjs 'node -v'` |
| Node の試験 | `test/node-compat/run.mjs` | ビルド・Chrome・`test/node-compat/.node/` | `node test/node-compat/run.mjs --port fs` |
| Astro のコーパス | `corpus/run.mjs` | ビルド・Chrome・`corpus/sites/`・通信 | `node corpus/run.mjs basics` |

ブラウザを使う試験を流している間は、`dist/` をビルドし直さないでください。走っている試験が、古いファイルと新しいファイルの混ざったものを読み込みます。

## 環境変数

| 変数 | 読むもの | 効き目 |
|---|---|---|
| `OV_PORT_BASE` | `scripts/serve.mjs`・`test/e2e/harness.mjs` | 3 つのサーバーのポートが 基準・基準 + 1・基準 + 2 になり（既定 5170）、ブラウザのプロファイルが `node_modules/.cache/ov-chrome-<基準>`（5170 なら `ov-chrome`）になる。そのため複数の試験を並べて流せる |
| `OV_HOST_PORT`・`OV_RUNTIME_PORT`・`OV_PREVIEW_PORT` | `scripts/serve.mjs` | ポートを 1 つずつ決める。試験の道具は `OV_PORT_BASE` しか知らないので、試験のスクリプトと一緒には使わない |
| `HEADED` | `harness.mjs`（直接使うとき）・`project.mjs`・`dev.mjs`・`preview-port.mjs` | 空でなければブラウザの窓を出す |
| `OV_CONSOLE` | `harness.mjs` | 空でなければ、ページの console のメッセージを `[console.<type>] <text>` と出す（ページのエラーはいつも `[pageerror] …` と出す） |
| `OV_TRACE` | `harness.mjs` | 空でなければカーネルのトレース（`debug.trace`）を入れる。起動・パイプを閉じる・読みの EOF・fd 0 の同期の読みのたびに `[trace]` の行を console に出す。`OV_CONSOLE=1` で見える |
| `SETUP` | `run-file.mjs` | ファイルを書く前に流すコマンドライン |
| `PRINT` | `port-fs.mjs` | 空でなければ、どの場面も実際の出力を出す |
| `OV_TIMING` | 移植版ランタイム | ホストではなく OpenVessel の中で使う。起動の時間を出す（[Node.js ランタイム](nodejs-runtime.ja.md#ov_timing)） |

## 単体の試験

`npm test` は `scripts/test.mjs` を動かします。

1. `test/unit/*.test.ts` を集めます（最初の引数を渡すと、名前にそれを含むファイルだけにする: `npm test -- zlib`）。
2. esbuild で `node_modules/.cache/ov-tests/*.mjs` に束ねます（`platform: 'node'`・ESM・`target: 'node22'`・ソースマップは埋め込み・npm のパッケージは外のまま）。ディレクトリは先に消します。
3. `node --enable-source-maps --test <ファイル>` を実行し、その終了コードで終わります。

| ファイル | 試すもの |
|---|---|
| `bindings-*.test.ts` | 本物の Node から取った記録と、バインディングを比べる。[バインディング](bindings.ja.md#バインディングを本物の-node-と突き合わせる) を参照 |
| `bindings-v8.test.ts` | `internalBinding('v8')` が `lib/v8.js` の読むバッファを埋めること、`heap_utils` がスナップショットを使えないと報告すること |
| `npm-wasm-runtime.test.ts` | `pickWasmRuntime`（バインディングと emnapi の peer が合う `@napi-rs/wasm-runtime` を選ぶ） |
| `policy.test.ts` | 通信の方針の `decide`／`normalizePolicy`（セット・ask・allowlist・deny が勝つ・外へ出るのは http(s) だけ） |
| `resolve.test.ts` | モジュールの解決（CJS の探し方・`exports` の条件とパターン・`imports`・クエリ文字列） |
| `semver.test.ts` | npm のクライアントの semver（範囲・プレリリース・`maxSatisfying`・`minVersion`） |
| `sh.test.ts` | Worker の無いカーネルの上のシェルと coreutils（`helpers.ts` の `makeKernel()`・`run()`） |

手伝いのファイル: `helpers.ts`（`sh`・`bash`・coreutils を登録した `Kernel`。`run(kernel, script, cwd, argv)` は `{ stdout, stderr, code }` を返す）、`binding-fixtures.ts`（`compareFixtures`）、`zlib-loop-shim.ts`（`bindings-zlib.test.ts` が最初に読み込む。イベントループの `MessageChannel` が試験のプロセスを生かし続けないようにする）。

### 記録の取り直し

`node scripts/regen-fixtures.mjs [name…]` は、固定した版の Node を `npx -y node@<version> -p process.execPath` で探し、記録を作るスクリプトをそれぞれ `--expose-internals --no-warnings` で動かします。ジョブごとに `<name>… ok`、最後に `fixtures recorded from node v<version>` と出します。ジョブは `encoding`・`string_decoder`・`url`・`icu`・`icu-width-table`・`http_parser`・`zlib`・`serdes`・`histogram`・`crypto`・`crypto-asym`・`crypto-tables` です。記録を作るスクリプトは、どれもほかの版の Node では動きません（`run with node@<version> (got <version>)`）。

## 端から端までの試験

`test/e2e/` のスクリプトは、どれも `harness.mjs` を使います。`scripts/serve.mjs` を起こし（`OV_PORT_BASE` に従う）、手元の Chrome を `playwright-core` で起動し（`channel: 'chrome'`・残るプロファイル・`--js-flags=--stack-size=4000`）、`http://localhost:<基準>/` のプレイグラウンドを開き、`window.ovReady` を待って、プレイグラウンドの `window.ov`（`OpenVessel` のインスタンス）を使います。プレイグラウンドは `/home/user/app` に Astro 5 の見本のプロジェクトを置きます。コマンドが `/etc/openvessel/node` に `legacy` を書き込まない限り、移植版ランタイムで動きます（[Node.js ランタイム](nodejs-runtime.ja.md#ランタイムの選び方) を参照）。

`harness.mjs` が出す関数:

| 関数 | すること |
|---|---|
| `startServer()` | `scripts/serve.mjs` を起こし、何か出力したら解決する |
| `openBrowser({ headless = true, profile })` | Chrome を起動し、プレイグラウンドを開き、`ovReady` を待つ。`OV_CONSOLE`・`OV_TRACE` が効く |
| `exec(page, cmd, { cwd = '/home/user/app', timeout = 600000, allowAll = true })` | 通信の方針を `allow-all` にし（`allowAll: false` でなければ）、`ov.exec(cmd, { cwd })` を実行し、`{ code, output, ms }` を返す |
| `useLegacyRuntime(page)` | `/etc/openvessel/node` に `legacy` を書き込み、そのあとに起動する node のプロセスを旧ランタイムで動かす |
| `usePortedRuntime(page)` | `/etc/openvessel/node` に `port` を書き込む。移植版ランタイムは既定なので、選択を明示するだけ |

| スクリプト | 引数 | すること |
|---|---|---|
| `harness.mjs` | `[コマンド]`（既定は `echo hello; node -e "console.log(process.version)"`） | コマンドラインを 1 つ実行し、出力と `[exit <code> in <ms>ms]` を出す |
| `run-file.mjs` | `<手元のファイル> <VFS のパス> '<コマンド>'` | `SETUP` があれば流し、手元のファイルを VFS に書いて、コマンドを実行する |
| `watch.mjs` | `[--mount <dir>] '<コマンド>' [秒=20]` | `/bin/sh -c <コマンド>` を起こし（cwd は `/home/user`。`--mount` では先に手元のプロジェクトを写した `/home/user/app`）、200 ms ごとに出力を流す。終われば `[exit <code>]`、時間切れなら `[still running after <n>s] ps:` とプロセスの一覧を出す |
| `project.mjs` | `<dir> ['<コマンド>']`（既定は `npm install && npm run build`） | `/home/user/app` を手元のプロジェクトで置き換え、コマンドを実行する（上限 15 分）。`node_modules`・`.git`・`dist`・`.astro`・`.vercel`・`.netlify`・`.cache`・`.turbo`・`.output` と 64 MiB を超えるファイルは飛ばし、シンボリックリンクは残す。`collectFiles()` と `mountProject()` を出す |
| `dev.mjs` | `[--legacy]` | `/home/user/app` で `npm install`、`npm run dev` を起こし、`server-ready` を待ち、プレビューの `<h1>` を確かめ、`src/pages/index.astro` を書き換えて、HMR での更新を 30 秒まで待つ |
| `preview-port.mjs` | — | 移植版ランタイムで、ポート 4000 に `http` のサーバーを立て、プレビューの iframe に読み込み（70000 バイトの分割された本文）、iframe から POST する。`OK` か `FAIL` を出し、0／1 で終わる |
| `port-fs.mjs` | `[場面…]` | 移植版ランタイムで、fs の場面 `dir`・`watch`・`watch2`・`cp`・`cp2`・`misc`・`misc2`（opendir と Dir・`fs.watch`・`fs.watchFile`・`fs.cp`／`cpSync`・readv／writev・FileHandle）を流し、それぞれの出力を Linux の Node v22.23.4（Docker の `node:22.23.4-bookworm-slim`）で記録した期待の出力と比べる。`ok`／`FAIL` と行の差分、`all passed` か `<n> failed` を出し、0／1 で終わる |
| `esm-graph.mjs` | `[--port] <プロジェクトのディレクトリ> <VFS の入口のパス> [インストールのコマンド='npm install']` | プロジェクトを置いてインストールし、カーネルが `/__ov/esm` で配る ES モジュールのグラフ（旧ランタイムの ESM の配信）をたどって、読み込めないモジュールを報告する |
| `debug-esm.mjs` | `[--port] <VFS のパス…>` | `npm install` のあと、それぞれのパスについて `/__ov/esm<パス>` の最初の 3000 文字を出す |

`dev.mjs` は移植版ランタイムで動きます。`--legacy` を付けると、何かを動かす前に `harness.mjs` の `useLegacyRuntime(page)` で旧ランタイムに切り替えます。`esm-graph.mjs` と `debug-esm.mjs` は逆で、読み出す ESM の配信を使うのが旧ランタイムだけなので、`--port` を付けない限り `useLegacyRuntime(page)` で旧ランタイムを選びます。`--port` を付けると、インストールは移植版ランタイムで動きます。

```bash
OV_PORT_BASE=5270 node test/e2e/harness.mjs \
  'mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node; node -p process.versions.node'
HEADED=1 node test/e2e/project.mjs ~/sites/blog 'npm install && npm run build'
node test/e2e/watch.mjs --mount ~/sites/blog 'npm run dev' 60
```

## Node の試験

`test/node-compat/run.mjs` は、Node.js 自身の `test/parallel` の試験を OpenVessel の中で動かし、本物の Node と比べます。数字の意味といまの結果は [互換性](../compatibility.ja.md) のページにあります。

### 試験を取ってくる

`node test/node-compat/fetch.mjs` は、`nodejs/node` のタグ `v<NODE_VERSION>` を `test/node-compat/.node/` に一部だけ clone します（`git clone --depth 1 --filter=blob:none --sparse`）。取り出すのは `test/common`・`test/parallel`・`test/fixtures` だけです。すでにあれば、固定した版のタグに移します。リポジトリの `"type": "module"` が Node の CommonJS の試験に効かないよう、`.node/package.json` を `{ "private": true, "type": "commonjs" }` にします。

### 選び方

試験は、ファイル名から `test-` と拡張子 `.js`／`.mjs` を除いたものが、次のモジュールの名前のどれかと同じか、その名前に `-` が続くもので始まるときに選ばれます（いちばん長く合うものを使う）: `fs`・`path`・`events`・`event-emitter`・`eventemitter`・`stream`・`stream2`・`stream3`・`readable`・`buffer`・`util`・`worker`・`crypto`・`child-process`・`url`・`whatwg-url`・`string-decoder`・`zlib`・`timers`・`process`・`module`・`require`・`readline`・`os`・`querystring`・`assert`・`abortcontroller`・`console`・`vm`・`async-local-storage`・`next-tick`・`promises`・`microtask`・`queue-microtask`・`wasi`。

選ばれた試験でも、ソースが次のどれかを含むものは飛ばします: `expose-internals`／`expose_internals`・`internalBinding`・`--expose-gc`・`common/inspector`・`--inspect`・`--cpu-prof`・`--heap-prof`・`--prof`・`--trace-`・`--report`・`--diagnostic`・`--allow-natives-syntax`・`--max-old-space`・`--abort-on-uncaught`・`common/sea`・`common/v8`・`v8.setFlagsFromString`・`--experimental-permission`・`--permission`・`process.binding`・`--snapshot`・`--build-snapshot`・`--frozen-intrinsics`・`--icu`・`common/shared-lib-util`・`common/wpt`・`common/benchmark`・`common/debugger`・`--watch`。

### フラグ

| 呼び方 | すること |
|---|---|
| `node test/node-compat/run.mjs --baseline [prefix…]` | 選んだ試験を本物の Node で動かし（`npx -y node@<NODE_VERSION>`、8 本ずつ、cwd は `.node/`、`NODE_TEST_DIR` は外す、1 本 30 秒で `SIGKILL`）、`results/baseline.json` に書く |
| `node test/node-compat/run.mjs [--port] [prefix…]` | OpenVessel の中で動かして結果を書き、報告を出す |
| `node test/node-compat/run.mjs [--port] --report` | 取ってある結果から報告だけを作り直す |
| `--port` | 移植版ランタイムで動かし、結果を `results/` ではなく `results/port/` に置く（公開している数字は `results/port/` のもの）。付けないときは `/etc/openvessel/node` に `legacy` を書き込み、旧ランタイムで動かす |
| `prefix…` | ほかの引数: ファイル名が `test-<prefix>` で始まる試験だけにする |

### 流れ

- `results/baseline.json` があれば、そこで通った試験だけを動かします。選んだ試験のうち基準に無いものは、`--baseline` を流し直すまで動きません。そのときは最初に `warning: <n> selected tests are not in results/baseline.json and are skipped (run --baseline to add them): <ファイル>` と出します。
- VFS の `/node` に、`package.json`、`test/common` と `test/fixtures` の 8 MiB までのファイル全部、選んだ試験を置きます。ページの評価 1 回あたり約 4 MB ずつ送ります。
- 通信の方針を `allow-all` にし、`window.ovNoAutoPreview` を立てて、試験が listen するポートのプレビューをプレイグラウンドが開かないようにします。
- 1 つのページで 4 本ずつ、それぞれ `node test/parallel/<file>` を cwd `/node`・`TEST_THREAD_ID=<0〜3>` で動かします（`test/common/tmpdir.js` が、Node の試験の道具と同じく、枠ごとに自分の `.tmp.<id>` を使うように）。1 本 30 秒で `SIGKILL` し、さらに 3 秒待ち、ページの評価にはさらに 15 秒の余裕を持たせます。
- `limits/` に載っている試験は最後に流します（ブラウザを落とすものがあるため）。ブラウザが落ちたら、走っていた試験すべてのために 1 回だけ起動し直し（OS の一時ディレクトリの使い捨てのプロファイルで。5 回まで試す）、その試験をもう 1 回だけ流します。
- 出力に `1..0 # Skipped` があれば、通ったのではなく飛ばしたものと数えます。
- 結果は 25 本ごと（進み具合の行 `<done>/<total> (<pass> pass so far, <s>s)` も出す）と最後に書きます。ファイルにある前の結果は残すので、別の prefix で流した結果は積み重なります。

### 結果

| ファイル | 中身 |
|---|---|
| `results/baseline.json` | 本物の Node での `{ "<試験のファイル>": { pass, skipped, code } }`（`code` は終了コードかシグナル） |
| `results[/port]/ov.json` | `{ "<試験のファイル>": { mod, pass, skipped, code, timedOut, ms, error } }`。`code` の −1 は時間内に終わらなかった、−2 は道具の側のエラー。`error` は `TIMEOUT` か最初のエラーの行 |
| `results[/port]/logs/<試験のファイル>.log` | 試験の出力の最後の 20000 文字 |
| `results[/port]/REPORT.md` | 報告 |

`test/node-compat/results/` は git の外です。

報告は、モジュールごとに、`ov.json` にある試験のうち本物の Node で通ったものを数えます。

| 列 | 意味 |
|---|---|
| `pass` | OpenVessel で通った（`limits/` の試験は除く） |
| `target` | 全体から `limits` を引いたもの |
| `%` | pass ÷ target |
| `limits`・`total` | `limits/` に載っている試験・数えた試験の全部 |
| `crash` | 思わぬ例外で落ちた |
| `value` | アサーションが違う結果を見つけた |
| `timeout` | 止まった（30 秒） |
| `shape` | エラーの `code`／`message`／`name`／`errno`／`syscall` か、引数の確かめだけが違う（「Missing expected exception」もここ） |

表の下には、失敗を種類ごと、最初のエラーの行ごと（数と引用符の中身はならす）にまとめ、1 つの組につき 8 個までファイルを挙げます。`limits/` に載っているのに通った試験は **Listed as limits but passing** として挙げるので、一覧から外せます。

### limits/*.json

`test/node-compat/limits/<module>.json` は、ブラウザでは通らない試験を、それぞれの理由とともに挙げます。ファイルはどれも、試験のファイル名から理由の文への 1 つの JSON のオブジェクトで、全部のファイルを合わせて使います。

```json
{
  "test-process-env-tz.js": "Date's local time zone is the browser's, fixed for the page by its JS engine; setting process.env.TZ can't change it at runtime (Node calls tzset() and tells V8 to re-detect it)."
}
```

いまあるファイル: `assert`・`async-local-storage`・`buffer`・`child-process`・`crypto`・`fs`・`process`・`stream`・`vm`・`worker`。

## Astro のコーパス

`corpus/` には、端から端までの試験に使う本物の Astro のサイトの一覧があります。

### corpus/sites.json

サイトの配列です。公式の examples:

```json
{ "id": "astro-5-examples__blog", "repo": "withastro/astro", "ref": "astro@5.18.2", "path": "examples/blog", "astro": 5 }
```

コミュニティのサイトは、`id`（`<owner>__<repo>`）・`repo`・`ref`（既定のブランチ）・`sha`（取ってきたコミット。記録するようになる前に集めたサイトは `null`）・`astro`（メジャーの版）・`stars` を持ちます。各サイトのファイルは `corpus/sites/<id>/` にあります（git の外。下の `--restore` を参照）。

### corpus/collect.mjs

`node corpus/collect.mjs [target=100] [majors=5,6,7]` は、ログイン済みの `gh` が要ります。一覧が `target` 件になるまでサイトを足します。

1. Astro のリリースのタグ `astro@7.4.2`・`astro@6.4.8`・`astro@5.18.2` の `examples/*` のうち、`build` のスクリプトと `astro.config.*` があるもの（ID は `astro-<major>-examples__<name>`）
2. GitHub の検索（`topic:astro-theme`・`topic:astro-template`・`topic:astro-blog`・`topic:astro language:Astro`・`astro theme in:name,description language:Astro`・`astro portfolio language:Astro`・`starlight docs language:MDX`。どれも `pushed:>2025-03-01` を付け、星の多い順に 50 件ずつ 5 ページまで）で見つけたリポジトリ。アーカイブ済み・fork・200 MB を超えるもの・`build` のスクリプトが無いもの・`astro` の依存のメジャーの版が `majors` に無いもの・いちばん上に `astro.config.*` が無いものは飛ばす。取るのは既定のブランチのいまのコミットで、それを `sha` に記録する

`astro.config.*` の無いディレクトリはサイトではない（`examples/toolbar-app` はツールバーの拡張）ので、足しません。`sites.json` は、1 件足すたびに書き直します。`sites.json` にすでにある ID は飛ばすので、この呼び方はサイトを足すだけです。

`node corpus/collect.mjs --restore` は、一覧にあって `corpus/sites/` に無いサイトをすべて取ってきます（取ってきたばかりのリポジトリなら全部）。公式の例はリリースのタグごとに 1 つの tarball から、コミュニティのサイトは `sha` のコミットから取ります（`sha` が `null` なら `ref` のいまの先頭なので、結果を計ったときのファイルと違うことがあります）。`<取れた数> of <無かった数> missing sites restored (<一覧の数> listed)` と出し、失敗があれば 1 で終わります。`corpus/sites/` にあって `sites.json` に無いディレクトリはそのまま残し、流しません。

### corpus/run.mjs

`node corpus/run.mjs [--legacy] [filter…]` は、ID がどれかの filter を含むサイト（filter が無ければ全部）について、次を行います。

1. プレイグラウンドを読み直し（新しいカーネル）、`corpus/sites/<id>` を `/home/user/app` に置く
2. パッケージマネージャを選ぶ: `package.json` の `packageManager`（`npm`・`pnpm`・`yarn`・`bun`）、無ければ `pnpm-lock.yaml` → pnpm、`yarn.lock` → yarn、`bun.lock`／`bun.lockb` → bun、それ以外は npm
3. `<pm> install`、通れば `<pm> run build`。どちらも `export CI=1 ASTRO_TELEMETRY_DISABLED=1`（`--legacy` では旧ランタイムを選ぶ行も）を付け、上限は 15 分

道具そのものが失敗したときは、ブラウザを起動し直して次のサイトへ進みます。

結果は `corpus/results/port/`（既定の移植版ランタイム）に、`--legacy` のときは `corpus/results/` に書き込みます。
下の表の `[/port]` は、この違いを表しています。

| 出力 | 中身 |
|---|---|
| `corpus/results[/port]/results.json` | `{ "<id>": { id, astro, install, build, ms, error } }`。`install`／`build` は真偽値（install が失敗したとき `build` は `null` のまま）。`error` はビルドの出力の空でない最後の 12 行、またはインストールの出力の最後の 8 行 |
| `corpus/results[/port]/logs/<id>.log` | `$ <pm> install`・その出力・`[exit <code> <ms>ms]`、続けてビルドの同じもの |

`results.json` にある項目は残し、サイトごとに上書きします。サイトごとに `[<i>/<n>] OK|FAIL|INST <id> (<s>s)`（FAIL はビルドの失敗、INST はインストールの失敗）と最後のエラーの行を出し、最後に `build ok: <x>/<total>, install ok: <y>` と出します。`corpus/results/logs/` と `corpus/results/port/` は git の外です。

## 試験の足し方

- **単体の試験**: `node:test` と `node:assert/strict` を使って `test/unit/<name>.test.ts` を足します。名前の末尾で拾われます。ソースは直接（`../../src/…`）import します。npm のパッケージは外のままです。
- **バインディングの差分の試験**: `{ 区分: [{ args, r }] }` を返す `run(binding)` を出す `test/fixtures-gen/<name>.cases.mjs` と、`generate('<バインディングの名前>', run)` を呼ぶ `test/fixtures-gen/<name>.mjs` を書き、`scripts/regen-fixtures.mjs` にジョブを足して流し、`compareFixtures(run(createX()), fixture.results, known)` を呼ぶ `test/unit/bindings-<name>.test.ts` を書きます。認める違いは、理由を名前にして `known` に並べます。
- **端から端までの確かめ**: `harness.mjs` の `startServer`・`openBrowser`・`exec` を使うスクリプトを `test/e2e/` に書きます。スクリプトは既定で移植版ランタイムで動きます（旧ランタイムで動かすときは `useLegacyRuntime(page)`）。`port-fs.mjs` や `preview-port.mjs` のように、結果をはっきり出し、失敗したら 0 以外で終わるようにします。
- **ブラウザでは通らない Node の試験**: 理由とともに `test/node-compat/limits/<module>.json` に足します。それ以後は target に数えません。報告が通ったと言えば外します。
- **コーパスのサイト**: `corpus/collect.mjs` を流すか、`corpus/sites.json` に項目を足し、ファイルを `corpus/sites/<id>/` に置きます。

## 関連するページ

- [ビルド](building.ja.md) — 要るもの、Node の版の追従の中の `regen-fixtures.mjs`
- [バインディング](bindings.ja.md) — 差分の試験が比べるもの
- [互換性](../compatibility.ja.md) — いまの結果
