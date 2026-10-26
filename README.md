# OpenVessel

[日本語](README.ja.md) · **[Live demo](https://kobesoft-labs.github.io/openvessel-demo/)** — edit an Astro site with Node.js running in the tab
· [Reference](docs/reference/README.md) · [Product page](https://kobesoft.co.jp/oss/openvessel/) (Japanese, by KOBESOFT)

## What is OpenVessel?

OpenVessel is a Node.js environment that runs entirely inside a web browser tab.
It gives a web page a real `node`, a POSIX-style shell, `npm`/`pnpm`/`yarn`/`bun`, a file system and processes —
enough to install a real JavaScript project from the npm registry, build it and serve it with live reload,
without a server doing the work and without opening a single real network port.

It was built for [Astro](https://astro.build) sites (Astro 7, 6 and 5): `npm install`, `astro build`,
`astro dev` with hot module replacement, and a preview of the running dev server in an iframe.
Because it runs Node.js's own code, most other Node tools work too.

![OpenVessel: a Node.js virtual machine inside a browser tab](docs/images/overview.svg)

Think of it as a small virtual machine for Node.js that lives in the tab: its own operating system
(a kernel with a file system, processes and a shell), its own programs (Node.js, npm, Astro), and
controlled ways in and out. [How it works](docs/how-it-works.md) explains each piece.

Typical uses:

- an online editor or CMS that builds and previews a site in the visitor's browser,
- tutorials and playgrounds where every reader gets their own sandboxed Node.js,
- previews of pull requests or templates without provisioning servers.

OpenVessel is a clean-room implementation: it was written without looking at the source of other
in-browser runtimes. It is open source under the [Apache License 2.0](LICENSE).

## How it is different

- **Node.js itself, not a look-alike.** Node.js v22's own `lib/` (the JavaScript half of Node) runs
  unmodified. What OpenVessel re-implements is the part Node writes in C++ — `internalBinding()` —
  in TypeScript, on top of a small kernel. Error messages, stack traces, argument validation and
  event-loop ordering come out the way Node produces them, and following a new Node release is a
  matter of re-reading its source (see [docs/NODE-VERSION.md](docs/NODE-VERSION.md)).
- **Native modules become WebAssembly.** Packages that ship native binaries are installed as their
  WebAssembly builds (esbuild, rollup, rolldown, lightningcss, sharp, napi-rs `wasm32-wasi`
  bindings…). Where a package has no WebAssembly build, OpenVessel provides a compat package —
  usually the same project compiled to `wasm32-wasi` (Pagefind, for example).
- **Nothing is reachable from outside.** Servers listen on virtual ports inside the kernel; the
  preview iframe talks to them through a service worker. Outgoing traffic goes through one policy
  gate that the embedding page controls.
- **Isolated by origin.** The page, the runtime and the preview are three different origins, so code
  in a previewed site can't reach the runtime or the host page ([docs/SECURITY.md](docs/SECURITY.md)).

## Status

| | |
|---|---|
| Version | 1.1.1 — [Changelog](CHANGELOG.md), [releasing](docs/RELEASING.md) (OpenVessel's own semver; the ported Node.js version is in every release title) |
| Node.js | v22.23.4 (`src/node/version.ts`) |
| Node's own test suite | 1237 of 1237 (100%) of the tests a browser can pass, across 1271 tests of the targeted modules; the other 34 are listed with the reason — see [docs/compatibility.md](docs/compatibility.md) |
| Astro sites | 131 of a corpus of 147 real sites build (Astro 5, 6 and 7); see [docs/compatibility.md](docs/compatibility.md) |
| Browsers | Chromium-based browsers; cross-origin isolation (`SharedArrayBuffer`) is required |

What can't work in a browser, and why, is listed in [docs/compatibility.md](docs/compatibility.md).

## Quick start

```bash
npm install
npm run build        # → dist/  (builds the runtime, Node's lib bundle and the compat packages)
npm run serve        # host :5170 (playground), runtime :5171, preview :5172
```

Open http://localhost:5170, put an Astro project in the terminal's working directory and run
`npm install && npm run dev`.

Building the Node lib bundle needs `vendor/node/` (created once with `node scripts/gen-node-data.mjs`,
which uses Docker to read the official Linux build of Node.js). Rebuilding the Pagefind compat
package needs Rust with the `wasm32-wasip1` target; the result is cached in `vendor/compat/`.

## Embedding

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://runtime.example.com/runtime.html',
  previewUrl: 'https://preview.example.com/',
  network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'] },
  onPermissionRequest: (req) => (confirm(`Allow ${req.host}?`) ? 'session' : 'deny'),
});

vessel.mount({ 'package.json': '…', 'src/pages/index.astro': '…' }, { path: '/home/user/app' });
const { code, output } = await vessel.exec('npm install && npm run build', { cwd: '/home/user/app' });

vessel.on('server-ready', async ({ port }) => {
  await vessel.createPreview(port, { container: document.querySelector('#preview')! });
});
await vessel.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });
```

The host page must be served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). `scripts/serve.mjs` shows the
headers each of the three origins needs.

## How it works

```
 host page (your origin)          runtime origin (hidden iframe)                 preview origin
 ───────────────────────          ──────────────────────────────────            ──────────────
 OpenVessel API  ──postMessage──▶ kernel (Web Worker)                            iframe + service worker
                                   VFS · processes · pipes · TTY · sh · npm      ▲  HTTP / WebSocket
                                   virtual ports · network gate                  │
                                     │ sync syscalls (SharedArrayBuffer+Atomics) │
                                   node processes (one Web Worker each) ─────────┘
                                   Node.js lib/ + TypeScript internalBinding()
```

| Piece | Where |
|---|---|
| Kernel: in-memory file system, processes, pipes, TTY, sockets, `sh`, coreutils, npm client, virtual ports, outbound HTTP | `src/kernel/` |
| Node.js: bootstrap, event loop, the `internalBinding()` modules | `src/nodejs/` |
| Runtime origin: service worker (ES module delivery, network gate) | `src/runtime/` |
| Preview origin: service worker bridging HTTP/WebSocket to virtual ports | `src/preview/` |
| Host API | `src/host/` |
| Compat packages for native-only npm packages | `compat/`, `scripts/build-compat.mjs` |

More: [How it works](docs/how-it-works.md) · [Compatibility](docs/compatibility.md) · [Reference](docs/reference/README.md) (host API, deployment, kernel, shell, npm, Node.js runtime…) · design notes [docs/DESIGN.md](docs/DESIGN.md), [docs/NODE-PORT.md](docs/NODE-PORT.md) (Japanese).

## Development

```bash
npm test                                                   # unit tests (bindings are checked against real Node)
node test/e2e/harness.mjs 'echo hi; node -v'               # one command in headless Chrome
node test/e2e/project.mjs <dir> 'npm install && npm run build'
node test/node-compat/run.mjs --port [module…]             # Node's own tests in OpenVessel
node test/node-compat/run.mjs --port --report              # pass / target per module
node corpus/run.mjs --port [filter]                        # build the Astro site corpus
```

The end-to-end tests drive the system Chrome through `playwright-core`. Set `HEADED=1` to watch,
`OV_CONSOLE=1` for browser console output, `OV_PORT_BASE=<port>` to run several suites side by side.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Third-party components and their licenses are listed in
[NOTICE](NOTICE).
