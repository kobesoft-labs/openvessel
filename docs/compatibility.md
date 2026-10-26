# Compatibility

[日本語](compatibility.ja.md)

OpenVessel runs Node.js's own JavaScript (`lib/`) and re-implements the native half in TypeScript. Whether
a given feature is supported therefore usually depends on one question: does it need something a browser
tab can't provide? This page lists what is measured, what works and what doesn't, with the reason in each
case.

## Node.js's own test suite

The measurement is done by `test/node-compat/run.mjs`:

- The tests are Node.js's own `test/parallel` files for the modules OpenVessel targets (fs, stream,
  buffer, events, child_process, process, worker_threads, crypto, zlib, vm, timers, module loading,
  util, url, readline, …), from the same Node version (v22.23.4).
- A test counts only if it passes on real Node.js on Linux (`--baseline`).
- Tests that exercise Node's internals rather than its public behaviour are out of scope and are not run.
  These are tests that need `--expose-internals`, call `internalBinding`/`process.binding`, set V8 flags,
  or use the inspector, profilers, snapshots, reports, single executable applications or the permission
  model.
- Tests that can't pass in a browser are listed with the reason in `test/node-compat/limits/*.json`.
  The target is every other test. The report shows `pass / target`, and the goal is 100%.

Result (2026-10-24, Chrome):

| Module | Pass | Target | Listed as limits |
|---|---:|---:|---:|
| fs | 173 | 173 | 4 |
| stream | 165 | 165 | 1 |
| worker_threads | 118 | 118 | 11 |
| crypto | 96 | 96 | 2 |
| child_process | 94 | 94 | 1 |
| vm | 78 | 78 | 11 |
| process | 73 | 73 | 1 |
| buffer | 60 | 60 | 1 |
| zlib | 60 | 60 | 0 |
| timers | 47 | 47 | 0 |
| module, require | 48 | 48 | 0 |
| events, event-emitter | 33 | 33 | 0 |
| stream2, stream3, readable | 35 | 35 | 0 |
| url, whatwg-url | 36 | 36 | 0 |
| console | 19 | 19 | 0 |
| util | 18 | 18 | 0 |
| assert | 17 | 17 | 1 |
| path | 16 | 16 | 0 |
| readline | 13 | 13 | 0 |
| process.nextTick, microtasks, promises | 18 | 18 | 0 |
| async_hooks (AsyncLocalStorage) | 7 | 7 | 1 |
| os | 6 | 6 | 0 |
| querystring | 4 | 4 | 0 |
| string_decoder | 3 | 3 | 0 |
| **All** | **1237** | **1237 (100%)** | **34** |

The 34 tests listed as limits break down by reason as follows (each file in `test/node-compat/limits/`
gives the reason per test):

| Reason | Tests |
|---|---:|
| Stopping JavaScript while it runs (`vm` `timeout`, `breakOnSigint`) or a context with its own microtask queue (`microtaskMode`) | 9 |
| The inspector, heap snapshots or per-thread heap limits | 7 |
| A context with its own built-ins (a separate V8 realm) | 4 |
| HTTP/2: not implemented, and not a browser limit (porting `node_http2.cc` over nghttp2 is a large project of its own) | 4 |
| No OS underneath: another program (`python3`), `RLIMIT_FSIZE`, changing the time zone at run time, UDP | 4 |
| One allocation of 2 GiB or more | 2 |
| macOS-only tests (OpenVessel is a Linux system, so they skip themselves) | 2 |
| `AsyncLocalStorage` after `await` (V8 promise hooks) | 1 |
| An OpenSSL configuration file | 1 |

To measure again, run `node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report`.
The table is written to `test/node-compat/results/port/REPORT.md`.
<!-- numbers: updated with each full run -->

## Firefox

The ported runtime (the default) works in the current Firefox release. This covers booting, the shell,
`node` (CommonJS, ES modules, TypeScript, `worker_threads`, `child_process`, zlib, crypto), `npm install`,
`npx`, an HTTP server in the preview, and Astro builds and `astro dev` with hot reload over WebSocket.
Of Node's own tests, 1200 of the 1237 that pass in Chrome also pass in Firefox (2026-10-26, Playwright's
Firefox 157). The rest fail for these reasons:

