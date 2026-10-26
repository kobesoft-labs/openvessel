# Bindings

[日本語](bindings.ja.md)

Node's `lib/` talks to its C++ half through `internalBinding(name)`. This page lists every binding name
the ported runtime knows, which file implements it, how complete it is, and how it is emulated; and it
explains how the bindings are tested against real Node. How the runtime as a whole behaves is in
[Node.js runtime](nodejs-runtime.md).

## How a binding is resolved

`getInternalBinding(name)` (`src/nodejs/bindings/index.ts`) creates each binding on first use and caches
it for the life of the thread:

1. If `factories[name]` exists, its factory builds the binding. Almost every factory starts from
   `fromShape(name)` and assigns its own members on top.
2. Otherwise the binding is `fromShape(name)` alone.
3. If there is no factory and the recorded shape is empty (the binding did not exist in Node v22.23.4),
   it throws `Error: No such binding: <name>` with code `ERR_INVALID_MODULE`. `getLinkedBinding()` always
   throws that error.

`fromShape()` (`src/nodejs/bindings/shape.ts`) materializes the shape recorded from real Node in
`src/node/data/bindings.json` (see [Building](building.md#gen-node-datamjs)):

| Recorded as | Becomes |
|---|---|
| number, string, boolean, `null` | the same value |
| `{ __num }`, `{ __bigint }`, `{ __symbol }` | `NaN`/`Infinity`, a BigInt, a new Symbol with that description |
| `{ __typed, length, values }` | a typed array of that class and length (values filled in when 64 or fewer were recorded) |
| `{ __map }`, `{ __set }` | a `Map`/`Set` |
| `{ __fn }` without prototype methods | a function that throws `ERR_NOT_IMPLEMENTED` (statics copied) |
| `{ __fn, proto }` | a class whose constructor and prototype methods throw `ERR_NOT_IMPLEMENTED` |
| `{ __ref }`, `{ __object }`, `{ __array }`, `{ __throws }`, `{ __missing }` | `undefined` |
| keys starting with `@@` (symbol keys) | left out |

The error is `Error: internalBinding <path> is not implemented in OpenVessel` with
`code: 'ERR_NOT_IMPLEMENTED'`, where `<path>` names the member, for example
`('sqlite').DatabaseSync` or `('crypto').DHBitsJob`. So every constant, enum and table of a binding is
exactly Node's (Linux x64 values: errno, signals, `O_*`, zlib and crypto constants…), and a member that
has no implementation fails loudly when called instead of being `undefined`.

`registerBinding(name, factory)` adds or replaces a factory.

## Status legend

| Status | Meaning |
|---|---|
| implemented | every member lib uses has a real implementation |
| partial | implemented, but some members are recorded stubs (`ERR_NOT_IMPLEMENTED`) or deliberate no-ops |
| shape-only | no factory: constants only, every function throws `ERR_NOT_IMPLEMENTED` |
| absent | not in Node v22.23.4 either: `internalBinding()` throws `ERR_INVALID_MODULE` |

## Process, loop and runtime

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `async_wrap` | `process.ts` | partial | `async_hook_fields`, `async_id_fields` and `async_ids_stack` start from `AsyncHooks`' initial state (the dump was taken inside a callback); `pushAsyncContext`/`popAsyncContext`/`executionAsyncResource`/`clearAsyncIdStack` as in C++; destroy ids are drained in a later task. Only workers and message ports emit `init` from the native side. `setPromiseHooks`, `getPromiseHooks`, `registerDestroyHook`, `setCallbackTrampoline` are no-ops: there are no V8 promise hooks |
| `builtins` | `src/nodejs/boot.ts` | implemented | built from `nodelib.js`: `builtinIds`, `compileFunction`, `natives`, `setInternalLoaders`, `hasCachedBuiltins`, `getCacheUsage` |
| `config` | `process.ts` | implemented | recorded values, with `hasInspector: true`, `isDebugBuild: false`, `noBrowserGlobals: false`, `getDefaultLocale()` → `en-US` |
| `constants` | `index.ts` | implemented | recorded `os`, `fs`, `crypto`, `zlib`, `trace`, `internal` groups; every group has a null prototype and every constant is read-only and non-configurable, as `NODE_DEFINE_CONSTANT` makes them |
| `credentials` | `process.ts` | implemented | uid/gid/euid/egid 1000, groups `[1000]`; `setuid` & co. accept only the current ids (else `EPERM`), names looked up in `/etc/passwd`/`/etc/group`; `safeGetenv`; `getTempDir` (`TMPDIR`, `TMP`, `TEMP`, `TEMPDIR`, `/tmp`) |
| `errors` | `process.ts` | implemented | `setPrepareStackTraceCallback` and `setEnhanceStackForFatalException` feed the stack-trace hook; `triggerUncaughtException` goes to the loop; `getErrorSourcePositions` reads the first stack frame; the source-map setters are no-ops |
| `mksnapshot` | `process.ts` | partial | the setters are no-ops; `compileSerializeMain` is a stub (no snapshot building) |
| `options` | `index.ts` | implemented | `getCLIOptionsValues()` returns the parsed command line; option info, aliases, embedder options, `envSettings` and `types` from the dump; `noGlobalSearchPaths: false`, `shouldNotRegisterESMLoader: false` |
| `os` | `process.ts` | implemented | values listed in [Node.js runtime](nodejs-runtime.md#process-and-os-values) |
| `process_methods` | `process.ts` | implemented | `hrtime`, `cwd`/`chdir`/`umask` (kernel), `memoryUsage`/`rss`/`cpuUsage`/`resourceUsage` (approximations), `_kill`, `reallyExit` (`--trace-exit`), `dlopen` (always fails), `execve`, `patchProcessObject`, `loadEnvFile`, active handles/requests from the loop; `_debugProcess`, `_debugEnd`, `resetStdioForTesting` are no-ops |
| `report` | `report.ts` | implemented | Node's report layout with a glibc Linux header (`glibcVersionRuntime` 2.36, `glibcVersionCompiler` 2.28); `writeReport` writes through the kernel; settings are kept |
| `symbols` | `process.ts` | implemented | fresh symbols with the recorded descriptions |
| `task_queue` | `process.ts` | implemented | `tickInfo` is wrapped so that a `nextTick` outside a callback scope schedules the tick task; `enqueueMicrotask` is the browser's `queueMicrotask`; `runMicrotasks` is a no-op (the browser drains microtasks); `setPromiseRejectCallback` is fed by the Worker's rejection events through the loop |
| `timers` | `process.ts` → `src/nodejs/loop.ts` | implemented | one native timer for all of lib's timers; `immediateInfo`, `timeoutInfo`, `toggleImmediateRef`, `getLibuvNow` |
| `trace_events` | `process.ts` | partial | no tracing: categories are never enabled, `trace()` does nothing |
| `uv` | `process.ts` | implemented | `errname`, `getErrorMap`, `getErrorMessage` from the recorded Linux error map, plus every `UV_*` constant |
| `performance` | `process.ts`, `performance.ts` | implemented | `now`, `milestones` (time origin, bootstrap complete), `Histogram` (a port of HdrHistogram_c with Node's buckets), `createELDHistogram` (sampled with a browser interval timer); `loopIdleTime()` 0, `uvMetricsInfo()` `[0, 0, 0]`; GC tracking and observers are no-ops |
| `profiler` | `inspector.ts` | partial | V8 coverage: the directory is accepted, nothing is collected |
| `inspector` | `inspector.ts` | partial | `Connection`/`MainThreadConnection` answer every message with error `-32601`; `url()` `undefined`; `open`, `waitForDebugger`, async-task hooks are no-ops; `consoleCall` calls Node's console method only |
| `heap_utils` | `heap_utils.ts` | partial | every function throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` (`The feature heap snapshots is unavailable on the current platform…`) |
| `v8` | `v8.ts` | partial | heap, code and space statistics derived from `performance.memory`; `cachedDataVersionTag()` is Node's value for default flags; `setFlagsFromString` records flags without effect; `GCProfiler` returns a profile with no entries; `isStringOneByteRepresentation` |
| `internal_only_v8` | `index.ts` | partial | `queryObjects()` returns `[]` (no heap access) |
| `util` | `util.ts` | implemented | V8 introspection by brand checks (`isPromise`, `isDate`, …), proxy details from the tracked `Proxy`, `previewEntries` for Map/Set iterators (WeakMap/WeakSet entries can't be listed), `getPromiseDetails` (state known only for promises the runtime settled itself; others report pending), `getOwnNonIndexProperties`, `getConstructorName`, `getCallSites`, `sleep` (`Atomics.wait`), `parseEnv`, `guessHandleType` (kernel `fdKind`), `isInsideNodeModules` (from the stack); private symbols emulated with accessors on `Object.prototype`; `getCallerLocation` → `undefined`, `getExternalValue` → `0n` |
| `types` | `util.ts` | implemented | the same brand checks; `isExternal` is always `false`; `isModuleNamespaceObject` by brand |
| `watchdog` | — | shape-only | `--trace-sigint` |

## File system

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `fs` | `fs.ts` | partial | every call is synchronous (throws a `UVException`), callback (`FSReqCallback`, completed on a later turn) or promise (`kUsePromises`), over the kernel's system calls. Stats fill Node's shared stat arrays. `statfs` returns fixed values (type `0xef53`, block size 4096). `chown`/`fchown`/`lchown` only check that the target exists; `fsync`/`fdatasync` only check the fd. `cpSyncCheckPaths`/`cpSyncOverrideFile`/`cpSyncCopyDir` reproduce `node_file.cc`. `StatWatcher` polls with a native timer. `FileHandle` is transferable to another thread (as its fd); a worker thread's unmanaged fds are closed at exit. The `FileHandle` StreamBase members (`readStart`, `writev`, `onread`, …) are recorded stubs |
| `fs_dir` | `fs_dir.ts` | implemented | the kernel has no directory streams: `opendir` takes a snapshot of the entries with their types and `read()` hands them out in batches of `bufferSize` |
| `fs_event_wrap` | `fs_event_wrap.ts` | implemented | kernel `watch`/`unwatch`; events are turned into what libuv's inotify backend reports (child name, `rename`/`change`; the watched path's basename; relative paths when recursive); once the watched inode is deleted or replaced the handle reports nothing more |

## Streams, pipes and terminals

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `stream_wrap` | `stream.ts` | implemented | `LibuvStreamWrap`, `WriteWrap`, `ShutdownWrap`, `streamBaseState`. Reads arrive as kernel `fd-data` messages after `readStart()`; data that arrives after `readStop()` is held for the next `readStart()`. Writes to fds 0–2 are synchronous and whole; other pipes and sockets take what fits in the kernel buffer and finish the rest when the reader drains it (`fd-writable`), so writers see back-pressure. `shutdown()` sends EOF to the peer |
| `pipe_wrap` | `stream.ts` | implemented | pipes over kernel fds; Unix domain sockets (`bind` creates the socket inode, each connection is a new kernel socket pair, `pipe-accept`); IPC pipes can carry handles |
| `tty_wrap` | `stream.ts` | implemented | `isTTY` from the kernel's `fdKind`; `getWindowSize` (`ttySize`), `setRawMode` |
| `js_stream` | — | shape-only | wrapping a JavaScript `Duplex` as a native stream (e.g. `tls.connect({ socket })` with a non-native socket) fails |
| `stream_pipe` | — | shape-only | |

## Network

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `tcp_wrap` | `net.ts` | implemented | TCP sockets are kernel socket pairs on virtual ports: `listen` registers the port, each connection arrives as `tcp-accept` with a new fd; `connect` to a loopback address asks the kernel for one end (a connect to a server in the same thread completes after its accept); `connect` to any other address calls `tcpConnectOut`, a connection whose HTTP/1.1 traffic the kernel forwards through the network policy. Results are reported asynchronously, failures included. `setNoDelay`/`setKeepAlive` are accepted. Listening sockets can be shared with other processes |
| `cares_wrap` | `net.ts` | implemented | no DNS: IP literals resolve to themselves, `localhost`/`*.localhost` to `127.0.0.1` and `::1`, every other name to a stand-in address in `198.18.0.0/15` (stable per name; the outbound bridge maps it back to the name); IPv6 lookups of other names return no data (`EAI_NODATA`). `ChannelWrap` queries: `queryA`/`queryAny` as above, `queryAaaa` only for localhost, everything else `ENODATA`; default server `127.0.0.53:53` |
| `udp_wrap` | `udp.ts` | implemented | loopback only: the kernel delivers each datagram to one receiver on the port (`udp-msg`); a socket sent over IPC is shared between processes |
| `js_udp_wrap` | — | shape-only | |
| `tls_wrap` | `tls_wrap.ts` | partial | no TLS on the wire. For outside connections the browser's `fetch` does the TLS and verifies the certificate, so `TLSWrap` passes plaintext through and reports the handshake done (`verifyError()` `null`); `getPeerCertificate()` returns a stand-in (subject `CN=<servername>`, issuer `O=OpenVessel, CN=verified by the browser`, valid from a day ago for 90 days) and `getPeerX509Certificate()` `undefined`. Between two ends inside the runtime both sides pass through, and the "handshake" exchanges their certificates through the kernel (`tlsHello`), so `getPeerCertificate()`/`getPeerX509Certificate()` show the other end's. `SecureContext` records its settings; `loadPKCS12` parses the archive and verifies its MAC; `addCRL` checks the format. A few StreamBase members (`bytesRead`, `onread`, …) are recorded stubs |
| `http_parser` | `http_parser.ts`, `http/llhttp.ts` | implemented | `HTTPParser` over a node-by-node port of llhttp, so callbacks, error codes, reasons and error positions match the C parser; `ConnectionsList` for the server's timeouts; the default maximum header size comes from `--max-http-header-size` (16384) |
| `http2` | `index.ts` | partial | the recorded shape plus no-op `setCallbackFunctions` and `refreshDefaultSettings`, so `node:http2` loads; `Http2Session`, `Http2Stream`, `packSettings`, `nghttp2ErrorString` are stubs |
| `block_list` | — | shape-only | `net.BlockList`, `net.SocketAddress` |

## Child processes and signals

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `process_wrap` | `process_wrap.ts` | implemented | `Process.spawn` → kernel `spawn` (stdio `pipe`, `overlapped`, `ipc`, `inherit`, `ignore`, fd, `wrap`); `uid`/`gid` other than the current ids → `EPERM`; `detached` is not passed on; exit arrives as `child-exit` |
| `spawn_sync` | `process_wrap.ts` | implemented | kernel `spawnSync` with `timeout`, `killSignal`, `input`; `maxBuffer` cut at the 64 KiB read that crossed it, `ENOBUFS` |
| `signal_wrap` | `process_wrap.ts` | implemented | `Signal.start(signum)` registers with the kernel (`sigaction`); signals arrive as `signal` messages |

## Modules and code

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `contextify` | `contextify.ts` | partial | `compileFunctionForCJSLoader`, `ContextifyScript`, `compileFunction`, `containsModuleSyntax` (acorn / es-module-lexer), `makeContext` (emulated contexts: proxy global + `with` scope), `measureMemory`. The SIGINT watchdog functions are no-ops; `timeout`/`breakOnSigint` and `microtaskMode` have no effect. `cachedData` is a 16-byte record of the source (`OVC1`) checked like V8's |
| `module_wrap` | `module_wrap.ts` | implemented | `ModuleWrap` (source-text and synthetic), served to the browser at `/__ov/mw/<pid>/<id>.mjs`; `link` accepts both the 22.23 `link(modules)` and the older `link(specifiers, modules)`; `evaluateSync` for `require(esm)` through sucrase; `createRequiredModuleFacade`; `throwIfPromiseRejected` is a no-op |
| `modules` | `modules.ts` | partial | `readPackageJSON`, `getNearestParentPackageJSON(Type)`, `getPackageScopeConfig`, `getPackageType` over the kernel's file reads, cached per thread, returned as Node's tuple with `imports`/`exports` as JSON text; `ERR_INVALID_PACKAGE_CONFIG` for bad JSON. Compile cache: `enableCompileCache` reports it disabled. `setLazyPathHelpers` is a no-op, so `import.meta.dirname`/`filename` are not set |
| `wasi` | `wasi.ts` | implemented | `WASI` gives the preview1 functions of `src/node/wasi.ts` (shared with the legacy runtime) the binding's shape; files go through the kernel; `proc_exit` exits the process; the `sock_*` calls return `ENOSYS` |
| `wasm_web_api` | `index.ts` | implemented | `setImplementation` is a no-op: `WebAssembly.compileStreaming`/`instantiateStreaming` are the browser's |
| `sea` | — | shape-only | `node:sea` loads; its functions throw |

## Workers and messaging

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `worker` | `worker.ts` | implemented | `Worker` starts a thread through the kernel (`threadReserve`, `threadSpawn`, `threadKill`); `getEnvMessagePort`; `threadId` per process; `SHARE_ENV`; `execArgv`/`NODE_OPTIONS` checks; `resourceLimits` recorded, not enforced; heap statistics and CPU usage approximated, CPU profiles empty, `takeHeapSnapshot` unavailable |
| `messaging` | `messaging.ts` | implemented | `MessagePort` wraps a browser `MessagePort` (or a process-wide `BroadcastChannel` group); messages are cloned by the browser's structured clone with Node's `Message::Serialize` rules around it (transfer-list checks and errors in Node's order; ports, lib's JS transferables and registered host objects travel as references). `receiveMessageOnPort`/drain read a shared-memory ring per direction (16 KiB growing to 1 MiB). `structuredClone`, `moveMessagePortToContext`, `exposeLazyDOMExceptionProperty`, `broadcastChannel` |
| `serdes` | `serdes.ts` | implemented | `Serializer`/`Deserializer` over a port of V8's `ValueSerializer` (wire format 15, as V8 12.4 writes it). What the browser can't tell is approximated: integers in int32 range are Smis, a packed array of numbers with a non-Smi is `PACKED_DOUBLE`, a string is one-byte when every code unit is ≤ 0xFF; proxies are serialized through their traps, host objects can't be recognized |
| `async_context_frame` | — | shape-only | `--experimental-async-context-frame` |
| `locks` | — | absent | |

## Buffers, encodings, URL, i18n

| Binding | Implementation | Status | Notes |
|---|---|---|---|
| `buffer` | `buffer.ts` | implemented | all slice/write/compare/fill/indexOf/swap functions, `byteLengthUtf8`, `isUtf8`, `isAscii`, `atob`/`btoa`, `createUnsafeArrayBuffer`; `kStringMaxLength` 0x1fffffe8 with Node's "Cannot create a string longer than …" error; also `getZeroFillToggle` and `setBufferPrototype`, which Node's bootstrap removes from the binding |
| `blob` | `blob.ts` | implemented | a blob is a list of parts (bytes, other blobs, or a file read on demand for `createBlobFromFilePath`) with a window; `concat`, `storeDataObject`/`getDataObject`/`revokeObjectURL` |
| `encoding_binding` | `encoding.ts` | implemented | `encodeInto`, `encodeUtf8String`, `decodeUTF8` (a leading BOM is removed unless `ignoreBOM`; `fatal`), `decodeWindows1252`, `toASCII`/`toUnicode` (non-ASCII domains are mapped through the platform URL parser) |
| `string_decoder` | `string_decoder.ts` | implemented | `decode`/`flush` over the state buffer that `lib/string_decoder.js` owns |
| `url` | `url.ts`, `whatwg-url.ts` | implemented | parsing is the URL Standard's own parser written as ada does it (the browser's `URL` is not used for parsing); `url_components` offsets are recomputed from the parsed record; `canParse`, `format`, `getOrigin`, `pathToFileURL`, `update`, `domainToASCII`/`domainToUnicode` |
| `icu` | `icu.ts` | implemented | no ICU: `getStringWidth` from a table dumped from Node's ICU; `transcode` between Node's encodings; `getConverter`/`decode` on the platform `TextDecoder` (`hasConverter` is false for `x-user-defined`); `icuErrName` |
| `url_pattern` | — | absent | |
| `webstorage` | — | shape-only | `localStorage`/`sessionStorage` |
| `permission` | — | shape-only | `--permission` |
| `sqlite` | — | shape-only | `node:sqlite` |
| `quic` | — | absent | |

## Crypto

`internalBinding('crypto')` (`crypto.ts`) is assembled from the files under `src/nodejs/bindings/crypto/`,
on `@noble/hashes`, `@noble/ciphers` and `@noble/curves` plus BigInt arithmetic. What Node does
synchronously stays synchronous; asynchronous `CryptoJob`s complete on a later task through the event
loop. Errors are shaped like OpenSSL's (`ERR_OSSL_*` codes, library and reason). Status: **partial** —
`DHKeyExportJob`, `DHBitsJob` and `internalVerifyIntegrity` are stubs, and `SecureContext` holds no
OpenSSL context.

| File | Covers |
|---|---|
| `crypto/hash.ts` | `Hash`, `Hmac`, `oneShotDigest`, `HashJob`, `HmacJob`, `getHashes`, `getCachedAliases` |
| `crypto/digests.ts` | the digests OpenSSL 3 exposes by name: MD5, SHA-1, SHA-224/256/384/512, SHA-512/224, SHA-512/256, SHA3-224/256/384/512, SHAKE128/256 (XOF), RIPEMD-160, BLAKE2b-512, BLAKE2s-256, SM3, MD5-SHA1, with OpenSSL's aliases (`RSA-SHA256`, `sha256WithRSAEncryption`, …); generic HMAC, PBKDF2, HKDF |
| `crypto/sm3.ts` | SM3 |
| `crypto/cipher.ts`, `blockcipher.ts`, `chacha.ts`, `tables.ts` | `CipherBase`, `getCiphers`, `getCipherInfo`, `getSSLCiphers`, with OpenSSL 3's streaming semantics: AES-128/192/256 in CBC, CFB, CFB1, CFB8, CTR, ECB, GCM, CCM, OCB, OFB, key wrap (with and without padding); DES and 3DES (EDE, EDE3) in ECB, CBC, CFB, OFB and 3DES wrap; ChaCha20 and ChaCha20-Poly1305 (68 cipher names; metadata generated from Node in `tables.ts`) |
| `crypto/kdf.ts` | `PBKDF2Job`, `ScryptJob`, `HKDFJob` |
| `crypto/random.ts` | `RandomBytesJob`, `RandomPrimeJob`, `CheckPrimeJob`, `secureBuffer`, `secureHeapUsed` |
| `crypto/keys.ts` | `KeyObjectHandle` (secret keys), `NativeKeyObject`, `SecretKeyGenJob` |
| `crypto/asymkeys.ts`, `asn1.ts` | asymmetric key material and its encodings: SPKI, PKCS#8 (plain and PBES2-encrypted), PKCS#1, SEC1, PEM (with legacy `Proc-Type` encryption), JWK, raw |
| `crypto/asym.ts` | `Sign`, `Verify`, `SignJob`, key-pair jobs (`RsaKeyPairGenJob`, `DsaKeyPairGenJob`, `DhKeyPairGenJob`, `EcKeyPairGenJob`, `NidKeyPairGenJob`), `ECDH`, `ECDHConvertKey`, `statelessDH`, `publicEncrypt`/`privateDecrypt`/`privateEncrypt`/`publicDecrypt`; curves `secp224r1`, `secp256k1`, `secp384r1`, `secp521r1`, `prime256v1`; Ed25519, Ed448, X25519, X448 |
| `crypto/rsa.ts` | RSA key generation, CRT, PKCS#1 v1.5 and PSS signatures, PKCS#1 v1.5 and OAEP encryption (RSA, RSA-PSS keys) |
| `crypto/dsa.ts`, `dh.ts` | DSA (FIPS 186-4) parameters and signatures; `DiffieHellman`, `DiffieHellmanGroup` (finite-field DH on BigInt) |
| `crypto/webcrypto.ts` | the jobs behind `crypto.subtle`: `AESCipherJob`, `ECDHBitsJob`, `ECKeyExportJob`, `RSAKeyExportJob`, `RSACipherJob` |
| `crypto/x509.ts` | `parseX509` and the `X509Certificate` handle over a DER reading (RFC 5280), names and extensions formatted as Node prints them |
| `crypto/spkac.ts` | `certVerifySpkac`, `certExportPublicKey`, `certExportChallenge` |
| `crypto/pkcs12.ts` | PKCS#12 parsing and MAC check for `SecureContext.loadPKCS12` |
| `crypto/util.ts` | error shapes, byte sources, the `CryptoJob` protocol (sync `run()` → `[err, result]`, async `ondone`) |
| `tls_wrap.ts` | `SecureContext` (see Network) |

Also in `crypto.ts`: `timingSafeEqual`; certificate stores are empty (`getBundledRootCertificates()`,
`getSystemCACertificates()` etc. return `[]`, since TLS is done by the browser); FIPS is off
(`getFipsCrypto()` 0, `setFipsCrypto()` a no-op); `getOpenSSLSecLevelCrypto()` 1; `setEngine()` `false`.

## Compression

`internalBinding('zlib')` (`zlib.ts`), status **implemented**:

| Class / function | Backed by |
|---|---|
| `Zlib` (deflate, inflate, gzip, gunzip, raw, unzip) | `zlib/zlib-context.ts` on pako 3's port of zlib's `z_stream`; pako uses the same hash as Node's (Chromium's) zlib, so deflate output is byte-identical to Node's |
| `BrotliEncoder`, `BrotliDecoder` | `zlib/brotli.ts`: brotli 1.1.0 compiled to WebAssembly (with the decoder patch Node carries), embedded raw-deflated and base64-encoded in `zlib/brotli-wasm.ts`; every parameter is passed to `BrotliEncoderSetParameter`/`BrotliDecoderSetParameter` |
| `ZstdCompress`, `ZstdDecompress` | `zlib/zstd.ts`: zstd 1.5.7 compiled to WebAssembly (`zlib/zstd-wasm.ts`), single-threaded (`ZSTD_c_nbWorkers > 0` is rejected, as in a non-multithreaded build) |
| `crc32` | table-driven |

The WebAssembly modules are decoded and compiled synchronously on first use, and all streams of a
process share one instance per library (a browser allows only a limited number of live WebAssembly
memories). `write()` queues the work and completes it on a later task (the thread-pool round trip);
`writeSync()` runs inline; errors go to `handle.onerror(message, errno, code)`. The WebAssembly modules are
rebuilt only to change library versions, with `src/nodejs/bindings/zlib/wasm/build.mjs` (see
[Building](building.md#other-generators)).

## Testing bindings against real Node

Bindings with a large, exactly specified surface are tested differentially: the same calls are made on
real Node's `internalBinding()` and on OpenVessel's, and the results must be equal.

```text
test/fixtures-gen/<name>.cases.mjs   the inputs: run(binding) → { section: [{ args, r }] }
test/fixtures-gen/<name>.mjs         runs the cases on real Node (internalBinding via --expose-internals)
test/unit/fixtures/<name>.json       what real Node returned ({ node, results })
test/unit/bindings-<name>.test.ts    runs the same cases on OpenVessel's binding and compares
```

- `test/fixtures-gen/_gen.mjs` provides `generate(name, run)`: it refuses to run unless `process.version`
  is the pinned version (`src/node/version.ts`), calls `run(internalBinding(name))` and writes
  `test/unit/fixtures/<name>.json`.
- `test/unit/binding-fixtures.ts` provides `compareFixtures(actual, expected, known)`: section by section,
  case counts and arguments must match the fixture (otherwise: "regenerate the fixture"), every result
  must deep-equal Node's, and `known` lists accepted differences as named predicates (reported as
  `accepted differences: {…}`).
- Generators that need more than one binding call write their own files: `zlib.mjs` (transcripts of
  `zlib-driver.mjs` driving the binding the way `lib/zlib.js` does), `http_parser.mjs` (recorded byte
  streams and callbacks), `crypto.mjs`, `crypto-asym.mjs`.
- `icu-width-table.mjs` rewrites the width table embedded in `src/nodejs/bindings/icu.ts`;
  `crypto-tables.cjs` writes `src/nodejs/bindings/crypto/tables.ts`.

| Unit test | Fixture | Generator |
|---|---|---|
| `bindings-encoding.test.ts` | `encoding_binding.json` | `encoding.mjs` |
| `bindings-string_decoder.test.ts` | `string_decoder.json` | `string_decoder.mjs` |
| `bindings-url.test.ts` | `url.json` | `url.mjs` |
| `bindings-icu.test.ts` | `icu.json` | `icu.mjs` (+ `icu-width-table.mjs`) |
| `bindings-http_parser.test.ts` | `http_parser.json` | `http_parser.mjs` |
| `bindings-zlib.test.ts` | `zlib.json` | `zlib.mjs` |
| `bindings-serdes.test.ts` | `serdes.json` | `serdes.mjs` |
| `bindings-histogram.test.ts` | `performance.json` | `histogram.mjs` |
| `bindings-crypto.test.ts` | `crypto.json` | `crypto.mjs` (+ `crypto-tables.cjs`) |
| `bindings-crypto-asym.test.ts` | `crypto-asym.json` | `crypto-asym.mjs` |
| `bindings-v8.test.ts` | — | (checks `v8` and `heap_utils` directly) |

After moving to a new Node version, `node scripts/regen-fixtures.mjs [name…]` re-records every fixture with
`npx -y node@<pinned version> --expose-internals --no-warnings`. Running and adding tests is described in
[Testing](testing.md); the rest of the upgrade in [Building](building.md#following-a-nodejs-release).

Bindings whose behaviour depends on the kernel (fs, streams, net, processes, workers, modules) are covered
end to end instead: by Node's own test suite run in OpenVessel (`test/node-compat/`) and by
`test/e2e/port-fs.mjs` and `test/e2e/preview-port.mjs`.

## Related pages

- [Node.js runtime](nodejs-runtime.md)
- [Building](building.md) — `gen-node-data.mjs` and `node-upgrade-check.mjs`, which produce the shapes
  and report binding changes between Node versions
- [Testing](testing.md)
- [Compatibility](../compatibility.md)
