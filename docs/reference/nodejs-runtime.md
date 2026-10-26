# Node.js runtime

[日本語](nodejs-runtime.ja.md)

This page specifies how Node.js runs inside a process worker: the two runtimes in the build and how one
is chosen, the start-up sequence of the ported runtime, its command line, environment, event loop,
module loading, TypeScript, `fetch`, and the places where it deliberately differs from Node.js.
What can't work in a browser at all, and the measured test results, are in
[Compatibility](../compatibility.md).

## Two runtimes

Every `node` process (and every `worker_threads` thread) is a Web Worker started by the kernel. The build
contains two different scripts for that Worker:

| | Ported runtime | Legacy runtime |
|---|---|---|
| Worker script | `dist/runtime/node-process.js` | `dist/runtime/process.js` |
| Source | `src/nodejs/` (entry `src/nodejs/boot.ts`) | `src/node/` (entry `src/node/worker.ts`) |
| What runs | Node.js v22.23.4's own `lib/` (bundled in `dist/runtime/nodelib.js`); the C++ half (`internalBinding()`) is re-implemented in TypeScript — see [Bindings](bindings.md) | hand-written Node-compatible modules (`fs.ts`, `http.ts`, `module.ts`, …) |
| Command line | Node's option table and parser (`src/nodejs/options.ts`); unknown options are errors | a small hand-written parser; unknown options are ignored |
| TypeScript | Node's own type stripping (amaro) | sucrase's `typescript` transform (enums etc. are accepted) |
| ES modules | `module_wrap` binding, served at `/__ov/mw/<pid>/<id>.mjs` | the kernel's ESM service at `/__ov/esm/…` and `/__ov/builtin/…` |
| `--loader` | Node's hooks machinery | ignored with a warning |
| `node:http2` | loads; servers listen, but a session fails with `ERR_NOT_IMPLEMENTED` (`Http2Session`, see [Not implemented](#not-implemented)) | `createServer()`, `createSecureServer()` and `connect()` throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` (`HTTP/2 is not supported in OpenVessel`) |
| Default | **yes** | no (selected with `legacy`) |

All numbers on the [Compatibility](../compatibility.md) page (Node's test suite and the Astro corpus) were
measured with the ported runtime. The rest of this page describes the ported runtime unless it says
otherwise.

### Selecting the runtime

The kernel picks the script each time a node program starts, a new process or an `execve` (`processScript()` in
`src/kernel/index.ts`):
if the VFS file `/etc/openvessel/node` exists and its contents, trimmed, are exactly `legacy`, it uses
`process.js`; in every other case (no file, unreadable, `port`, any other text) it uses `node-process.js`.
`port` is still accepted for compatibility with setups that selected the ported runtime explicitly before it
became the default. The choice is recorded in the process: it applies to programs started after the file is
written, running processes are not affected, and a process's `worker_threads` threads always use the same
runtime as its main thread.

To switch to the legacy runtime from the shell:

```sh
mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node
node -p 'process.version'      # now runs on the legacy runtime
rm /etc/openvessel/node        # back to the ported runtime for the next process
```

From the host page:

```ts
vessel.mount({ node: 'legacy' }, { path: '/etc/openvessel' });
```

The kernel keeps two pre-created Workers per script URL (`WARM = 2`) waiting for their `init` message, and
tops the pool up after each one is taken, so most of a process's script loading and compilation happens
before it is needed.

## Start-up of a process worker

### The `init` message

The kernel starts a thread by posting `{ t: 'init', … }` (`InitMsg` in `src/nodejs/state.ts`):

| Field | Meaning |
|---|---|
| `kind` | `'main'` for a process, `'thread'` for a `worker_threads` thread |
| `pid`, `ppid`, `tid` | process id, parent process id, kernel thread id |
| `argv`, `env`, `cwd` | the process's argument vector, environment and working directory |
| `sab` | the `SharedArrayBuffer` used for synchronous system calls |
| `ttys` | for fds 0–2: `{ cols, rows }` when the fd is a terminal, else `null` |
| `hostname` | the kernel's host name (`openvessel`) |
| `file`, `eval`, `evalType`, `execArgv`, `workerData`, `envData`, `port`, `name`, `threadId`, `envRings`, `trackUnmanagedFds`, `sharedEnv`, `resourceLimits` | worker threads only |

Other messages the worker accepts: `{ t: 'ping', id }` is answered with `{ t: 'pong', id }` (the kernel
uses it to know that everything posted before has been handled); any other `t` is dispatched to a handler
registered by a binding (`child-exit`, `signal`, `fd-data`, `fd-writable`, `tcp-accept`, `pipe-accept`,
`udp-msg`, `watch`, `tls-peer`, `thread-exit`, `thread-gone`). The message protocol itself is described in
[Protocol](protocol.md).

### Boot sequence

`boot()` in `src/nodejs/boot.ts` does what `node::CreateEnvironment` and `node::StartExecution` do in C++:

1. Records the init message, connects the system-call channel, and (main thread only) reads the
   `--env-file` files and parses the command line. An invalid command line prints each error as
   `<argv0>: <error>` and exits with code 9. `--version`/`-v` prints `v22.23.4` and `--v8-options` prints
   V8's option list, then exit with 0 before anything else is loaded. `Error.stackTraceLimit` is set from
   `--stack-trace-limit` (10 by default).
2. Installs listeners for the Worker's `unhandledrejection`, `rejectionhandled` and `error` events.
3. Replaces the global `Proxy` with one that records target and handler (so `util.types.isProxy` and
   `util.inspect(…, { showProxy: true })` work), and wraps the methods that create Map/Set iterators (so
   `util.types.isMapIterator` and iterator previews work). Both happen before Node's primordials capture
   them.
4. Runs the per-context scripts `internal/per_context/primordials`, `internal/per_context/domexception` and
   `internal/per_context/messageport`.
5. Builds `internalBinding('builtins')` from the bundled lib and creates the `process` object
   (`version`, `versions`, `arch: 'x64'`, `platform: 'linux'`, `release`, `_rawDebug`, `env`).
6. Runs `internal/bootstrap/realm`, then installs the stack-trace hook (see [Stack traces](#stack-traces-and-errors)).
7. Runs `internal/bootstrap/node`, then `internal/bootstrap/web/exposed-wildcard` and
   `internal/bootstrap/web/exposed-window-or-worker` (`config.noBrowserGlobals` is always `false`).
8. Runs `internal/bootstrap/switches/is_main_thread` and `…/does_own_process_state` on the main thread,
   or `…/is_not_main_thread` and `…/does_not_own_process_state` in a worker thread.
9. Reshapes the global object to look like Node's (see [Global object](#global-object)). Without fetch
   (`--no-experimental-fetch`) `WebAssembly.compileStreaming` and `instantiateStreaming` are removed, as
   V8 has them only when Node sets up wasm streaming together with fetch.
10. With `--run`, runs the package script (see [--run](#--run)) instead of a main script. Otherwise sets
    the `--env-file` variables that `process.env` doesn't have yet (not in watch mode, whose child loads
    them), selects and runs the main script inside a callback scope with execution async id 1, and
    starts the event loop.

If anything in steps 2–10 throws, the worker writes `[openvessel] node bootstrap failed: <stack>` to fd 2
and exits with code 10 (`kBootstrapFailure`).

The main script is chosen like `node::SelectLoadMode`:

| Condition (first match) | Main script |
|---|---|
| a worker thread | `internal/main/worker_thread` |
| `--help` | `internal/main/print_help` |
| `--prof-process` | `internal/main/prof_process` |
| `-e`/`-p`/`--eval`/`--print` without `--interactive` | `internal/main/eval_string` |
| `--check` | `internal/main/check_syntax` |
| `--test` | `internal/main/test_runner` |
| `--watch` | `internal/main/watch_mode` |
| a script argument other than `-` | `internal/main/run_main_module` |
| `--interactive`, or fd 0 is a terminal | `internal/main/repl` |
| otherwise | `internal/main/eval_stdin` |

### nodelib.js and lazy compilation

`dist/runtime/nodelib.js` (generated by `scripts/gen-nodelib.mjs`, see [Building](building.md)) is an ES
module that exports three things: `ids` (every builtin id), `params` (the wrapper parameter list of each
builtin) and `sources` (each builtin's source as a string). Nothing is compiled when it loads. The first
time a builtin is required, `compileBuiltin()` evaluates

```js
(function (<params>) {<source>
})
//# sourceURL=node:<id>
```

with an indirect `eval` and caches the function, so stack traces name Node's files as `node:fs` etc.
The parameter lists are those of `node_builtins.cc`:

| Builtin ids | Parameters |
|---|---|
| `internal/per_context/*` | `exports, primordials, privateSymbols, perIsolateSymbols` |
| `internal/bootstrap/realm` | `process, getLinkedBinding, getInternalBinding, primordials` |
| other `internal/bootstrap/*`, `internal/main/*` | `process, require, internalBinding, primordials` |
| everything else | `exports, require, module, process, internalBinding, primordials` |

`internalBinding('builtins')` exposes `builtinIds`, `compileFunction(id)` (unknown id:
`ERR_UNKNOWN_BUILTIN_MODULE`, `No such built-in module: <id>`), `natives` (a read-only view of the
sources), `hasCachedBuiltins()` → `true` and `getCacheUsage()` → three empty lists.

### OV_TIMING

When the process environment contains a non-empty `OV_TIMING`, the worker prints how long each stage took
to fd 2, after the main script's synchronous part has run:

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

`worker start→script` is the time from the Worker's creation to its script being evaluated; with a warm
Worker it includes the time the Worker waited in the pool. `OV_TIMING` is the only `OV_*` variable the
runtime reads. (The other `OV_*` names in the repository belong to the shell's internal state and to the
test tools: see [Testing](testing.md) and [Building](building.md).)

### Exit codes set by the runtime

| Code | When |
|---|---|
| 0 | normal exit, `--version`, `--v8-options`, `--run` whose script succeeded |
| 1 | uncaught exception or unhandled rejection (unless an `exit` handler set `process.exitCode`); `--run` that failed |
| 6 | `process._fatalException` is not a function (`kInvalidFatalExceptionMonkeyPatching`) |
| 7 | the fatal-exception handler itself threw (`kExceptionInFatalExceptionHandler`) |
| 9 | invalid command line or `NODE_OPTIONS` |
| 10 | bootstrap failure |
| 13 | the event loop ran dry while a module's top-level `await` was still pending |
| 134 | `process.abort()`, or a failed `process.execve()` |
| 139 | `process.causeSegfault()` |

When a process exits, the worker calls the kernel's `exit` system call (a worker thread runs its exit
hooks and calls `threadExit`), then blocks in `Atomics.wait` until the kernel terminates it.

## Command line

### Parsing

`parseCommandLine()` (`src/nodejs/options.ts`) follows `node_options.cc`, driven by the option table
dumped from real Node (`src/node/data/process.json`: 210 options, 25 aliases, their types and whether
they are allowed in `NODE_OPTIONS`):

- `NODE_OPTIONS` is applied first, then the command line, so the command line wins. `NODE_OPTIONS` is
  split on whitespace; `'…'` and `"…"` quote, and a backslash escapes the next character inside double
  quotes only.
- Options end at `--`, at `-`, or at the first argument not starting with `-`. What follows is
  `process.argv[1…]`.
- `_` and `-` are the same in option names (`--stack_trace_limit=3` is `--stack-trace-limit=3`;
  `process.execArgv` keeps what was typed).
- `--name=value` and `--name value` are both accepted for options that take a value. Aliases are expanded
  as in Node (`-e` → `--eval`, `-p` → `--print`, `-pe` → `--print --eval`, `-C` → `--conditions`,
  `-r` → `--require`, `--loader` → `--experimental-loader`, `-c` → `--check`, `-i` → `--interactive`, …).
  `--prof-process` expands to `--prof-process --`, so everything after it is an argument.
- `--no-<name>` negates a boolean option. Options switch on others as `Implies()` does in
  `node_options.cc`: `--eval` → `[has_eval_string]`, `--env-file`/`--env-file-if-exists` →
  `[has_env_file_string]`, `--watch-path` → `--watch`, `--experimental-strip-types` →
  `--experimental-detect-module`, `--experimental-transform-types` → `--experimental-strip-types` and
  `--enable-source-maps`, `--inspect-brk` → `--inspect`, `--report-signal` → `--report-on-signal`, ….
- Integer options are stored as numbers, string lists (`--require`, `--import`, `--conditions`, …)
  accumulate.
- An option Node doesn't know goes to V8, as in Node. V8's own list of flags (`node --v8-options` of
  Node v22.23.4 on Linux x64, `src/nodejs/data/v8-options.json`) decides: a V8 flag is accepted (and has
  no effect, see below), anything else is a bad option. A boolean flag takes `--no-`; any other flag needs
  its value after `=` (Node hands the argument to V8 alone), which must suit its type.

Errors (each printed as `node: <message>`, exit code 9):

| Message | Cause |
|---|---|
| `bad option: <arg>` | an option in neither Node's table nor V8's, or a V8 flag with a value that doesn't suit it (V8's own message comes first, see below) |
| `<option> is not allowed in NODE_OPTIONS` | an option Node disallows in `NODE_OPTIONS` (40 of them, e.g. `--eval`), and any option not in Node's table (V8 flags included) |
| `--no-<name> is an invalid negation because it is not a boolean option` | `--no-` on a Node option that isn't boolean |
| `<arg> requires an argument` | a value option at the end of the line |
| `<file>: not found` | an `--env-file` that can't be opened (`--env-file-if-exists` prints `<file> not found. Continuing without it.` instead and goes on) |
| `<file>: invalid format` | an `--env-file` that can't be read (a directory) |
| `either --watch or --check can be used, not both` (also `--eval`, `--interactive`, `--test-force-exit`), `--watch requires specifying a file` | `EnvironmentOptions::CheckOptions` |
| `--secure-heap must be a power of 2` / `--secure-heap-min must be a power of 2` | `PerProcessOptions::CheckOptions` |

A V8 flag with a wrong value gets V8's message before Node's. V8 stops there, so that flag, the V8
flags after it and the V8 flags Node adds itself (`--harmony-import-attributes`,
`--no-harmony-import-assertions`, `--experimental-wasm-imported-strings`, `--experimental-wasm-memory64`,
`--experimental-wasm-exnref`) are all reported as bad options, as in Node:

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

### What the options do

The parsed values are what `internalBinding('options').getCLIOptionsValues()` returns, so Node's own
`lib/` reads and honours them exactly as in Node (`--require`, `--import`, `--conditions`,
`--input-type`, `--experimental-strip-types`, `--unhandled-rejections`, `--trace-warnings`,
`--no-warnings`, `--experimental-vm-modules`, `--test`, …). A few are consumed by the runtime itself:

| Option | Effect in the runtime |
|---|---|
| `--version`, `-v` | printed during boot, before Node's bootstrap |
| `--v8-options` | prints V8's option list (the dump in `src/nodejs/data/v8-options.json`, whose first line lists the CPU features of the machine it was taken on) |
| `-e`, `-p`, `--check`, `--test`, `--interactive`, `--help`, `--prof-process`, `--watch` | choose the main script (table above). `--prof-process` runs V8's tick processor from lib (without a log: `Please provide a valid isolate file as the final argument.`, exit code 1); `--watch` runs Node's watch mode, which restarts the script in a child process when a file it loaded (or a `--watch-path`) changes |
| `--env-file`, `--env-file-if-exists` | see [--env-file](#--env-file) |
| `--run` | see [--run](#--run) |
| `--stack-trace-limit` | `Error.stackTraceLimit` (also in worker threads, which inherit it) |
| `--title` | initial `process.title` |
| `--trace-exit` | `process.reallyExit` prints `(node:<pid>) WARNING: Exited the environment with code <n>` and the stack |
| `--pending-deprecation` | DEP0104 warning for non-string `process.env` values; the GCM short-auth-tag deprecation |
| `--secure-heap`, `--secure-heap-min` | validated; reported by `crypto.secureHeapUsed()` |
| `--max-http-header-size` | default maximum header size of the HTTP parser (16384) |

Accepted but without effect:

- options of type `kV8Option` in Node's table (`--expose-gc`, `--jitless`, `--max-old-space-size`,
  `--max-semi-space-size`, `--abort-on-uncaught-exception`, `--prof`, `--perf-*`,
  `--disallow-code-generation-from-strings`, …) — so `node --expose-gc -e 'typeof gc'` gives `undefined`;
- options of type `kNoOp` (`--experimental-modules`, `--experimental-wasm-modules`, …);
- every other V8 flag (`--use-strict`, `--stack-size=…`, `--harmony-*`, `--allow-natives-syntax`, …):
  the browser's V8 is already running and takes no flags.

### --env-file

As in `node.cc`, before the options are parsed: every `--env-file <file>`, `--env-file=<file>` and
`--env-file-if-exists` on the command line (up to a `--`) is read in order, relative to the working
directory, and parsed like `util.parseEnv()`; a later file wins. A `NODE_OPTIONS` in the files is used for
parsing when the environment has none. When the options were given as Node options (not after the script
name), the variables `process.env` doesn't have yet are set before the main script runs; variables already
in the environment win. `--run` ignores the files' variables, and watch mode leaves them to its child.

```text
$ printf 'FOO=fromfile\n' > .env
$ node --env-file=.env -p process.env.FOO
fromfile
$ FOO=outer node --env-file .env -p process.env.FOO
outer
```

### --run

`node --run <script>` (`src/nodejs/task_runner.ts`, after `node_task_runner.cc`) looks for the nearest
`package.json` from the working directory up (the root directory itself is not searched) and runs
`/bin/sh -c '<script>'` in that file's directory, with stdio inherited and the process's environment plus
`NODE_RUN_SCRIPT_NAME`, `NODE_RUN_PACKAGE_JSON_PATH`, and every `node_modules/.bin` from the working
directory up in front of `PATH`. Arguments after `--` are appended, quoted for the shell the way Node quotes
them. The exit code is 1 if the script failed, else 0. Node does this in C++ before its environment
exists; here it runs after lib's bootstrap (with `child_process`), and no main script runs. Errors, all with
exit code 1: `Can't find package.json for directory <dir>`, `Can't parse <path>`,
`Can't find "scripts" field in <path>`, `Script "<name>" is unexpectedly not a string for <path>`, and
`Missing script: "<name>" for <path>` followed by the available scripts.

### Worker threads

A worker thread parses its own `execArgv` (or the parent's when none is given) together with the
`NODE_OPTIONS` of its environment. `new Worker()` checks them like `Worker::New`: a per-process option
(`--title`, `--openssl-config`, `--secure-heap`, `--report-*`, `--use-openssl-ca`, `--v8-options`, `-h`,
`-v`, …), an option that goes to V8 (`--expose-gc`, `--stack-trace-limit`, `--use-strict`, …) or an
invalid option fails with `ERR_WORKER_INVALID_EXEC_ARGV`; a bad `env.NODE_OPTIONS` fails with
`ERR_WORKER_INVALID_EXEC_ARGV` as well (reported through `invalidNodeOptions`).

## Environment and globals

### process.env

`process.env` (`src/nodejs/env.ts`) is built from the `env` of the init message. It behaves like Node's
interceptor object, not like a `Proxy` (`util.types.isProxy(process.env)` is `false`):

- Assigned values are converted with `String()`; a Symbol value or key throws
  `TypeError: Cannot convert a Symbol value to a string`. With `--pending-deprecation`, the first value
  that isn't a string, number or boolean emits DEP0104.
- Assigning to the empty name stores nothing.
- `Object.defineProperty` with an accessor throws `ERR_INVALID_OBJECT_DEFINE_PROPERTY`
  (`'process.env' does not accept an accessor(getter/setter) descriptor`); a data descriptor must be
  configurable, writable and enumerable.
- Names such as `__proto__` are stored as own properties.

Each thread has its own copy, except with `worker_threads`' `SHARE_ENV`: then the variables live in shared
memory (a lock word, a version counter and JSON text) and every access first picks up what another thread
changed. The buffer is a growable `SharedArrayBuffer` of 64 KiB growing up to 16 MiB (1 MiB fixed where
growable buffers are unavailable); a larger environment throws `RangeError: process.env is too large to share`.

The environment a process starts with comes from whoever spawned it; the kernel's default environment is
described in [Processes](processes.md).

### Global object

After the bootstrap the global object is reshaped from the list of globals dumped from real Node
(`globals` in `process.json`): names a Worker has but Node doesn't (`self`, `postMessage`, `location`,
`indexedDB`, `importScripts`, `caches`, `onmessage`, …) read as `undefined` and are not enumerable; Node's
globals get Node's enumerability; where Node defines a global that the browser also has on the Worker's
prototype chain (`setTimeout`, `navigator`, …), the prototype's copy is removed, so
`delete globalThis.setTimeout` leaves nothing behind. Names starting with `__ov` (the runtime's entry
points, all non-enumerable) are kept.

Node's bootstrap replaces web globals with lib implementations (`URL`, `TextDecoder`, `structuredClone`,
`queueMicrotask`, `MessageChannel`, `Blob`, `fetch`, …). Bindings that need the browser's versions use
copies taken when the worker script loads (`src/nodejs/web.ts`): `URL`, `URLSearchParams`, `TextEncoder`,
`TextDecoder`, `MessageChannel`, `MessagePort`, `BroadcastChannel`, `Blob`, `structuredClone`,
`queueMicrotask`, `fetch`, `XMLHttpRequest` and `navigator.hardwareConcurrency` (4 when unavailable).

`WebSocket` is the browser's (see [fetch](#fetch-and-the-web-classes)). `EventSource` is not a global,
as in Node 22 without `--experimental-eventsource`. `localStorage` is not a global (Node's
`--experimental-webstorage` is off by default; its binding is not implemented).

## process and os values

| API | Value in OpenVessel |
|---|---|
| `process.version`, `process.versions` | `v22.23.4` and every component version of the real Node 22.23.4 build (`v8` `12.4.254.21-node.57`, `openssl` `3.5.9`, …) |
| `process.release`, `process.features`, `process.config` | those of the real build (`release.lts` `Jod`, `features.typescript` `strip`) |
| `process.platform`, `process.arch` | `linux`, `x64` |
| `process.execPath` | `/usr/bin/node` |
| `process.pid`, `process.ppid` | kernel process ids |
| `process.title` | `--title`, else the basename of `argv[0]`; only the main thread can change it |
| `process.debugPort` | 9229; only the main thread can change it |
| `process.getuid()`, `geteuid()`, `getgid()`, `getegid()` | 1000; `getgroups()` → `[1000]` |
| `process.setuid()` etc. | to the real or effective id: succeeds; to another id: `EPERM`; names are looked up in `/etc/passwd` and `/etc/group` |
| `process.memoryUsage()` | `heapUsed` = `performance.memory.usedJSHeapSize` (50 MB when unavailable), `heapTotal` = `totalJSHeapSize`, `rss` = 1.5 × `heapUsed`, `external` and `arrayBuffers` 0 |
| `process.constrainedMemory()`, `availableMemory()` | 0, 4 GiB |
| `process.cpuUsage()`, `threadCpuUsage()` | `user` = wall-clock microseconds since the worker started, `system` 0 |
| `process.resourceUsage()` | all 0 except `userCPUTime` (as above) and `maxRSS` 100000 |
| `process.hrtime()`, `hrtime.bigint()`, `uptime()` | from `performance.timeOrigin` + `performance.now()` |
| `process.kill(pid, sig)` | the kernel's `kill`; `ESRCH`, `EPERM`, `EINVAL` as errors |
| `process.dlopen()` | always `ERR_DLOPEN_FAILED`: `<file>: cannot open shared object file: No such file or directory`, `<file>: file too short`, `<file>: invalid ELF header`, or `Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.` |
| `process.execve()` | the kernel's `execve`; on failure prints `process.execve failed with error code <code>` and exits with 134 |
| `process.loadEnvFile(path = '.env')` | reads the file from the VFS; sets only variables that are not set |
| `process.report.getReport()` | Node's layout; header says glibc 2.36 (`glibcVersionRuntime`), `osRelease` `6.8.0-openvessel`, `osVersion` `#1 SMP OpenVessel`, `osMachine` `x86_64`, `host` `openvessel`, and lists `cpus` and `networkInterfaces` as `os.cpus()`/`os.networkInterfaces()` report them |
| `os.release()`, `os.version()` | `6.8.0-openvessel`, `#1 SMP OpenVessel` (uname's release and version) |
| `os.hostname()` | `openvessel` |
| `os.type()`, `os.machine()`, `os.endianness()` | `Linux`, `x86_64`, `LE` |
| `os.cpus()` | `navigator.hardwareConcurrency` entries, model `OpenVessel Virtual CPU`, speed 2400 |
| `os.availableParallelism()` | `navigator.hardwareConcurrency` |
| `os.totalmem()`, `os.freemem()` | 8 GiB, 4 GiB |
| `os.loadavg()` | `[0, 0, 0]` |
| `os.uptime()` | seconds since the worker started + 1000 |
| `os.networkInterfaces()` | only `lo`, `127.0.0.1/8` |
| `os.homedir()`, `os.tmpdir()` | `$HOME` (else `/home/user`); `$TMPDIR`, `$TMP`, `$TEMP`, `$TEMPDIR` (else `/tmp`) |
| `os.userInfo()` | uid/gid 1000, user name from `/etc/passwd` (else `user`), `homedir` `$HOME`, shell `/bin/sh` |
| `os.setPriority()`, `os.getPriority()` | own process: the value is kept, lowering it (a smaller nice value) fails with `EACCES`; another existing pid: `getPriority` 0, `setPriority` `EACCES`; unknown pid: `ESRCH` |

## Event loop

`src/nodejs/loop.ts` stands in for libuv. It keeps Node's data structures (the `timers`, `immediateInfo`,
`tickInfo` and `async_hooks` fields that lib reads) and Node's order of events, on top of browser tasks.

### Callback scope

Every entry from the loop into JavaScript (timers, immediates, I/O completions, kernel messages) goes
through `scope()`, the equivalent of `InternalCallbackScope`: after the outermost callback returns it runs
`processTicksAndRejections` (the `process.nextTick` queue and microtasks) when `tickInfo` says ticks or
rejections are pending. A `process.nextTick()` called outside any scope (from a promise job) is run in a
separate task once the microtask queue has drained, or earlier by the next callback that enters a scope.

Internal tasks are posted through a `MessageChannel` (faster than `setTimeout(0)`).

### Phases and ordering

- **Timers.** All of lib's timers share one native `setTimeout` (Node's single `uv_timer`); lib schedules
  it through `scheduleTimer(ms)` (minimum 1 ms) and runs due timers in `processTimers(now)`. The expiry
  that `processTimers` returns wins over timers scheduled from inside it, as in `RunTimers`. After an
  uncaught exception that a handler swallows, `processTimers` is called again so the remaining due timers
  still run. `uv_now()` (`getLibuvNow`) is milliseconds since the loop started, plus one.
- **Immediates (check phase).** When immediates are queued, the runtime waits two internal tasks before
  running `processImmediate` — so the browser's `unhandledrejection` events for the current task are
  reported first, as Node reports rejections before the next check phase. If the timer is already due, the
  timers run first (a loop iteration runs expired timers before the check phase). After an uncaught
  exception, the rest of the immediate queue still runs in the same phase. A `setImmediate()` made outside
  a callback scope (e.g. after a top-level `await`) takes a turn by itself.
- **I/O.** Kernel messages (`fd-data`, `tcp-accept`, `child-exit`, …) are handled as they arrive, each in
  its own scope.

### Liveness, ref and unref

The loop is alive while any of these exist:

- a request in flight (`startReq`: fs callbacks, DNS lookups, connects, `fetch` requests and body reads,
  module loading, `WebAssembly.compile` and other tracked promises),
- the shared timer, if it is ref'd,
- a ref'd immediate (`immediateInfo[kRefCount] > 0`),
- an active, ref'd handle (sockets, pipes, servers, child processes, signal watchers, workers, file
  watchers, …).

`ref()`/`unref()` on handles and `timeout.unref()` change the corresponding flag. After every change the
runtime schedules a liveness check (one internal task plus a 2 ms timeout, so work the browser finishes by
itself can land). When nothing keeps the loop alive:

1. Rejections still held (see below) are released first.
2. `process.emit('beforeExit', process.exitCode ?? 0)` runs in a scope, unless the process is already
   exiting; if that made the loop alive again, the loop continues.
3. If a module's top-level `await` never settled, the exit code becomes 13 and
   `Warning: Detected unsettled top-level await at <url>:<line>` is printed with the line and a caret.
4. `process.emit('exit', code)` runs, then the process exits with `process.exitCode` (default 0).

`process.getActiveResourcesInfo()` lists requests in flight (not handle closes), then ref'd handles by
resource name, then one `Timeout` per ref'd timer and one `Immediate` per ref'd immediate.
`process._getActiveHandles()` and `_getActiveRequests()` return the owners.

### Uncaught exceptions

An exception escaping a callback goes to `process._fatalException` (Node's `TriggerUncaughtException`).
If it is not handled, the error is printed to fd 2 and the process exits with the exit code an `exit`
handler set, or 1. The printout is Node's: the source line with a caret (when the error's first frame is a
file or a builtin whose source can be read), the stack (after Node's `enhanceStackForFatalException`), and
`Node.js v22.23.4`. A thrown non-error is printed as
``Uncaught <inspect(value)>`` followed by ``(Use `node --trace-uncaught ...` to show where the exception was thrown)``.
Errors the Worker reports through its own `error` event are treated the same way.

### Unhandled rejections

The browser decides at the end of a task that a rejection is unhandled; Node decides only after
`processTicksAndRejections` has run out of ticks and microtasks. So the Worker's `unhandledrejection`
event does not reach Node immediately: the rejection is held until no `nextTick` work is pending, plus one
more task for a `rejectionhandled` event to arrive. A rejection that gets a handler while held is dropped
silently. Released rejections go to Node's promise-reject callback as `kPromiseRejectWithNoHandler`;
later `rejectionhandled` events as `kPromiseHandlerAddedAfterReject`. From there lib applies
`--unhandled-rejections` exactly as Node does (default `throw`: the error is printed and the exit code is 1).

## Module loading

### Builtins

`require('fs')`, `require('node:fs')` and `import 'node:fs'` load Node's own `lib/` modules from
`nodelib.js`. Two dependencies are replaced by overrides (see [Overrides](#overrides)); the V8 profiler
tools under `internal/deps/v8/tools/` are not shipped, so `node --prof-process <log>` fails with
`TypeError [ERR_INVALID_ARG_TYPE]: The "sourceText" argument must be of type string. Received undefined`
(without a log it answers like Node).

### CommonJS

Node's own CommonJS loader runs unchanged. The native part, `contextify.compileFunctionForCJSLoader`,
compiles each file with an indirect `eval` as a function of
`exports, require, module, __filename, __dirname`, with the file's code on the wrapper's first line (so
line numbers match) and a `sourceURL` of the file name. A leading `#!` line is turned into a comment. When
the code fails to compile and looks like ES module syntax (with `--experimental-detect-module`, on by
default in 22.23.4), lib retries it as an ES module, as in Node. `import()` inside CommonJS code is routed
to Node's `importModuleDynamically` callback.

### ES modules

ES modules are real browser modules, evaluated by the browser (`src/nodejs/bindings/module_wrap.ts`):

1. Node's ESM loader resolves and loads the source and creates a `ModuleWrap`. The binding scans the
   source with `es-module-lexer` for static imports and re-exports, `import.meta` and `import()`.
2. When lib links the graph, each static specifier in the source is rewritten to the URL of the
   `ModuleWrap` it was linked to. Import attributes (`with { type: 'json' }`) are removed from the served
   source (lib has already checked them; the target is always served as JavaScript).
3. `import.meta` becomes `globalThis.__ovImportMeta(<id>)`, which calls Node's
   `initializeImportMeta` callback; `import(` becomes `globalThis.__ovDynamicImport.bind(null, <id>)(`,
   which calls Node's `importModuleDynamically` callback.
4. On evaluation every module of the graph is registered with the kernel (`esmRegister` system call). The
   runtime's service worker serves them at `/__ov/mw/<pid>/<id>.mjs`, and evaluating the root is a native
   `import()` of its URL. Linking, cycles, live bindings and top-level `await` are therefore the
   browser's. The kernel drops a process's modules when it exits.
5. Builtins, CommonJS modules and JSON modules reach the browser as generated "synthetic" modules: one
   `var` per export name, exported, and assigned by the binding's `setExport()`.

Module evaluation counts as a request (the loop stays alive) until the module's own body starts to run; a
top-level `await` that never settles after that does not keep the process alive (exit code 13, above).

### require(esm)

`require()` of an ES module (enabled by default in 22.23.4) must evaluate synchronously, which the
browser cannot do with a module graph. The binding therefore runs each source module of the graph as a
CommonJS-shaped function produced by sucrase's `imports` transform (`dist/runtime/ts-strip.js`, loaded
the first time it is needed), and synthetic modules run their evaluation steps directly. A graph with
top-level `await` fails with `ERR_REQUIRE_ASYNC_MODULE`, as in Node. If the same module is later imported,
the browser gets a facade module that re-exports the values `require()` produced, so the code is not run
twice.

```js
// m.mjs: export const v = 42; export default function f() { return 'def'; }
const m = require('./m.mjs');
console.log(m.v, m.default()); // 42 def
```

### import.meta

`import.meta.url` (a `file://` URL), `import.meta.resolve()` and `import.meta.main` are set by Node's
callback. For a `file:` module, `internalBinding('modules').setLazyPathHelpers` adds
`import.meta.dirname` and `import.meta.filename` (the module's directory and path, as
`url.fileURLToPath()` gives them) as writable, enumerable data properties, so `Object.keys(import.meta)`
is `['dirname', 'filename', 'main', 'resolve', 'url']` as in Node. Node computes them on first access;
here they are computed right away.

### Conditions, preloading and hooks

These are handled by Node's lib and work as in Node: `--conditions`/`-C` for both `require` and `import`,
`--require`/`-r`, `--import`, `--input-type`, `--experimental-default-type`, and module customization
hooks registered with `module.register()`:

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

### vm modules

`vm.SourceTextModule` and `vm.SyntheticModule` (with `--experimental-vm-modules`) are implemented in the
same binding. Source-text modules created through `vm` are evaluated with sucrase's `imports` transform
inside the context's scope (see [vm](#vm)); before instantiation every request must be linked and every
imported name must exist (`ERR_VM_MODULE_LINK_FAILURE`, or
`SyntaxError: The requested module '<spec>' does not provide an export named '<name>'`). A graph with
top-level `await` is evaluated dependency by dependency. `cachedData` that was not produced for the same
source is rejected with `ERR_VM_MODULE_CACHED_DATA_REJECTED`.

### Compile cache

`module.enableCompileCache()` reports the cache as disabled with the message
`the compile cache is not available in OpenVessel`; `module.getCompileCacheDir()` returns `undefined`.

## TypeScript

Type stripping is Node's own: `--experimental-strip-types` is on by default in Node 22.23.4, and lib
decides which files are stripped (`.ts`, `.mts`, `.cts`, and `--input-type=module-typescript` /
`commonjs-typescript` for eval input) and which errors to raise. lib calls `internal/deps/amaro`, which the
override replaces with `globalThis.__ovAmaro` (`src/nodejs/typescript.ts`). The real amaro — the same
version Node bundles (`process.versions.amaro` 1.1.8), swc compiled to WebAssembly, about 3 MB — is
shipped as `dist/runtime/amaro.js` and fetched with a synchronous `XMLHttpRequest` from the runtime origin
the first time something is stripped, then evaluated once per worker.

| Command | Result |
|---|---|
| `node a.mts` with type annotations only | runs |
| `node e.ts` with an `enum` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` |
| `node --experimental-transform-types e.ts` | runs (with the ExperimentalWarning); source maps are enabled by implication |
| `node --no-experimental-strip-types a.mts` | `SyntaxError` from the JavaScript parser |

The legacy runtime strips types with sucrase's `typescript` transform instead, which also accepts enums
and other non-erasable syntax.

## fetch and the web classes

Node's `fetch`, `Headers`, `Request`, `Response`, `FormData`, `WebSocket`, `EventSource` and `MessageEvent`
come from `internal/deps/undici`, which the override replaces with `globalThis.__ovUndici`
(`src/nodejs/fetch.ts`). undici speaks HTTP over TCP sockets, which a browser cannot open to the outside.

### Routing

| URL | How it is fetched |
|---|---|
| `data:`, `blob:` | the browser's `fetch` directly |
| `http:`/`https:` to `localhost`, `*.localhost`, `127.0.0.1`, `::1`, `[::1]`, `0.0.0.0` | Node's own `http.request()` (`https.request()` for `https:`) to `127.0.0.1` on the URL's port, or the scheme's default (80, 443) — a real TCP connection to a virtual port, so it reaches servers inside OpenVessel. `https:` goes through `tls` like any `https` client (server name and certificate check use the URL's host name) |
| other `http:`/`https:` | the runtime service worker's `/__ov/net?url=…` endpoint, which applies the [network policy](network-policy.md) and makes the request with the browser's `fetch` |
| any other scheme | `TypeError: fetch failed`, `cause.code` `ERR_INVALID_URL` (`unsupported URL scheme <scheme>`) |

### Behaviour of requests to virtual ports

These follow undici: the request carries `host` (the URL's host), `connection: keep-alive`, the headers
undici adds when the request doesn't set them (`accept: */*`, `accept-language: *`,
`sec-fetch-mode: cors`, `user-agent: node`, `accept-encoding: gzip, deflate`) and a `content-length` for a
body. Redirects (301, 302, 303, 307, 308) are followed up to 20 times as the Fetch Standard says
(`redirect: 'manual'` returns the redirect, `'error'` fails; a 303, or a 301/302 after `POST`, becomes a
`GET` without body; `authorization`, `cookie` and `proxy-authorization` don't go to another origin).
`gzip`, `x-gzip`, `deflate` and `br` response bodies are decoded. Requests to the Fetch Standard's bad
ports fail with `bad port`. A refused connection rejects with `fetch failed` whose `cause` is the socket's
own error (`ECONNREFUSED`, with `errno`, `syscall`, `address`, `port`).

### Behaviour of outside requests

- Request headers travel in an `x-ov-h` header; the service worker drops headers a page may not set or
  that make no sense across the proxy (`host`, `connection`, `content-length`, `cookie`, `origin`,
  `referer`, `accept-encoding`, `sec-*`, `proxy-*`, …).
- The body is read completely before the request is sent. `GET` and `HEAD` carry no body.
- `redirect: 'error'` is honoured; anything else follows redirects. `response.url` and
  `response.redirected` reflect the final URL.
- Requests are made with `mode: 'cors'`, `credentials: 'omit'`, `cache: 'no-store'`. The server must
  allow cross-origin requests, and only the response headers the browser exposes under CORS are visible.
- The request and each pending body read count as loop requests (`FetchRequest`, `FetchBody`), so the
  process stays alive while they are in flight.
- `Request` and `Response` accept Node's `AbortSignal`, lib's `ReadableStream` and async iterables as
  bodies (a streamed request body implies `duplex: 'half'`). Every response `fetch` returns is an instance
  of the global `Response`.
- The `x-ov-by` header tells the host which process asked (pid and the first argv entries), for permission
  prompts.

### Errors

Failures reject with `TypeError('fetch failed')` whose `cause` carries a code:

| `cause.code` | When |
|---|---|
| `EACCES` | the network policy denied the host: `OpenVessel: network access to <host> was denied by the network policy` |
| `ECONNREFUSED` | the browser's `fetch` failed (often CORS): `request to <host> failed: <message>. The server may not allow cross-origin requests (CORS) from the browser.`; also a refused loopback connection (there `cause` is the socket's error) |
| `ERR_INVALID_URL` | unsupported scheme |

Other HTTP clients (`http.get`, undici from npm, axios, got) go through `net`/`tls` instead; the kernel
reads their HTTP/1.1 requests and makes them with the same policy-checked proxy. That path is described in
[Network policy](network-policy.md) and [Kernel](kernel.md).

## Overrides

`src/nodejs/overrides/` holds the only replacements of files of Node's `lib/`. `scripts/gen-nodelib.mjs`
puts each file there in place of the builtin with the same id.

| Builtin id | Replaced by | Why |
|---|---|---|
| `internal/deps/undici/undici` | `module.exports = globalThis.__ovUndici;` (from `src/nodejs/fetch.ts`) | undici needs outgoing TCP sockets; fetch goes to virtual ports through `node:http` and everywhere else through the policy-checked proxy |
| `internal/deps/amaro/dist/index` | `module.exports = globalThis.__ovAmaro(require);` (from `src/nodejs/typescript.ts`) | amaro bundles swc as a 3 MB WebAssembly module; it is kept out of `nodelib.js` and fetched on first use |

## worker_threads

A worker thread is another Web Worker of the same process, started by the kernel
(`internalBinding('worker')`). It boots like a process but runs `internal/main/worker_thread`; the parent
and the thread talk over a `MessageChannel` on which Node's lib speaks its own protocol.

- `threadId` is per process (the kernel reserves it); `isMainThread`, `threadName`, `resourceLimits` and
  `SHARE_ENV` are supported. `resourceLimits` are recorded and reported back but not enforced.
- `receiveMessageOnPort()` and synchronous draining work through shared-memory rings: every message on a
  `MessageChannel` port is also written, serialized with `v8.serialize`, to a ring that starts at 16 KiB
  and grows to 1 MiB (1 MiB fixed without growable `SharedArrayBuffer`). Messages that can't be serialized
  that way are delivered only the normal way.
- With `trackUnmanagedFds` (the default) the fds a thread opened with `fs.open` are closed when it exits.
- `worker.getHeapStatistics()` reports numbers derived from `performance.memory`; `worker.cpuUsage()`
  reports wall time since the thread started; `startCpuProfile()`/`stopCpuProfile()` return an empty
  profile in V8's format; `getHeapSnapshot()` is unavailable.
- A thread runs on the same runtime as its process's main thread, even if `/etc/openvessel/node` changed
  after the process started.

## child_process

`spawn`, `exec`, `execFile`, `fork` and their `Sync` variants are Node's lib over `process_wrap` and
`spawn_sync`, which call the kernel's `spawn`/`spawnSync`. The programs that exist are `node` and the
programs built into the kernel (see [Processes](processes.md) and [Shell and commands](shell.md)).

- stdio `pipe`, `overlapped`, `inherit`, `ignore`, an fd number and passing a stream's handle are
  supported. An `ipc` channel is a kernel socket pair; Node's lib finds it through `NODE_CHANNEL_FD` and
  removes that variable from the child's `process.env`, as in Node. Handles (sockets, servers) can be sent
  over IPC.
- `uid`/`gid` other than the process's own fail with `EPERM`. `detached` is not passed to the kernel.
- `spawnSync`: `timeout`, `killSignal` and `input` are passed to the kernel. When `maxBuffer` is exceeded,
  output is cut at the 64 KiB read that crossed the limit (as libuv reads), `error` is `ENOBUFS`, `status`
  is `null` and `signal` is the kill signal (`SIGTERM` by default).
- Signals between processes (`process.kill`, `child.kill`, `process.on('SIGINT')`) go through the
  kernel.

## Stack traces and errors

A browser's V8 calls `Error.prepareStackTrace` directly, where Node's V8 calls a C++ callback that runs
Node's JavaScript callback. `installStackTraceHook()` (`src/nodejs/boot.ts`) puts a function in that slot
which does what the C++ does:

- Frames of the runtime itself (the worker script) are removed, as are the indirect-`eval` boundaries the
  runtime creates when it compiles a module or script; a user's own `eval`/`new Function` frames stay.
- Code compiled with `eval` reports its top-level frame as `eval (file:line:col)` in a browser; it is
  rewritten to `file:line:col` (or `Object.<anonymous> (file:line:col)` for a CommonJS module wrapper), and
  columns on line 1 of a CommonJS file are corrected for the wrapper.
- `vm.compileFunction` code is mapped back to its file name, line and column offsets.
- `CallSite.prototype.getFileName` and `getScriptNameOrSourceURL` are patched so that ES modules report
  their `file://` URL (not the `/__ov/mw/…` URL they were served from) and eval-compiled code reports its
  `sourceURL` — also for libraries that install their own `Error.prepareStackTrace` (callsites, depd, …).
- Node's own `prepareStackTrace` callback (set through `setPrepareStackTraceCallback`) then formats the
  trace, so error messages, `code` properties and stack frames read like Node's:

```text
[eval]:1
console.log(require("fs").readFileSync("/nonexistent"))
                          ^

Error: ENOENT: no such file or directory, open '/nonexistent'
    at Object.openSync (node:fs:560:18)
    at Object.readFileSync (node:fs:444:35)
    at [eval]:1:27
```

Differences that remain: code run through `vm` APIs (which `-e` uses) can show an extra
`at eval (<anonymous>)` frame; `util.getCallSites()`/`callsites` come from the same hook;
`getCallerLocation` returns `undefined`. Error source positions for fatal errors
(`getErrorSourcePositions`) are taken from the first stack frame.

## vm

A Web Worker can't create a new JavaScript realm, so `vm` contexts are emulated
(`src/nodejs/bindings/contextify.ts`):

- A context's global is a proxy over the contextified object (the sandbox) that falls back to the
  ECMAScript built-ins. Code runs inside `with (scope)`, where free names resolve to the sandbox, then the
  built-ins, while the worker's own globals (`process`, `require`, …) read as `undefined`.
- Top-level `var` and function declarations of a script land on the sandbox and can't be deleted, as in
  V8; `this` at top level and in sloppy functions called plainly is the context's global.
- `codeGeneration: { strings: false }` replaces `eval`/`Function` in the context with versions that throw
  `EvalError: Code generation from strings disallowed for this context`; `{ wasm: false }` makes
  `WebAssembly.compile` etc. fail with `WebAssembly.<fn>(): Wasm code generation disallowed by embedder`.
- `vm.constants.DONT_CONTEXTIFY` returns an ordinary global object.
- `cachedData`: V8's code cache can't be produced; `createCachedData()` returns a 16-byte record
  (`OVC1`, length and two hashes of the source) and a `cachedData` that doesn't match the source is
  rejected the way V8 rejects it.
- `vm.measureMemory()` reports `performance.memory.usedJSHeapSize`.

Not emulated: separate built-ins (`vm.runInContext('Array', ctx) === Array` is `true`), the `timeout` and
`breakOnSigint` options (accepted; a script that never returns hangs), and `microtaskMode`.

## AsyncLocalStorage

Node propagates async context through promises with V8 promise hooks, which a browser doesn't expose
(`setPromiseHooks` is a no-op). Context set with `AsyncLocalStorage.run()`/`enterWith()` is visible in
synchronous code and in callbacks scheduled before the first `await` (`process.nextTick`, timers,
immediates, I/O), but it is lost after an `await`:

```js
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
als.run(42, async () => {
  console.log(als.getStore()); // 42
  await null;
  console.log(als.getStore()); // undefined
});
```

`async_hooks.createHook()` hooks fire for the resources lib creates in JavaScript (`Timeout`,
`Immediate`, `TickObject`, `AsyncResource`, …) and, as in Node's C++ `AsyncWrap`, for the native ones:
handles (`TCPWRAP`, `TCPSERVERWRAP`, `PIPEWRAP`, `PIPESERVERWRAP`, `TTYWRAP`, `TLSWRAP`, `UDPWRAP`,
`PROCESSWRAP`, `SIGNALWRAP`, `FSEVENTWRAP`, `STATWATCHER`, `WORKER`, `MESSAGEPORT`), requests
(`FSREQCALLBACK`, `FSREQPROMISE`, `FILEHANDLECLOSEREQ`, `TCPCONNECTWRAP`, `PIPECONNECTWRAP`,
`SHUTDOWNWRAP`, `WRITEWRAP` for a write that couldn't finish at once, `GETADDRINFOREQWRAP`,
`GETNAMEINFOREQWRAP`, `QUERYWRAP`) and others (`FILEHANDLE`, `DIRHANDLE`, `DNSCHANNEL`, `ZLIB`,
`HTTPINCOMINGMESSAGE`, `HTTPCLIENTREQUEST`, the crypto jobs). Each gets an async id when it is made — a
request object lib creates (`WriteWrap`, `TCPConnectWrap`, …) when the binding starts the request with
it — and `init` runs then (the trigger is the default trigger id or the current execution id; a request
started on a handle and a connection accepted by a server are triggered by that handle), its callbacks run in its async context with `before`/`after` around them
(`executionAsyncId()` and `executionAsyncResource()` are the resource), and `destroy` follows when a
handle has closed or a request has completed. Resources Node destroys only on garbage collection
(`FILEHANDLE`, `DIRHANDLE`, `ZLIB`, …) never report `destroy`. Without hooks this costs an id and a
push/pop of the async context per callback, as in Node. Promise hooks never fire (no `PROMISE`
resources), so the trigger of a resource made in a promise reaction is the enclosing execution id, not
the promise.

## Inspector, profiling and diagnostics

- `node:inspector` loads. `inspector.url()` is `undefined`, `open()` and `waitForDebugger()` do nothing,
  and every protocol message posted on a `Session` is answered asynchronously with error `-32601`
  `The inspector is not available in OpenVessel`. Console calls go to Node's console only.
- V8 coverage (`NODE_V8_COVERAGE`): the directory is accepted, nothing is written.
- Heap snapshots (`v8.getHeapSnapshot()`, `v8.writeHeapSnapshot()`) throw
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
- `v8.getHeapStatistics()` and related functions return numbers derived from `performance.memory`;
  `v8.setFlagsFromString()` records flags but changes nothing.
- `perf_hooks.monitorEventLoopDelay()` samples with a browser interval timer; `createHistogram()` is a port
  of HdrHistogram with Node's buckets; `eventLoopUtilization()` reports zero idle time.
- Trace events are disabled (`trace_events` categories are never enabled).

## Not implemented

These load but fail when used, with `ERR_NOT_IMPLEMENTED`
(`internalBinding ('<name>').<member> is not implemented in OpenVessel`) unless noted:

| Feature | Behaviour |
|---|---|
| `node:http2` | `require` works, and `http2.createServer()`/`createSecureServer()` return a server that listens. Every session fails, because `new Http2Session()` throws `ERR_NOT_IMPLEMENTED` (`internalBinding ('http2').Http2Session is not implemented in OpenVessel`): `http2.connect()` returns a `ClientHttp2Session`, which emits that error as its `error` event once the socket has connected, then `close`; a connection to a server throws it from the server's connection listener as an uncaught exception (the process exits with 1 unless `uncaughtException` is handled) |
| `node:sqlite` | `new DatabaseSync()` fails |
| `node:sea` | `sea.isSea()` etc. fail |
| `net.BlockList`, `net.SocketAddress` | construction fails (`block_list`) |
| `tls.connect({ socket })` with a JavaScript stream (not a native socket) | fails (`js_stream`) |
| `localStorage`/`sessionStorage` | not available (`webstorage`) |
| `--permission` | `process.permission.has()` fails (`permission`) |
| native addons | `process.dlopen` always fails (above) |

The binding-level status of every module is in [Bindings](bindings.md).

## Related pages

- [Bindings](bindings.md) — every `internalBinding()` module and its status
- [Processes](processes.md), [Kernel](kernel.md), [Protocol](protocol.md) — the kernel side
- [Network policy](network-policy.md) — what outgoing requests may do
- [Compatibility](../compatibility.md) — measured results and platform limits
- [How it works](../how-it-works.md)
