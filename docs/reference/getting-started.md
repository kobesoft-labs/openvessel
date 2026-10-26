# Getting started

[日本語](getting-started.ja.md)

This page takes you from an empty web page to a project running inside OpenVessel: installing the
package, serving its files on three origins, booting, choosing the Node.js runtime, mounting a project,
`npm install`, a build, a dev server with a live preview, an interactive terminal and teardown. Every
call used here is specified in [Host API](host-api.md); serving in production is covered in
[Deployment](deployment.md).

## What you need

| Requirement | Why |
|---|---|
| A Chromium-based browser | The browsers OpenVessel is tested in ([README](../../README.md)). |
| Cross-origin isolation on the host page (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`) | The kernel and the processes talk through `SharedArrayBuffer` and `Atomics.wait`, which a browser only enables in a cross-origin isolated page. `OpenVessel.boot()` checks `crossOriginIsolated` first and rejects without it. |
| Three origins: your page, the runtime, the preview | The runtime (kernel, processes, network gate) and the preview (the site being developed) must not share an origin with your page or with each other ([how it works](../how-it-works.md#three-origins)). |

Locally the three origins can be three ports on `localhost`, which is what `npm run serve` in the
OpenVessel repository does.

## Install

The package is published as a tarball attached to every
[GitHub release](https://github.com/kobesoft-labs/openvessel/releases) (`openvessel-<version>.tgz`);
it is not on the npm registry. Install it from the release URL or from a downloaded copy:

```bash
npm install https://github.com/kobesoft-labs/openvessel/releases/download/v1.1.1/openvessel-1.1.1.tgz
```

The package is an ES module with one entry point:

| `package.json` field | Value | What it is |
|---|---|---|
| `exports["."].default`, `main` | `./dist/host/index.js` | The host API, bundled, with no runtime dependencies. |
| `exports["."].types`, `types` | `./dist/types/host/index.d.ts` | TypeScript declarations (they import `dist/types/shared/policy.d.ts`). |
| `openvessel.node` | `22.23.4` | The Node.js version the ported runtime follows. |

```ts
import { OpenVessel, PRESETS, type BootOptions, type Process } from 'openvessel';
```

## What is in `dist/`

Only `dist/` is published. Each directory goes to a different place:

| Directory | Contents | Where it goes |
|---|---|---|
| `dist/host/` | `index.js` — the host API | Into your page's bundle (through `import 'openvessel'`). |
| `dist/types/` | `.d.ts` files | Used by TypeScript only. |
| `dist/runtime/` | `runtime.html`, `runtime.js`, `sw.js`, `kernel.js`, `process.js` (legacy runtime), `node-process.js` + `nodelib.js` (ported runtime), `ts-strip.js`, `amaro.js`, `chunks/`, `compat/` (compat package tarballs and `index.json`), license files | The **runtime origin**, as one directory. It may be served under a path (for example `https://example.com/ov/runtime/`). |
| `dist/preview/` | `__ov-sw.js`, `__ov/relay.html`, `__ov/relay.js`, `__ov/inject.js` | The **preview origin**, as one directory, also possibly under a path. |
| `dist/playground/` | The repository's own test page | Not needed for embedding. |

Copy the runtime and preview directories as they are: the files find each other by relative URLs.

## Serve the three origins

`scripts/serve.mjs` in the repository is the reference for the headers. It serves `dist/playground`,
`dist/runtime` and `dist/preview` on ports 5170, 5171 and 5172 (`OV_PORT_BASE` moves all three;
`OV_HOST_PORT`, `OV_RUNTIME_PORT` and `OV_PREVIEW_PORT` set each one):

| Origin | Headers set by `scripts/serve.mjs` |
|---|---|
| Host page | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin` |
| Runtime | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin`, and on every file except `sw.js`: `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors <host origin>` |
| Preview | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin`, `Service-Worker-Allowed: /` |

`connect-src 'self'` on the runtime is what keeps code in a process from reaching the network except
through the gate; `sw.js` must not get it, because the service worker is the gate. Static hosts that
can't set headers, origin restrictions and everything else about serving are in
[Deployment](deployment.md).

`dist/runtime/runtime.html` contains `<meta name="openvessel-allowed-hosts" content="*">`. Replace `*`
with the origins allowed to embed the runtime (separated by spaces or commas); `boot()` from any other
origin fails with `origin … is not allowed to use this runtime`.

To try OpenVessel itself before embedding it, clone the repository and run `npm install`,
`npm run build` and `npm run serve`, then open http://localhost:5170.

## A minimal host page

```text
<!doctype html>
<html>
<head><meta charset="utf-8"><title>OpenVessel</title></head>
<body>
  <pre id="log"></pre>
  <div id="preview" style="height:480px"></div>
  <script type="module" src="./main.js"></script>
</body>
</html>
```

Serve it with the host-page headers above. `boot()` appends hidden iframes to `document.body`, so call
it once the body exists (a module script at the end of the body, or after `DOMContentLoaded`).

## Boot

```ts
import { OpenVessel } from 'openvessel';

const vessel = await OpenVessel.boot({
  runtimeUrl: 'https://rt.example.com/',   // the directory holding runtime.html (or runtime.html itself)
  previewUrl: 'https://pv.example.com/',   // the directory holding __ov-sw.js
  network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'] },
});
```

`boot()` loads `runtime.html` in a hidden iframe, which registers the runtime's service worker and
starts the kernel worker; it resolves when the kernel says it is ready, or rejects after `timeout`
(30 000 ms by default). Every option and error is listed in [Host API](host-api.md#openvesselboot).
The network policy is explained in [Network policy](network-policy.md); with `mode: 'ask'` and no
`onPermissionRequest`, a built-in dialog asks the user about hosts outside the presets.

Errors that happen after `boot()` resolved, outside any call, arrive as an `error` event (new in
1.2.0); `fatal: true` means the kernel is gone and the instance has stopped:

```ts
vessel.on('error', ({ message, fatal }) => console.error(message, fatal ? '(stopped)' : ''));
```

One OpenVessel instance per runtime origin is supported in a browser profile at a time: the runtime's
service worker keeps only the most recent kernel connection, so a second tab or a second `boot()` on
the same runtime origin takes over module loading and network checks from the first.

## Choose the Node.js runtime

The build contains two Node.js runtimes. The kernel picks one each time it starts a `node` process:

| Runtime | Script | Used when |
|---|---|---|
| The ported runtime | `dist/runtime/node-process.js` (`src/nodejs/`) — Node.js v22.23.4's own `lib/` on a TypeScript `internalBinding()` | The VFS file `/etc/openvessel/node` contains `port` (surrounding whitespace ignored). |
| The legacy runtime | `dist/runtime/process.js` (`src/node/worker.ts`) — an older hand-written Node-compatible layer | Otherwise (the default). |

All compatibility numbers in [Compatibility](../compatibility.md) are measured on the ported runtime.
Select it right after booting:

```ts
await vessel.mount({ node: 'port' }, { path: '/etc/openvessel' });
// the same thing: await vessel.fs.writeFile('/etc/openvessel/node', 'port');
```

The file is read at every process start, so processes already running keep the runtime they started
with. More in [Node.js runtime](nodejs-runtime.md).

## Put a project in the file system

The file system lives in memory and starts empty apart from the base system (`/bin`, `/usr`,
`/home/user`, `/tmp`, `/etc`, `/dev`, `/proc`, …). Nothing is kept between boots.

```ts
const APP = '/home/user/app';
await vessel.mount(
  {
    'package.json': JSON.stringify({
      name: 'site', type: 'module', private: true,
      scripts: { dev: 'astro dev', build: 'astro build' },
      dependencies: { astro: '^5.18.0' },
    }, null, 2),
    'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
    'src/pages/index.astro': '<h1>Hello from OpenVessel</h1>\n',
    'public/favicon.ico': new Uint8Array([/* bytes */]),
  },
  { path: APP },
);
```

Keys are paths relative to `path` (default `/home/user/app`); values are text (`string`), bytes
(`Uint8Array`), `null` for an empty directory, or `{ symlink: target }`. Missing directories are
created. To load a folder the user picks, read each `File` into a `Uint8Array` (the playground skips
`node_modules/` and `.git/` while doing this).

## Install dependencies

```ts
const install = await vessel.spawn('npm', ['install'], { cwd: APP });
install.output.pipeTo(new WritableStream({ write: (s) => log(s) }));
if ((await install.exit) !== 0) throw new Error('npm install failed');
```

`npm`, `pnpm`, `yarn` and `bun` are built into the kernel ([Package managers](package-managers.md)).
Registry requests and tarballs go through the network gate, so the policy must allow the registry —
the `npm` preset covers `registry.npmjs.org` and the usual mirrors. Packages that ship native binaries
are installed as their WebAssembly builds ([Native modules](native-modules.md)).

The [demo](https://kobesoft-labs.github.io/openvessel-demo/) passes
`env: { ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '1', NODE_NO_WARNINGS: '1' }` to its processes.

## Build

```ts
const { code, output } = await vessel.exec('npm run build', { cwd: APP });
if (code !== 0) console.error(output);

// read the result back: { 'index.html': Uint8Array, '_astro/…': Uint8Array, … }
const files = await vessel.export(`${APP}/dist`);
```

`exec()` runs a command line through `/bin/sh -c` and resolves with the exit code and the combined
stdout and stderr. It resolves only when the process has exited **and** its output pipes are closed,
so a command that leaves a background job holding the output (`npm run dev &`) keeps it waiting —
start long-running servers with `spawn()`.

## Run the dev server and show the preview

```ts
vessel.on('server-ready', async ({ port }) => {
  const frame = await vessel.createPreview(port, { container: document.getElementById('preview')! });
  // frame is a sandboxed <iframe> on the preview origin, showing http://localhost:<port>/
});
const dev = await vessel.spawn('npm', ['run', 'dev'], { cwd: APP });
```

Register the listener before starting the server. `server-ready` fires when a process listens on a
virtual port (Astro's dev server uses 4321); `port-closed` fires when it stops. `createPreview()` starts
the preview relay on first use, creates the iframe and appends it to `container`. To place the iframe
yourself, use `await vessel.previewUrl(port, '/about/')`, or the event's `url`: with `previewUrl`
configured, `server-ready` is emitted once the relay is up, so `url` can be loaded at once. Hot module replacement works through the
preview's service worker ([Preview](preview.md)).

## An interactive terminal with xterm.js

A process spawned with `terminal` gets a TTY: stdin, stdout and stderr are the terminal, the line
discipline echoes and edits input, Ctrl-C sends `SIGINT` to the foreground process group, and output
`\n` becomes `\r\n`. This is how the playground (`playground/app.ts`) and the demo wire up
[xterm.js](https://xtermjs.org) (`@xterm/xterm` and `@xterm/addon-fit`):

```ts
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const term = new Terminal({ fontSize: 13, cursorBlink: true });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term')!);
fit.fit();

const shell = await vessel.spawn('/bin/sh', ['-i'], {
  cwd: APP,
  terminal: { cols: term.cols, rows: term.rows },
});

// output → terminal
(async () => {
  const reader = shell.output.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    term.write(value);
  }
  term.writeln('\r\n[shell exited]');
})();

