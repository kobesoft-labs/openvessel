# バインディング

[English](bindings.md)

Node の `lib/` は `internalBinding(name)` を通して C++ の半分とやり取りします。このページは、移植版ランタイムが知っているバインディングの名前を全部挙げ、それぞれをどのファイルが実装しているか、どこまでできているか、どうまねているかを示します。あわせて、バインディングを本物の Node とどう突き合わせて試験しているかを説明します。ランタイム全体の振る舞いは [Node.js の層](nodejs-runtime.ja.md) にあります。

## バインディングの引き方

`getInternalBinding(name)`（`src/nodejs/bindings/index.ts`）は、各バインディングを初めて使うときに作り、スレッドが終わるまで取っておきます。

1. `factories[name]` があれば、その関数がバインディングを作ります。ほとんどの関数は `fromShape(name)` から始めて、自分のメンバーを上に載せます。
2. 無ければ、`fromShape(name)` だけがバインディングになります。
3. 関数が無く、記録した形も空（Node v22.23.4 にも無いバインディング）なら、コード `ERR_INVALID_MODULE` の `Error: No such binding: <name>` を投げます。`getLinkedBinding()` はいつもこのエラーを投げます。

`fromShape()`（`src/nodejs/bindings/shape.ts`）は、本物の Node から `src/node/data/bindings.json` に記録した形を、実物にします（[ビルド](building.ja.md#gen-node-datamjs) を参照）。

| 記録の形 | 実物 |
|---|---|
| 数・文字列・真偽値・`null` | 同じ値 |
| `{ __num }`・`{ __bigint }`・`{ __symbol }` | `NaN`／`Infinity`、BigInt、その説明を持つ新しい Symbol |
| `{ __typed, length, values }` | そのクラスと長さの型付き配列（記録した値が 64 個以下なら中身も入れる） |
| `{ __map }`・`{ __set }` | `Map`／`Set` |
| プロトタイプのメソッドの無い `{ __fn }` | `ERR_NOT_IMPLEMENTED` を投げる関数（静的なメンバーは写す） |
| `{ __fn, proto }` | コンストラクタとプロトタイプのメソッドが `ERR_NOT_IMPLEMENTED` を投げるクラス |
| `{ __ref }`・`{ __object }`・`{ __array }`・`{ __throws }`・`{ __missing }` | `undefined` |
| `@@` で始まるキー（Symbol のキー） | 入れない |

エラーは `code: 'ERR_NOT_IMPLEMENTED'` の `Error: internalBinding <path> is not implemented in OpenVessel` で、`<path>` はメンバーの名前です（たとえば `('sqlite').DatabaseSync`・`('crypto').DHBitsJob`）。そのため、バインディングの定数・列挙・表は Node とまったく同じで（Linux x64 の値: errno・シグナル・`O_*`・zlib と crypto の定数など）、実装の無いメンバーは `undefined` にならず、呼んだときにはっきり失敗します。

`registerBinding(name, factory)` で関数を足したり差し替えたりできます。

## 状況の見方

| 状況 | 意味 |
|---|---|
| 実装済み | lib が使うメンバーにすべて本当の実装がある |
| 一部 | 実装はあるが、記録した形のままの空のメンバー（`ERR_NOT_IMPLEMENTED`）や、わざと何もしないメンバーがある |
| 形だけ | 作る関数が無い。定数だけで、関数はどれも `ERR_NOT_IMPLEMENTED` を投げる |
| 無し | Node v22.23.4 にも無い。`internalBinding()` が `ERR_INVALID_MODULE` を投げる |

## プロセス・ループ・ランタイム

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `async_wrap` | `process.ts` | 一部 | `async_hook_fields`・`async_id_fields`・`async_ids_stack` は `AsyncHooks` の初めの状態から始める（吸い出しがコールバックの中で取られたため）。`pushAsyncContext`／`popAsyncContext`／`executionAsyncResource`／`clearAsyncIdStack` は C++ と同じ。destroy の ID はあとのタスクでまとめて流す。スタックの ID は、`grow_async_ids_stack` と同じに大きくなる（バインディングの上で差し替える）`Float64Array` に持つ。ネイティブのリソースは `AsyncWrap`（`process.ts` の `emitAsyncInit`）: 作られたときに `kAsyncIdCounter` から ID をもらって `init` のフックを呼び、`loop.scope()` がそのコールバックの前後で非同期の文脈を出し入れして `before`／`after` を呼び（`InternalCallbackScope`）、ハンドルが閉じたとき・リクエストが終わったときに `destroy` を積む。`getProviderType()` は `Providers` の数を返す（[Node.js の層](nodejs-runtime.ja.md#asynclocalstorage) を参照）。`setPromiseHooks`・`getPromiseHooks`・`registerDestroyHook`・`setCallbackTrampoline` は何もしない（V8 の Promise のフックが無い） |
| `builtins` | `src/nodejs/boot.ts` | 実装済み | `nodelib.js` から作る: `builtinIds`・`compileFunction`・`natives`・`setInternalLoaders`・`hasCachedBuiltins`・`getCacheUsage` |
| `config` | `process.ts` | 実装済み | 記録した値。ただし `hasInspector: true`・`isDebugBuild: false`・`noBrowserGlobals: false`・`getDefaultLocale()` は `en-US` |
| `constants` | `index.ts` | 実装済み | 記録した `os`・`fs`・`crypto`・`zlib`・`trace`・`internal` の組。`NODE_DEFINE_CONSTANT` と同じく、どの組もプロトタイプが null で、どの定数も書き換え・削除できない |
| `credentials` | `process.ts` | 実装済み | uid・gid・euid・egid は 1000、グループは `[1000]`。`setuid` などは今の ID だけ受け付ける（ほかは `EPERM`）。名前は `/etc/passwd`・`/etc/group` で引く。`safeGetenv`。`getTempDir`（`TMPDIR`・`TMP`・`TEMP`・`TEMPDIR`・`/tmp`） |
| `errors` | `process.ts` | 実装済み | `setPrepareStackTraceCallback` と `setEnhanceStackForFatalException` はスタックトレースのフックへ。`triggerUncaughtException` はループへ。`getErrorSourcePositions` はスタックの最初のフレームから読む。ソースマップの設定は何もしない |
| `mksnapshot` | `process.ts` | 一部 | 設定の関数は何もしない。`compileSerializeMain` は空（スナップショットは作れない） |
| `options` | `index.ts` | 実装済み | `getCLIOptionsValues()` は解析したコマンドラインを返す。オプションの情報・別名・埋め込み側のオプション・`envSettings`・`types` は吸い出したもの。`noGlobalSearchPaths: false`・`shouldNotRegisterESMLoader: false` |
| `os` | `process.ts` | 実装済み | 値は [Node.js の層](nodejs-runtime.ja.md#process-と-os-の値) を参照。`getOSInformation()` は `node_os.cc` が uname を返すのと同じ `[sysname, version, release, machine]` |
| `process_methods` | `process.ts` | 実装済み | `hrtime`、`cwd`／`chdir`／`umask`（カーネル）、`memoryUsage`／`rss`／`cpuUsage`／`resourceUsage`（近い値）、`_kill`、`reallyExit`（`--trace-exit`）、`dlopen`（いつも失敗）、`execve`、`patchProcessObject`、`loadEnvFile`、ループから取る動いているハンドル・リクエスト。`_debugProcess`・`_debugEnd`・`resetStdioForTesting` は何もしない |
| `report` | `report.ts` | 実装済み | Node のレポートの形で、頭の部分は glibc の Linux のもの（`glibcVersionRuntime` 2.36・`glibcVersionCompiler` 2.28。`cpus` と `networkInterfaces` は `os` のバインディングから）。`writeReport` はカーネルを通して書く。設定は覚える |
| `symbols` | `process.ts` | 実装済み | 記録した説明を持つ新しい Symbol |
| `task_queue` | `process.ts` | 実装済み | `tickInfo` を包み、コールバックの枠の外の `nextTick` で tick のタスクを予約する。`enqueueMicrotask` はブラウザの `queueMicrotask`。`runMicrotasks` は何もしない（マイクロタスクはブラウザが流す）。`setPromiseRejectCallback` には、Worker の拒否のイベントがループを通して届く |
| `timers` | `process.ts` → `src/nodejs/loop.ts` | 実装済み | lib のタイマー全部で 1 つのブラウザのタイマー。`immediateInfo`・`timeoutInfo`・`toggleImmediateRef`・`getLibuvNow` |
| `trace_events` | `process.ts` | 一部 | トレースしない。分類は有効にならず、`trace()` は何もしない |
| `uv` | `process.ts` | 実装済み | 記録した Linux のエラーの表から `errname`・`getErrorMap`・`getErrorMessage`。`UV_*` の定数は全部ある |
| `performance` | `process.ts`・`performance.ts` | 実装済み | `now`、`milestones`（時刻の起点・起動の完了）、`Histogram`（Node と同じ区切りの HdrHistogram_c の移植）、`createELDHistogram`（ブラウザの interval のタイマーで測る）。`loopIdleTime()` は 0、`uvMetricsInfo()` は `[0, 0, 0]`。GC の見張りとオブザーバーは何もしない |
| `profiler` | `inspector.ts` | 一部 | V8 のカバレッジ: ディレクトリは受け付けるが、何も集めない |
| `inspector` | `inspector.ts` | 一部 | `Connection`／`MainThreadConnection` はどのメッセージにもエラー `-32601` を返す。`url()` は `undefined`。`open`・`waitForDebugger`・非同期のタスクのフックは何もしない。`consoleCall` は Node の console のメソッドだけを呼ぶ |
| `heap_utils` | `heap_utils.ts` | 一部 | どの関数も `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`（`The feature heap snapshots is unavailable on the current platform…`）を投げる |
| `v8` | `v8.ts` | 一部 | ヒープ・コード・領域の統計は `performance.memory` から作る。`cachedDataVersionTag()` は既定のフラグでの Node の値。`setFlagsFromString` はフラグを覚えるだけ。`GCProfiler` は中身の無いプロファイルを返す。`isStringOneByteRepresentation` |
| `internal_only_v8` | `index.ts` | 一部 | `queryObjects()` は `[]`（ヒープを見られない） |
| `util` | `util.ts` | 実装済み | V8 の中を見る関数を型の確かめ（brand check）で行う（`isPromise`・`isDate` など）。Proxy の中身は記録した `Proxy` から。`previewEntries` は Map／Set の反復子（WeakMap／WeakSet の中身は JS から一覧できない）。`getPromiseDetails`（状態が分かるのはランタイムが自分で決着させた Promise だけ。ほかは pending と答える）、`getOwnNonIndexProperties`、`getConstructorName`、`getCallSites`、`sleep`（`Atomics.wait`）、`parseEnv`、`guessHandleType`（カーネルの `fdKind`）、`isInsideNodeModules`（スタックから）。private な Symbol は `Object.prototype` のアクセサでまねる。`getCallerLocation` は `undefined`、`getExternalValue` は `0n` |
| `types` | `util.ts` | 実装済み | 同じ型の確かめ。`isExternal` はいつも `false`。`isModuleNamespaceObject` も型の確かめ |
| `watchdog` | — | 形だけ | `--trace-sigint` |

## ファイルシステム

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `fs` | `fs.ts` | 一部 | どの呼び出しも、同期（`UVException` を投げる）・コールバック（`FSReqCallback`。あとのターンで完了）・Promise（`kUsePromises`）のどれかで、カーネルの syscall の上で動く。stat は Node の共有の stat の配列に書く。`statfs` は決まった値（種類 `0xef53`・ブロックの大きさ 4096）。`chown`／`fchown`／`lchown` は対象があるかだけを確かめ、`fsync`／`fdatasync` は fd だけを確かめる。`cpSyncCheckPaths`／`cpSyncOverrideFile`／`cpSyncCopyDir` は `node_file.cc` を再現。`StatWatcher` はブラウザのタイマーで見に行く。`FileHandle` は別のスレッドへ（fd として）渡せる。worker のスレッドが管理外で開いた fd は終了時に閉じる。`FileHandle` の StreamBase のメンバー（`readStart`・`writev`・`onread` など）は記録した空のまま |
| `fs_dir` | `fs_dir.ts` | 実装済み | カーネルにディレクトリのストリームは無いので、`opendir` が種類つきの中身の写しを取り、`read()` が `bufferSize` ずつ渡す |
| `fs_event_wrap` | `fs_event_wrap.ts` | 実装済み | カーネルの `watch`／`unwatch`。出来事を libuv の inotify の版が出す形にする（子の名前と `rename`／`change`、見ているパスの最後の名前、recursive では相対パス）。見ている inode が消されるか置き換えられると、それ以後は何も報告しない |

## ストリーム・パイプ・端末

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `stream_wrap` | `stream.ts` | 実装済み | `LibuvStreamWrap`・`WriteWrap`・`ShutdownWrap`・`streamBaseState`。`StreamBase` と同じに、`WriteWrap` はすぐに終わらない書き込みのときだけ、`ShutdownWrap` は `shutdown()` のときに `AsyncWrap` になる。読みは `readStart()` のあと、カーネルの `fd-data` のメッセージで届く。`readStop()` のあとに届いたものは次の `readStart()` まで取っておく。fd 0〜2 への書き込みは同期で全部書く。ほかのパイプとソケットは、カーネルの入れ物に入る分だけ書き、残りは読み手が空けたとき（`fd-writable`）に書くので、書き手には背圧が見える。`shutdown()` は相手に EOF を送る |
| `pipe_wrap` | `stream.ts` | 実装済み | カーネルの fd の上のパイプ。Unix ドメインソケット（`bind` がソケットの inode を作り、接続ごとに新しいカーネルのソケットの対ができる。`pipe-accept`）。IPC のパイプはハンドルを運べる |
| `tty_wrap` | `stream.ts` | 実装済み | `isTTY` はカーネルの `fdKind` から。`getWindowSize`（`ttySize`）・`setRawMode` |
| `js_stream` | — | 形だけ | JavaScript の `Duplex` をネイティブのストリームとして包むもの（ネイティブでないソケットを渡す `tls.connect({ socket })` など）は失敗する |
| `stream_pipe` | — | 形だけ | |

## ネットワーク

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `tcp_wrap` | `net.ts` | 実装済み | TCP のソケットは仮想ポートの上のカーネルのソケットの対。`listen` はポートを登録し、接続ごとに新しい fd が `tcp-accept` で届く。ループバックのアドレスへの `connect` は、カーネルに片方の端をもらう（同じスレッドのサーバーへの接続は、その accept のあとに完了する）。ほかのアドレスへの `connect` は `tcpConnectOut` を呼ぶ。その接続の HTTP/1.1 の通信は、カーネルが通信の方針を通して出す。結果は失敗も含めて非同期に報告する。`setNoDelay`・`setKeepAlive` は受け付けるだけ。listen しているソケットはほかのプロセスと共有できる |
| `cares_wrap` | `net.ts` | 実装済み | DNS は無い。IP の文字列はそのまま、`localhost`／`*.localhost` は `127.0.0.1` と `::1`、ほかの名前は `198.18.0.0/15` の代わりのアドレス（名前ごとに決まり、外への橋渡しが名前に戻す）。ほかの名前の IPv6 の引きはデータ無し（`EAI_NODATA`）。`ChannelWrap` の問い合わせ: `queryA`／`queryAny` は上と同じ、`queryAaaa` は localhost だけ、ほかは `ENODATA`。既定のサーバーは `127.0.0.53:53` |
| `udp_wrap` | `udp.ts` | 実装済み | ループバックだけ。カーネルが、データグラムをそのポートの受け手の 1 つに渡す（`udp-msg`）。IPC で送ったソケットはプロセスの間で共有する |
| `js_udp_wrap` | — | 形だけ | |
| `tls_wrap` | `tls_wrap.ts` | 一部 | 通信路の上の TLS は無い。外への接続では、ブラウザの `fetch` が TLS をして証明書を確かめるので、`TLSWrap` は平文をそのまま通し、ハンドシェイクは済んだと報告する（`verifyError()` は `null`）。`getPeerCertificate()` は代わりの物（subject は `CN=<servername>`、issuer は `O=OpenVessel, CN=verified by the browser`、1 日前から 90 日有効）を、`getPeerX509Certificate()` は `undefined` を返す。ランタイムの中の 2 つの端の間では、両方とも素通しで、「ハンドシェイク」はカーネルを通した証明書の受け渡し（`tlsHello`）なので、`getPeerCertificate()`／`getPeerX509Certificate()` には相手の証明書が見える。サーバーの `TLSWrap` は、包んだソケットの読みを引き継ぐ（lib が包むとき、ソケットはもう読んでいる）。`SecureContext` は設定を覚える。`loadPKCS12` は中身を読んで MAC を確かめる。`addCRL` は形式を確かめる。StreamBase のメンバーのいくつか（`bytesRead`・`onread` など）は記録した空のまま |
| `http_parser` | `http_parser.ts`・`http/llhttp.ts` | 実装済み | `HTTPParser` は llhttp 9.4.3（Node 22.23.4 が同梱する版。`process.versions.llhttp`）を節ごとに移したものの上で動くので、コールバック・エラーのコード・理由・エラーの位置が C のパーサーと同じ。サーバーのタイムアウトのための `ConnectionsList`。ヘッダーの大きさの上限の既定値は `--max-http-header-size`（16384）。`getProviderType()` は `initialize()` のあと 17／18（`HTTPINCOMINGMESSAGE`／`HTTPCLIENTREQUEST`）。ほかのオブジェクトの上で呼んだメソッドは `TypeError: Illegal invocation` を投げる |
| `http2` | `index.ts` | 一部 | 記録した形に、何もしない `setCallbackFunctions` と `refreshDefaultSettings` を足したもの。そのため `node:http2` は読み込める。`Http2Session`・`Http2Stream`・`packSettings`・`nghttp2ErrorString` は `ERR_NOT_IMPLEMENTED` を投げる空のものなので、HTTP/2 のセッションはどれも失敗する（[Node.js の層](nodejs-runtime.ja.md#実装していないもの) を参照） |
| `block_list` | — | 形だけ | `net.BlockList`・`net.SocketAddress` |

## 子プロセスとシグナル

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `process_wrap` | `process_wrap.ts` | 実装済み | `Process.spawn` → カーネルの `spawn`（stdio は `pipe`・`overlapped`・`ipc`・`inherit`・`ignore`・fd・`wrap`）。今のものでない `uid`／`gid` は `EPERM`。`detached` は渡さない。終了は `child-exit` で届く |
| `spawn_sync` | `process_wrap.ts` | 実装済み | カーネルの `spawnSync`（`timeout`・`killSignal`・`input`）。`maxBuffer` は上限をまたいだ 64 KiB の読みで切り、`ENOBUFS` |
| `signal_wrap` | `process_wrap.ts` | 実装済み | `Signal.start(signum)` がカーネルに登録する（`sigaction`）。シグナルは `signal` のメッセージで届く |

## モジュールとコード

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `contextify` | `contextify.ts` | 一部 | `compileFunctionForCJSLoader`・`ContextifyScript`・`compileFunction`・`containsModuleSyntax`（acorn／es-module-lexer）・`makeContext`（まねた文脈: プロキシのグローバルと `with` のスコープ）・`measureMemory`。SIGINT の見張りの関数は何もしない。`timeout`／`breakOnSigint` と `microtaskMode` は効かない。`cachedData` はソースの 16 バイトの記録（`OVC1`）で、V8 と同じように確かめる |
| `module_wrap` | `module_wrap.ts` | 実装済み | `ModuleWrap`（ソースと合成）。ブラウザへは `/__ov/mw/<pid>/<id>.mjs` で配る。`link` は 22.23 の `link(modules)` と前の `link(specifiers, modules)` の両方を受ける。`require(esm)` のための `evaluateSync` は sucrase で。`createRequiredModuleFacade`。`throwIfPromiseRejected` は何もしない |
| `modules` | `modules.ts` | 一部 | `readPackageJSON`・`getNearestParentPackageJSON(Type)`・`getPackageScopeConfig`・`getPackageType` をカーネルのファイルの読みの上で。スレッドごとに覚え、Node と同じ組（`imports`／`exports` は JSON の文字列）で返す。JSON が壊れていれば `ERR_INVALID_PACKAGE_CONFIG`。コンパイルのキャッシュ: `enableCompileCache` は無効と答える。`setLazyPathHelpers` は `file:` の URL に `import.meta.dirname`／`filename` を入れる |
| `wasi` | `wasi.ts` | 実装済み | `WASI` は `src/node/wasi.ts`（旧ランタイムと共用）の preview1 の関数にバインディングの形を与える。ファイルはカーネルを通る。`proc_exit` はプロセスを終える。`sock_*` は `ENOSYS` を返す |
| `wasm_web_api` | `index.ts` | 実装済み | `setImplementation` は何もしない。`WebAssembly.compileStreaming`／`instantiateStreaming` はブラウザのもの |
| `sea` | — | 形だけ | `node:sea` は読み込めるが、関数は投げる |

## worker とメッセージ

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `worker` | `worker.ts` | 実装済み | `Worker` はカーネルを通してスレッドを起こす（`threadReserve`・`threadSpawn`・`threadKill`）。`getEnvMessagePort`。`threadId` はプロセスごと。`SHARE_ENV`。`execArgv`／`NODE_OPTIONS` の確かめ。`resourceLimits` は覚えるが制限しない。ヒープの統計と CPU の使用は近い値、CPU のプロファイルは空、`takeHeapSnapshot` は使えない |
| `messaging` | `messaging.ts` | 実装済み | `MessagePort` はブラウザの `MessagePort`（またはプロセス全体の `BroadcastChannel` の組）を包む。メッセージはブラウザの structured clone で写し、その前後に Node の `Message::Serialize` の決まりを当てる（転送の一覧の確かめとエラーは Node の順、ポート・lib の JS の転送できる物・登録したホストのオブジェクトは参照として運ぶ）。`receiveMessageOnPort`／drain は向きごとの共有メモリの輪（16 KiB から 1 MiB まで伸びる）を読む。`structuredClone`・`moveMessagePortToContext`・`exposeLazyDOMExceptionProperty`・`broadcastChannel` |
| `serdes` | `serdes.ts` | 実装済み | `Serializer`／`Deserializer` は V8 の `ValueSerializer` の移植（V8 12.4 が書く wire format 15）。ブラウザから分からないものは近づける: int32 の範囲の整数は Smi、Smi でない数を含む穴の無い数の配列は `PACKED_DOUBLE`、すべての符号単位が 0xFF 以下の文字列は 1 バイトの文字列。Proxy はトラップを通して直列化し、ホストのオブジェクトは見分けられない |
| `async_context_frame` | — | 形だけ | `--experimental-async-context-frame` |
| `locks` | — | 無し | |

## バッファ・エンコーディング・URL・国際化

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `buffer` | `buffer.ts` | 実装済み | slice・write・compare・fill・indexOf・swap の関数全部、`byteLengthUtf8`・`isUtf8`・`isAscii`・`atob`／`btoa`・`createUnsafeArrayBuffer`。`kStringMaxLength` は 0x1fffffe8 で、Node の「Cannot create a string longer than …」のエラー。Node の起動がバインディングから消す `getZeroFillToggle` と `setBufferPrototype` もある |
| `blob` | `blob.ts` | 実装済み | blob は部分（バイト列・ほかの blob・`createBlobFromFilePath` では使うときに読むファイル）の並びと窓。`concat`・`storeDataObject`／`getDataObject`／`revokeObjectURL` |
| `encoding_binding` | `encoding.ts` | 実装済み | `encodeInto`・`encodeUtf8String`・`decodeUTF8`（`ignoreBOM` でなければ先頭の BOM を除く。`fatal`）・`decodeWindows1252`・`toASCII`／`toUnicode`（ASCII でないドメインは、その環境の URL のパーサーで写す） |
| `string_decoder` | `string_decoder.ts` | 実装済み | `lib/string_decoder.js` が持つ状態のバッファの上で `decode`／`flush` |
| `url` | `url.ts`・`whatwg-url.ts` | 実装済み | 解析は URL Standard のパーサーを ada と同じように書いたもの（ブラウザの `URL` は解析に使わない）。`url_components` の位置は解析した結果から計算し直す。`canParse`・`format`・`getOrigin`・`pathToFileURL`・`update`・`domainToASCII`／`domainToUnicode` |
| `icu` | `icu.ts` | 実装済み | ICU は無い。`getStringWidth` は Node の ICU から吸い出した表で。`transcode` は Node のエンコーディングの間で。`getConverter`／`decode` はその環境の `TextDecoder` の上で（`x-user-defined` の `hasConverter` は false）。`icuErrName` |
| `url_pattern` | — | 無し | |
| `webstorage` | — | 形だけ | `localStorage`・`sessionStorage` |
| `permission` | — | 形だけ | `--permission` |
| `sqlite` | — | 形だけ | `node:sqlite` |
| `quic` | — | 無し | |

## 暗号

`internalBinding('crypto')`（`crypto.ts`）は、`src/nodejs/bindings/crypto/` のファイルを組み合わせたもので、`@noble/hashes`・`@noble/ciphers`・`@noble/curves` と BigInt の計算の上で動きます。Node が同期でするものは同期のままで、非同期の `CryptoJob` はイベントループを通してあとのタスクで完了します。エラーは OpenSSL の形（`ERR_OSSL_*` のコード・ライブラリ・理由）です。状況は**一部**です: `DHKeyExportJob`・`DHBitsJob`・`internalVerifyIntegrity` は空で、`SecureContext` の裏に OpenSSL の文脈はありません。

| ファイル | 受け持ち |
|---|---|
| `crypto/hash.ts` | `Hash`・`Hmac`・`oneShotDigest`・`HashJob`・`HmacJob`・`getHashes`・`getCachedAliases` |
| `crypto/digests.ts` | OpenSSL 3 が名前で出すダイジェスト: MD5・SHA-1・SHA-224/256/384/512・SHA-512/224・SHA-512/256・SHA3-224/256/384/512・SHAKE128/256（XOF）・RIPEMD-160・BLAKE2b-512・BLAKE2s-256・SM3・MD5-SHA1。OpenSSL の別名（`RSA-SHA256`・`sha256WithRSAEncryption` など）も。汎用の HMAC・PBKDF2・HKDF |
| `crypto/sm3.ts` | SM3 |
| `crypto/cipher.ts`・`blockcipher.ts`・`chacha.ts`・`tables.ts` | `CipherBase`・`getCiphers`・`getCipherInfo`・`getSSLCiphers`。OpenSSL 3 の流し方の決まりどおり: AES-128/192/256 の CBC・CFB・CFB1・CFB8・CTR・ECB・GCM・CCM・OCB・OFB・鍵の包み（詰め物あり・なし）。DES と 3DES（EDE・EDE3）の ECB・CBC・CFB・OFB と 3DES の包み。ChaCha20 と ChaCha20-Poly1305（暗号の名前は 68 個。情報は `tables.ts` に Node から生成） |
| `crypto/kdf.ts` | `PBKDF2Job`・`ScryptJob`・`HKDFJob` |
| `crypto/random.ts` | `RandomBytesJob`・`RandomPrimeJob`・`CheckPrimeJob`・`secureBuffer`・`secureHeapUsed` |
| `crypto/keys.ts` | `KeyObjectHandle`（秘密鍵）・`NativeKeyObject`・`SecretKeyGenJob` |
| `crypto/asymkeys.ts`・`asn1.ts` | 非対称の鍵の中身と、その形式: SPKI・PKCS#8（そのままと PBES2 の暗号化）・PKCS#1・SEC1・PEM（古い `Proc-Type` の暗号化も）・JWK・raw |
| `crypto/asym.ts` | `Sign`・`Verify`・`SignJob`、鍵の対を作るジョブ（`RsaKeyPairGenJob`・`DsaKeyPairGenJob`・`DhKeyPairGenJob`・`EcKeyPairGenJob`・`NidKeyPairGenJob`）、`ECDH`・`ECDHConvertKey`・`statelessDH`、`publicEncrypt`／`privateDecrypt`／`privateEncrypt`／`publicDecrypt`。曲線は `secp224r1`・`secp256k1`・`secp384r1`・`secp521r1`・`prime256v1`。Ed25519・Ed448・X25519・X448 |
| `crypto/rsa.ts` | RSA の鍵の生成、CRT、PKCS#1 v1.5 と PSS の署名、PKCS#1 v1.5 と OAEP の暗号化（RSA・RSA-PSS の鍵） |
| `crypto/dsa.ts`・`dh.ts` | DSA（FIPS 186-4）のパラメーターと署名。`DiffieHellman`・`DiffieHellmanGroup`（BigInt の上の有限体の DH） |
| `crypto/webcrypto.ts` | `crypto.subtle` の裏のジョブ: `AESCipherJob`・`ECDHBitsJob`・`ECKeyExportJob`・`RSAKeyExportJob`・`RSACipherJob` |
| `crypto/x509.ts` | `parseX509` と `X509Certificate` のハンドル。DER を読み（RFC 5280）、名前と拡張は Node が出すのと同じ形にする |
| `crypto/spkac.ts` | `certVerifySpkac`・`certExportPublicKey`・`certExportChallenge` |
| `crypto/pkcs12.ts` | `SecureContext.loadPKCS12` のための PKCS#12 の読みと MAC の確かめ |
| `crypto/util.ts` | エラーの形・バイト列の受け取り・`CryptoJob` の約束（同期の `run()` は `[err, result]`、非同期は `ondone`） |
| `tls_wrap.ts` | `SecureContext`（ネットワークを参照） |

`crypto.ts` にはほかに: `timingSafeEqual`。証明書の置き場は空（TLS はブラウザがするので、`getBundledRootCertificates()`・`getSystemCACertificates()` などは `[]`）。FIPS は切れている（`getFipsCrypto()` は 0、`setFipsCrypto()` は何もしない）。`getOpenSSLSecLevelCrypto()` は 1、`setEngine()` は `false`。

## 圧縮

`internalBinding('zlib')`（`zlib.ts`）。状況は**実装済み**です。

| クラス・関数 | 中身 |
|---|---|
| `Zlib`（deflate・inflate・gzip・gunzip・raw・unzip） | `zlib/zlib-context.ts`。pako 3 の zlib の `z_stream` の移植の上で。pako は Node の（Chromium の）zlib と同じハッシュを使うので、deflate の出力は Node とバイト単位で同じ |
| `BrotliEncoder`・`BrotliDecoder` | `zlib/brotli.ts`。brotli 1.1.0 を WebAssembly にしたもの（Node が当てているデコーダーの修正つき）を、raw deflate と base64 にして `zlib/brotli-wasm.ts` に埋めている。パラメーターはすべて `BrotliEncoderSetParameter`／`BrotliDecoderSetParameter` にそのまま渡す |
| `ZstdCompress`・`ZstdDecompress` | `zlib/zstd.ts`。zstd 1.5.7 を WebAssembly にしたもの（`zlib/zstd-wasm.ts`）。1 スレッドで動く（`ZSTD_c_nbWorkers > 0` は、マルチスレッドでないビルドと同じく断る） |
| `crc32` | 表を引く |

WebAssembly のモジュールは初めて使うときに同期で展開・コンパイルし、プロセスのすべてのストリームがライブラリごとに 1 つのインスタンスを共有します（ブラウザは、同時に生きている WebAssembly のメモリの数を限るため）。`write()` は仕事を予約して、あとのタスクで完了します（スレッドプールの往復にあたる）。`writeSync()` はその場で実行します。エラーは `handle.onerror(message, errno, code)` に渡します。WebAssembly のモジュールを作り直すのはライブラリの版を変えるときだけで、`src/nodejs/bindings/zlib/wasm/build.mjs` を使います（[ビルド](building.ja.md#ほかの生成の道具) を参照）。

## バインディングを本物の Node と突き合わせる

決まりがはっきりしていて範囲の広いバインディングは、差分で試験します。同じ呼び出しを本物の Node の `internalBinding()` と OpenVessel のものにして、結果が同じでなければなりません。

```text
test/fixtures-gen/<name>.cases.mjs   入力: run(binding) → { 区分: [{ args, r }] }
test/fixtures-gen/<name>.mjs         本物の Node で cases を実行する（--expose-internals で internalBinding）
test/unit/fixtures/<name>.json       本物の Node が返したもの（{ node, results }）
test/unit/bindings-<name>.test.ts    同じ cases を OpenVessel のバインディングで実行して比べる
```

- `test/fixtures-gen/_gen.mjs` の `generate(name, run)` は、`process.version` が固定した版（`src/node/version.ts`）でなければ動かず、`run(internalBinding(name))` を呼んで `test/unit/fixtures/<name>.json` を書きます。
- `test/unit/binding-fixtures.ts` の `compareFixtures(actual, expected, known)` は、区分ごとに、件数と引数が記録と合うこと（合わなければ「記録を作り直す」）と、すべての結果が Node のものと深く等しいことを確かめます。`known` は、認める違いを名前つきの条件で並べたものです（`accepted differences: {…}` と報告する）。
- 1 回の呼び出しで済まないものは、自分でファイルを書きます: `zlib.mjs`（`zlib-driver.mjs` が `lib/zlib.js` と同じようにバインディングを動かした記録）、`http_parser.mjs`（記録したバイト列とコールバック）、`crypto.mjs`、`crypto-asym.mjs`。
- `icu-width-table.mjs` は `src/nodejs/bindings/icu.ts` に埋めた幅の表を書き換え、`crypto-tables.cjs` は `src/nodejs/bindings/crypto/tables.ts` を書きます。

| 単体の試験 | 記録 | 作るもの |
|---|---|---|
| `bindings-encoding.test.ts` | `encoding_binding.json` | `encoding.mjs` |
| `bindings-string_decoder.test.ts` | `string_decoder.json` | `string_decoder.mjs` |
| `bindings-url.test.ts` | `url.json` | `url.mjs` |
| `bindings-icu.test.ts` | `icu.json` | `icu.mjs`（と `icu-width-table.mjs`） |
| `bindings-http_parser.test.ts` | `http_parser.json` | `http_parser.mjs` |
| `bindings-zlib.test.ts` | `zlib.json` | `zlib.mjs` |
| `bindings-serdes.test.ts` | `serdes.json` | `serdes.mjs` |
| `bindings-histogram.test.ts` | `performance.json` | `histogram.mjs` |
| `bindings-crypto.test.ts` | `crypto.json` | `crypto.mjs`（と `crypto-tables.cjs`） |
| `bindings-crypto-asym.test.ts` | `crypto-asym.json` | `crypto-asym.mjs` |
| `bindings-v8.test.ts` | — | （`v8` と `heap_utils` を直接確かめる） |

Node の新しい版に移ったら、`node scripts/regen-fixtures.mjs [name…]` で、記録を全部 `npx -y node@<固定した版> --expose-internals --no-warnings` で取り直します。試験の動かし方と足し方は [試験](testing.ja.md) に、版の追従の残りは [ビルド](building.ja.md#nodejs-の新しい版に追従する) にあります。

カーネルに振る舞いが左右されるバインディング（fs・ストリーム・ネット・プロセス・worker・モジュール）は、端から端までの試験で確かめます。OpenVessel の中で動かす Node 自身の試験（`test/node-compat/`）と、`test/e2e/port-fs.mjs`・`test/e2e/preview-port.mjs` です。

## 関連するページ

- [Node.js の層](nodejs-runtime.ja.md)
- [ビルド](building.ja.md) — 形を作る `gen-node-data.mjs` と、Node の版の間のバインディングの変化を報告する `node-upgrade-check.mjs`
- [試験](testing.ja.md)
- [互換性](../compatibility.ja.md)