- Error messages come from SpiderMonkey instead of V8 (`can't convert symbol to string` instead of
  `Cannot convert a Symbol value to a string`, and `too much recursion` as an `InternalError` instead
  of `RangeError: Maximum call stack size exceeded`). Tests that compare the message fail, and code
  that checks `instanceof RangeError` to detect a stack overflow doesn't see one.
- V8's stack trace API is emulated from Firefox's stack strings. `Error.prepareStackTrace`,
  `Error.captureStackTrace` and V8-style stacks work, but a CallSite has no receiver or type name
  (`getThis()`, `getTypeName()`). As a result `util.inspect` can't name the class of a null-prototype
  object, and async frames and method names read slightly differently.
- Some worker tests depend on the order in which a worker's last messages, its `exit` event and
  its handle closing arrive, and Firefox delivers them in a different order.
- A few crypto tests (Diffie-Hellman key generation, many cipher rounds) run past the 30-second
  limit, and some `vm` tests expect V8's exact behaviour for proxies and non-configurable properties.

The legacy runtime (`legacy` in `/etc/openvessel/node`) boots and runs simple programs, but its stack
traces stay in Firefox's format. The end-to-end scripts can run in Firefox with `OV_BROWSER=firefox`
(see the README).

## What can't work in a browser, and why

The items below are limits of the platform rather than unfinished work. Each one comes from a restriction
that a browser tab imposes.

### Network

- Raw TCP to the internet for protocols other than HTTP (databases, SMTP, SSH, Redis, …) is not
  supported, because a web page can't open sockets. `net.connect` to an outside host is handled by the
  kernel, which speaks HTTP/1.1 over `fetch`; anything that isn't HTTP is reset.
- Servers that don't allow cross-origin requests can't be reached. Outbound requests are made with the
  browser's `fetch`, which enforces CORS. The request fails with `fetch failed` (`ECONNREFUSED`) and a
  message that names CORS. Google Fonts metadata and many RSS feeds are in this group.
- UDP (`dgram`) and raw DNS queries are not available, since browsers have no UDP. Host names resolve to
  stand-in addresses that the HTTP bridge maps back to the name.
