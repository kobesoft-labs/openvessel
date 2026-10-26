# Node.js の層

[English](nodejs-runtime.md)

プロセスの Worker の中で Node.js がどう動くかの仕様です。ビルドに入っている 2 つのランタイムと選び方、移植版ランタイムの起動の順序、コマンドライン、環境、イベントループ、モジュールの読み込み、TypeScript、`fetch`、そして Node.js とわざと違えている所を扱います。
ブラウザではそもそも動かないものと、計った試験の結果は [互換性](../compatibility.ja.md) にあります。

## 2 つのランタイム

`node` のプロセス（と `worker_threads` のスレッド）は、どれもカーネルが起こす Web Worker です。その Worker のスクリプトは、ビルドに 2 種類あります。

| | 移植版ランタイム | 旧ランタイム |
|---|---|---|
| Worker のスクリプト | `dist/runtime/node-process.js` | `dist/runtime/process.js` |
| ソース | `src/nodejs/`（入口は `src/nodejs/boot.ts`） | `src/node/`（入口は `src/node/worker.ts`） |
| 動くもの | Node.js v22.23.4 の `lib/` そのもの（`dist/runtime/nodelib.js` に束ねたもの）。C++ の半分（`internalBinding()`）を TypeScript で書き直している。[バインディング](bindings.ja.md) を参照 | 手で書いた Node 互換のモジュール（`fs.ts`・`http.ts`・`module.ts` など） |
| コマンドライン | Node のオプション表と解析（`src/nodejs/options.ts`）。知らないオプションはエラー | 手で書いた小さな解析。知らないオプションは無視 |
| TypeScript | Node の型の除去（amaro） | sucrase の `typescript` 変換（enum なども通る） |
| ES モジュール | `module_wrap` バインディング。`/__ov/mw/<pid>/<id>.mjs` で配る | カーネルの ESM の配信（`/__ov/esm/…`・`/__ov/builtin/…`） |
| `--loader` | Node のフックの仕組み | 警告を出して無視 |
| `node:http2` | 読み込める。セッションで `ERR_NOT_IMPLEMENTED` | 読み込める。`createServer`・`createSecureServer`・`connect` が `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`（「HTTP/2 is not supported in OpenVessel」）を投げる |
| 既定 | いいえ | **はい** |

[互換性](../compatibility.ja.md) のページの数字（Node の試験とAstro のコーパス）は、どれも移植版ランタイムで計ったものです。このページは、断りのない限り移植版ランタイムについて書いています。

### ランタイムの選び方

カーネルは Worker を作るたびにスクリプトを選びます（`src/kernel/index.ts` の `processScript()`）。VFS の `/etc/openvessel/node` があり、中身の前後の空白を除いたものがちょうど `port` なら `node-process.js` を、それ以外（ファイルが無い・読めない・ほかの文字）なら `process.js` を使います。
ファイルは Worker ごとに読むので、書いたあとに起動したプロセスとスレッドに効きます。動いているプロセスは変わりません。

シェルから:

```sh
mkdir -p /etc/openvessel && echo port > /etc/openvessel/node
node -p 'process.version'      # ここから移植版ランタイムで動く
```

ホストのページから（デモと同じ）:

```ts
vessel.mount({ node: 'port' }, { path: '/etc/openvessel' });
```

カーネルはスクリプトの URL ごとに、`init` を待つ Worker を 2 つ先に作っておき（`WARM = 2`）、1 つ使うたびに補います。そのため、スクリプトの読み込みとコンパイルの大部分は、プロセスが要る前に済んでいます。

## プロセスの Worker の起動

### `init` のメッセージ

カーネルは `{ t: 'init', … }` を送ってスレッドを始めます（`src/nodejs/state.ts` の `InitMsg`）。

| 項目 | 意味 |
|---|---|
| `kind` | プロセスは `'main'`、`worker_threads` のスレッドは `'thread'` |
| `pid`・`ppid`・`tid` | プロセス ID・親のプロセス ID・カーネルのスレッド ID |
| `argv`・`env`・`cwd` | プロセスの引数・環境変数・作業ディレクトリ |
| `sab` | 同期の syscall に使う `SharedArrayBuffer` |
| `ttys` | fd 0〜2 のそれぞれについて、端末なら `{ cols, rows }`、そうでなければ `null` |
| `hostname` | カーネルのホスト名（`openvessel`） |
| `file`・`eval`・`evalType`・`execArgv`・`workerData`・`envData`・`port`・`name`・`threadId`・`envRings`・`trackUnmanagedFds`・`sharedEnv`・`resourceLimits` | worker のスレッドだけ |

ほかに受けるメッセージ: `{ t: 'ping', id }` には `{ t: 'pong', id }` を返します（カーネルはこれで、それまでに送ったものが全部処理されたことを知ります）。それ以外の `t` は、バインディングが登録した受け手に渡します（`child-exit`・`signal`・`fd-data`・`fd-writable`・`tcp-accept`・`pipe-accept`・`udp-msg`・`watch`・`tls-peer`・`thread-exit`・`thread-gone`）。メッセージの約束ごとそのものは [通信の形式](protocol.ja.md) にあります。

### 起動の順序

`src/nodejs/boot.ts` の `boot()` は、C++ の `node::CreateEnvironment` と `node::StartExecution` がすることをします。

