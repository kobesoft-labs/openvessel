# Node.js ランタイム

[English](nodejs-runtime.md)

プロセスの Worker の中で Node.js がどう動くかの仕様です。ビルドに含まれる 2 つのランタイムとその選び方、移植版ランタイムの起動シーケンス、コマンドライン、環境、イベントループ、モジュールの読み込み、TypeScript、`fetch`、そして Node.js と意図的に動作を変えている箇所を扱います。
ブラウザではそもそも動かせないものと、テストの計測結果は [互換性](../compatibility.ja.md) にあります。

## 2 つのランタイム

`node` のプロセス（と `worker_threads` のスレッド）は、どれもカーネルが起動する Web Worker です。その Worker のスクリプトとして、ビルドには 2 種類が含まれています。

| | 移植版ランタイム | 旧ランタイム |
|---|---|---|
| Worker のスクリプト | `dist/runtime/node-process.js` | `dist/runtime/process.js` |
| ソース | `src/nodejs/`（エントリは `src/nodejs/boot.ts`） | `src/node/`（エントリは `src/node/worker.ts`） |
| 実行されるもの | Node.js v22.23.4 の `lib/` そのもの（`dist/runtime/nodelib.js` にバンドル）。C++ 側（`internalBinding()`）を TypeScript で実装し直している（[バインディング](bindings.ja.md) を参照） | 独自に実装した Node 互換のモジュール（`fs.ts`・`http.ts`・`module.ts` など） |
| コマンドライン | Node のオプションテーブルとパーサー（`src/nodejs/options.ts`）。未知のオプションはエラー | 独自の小さなパーサー。未知のオプションは無視 |
| TypeScript | Node 自身の型除去（amaro） | sucrase の `typescript` 変換（enum なども通る） |
| ES モジュール | `module_wrap` バインディング。`/__ov/mw/<pid>/<id>.mjs` で配信 | カーネルの ESM 配信（`/__ov/esm/…`・`/__ov/builtin/…`） |
| `--loader` | Node のフックの仕組み | 警告を出して無視 |
| `node:http2` | 読み込めて、サーバーも listen するが、セッションは `ERR_NOT_IMPLEMENTED`（`Http2Session`。[実装していないもの](#実装していないもの) を参照）で失敗する | `createServer()`・`createSecureServer()`・`connect()` が `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`（`HTTP/2 is not supported in OpenVessel`）を投げる |
| 既定 | はい | いいえ（`legacy` で選択） |

[互換性](../compatibility.ja.md) のページの数値（Node のテストスイートと Astro のコーパス）は、すべて移植版ランタイムで計測したものです。このページの以降の説明も、特に断りが無い限り移植版ランタイムについてのものです。

### ランタイムの選び方

カーネルは node のプログラムが起動するたび（新しいプロセスの起動時と `execve` のとき）に、使うスクリプトを選びます（`src/kernel/index.ts` の `processScript()`）。VFS に `/etc/openvessel/node` があり、その内容の前後の空白を除いたものがちょうど `legacy` なら `process.js` を、それ以外の場合（ファイルが無い、読めない、`port`、それ以外の文字列）は `node-process.js` を使います。
`port` は、移植版ランタイムが既定になる前にそれを明示的に選んでいた設定との互換性のために、現在も受け付けています。
選択はプロセスに記録されます。ファイルを書き込んだあとに起動したプログラムから適用され、実行中のプロセスには影響しません。プロセスの `worker_threads` のスレッドは、常にメインスレッドと同じランタイムを使います。

シェルから旧ランタイムに切り替えるには、次のようにします。

```sh
mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node
node -p 'process.version'      # ここから旧ランタイムで動く
rm /etc/openvessel/node        # 次のプロセスから移植版ランタイムに戻る
```

ホストのページからは次のようにします。

```ts
vessel.mount({ node: 'legacy' }, { path: '/etc/openvessel' });
```

カーネルはスクリプトの URL ごとに、`init` メッセージを待つ Worker を 2 つ事前に作成しておき（`WARM = 2`）、1 つ取り出すたびに補充します。そのため、プロセスのスクリプトの読み込みとコンパイルの大部分は、必要になる前に済んでいます。

## プロセスの Worker の起動

### `init` メッセージ

カーネルは `{ t: 'init', … }` を送ってスレッドを起動します（`src/nodejs/state.ts` の `InitMsg`）。

| 項目 | 意味 |
|---|---|
| `kind` | プロセスなら `'main'`、`worker_threads` のスレッドなら `'thread'` |
| `pid`・`ppid`・`tid` | プロセス ID・親プロセスの ID・カーネルのスレッド ID |
| `argv`・`env`・`cwd` | プロセスの引数・環境変数・作業ディレクトリ |
| `sab` | 同期システムコールに使う `SharedArrayBuffer` |
| `ttys` | fd 0〜2 のそれぞれについて、端末なら `{ cols, rows }`、そうでなければ `null` |
| `hostname` | カーネルのホスト名（`openvessel`） |
| `file`・`eval`・`evalType`・`execArgv`・`workerData`・`envData`・`port`・`name`・`threadId`・`envRings`・`trackUnmanagedFds`・`sharedEnv`・`resourceLimits` | ワーカースレッドのみ |

Worker はほかに次のメッセージを受け付けます。`{ t: 'ping', id }` には `{ t: 'pong', id }` を返します（カーネルはこれで、それ以前に送ったものがすべて処理されたことを確認します）。それ以外の `t` は、バインディングが登録したハンドラに渡します（`child-exit`・`signal`・`fd-data`・`fd-writable`・`tcp-accept`・`pipe-accept`・`udp-msg`・`watch`・`tls-peer`・`thread-exit`・`thread-gone`）。メッセージのプロトコル自体は [通信の形式](protocol.ja.md) で説明しています。

### 起動シーケンス

`src/nodejs/boot.ts` の `boot()` は、C++ の `node::CreateEnvironment` と `node::StartExecution` に相当する処理を行います。

1. init メッセージを保存し、システムコールのチャネルを接続します。メインスレッドの場合は、`--env-file` のファイルを読み込んでコマンドラインを解析します。コマンドラインが不正なら、エラーを 1 件ずつ `<argv0>: <エラー>` の形で出力し、終了コード 9 で終了します。`--version`／`-v` は `v22.23.4` を、`--v8-options` は V8 のオプション一覧を出力し、ほかに何も読み込まずに 0 で終了します。`Error.stackTraceLimit` を `--stack-trace-limit` の値（既定は 10）に設定します。
2. Worker の `unhandledrejection`・`rejectionhandled`・`error` のイベントリスナーを登録します。
3. グローバルの `Proxy` を、ターゲットとハンドラを記録するものに置き換えます（`util.types.isProxy` と `util.inspect(…, { showProxy: true })` を動かすため）。また、Map／Set のイテレーターを作るメソッドをラップします（`util.types.isMapIterator` とイテレーターのプレビューを動かすため）。どちらも Node の primordials がこれらを取り込む前に行います。
4. コンテキストごとのスクリプト `internal/per_context/primordials`・`internal/per_context/domexception`・`internal/per_context/messageport` を実行します。
5. バンドルした lib から `internalBinding('builtins')` を作成し、`process` オブジェクト（`version`・`versions`・`arch: 'x64'`・`platform: 'linux'`・`release`・`_rawDebug`・`env`）を作成します。
6. `internal/bootstrap/realm` を実行し、スタックトレースのフックを登録します（[スタックトレースとエラー](#スタックトレースとエラー) を参照）。
7. `internal/bootstrap/node` を実行し、続けて `internal/bootstrap/web/exposed-wildcard` と `internal/bootstrap/web/exposed-window-or-worker` を実行します（`config.noBrowserGlobals` は常に `false`）。
8. メインスレッドでは `internal/bootstrap/switches/is_main_thread` と `…/does_own_process_state` を、ワーカースレッドでは `…/is_not_main_thread` と `…/does_not_own_process_state` を実行します。
9. グローバルオブジェクトを Node と同じ形に整えます（[グローバルオブジェクト](#グローバルオブジェクト) を参照）。fetch が無効なとき（`--no-experimental-fetch`）は `WebAssembly.compileStreaming` と `instantiateStreaming` を削除します。V8 にこれらが存在するのは、Node が fetch と一緒に wasm のストリーミングを設定した場合だけだからです。
10. `--run` の場合は、メインスクリプトの代わりにパッケージのスクリプトを実行します（[--run](#--run) を参照）。それ以外の場合は、`--env-file` の変数のうち `process.env` にまだ無いものを設定し（watch モードでは設定せず、子プロセスが読み込む）、メインスクリプトを選んで、実行時の非同期 ID を 1 としたコールバックスコープの中で実行し、イベントループを開始します。

2〜10 のいずれかで例外が発生した場合、Worker は fd 2 に `[openvessel] node bootstrap failed: <スタック>` と書き込み、終了コード 10（`kBootstrapFailure`）で終了します。

メインスクリプトは `node::SelectLoadMode` と同じ方法で選びます。

| 条件（最初に一致したもの） | メインスクリプト |
|---|---|
| ワーカースレッド | `internal/main/worker_thread` |
| `--help` | `internal/main/print_help` |
| `--prof-process` | `internal/main/prof_process` |
| `-e`・`-p`・`--eval`・`--print`（`--interactive` なし） | `internal/main/eval_string` |
| `--check` | `internal/main/check_syntax` |
| `--test` | `internal/main/test_runner` |
| `--watch` | `internal/main/watch_mode` |
| `-` 以外のスクリプト引数がある | `internal/main/run_main_module` |
| `--interactive`、または fd 0 が端末 | `internal/main/repl` |
| それ以外 | `internal/main/eval_stdin` |

### nodelib.js と遅延コンパイル

`dist/runtime/nodelib.js`（`scripts/gen-nodelib.mjs` が生成。[ビルド](building.ja.md) を参照）は ES モジュールで、`ids`（すべての組み込みモジュールの ID）・`params`（各組み込みモジュールのラッパー関数の引数リスト）・`sources`（各組み込みモジュールのソース文字列）の 3 つをエクスポートします。読み込んだ時点では何もコンパイルしません。組み込みモジュールが初めて require されたときに、`compileBuiltin()` が

```js
(function (<params>) {<source>
})
//# sourceURL=node:<id>
```

を間接 `eval` で評価し、できた関数をキャッシュします。そのため、スタックトレースには Node のファイルが `node:fs` などの名前で表示されます。引数リストは `node_builtins.cc` と同じです。

| 組み込みモジュールの ID | 引数 |
|---|---|
| `internal/per_context/*` | `exports, primordials, privateSymbols, perIsolateSymbols` |
| `internal/bootstrap/realm` | `process, getLinkedBinding, getInternalBinding, primordials` |
| ほかの `internal/bootstrap/*`・`internal/main/*` | `process, require, internalBinding, primordials` |
| それ以外 | `exports, require, module, process, internalBinding, primordials` |

`internalBinding('builtins')` は、`builtinIds`、`compileFunction(id)`（未知の ID には `ERR_UNKNOWN_BUILTIN_MODULE`、`No such built-in module: <id>`）、`natives`（ソースの読み取り専用ビュー）、`hasCachedBuiltins()`（`true` を返す）、`getCacheUsage()`（空のリストを 3 つ返す）を提供します。

### OV_TIMING

プロセスの環境変数に空でない `OV_TIMING` があると、Worker はメインスクリプトの同期部分の実行が終わったあとに、各段階にかかった時間を fd 2 に出力します。

```text
[timing] worker start→script 80ms
[timing] init received: 0.5ms
[timing] per_context: 3.8ms
[timing] realm: 2.6ms
[timing] bootstrap/node: 12.1ms
[timing] web + switches: 6.8ms
[timing] internal/main/run_main_module: 30.5ms
[timing] total 136ms since worker start (06:11:35.749)
```

`worker start→script` は、Worker の作成からスクリプトが評価されるまでの時間です。ウォームプールの Worker の場合は、プールで待機していた時間も含みます。ランタイムが読む `OV_*` の変数は `OV_TIMING` だけです（リポジトリにあるほかの `OV_*` は、シェルの内部状態とテストツール用のものです。[テスト](testing.ja.md) と [ビルド](building.ja.md) を参照）。

### ランタイムが設定する終了コード

| コード | 条件 |
|---|---|
| 0 | 正常終了、`--version`、`--v8-options`、スクリプトが成功した `--run` |
| 1 | キャッチされない例外または未処理の Promise の reject（`exit` ハンドラが `process.exitCode` を設定した場合を除く）、失敗した `--run` |
| 6 | `process._fatalException` が関数でない（`kInvalidFatalExceptionMonkeyPatching`） |
| 7 | 致命的な例外のハンドラ自体が例外を投げた（`kExceptionInFatalExceptionHandler`） |
| 9 | コマンドラインまたは `NODE_OPTIONS` が不正 |
| 10 | 起動処理の失敗 |
| 13 | モジュールのトップレベル `await` が完了しないまま、イベントループが空になった |
| 134 | `process.abort()`、または失敗した `process.execve()` |
| 139 | `process.causeSegfault()` |

プロセスが終了するとき、Worker はカーネルの `exit` システムコールを呼び（ワーカースレッドは終了時のフックを実行してから `threadExit` を呼ぶ）、カーネルに終了させられるまで `Atomics.wait` でブロックします。

## コマンドライン

### 解析

`parseCommandLine()`（`src/nodejs/options.ts`）は `node_options.cc` と同じ処理を、本物の Node からダンプしたオプションテーブル（`src/node/data/process.json`。オプション 210 個とエイリアス 25 個、それぞれの型と `NODE_OPTIONS` で使えるかどうか）に基づいて行います。

- 先に `NODE_OPTIONS` を、次にコマンドラインを適用するので、コマンドラインのほうが優先されます。`NODE_OPTIONS` は空白で分割します。`'…'` と `"…"` で囲めます。バックスラッシュによる次の 1 文字のエスケープは、ダブルクォートの中でだけ有効です。
- オプションの並びは、`--`、`-`、または `-` で始まらない最初の引数で終わります。それ以降が `process.argv[1…]` になります。
- オプション名の `_` と `-` は区別しません（`--stack_trace_limit=3` は `--stack-trace-limit=3` と同じ。`process.execArgv` には入力したとおりに残る）。
- 値を取るオプションは `--name=value` と `--name value` のどちらでも書けます。エイリアスは Node と同じように展開します（`-e` → `--eval`、`-p` → `--print`、`-pe` → `--print --eval`、`-C` → `--conditions`、`-r` → `--require`、`--loader` → `--experimental-loader`、`-c` → `--check`、`-i` → `--interactive` など）。`--prof-process` は `--prof-process --` に展開されるので、それ以降はすべて引数になります。
- `--no-<name>` は真偽値のオプションを否定します。`node_options.cc` の `Implies()` と同じように、ほかのオプションを有効にするオプションがあります: `--eval` → `[has_eval_string]`、`--env-file`・`--env-file-if-exists` → `[has_env_file_string]`、`--watch-path` → `--watch`、`--experimental-strip-types` → `--experimental-detect-module`、`--experimental-transform-types` → `--experimental-strip-types` と `--enable-source-maps`、`--inspect-brk` → `--inspect`、`--report-signal` → `--report-on-signal` など。
- 整数のオプションは数値として保存し、文字列のリスト（`--require`・`--import`・`--conditions` など）は値を追加していきます。
- Node が知らないオプションは、Node と同じく V8 に渡します。判定には V8 自身のフラグ一覧（Linux x64 の Node v22.23.4 での `node --v8-options`。`src/nodejs/data/v8-options.json`）を使います。V8 のフラグなら受け付け（効果は無い。後述）、それ以外は bad option です。真偽値のフラグは `--no-` を付けられます。それ以外のフラグは値を `=` の後ろに書く必要があり（Node はその引数だけを V8 に渡すため）、値はフラグの型に合っていなければなりません。

エラー（いずれも `node: <メッセージ>` と出力し、終了コード 9）:

| メッセージ | 原因 |
|---|---|
| `bad option: <arg>` | Node のテーブルにも V8 の一覧にも無いオプション、または値が型に合わない V8 のフラグ（先に V8 自身のメッセージが出る。後述） |
| `<option> is not allowed in NODE_OPTIONS` | Node が `NODE_OPTIONS` で禁止しているオプション（40 個。`--eval` など）と、Node のテーブルに無いすべてのオプション（V8 のフラグを含む） |
| `--no-<name> is an invalid negation because it is not a boolean option` | 真偽値でない Node のオプションに `--no-` を付けた |
| `<arg> requires an argument` | 値を取るオプションが行の最後にある |
| `<file>: not found` | 開けない `--env-file`（`--env-file-if-exists` の場合は `<file> not found. Continuing without it.` と出力して続行する） |
| `<file>: invalid format` | 読み込めない `--env-file`（ディレクトリなど） |
| `either --watch or --check can be used, not both`（`--eval`・`--interactive`・`--test-force-exit` も同様）、`--watch requires specifying a file` | `EnvironmentOptions::CheckOptions` |
| `--secure-heap must be a power of 2`／`--secure-heap-min must be a power of 2` | `PerProcessOptions::CheckOptions` |

値が不正な V8 のフラグに対しては、Node のメッセージの前に V8 のメッセージが出ます。V8 はそこで処理を止めるので、Node と同じく、そのフラグ、それ以降の V8 のフラグ、Node が自分で追加する V8 のフラグ（`--harmony-import-attributes`・`--no-harmony-import-assertions`・`--experimental-wasm-imported-strings`・`--experimental-wasm-memory64`・`--experimental-wasm-exnref`）がすべて bad option として報告されます。

```text
$ node --bogus
node: bad option: --bogus
$ NODE_OPTIONS='--eval=1' node -e 1
node: --eval is not allowed in NODE_OPTIONS
$ node --stack-trace-limit 5 -e 1
Error: illegal value for flag --stack-trace-limit of type int
Try --help for options
node: bad option: --stack-trace-limit
node: bad option: --harmony-import-attributes
node: bad option: --no-harmony-import-assertions
node: bad option: --experimental-wasm-imported-strings
node: bad option: --experimental-wasm-memory64
node: bad option: --experimental-wasm-exnref
```

### オプションの効果

解析した値は `internalBinding('options').getCLIOptionsValues()` が返す値になるので、Node の `lib/` がそれを読み、Node とまったく同じように動作します（`--require`・`--import`・`--conditions`・`--input-type`・`--experimental-strip-types`・`--unhandled-rejections`・`--trace-warnings`・`--no-warnings`・`--experimental-vm-modules`・`--test` など）。ランタイム自身が処理するオプションは次のとおりです。

| オプション | ランタイムでの効果 |
|---|---|
| `--version`・`-v` | 起動処理の途中、Node の bootstrap より前に出力する |
| `--v8-options` | V8 のオプション一覧を出力する（`src/nodejs/data/v8-options.json` のダンプ。最初の行は、ダンプを取得したマシンの CPU の機能） |
| `-e`・`-p`・`--check`・`--test`・`--interactive`・`--help`・`--prof-process`・`--watch` | メインスクリプトを選ぶ（上の表）。`--prof-process` は lib にある V8 の tick processor を実行する（ログを渡さないと `Please provide a valid isolate file as the final argument.` で終了コード 1）。`--watch` は Node の watch モードを実行し、読み込んだファイル（または `--watch-path`）が変わると、子プロセスでスクリプトを再実行する |
| `--env-file`・`--env-file-if-exists` | [--env-file](#--env-file) を参照 |
| `--run` | [--run](#--run) を参照 |
| `--stack-trace-limit` | `Error.stackTraceLimit`（設定を継承するワーカースレッドでも有効） |
| `--title` | `process.title` の初期値 |
| `--trace-exit` | `process.reallyExit` が `(node:<pid>) WARNING: Exited the environment with code <n>` とスタックを出力する |
| `--pending-deprecation` | `process.env` に文字列でない値を設定したときの DEP0104 の警告、GCM の短い認証タグに関する非推奨の警告 |
| `--secure-heap`・`--secure-heap-min` | 値を検証する。`crypto.secureHeapUsed()` が報告する |
| `--max-http-header-size` | HTTP パーサーのヘッダーサイズの上限の既定値（16384） |

受け付けるが効果の無いもの:

- Node のテーブルで型が `kV8Option` のオプション（`--expose-gc`・`--jitless`・`--max-old-space-size`・`--max-semi-space-size`・`--abort-on-uncaught-exception`・`--prof`・`--perf-*`・`--disallow-code-generation-from-strings` など）。そのため `node --expose-gc -e 'typeof gc'` は `undefined` になります
- 型が `kNoOp` のオプション（`--experimental-modules`・`--experimental-wasm-modules` など）
- そのほかの V8 のフラグ（`--use-strict`・`--stack-size=…`・`--harmony-*`・`--allow-natives-syntax` など）。ブラウザの V8 はすでに動いていて、フラグを受け取らないためです

### --env-file

`node.cc` と同じく、オプションを解析する前に、コマンドライン上（`--` まで）の `--env-file <file>`・`--env-file=<file>`・`--env-file-if-exists` をすべて順番に、作業ディレクトリからの相対パスで読み込み、`util.parseEnv()` と同じ方法で解析します。後に指定したファイルが優先されます。ファイル内の `NODE_OPTIONS` は、環境変数に `NODE_OPTIONS` が無い場合に解析に使います。これらのオプションを Node のオプションとして（スクリプト名より前に）指定した場合、`process.env` にまだ無い変数をメインスクリプトの実行前に設定します。すでに環境にある変数のほうが優先されます。`--run` はファイルの変数を使わず、watch モードでは子プロセスに任せます。

```text
$ printf 'FOO=fromfile\n' > .env
$ node --env-file=.env -p process.env.FOO
fromfile
$ FOO=outer node --env-file .env -p process.env.FOO
outer
```

### --run

`node --run <script>`（`src/nodejs/task_runner.ts`。`node_task_runner.cc` に準拠）は、作業ディレクトリから上位に向かって最も近い `package.json` を探し（ルートディレクトリ自体は探さない）、そのファイルのディレクトリで `/bin/sh -c '<script>'` を実行します。標準入出力は継承し、環境変数はプロセスの環境に `NODE_RUN_SCRIPT_NAME`・`NODE_RUN_PACKAGE_JSON_PATH` を加え、作業ディレクトリから上位にあるすべての `node_modules/.bin` を `PATH` の前に追加したものです。`--` の後ろの引数は、Node と同じ方法でシェル用にクォートして追加します。終了コードは、スクリプトが失敗すれば 1、そうでなければ 0 です。Node はこの処理を環境の作成前に C++ で行いますが、ここでは lib の起動後に（`child_process` を使って）実行し、メインスクリプトは実行しません。エラーはいずれも終了コード 1 で、`Can't find package.json for directory <dir>`・`Can't parse <path>`・`Can't find "scripts" field in <path>`・`Script "<name>" is unexpectedly not a string for <path>`・`Missing script: "<name>" for <path>`（続けて利用可能なスクリプトの一覧を表示）があります。

### ワーカースレッド

ワーカースレッドは、自身の `execArgv`（指定が無ければ親のもの）と、自身の環境の `NODE_OPTIONS` を解析します。`new Worker()` は `Worker::New` と同じ検証を行います。プロセス単位のオプション（`--title`・`--openssl-config`・`--secure-heap`・`--report-*`・`--use-openssl-ca`・`--v8-options`・`-h`・`-v` など）、V8 に渡されるオプション（`--expose-gc`・`--stack-trace-limit`・`--use-strict` など）、不正なオプションは `ERR_WORKER_INVALID_EXEC_ARGV` で失敗します。`env.NODE_OPTIONS` が不正な場合も、`invalid NODE_OPTIONS env variable` を添えた `ERR_WORKER_INVALID_EXEC_ARGV` で失敗します。

## 環境とグローバル

### process.env

`process.env`（`src/nodejs/env.ts`）は、init メッセージの `env` から作成します。`Proxy` ではなく、Node のインターセプター付きオブジェクトと同じように動作します（`util.types.isProxy(process.env)` は `false`）。

- 代入した値は `String()` で文字列に変換します。値や名前が Symbol の場合は `TypeError: Cannot convert a Symbol value to a string` を投げます。`--pending-deprecation` のときは、文字列・数値・真偽値のいずれでもない最初の値で DEP0104 を出します。
- 空の名前への代入では何も保存しません。
- アクセサを指定した `Object.defineProperty` は `ERR_INVALID_OBJECT_DEFINE_PROPERTY`（`'process.env' does not accept an accessor(getter/setter) descriptor`）を投げます。データディスクリプタは configurable・writable・enumerable がすべて true でなければなりません。
- `__proto__` のような名前も、自身のプロパティとして保存します。

各スレッドは自分のコピーを持ちます。ただし `worker_threads` の `SHARE_ENV` を使った場合は、変数を共有メモリ（ロック用のワード、バージョンカウンター、JSON 文字列）に置き、アクセスのたびに、ほかのスレッドが変更した内容を先に取り込みます。共有メモリは 64 KiB から 16 MiB まで拡張できる `SharedArrayBuffer` です（拡張可能なバッファが使えない環境では 1 MiB 固定）。それより大きい環境変数は `RangeError: process.env is too large to share` を投げます。

プロセスの起動時の環境変数は、そのプロセスを起動した側が渡したものです。カーネルの既定の環境変数は [プロセス](processes.ja.md) で説明しています。

### グローバルオブジェクト

起動処理のあと、本物の Node からダンプしたグローバルの一覧（`process.json` の `globals`）に合わせて、グローバルオブジェクトの形を整えます。Worker にはあって Node には無い名前（`self`・`postMessage`・`location`・`indexedDB`・`importScripts`・`caches`・`onmessage` など）は `undefined` として読め、列挙されません。Node のグローバルは、列挙可能かどうかを Node に合わせます。Node が定義するグローバルを、ブラウザも Worker のプロトタイプチェーン上に持っている場合（`setTimeout`・`navigator` など）は、プロトタイプ側を削除します。そのため `delete globalThis.setTimeout` のあとには何も残りません。`__ov` で始まる名前（ランタイムのエントリポイントで、いずれも列挙不可）は残します。

Node の起動処理は、Web のグローバルを lib の実装に置き換えます（`URL`・`TextDecoder`・`structuredClone`・`queueMicrotask`・`MessageChannel`・`Blob`・`fetch` など）。ブラウザ本来の実装が必要なバインディングは、Worker のスクリプトを読み込んだ時点で保存しておいたコピー（`src/nodejs/web.ts`）を使います。対象は `URL`・`URLSearchParams`・`TextEncoder`・`TextDecoder`・`MessageChannel`・`MessagePort`・`BroadcastChannel`・`Blob`・`structuredClone`・`queueMicrotask`・`fetch`・`XMLHttpRequest`・`navigator.hardwareConcurrency`（取得できなければ 4）です。

`WebSocket` はブラウザのものです（[fetch](#fetch-と-web-のクラス) を参照）。`EventSource` は、`--experimental-eventsource` を付けない Node 22 と同じく、グローバルにはありません。`localStorage` もグローバルにはありません（Node の `--experimental-webstorage` は既定で無効で、そのバインディングは実装していません）。

## process と os の値

| API | OpenVessel での値 |
|---|---|
| `process.version`・`process.versions` | `v22.23.4` と、本物の Node 22.23.4 のビルドの各コンポーネントのバージョン（`v8` は `12.4.254.21-node.57`、`openssl` は `3.5.9` など） |
| `process.release`・`process.features`・`process.config` | 本物のビルドのもの（`release.lts` は `Jod`、`features.typescript` は `strip`） |
| `process.platform`・`process.arch` | `linux`・`x64` |
| `process.execPath` | `/usr/bin/node` |
| `process.pid`・`process.ppid` | カーネルのプロセス ID |
| `process.title` | `--title`、無ければ `argv[0]` のベース名。変更できるのはメインスレッドだけ |
| `process.debugPort` | 9229。変更できるのはメインスレッドだけ |
| `process.getuid()`・`geteuid()`・`getgid()`・`getegid()` | 1000。`getgroups()` は `[1000]` |
| `process.setuid()` など | 実 ID または実効 ID への変更は成功し、それ以外の ID への変更は `EPERM`。名前は `/etc/passwd` と `/etc/group` から引く |
| `process.memoryUsage()` | `heapUsed` は `performance.memory.usedJSHeapSize`（取得できなければ 50 MB）、`heapTotal` は `totalJSHeapSize`、`rss` は `heapUsed` の 1.5 倍、`external` と `arrayBuffers` は 0 |
| `process.constrainedMemory()`・`availableMemory()` | 0・4 GiB |
| `process.cpuUsage()`・`threadCpuUsage()` | `user` は Worker の起動からの経過時間（マイクロ秒）、`system` は 0 |
| `process.resourceUsage()` | `userCPUTime`（上と同じ）と `maxRSS`（100000）以外はすべて 0 |
| `process.hrtime()`・`hrtime.bigint()`・`uptime()` | `performance.timeOrigin` + `performance.now()` から算出 |
| `process.kill(pid, sig)` | カーネルの `kill`。エラーは `ESRCH`・`EPERM`・`EINVAL` |
| `process.dlopen()` | 常に `ERR_DLOPEN_FAILED`。メッセージは `<file>: cannot open shared object file: No such file or directory`・`<file>: file too short`・`<file>: invalid ELF header`・`Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.` のいずれか |
| `process.execve()` | カーネルの `execve`。失敗すると `process.execve failed with error code <code>` と出力して 134 で終了する |
| `process.loadEnvFile(path = '.env')` | VFS からファイルを読み、まだ設定されていない変数だけを設定する |
| `process.report.getReport()` | Node と同じ構成。ヘッダーは glibc 2.36（`glibcVersionRuntime`）、`osRelease` は `6.8.0-openvessel`、`osVersion` は `#1 SMP OpenVessel`、`osMachine` は `x86_64`、`host` は `openvessel` で、`cpus` と `networkInterfaces` は `os.cpus()`／`os.networkInterfaces()` と同じ内容 |
| `os.release()`・`os.version()` | `6.8.0-openvessel`・`#1 SMP OpenVessel`（uname の release と version） |
| `os.hostname()` | `openvessel` |
| `os.type()`・`os.machine()`・`os.endianness()` | `Linux`・`x86_64`・`LE` |
| `os.cpus()` | `navigator.hardwareConcurrency` 個のエントリ。モデルは `OpenVessel Virtual CPU`、速度は 2400 |
| `os.availableParallelism()` | `navigator.hardwareConcurrency` |
| `os.totalmem()`・`os.freemem()` | 8 GiB・4 GiB |
| `os.loadavg()` | `[0, 0, 0]` |
| `os.uptime()` | Worker の起動からの秒数 + 1000 |
| `os.networkInterfaces()` | `lo`（`127.0.0.1/8`）のみ |
| `os.homedir()`・`os.tmpdir()` | `$HOME`（無ければ `/home/user`）。`$TMPDIR`・`$TMP`・`$TEMP`・`$TEMPDIR`（無ければ `/tmp`） |
| `os.userInfo()` | uid・gid は 1000、ユーザー名は `/etc/passwd` から（無ければ `user`）、`homedir` は `$HOME`、シェルは `/bin/sh` |
| `os.setPriority()`・`os.getPriority()` | 自分のプロセスの場合は値を保持するが、値を下げる（nice 値を小さくする）と `EACCES`。存在するほかの pid の場合は `getPriority` が 0、`setPriority` が `EACCES`。存在しない pid は `ESRCH` |

## イベントループ

`src/nodejs/loop.ts` が libuv の代わりをします。lib が読む Node のデータ構造（`timers`・`immediateInfo`・`tickInfo`・`async_hooks` のフィールド）と Node のイベントの順序を、ブラウザのタスクの上で維持します。

### コールバックスコープ

ループから JavaScript に入る処理（タイマー、immediate、I/O の完了、カーネルからのメッセージ）は、すべて `InternalCallbackScope` に相当する `scope()` を通ります。最も外側のコールバックが戻ったあと、`tickInfo` が tick または reject の処理待ちを示していれば、`processTicksAndRejections`（`process.nextTick` のキューとマイクロタスク）を実行します。スコープの外（Promise のジョブの中など）で呼ばれた `process.nextTick()` は、マイクロタスクのキューが空になったあとに別のタスクで実行します。それより先に次のコールバックがスコープに入った場合は、そこで実行します。

内部のタスクは `MessageChannel` 経由でポストします（`setTimeout(0)` より速いため）。

### フェーズと順序

- タイマー: lib のタイマーはすべて 1 つのネイティブの `setTimeout` を共有します（Node の 1 つの `uv_timer` に相当）。lib は `scheduleTimer(ms)`（最小 1 ms）でそれをスケジュールし、期限の来たタイマーを `processTimers(now)` で実行します。`RunTimers` と同じく、`processTimers` が返した期限は、その中でスケジュールされたタイマーより優先されます。キャッチされない例外をハンドラが握りつぶした場合は、残りの期限切れのタイマーも実行されるように、もう一度 `processTimers` を呼びます。`uv_now()`（`getLibuvNow`）は、ループの開始からのミリ秒数に 1 を足した値です。
- immediate（check フェーズ）: immediate がキューにあるとき、ランタイムは内部のタスクを 2 つ待ってから `processImmediate` を実行します。Node は次の check フェーズの前に reject を報告するので、現在のタスクに対するブラウザの `unhandledrejection` イベントを先に報告するためです。タイマーの期限がすでに来ていれば、タイマーを先に実行します（ループの 1 回の反復では、check フェーズの前に期限切れのタイマーを実行するため）。キャッチされない例外が発生したあとも、immediate のキューの残りは同じフェーズで実行します。コールバックスコープの外（トップレベルの `await` のあとなど）で作られた `setImmediate()` は、単独で 1 回分の順番を使います。
- I/O: カーネルからのメッセージ（`fd-data`・`tcp-accept`・`child-exit` など）は、届いた時点でそれぞれ独自のスコープの中で処理します。

### ループの生存判定・ref と unref

次のいずれかがある間、ループは生存しています。

- 処理中のリクエスト（`startReq`: fs のコールバック、DNS の lookup、接続、`fetch` のリクエストとボディの読み取り、モジュールの読み込み、`WebAssembly.compile` などの追跡対象の Promise）
- 共有のタイマー（ref されている場合）
- ref されている immediate（`immediateInfo[kRefCount] > 0`）
- アクティブで ref されているハンドル（ソケット、パイプ、サーバー、子プロセス、シグナルの監視、ワーカー、ファイルの監視など）

ハンドルの `ref()`／`unref()` と `timeout.unref()` は、対応するフラグを変更します。変更のたびに、ランタイムは生存判定をスケジュールします（内部のタスク 1 つと 2 ms のタイムアウト。ブラウザが自分で完了させる処理が間に合うようにするため）。ループを生存させるものが何も無いときは、次の処理を行います。

1. 保留している reject（後述）があれば、先にそれを渡します。
2. プロセスが終了処理中でなければ、スコープの中で `process.emit('beforeExit', process.exitCode ?? 0)` を実行します。それでループが再び生存状態になれば、ループを続けます。
3. モジュールのトップレベル `await` が完了していなければ、終了コードを 13 にし、`Warning: Detected unsettled top-level await at <url>:<line>` を、その行とキャレットとともに出力します。
4. `process.emit('exit', code)` を実行し、`process.exitCode`（既定は 0）でプロセスを終了します。

`process.getActiveResourcesInfo()` は、処理中のリクエスト（ハンドルのクローズは除く）、ref されているハンドルのリソース名、ref されているタイマー 1 つにつき `Timeout`、ref されている immediate 1 つにつき `Immediate` の順に並べて返します。`process._getActiveHandles()` と `_getActiveRequests()` は、それらの所有者を返します。

### キャッチされない例外

コールバックから漏れた例外は `process._fatalException` に渡します（Node の `TriggerUncaughtException`）。処理されなかった場合は、エラーを fd 2 に出力し、`exit` ハンドラが設定した終了コード、または 1 でプロセスを終了します。出力の形式は Node と同じで、エラーの最初のフレームがソースを読めるファイルまたは組み込みモジュールの場合はソースの行とキャレット、次にスタック（Node の `enhanceStackForFatalException` を通したもの）、最後に `Node.js v22.23.4` を出力します。エラーでない値が投げられた場合は、``Uncaught <inspect(value)>`` に続けて ``(Use `node --trace-uncaught ...` to show where the exception was thrown)`` を出力します。Worker 自身の `error` イベントで報告されたエラーも同じように扱います。

### 未処理の Promise の reject

ブラウザは、reject が未処理かどうかをタスクの終わりに判断します。Node が判断するのは、`processTicksAndRejections` が tick とマイクロタスクをすべて処理し終えたあとです。そのため、Worker の `unhandledrejection` イベントはすぐには Node に渡しません。`nextTick` の処理が残っていない状態になり、さらに `rejectionhandled` イベントが届く余地として 1 タスク待つまで保留します。保留中にハンドラが付いた reject は、何も出力せずに破棄します。保留を解除した reject は Node の promise-reject コールバックに `kPromiseRejectWithNoHandler` として渡し、その後の `rejectionhandled` イベントは `kPromiseHandlerAddedAfterReject` として渡します。それ以降は lib が Node とまったく同じように `--unhandled-rejections` を適用します（既定の `throw` では、エラーを出力して終了コードは 1）。

## モジュールの読み込み

### 組み込みモジュール

`require('fs')`・`require('node:fs')`・`import 'node:fs'` は、`nodelib.js` から Node 自身の `lib/` のモジュールを読み込みます。2 つの依存モジュールは差し替えています（[差し替え](#差し替え) を参照）。`internal/deps/v8/tools/` にある V8 のプロファイラーのツールは同梱していないので、`node --prof-process <ログ>` は `TypeError [ERR_INVALID_ARG_TYPE]: The "sourceText" argument must be of type string. Received undefined` で失敗します（ログを渡さない場合は Node と同じ応答をします）。

### CommonJS

Node 自身の CommonJS ローダーを変更なしで使います。ネイティブ部分の `contextify.compileFunctionForCJSLoader` は、各ファイルを `exports, require, module, __filename, __dirname` を引数とする関数として間接 `eval` でコンパイルします。ファイルのコードはラッパーの 1 行目に置き（行番号を一致させるため）、`sourceURL` にはファイル名を設定します。先頭の `#!` の行はコメントに変換します。コンパイルに失敗し、コードが ES モジュールの構文に見える場合は（`--experimental-detect-module`。22.23.4 では既定で有効）、Node と同じく lib が ES モジュールとして再試行します。CommonJS のコード内の `import()` は、Node の `importModuleDynamically` コールバックに渡します。

### ES モジュール

ES モジュールはブラウザの本物のモジュールで、ブラウザが評価します（`src/nodejs/bindings/module_wrap.ts`）。

1. Node の ESM ローダーがソースを解決して読み込み、`ModuleWrap` を作成します。バインディングは `es-module-lexer` でソースを走査し、静的な import と再 export、`import.meta`、`import()` を見つけます。
2. lib がグラフをリンクするとき、ソース内の静的な指定子を、リンク先の `ModuleWrap` の URL に書き換えます。import 属性（`with { type: 'json' }`）は配信するソースから削除します（lib がすでに検証済みで、リンク先は常に JavaScript として配信するため）。
3. `import.meta` は `globalThis.__ovImportMeta(<id>)` に置き換わり、Node の `initializeImportMeta` コールバックを呼びます。`import(` は `globalThis.__ovDynamicImport.bind(null, <id>)(` に置き換わり、Node の `importModuleDynamically` コールバックを呼びます。
4. 評価時に、グラフ内のすべてのモジュールをカーネルに登録します（`esmRegister` システムコール）。ランタイムの Service Worker がそれらを `/__ov/mw/<pid>/<id>.mjs` で配信し、ルートモジュールの評価はその URL に対するネイティブの `import()` で行います。そのため、リンク、循環参照、ライブバインディング、トップレベル `await` はブラウザの実装がそのまま使われます。プロセスが終了すると、カーネルはそのプロセスのモジュールを破棄します。
5. 組み込みモジュール、CommonJS モジュール、JSON モジュールは、生成した「合成」モジュールとしてブラウザに渡します。エクスポート名ごとに `var` を 1 つ宣言してエクスポートし、バインディングの `setExport()` で値を設定します。

モジュールの評価は、そのモジュール自身の本体が実行を始めるまではリクエストとして数えます（ループは生存したまま）。それ以降に完了しないトップレベル `await` は、プロセスを生存させません（前述の終了コード 13）。

### require(esm)

ES モジュールの `require()`（22.23.4 では既定で有効）は同期的に評価しなければなりませんが、ブラウザはモジュールグラフを同期的に評価できません。そのためバインディングは、グラフ内の各ソースモジュールを、sucrase の `imports` 変換で生成した CommonJS 形式の関数として実行します（`dist/runtime/ts-strip.js`。初めて必要になったときに読み込む）。合成モジュールは評価の手順を直接実行します。トップレベル `await` を含むグラフは、Node と同じく `ERR_REQUIRE_ASYNC_MODULE` で失敗します。同じモジュールをあとで import した場合、ブラウザには `require()` が生成した値を再 export するファサードモジュールを渡すので、コードが 2 回実行されることはありません。

```js
// m.mjs: export const v = 42; export default function f() { return 'def'; }
const m = require('./m.mjs');
console.log(m.v, m.default()); // 42 def
```

### import.meta

`import.meta.url`（`file://` の URL）・`import.meta.resolve()`・`import.meta.main` は Node のコールバックが設定します。`file:` のモジュールには、`internalBinding('modules').setLazyPathHelpers` が `import.meta.dirname` と `import.meta.filename`（`url.fileURLToPath()` で得られる、モジュールのディレクトリとパス）を、書き込み可能かつ列挙可能なデータプロパティとして追加します。そのため `Object.keys(import.meta)` は、Node と同じ `['dirname', 'filename', 'main', 'resolve', 'url']` になります。Node は最初のアクセス時にこれらを計算しますが、ここでは即座に計算します。

### 条件・プリロード・フック

次の機能は Node の lib が処理し、Node と同じように動作します: `require` と `import` の両方に対する `--conditions`／`-C`、`--require`／`-r`、`--import`、`--input-type`、`--experimental-default-type`、`module.register()` で登録するモジュールのカスタマイズフック。

```js
// hooks.mjs
export async function resolve(specifier, context, next) {
  if (specifier === 'virtual:x') return { url: 'data:text/javascript,export default 7', shortCircuit: true };
  return next(specifier, context);
}
// main.mjs
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
console.log((await import('virtual:x')).default); // 7
```

### vm モジュール

`vm.SourceTextModule` と `vm.SyntheticModule`（`--experimental-vm-modules` のとき）も同じバインディングで実装しています。`vm` で作成したソーステキストモジュールは、コンテキストのスコープ内で sucrase の `imports` 変換を使って評価します（[vm](#vm) を参照）。インスタンス化の前に、すべてのリクエストがリンクされていること、import するすべての名前が存在することを確認します（満たさない場合は `ERR_VM_MODULE_LINK_FAILURE`、または `SyntaxError: The requested module '<spec>' does not provide an export named '<name>'`）。トップレベル `await` を含むグラフは、依存モジュールを 1 つずつ評価します。同じソースから作られたものでない `cachedData` は `ERR_VM_MODULE_CACHED_DATA_REJECTED` で拒否します。

### コンパイルキャッシュ

`module.enableCompileCache()` は、キャッシュが無効であることを `the compile cache is not available in OpenVessel` というメッセージで返します。`module.getCompileCacheDir()` は `undefined` を返します。

## TypeScript

型の除去には Node 自身の仕組みを使います。Node 22.23.4 では `--experimental-strip-types` が既定で有効で、どのファイルの型を除去するか（`.ts`・`.mts`・`.cts`、eval の入力では `--input-type=module-typescript`／`commonjs-typescript`）と、どのエラーを出すかは lib が決めます。lib は `internal/deps/amaro` を呼び出しますが、これは差し替えにより `globalThis.__ovAmaro`（`src/nodejs/typescript.ts`）になります。本物の amaro（Node が同梱しているのと同じバージョンで、`process.versions.amaro` は 1.1.8。swc を WebAssembly にコンパイルしたもので約 3 MB）は `dist/runtime/amaro.js` として配布し、初めて型の除去が必要になったときに、ランタイムのオリジンから同期の `XMLHttpRequest` で取得して、Worker ごとに 1 回評価します。

| コマンド | 結果 |
|---|---|
| 型注釈だけを含む `node a.mts` | 実行できる |
| `enum` を含む `node e.ts` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` |
| `node --experimental-transform-types e.ts` | 実行できる（ExperimentalWarning が出る）。ソースマップも暗黙に有効になる |
| `node --no-experimental-strip-types a.mts` | JavaScript パーサーの `SyntaxError` |

旧ランタイムは代わりに sucrase の `typescript` 変換で型を除去します。こちらは enum など、型を消すだけでは処理できない構文も受け付けます。

## fetch と Web のクラス

Node の `fetch`・`Headers`・`Request`・`Response`・`FormData`・`WebSocket`・`EventSource`・`MessageEvent` は `internal/deps/undici` から提供されますが、これは差し替えにより `globalThis.__ovUndici`（`src/nodejs/fetch.ts`）になります。undici は TCP ソケットの上で HTTP を話しますが、ブラウザは外部へのソケットを開けないためです。

### ルーティング

| URL | 取得方法 |
|---|---|
| `data:`・`blob:` | ブラウザの `fetch` で直接取得する |
| `localhost`・`*.localhost`・`127.0.0.1`・`::1`・`[::1]`・`0.0.0.0` への `http:`／`https:` | Node 自身の `http.request()`（`https:` なら `https.request()`）で、`127.0.0.1` の URL のポート（指定が無ければスキームの既定の 80・443）に接続する。仮想ポートへの実際の TCP 接続なので、OpenVessel 内のサーバーに届く。`https:` はほかの `https` クライアントと同じく `tls` を通る（サーバー名と証明書の確認には URL のホスト名を使う） |
| それ以外の `http:`／`https:` | ランタイムの Service Worker の `/__ov/net?url=…` エンドポイント。ここで [ネットワークポリシー](network-policy.ja.md) を適用し、ブラウザの `fetch` でリクエストを送る |
| それ以外のスキーム | `TypeError: fetch failed`。`cause.code` は `ERR_INVALID_URL`（`unsupported URL scheme <scheme>`） |

### 仮想ポートへのリクエストの動作

undici と同じ動作です。リクエストには `host`（URL のホスト）、`connection: keep-alive`、リクエストが設定していなければ undici が追加するヘッダー（`accept: */*`・`accept-language: *`・`sec-fetch-mode: cors`・`user-agent: node`・`accept-encoding: gzip, deflate`）、ボディがあれば `content-length` が付きます。リダイレクト（301・302・303・307・308）は Fetch Standard のとおり最大 20 回までたどります（`redirect: 'manual'` はリダイレクトのレスポンスをそのまま返し、`'error'` は失敗する。303 と、`POST` のあとの 301／302 はボディなしの `GET` になる。`authorization`・`cookie`・`proxy-authorization` は別のオリジンには送らない）。`gzip`・`x-gzip`・`deflate`・`br` のレスポンスボディはデコードします。Fetch Standard で禁止されているポートへのリクエストは `bad port` で失敗します。接続が拒否された場合は `fetch failed` で reject し、その `cause` はソケット自身のエラー（`ECONNREFUSED`。`errno`・`syscall`・`address`・`port` を含む）です。

### 外部へのリクエストの動作

- リクエストヘッダーは `x-ov-h` ヘッダーに入れて送ります。Service Worker は、ページが設定できないヘッダーや、プロキシを経由すると意味をなさないヘッダー（`host`・`connection`・`content-length`・`cookie`・`origin`・`referer`・`accept-encoding`・`sec-*`・`proxy-*` など）を削除します。
- ボディは、リクエストを送る前にすべて読み込みます。`GET` と `HEAD` はボディを持ちません。
- `redirect: 'error'` は指定どおりに動作し、それ以外の場合はリダイレクトをたどります。`response.url` と `response.redirected` は最終的な URL を反映します。
- リクエストは `mode: 'cors'`・`credentials: 'omit'`・`cache: 'no-store'` で送ります。サーバーがクロスオリジンのリクエストを許可している必要があり、レスポンスヘッダーは CORS でブラウザが公開するものだけが見えます。
- リクエストと、処理中のボディの読み取りは、それぞれループのリクエスト（`FetchRequest`・`FetchBody`）として数えるので、それらが処理中の間はプロセスが生存し続けます。
- `Request` と `Response` は、Node の `AbortSignal`、lib の `ReadableStream`、非同期イテラブルをボディとして受け付けます（ストリームのリクエストボディは `duplex: 'half'` を暗黙に伴う）。`fetch` が返すレスポンスは、すべてグローバルの `Response` のインスタンスです。
- `x-ov-by` ヘッダーで、どのプロセスがリクエストしたか（pid と argv の先頭のいくつか）をホストに伝えます。許可を求めるダイアログで使います。

### エラー

失敗した場合は `TypeError('fetch failed')` で reject し、その `cause` がコードを持ちます。

| `cause.code` | 条件 |
|---|---|
| `EACCES` | ネットワークポリシーがそのホストを拒否した: `OpenVessel: network access to <host> was denied by the network policy` |
| `ECONNREFUSED` | ブラウザの `fetch` が失敗した（多くは CORS）: `request to <host> failed: <message>. The server may not allow cross-origin requests (CORS) from the browser.`。ループバックへの接続が拒否された場合も同じ（このときの `cause` はソケットのエラー） |
| `ERR_INVALID_URL` | 未対応のスキーム |

ほかの HTTP クライアント（`http.get`、npm の undici、axios、got）は、代わりに `net`／`tls` を通ります。カーネルがそれらの HTTP/1.1 リクエストを読み取り、同じくポリシーのチェックを行うプロキシ経由で送信します。この経路は [ネットワークポリシー](network-policy.ja.md) と [カーネル](kernel.ja.md) で説明しています。

## 差し替え

Node の `lib/` のファイルを差し替えているのは、`src/nodejs/overrides/` にあるものだけです。`scripts/gen-nodelib.mjs` は、そこにある各ファイルを同じ ID の組み込みモジュールの代わりに組み込みます。差し替えは次の 2 つです。

- `internal/deps/undici/undici` は `module.exports = globalThis.__ovUndici;`（`src/nodejs/fetch.ts` から）に差し替えます。undici は外部への TCP ソケットを必要とするためで、fetch は仮想ポートへは `node:http` で、それ以外へはポリシーのチェックを行うプロキシ経由で送ります。
- `internal/deps/amaro/dist/index` は `module.exports = globalThis.__ovAmaro(require);`（`src/nodejs/typescript.ts` から）に差し替えます。amaro は swc を 3 MB の WebAssembly モジュールとして同梱しているため、`nodelib.js` には含めず、初めて使うときに取得します。

## worker_threads

ワーカースレッドは、同じプロセスに属する別の Web Worker で、カーネルが起動します（`internalBinding('worker')`）。プロセスと同じように起動しますが、`internal/main/worker_thread` を実行します。親とスレッドは `MessageChannel` で通信し、その上で Node の lib が独自のプロトコルを使います。

- `threadId` はプロセスごとの番号です（カーネルが予約します）。`isMainThread`・`threadName`・`resourceLimits`・`SHARE_ENV` に対応しています。`resourceLimits` は記録して返しますが、制限は行いません。
- `receiveMessageOnPort()` と同期的な読み出しは、共有メモリのリングバッファで実現しています。`MessageChannel` のポートに届くメッセージは、`v8.serialize` でシリアライズしてリングバッファにも書き込みます。リングバッファは 16 KiB から始まって 1 MiB まで拡張します（拡張可能な `SharedArrayBuffer` が無い場合は 1 MiB 固定）。この方法でシリアライズできないメッセージは、通常の経路でだけ届きます。
- `trackUnmanagedFds`（既定）の場合、スレッドが `fs.open` で開いた fd はスレッドの終了時に閉じます。
- `worker.getHeapStatistics()` は `performance.memory` から算出した値を返します。`worker.cpuUsage()` はスレッドの起動からの経過時間を返します。`startCpuProfile()`／`stopCpuProfile()` は V8 の形式の空のプロファイルを返します。`getHeapSnapshot()` は利用できません。
- スレッドは、プロセスのメインスレッドと同じランタイムで動きます。プロセスの起動後に `/etc/openvessel/node` が変わっても同じです。

## child_process

`spawn`・`exec`・`execFile`・`fork` とそれぞれの `Sync` 版は、Node の lib が `process_wrap` と `spawn_sync` の上で実装しており、これらがカーネルの `spawn`／`spawnSync` を呼びます。実行できるプログラムは `node` と、カーネルの組み込みプログラムです（[プロセス](processes.ja.md) と [シェルとコマンド](shell.ja.md) を参照）。

- stdio の `pipe`・`overlapped`・`inherit`・`ignore`・fd 番号、ストリームのハンドルの受け渡しに対応しています。`ipc` チャネルはカーネルのソケットペアです。Node の lib は `NODE_CHANNEL_FD` でそれを見つけ、Node と同じく子プロセスの `process.env` からこの変数を削除します。ハンドル（ソケット、サーバー）を IPC で送れます。
- プロセス自身のものでない `uid`／`gid` は `EPERM` で失敗します。`detached` はカーネルに渡しません。
- `spawnSync`: `timeout`・`killSignal`・`input` はカーネルに渡します。`maxBuffer` を超えた場合、出力は上限を超えた 64 KiB の読み取りの位置で打ち切り（libuv の読み取り方と同じ）、`error` は `ENOBUFS`、`status` は `null`、`signal` は kill に使ったシグナル（既定は `SIGTERM`）になります。
- プロセス間のシグナル（`process.kill`・`child.kill`・`process.on('SIGINT')`）はカーネルを経由します。

## スタックトレースとエラー

ブラウザの V8 は `Error.prepareStackTrace` を直接呼び出しますが、Node の V8 は C++ のコールバックを呼び、それが Node の JavaScript のコールバックを実行します。`installStackTraceHook()`（`src/nodejs/boot.ts`）は、C++ 側と同じ処理を行う関数をそこに設定します。

- ランタイム自身（Worker のスクリプト）のフレームを除去します。ランタイムがモジュールやスクリプトをコンパイルするときに生じる間接 `eval` の境界のフレームも除去します。ユーザー自身の `eval`／`new Function` のフレームは残します。
- ブラウザでは、`eval` でコンパイルしたコードのトップレベルのフレームが `eval (file:line:col)` と表示されます。これを `file:line:col`（CommonJS のモジュールのラッパーでは `Object.<anonymous> (file:line:col)`）に書き換え、CommonJS のファイルの 1 行目の列番号をラッパーの分だけ補正します。
- `vm.compileFunction` のコードは、ファイル名と行・列のオフセットに戻して対応付けます。
- `CallSite.prototype.getFileName` と `getScriptNameOrSourceURL` にパッチを当て、ES モジュールが（配信元の `/__ov/mw/…` の URL ではなく）`file://` の URL を、`eval` でコンパイルしたコードが `sourceURL` を返すようにしています。独自の `Error.prepareStackTrace` を設定するライブラリ（callsites・depd など）でも同様です。
- そのうえで、Node 自身の `prepareStackTrace` コールバック（`setPrepareStackTraceCallback` で設定されたもの）がトレースを整形するので、エラーメッセージ、`code` プロパティ、スタックフレームは Node と同じ形になります。

```text
[eval]:1
console.log(require("fs").readFileSync("/nonexistent"))
                          ^

Error: ENOENT: no such file or directory, open '/nonexistent'
    at Object.openSync (node:fs:560:18)
    at Object.readFileSync (node:fs:444:35)
    at [eval]:1:27
```

残っている違いは次のとおりです。`vm` の API で実行したコード（`-e` もこれを使う）では、余分な `at eval (<anonymous>)` のフレームが表示されることがあります。`util.getCallSites()`／`callsites` も同じフックから得られます。`getCallerLocation` は `undefined` を返します。致命的なエラーのソース位置（`getErrorSourcePositions`）は、スタックの最初のフレームから取得します。

## vm

Web Worker では新しい JavaScript の realm を作れないので、`vm` のコンテキストはエミュレートしています（`src/nodejs/bindings/contextify.ts`）。

- コンテキストのグローバルは、コンテキスト化したオブジェクト（サンドボックス）に対するプロキシで、見つからない名前は ECMAScript の組み込みオブジェクトにフォールバックします。コードは `with (scope)` の中で実行され、自由変数はサンドボックス、組み込みオブジェクトの順に解決されます。Worker 自身のグローバル（`process`・`require` など）は `undefined` として読めます。
- スクリプトのトップレベルの `var` と関数宣言は、V8 と同じくサンドボックスに定義され、削除できません。トップレベルと、単純に呼び出された sloppy モードの関数の `this` は、コンテキストのグローバルです。
- `codeGeneration: { strings: false }` は、コンテキスト内の `eval`／`Function` を `EvalError: Code generation from strings disallowed for this context` を投げるものに置き換えます。`{ wasm: false }` では、`WebAssembly.compile` などが `WebAssembly.<fn>(): Wasm code generation disallowed by embedder` で失敗します。
- `vm.constants.DONT_CONTEXTIFY` は通常のグローバルオブジェクトを返します。
- `cachedData`: V8 のコードキャッシュは生成できません。`createCachedData()` は 16 バイトのレコード（`OVC1`、ソースの長さと 2 つのハッシュ）を返し、ソースに一致しない `cachedData` は V8 と同じ方法で拒否します。
- `vm.measureMemory()` は `performance.memory.usedJSHeapSize` を返します。

エミュレートしていないもの: 独立した組み込みオブジェクト（`vm.runInContext('Array', ctx) === Array` は `true`）、`timeout` と `breakOnSigint` のオプション（受け付けるが、終わらないスクリプトはそのまま止まらない）、`microtaskMode`。

## AsyncLocalStorage

Node は V8 の Promise フックを使って、非同期コンテキストを Promise に沿って伝播させます。ブラウザはこのフックを公開していないため（`setPromiseHooks` は何もしない）、`AsyncLocalStorage.run()`／`enterWith()` で設定したコンテキストは、同期的なコードと、最初の `await` より前にスケジュールしたコールバック（`process.nextTick`、タイマー、immediate、I/O）では参照できますが、`await` のあとでは失われます。

```js
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
als.run(42, async () => {
  console.log(als.getStore()); // 42
  await null;
  console.log(als.getStore()); // undefined
});
```

`async_hooks.createHook()` のフックは、lib が JavaScript で作成するリソース（`Timeout`・`Immediate`・`TickObject`・`AsyncResource` など）に加え、Node の C++ の `AsyncWrap` と同様にネイティブのリソースでも呼ばれます。対象は、ハンドル（`TCPWRAP`・`TCPSERVERWRAP`・`PIPEWRAP`・`PIPESERVERWRAP`・`TTYWRAP`・`TLSWRAP`・`UDPWRAP`・`PROCESSWRAP`・`SIGNALWRAP`・`FSEVENTWRAP`・`STATWATCHER`・`WORKER`・`MESSAGEPORT`）、リクエスト（`FSREQCALLBACK`・`FSREQPROMISE`・`FILEHANDLECLOSEREQ`・`TCPCONNECTWRAP`・`PIPECONNECTWRAP`・`SHUTDOWNWRAP`、すぐには完了しなかった書き込みの `WRITEWRAP`、`GETADDRINFOREQWRAP`・`GETNAMEINFOREQWRAP`・`QUERYWRAP`）、その他（`FILEHANDLE`・`DIRHANDLE`・`DNSCHANNEL`・`ZLIB`・`HTTPINCOMINGMESSAGE`・`HTTPCLIENTREQUEST`・暗号のジョブ）です。各リソースは作成時に非同期 ID を受け取り（lib が作成するリクエストオブジェクト、たとえば `WriteWrap` や `TCPConnectWrap` の場合は、バインディングがそれを使ってリクエストを開始したとき）、そのときに `init` が呼ばれます（トリガーは既定のトリガー ID か現在の実行 ID。ハンドル上で開始したリクエストと、サーバーが accept した接続のトリガーはそのハンドル）。コールバックはそのリソースの非同期コンテキストで実行され、前後に `before`／`after` が呼ばれます（`executionAsyncId()` と `executionAsyncResource()` はそのリソースを指す）。ハンドルが閉じたとき、またはリクエストが完了したときに `destroy` が続きます。Node がガベージコレクションのときにしか破棄しないリソース（`FILEHANDLE`・`DIRHANDLE`・`ZLIB` など）は `destroy` を報告しません。フックが無い場合のコストは、Node と同じく、ID 1 つとコールバックごとの非同期コンテキストの push／pop だけです。Promise フックは呼ばれない（`PROMISE` リソースは無い）ので、Promise のリアクションの中で作成したリソースのトリガーは、Promise ではなく、それを囲む実行の ID になります。

## インスペクター・プロファイル・診断

- `node:inspector` は読み込めます。`inspector.url()` は `undefined` で、`open()` と `waitForDebugger()` は何もしません。`Session` にポストしたプロトコルのメッセージには、すべて非同期にエラー `-32601`（`The inspector is not available in OpenVessel`）を返します。console の呼び出しは Node の console にだけ渡ります。
- V8 のカバレッジ（`NODE_V8_COVERAGE`）: ディレクトリは受け付けますが、何も書き出しません。
- ヒープスナップショット（`v8.getHeapSnapshot()`・`v8.writeHeapSnapshot()`）は `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` を投げます。
- `v8.getHeapStatistics()` などの関数は `performance.memory` から算出した値を返します。`v8.setFlagsFromString()` はフラグを記録しますが、何も変更しません。
- `perf_hooks.monitorEventLoopDelay()` はブラウザの interval タイマーでサンプリングします。`createHistogram()` は Node と同じバケットを持つ HdrHistogram の移植です。`eventLoopUtilization()` のアイドル時間は常に 0 です。
- トレースイベントは無効です（`trace_events` のカテゴリが有効になることはありません）。

## 実装していないもの

次のものは読み込めますが、使うと失敗します。特に記載が無い限り、エラーは `ERR_NOT_IMPLEMENTED`（`internalBinding ('<name>').<member> is not implemented in OpenVessel`）です。

| 機能 | 動作 |
|---|---|
| `node:http2` | `require` はでき、`http2.createServer()`／`createSecureServer()` は listen するサーバーを返す。しかし `new Http2Session()` が `ERR_NOT_IMPLEMENTED`（`internalBinding ('http2').Http2Session is not implemented in OpenVessel`）を投げるので、セッションはすべて失敗する。`http2.connect()` は `ClientHttp2Session` を返し、ソケットが接続した時点でそのエラーを `error` イベントとして発行し、続けて `close` を発行する。サーバーへの接続では、サーバーの connection リスナーからそのエラーがキャッチされない例外として投げられる（`uncaughtException` を処理しなければ、プロセスは 1 で終了する） |
| `node:sqlite` | `new DatabaseSync()` が失敗する |
| `node:sea` | `sea.isSea()` などが失敗する |
| `net.BlockList`・`net.SocketAddress` | インスタンスの作成が失敗する（`block_list`） |
| JavaScript のストリーム（ネイティブのソケットでないもの）を渡す `tls.connect({ socket })` | 失敗する（`js_stream`） |
| `localStorage`／`sessionStorage` | 利用できない（`webstorage`） |
| `--permission` | `process.permission.has()` が失敗する（`permission`） |
| ネイティブアドオン | `process.dlopen` は常に失敗する（前述） |

各モジュールのバインディング単位の状況は [バインディング](bindings.ja.md) にあります。

## 関連するページ

- [バインディング](bindings.ja.md): すべての `internalBinding()` モジュールとその状況
- [プロセス](processes.ja.md)・[カーネル](kernel.ja.md)・[通信の形式](protocol.ja.md): カーネル側
- [ネットワークポリシー](network-policy.ja.md): 外部へのリクエストに許されていること
- [互換性](../compatibility.ja.md): 計測結果とプラットフォームの制約
- [OpenVessel の仕組み](../how-it-works.ja.md)