- WebSocket client connections to outside hosts over `net`/`tls` are answered with
  `501 Not Implemented`, because the HTTP bridge handles request/response only. The `WebSocket` global
  is the browser's, but the runtime's Content-Security-Policy (`connect-src 'self' data: blob:`) only
  lets it connect to the runtime origin itself, so it can't reach outside hosts either
  ([details](reference/network-policy.md#websockets)).
- Custom CAs, client certificates and TLS details are not available. TLS is done, and verified, by the
  browser's `fetch`, and the process sees plaintext. `tls.connect` succeeds with `authorized: true` when
  the browser accepted the certificate. `getPeerCertificate()` returns a summary instead of the real
  certificate.
- Listening on a real port is not possible, since nothing outside the tab could connect to it. Servers
  listen on virtual ports, and the preview iframe reaches them through a service worker.
- HTTP/2 (`node:http2`) is not a browser limit: the binding (`node_http2.cc` over nghttp2) is not
  implemented yet, and it is a large port of its own. On the ported runtime `node:http2` loads and
  servers listen, but every session (an incoming connection, `http2.connect()`) fails with
  `ERR_NOT_IMPLEMENTED` (`Http2Session`, [details](reference/nodejs-runtime.md#not-implemented)). On the
  legacy runtime `createServer()`, `createSecureServer()` and `connect()` throw
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` (`HTTP/2 is not supported in OpenVessel`). HTTP/1.1 servers and
  clients work.

### Native code

- Native addons (`.node` files) in general can't be loaded, because a browser can't load machine code.
  Packages with WebAssembly builds are installed as those (esbuild, rollup, rolldown, lightningcss, sharp,
  napi-rs `wasm32-wasi` bindings). Others get a compat package (below) where one exists.
- `workerd` (Cloudflare's runtime, used by `@astrojs/cloudflare` to prerender and to run `astro dev`) is a
  C++ program that embeds V8. There is no WebAssembly build and it can't be compiled to one. Install
  succeeds, and the build fails when the adapter starts workerd.
- Koffi and other FFI libraries call native shared libraries. `cn-font-split`, the package in the corpus
  that needs Koffi, has a compat package that uses its WebAssembly build instead.
- Headless browsers (Playwright/Puppeteer browsers, e.g. `rehype-mermaid` rendering diagrams with
  Chromium) don't work, since a browser binary can't run inside a browser tab. `playwright-core` loads,
  so configs that import it work, but launching a browser fails.
- Install scripts of dependencies are not run, because they mostly download or compile native binaries.
  The project's own `prepare`/`postinstall` scripts do run.

OpenVessel builds these compat packages (`compat/`, `scripts/build-compat.mjs`):

- `@pagefind/linux-x64` (Pagefind's indexer): Pagefind compiled to `wasm32-wasip1` from its published
  crate with a small patch (single-threaded tokio, a one-loop `--service`). The CLI and the Node API both
  work.
- `cn-font-split`: the project's own `wasm32-wasip1` build, run with `node:wasi` instead of Koffi.
- `@resvg/resvg-js`: the same API on `@resvg/resvg-wasm`.

A candidate for a future compat package is `@myriaddreamin/typst-ts-node-compiler` (napi-rs; Typst
compiles to WebAssembly, but the Node binding has no WASI build yet).

### JavaScript engine

- `AsyncLocalStorage` context is not carried across `await`. Node propagates it with V8 promise hooks,
  which browsers don't expose. The store is visible in synchronous code, in callbacks,
  `process.nextTick`, timers and immediates, but is lost after an `await`.
- `vm` `timeout` and `breakOnSigint` have no effect, because synchronous JavaScript in a browser can't be
  interrupted from outside. The option is accepted, and a script that never returns hangs.
- `vm` contexts are not separate realms (`microtaskMode`, own built-ins). Contexts are emulated in the
  worker's realm with a proxy global and a `with` scope. Globals, `var`/function declarations and
  `runInContext` behave as in Node, but built-ins like `Array` are shared with the main context.
- The inspector protocol, heap snapshots and CPU profiles are not available, since there is no V8
  inspector to attach to. `node:inspector` loads, and sessions answer "not supported".

### Operating system

- Users, groups and permissions (`setuid`, `chown` to other users, `EACCES` by mode) don't exist, because
  there is one user in the in-memory file system. Calls succeed or are no-ops as for the single user.
- Signals sent by the OS (`SIGSEGV`, `SIGXFSZ`, …) and resource limits don't exist, since there is no
  real OS underneath. Signals sent with `process.kill`/`child.kill` between processes work.
- Programs other than `node`, the shell built-ins, coreutils and the package managers (e.g. `git`,
  `python`) are not available, because only programs written for the kernel exist. Running one gives
  `command not found`.

## Astro site corpus

`corpus/` holds 147 real Astro sites (official examples and popular community themes for Astro 5,
6 and 7). `node corpus/run.mjs` runs `install` and `build` for each.

These sites don't build, for the reasons given:

| Reason | Sites |
|---|---|
| Outside requests blocked by CORS (Google Fonts metadata, RSS feeds, remote images) | bekturaslan/syntro-astro, lin-stephanie/astro-antfustyle-theme, radishzzz/astro-theme-retypeset, satnaing/astro-paper (OG image font), themefisher/dockit-astro, mnyorba/astro-starter (dependency from `codeload.github.com`) |
| Needs workerd (Cloudflare adapter) | webrating/starfolio, CuteLeaf/Firefly |
| Renders diagrams with a headless browser | huangmingche/astro-theme-aither |
| Native-only dependency without a compat package yet (Typst) | LemonAdorable/astro-theme-iris |
| The site needs setup the repository doesn't include (env variables, generated files, comment-service config) | SolitudeRA/Solitude-Interface, unfolding-io/nebulix, vic/awesome-gh-repos, Liksium/astro-theme-sora, louisescher/spectre |
| Under investigation | izmttk/astro-mecure (a CommonJS dependency's named exports during prerendering) |

<!-- corpus: updated with each full run -->