1. init のメッセージを覚え、syscall の通り道をつなぎ、（メインのスレッドだけ）コマンドラインを解析します。コマンドラインが正しくなければ、エラーを 1 行ずつ `<argv0>: <エラー>` と出し、終了コード 9 で終わります。`--version`／`-v` は、ほかの何も読み込む前に `v22.23.4` を出して 0 で終わります。
2. Worker の `unhandledrejection`・`rejectionhandled`・`error` のイベントを受ける準備をします。
3. グローバルの `Proxy` を、対象とハンドラを記録するものに差し替え（`util.types.isProxy` と `util.inspect(…, { showProxy: true })` のため）、Map・Set の反復子を作るメソッドを包みます（`util.types.isMapIterator` と反復子のプレビューのため）。どちらも Node の primordials が掴む前に行います。
4. コンテキストごとのスクリプト `internal/per_context/primordials`・`internal/per_context/domexception`・`internal/per_context/messageport` を実行します。
5. 束ねた lib から `internalBinding('builtins')` を作り、`process` オブジェクトを作ります（`version`・`versions`・`arch: 'x64'`・`platform: 'linux'`・`release`・`_rawDebug`・`env`）。
6. `internal/bootstrap/realm` を実行し、スタックトレースのフックを入れます（[スタックトレースとエラー](#スタックトレースとエラー) を参照）。
7. `internal/bootstrap/node`、続けて `internal/bootstrap/web/exposed-wildcard` と `internal/bootstrap/web/exposed-window-or-worker` を実行します（`config.noBrowserGlobals` はいつも `false`）。
8. メインのスレッドでは `internal/bootstrap/switches/is_main_thread` と `…/does_own_process_state` を、worker のスレッドでは `…/is_not_main_thread` と `…/does_not_own_process_state` を実行します。
9. グローバルオブジェクトを Node の形に整えます（[グローバルオブジェクト](#グローバルオブジェクト) を参照）。
10. メインのスクリプトを選んでコールバックの枠の中で実行し、イベントループを始めます。

2〜10 のどこかで例外が出ると、fd 2 に `[openvessel] node bootstrap failed: <スタック>` と書き、終了コード 10（`kBootstrapFailure`）で終わります。

メインのスクリプトは `node::SelectLoadMode` と同じように選びます。

| 条件（上から最初に当てはまるもの） | メインのスクリプト |
|---|---|
| worker のスレッド | `internal/main/worker_thread` |
| `--help` | `internal/main/print_help` |
| `-e`・`-p`・`--eval`・`--print`（`--interactive` なし） | `internal/main/eval_string` |
| `--check` | `internal/main/check_syntax` |
| `--test` | `internal/main/test_runner` |
| `-` 以外のスクリプトの引数がある | `internal/main/run_main_module` |
| `--interactive`、または fd 0 が端末 | `internal/main/repl` |
| それ以外 | `internal/main/eval_stdin` |

### nodelib.js と、使う時のコンパイル

`dist/runtime/nodelib.js`（`scripts/gen-nodelib.mjs` が作る。[ビルド](building.ja.md) を参照）は ES モジュールで、`ids`（組み込みモジュールの ID の全部）・`params`（それぞれの包む関数の引数）・`sources`（それぞれのソースの文字列）の 3 つを出します。読み込んだ時点では何もコンパイルしません。組み込みモジュールが初めて require されたとき、`compileBuiltin()` が

```js
(function (<params>) {<source>
})
//# sourceURL=node:<id>
```

を間接の `eval` で評価し、関数を取っておきます。そのためスタックトレースには Node のファイルが `node:fs` などの名前で出ます。引数は `node_builtins.cc` と同じです。

| 組み込みの ID | 引数 |
|---|---|
| `internal/per_context/*` | `exports, primordials, privateSymbols, perIsolateSymbols` |
| `internal/bootstrap/realm` | `process, getLinkedBinding, getInternalBinding, primordials` |
| ほかの `internal/bootstrap/*`・`internal/main/*` | `process, require, internalBinding, primordials` |
| それ以外 | `exports, require, module, process, internalBinding, primordials` |

`internalBinding('builtins')` は `builtinIds`・`compileFunction(id)`（知らない ID は `ERR_UNKNOWN_BUILTIN_MODULE`、`No such built-in module: <id>`）・`natives`（ソースを読むだけの窓）・`hasCachedBuiltins()`（`true`）・`getCacheUsage()`（空の一覧 3 つ）を持ちます。

### OV_TIMING

プロセスの環境変数に空でない `OV_TIMING` があると、Worker はメインのスクリプトの同期の部分が終わったあとに、段ごとの時間を fd 2 に出します。

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

`worker start→script` は、Worker を作ってからスクリプトが評価されるまでの時間です。温めた Worker では、待機列で待った時間も入ります。ランタイムが読む `OV_*` の変数は `OV_TIMING` だけです（リポジトリにあるほかの `OV_*` は、シェルの内部の状態と試験の道具のものです。[試験](testing.ja.md) と [ビルド](building.ja.md) を参照）。

### ランタイムが決める終了コード

| コード | いつ |
|---|---|
| 0 | ふつうの終了、`--version` |
| 1 | 捕まえられなかった例外・処理されなかった Promise の拒否（`exit` のハンドラが `process.exitCode` を決めたときはその値） |
| 6 | `process._fatalException` が関数でない（`kInvalidFatalExceptionMonkeyPatching`） |
| 7 | 致命的な例外の処理そのものが例外を投げた（`kExceptionInFatalExceptionHandler`） |
| 9 | コマンドラインか `NODE_OPTIONS` が正しくない |
| 10 | 起動の失敗 |
| 13 | モジュールの最上位の `await` が終わらないまま、イベントループが空になった |
| 134 | `process.abort()`、または失敗した `process.execve()` |
| 139 | `process.causeSegfault()` |

プロセスが終わるとき、Worker はカーネルの `exit` の syscall を呼び（worker のスレッドは終了時のフックを実行して `threadExit` を呼ぶ）、カーネルに止められるまで `Atomics.wait` で待ちます。

## コマンドライン

### 解析

`parseCommandLine()`（`src/nodejs/options.ts`）は `node_options.cc` に従い、本物の Node から吸い出したオプションの表（`src/node/data/process.json`: オプション 210 個・別名 25 個、それぞれの型と `NODE_OPTIONS` で使えるかどうか）で動きます。

- 先に `NODE_OPTIONS`、次にコマンドラインを当てます。コマンドラインのほうが勝ちます。`NODE_OPTIONS` は空白で区切ります。`'…'` と `"…"` で囲めて、バックスラッシュは二重引用符の中でだけ次の 1 文字をそのまま入れます。
- オプションは `--`・`-`・`-` で始まらない最初の引数で終わります。その後ろが `process.argv[1…]` です。
- 値を取るオプションは `--name=value` でも `--name value` でも書けます。別名は Node と同じに展開します（`-e` → `--eval`、`-p` → `--print`、`-pe` → `--print --eval`、`-C` → `--conditions`、`-r` → `--require`、`--loader` → `--experimental-loader`、`-c` → `--check`、`-i` → `--interactive` など）。
- `--no-<name>` は真偽のオプションを打ち消します。ほかのオプションを伴う真偽のオプションがあります: `--experimental-transform-types` は `--experimental-strip-types` と `--enable-source-maps` を伴います。
- 整数のオプションは数として、文字列の一覧（`--require`・`--import`・`--conditions` など）は積み重ねて持ちます。

エラー（どれも `node: <メッセージ>` と出し、終了コード 9）:

| メッセージ | 原因 |
|---|---|
| `bad option: <arg>` | Node の表に無く、受け付ける V8 のフラグでもないオプション |
| `<option> is not allowed in NODE_OPTIONS` | Node が `NODE_OPTIONS` で禁じているオプション（40 個。`--eval` など） |
| `<arg> requires an argument` | 値を取るオプションが行の最後にある |
| `--secure-heap must be a power of 2`／`--secure-heap-min must be a power of 2` | `PerProcessOptions::CheckOptions` |

```text
$ node --bogus
node: bad option: --bogus
$ NODE_OPTIONS='--eval=1' node -e 1
node: --eval is not allowed in NODE_OPTIONS
```

### オプションの効き方

解析した値は `internalBinding('options').getCLIOptionsValues()` が返すものになるので、Node の `lib/` が Node とまったく同じように読んで従います（`--require`・`--import`・`--conditions`・`--input-type`・`--experimental-strip-types`・`--unhandled-rejections`・`--trace-warnings`・`--no-warnings`・`--experimental-vm-modules`・`--test` など）。ランタイム自身が使うものは次のとおりです。

| オプション | ランタイムでの効き目 |
|---|---|
| `--version`・`-v` | Node の起動より前に出す |
| `-e`・`-p`・`--check`・`--test`・`--interactive`・`--help` | メインのスクリプトを選ぶ（上の表） |
| `--title` | `process.title` の初めの値 |
| `--trace-exit` | `process.reallyExit` が `(node:<pid>) WARNING: Exited the environment with code <n>` とスタックを出す |
| `--pending-deprecation` | `process.env` に文字列でない値を入れたときの DEP0104 の警告、GCM の短い認証タグの非推奨の警告 |
| `--secure-heap`・`--secure-heap-min` | 値を確かめる。`crypto.secureHeapUsed()` が報告する |
| `--max-http-header-size` | HTTP パーサーのヘッダーの大きさの上限の既定値（16384） |

受け付けるが効き目の無いもの:

- Node の表で型が `kV8Option` のもの（`--expose-gc`・`--jitless`・`--max-old-space-size`・`--max-semi-space-size`・`--abort-on-uncaught-exception`・`--prof`・`--perf-*`・`--disallow-code-generation-from-strings` など）。そのため `node --expose-gc -e 'typeof gc'` は `undefined` です
- 型が `kNoOp` のもの（`--experimental-modules`・`--experimental-wasm-modules` など）
- 表に無いが V8 のフラグらしいもの: `--max-old-space-size*`・`--max-semi-space-size*`・`--stack-size*`・`--expose-gc*`・`--harmony*`・`--js-*`・`--allow-natives-syntax*`・`--enable-sharedarraybuffer-per-context*`・`--v8-*`・すべての `--no-*`

次のものは解析しますが、当てません。Node が JavaScript の起動の前に、または代わりに C++ で扱うもので、ランタイムはそれを再現していないためです。

| オプション | どうなるか |
|---|---|
| `--env-file`・`--env-file-if-exists` | ファイルを読み込まない（`process.loadEnvFile()` は動く） |
| `--run <script>` | パッケージのスクリプトを動かさない |
| `--watch`・`--watch-path` | スクリプトを 1 回動かすだけで、見張らない |
| `--v8-options` | 何も出さない |
| `--stack-trace-limit` | `Error.stackTraceLimit` は 10 のまま |

### worker のスレッド

worker のスレッドは、自分の `execArgv`（無ければ親のもの）と、自分の環境の `NODE_OPTIONS` を解析します。`new Worker()` は `Worker::New` と同じように確かめます。プロセス全体のオプション（`--title`・`--openssl-config`・`--secure-heap`・`--report-*`・`--use-openssl-ca`・`--v8-options`・`-h`・`-v` など）や正しくないオプションは `ERR_WORKER_INVALID_EXEC_ARGV` になります。`env.NODE_OPTIONS` が正しくないときも、`invalid NODE_OPTIONS env variable` を添えた `ERR_WORKER_INVALID_EXEC_ARGV` になります。

## 環境とグローバル

### process.env

`process.env`（`src/nodejs/env.ts`）は init のメッセージの `env` から作ります。`Proxy` ではなく、Node のインターセプターのある物と同じに振る舞います（`util.types.isProxy(process.env)` は `false`）。

- 代入した値は `String()` で文字列にします。Symbol の値や名前は `TypeError: Cannot convert a Symbol value to a string` を投げます。`--pending-deprecation` のとき、文字列・数・真偽値でない最初の値で DEP0104 を出します。
- 空の名前への代入は何も入れません。
- アクセサを渡す `Object.defineProperty` は `ERR_INVALID_OBJECT_DEFINE_PROPERTY`（`'process.env' does not accept an accessor(getter/setter) descriptor`）を投げます。データの記述子は configurable・writable・enumerable がすべて true でなければなりません。
- `__proto__` のような名前も、自分のプロパティとして入れます。

スレッドごとに自分の写しを持ちます。ただし `worker_threads` の `SHARE_ENV` のときは、変数を共有メモリ（ロックの語・版の数・JSON の文字列）に置き、読み書きのたびに、ほかのスレッドが変えたものを先に取り込みます。共有メモリは 64 KiB から 16 MiB まで伸びる `SharedArrayBuffer` です（伸びる物が使えないときは 1 MiB 固定）。それより大きい環境は `RangeError: process.env is too large to share` になります。

プロセスが始まるときの環境は、起動した側が渡したものです。カーネルの既定の環境は [プロセス](processes.ja.md) にあります。

### グローバルオブジェクト

起動のあと、本物の Node から吸い出したグローバルの一覧（`process.json` の `globals`）に合わせて、グローバルオブジェクトの形を整えます。Worker にはあって Node には無い名前（`self`・`postMessage`・`location`・`indexedDB`・`importScripts`・`caches`・`onmessage` など）は `undefined` に見え、列挙されません。Node のグローバルは Node と同じ列挙可否にします。Node が定義するグローバルを、ブラウザも Worker のプロトタイプの側に持っているとき（`setTimeout`・`navigator` など）は、プロトタイプ側を消します。そのため `delete globalThis.setTimeout` のあとには何も残りません。`__ov` で始まる名前（ランタイムの入口。どれも列挙されない）は残します。

Node の起動は、Web のグローバルを lib の実装に差し替えます（`URL`・`TextDecoder`・`structuredClone`・`queueMicrotask`・`MessageChannel`・`Blob`・`fetch` など）。ブラウザ本来のものが要るバインディングは、Worker のスクリプトを読み込んだ時点で取っておいた物（`src/nodejs/web.ts`）を使います: `URL`・`URLSearchParams`・`TextEncoder`・`TextDecoder`・`MessageChannel`・`MessagePort`・`BroadcastChannel`・`Blob`・`structuredClone`・`queueMicrotask`・`fetch`・`XMLHttpRequest`・`navigator.hardwareConcurrency`（取れなければ 4）。

`WebSocket` はブラウザのものです（[fetch](#fetch-と-web-のクラス) を参照）。`EventSource` は、`--experimental-eventsource` の無い Node 22 と同じくグローバルにありません。`localStorage` もありません（Node の `--experimental-webstorage` は既定で切れていて、そのバインディングは実装していません）。

## process と os の値

| API | OpenVessel での値 |
|---|---|
| `process.version`・`process.versions` | `v22.23.4` と、本物の Node 22.23.4 の各部品の版（`v8` は `12.4.254.21-node.57`、`openssl` は `3.5.9` など） |
| `process.release`・`process.features`・`process.config` | 本物のビルドのもの（`release.lts` は `Jod`、`features.typescript` は `strip`） |
| `process.platform`・`process.arch` | `linux`・`x64` |
| `process.execPath` | `/usr/bin/node` |
| `process.pid`・`process.ppid` | カーネルのプロセス ID |
| `process.title` | `--title`、無ければ `argv[0]` の最後の名前。変えられるのはメインのスレッドだけ |
| `process.debugPort` | 9229。変えられるのはメインのスレッドだけ |
| `process.getuid()`・`geteuid()`・`getgid()`・`getegid()` | 1000。`getgroups()` は `[1000]` |
| `process.setuid()` など | 実 ID か実効 ID へは成功、ほかの ID へは `EPERM`。名前は `/etc/passwd`・`/etc/group` で引く |
| `process.memoryUsage()` | `heapUsed` は `performance.memory.usedJSHeapSize`（取れなければ 50 MB）、`heapTotal` は `totalJSHeapSize`、`rss` は `heapUsed` の 1.5 倍、`external`・`arrayBuffers` は 0 |
| `process.constrainedMemory()`・`availableMemory()` | 0・4 GiB |
| `process.cpuUsage()`・`threadCpuUsage()` | `user` は Worker が始まってからの経過時間（マイクロ秒）、`system` は 0 |
| `process.resourceUsage()` | `userCPUTime`（上と同じ）と `maxRSS`（100000）のほかは 0 |
| `process.hrtime()`・`hrtime.bigint()`・`uptime()` | `performance.timeOrigin` と `performance.now()` から |
| `process.kill(pid, sig)` | カーネルの `kill`。エラーは `ESRCH`・`EPERM`・`EINVAL` |
| `process.dlopen()` | いつも `ERR_DLOPEN_FAILED`。メッセージは `<file>: cannot open shared object file: No such file or directory`・`<file>: file too short`・`<file>: invalid ELF header`・`Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.` のどれか |
| `process.execve()` | カーネルの `execve`。失敗すると `process.execve failed with error code <code>` を出して 134 で終わる |
| `process.loadEnvFile(path = '.env')` | VFS からファイルを読み、まだ無い変数だけを入れる |
| `process.report.getReport()` | Node と同じ形。頭の部分は glibc 2.36（`glibcVersionRuntime`）・`osRelease` は `6.8.0-openvessel`・`host` は `openvessel` |
| `os.hostname()` | `openvessel` |
| `os.type()`・`os.machine()`・`os.endianness()` | `Linux`・`x86_64`・`LE` |
| `os.cpus()` | `navigator.hardwareConcurrency` 個。型名は `OpenVessel Virtual CPU`、速さは 2400 |
| `os.availableParallelism()` | `navigator.hardwareConcurrency` |
| `os.totalmem()`・`os.freemem()` | 8 GiB・4 GiB |
| `os.loadavg()` | `[0, 0, 0]` |
| `os.uptime()` | Worker が始まってからの秒数 + 1000 |
| `os.networkInterfaces()` | `lo`（`127.0.0.1/8`）だけ |
| `os.homedir()`・`os.tmpdir()` | `$HOME`（無ければ `/home/user`）。`$TMPDIR`・`$TMP`・`$TEMP`・`$TEMPDIR`（無ければ `/tmp`） |
| `os.userInfo()` | uid・gid は 1000、ユーザー名は `/etc/passwd` から（無ければ `user`）、`homedir` は `$HOME`、シェルは `/bin/sh` |
| `os.setPriority()`・`os.getPriority()` | 自分のプロセスは値を覚える。下げる（nice の値を小さくする）と `EACCES`。ほかの存在する pid は `getPriority` が 0、`setPriority` が `EACCES`。無い pid は `ESRCH` |

## イベントループ

`src/nodejs/loop.ts` が libuv の代わりをします。lib が読む Node の作り（`timers`・`immediateInfo`・`tickInfo`・`async_hooks` の欄）と、Node の出来事の順番を、ブラウザのタスクの上で守ります。

### コールバックの枠

ループから JavaScript に入るところ（タイマー・即時・I/O の完了・カーネルからのメッセージ）は、どれも `scope()` を通ります。C++ の `InternalCallbackScope` にあたるもので、いちばん外側のコールバックが戻ったあと、`tickInfo` が tick か拒否の処理が待っていると言えば `processTicksAndRejections`（`process.nextTick` の列とマイクロタスク）を実行します。枠の外（Promise のジョブの中）で呼ばれた `process.nextTick()` は、マイクロタスクの列が空になってから別のタスクで実行します。それより先に枠に入るコールバックがあれば、そこで先に実行します。

内部のタスクは `MessageChannel` で送ります（`setTimeout(0)` より速い）。

### 段と順番

- **タイマー**: lib のタイマーは全部で 1 つのブラウザの `setTimeout` を共有します（Node の 1 つの `uv_timer` にあたる）。lib が `scheduleTimer(ms)`（最小 1 ms）で予約し、期限の来たタイマーを `processTimers(now)` で実行します。`RunTimers` と同じく、`processTimers` が返した期限が、その中で予約されたタイマーより優先します。ハンドラが握りつぶした捕まえられない例外のあとは、残りの期限の来たタイマーも動くように、もう一度 `processTimers` を呼びます。`uv_now()`（`getLibuvNow`）は、ループが始まってからのミリ秒に 1 を足したものです。
- **即時（check の段）**: 即時が待っているとき、ランタイムは内部のタスクを 2 つ待ってから `processImmediate` を実行します。Node は次の check の段より前に拒否を報告するので、いまのタスクに対するブラウザの `unhandledrejection` を先に通すためです。タイマーの期限が来ていれば、先にタイマーを実行します（ループの 1 周では、check の段より前に期限の来たタイマーが動く）。捕まえられない例外のあとも、残りの即時は同じ段で実行します。コールバックの枠の外（最上位の `await` のあとなど）で作った `setImmediate()` は、自分で順番を取ります。
- **I/O**: カーネルからのメッセージ（`fd-data`・`tcp-accept`・`child-exit` など）は、届いた順に、それぞれ自分の枠の中で処理します。

### 生きているかどうか・ref と unref

次のどれかがある間、ループは生きています。

- 進行中のリクエスト（`startReq`: fs のコールバック・DNS の引き・接続・`fetch` のリクエストと本文の読み・モジュールの読み込み・`WebAssembly.compile` などの見張っている Promise）
- 共有のタイマー（ref されているとき）
- ref されている即時（`immediateInfo[kRefCount] > 0`）
- 動いていて ref されているハンドル（ソケット・パイプ・サーバー・子プロセス・シグナルの見張り・worker・ファイルの見張りなど）

ハンドルの `ref()`／`unref()` や `timeout.unref()` は、それぞれの印を変えます。変わるたびに、ランタイムは生きているかの確認を予約します（内部のタスク 1 つと 2 ms のタイマー。ブラウザが自分で済ませる仕事が間に合うように）。何もループを生かしていないとき:

1. 留めている拒否（下を参照）があれば、先にそれを渡します。
2. 終了の途中でなければ、枠の中で `process.emit('beforeExit', process.exitCode ?? 0)` を実行します。それでループが生き返れば続けます。
3. モジュールの最上位の `await` が終わっていなければ、終了コードを 13 にし、`Warning: Detected unsettled top-level await at <url>:<line>` と、その行と `^` を出します。
4. `process.emit('exit', code)` を実行し、`process.exitCode`（既定は 0）で終わります。

`process.getActiveResourcesInfo()` は、進行中のリクエスト（ハンドルを閉じる処理は除く）、ref されているハンドルのリソース名、ref されているタイマー 1 つにつき `Timeout`、ref されている即時 1 つにつき `Immediate` の順に並べます。`process._getActiveHandles()` と `_getActiveRequests()` は、その持ち主を返します。

### 捕まえられない例外

コールバックから漏れた例外は `process._fatalException` に渡します（Node の `TriggerUncaughtException`）。処理されなければ、エラーを fd 2 に出し、`exit` のハンドラが決めた終了コード、無ければ 1 で終わります。出し方は Node と同じです: 該当する行と `^`（エラーの最初のフレームが、ソースを読めるファイルか組み込みモジュールのとき）、スタック（Node の `enhanceStackForFatalException` を通したもの）、`Node.js v22.23.4`。エラーでない値を投げたときは ``Uncaught <inspect(値)>`` と ``(Use `node --trace-uncaught ...` to show where the exception was thrown)`` を出します。Worker 自身の `error` イベントで届いたエラーも同じに扱います。

### 処理されない Promise の拒否

ブラウザは、拒否が処理されていないことをタスクの終わりに決めます。Node が決めるのは、`processTicksAndRejections` が tick とマイクロタスクを全部片付けたあとです。そのため Worker の `unhandledrejection` は、すぐには Node に渡しません。`nextTick` の仕事が無くなり、さらに `rejectionhandled` が届くためのタスクを 1 つ待つまで留めておきます。留めている間にハンドラが付いた拒否は、黙って捨てます。渡す拒否は Node の Promise の拒否のコールバックに `kPromiseRejectWithNoHandler` として、あとから来た `rejectionhandled` は `kPromiseHandlerAddedAfterReject` として渡します。そこから先は、lib が Node とまったく同じに `--unhandled-rejections` を当てます（既定の `throw` では、エラーを出して終了コードは 1）。

## モジュールの読み込み

### 組み込みモジュール

`require('fs')`・`require('node:fs')`・`import 'node:fs'` は、`nodelib.js` の Node の `lib/` のモジュールを読みます。依存の 2 つは差し替えています（[差し替え](#差し替え) を参照）。`internal/deps/v8/tools/` の V8 のプロファイラーの道具は入れていません。

### CommonJS

Node の CommonJS のローダーがそのまま動きます。ネイティブの部分の `contextify.compileFunctionForCJSLoader` は、各ファイルを `exports, require, module, __filename, __dirname` を引数に取る関数として、間接の `eval` でコンパイルします。ファイルのコードは包む関数の 1 行目に置き（行番号が合うように）、`sourceURL` はファイル名です。先頭の `#!` の行はコメントにします。コンパイルに失敗し、ES モジュールの構文らしいときは（`--experimental-detect-module`。22.23.4 では既定で有効）、Node と同じく lib が ES モジュールとして読み直します。CommonJS のコードの中の `import()` は、Node の `importModuleDynamically` のコールバックに回します。

### ES モジュール

ES モジュールはブラウザの本物のモジュールで、評価もブラウザがします（`src/nodejs/bindings/module_wrap.ts`）。

1. Node の ESM のローダーがソースを解決して読み、`ModuleWrap` を作ります。バインディングは `es-module-lexer` でソースを見て、静的な import と再 export、`import.meta`、`import()` を探します。
2. lib がグラフをつなぐとき、ソースの中の静的な指定子を、つながった先の `ModuleWrap` の URL に書き換えます。import 属性（`with { type: 'json' }`）は配るソースから消します（lib が確かめ済みで、つながった先はいつも JavaScript として配るため）。
3. `import.meta` は `globalThis.__ovImportMeta(<id>)` になり、Node の `initializeImportMeta` のコールバックを呼びます。`import(` は `globalThis.__ovDynamicImport.bind(null, <id>)(` になり、Node の `importModuleDynamically` のコールバックを呼びます。
4. 評価のとき、グラフのモジュールを全部カーネルに登録します（`esmRegister` の syscall）。ランタイムの Service Worker がそれを `/__ov/mw/<pid>/<id>.mjs` で配り、根のモジュールの評価は、その URL のブラウザの `import()` です。リンク・循環・生きた束縛・最上位の `await` は、ブラウザのものがそのまま効きます。プロセスが終わると、カーネルはそのプロセスのモジュールを捨てます。
5. 組み込みモジュール・CommonJS・JSON は、生成した「合成」モジュールとしてブラウザに渡します。export の名前ごとに `var` を 1 つ置いて export し、バインディングの `setExport()` で値を入れます。

モジュールの評価は、そのモジュール自身の本体が動き出すまでリクエストとして数えます（ループは生きている）。そのあと終わらない最上位の `await` は、プロセスを生かしません（終了コード 13。上を参照）。

### require(esm)

ES モジュールの `require()`（22.23.4 では既定で有効）は同期で評価しなければなりませんが、ブラウザはモジュールのグラフを同期で評価できません。そこでバインディングは、グラフのソースのモジュールを、sucrase の `imports` 変換で作った CommonJS の形の関数として実行します（`dist/runtime/ts-strip.js`。要るときに初めて読む）。合成モジュールは評価の手順を直接実行します。最上位の `await` があるグラフは、Node と同じく `ERR_REQUIRE_ASYNC_MODULE` になります。同じモジュールをあとで import すると、ブラウザには `require()` が作った値を再 export する殻のモジュールを渡すので、コードは 2 回動きません。

```js
// m.mjs: export const v = 42; export default function f() { return 'def'; }
const m = require('./m.mjs');
console.log(m.v, m.default()); // 42 def
```

### import.meta

`import.meta.url`（`file://` の URL）・`import.meta.resolve()`・`import.meta.main` は Node のコールバックが入れます。`import.meta.dirname` と `import.meta.filename` は、いまは**入りません**（`undefined`）。Node はこれを `internalBinding('modules').setLazyPathHelpers` で入れますが、ここではそれが何もしないためです。

### 条件・先読み・フック

次は Node の lib が扱い、Node と同じに動きます: `require` と `import` の両方への `--conditions`／`-C`、`--require`／`-r`、`--import`、`--input-type`、`--experimental-default-type`、`module.register()` で登録するモジュールのフック。

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

### vm のモジュール

`vm.SourceTextModule` と `vm.SyntheticModule`（`--experimental-vm-modules` のとき）も同じバインディングで動きます。`vm` で作ったソースのモジュールは、文脈のスコープの中で sucrase の `imports` 変換を使って評価します（[vm](#vm) を参照）。インスタンス化の前に、すべての依頼がつながっていて、import する名前がすべてあることを確かめます（`ERR_VM_MODULE_LINK_FAILURE`、または `SyntaxError: The requested module '<spec>' does not provide an export named '<name>'`）。最上位の `await` があるグラフは、依存を 1 つずつ評価します。同じソースのために作られたのでない `cachedData` は `ERR_VM_MODULE_CACHED_DATA_REJECTED` で断ります。

### コンパイルのキャッシュ

`module.enableCompileCache()` は、キャッシュが無効で、メッセージは `the compile cache is not available in OpenVessel` だと返します。`module.getCompileCacheDir()` は `undefined` です。

## TypeScript

型の除去は Node 自身のものです。Node 22.23.4 では `--experimental-strip-types` が既定で有効で、どのファイルを除去するか（`.ts`・`.mts`・`.cts`、eval の入力では `--input-type=module-typescript`／`commonjs-typescript`）と、どのエラーにするかは lib が決めます。lib が呼ぶ `internal/deps/amaro` は、差し替えで `globalThis.__ovAmaro`（`src/nodejs/typescript.ts`）になります。本物の amaro（Node が同梱するのと同じ版。`process.versions.amaro` は 1.1.8。swc を WebAssembly にしたもので約 3 MB）は `dist/runtime/amaro.js` として配り、初めて何かを除去するときに、ランタイムのオリジンから同期の `XMLHttpRequest` で取ってきて、Worker ごとに 1 回評価します。

| コマンド | 結果 |
|---|---|
| 型の注釈だけの `node a.mts` | 動く |
| `enum` のある `node e.ts` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` |
| `node --experimental-transform-types e.ts` | 動く（ExperimentalWarning が出る）。ソースマップも有効になる |
| `node --no-experimental-strip-types a.mts` | JavaScript のパーサーの `SyntaxError` |

旧ランタイムは代わりに sucrase の `typescript` 変換で型を除去します。こちらは enum など消せない構文も通します。

## fetch と Web のクラス

Node の `fetch`・`Headers`・`Request`・`Response`・`FormData`・`WebSocket`・`EventSource`・`MessageEvent` は `internal/deps/undici` から来ますが、差し替えで `globalThis.__ovUndici`（`src/nodejs/fetch.ts`）になります。undici は TCP のソケットの上で HTTP を話しますが、ブラウザは外へのソケットを開けません。

### 行き先

| URL | 取り方 |
|---|---|
| `data:`・`blob:` | ブラウザの `fetch` で直接 |
| `localhost`・`*.localhost`・`127.0.0.1`・`::1`・`[::1]`・`0.0.0.0` への `http:`／`https:` | Node の `http.request()` で `127.0.0.1` の、URL のポート（無ければ 80。`https:` でも 80）へ。仮想ポートへの本物の TCP の接続なので、OpenVessel の中のサーバーに届く |
| ほかの `http:`／`https:` | ランタイムの Service Worker の `/__ov/net?url=…`。ここで [通信の方針](network-policy.ja.md) を当て、ブラウザの `fetch` で出す |
| それ以外のスキーム | `TypeError: fetch failed`。`cause.code` は `ERR_INVALID_URL`（`unsupported URL scheme <scheme>`） |

### 外への要求の振る舞い

- 要求のヘッダーは `x-ov-h` のヘッダーに入れて運びます。Service Worker は、ページが付けられないものや中継をまたぐと意味の無いもの（`host`・`connection`・`content-length`・`cookie`・`origin`・`referer`・`accept-encoding`・`sec-*`・`proxy-*` など）を落とします。
- 本文は、送る前に全部読みます。`GET` と `HEAD` は本文を持ちません。
- `redirect: 'error'` は守ります。それ以外はリダイレクトをたどります。`response.url` と `response.redirected` は最後の URL を表します。
- 要求は `mode: 'cors'`・`credentials: 'omit'`・`cache: 'no-store'` で出します。相手がオリジンをまたぐ要求を許していなければならず、応答のヘッダーは CORS でブラウザが見せるものだけが見えます。
- 要求と、待っている本文の読みは、それぞれループのリクエスト（`FetchRequest`・`FetchBody`）として数えるので、その間プロセスは生きています。
- `Request` と `Response` は、Node の `AbortSignal`、lib の `ReadableStream`、非同期の反復可能な物を本文として受けます（流す本文は `duplex: 'half'` を伴う）。
- `x-ov-by` のヘッダーで、どのプロセスが頼んだか（pid と argv の最初のいくつか）をホストに伝えます。許可の問い合わせに使います。

### エラー

失敗は `TypeError('fetch failed')` で拒否され、その `cause` がコードを持ちます。

| `cause.code` | いつ |
|---|---|
| `EACCES` | 通信の方針がそのホストを断った: `OpenVessel: network access to <host> was denied by the network policy` |
| `ECONNREFUSED` | ブラウザの `fetch` が失敗した（多くは CORS）: `request to <host> failed: <message>. The server may not allow cross-origin requests (CORS) from the browser.`。ループバックへの接続を断られたときも |
| `ERR_INVALID_URL` | 扱えないスキーム |

ほかの HTTP のクライアント（`http.get`、npm の undici、axios、got）は `net`／`tls` を通ります。カーネルがその HTTP/1.1 の要求を読み、同じ方針つきの中継で出します。その道筋は [通信の方針](network-policy.ja.md) と [カーネル](kernel.ja.md) にあります。

## 差し替え

`src/nodejs/overrides/` にあるものが、Node の `lib/` のファイルの差し替えのすべてです。`scripts/gen-nodelib.mjs` が、そこにある各ファイルを同じ ID の組み込みモジュールの代わりに入れます。

| 組み込みの ID | 差し替え後 | 理由 |
|---|---|---|
| `internal/deps/undici/undici` | `module.exports = globalThis.__ovUndici;`（`src/nodejs/fetch.ts` から） | undici は外への TCP のソケットが要る。fetch は、仮想ポートへは `node:http` で、それ以外へは方針つきの中継で出す |
| `internal/deps/amaro/dist/index` | `module.exports = globalThis.__ovAmaro(require);`（`src/nodejs/typescript.ts` から） | amaro は swc を 3 MB の WebAssembly として抱えている。`nodelib.js` から外し、初めて使うときに取ってくる |

## worker_threads

worker のスレッドは、同じプロセスの別の Web Worker で、カーネルが起こします（`internalBinding('worker')`）。プロセスと同じに起動し、`internal/main/worker_thread` を実行します。親とスレッドは `MessageChannel` でつながり、その上で Node の lib が自分の約束ごとで話します。

- `threadId` はプロセスごとの番号です（カーネルが取っておく）。`isMainThread`・`threadName`・`resourceLimits`・`SHARE_ENV` が使えます。`resourceLimits` は覚えて返しますが、制限はしません。
- `receiveMessageOnPort()` と同期の取り出しは、共有メモリの輪で動きます。`MessageChannel` のポートに来るメッセージは、`v8.serialize` で直列化して、向きごとの輪にも書きます。輪は 16 KiB から始まり 1 MiB まで伸びます（伸びる `SharedArrayBuffer` が無いときは 1 MiB 固定）。この形で直列化できないメッセージは、ふつうの道でだけ届きます。
- `trackUnmanagedFds`（既定）のとき、スレッドが `fs.open` で開いた fd は、スレッドの終了時に閉じます。
- `worker.getHeapStatistics()` は `performance.memory` から作った数を返します。`worker.cpuUsage()` はスレッドが始まってからの経過時間です。`startCpuProfile()`／`stopCpuProfile()` は V8 の形の空のプロファイルを返します。`getHeapSnapshot()` は使えません。
- スレッドは、作られた時点で `/etc/openvessel/node` が選ぶランタイムで動きます。

## child_process

`spawn`・`exec`・`execFile`・`fork` と、それぞれの `Sync` 版は、Node の lib が `process_wrap` と `spawn_sync` の上で動かし、それがカーネルの `spawn`／`spawnSync` を呼びます。あるプログラムは `node` と、カーネルに組み込まれたプログラムです（[プロセス](processes.ja.md) と [シェルとコマンド](shell.ja.md) を参照）。

- stdio の `pipe`・`overlapped`・`inherit`・`ignore`・fd の番号・ストリームのハンドルを渡すことができます。`ipc` の通り道はカーネルのソケットの対です。Node の lib は `NODE_CHANNEL_FD` でそれを見つけ、Node と同じく子の `process.env` からその変数を消します。ハンドル（ソケット・サーバー）を IPC で送れます。
- 自分のものでない `uid`／`gid` は `EPERM` になります。`detached` はカーネルに渡しません。
- `spawnSync`: `timeout`・`killSignal`・`input` はカーネルに渡します。`maxBuffer` を超えると、出力は上限をまたいだ 64 KiB の読み（libuv の読み方）のところで切り、`error` は `ENOBUFS`、`status` は `null`、`signal` は止めるシグナル（既定は `SIGTERM`）になります。
- プロセスの間のシグナル（`process.kill`・`child.kill`・`process.on('SIGINT')`）はカーネルを通ります。

## スタックトレースとエラー

ブラウザの V8 は `Error.prepareStackTrace` を直接呼びます。Node の V8 は C++ のコールバックを呼び、それが Node の JavaScript のコールバックを呼びます。`installStackTraceHook()`（`src/nodejs/boot.ts`）は、C++ がすることをする関数をそこに置きます。

- ランタイム自身（Worker のスクリプト）のフレームと、ランタイムがモジュールやスクリプトをコンパイルするときの間接の `eval` の境目を除きます。利用者自身の `eval`・`new Function` のフレームは残します。
- ブラウザでは、`eval` でコンパイルしたコードの最上位のフレームは `eval (file:line:col)` になります。これを `file:line:col`（CommonJS のモジュールの包みでは `Object.<anonymous> (file:line:col)`）に書き換え、CommonJS のファイルの 1 行目の列から包みの分を引きます。
- `vm.compileFunction` のコードは、ファイル名と行・列のずらしに戻します。
- `CallSite.prototype.getFileName` と `getScriptNameOrSourceURL` を直して、ES モジュールは（配った `/__ov/mw/…` ではなく）`file://` の URL を、`eval` でコンパイルしたコードは `sourceURL` を返すようにします。自分で `Error.prepareStackTrace` を入れるライブラリ（callsites・depd など）にも効きます。
- そのうえで、Node 自身の `prepareStackTrace` のコールバック（`setPrepareStackTraceCallback` で入るもの）が形を整えるので、エラーのメッセージ・`code`・スタックのフレームは Node と同じに読めます。

```text
[eval]:1
console.log(require("fs").readFileSync("/nonexistent"))
                          ^

Error: ENOENT: no such file or directory, open '/nonexistent'
    at Object.openSync (node:fs:560:18)
    at Object.readFileSync (node:fs:444:35)
    at [eval]:1:27
```

残っている違い: `vm` の API で動かすコード（`-e` もそう）には、余分な `at eval (<anonymous>)` のフレームが出ることがあります。`util.getCallSites()` も同じフックから作ります。`getCallerLocation` は `undefined` を返します。致命的なエラーの位置（`getErrorSourcePositions`）は、スタックの最初のフレームから取ります。

## vm

Web Worker は新しい JavaScript の realm を作れないので、`vm` の文脈はまねて作ります（`src/nodejs/bindings/contextify.ts`）。

- 文脈のグローバルは、文脈にした物（サンドボックス）の上のプロキシで、無い名前は ECMAScript の組み込みに落ちます。コードは `with (scope)` の中で動き、自由な名前はサンドボックス、次に組み込みの順に引き、Worker 自身のグローバル（`process`・`require` など）は `undefined` に見えます。
- スクリプトの最上位の `var` と関数の宣言は、V8 と同じくサンドボックスに載り、消せません。最上位と、ただ呼ばれた sloppy な関数の `this` は、文脈のグローバルです。
- `codeGeneration: { strings: false }` は、文脈の `eval`・`Function` を `EvalError: Code generation from strings disallowed for this context` を投げるものにします。`{ wasm: false }` では `WebAssembly.compile` などが `WebAssembly.<fn>(): Wasm code generation disallowed by embedder` で失敗します。
- `vm.constants.DONT_CONTEXTIFY` は、ふつうのグローバルオブジェクトを返します。
- `cachedData`: V8 のコードのキャッシュは作れません。`createCachedData()` は 16 バイトの記録（`OVC1`、ソースの長さとハッシュ 2 つ）を返し、ソースに合わない `cachedData` は V8 と同じように断ります。
- `vm.measureMemory()` は `performance.memory.usedJSHeapSize` を返します。

まねできないもの: 別の組み込み（`vm.runInContext('Array', ctx) === Array` は `true`）、`timeout` と `breakOnSigint`（受け付けるが、終わらないスクリプトは止まらない）、`microtaskMode`。

## AsyncLocalStorage

Node は非同期の文脈を、V8 の Promise のフックで Promise に沿って運びます。ブラウザはこのフックを見せないので（`setPromiseHooks` は何もしない）、`AsyncLocalStorage.run()`／`enterWith()` で入れた文脈は、同期のコードと、最初の `await` より前に予約したコールバック（`process.nextTick`・タイマー・即時・I/O）では見えますが、`await` のあとでは失われます。

```js
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
als.run(42, async () => {
  console.log(als.getStore()); // 42
  await null;
  console.log(als.getStore()); // undefined
});
```

`async_hooks.createHook()` のフックは、lib が JavaScript で作るリソース（`Timeout`・`Immediate`・`TickObject`・`AsyncResource` など）と、worker・メッセージのポートで呼ばれます。ネイティブのハンドルとリクエストの多く（ファイルシステムのリクエスト・ソケット・パイプ）は `init` を報告せず、Promise のフックは呼ばれません。

## インスペクター・プロファイル・診断

- `node:inspector` は読み込めます。`inspector.url()` は `undefined`、`open()` と `waitForDebugger()` は何もしません。`Session` に送ったプロトコルのメッセージには、どれも非同期にエラー `-32601`（`The inspector is not available in OpenVessel`）を返します。console の呼び出しは Node の console にだけ行きます。
- V8 のカバレッジ（`NODE_V8_COVERAGE`）: ディレクトリは受け付けますが、何も書きません。
- ヒープのスナップショット（`v8.getHeapSnapshot()`・`v8.writeHeapSnapshot()`）は `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` を投げます。
- `v8.getHeapStatistics()` などは `performance.memory` から作った数を返します。`v8.setFlagsFromString()` はフラグを覚えますが、何も変えません。
- `perf_hooks.monitorEventLoopDelay()` はブラウザの interval のタイマーで測ります。`createHistogram()` は Node と同じ区切りの HdrHistogram の移植です。`eventLoopUtilization()` の待ち時間はいつも 0 です。
- トレースのイベントは無効です（`trace_events` の分類が有効になることはない）。

## 実装していないもの

次のものは読み込めますが、使うと失敗します。特に書いていなければ `ERR_NOT_IMPLEMENTED`（`internalBinding ('<name>').<member> is not implemented in OpenVessel`）です。

| 機能 | 振る舞い |
|---|---|
| `node:http2` | `require` はでき、`http2.createServer()` もサーバーを返すが、セッションを作る（接続を受ける、`http2.connect()`）と `ERR_NOT_IMPLEMENTED`（`Http2Session`） |
| `node:sqlite` | `new DatabaseSync()` が失敗する |
| `node:sea` | `sea.isSea()` などが失敗する |
| `net.BlockList`・`net.SocketAddress` | 作ると失敗する（`block_list`） |
| JavaScript のストリーム（ネイティブのソケットでないもの）を渡す `tls.connect({ socket })` | 失敗する（`js_stream`） |
| `localStorage`・`sessionStorage` | 使えない（`webstorage`） |
| `--permission` | `process.permission.has()` が失敗する（`permission`） |
| ネイティブのアドオン | `process.dlopen` はいつも失敗する（上を参照） |

各モジュールのバインディングの単位の状況は [バインディング](bindings.ja.md) にあります。

## 関連するページ

- [バインディング](bindings.ja.md) — すべての `internalBinding()` のモジュールとその状況
- [プロセス](processes.ja.md)・[カーネル](kernel.ja.md)・[通信の形式](protocol.ja.md) — カーネルの側
- [通信の方針](network-policy.ja.md) — 外への要求にできること
- [互換性](../compatibility.ja.md) — 計った結果とプラットフォームの限界
- [しくみ](../how-it-works.ja.md)
