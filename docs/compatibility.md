# Compatibility

[日本語](compatibility.ja.md)

OpenVessel runs Node.js's own JavaScript (`lib/`) and re-implements the native half in TypeScript, so
"is X supported?" usually comes down to: does it need something a browser tab can't provide? This page
lists what is measured, what works, and what doesn't — with the reason in every case.

## Node.js's own test suite

How it is measured (`test/node-compat/run.mjs`):

- The tests are Node.js's own `test/parallel` files for the modules OpenVessel targets (fs, stream,
  buffer, events, child_process, process, worker_threads, crypto, zlib, vm, timers, module loading,
  util, url, readline, …), from the same Node version (v22.23.4).
- A test counts only if it passes on real Node.js on Linux (`--baseline`).
- Tests that exercise Node's internals rather than its public behaviour are out of scope and not run:
  ones that need `--expose-internals`, call `internalBinding`/`process.binding`, set V8 flags, or use
  the inspector, profilers, snapshots, reports, single executable applications or the permission model.
- Tests that can't pass in a browser are listed with the reason in `test/node-compat/limits/*.json`.
  **The target is every other test**: `pass / target` is what the report shows, and the goal is 100%.

Current result: see the table in `test/node-compat/results/port/REPORT.md` after
`node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report`.
<!-- numbers: updated with each full run -->

## What can't work in a browser, and why

These are limits of the platform, not missing work. Each has a reason a browser tab imposes.

### Network

| Not supported | Why | What happens instead |
|---|---|---|
| Raw TCP to the internet for protocols other than HTTP (databases, SMTP, SSH, Redis, …) | A web page can't open sockets. | `net.connect` to an outside host is handled by the kernel, which speaks HTTP/1.1 over `fetch`; anything that isn't HTTP is reset. |
| Servers that don't allow cross-origin requests | Outbound requests are made with the browser's `fetch`, which enforces CORS. | The request fails with `fetch failed` (`ECONNREFUSED`) and a message that names CORS. Google Fonts metadata and many RSS feeds are in this group. |
| UDP (`dgram`), raw DNS queries | No UDP in browsers. | Host names resolve to stand-in addresses the HTTP bridge maps back to the name. |
| WebSocket client connections to outside hosts over `net`/`tls` | The HTTP bridge handles request/response only. | Answered with `501 Not Implemented`. (The browser's `WebSocket` global is available.) |
| Custom CAs, client certificates, TLS details | TLS is done — and verified — by the browser's `fetch`; the process sees plaintext. | `tls.connect` succeeds with `authorized: true` when the browser accepted the certificate. `getPeerCertificate()` returns a summary, not the real certificate. |
| Listening on a real port | Nothing outside the tab can connect to it. | Servers listen on virtual ports; the preview iframe reaches them through a service worker. |

### Native code

| Not supported | Why | What happens instead |
|---|---|---|
| Native addons (`.node` files) in general | A browser can't load machine code. | Packages with WebAssembly builds are installed as those (esbuild, rollup, rolldown, lightningcss, sharp, napi-rs `wasm32-wasi` bindings); others get a compat package (below) where one exists. |
| `workerd` (Cloudflare's runtime, used by `@astrojs/cloudflare` to prerender and to run `astro dev`) | It is a C++ program that embeds V8; there is no WebAssembly build and it can't be compiled to one. | Install succeeds, the build fails when the adapter starts workerd. |
| Koffi and other FFI libraries | They call native shared libraries. | `cn-font-split`, the package that needs Koffi in the corpus, has a compat package that uses its WebAssembly build instead. |
| Headless browsers (Playwright/Puppeteer browsers), e.g. `rehype-mermaid` rendering diagrams with Chromium | A browser binary can't run inside a browser tab. | `playwright-core` loads (so configs that import it work); launching a browser fails. |
| Install scripts of dependencies | They mostly download or compile native binaries. | They are not run. The project's own `prepare`/`postinstall` scripts do run. |

Compat packages built by OpenVessel (`compat/`, `scripts/build-compat.mjs`):

| Package | How |
|---|---|
| `@pagefind/linux-x64` (Pagefind's indexer) | Pagefind compiled to `wasm32-wasip1` from its published crate with a small patch (single-threaded tokio, a one-loop `--service`). The CLI and the Node API both work. |
| `cn-font-split` | The project's own `wasm32-wasip1` build, run with `node:wasi` instead of Koffi. |
| `@resvg/resvg-js` | The same API on `@resvg/resvg-wasm`. |

Candidates for future compat packages: `@myriaddreamin/typst-ts-node-compiler` (napi-rs; Typst
compiles to WebAssembly, but the Node binding has no WASI build yet).

### JavaScript engine

| Not supported | Why | What happens instead |
|---|---|---|
| `AsyncLocalStorage` context across `await` | Node propagates it with V8 promise hooks, which browsers don't expose. | The store is visible in synchronous code, in callbacks, `process.nextTick`, timers and immediates, but is lost after an `await`. |
| `vm` `timeout` and `breakOnSigint` | Synchronous JavaScript in a browser can't be interrupted from outside. | The option is accepted; a script that never returns hangs. |
| `vm` contexts as separate realms (`microtaskMode`, own built-ins) | Contexts are emulated in the worker's realm (a proxy global and `with` scope). | Globals, `var`/function declarations and `runInContext` behave as in Node; built-ins like `Array` are shared with the main context. |
| The inspector protocol, heap snapshots, CPU profiles | There is no V8 inspector to attach to. | `node:inspector` loads; sessions answer "not supported". |

### Operating system

| Not supported | Why | What happens instead |
|---|---|---|
| Users, groups and permissions (`setuid`, `chown` to other users, `EACCES` by mode) | There is one user in the in-memory file system. | Calls succeed or are no-ops as for the single user. |
| Signals sent by the OS (`SIGSEGV`, `SIGXFSZ`, …), resource limits | No real OS underneath. | Signals sent with `process.kill`/`child.kill` between processes work. |
| Programs other than `node`, the shell built-ins, coreutils and the package managers (e.g. `git`, `python`) | Only programs written for the kernel exist. | `command not found`. |

## Astro site corpus

`corpus/` holds 147 real Astro sites (official examples and popular community themes for Astro 5,
6 and 7). `node corpus/run.mjs --port` runs `install` and `build` for each.

Sites that don't build, by reason:

| Reason | Sites |
|---|---|
| Outside requests blocked by CORS (Google Fonts metadata, RSS feeds, remote images) | bekturaslan/syntro-astro, lin-stephanie/astro-antfustyle-theme, radishzzz/astro-theme-retypeset, satnaing/astro-paper (OG image font), themefisher/dockit-astro, mnyorba/astro-starter (dependency from `codeload.github.com`) |
| Needs workerd (Cloudflare adapter) | webrating/starfolio, CuteLeaf/Firefly |
| Renders diagrams with a headless browser | huangmingche/astro-theme-aither |
| Native-only dependency without a compat package yet (Typst) | LemonAdorable/astro-theme-iris |
| The site needs setup the repository doesn't include (env variables, generated files, comment-service config) | SolitudeRA/Solitude-Interface, unfolding-io/nebulix, vic/awesome-gh-repos, Liksium/astro-theme-sora, louisescher/spectre |
| Under investigation | izmttk/astro-mecure (a CommonJS dependency's named exports during prerendering) |

<!-- corpus: updated with each full run -->
