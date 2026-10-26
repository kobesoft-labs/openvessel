# バインディング

[English](bindings.md)

Node の `lib/` は、`internalBinding(name)` を通して C++ 側の実装を呼び出します。このページでは、移植版ランタイムが扱うバインディングの名前をすべて挙げ、それぞれの実装ファイル、実装の状況、エミュレーションの方法を示します。最後の節では、バインディングを本物の Node と比較してテストする方法を説明します。ランタイム全体の動作は [Node.js ランタイム](nodejs-runtime.ja.md) にあります。

## バインディングの引き方

`getInternalBinding(name)`（`src/nodejs/bindings/index.ts`）は、各バインディングを最初に使われたときに生成し、スレッドが終了するまでキャッシュします。

1. `factories[name]` があれば、そのファクトリがバインディングを生成します。ほとんどのファクトリは `fromShape(name)` を土台に、独自のメンバーを上書きします。
2. ファクトリが無ければ、`fromShape(name)` がそのままバインディングになります。
3. ファクトリが無く、記録した構造も空（Node v22.23.4 にも存在しないバインディング）の場合は、コード `ERR_INVALID_MODULE` の `Error: No such binding: <name>` を投げます。`getLinkedBinding()` は常にこのエラーを投げます。

`fromShape()`（`src/nodejs/bindings/shape.ts`）は、本物の Node から `src/node/data/bindings.json` に記録した構造を、実際のオブジェクトに変換します（[ビルド](building.ja.md#gen-node-datamjs) を参照）。

| 記録された形式 | 変換結果 |
|---|---|
| 数・文字列・真偽値・`null` | 同じ値 |
| `{ __num }`・`{ __bigint }`・`{ __symbol }` | `NaN`／`Infinity`、BigInt、その説明を持つ新しい Symbol |
| `{ __typed, length, values }` | そのクラスと長さの型付き配列（記録した値が 64 個以下なら値も入れる） |
| `{ __map }`・`{ __set }` | `Map`／`Set` |
| プロトタイプメソッドの無い `{ __fn }` | `ERR_NOT_IMPLEMENTED` を投げる関数（静的メンバーはコピーする） |
| `{ __fn, proto }` | コンストラクタとプロトタイプメソッドが `ERR_NOT_IMPLEMENTED` を投げるクラス |
| `{ __ref }`・`{ __object }`・`{ __array }`・`{ __throws }`・`{ __missing }` | `undefined` |
| `@@` で始まるキー（Symbol のキー） | 含めない |

投げるエラーは `code: 'ERR_NOT_IMPLEMENTED'` の `Error: internalBinding <path> is not implemented in OpenVessel` で、`<path>` はメンバーを表します（例: `('sqlite').DatabaseSync`、`('crypto').DHBitsJob`）。この仕組みにより、バインディングの定数・列挙・テーブルはすべて Node と同じ値になり（Linux x64 の値。errno、シグナル、`O_*`、zlib と crypto の定数など）、実装の無いメンバーは `undefined` になるのではなく、呼び出した時点で明確に失敗します。

`registerBinding(name, factory)` で、ファクトリを追加または置き換えられます。

## 状況の見方

| 状況 | 意味 |
|---|---|
| 実装済み | lib が使うメンバーにすべて実際の実装がある |
| 一部 | 実装はあるが、記録した構造のままのスタブ（`ERR_NOT_IMPLEMENTED`）や、意図的に何もしないメンバーがある |
| 形だけ | ファクトリが無い。定数だけで、関数はすべて `ERR_NOT_IMPLEMENTED` を投げる |
| 無し | Node v22.23.4 にも無い。`internalBinding()` が `ERR_INVALID_MODULE` を投げる |

## プロセス・ループ・ランタイム

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `async_wrap` | `process.ts` | 一部 | `async_hook_fields`・`async_id_fields`・`async_ids_stack` は `AsyncHooks` の初期状態から始める（ダンプはコールバックの中で取得したため）。`pushAsyncContext`／`popAsyncContext`／`executionAsyncResource`／`clearAsyncIdStack` は C++ と同じ動作。destroy の ID は後続のタスクでまとめて処理する。スタックの ID は `Float64Array` に保持し、`grow_async_ids_stack` と同様に拡張する（バインディング上の配列を差し替える）。ネイティブのリソースは `AsyncWrap`（`process.ts` の `emitAsyncInit`）で、生成時に `kAsyncIdCounter` から ID を取得して `init` フックを呼ぶ。`loop.scope()` がコールバックの前後で非同期コンテキストを push／pop し、`before`／`after` を呼ぶ（`InternalCallbackScope`）。ハンドルが閉じたとき、リクエストが完了したときに `destroy` をキューに入れる。`getProviderType()` は `Providers` の番号を返す（[Node.js ランタイム](nodejs-runtime.ja.md#asynclocalstorage) を参照）。`setPromiseHooks`・`getPromiseHooks`・`registerDestroyHook`・`setCallbackTrampoline` は何もしない（V8 の Promise フックが無いため） |
| `builtins` | `src/nodejs/boot.ts` | 実装済み | `nodelib.js` から生成する: `builtinIds`・`compileFunction`・`natives`・`setInternalLoaders`・`hasCachedBuiltins`・`getCacheUsage` |
| `config` | `process.ts` | 実装済み | 記録した値。ただし `hasInspector: true`・`isDebugBuild: false`・`noBrowserGlobals: false`、`getDefaultLocale()` は `en-US` |
| `constants` | `index.ts` | 実装済み | 記録した `os`・`fs`・`crypto`・`zlib`・`trace`・`internal` のグループ。`NODE_DEFINE_CONSTANT` と同様に、どのグループもプロトタイプが null で、定数はすべて読み取り専用かつ削除不可 |
| `credentials` | `process.ts` | 実装済み | uid・gid・euid・egid は 1000、グループは `[1000]`。`setuid` などは現在の ID だけを受け付ける（それ以外は `EPERM`）。名前は `/etc/passwd`・`/etc/group` から引く。`safeGetenv`。`getTempDir`（`TMPDIR`・`TMP`・`TEMP`・`TEMPDIR`・`/tmp`） |
| `errors` | `process.ts` | 実装済み | `setPrepareStackTraceCallback` と `setEnhanceStackForFatalException` はスタックトレースのフックに渡す。`triggerUncaughtException` はループに渡す。`getErrorSourcePositions` はスタックの最初のフレームから取得する。ソースマップの setter は何もしない |
| `mksnapshot` | `process.ts` | 一部 | setter は何もしない。`compileSerializeMain` はスタブ（スナップショットは作れない） |
| `options` | `index.ts` | 実装済み | `getCLIOptionsValues()` はパース済みのコマンドラインを返す。オプション情報・エイリアス・埋め込み側のオプション・`envSettings`・`types` はダンプから。`noGlobalSearchPaths: false`・`shouldNotRegisterESMLoader: false` |
| `os` | `process.ts` | 実装済み | 値は [Node.js ランタイム](nodejs-runtime.ja.md#process-と-os-の値) を参照。`getOSInformation()` は、`node_os.cc` が uname から返すのと同じ `[sysname, version, release, machine]` |
| `process_methods` | `process.ts` | 実装済み | `hrtime`、`cwd`／`chdir`／`umask`（カーネル）、`memoryUsage`／`rss`／`cpuUsage`／`resourceUsage`（近似値）、`_kill`、`reallyExit`（`--trace-exit`）、`dlopen`（常に失敗）、`execve`、`patchProcessObject`、`loadEnvFile`、アクティブなハンドル・リクエスト（ループから取得）。`_debugProcess`・`_debugEnd`・`resetStdioForTesting` は何もしない |
| `report` | `report.ts` | 実装済み | Node のレポートと同じ構成で、ヘッダーは glibc の Linux のもの（`glibcVersionRuntime` 2.36・`glibcVersionCompiler` 2.28。`cpus` と `networkInterfaces` は `os` バインディングから）。`writeReport` はカーネル経由で書き込む。設定値は保持する |
| `symbols` | `process.ts` | 実装済み | 記録した説明を持つ新しい Symbol |
| `task_queue` | `process.ts` | 実装済み | `tickInfo` をラップし、コールバックスコープの外で `nextTick` が呼ばれたら tick のタスクをスケジュールする。`enqueueMicrotask` はブラウザの `queueMicrotask`。`runMicrotasks` は何もしない（マイクロタスクはブラウザが処理する）。`setPromiseRejectCallback` には、Worker の reject イベントがループ経由で届く |
| `timers` | `process.ts` → `src/nodejs/loop.ts` | 実装済み | lib のタイマー全体で 1 つのネイティブタイマーを使う。`immediateInfo`・`timeoutInfo`・`toggleImmediateRef`・`getLibuvNow` |
| `trace_events` | `process.ts` | 一部 | トレースはしない。カテゴリが有効になることはなく、`trace()` は何もしない |
| `uv` | `process.ts` | 実装済み | 記録した Linux のエラーマップから `errname`・`getErrorMap`・`getErrorMessage`。`UV_*` の定数はすべてある |
| `performance` | `process.ts`・`performance.ts` | 実装済み | `now`、`milestones`（time origin・bootstrap complete）、`Histogram`（Node と同じバケットを持つ HdrHistogram_c の移植）、`createELDHistogram`（ブラウザの interval タイマーでサンプリング）。`loopIdleTime()` は 0、`uvMetricsInfo()` は `[0, 0, 0]`。GC の追跡とオブザーバーは何もしない |
| `profiler` | `inspector.ts` | 一部 | V8 のカバレッジ: ディレクトリは受け付けるが、何も収集しない |
| `inspector` | `inspector.ts` | 一部 | `Connection`／`MainThreadConnection` はすべてのメッセージにエラー `-32601` を返す。`url()` は `undefined`。`open`・`waitForDebugger`・非同期タスクのフックは何もしない。`consoleCall` は Node の console のメソッドだけを呼ぶ |
| `heap_utils` | `heap_utils.ts` | 一部 | どの関数も `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`（`The feature heap snapshots is unavailable on the current platform…`）を投げる |
| `v8` | `v8.ts` | 一部 | ヒープ・コード・スペースの統計は `performance.memory` から算出する。`cachedDataVersionTag()` は既定のフラグでの Node の値。`setFlagsFromString` はフラグを記録するだけで効果は無い。`GCProfiler` はエントリの無いプロファイルを返す。`isStringOneByteRepresentation` |
| `internal_only_v8` | `index.ts` | 一部 | `queryObjects()` は `[]` を返す（ヒープにアクセスできない） |
| `util` | `util.ts` | 実装済み | V8 の内部を調べる関数を brand check で実装（`isPromise`・`isDate` など）。Proxy の詳細は記録しておいた `Proxy` から取得。`previewEntries` は Map／Set のイテレーターに対応（WeakMap／WeakSet のエントリは列挙できない）。`getPromiseDetails`（状態がわかるのはランタイム自身が決着させた Promise だけで、それ以外は pending と返す）、`getOwnNonIndexProperties`、`getConstructorName`、`getCallSites`、`sleep`（`Atomics.wait`）、`parseEnv`、`guessHandleType`（カーネルの `fdKind`）、`isInsideNodeModules`（スタックから判定）。private symbol は `Object.prototype` 上のアクセサでエミュレートする。`getCallerLocation` は `undefined`、`getExternalValue` は `0n` |
| `types` | `util.ts` | 実装済み | 同じ brand check。`isExternal` は常に `false`。`isModuleNamespaceObject` も brand check で判定 |
| `watchdog` | — | 形だけ | `--trace-sigint` |

## ファイルシステム

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `fs` | `fs.ts` | 一部 | どの呼び出しも、同期（`UVException` を投げる）・コールバック（`FSReqCallback`。後続のターンで完了）・Promise（`kUsePromises`）のいずれかで、カーネルのシステムコールの上で動く。stat の結果は Node の共有 stat 配列に書き込む。`statfs` は固定値を返す（タイプ `0xef53`・ブロックサイズ 4096）。`chown`／`fchown`／`lchown` は対象の存在だけを確認し、`fsync`／`fdatasync` は fd だけを確認する。`cpSyncCheckPaths`／`cpSyncOverrideFile`／`cpSyncCopyDir` は `node_file.cc` を再現している。`StatWatcher` はネイティブタイマーでポーリングする。`FileHandle` は別のスレッドに（fd として）転送できる。ワーカースレッドが管理外で開いた fd は終了時に閉じる。`FileHandle` の StreamBase のメンバー（`readStart`・`writev`・`onread` など）は記録した構造のままのスタブ |
| `fs_dir` | `fs_dir.ts` | 実装済み | カーネルにはディレクトリストリームが無いので、`opendir` がエントリとその種類のスナップショットを取り、`read()` が `bufferSize` 件ずつ返す |
| `fs_event_wrap` | `fs_event_wrap.ts` | 実装済み | カーネルの `watch`／`unwatch`。イベントは libuv の inotify バックエンドが報告する形に変換する（子の名前と `rename`／`change`、監視対象のパスのベース名、recursive のときは相対パス）。監視している inode が削除または置き換えられると、以後は何も報告しない |

## ストリーム・パイプ・端末

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `stream_wrap` | `stream.ts` | 実装済み | `LibuvStreamWrap`・`WriteWrap`・`ShutdownWrap`・`streamBaseState`。`StreamBase` と同様に、`WriteWrap` はすぐに完了しない書き込みのときだけ、`ShutdownWrap` は `shutdown()` のときに `AsyncWrap` になる。読み取りデータは `readStart()` のあと、カーネルの `fd-data` メッセージで届く。`readStop()` のあとに届いたデータは、次の `readStart()` まで保持する。fd 0〜2 への書き込みは同期で、すべてを一度に書く。それ以外のパイプとソケットは、カーネルのバッファに入る分だけを書き、残りは読み手がバッファを空けたとき（`fd-writable`）に書くので、書き手にはバックプレッシャーがかかる。`shutdown()` は相手に EOF を送る |
| `pipe_wrap` | `stream.ts` | 実装済み | カーネルの fd の上のパイプ。Unix ドメインソケット（`bind` がソケットの inode を作り、接続ごとに新しいカーネルのソケットペアができる。`pipe-accept`）。IPC パイプはハンドルを転送できる |
| `tty_wrap` | `stream.ts` | 実装済み | `isTTY` はカーネルの `fdKind` から判定。`getWindowSize`（`ttySize`）・`setRawMode` |
| `js_stream` | — | 形だけ | JavaScript の `Duplex` をネイティブのストリームとしてラップする処理（ネイティブでないソケットを渡す `tls.connect({ socket })` など）は失敗する |
| `stream_pipe` | — | 形だけ | |

## ネットワーク

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `tcp_wrap` | `net.ts` | 実装済み | TCP ソケットは仮想ポート上のカーネルのソケットペア。`listen` はポートを登録し、接続ごとに新しい fd が `tcp-accept` で届く。ループバックアドレスへの `connect` はカーネルから一方の端を受け取る（同じスレッドのサーバーへの接続は、その accept のあとに完了する）。それ以外のアドレスへの `connect` は `tcpConnectOut` を呼び、その接続の HTTP/1.1 の通信をカーネルがネットワークポリシーを通して転送する。結果は失敗も含めて非同期に通知する。`setNoDelay`／`setKeepAlive` は受け付けるだけ。listen 中のソケットはほかのプロセスと共有できる |
| `cares_wrap` | `net.ts` | 実装済み | DNS は無い。IP アドレスの文字列はそのまま、`localhost`／`*.localhost` は `127.0.0.1` と `::1` に、それ以外の名前は `198.18.0.0/15` の代理アドレスに解決する（名前ごとに固定で、外部への中継がアドレスを名前に戻す）。それ以外の名前の IPv6 の lookup はデータ無し（`EAI_NODATA`）を返す。`ChannelWrap` の問い合わせ: `queryA`／`queryAny` は上と同じ、`queryAaaa` は localhost だけ、それ以外は `ENODATA`。既定のサーバーは `127.0.0.53:53` |
| `udp_wrap` | `udp.ts` | 実装済み | ループバックのみ。カーネルが各データグラムを、そのポートの受信者の 1 つに配送する（`udp-msg`）。IPC で送ったソケットはプロセス間で共有する |
| `js_udp_wrap` | — | 形だけ | |
| `tls_wrap` | `tls_wrap.ts` | 一部 | 通信路上の TLS は行わない。外部への接続ではブラウザの `fetch` が TLS と証明書の検証を行うので、`TLSWrap` は平文をそのまま通し、ハンドシェイクは完了したと報告する（`verifyError()` は `null`）。`getPeerCertificate()` は代わりの証明書（subject は `CN=<servername>`、issuer は `O=OpenVessel, CN=verified by the browser`、1 日前から 90 日間有効）を返し、`getPeerX509Certificate()` は `undefined` を返す。ランタイム内の 2 つの端点の間では両側とも平文を通し、「ハンドシェイク」ではカーネル経由で証明書を交換する（`tlsHello`）ので、`getPeerCertificate()`／`getPeerX509Certificate()` で相手の証明書が見える。サーバー側の `TLSWrap` は、ラップしたソケットの読み取りを引き継ぐ（lib がラップする時点で、ソケットはすでに読み取り中のため）。`SecureContext` は設定を記録する。`loadPKCS12` はアーカイブを解析して MAC を検証する。`addCRL` は形式を確認する。StreamBase のメンバーの一部（`bytesRead`・`onread` など）は記録した構造のままのスタブ |
| `http_parser` | `http_parser.ts`・`http/llhttp.ts` | 実装済み | `HTTPParser` は llhttp 9.4.3（Node 22.23.4 が同梱するバージョン。`process.versions.llhttp`）をノード単位で移植したものの上で動くので、コールバック・エラーコード・理由・エラーの位置が C のパーサーと一致する。サーバーのタイムアウト用の `ConnectionsList`。ヘッダーサイズの上限の既定値は `--max-http-header-size`（16384）から取る。`getProviderType()` は `initialize()` のあと 17／18（`HTTPINCOMINGMESSAGE`／`HTTPCLIENTREQUEST`）。別のオブジェクトに対して呼ばれたメソッドは `TypeError: Illegal invocation` を投げる |
| `http2` | `index.ts` | 一部 | 記録した構造に、何もしない `setCallbackFunctions` と `refreshDefaultSettings` を加えたもの。これで `node:http2` は読み込める。`Http2Session`・`Http2Stream`・`packSettings`・`nghttp2ErrorString` は `ERR_NOT_IMPLEMENTED` を投げるスタブなので、HTTP/2 のセッションはすべて失敗する（[Node.js ランタイム](nodejs-runtime.ja.md#実装していないもの) を参照） |
| `block_list` | — | 形だけ | `net.BlockList`・`net.SocketAddress` |

## 子プロセスとシグナル

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `process_wrap` | `process_wrap.ts` | 実装済み | `Process.spawn` → カーネルの `spawn`（stdio は `pipe`・`overlapped`・`ipc`・`inherit`・`ignore`・fd・`wrap`）。現在の ID 以外の `uid`／`gid` は `EPERM`。`detached` はカーネルに渡さない。終了は `child-exit` で届く |
| `spawn_sync` | `process_wrap.ts` | 実装済み | カーネルの `spawnSync`（`timeout`・`killSignal`・`input`）。`maxBuffer` は上限を超えた 64 KiB の読み取りの位置で打ち切り、`ENOBUFS` |
| `signal_wrap` | `process_wrap.ts` | 実装済み | `Signal.start(signum)` がカーネルに登録する（`sigaction`）。シグナルは `signal` メッセージで届く |

## モジュールとコード

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `contextify` | `contextify.ts` | 一部 | `compileFunctionForCJSLoader`・`ContextifyScript`・`compileFunction`・`containsModuleSyntax`（acorn／es-module-lexer）・`makeContext`（エミュレートしたコンテキスト: プロキシのグローバルと `with` スコープ）・`measureMemory`。SIGINT の watchdog 関連の関数は何もしない。`timeout`／`breakOnSigint` と `microtaskMode` は効果が無い。`cachedData` はソースの 16 バイトの記録（`OVC1`）で、V8 と同じ方法で検証する |
| `module_wrap` | `module_wrap.ts` | 実装済み | `ModuleWrap`（ソーステキストと合成）。ブラウザへは `/__ov/mw/<pid>/<id>.mjs` で配信する。`link` は 22.23 の `link(modules)` と以前の `link(specifiers, modules)` の両方を受け付ける。`require(esm)` 用の `evaluateSync` は sucrase で実装。`createRequiredModuleFacade`。`throwIfPromiseRejected` は何もしない |
| `modules` | `modules.ts` | 一部 | `readPackageJSON`・`getNearestParentPackageJSON(Type)`・`getPackageScopeConfig`・`getPackageType` をカーネルのファイル読み取りの上で実装。スレッドごとにキャッシュし、Node と同じタプル（`imports`／`exports` は JSON 文字列）で返す。JSON が不正なら `ERR_INVALID_PACKAGE_CONFIG`。コンパイルキャッシュ: `enableCompileCache` は無効と返す。`setLazyPathHelpers` は `file:` の URL に対して `import.meta.dirname`／`filename` を定義する |
| `wasi` | `wasi.ts` | 実装済み | `WASI` は、`src/node/wasi.ts`（旧ランタイムと共用）の preview1 の関数をバインディングの構造に合わせたもの。ファイルはカーネルを経由する。`proc_exit` はプロセスを終了する。`sock_*` は `ENOSYS` を返す |
| `wasm_web_api` | `index.ts` | 実装済み | `setImplementation` は何もしない。`WebAssembly.compileStreaming`／`instantiateStreaming` はブラウザのものを使う |
| `sea` | — | 形だけ | `node:sea` は読み込めるが、関数は例外を投げる |

## ワーカーとメッセージング

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `worker` | `worker.ts` | 実装済み | `Worker` はカーネル経由でスレッドを起動する（`threadReserve`・`threadSpawn`・`threadKill`）。`getEnvMessagePort`。`threadId` はプロセスごと。`SHARE_ENV`。`execArgv`／`NODE_OPTIONS` の検証。`resourceLimits` は記録するが制限はしない。ヒープ統計と CPU 使用量は近似値、CPU プロファイルは空、`takeHeapSnapshot` は利用できない |
| `messaging` | `messaging.ts` | 実装済み | `MessagePort` はブラウザの `MessagePort`（またはプロセス全体の `BroadcastChannel` のグループ）をラップする。メッセージはブラウザの structured clone で複製し、その前後に Node の `Message::Serialize` の規則を適用する（転送リストの検証とエラーは Node と同じ順序。ポート、lib の JS の転送可能オブジェクト、登録済みのホストオブジェクトは参照として渡す）。`receiveMessageOnPort`／drain は、方向ごとの共有メモリのリングバッファ（16 KiB から 1 MiB まで拡張）を読む。`structuredClone`・`moveMessagePortToContext`・`exposeLazyDOMExceptionProperty`・`broadcastChannel` |
| `serdes` | `serdes.ts` | 実装済み | `Serializer`／`Deserializer` は V8 の `ValueSerializer` の移植（V8 12.4 が書き出す wire format 15）。ブラウザから判別できない点は近似する: int32 の範囲の整数は Smi、Smi でない数を含む packed な数値配列は `PACKED_DOUBLE`、すべてのコードユニットが 0xFF 以下の文字列は 1 バイト文字列として扱う。Proxy はトラップ経由でシリアライズし、ホストオブジェクトは判別できない |
| `async_context_frame` | — | 形だけ | `--experimental-async-context-frame` |
| `locks` | — | 無し | |

## バッファ・エンコーディング・URL・国際化

| バインディング | 実装 | 状況 | メモ |
|---|---|---|---|
| `buffer` | `buffer.ts` | 実装済み | slice・write・compare・fill・indexOf・swap の関数すべて、`byteLengthUtf8`・`isUtf8`・`isAscii`・`atob`／`btoa`・`createUnsafeArrayBuffer`。`kStringMaxLength` は 0x1fffffe8 で、Node と同じ「Cannot create a string longer than …」のエラーを出す。Node の起動処理がバインディングから削除する `getZeroFillToggle` と `setBufferPrototype` もある |
| `blob` | `blob.ts` | 実装済み | blob はパーツ（バイト列、ほかの blob、`createBlobFromFilePath` の場合は必要になったときに読むファイル）のリストと、その範囲で表す。`concat`・`storeDataObject`／`getDataObject`／`revokeObjectURL` |
| `encoding_binding` | `encoding.ts` | 実装済み | `encodeInto`・`encodeUtf8String`・`decodeUTF8`（`ignoreBOM` でなければ先頭の BOM を除去。`fatal`）・`decodeWindows1252`・`toASCII`／`toUnicode`（ASCII 以外のドメインはプラットフォームの URL パーサーで変換） |
| `string_decoder` | `string_decoder.ts` | 実装済み | `lib/string_decoder.js` が持つ状態バッファの上で `decode`／`flush` |
| `url` | `url.ts`・`whatwg-url.ts` | 実装済み | パースは、URL Standard のパーサーを ada と同じ方式で実装したもの（ブラウザの `URL` はパースに使わない）。`url_components` のオフセットはパース結果から計算し直す。`canParse`・`format`・`getOrigin`・`pathToFileURL`・`update`・`domainToASCII`／`domainToUnicode` |
| `icu` | `icu.ts` | 実装済み | ICU は無い。`getStringWidth` は Node の ICU からダンプしたテーブルを使う。`transcode` は Node のエンコーディング間で変換する。`getConverter`／`decode` はプラットフォームの `TextDecoder` の上で実装（`x-user-defined` の `hasConverter` は false）。`icuErrName` |
| `url_pattern` | — | 無し | |
| `webstorage` | — | 形だけ | `localStorage`・`sessionStorage` |
| `permission` | — | 形だけ | `--permission` |
| `sqlite` | — | 形だけ | `node:sqlite` |
| `quic` | — | 無し | |

## 暗号

`internalBinding('crypto')`（`crypto.ts`）は、`src/nodejs/bindings/crypto/` 以下のファイルを組み合わせたもので、`@noble/hashes`・`@noble/ciphers`・`@noble/curves` と BigInt の演算の上で動きます。Node が同期で行う処理は同期のままで、非同期の `CryptoJob` はイベントループを通じて後続のタスクで完了します。エラーは OpenSSL と同じ形（`ERR_OSSL_*` のコード、ライブラリ、理由）です。状況は「一部」で、`DHKeyExportJob`・`DHBitsJob`・`internalVerifyIntegrity` はスタブ、`SecureContext` は OpenSSL のコンテキストを持ちません。

| ファイル | 対象 |
|---|---|
| `crypto/hash.ts` | `Hash`・`Hmac`・`oneShotDigest`・`HashJob`・`HmacJob`・`getHashes`・`getCachedAliases` |
| `crypto/digests.ts` | OpenSSL 3 が名前で公開しているダイジェスト: MD5・SHA-1・SHA-224/256/384/512・SHA-512/224・SHA-512/256・SHA3-224/256/384/512・SHAKE128/256（XOF）・RIPEMD-160・BLAKE2b-512・BLAKE2s-256・SM3・MD5-SHA1。OpenSSL のエイリアス（`RSA-SHA256`・`sha256WithRSAEncryption` など）も含む。汎用の HMAC・PBKDF2・HKDF |
| `crypto/sm3.ts` | SM3 |
| `crypto/cipher.ts`・`blockcipher.ts`・`chacha.ts`・`tables.ts` | `CipherBase`・`getCiphers`・`getCipherInfo`・`getSSLCiphers`。OpenSSL 3 のストリーミングの挙動に合わせている: AES-128/192/256 の CBC・CFB・CFB1・CFB8・CTR・ECB・GCM・CCM・OCB・OFB・鍵ラップ（パディングあり・なし）。DES と 3DES（EDE・EDE3）の ECB・CBC・CFB・OFB と 3DES の鍵ラップ。ChaCha20 と ChaCha20-Poly1305（暗号名は 68 個。メタデータは Node から生成して `tables.ts` に置く） |
| `crypto/kdf.ts` | `PBKDF2Job`・`ScryptJob`・`HKDFJob` |
| `crypto/random.ts` | `RandomBytesJob`・`RandomPrimeJob`・`CheckPrimeJob`・`secureBuffer`・`secureHeapUsed` |
| `crypto/keys.ts` | `KeyObjectHandle`（秘密鍵）・`NativeKeyObject`・`SecretKeyGenJob` |
| `crypto/asymkeys.ts`・`asn1.ts` | 非対称鍵のデータとそのエンコーディング: SPKI・PKCS#8（平文と PBES2 による暗号化）・PKCS#1・SEC1・PEM（旧来の `Proc-Type` による暗号化も含む）・JWK・raw |
| `crypto/asym.ts` | `Sign`・`Verify`・`SignJob`、鍵ペア生成のジョブ（`RsaKeyPairGenJob`・`DsaKeyPairGenJob`・`DhKeyPairGenJob`・`EcKeyPairGenJob`・`NidKeyPairGenJob`）、`ECDH`・`ECDHConvertKey`・`statelessDH`、`publicEncrypt`／`privateDecrypt`／`privateEncrypt`／`publicDecrypt`。曲線は `secp224r1`・`secp256k1`・`secp384r1`・`secp521r1`・`prime256v1`。Ed25519・Ed448・X25519・X448 |
| `crypto/rsa.ts` | RSA の鍵生成、CRT、PKCS#1 v1.5 と PSS の署名、PKCS#1 v1.5 と OAEP の暗号化（RSA・RSA-PSS の鍵） |
| `crypto/dsa.ts`・`dh.ts` | DSA（FIPS 186-4）のパラメーターと署名。`DiffieHellman`・`DiffieHellmanGroup`（BigInt による有限体の DH） |
| `crypto/webcrypto.ts` | `crypto.subtle` の内部で使うジョブ: `AESCipherJob`・`ECDHBitsJob`・`ECKeyExportJob`・`RSAKeyExportJob`・`RSACipherJob` |
| `crypto/x509.ts` | `parseX509` と `X509Certificate` のハンドル。DER を読み取り（RFC 5280）、名前と拡張は Node と同じ形式で表示する |
| `crypto/spkac.ts` | `certVerifySpkac`・`certExportPublicKey`・`certExportChallenge` |
| `crypto/pkcs12.ts` | `SecureContext.loadPKCS12` 用の PKCS#12 の解析と MAC の検証 |
| `crypto/util.ts` | エラーの形、バイト列の入力元、`CryptoJob` のプロトコル（同期の `run()` は `[err, result]`、非同期は `ondone`） |
| `tls_wrap.ts` | `SecureContext`（ネットワークの節を参照） |

`crypto.ts` にはほかに次のものがあります。`timingSafeEqual` があり、証明書ストアは空です（TLS はブラウザが行うので、`getBundledRootCertificates()`・`getSystemCACertificates()` などは `[]` を返す）。FIPS は無効で（`getFipsCrypto()` は 0、`setFipsCrypto()` は何もしない）、`getOpenSSLSecLevelCrypto()` は 1、`setEngine()` は `false` を返します。

## 圧縮

`internalBinding('zlib')`（`zlib.ts`）の状況は「実装済み」です。

| クラス・関数 | 実装 |
|---|---|
| `Zlib`（deflate・inflate・gzip・gunzip・raw・unzip） | `zlib/zlib-context.ts`。pako 3 による zlib の `z_stream` の移植を使う。pako は Node の（Chromium の）zlib と同じハッシュを使うので、deflate の出力は Node とバイト単位で一致する |
| `BrotliEncoder`・`BrotliDecoder` | `zlib/brotli.ts`。brotli 1.1.0 を WebAssembly にコンパイルしたもの（Node が当てているデコーダーのパッチを含む）を、raw deflate で圧縮して base64 にし、`zlib/brotli-wasm.ts` に埋め込んでいる。パラメーターはすべて `BrotliEncoderSetParameter`／`BrotliDecoderSetParameter` に渡す |
| `ZstdCompress`・`ZstdDecompress` | `zlib/zstd.ts`。zstd 1.5.7 を WebAssembly にコンパイルしたもの（`zlib/zstd-wasm.ts`）。シングルスレッドで動く（マルチスレッドでないビルドと同じく、`ZSTD_c_nbWorkers > 0` は拒否する） |
| `crc32` | テーブル参照 |

WebAssembly のモジュールは最初に使うときに同期でデコードしてコンパイルし、プロセス内のすべてのストリームがライブラリごとに 1 つのインスタンスを共有します（ブラウザでは、同時に存在できる WebAssembly のメモリの数に上限があるためです）。`write()` は処理をキューに入れて後続のタスクで完了させ（スレッドプールとの往復に相当）、`writeSync()` はその場で実行します。エラーは `handle.onerror(message, errno, code)` に渡します。WebAssembly のモジュールを作り直すのはライブラリのバージョンを変えるときだけで、`src/nodejs/bindings/zlib/wasm/build.mjs` を使います（[ビルド](building.ja.md#ほかの生成の道具) を参照）。

## バインディングを本物の Node と比較する

仕様が厳密に決まっていて範囲の広いバインディングは、差分テストで確認します。同じ呼び出しを本物の Node の `internalBinding()` と OpenVessel のものに対して行い、結果が一致しなければなりません。

```text
test/fixtures-gen/<name>.cases.mjs   入力: run(binding) → { 区分: [{ args, r }] }
test/fixtures-gen/<name>.mjs         本物の Node で cases を実行する（--expose-internals で internalBinding）
test/unit/fixtures/<name>.json       本物の Node が返したもの（{ node, results }）
test/unit/bindings-<name>.test.ts    同じ cases を OpenVessel のバインディングで実行して比べる
```

- `test/fixtures-gen/_gen.mjs` が提供する `generate(name, run)` は、`process.version` が固定したバージョン（`src/node/version.ts`）でなければ実行を拒否します。`run(internalBinding(name))` を呼び、`test/unit/fixtures/<name>.json` を書き出します。
- `test/unit/binding-fixtures.ts` が提供する `compareFixtures(actual, expected, known)` は、区分ごとに、ケースの数と引数がフィクスチャと一致すること（一致しなければ「フィクスチャを作り直す」）、すべての結果が Node のものと deep equal であることを確認します。`known` には、許容する差異を名前付きの判定関数として並べます（`accepted differences: {…}` と報告します）。
- バインディングを 1 回呼ぶだけでは済まないジェネレーターは、独自にファイルを書き出します: `zlib.mjs`（`zlib-driver.mjs` が `lib/zlib.js` と同じ手順でバインディングを操作した記録）、`http_parser.mjs`（記録したバイト列とコールバック）、`crypto.mjs`、`crypto-asym.mjs`。
- `icu-width-table.mjs` は `src/nodejs/bindings/icu.ts` に埋め込んだ文字幅のテーブルを書き換え、`crypto-tables.cjs` は `src/nodejs/bindings/crypto/tables.ts` を書き出します。

| 単体テスト | フィクスチャ | ジェネレーター |
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
| `bindings-v8.test.ts` | — | （`v8` と `heap_utils` を直接確認する） |

Node の新しいバージョンに移行したら、`node scripts/regen-fixtures.mjs [name…]` ですべてのフィクスチャを `npx -y node@<固定したバージョン> --expose-internals --no-warnings` で記録し直します。テストの実行と追加の方法は [テスト](testing.ja.md) に、バージョンアップの残りの手順は [ビルド](building.ja.md#nodejs-の新しいバージョンに追従する) にあります。

動作がカーネルに依存するバインディング（fs・ストリーム・ネットワーク・プロセス・ワーカー・モジュール）は、代わりに E2E で確認します。OpenVessel の中で実行する Node 自身のテストスイート（`test/node-compat/`）と、`test/e2e/port-fs.mjs`・`test/e2e/preview-port.mjs` です。

## 関連するページ

- [Node.js ランタイム](nodejs-runtime.ja.md)
- [ビルド](building.ja.md): 構造を生成する `gen-node-data.mjs` と、Node のバージョン間のバインディングの変化を報告する `node-upgrade-check.mjs`
- [テスト](testing.ja.md)
- [互換性](../compatibility.ja.md)
