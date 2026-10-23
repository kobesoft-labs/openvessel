# OpenVessel

A browser-only, Node.js-like environment for installing, building and previewing [Astro](https://astro.build) sites.
Everything runs inside the user's browser tab: a POSIX-ish shell, `node`, `npm`/`pnpm`/`yarn`/`bun`, `astro build` and `astro dev` with HMR.
No real port is ever opened, and outgoing network traffic goes through a single policy gate.

OpenVessel is a clean-room implementation. It was written without looking at the source of other in-browser runtimes.

## Status

- Targets **Astro 7, 6 and 5** (Vite 8 / 7 / 6). Astro 7's rolldown runs as the napi-rs `wasm32-wasi` build.
- Tested against a corpus of 150 real sites (official examples and popular community themes for each major); see `corpus/`.
- Chromium-based browsers. Requires cross-origin isolation (`SharedArrayBuffer`).

## Quick start

```bash
npm install
npm run build        # → dist/
npm run serve        # host :5170 (playground), runtime :5171, preview :5172
```

Open http://localhost:5170, drop an Astro project into the terminal's working directory, then run `npm install && npm run dev`.

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

The host page must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
`scripts/serve.mjs` shows the exact headers each origin needs.

## How it works

| Piece | Where |
|---|---|
| Kernel (one Web Worker): in-memory VFS, processes, pipes, TTY, `sh`, coreutils, `curl`, npm | `src/kernel/` |
| Processes (one Web Worker per `node`): Node built-ins, CJS loader, native ESM served by a Service Worker, synchronous syscalls over `SharedArrayBuffer` + `Atomics.wait` | `src/node/` |
| Runtime origin: hidden iframe + Service Worker (ESM delivery, network gate) | `src/runtime/` |
| Preview origin: Service Worker that bridges HTTP/WebSocket to virtual ports | `src/preview/` |
| Host API | `src/host/` |

Native dependencies are swapped for WebAssembly builds when one exists (`esbuild-wasm`, `@rollup/wasm-node`, `lightningcss-wasm`, napi-rs `*-wasm32-wasi`, `@img/sharp-wasm32`), otherwise for a JavaScript equivalent (`sass-embedded` → `sass`).
Dependencies' install scripts are never run (the project's own `postinstall`/`prepare` run as in npm).

See [docs/DESIGN.md](docs/DESIGN.md) (Japanese) for the full design and [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Development

```bash
npm test                                              # unit tests (node:test)
node test/e2e/harness.mjs 'echo hi; node -v'          # one command in headless Chrome
node test/e2e/project.mjs <dir> 'npm install && npm run build'
node test/e2e/dev.mjs                                 # astro dev + preview + HMR
node corpus/run.mjs [filter]                          # run the site corpus → corpus/results/
```

The e2e tests drive the system Chrome through `playwright-core`.
Set `HEADED=1` to watch, `OV_CONSOLE=1` for browser console output, `OV_TRACE=1` for kernel traces.

## License

MIT