// keyboard → process, size → process (SIGWINCH)
term.onData((d) => shell.write(d));
term.onResize(({ cols, rows }) => shell.resize(cols, rows));
new ResizeObserver(() => fit.fit()).observe(document.getElementById('term')!);
```

To type a command for the user, write it with a carriage return: `shell.write('npm run dev\r')`.
`shell.end()` on a terminal process sends Ctrl-D (`^D`) through the line discipline: at the start of a
line the program reads end of file (an interactive `sh` exits). On a pipe process it closes stdin.

## Edit files while it runs

```ts
await vessel.fs.writeFile(`${APP}/src/pages/index.astro`, '<h1>Edited</h1>\n');

const stop = await vessel.fs.watch(APP, (ev) => {
  // ev.type is 'rename' (created, removed, renamed) or 'change'; ev.path is the changed path
  console.log(ev.type, ev.path);
});
// later: await stop();
```

Writes from the host notify every watcher in the kernel, so the dev server's file watcher (Node's
`fs.watch`) sees the edit and the preview updates. `fs.watch` on the host sees changes made by
processes too (files created in the terminal, `npm install`).

## Tear down

```ts
vessel.teardown();
```

`teardown()` removes the runtime and relay iframes and closes the channel to the kernel. The kernel
worker and every process go with the runtime iframe; the in-memory file system is gone. Calls still
waiting for an answer reject, and running processes' `exit` resolves with `137`. It does not remove
preview iframes you placed in your page.
The service worker registrations on the runtime and preview origins and the npm tarball cache
(Cache Storage `openvessel-npm-v1` on the runtime origin) stay in the browser.

## When something goes wrong

| Symptom | Cause |
|---|---|
| `OpenVessel: the host page must be cross-origin isolated (…)` | The host page lacks `Cross-Origin-Opener-Policy: same-origin` or `Cross-Origin-Embedder-Policy`. |
| `OpenVessel: OpenVessel needs a cross-origin isolated page (…)` | The runtime page isn't cross-origin isolated: its own COOP/COEP headers are missing (the runtime service worker adds them only once it is installed), or the host page's COEP blocks it (the runtime must send `Cross-Origin-Resource-Policy: cross-origin`). |
| `OpenVessel: runtime did not start in time` | `runtime.html` didn't load or never answered within `timeout`; check `runtimeUrl` (the directory holding `runtime.html`, or `runtime.html` itself) and `frame-ancestors`. |
| `OpenVessel: origin … is not allowed to use this runtime` | The host origin isn't in `openvessel-allowed-hosts` in `runtime.html`. |
| `OpenVessel: the runtime must be embedded directly by the host page` | The page calling `boot()` is itself inside a frame. |
| `OpenVessel: previewUrl was not configured` | `createPreview()`/`previewUrl()` without `previewUrl` in `boot()`. |
| `OpenVessel: preview relay did not start` | `__ov/relay.html` on the preview origin didn't load or register its service worker within 20 s. |
| A process prints `fetch failed` with `EACCES` | The network policy denied the host. |
| A process prints `fetch failed` with `ECONNREFUSED` and a CORS hint | The request was allowed, but the server doesn't allow cross-origin requests from a browser ([Network policy](network-policy.md#cors)). |
| `Error: module … is not registered` from `node` | Another tab or `boot()` on the same runtime origin took over the runtime's service worker. |

## Next

- [Host API](host-api.md) — every method, option, event and error.
- [Network policy](network-policy.md) — what may leave the tab, and how the user is asked.
- [Deployment](deployment.md) — production origins, headers, static hosts.
- [Preview](preview.md) — how the iframe reaches the dev server.
