# Changelog

OpenVessel follows [Semantic Versioning](https://semver.org). Each release states the Node.js
version it ports; see [docs/NODE-VERSION.md](docs/NODE-VERSION.md) for how that version is tracked.

## 1.2.0 — (unreleased) · Node.js v22.23.4

### Node.js runtime

- The ported runtime (Node.js's own `lib/` on `internalBinding()` in TypeScript) is now the default for
  every `node` process. Writing `legacy` to `/etc/openvessel/node` selects the older hand-written runtime;
  `port` is still accepted and means the default. All published compatibility numbers were already measured
  on the ported runtime.
- Command line: V8 flags are checked against V8's list and passed on as Node does; option names accept `_`
  for `-`; `--no-` on a non-boolean option is an invalid negation; `--env-file`, `--env-file-if-exists`,
  `--run`, `--watch`, `--prof-process`, `--v8-options` and `--stack-trace-limit` behave as in Node. A
  worker's `execArgv` takes no V8 flags.
- Native resources (handles, requests, fs, zlib, dns) are AsyncWraps, so `async_hooks` sees `init`,
  `before`/`after` and `destroy` for them.
- `fetch` to a virtual port uses the scheme's default port and goes through `tls` for `https:`, with
  undici's headers, redirects and decoding; `fetch` returns the global `Response` class.
- An HTTPS server inside the runtime no longer hangs (a server's TLSWrap takes over the socket's reads).
- `import.meta.dirname` and `import.meta.filename` for `file:` modules; `os.release()`/`os.version()` in
  `uname` order; llhttp reports 9.4.3, as `process.versions` says.
- A handler attached with `then()`/`catch()` drops a held rejection at once, as V8's promise reject
  callback does.
- WASI: path calls stay inside their directory fd (`ENOTCAPABLE`, as uvwasi), including `..` above the
  directory a module sees as `/`.
- `NAPI_RS_FORCE_WASI=true` is in the default environment, the value both older and newer napi-rs loaders
  read as forcing WASI.
- Legacy runtime: its URLs (`/__ov/esm`, `/__ov/builtin`, `/__ov/net`) live under the runtime's base, so it
  works when served under a path; `process.dlopen` fails with `ERR_DLOPEN_FAILED` and `process.umask` uses
  the kernel's mask; `node:wasi` takes `version` and skips undefined env values.

### Firefox

- The ported runtime runs in the current Firefox release: the shell, npm, Astro build and dev server with
  the preview, and 1200 of the 1237 Node tests that pass in Chrome. Chrome results are unchanged.
- V8's stack trace API (CallSites, `Error.prepareStackTrace`, V8-format stacks) is emulated where the engine
  lacks it, and SpiderMonkey's messages for ESM syntax errors, early function close, top-level `return` and
  the promise brand check are recognised.
- Without `location.ancestorOrigins`, the runtime refuses a parent that isn't the top-level window.

### Host API

- `Process.end()` works on terminal processes: it sends EOF (`^D`) through the line discipline.
- New `error` event (`RuntimeErrorEvent`) for errors the runtime frame reports after boot. A reloaded
  runtime frame or a kernel that stops answering is fatal: waiting and later calls reject and processes end.
- `permission-settled` carries `decision`, which is `'timeout'` when nobody answered; it is also emitted on
  timeout, and the built-in dialog closes then.
- `server-ready` is held until the preview relay is up, so its `url` works at once; a failed relay start is
  retried by the next `previewUrl()` or `createPreview()`.
- Host method arguments are checked (`ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`) and every error reaches
  the host with a code.
- `runtimeUrl` and `previewUrl` whose last segment has no extension are treated as directories.
- `teardown()` rejects waiting calls, ends processes, removes its message listeners and closes its dialogs;
  a failed boot removes its frame.

### Network policy and previews

- Loopback hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, …) are always denied by the policy, in
  every mode. `curl`, `wget` and the package managers send loopback URLs to the virtual ports instead, and a
  preview page's `http://localhost:<port>` reaches that virtual port.
- Presets are checked as own properties; IPv6 hosts and patterns are supported.
- Several runtime frames on one origin share one service worker: each kernel runs under its own
  `/__ov/k/<id>/` prefix, and module loads and network checks go to the kernel the URL names.
- Redirects are checked at the URL where they end, in the runtime and in the preview.
- The preview fails closed without a kernel channel, and asks the policy before a page opens a WebSocket to
  an outside host.
- In the preview, `no-cors` loads (images, classic scripts) pass through and are checked at their first URL
  only, so images from servers without CORS show. The preview service worker is served with COEP
  `credentialless`; `scripts/serve.mjs` no longer sends `Service-Worker-Allowed`.
- `'once'` allows only the waiting requests and is never cached; `setPolicy()` and `clearSession()` make the
  preview service workers drop cached allows.
- The kernel names the initiator of a permission request from the process table, so a process can't pose
  as npm. An unanswered request gives a timeout error (504).

### Shell and commands

- `cmd &` runs in a new process, so `$!` works with `kill` and `wait`; EXIT, ERR and signal traps run; bash
  error and alias semantics; `"$@"` with no parameters expands to nothing; `[[ =~ ]]` takes unquoted
  parentheses and blanks as bash does.
- GNU option parsing and fixes across coreutils (`timeout`, `xargs`, `kill`, `seq`, `chmod`, `tr`, `find`,
  `date`, `grep`, `sed`, `tail`, `diff`, `stat`, …).
- `curl -i`/`-I`/`-D` show the origin server's status line and headers, not the proxy's; more short-option
  combinations and `-w`, `-G`, `-A`, `-e`, `-u`.

### Package managers

- Options are read where the real clients read them (`-h` and unknown flags pass on to scripts and `npx`
  commands); `npx -p`; dist-tags are saved as `^version`; full metadata for `view`; `npm root -g`, `help`,
  workspace selection and per-client command precedence.
- Yarn Berry lockfiles give version hints, workspace links are recorded like npm, and a failed compat index
  fetch is retried.

### Kernel

- Linux signal table and `kill` semantics (process groups, signal 0), a per-process `umask`, permission
  checks for processes, `EMFILE` from `RLIMIT_NOFILE`, and ephemeral ports for the connecting side of TCP.
- A process's worker threads use the runtime its main thread started with.
- `/dev/tty` is a character device node.

### Tooling and docs

- Technical reference in English and Japanese (`docs/reference/`).
- `OV_BROWSER=firefox` runs the end-to-end harness in Playwright's Firefox.
- `corpus/run.mjs` runs on the ported runtime by default (results in `corpus/results/port/`) and takes
  `--legacy`; `test/e2e/dev.mjs` takes `--legacy`; `test/node-compat/run.mjs` warns about tests missing from
  the baseline.

## 1.1.1 — 2026-10-26 · Node.js v22.23.4

- Fix: `npm install` could pick a `@napi-rs/wasm-runtime` whose emnapi peer doesn't match the emnapi a
  WebAssembly binding pins (wasm-runtime 1.2.6 with rolldown's binding: rolldown, and so Astro 7, failed to
  load). The installer now takes the newest release in the binding's range whose peer accepts that emnapi.

## 1.1.0 — 2026-10-25 · Node.js v22.23.4

- The class returned by `spawn()` is now `Process` (was `VesselProcess`). Only the entry point keeps the
  product name; every type reachable from it has a neutral name. `VesselProcess` stays as a deprecated alias.

## 1.0.0 — 2026-10-25 · Node.js v22.23.4

First stable release.

- Runs Node.js v22.23.4's own `lib/` in a browser tab; the C++ half (`internalBinding()`) is
  re-implemented in TypeScript on a small kernel (file system, processes, pipes, TTY, sockets, `sh`).
- `npm`, `pnpm`, `yarn` and `bun` clients, installing real projects from the npm registry.
- Astro 7, 6 and 5: `install`, `build` and `dev` with hot module replacement, previewed in an iframe.
  131 of a corpus of 147 real sites build.
- Node's own test suite: 1237 of the 1237 tests a browser can pass (34 more are listed with the reason).
- Native packages are installed as their WebAssembly builds; compat packages cover Pagefind,
  resvg-js and cn-font-split.
- Outgoing network traffic is checked against one network policy (`ask`, `allowlist`, `allow-all`); servers use
  virtual ports and are never reachable from outside.
- Host API (`OpenVessel.boot`, `mount`, `export`, `spawn`, `exec`, `ps`, `ports`, `on`,
  `createPreview`, `previewUrl`, `teardown`) with TypeScript declarations.

### Stability

From 1.0.0 the host API (`dist/host`, with its declarations) and the three-origin embedding
requirements are covered by semver. Not covered: `src/` internals, the files inside `dist/runtime`
and `dist/preview`, and the contents of the compat packages.
