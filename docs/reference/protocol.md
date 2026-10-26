# Protocol

[日本語](protocol.ja.md)

The wire protocols between OpenVessel's pieces: the host ↔ runtime handshake and RPC, kernel events, the
preview relay and preview channel, the runtime service worker's `/__ov/…` endpoints, the messages between
the kernel and process workers, and the synchronous syscall channel. This page is for debugging and for
people writing their own host instead of using `dist/host`.

> **Stability.** Only the host API (`dist/host` and its declarations) and the three-origin embedding
> requirements are covered by semver ([CHANGELOG](../../CHANGELOG.md), "Stability"). Everything on this
> page is internal: `src/` internals and the files inside `dist/runtime` and `dist/preview` may change in
> any release, including patch releases. A custom host has to be built against one exact OpenVessel version.

## Channels at a glance

| Between | Transport | Format | Source |
|---|---|---|---|
| Host page ↔ runtime iframe | `window.postMessage` | `{ t: 'openvessel-…' }` | `src/host/index.ts`, `src/runtime/runtime.ts` |
| Host page ↔ kernel | a `MessagePort` (handed over in the handshake) | RPC `{ id, m, a }` / `{ id, r }` / `{ id, e }`, events `{ ev, … }` | `src/kernel/index.ts` |
| Runtime iframe → kernel worker | `Worker.postMessage` | `{ t: 'host-port' \| 'sw-port' \| 'policy' }` | `src/runtime/runtime.ts` |
| Runtime service worker ↔ kernel | a `MessagePort` | `{ id, k: 'esm' \| 'net', … }` | `src/runtime/sw.ts` |
| Process / kernel code → runtime service worker | HTTP (`fetch`, `import`, sync XHR) | `/__ov/…` URLs | `src/runtime/sw.ts` |
| Host page ↔ preview relay iframe | `window.postMessage` | `{ t: 'openvessel-preview-…' }` | `src/host/index.ts`, `src/preview/relay.ts` |
| Relay ↔ preview service worker | `ServiceWorker.postMessage` | `{ t: 'kernel-port' \| 'default-port' \| 'need-kernel-port' }` | `src/preview/relay.ts`, `src/preview/sw.ts` |
| Preview service worker ↔ kernel | a `MessagePort` | `{ id, k: 'req' \| 'body' \| … }` | `src/preview/sw.ts`, `src/kernel/index.ts` |
| Preview page ↔ preview service worker | `postMessage` + a `MessagePort` per WebSocket | `{ t: 'ws-connect' }`, `{ t: 'open' \| 'msg' \| 'close' \| 'send' }` | `src/preview/inject.ts` |
| Kernel ↔ process worker | `Worker.postMessage` | `{ t: … }` | `src/kernel/kernel.ts`, `src/kernel/syscalls.ts`, `src/kernel/net.ts` |
| Process worker → kernel (syscalls) | a `SharedArrayBuffer` + `Atomics` | JSON + binary | `src/shared/syncchan.ts` |

## Host ↔ runtime handshake

```text
host page                                   runtime.html (runtime origin)
─────────                                   ─────────────────────────────
append <iframe src=".../runtime.html" allow="cross-origin-isolated">
                              ◀──────────── { t: 'openvessel-runtime-loaded' }            (to '*')
new MessageChannel()
{ t: 'openvessel-connect', port, init } ──▶  checks; registers sw.js; starts kernel.js
   (to the runtime origin, port transferred)  kernel ◀ { t: 'policy', policy }   (if init.policy)
                                              kernel ◀ { t: 'sw-port', port }
                                              sw.js  ◀ { t: 'kernel-port', port }
                                              kernel ◀ { t: 'host-port', port }
port ◀──────────────────────────────────────  { ev: 'ready' }                    (from the kernel)
```

### Window messages

| Message | Direction | Fields | Notes |
|---|---|---|---|
| `openvessel-runtime-loaded` | runtime → parent | — | Posted with target `'*'` when `runtime.js` has run |
| `openvessel-connect` | host → runtime | `port: MessagePort`, `init: { policy?: Partial<NetworkPolicy> }` | Accepted only from `window.parent` and only once; ignored if `port` isn't a `MessagePort` |
| `openvessel-error` | runtime → parent | `message: string` | Posted with target `'*'` |

The host accepts runtime messages only when `ev.origin` is the runtime origin and `ev.source` is its iframe.

### Checks and errors in `runtime.js`

| Order | Check | `openvessel-error` message |
|---|---|---|
| 1 | `ev.origin` is in `<meta name="openvessel-allowed-hosts">` (space/comma separated, `*` = any) | `origin <origin> is not allowed to use this runtime` |
| 2 | `location.ancestorOrigins`, when present, has at most one entry | `the runtime must be embedded directly by the host page` |
| 3 | `crossOriginIsolated` | `OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).` |
| 4 | service worker registration | `service worker registration failed: <message>` |
| later | the kernel worker's `error` event | `kernel failed: <message>` |

After failing check 1 or 2 the runtime still accepts another `openvessel-connect`. The host rejects
`boot()` with `OpenVessel: <message>` on the first `openvessel-error`, and with
`OpenVessel: runtime did not start in time` when `ready` hasn't arrived after `timeout` (default
30000 ms). An `openvessel-error` that arrives after `boot()` resolved is not reported by `dist/host`.

Service worker start-up in `runtime.js`: `register('./sw.js', { scope: './', updateViaCache: 'none' })`,
then `reg.update()`; while a worker is installing or waiting it waits for `controllerchange`; then
`navigator.serviceWorker.ready`; if the page still has no controller it waits for `controllerchange`
(the worker calls `clients.claim()` on activation).

### Messages to the kernel worker

| Message | From | Effect |
|---|---|---|
| `{ t: 'policy', policy }` | `runtime.js`, before `host-port`, if `init.policy` was given | sets the network policy (normalized) |
| `{ t: 'sw-port', port }` | `runtime.js`, at start and on every `controllerchange` and `need-kernel-port` | attaches a runtime service worker channel |
| `{ t: 'host-port', port }` | `runtime.js` | attaches the host channel (replacing a previous one) and posts `{ ev: 'ready' }` on it |

## Host RPC

### Format

| Message | Shape |
|---|---|
| Call (host → kernel) | `{ id: number, m: string, a: object }` |
| Result (kernel → host) | `{ id, r: any }` — a `Uint8Array` result is transferred (its `buffer`) |
| Error (kernel → host) | `{ id, e: { message: string, code?: string } }` |
| Unknown method | `{ id, e: { message: 'unknown method <m>', code: 'ENOSYS' } }` |
| Event (kernel → host) | `{ ev: string, … }` (no `id`) |
| Preview channel hand-over (host → kernel, not a call) | `{ t: 'preview-port', port: MessagePort }` |

Methods may be synchronous or return a promise; calls are answered in completion order. Errors thrown by the
file system are `KernelError`s with an errno `code` (`ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`,
…) and the errno text as `message` (for example `no such file or directory`). `dist/host` turns `e` into an
`Error` with `code`.

```js
// a minimal call over the host port
let next = 1;
const pending = new Map();
port.onmessage = ({ data }) => {
  if (data.id !== undefined && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.e ? reject(Object.assign(new Error(data.e.message), { code: data.e.code })) : resolve(data.r);
  } else if (data.ev) console.log('event', data);
};
const call = (m, a = {}) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { resolve, reject });
  port.postMessage({ id, m, a });
});
await call('ping'); // 'pong'
```

### Methods

| Method | Arguments (`a`) | Result |
|---|---|---|
| `ping` | — | `'pong'` |
| `fs.readFile` | `path`, `encoding?` (any truthy value: UTF-8) | `Uint8Array` (a copy), or `string` with `encoding` |
| `fs.writeFile` | `path`, `data: string \| Uint8Array \| ArrayBuffer`, `mode?` (default `0o644`), `mkdirs?` (default `true`: parent directories are created) | `null` |
| `fs.mkdir` | `path`, `recursive?` (default `true`) | the first directory created (recursive), or `null` |
| `fs.readdir` | `path`, `withTypes?` | `string[]`, or with `withTypes` `{ name, type: 'dir' \| 'symlink' \| 'file' }[]` (every other node type is reported as `'file'`) |
| `fs.rm` | `path`, `recursive?`, `force?` (default `true`) | `null`. Recursive: like `rm -rf` (`force: false` → `ENOENT` if missing). Otherwise `rmdir` for a directory, `unlink` for anything else (symlinks aren't followed) |
| `fs.stat` | `path` (symlinks followed) | `{ dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs, isDirectory, isFile }` |
| `fs.exists` | `path` | `boolean` |
| `fs.rename` | `from`, `to` | `null` |
| `mount` | `files: Record<string, string \| Uint8Array \| ArrayBuffer \| null \| { dir: true } \| { symlink: string }>`, `path?` (default `/home/user/app`) | number of entries. Keys are relative to `path`. `null` or `{ dir }` makes a directory, `{ symlink }` a symlink (target as given), anything else a file (mode `0o644`, parents created). Files ending in `.sh`/`.bash` and string contents starting with `#!` get the execute bits |
| `export` | `path`, `exclude?` (default `['node_modules', '.git']`, names matched at any depth) | `Record<string, Uint8Array>` of regular files, keys relative to `path`; symlinks are skipped |
| `spawn` | `argv: string[]`, `cwd?` (default `/home/user`, created if missing), `env?` (merged over the default environment), `terminal?: { cols?, rows? }` (defaults 80 × 24) | `{ pid }`. Each process starts its own process group. With `terminal`, stdin/stdout/stderr are one TTY; otherwise three pipes |
| `input` | `pid`, `data: string \| Uint8Array \| null` | `false` if the pid isn't one the host started or it has exited, else `true`. TTY: the bytes go through the line discipline. Pipes: written to stdin; `null` closes stdin. Write errors are ignored |
| `resize` | `pid`, `cols`, `rows` | `null` (only for terminal processes; delivers `SIGWINCH`) |
| `kill` | `pid`, `signal?` (default `'SIGTERM'`) | `null`. Signals the process's whole process group; errors (unknown pid) are ignored |
| `ps` | — | `{ pid, ppid, argv, cwd }[]` of running processes |
| `ports` | — | `{ port, pid }[]` of listeners reachable from the preview (legacy `net.Server` listeners are left out) |
| `network.setPolicy` | `policy: Partial<NetworkPolicy>` | the normalized policy |
| `network.getPolicy` | — | the current policy |
| `network.clearSession` | — | `null`; forgets "for this session" allows and denials |
| `permission.respond` | `id`, `decision: 'once' \| 'session' \| 'deny' \| 'deny-session'` (anything else = `deny`) | `false` if no such pending request, else `true` |
| `watch` | `path`, `id` (chosen by the caller) | `null`; afterwards `fs-change` events with that `id` for `path` and everything below it |
| `unwatch` | `id` | `null` |
| `debug.trace` | `on` | the new value (turns kernel trace logging to the console on/off) |
| `debug.esm` | `pathname`, `search?` | `{ status, body, type }` — what the runtime service worker would serve for that `/__ov/…` path |

The default environment is `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/home/user`, `USER=user`,
`LOGNAME=user`, `SHELL=/bin/sh`, `TERM=xterm-256color`, `LANG=en_US.UTF-8`, `TMPDIR=/tmp`,
`HOSTNAME=<kernel host name>`, `NAPI_RS_FORCE_WASI=true`. See [Kernel](kernel.md) and [Host API](host-api.md).

### Events

| Event | Fields | When |
|---|---|---|
| `ready` | — | right after the host channel is attached |
| `output` | `pid`, `data: Uint8Array`, `stream?: 'stdout' \| 'stderr'` | output of a process the host started; `stream` is absent for terminal processes. Pipes are read in chunks of up to 65536 bytes |
| `exit` | `pid`, `code: number`, `signal: string \| null` | a host-started process ended (for pipe processes, after its stdout and stderr reached EOF) |
| `server-ready` | `port`, `pid` | a process listens on a port reachable from the preview |
| `port-closed` | `port` | that listener went away |
| `fs-change` | `id`, `type: 'rename' \| 'change'`, `path` | a change under a watched path |
| `permission-request` | `id`, `url`, `host`, `initiator`, `source: 'runtime' \| 'preview'` | the policy says `ask` for a host; answer with `permission.respond` |
| `permission-settled` | `id`, `host`, `allowed: boolean` | a permission request was answered, or timed out |

Permission requests: the kernel merges concurrent questions about the same host name into one (all waiters
get the same answer), denies a question that isn't answered within 5 minutes, and denies at once while no
host channel is attached. `session` / `deny-session` decisions are remembered per host name until
`network.clearSession`. `initiator` is `npm` for the package manager, `<pid> <argv…>` (at most 200
characters) for processes, `process` when unknown, and `preview` for the preview. See
[Network policy](network-policy.md).

`dist/host` re-emits `exit` as `process-exit`, adds a `url` to `server-ready`, and answers
`permission-request` itself (with `onPermissionRequest` or its dialog).

## Preview relay

### Host ↔ relay iframe (`window.postMessage`)

| Message | Direction | Fields | Notes |
|---|---|---|---|
| `openvessel-preview-loaded` | relay → parent (`'*'`) | — | after the preview service worker is registered and ready |
| `openvessel-preview-connect` | host → relay | `port: MessagePort`, `defaultPort: number` | the host has sent the other end to the kernel as `{ t: 'preview-port', port }` |
| `openvessel-preview-ready` | relay → parent (`'*'`) | — | the port was handed to the service worker |
| `openvessel-preview-default-port` | host → relay | `port: number` | sent by every `previewUrl()` after the first |
| `openvessel-preview-need-port` | relay → parent (`'*'`) | — | the service worker lost its channel; the host answers with a new `openvessel-preview-connect` |

The relay accepts messages only from `window.parent`; the host only from the preview origin and the relay
iframe. The host answers both `openvessel-preview-loaded` and `openvessel-preview-need-port` by creating a
new channel.

### Relay ↔ preview service worker

| Message | Direction | Fields | Accepted when |
|---|---|---|---|
| `kernel-port` | relay → SW | `port: MessagePort`, `defaultPort: number` | the sender's URL path ends in `/relay.html`; a non-zero `defaultPort` replaces the default port |
| `default-port` | relay → SW | `port: number` | sender path ends in `/relay.html` |
| `need-kernel-port` | SW → every window client whose path ends in `/relay.html` | — | the SW needs a channel and has none; it waits up to 15 s (`preview is not connected to OpenVessel`) |

### Preview page ↔ preview service worker (WebSockets)

| Message | Direction | Fields |
|---|---|---|
| `ws-connect` | page → SW (`navigator.serviceWorker.controller`) | `port: MessagePort` (transferred), `path` (path + query), `protocols: string[]`, `vport: number`, `origin` |
| `open` | SW → page (on that port) | `protocol` |
| `msg` | SW → page | `data: string \| Uint8Array`, `binary: boolean` |
| `close` | SW → page | `code`, `reason` (`1006`/`not connected` when the SW has no kernel channel) |
| `send` | page → SW | `data: string \| Uint8Array`, `binary: boolean` |
| `close` | page → SW | `code`, `reason` |

See [Preview](preview.md#websockets) for port selection.

## Preview channel

Between the preview service worker and the kernel (`attachPreview` in `src/kernel/index.ts`). Every message
has a numeric `id` chosen by the service worker and a string `k`; the kernel ignores anything else.

| `k` | Direction | Fields | Meaning |
|---|---|---|---|
| `req` | SW → kernel | `id`, `port`, `method`, `url` (path + query), `headers: [string, string][]`, `hasBody` | start an HTTP request |
| `body` | SW → kernel | `id`, `data: Uint8Array` (transferred) | request body (the SW sends it in one piece) |
| `body-end` | SW → kernel | `id` | end of the request body (sent for every method with a body, even when empty) |
| `abort` | SW → kernel | `id` | the page cancelled the response body |
| `head` | kernel → SW | `id`, `status`, `statusText`, `headers: [string, string][]` | response head |
| `data` | kernel → SW | `id`, `data: Uint8Array` | a body chunk |
| `end` | kernel → SW | `id` | end of the response |
| `error` | kernel → SW | `id`, `msg` | the request failed (`connect ECONNREFUSED 127.0.0.1:<port>`, `socket hang up`, `incomplete response`, `server process exited`, …) |
| `ws-open` | SW → kernel | `id`, `port`, `url`, `headers` | open a WebSocket |
| `ws-opened` | kernel → SW | `id`, `protocol: string \| null` | the server accepted the upgrade |
| `ws-msg` | both | `id`, `data: string \| Uint8Array`, `binary` | a message |
| `ws-close` | SW → kernel | `id`, `code` (`Number(code) \|\| 1000`), `reason` | close from the page |
| `ws-closed` | kernel → SW | `id`, `code`, `reason` | closed by the server, or failed to open (`1006`, reason = error message) |
| `net` | SW → kernel | `id`, `url` | may the preview fetch this outside URL? (initiator `preview`, source `preview`) |
| `net-result` | kernel → SW | `id`, `allow: boolean` | the decision |

The kernel can't do anything else on this channel; file system, process and policy methods exist only on
the host channel.

## Runtime service worker

`dist/runtime/sw.js` handles same-origin requests under its scope. Paths below are relative to the
runtime directory (the scope is stripped before matching).

### Endpoints

| Path | Method | Answer |
|---|---|---|
| `/__ov/esm/<absolute VFS path>[?query]` | any | an ES module made from a VFS file by the kernel ([below](#module-endpoints)). Used by the legacy runtime |
| `/__ov/builtin/<name>[.mjs]` | any | an ES module facade over a builtin (`node:fs` etc.). Used by the legacy runtime |
| `/__ov/mw/<pid>/<id>.mjs` | any | a module source the ported runtime registered with the `esmRegister` syscall |
| `/__ov/net?url=<encoded URL>` | any | the network gate ([below](#__ovnet)) |
| `/__ov/ping` | any | `pong` (`text/plain`) |
| anything else | `GET` | fetched from the server, with the isolation headers added if missing |
| anything else | other | not handled (goes to the server) |

### Module endpoints

Module responses have `content-type: <type>; charset=utf-8`, `cache-control: no-store` and
`cross-origin-resource-policy: same-origin`, and the status the kernel returns. Errors are delivered as
modules that throw, so an `import` fails with the right `code`:

| Case | Module thrown error `code` |
|---|---|
| file not found | `ERR_MODULE_NOT_FOUND` (`Cannot find module '<path>'`) |
| directory | `ERR_UNSUPPORTED_DIR_IMPORT` |
| `.node` addon | `ERR_DLOPEN_FAILED` (`Native addons are not supported in OpenVessel: <path>`) |
| `.wasm` as an ES module | `ERR_UNKNOWN_FILE_EXTENSION` |
| `/__ov/mw/` id not registered | `ERR_INTERNAL_ASSERTION` (`module <pid>/<id> is not registered`) |
| no kernel channel within 15 s | status 200, `text/javascript`, `throw new Error("OpenVessel kernel is not connected");` |

For `/__ov/esm/` the kernel converts by format: JSON → `export default JSON.parse(…)` (also forced with the
query parameter `ov-json`), CommonJS → a facade over `globalThis.__ov.requireForImport()` with named
exports found by `cjs-module-lexer`, ES modules → the source with specifiers rewritten to `/__ov/esm/…` and
`/__ov/builtin/…` URLs and `import.meta` / `import()` routed through `globalThis.__ov`, TypeScript ES
modules → types stripped with sucrase first. Results are cached by inode, mtime and size (the cache is
cleared above 4000 entries). Registered `/__ov/mw/` sources are dropped when their process exits.

### `/__ov/net`

The only way from the runtime to the network. Callers: the ported runtime's `fetch` and the legacy
runtime's network layer (from process workers), the kernel's npm client (`initiator` `npm`) and the
kernel's outbound TCP bridge, which turns HTTP/1.1 written to a socket into these requests
(`src/kernel/outbound.ts`).

Request:

| Part | Content |
|---|---|
| URL | `<runtime base>/__ov/net?url=<encodeURIComponent(target)>` |
| Method | `GET` or `HEAD` as is; everything else is sent as `POST` with the body |
| `x-ov-method` | the real method (default: the request's method) |
| `x-ov-h` | `encodeURIComponent(JSON.stringify([[name, value], …]))`: the headers to send |
| `x-ov-by` | `encodeURIComponent(initiator)` for the permission prompt (default `process`) |
| `x-ov-redirect` | `error` makes a redirect fail; anything else (or none) follows redirects |

The service worker asks the kernel (`{ k: 'net', url, initiator }`), drops headers the browser controls
(`host`, `connection`, `content-length`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `trailer`,
`expect`, `cookie`, `cookie2`, `origin`, `referer`, `accept-encoding`, `access-control-request-headers`,
`access-control-request-method`, `date`, `dnt`, `via`, `proxy-connection`, `sec-*`, `proxy-*`) and fetches
the target with `credentials: 'omit'`, `mode: 'cors'`, `cache: 'no-store'`.

Response when the request was made (always status `200`):

| Header | Content |
|---|---|
| `x-ov-status` | the real status |
| `x-ov-status-text` | URI-encoded status text |
| `x-ov-url` | URI-encoded final URL (after redirects) |
| `x-ov-redirected` | `1` or `0` |
| `x-ov-rh` | URI-encoded JSON of the response headers the browser exposes (CORS rules apply: only safelisted and `Access-Control-Expose-Headers` headers) |
| `content-type` | the real content type, or `application/octet-stream` |
| `cache-control` | `no-store` |

The body is streamed; it is empty for `204`, `205`, `304` and `HEAD`. Failures:

| Status | `x-ov-error` | `x-ov-message` (URI-encoded, also the plain-text body) |
|---|---|---|
| `403` | `denied` | `OpenVessel: network access to <host> was denied by the network policy` |
| `502` | `network` | `request to <host> failed: <message>. The server may not allow cross-origin requests (CORS) from the browser.` |
| `502` | `network` | the kernel channel couldn't be obtained (`OpenVessel kernel is not connected`) |

The ported runtime's `fetch` turns these into `TypeError('fetch failed')` with a `cause` whose `code` is
`EACCES` (`denied`), `ETIMEDOUT` (`timeout`) or `ECONNREFUSED` (anything else); the outbound TCP bridge
writes an HTTP `403` or `502` back to the socket.

### Service worker ↔ runtime frame and kernel

| Message | Direction | Fields |
|---|---|---|
| `kernel-port` | `runtime.html` → SW | `port: MessagePort`. Accepted only from a window client whose URL path ends in `/runtime.html` |
| `ping` | `runtime.html` → SW | ignored (sent so `clients.claim()` triggers `controllerchange`) |
| `need-kernel-port` | SW → every window client whose path ends in `/runtime.html` | the SW lost its channel; `runtime.js` answers by sending new `sw-port` / `kernel-port` messages |
| `{ id, k: 'esm', pathname, search }` | SW → kernel | load a module |
| `{ id, status, body, type }` | kernel → SW | the module |
| `{ id, k: 'net', url, initiator }` | SW → kernel | policy decision for `url` (`source` is `runtime`) |
| `{ id, allow }` | kernel → SW | the decision |

The service worker waits up to 15 s for a channel; there is no timeout on the kernel's answers.

## Kernel ↔ process messages

Each process (and each `worker_threads` thread) is a Web Worker created by the kernel. These messages are
`postMessage`s on that worker; syscalls use the [synchronous channel](#synchronous-syscall-channel).

### `init`

The first message to a new worker:

| Field | Content |
|---|---|
| `t` | `'init'` |
| `kind` | `'main'` or `'thread'` |
| `pid`, `ppid`, `tid` | ids |
| `argv`, `env`, `cwd` | the process's command line, environment and working directory |
| `sab` | the `SharedArrayBuffer` of the syscall channel (4 MiB) |
| `ttys` | `{ 0, 1, 2 }` → `{ cols, rows }` for descriptors that are a TTY, else `null` |
| `hostname` | the kernel's host name |
| threads only | `file`, `eval`, `evalType`, `execArgv`, `workerData`, `envData`, `port` (transferred `MessagePort`), `name`, `threadId`, `resourceLimits`, `envRings`, `trackUnmanagedFds`, `sharedEnv` |

### Process → kernel

| `t` | Fields | Meaning |
|---|---|---|
| `sys` | — | "a syscall request is in the shared buffer" |
| `pong` | `id` | answer to `ping` |
| `readStart` | `fd` | start delivering data from `fd` as `fd-data` |
| `readStop` | `fd` | stop |
| `readOnce` | `fd`, `len?` (default 65536), `id` | one read, answered with `fd-data` carrying `id` |
| `writeWait` | `fd` | send `fd-writable` once the pipe/socket buffer has drained |
| `threadSpawn` | `tid`, `file`, `eval`, `argv`, `port`, … | start a `worker_threads` thread |
| `threadKill` | `tid` | terminate a thread |
| `loop-req`, `loop-body`, `loop-body-end`, `loop-abort` | `crid`, `port`, `method`, `url`, `headers`, `data` | legacy runtime: HTTP request to a virtual port |
| `http-res`, `http-res-data`, `http-res-end`, `http-res-error` | `rid`, `status`, `statusText`, `headers`, `data`, `msg` | legacy runtime: response to `http-req` |
| `ws-open`, `ws-send`, `ws-close` | `rid`, `protocol`, `headers`, `data`, `binary`, `code`, `reason` | legacy runtime: WebSocket server side |

### Kernel → process

| `t` | Fields | Meaning |
|---|---|---|
| `ping` | `id` | "answer once everything posted before is handled" (used when a process exits while its peers are reading) |
| `fd-data` | `fd` or `id`, `data: Uint8Array \| null` (`null` = EOF), `err?`, `handle?` | read data; `handle` describes a descriptor received over IPC |
| `fd-writable` | `fd` | buffer drained |
| `signal` | `sig` | a signal the process handles (and `SIGWINCH`) |
| `child-exit` | `pid`, `code`, `signal` | a child started with the `spawn` syscall ended |
| `watch` | `id`, `type`, `path` | file system change for a `watch` syscall |
| `thread-exit` | `tid`, `code`, `initFailed?`, `terminated?` | a thread ended |
| `thread-gone` | `tid` | a watched thread is gone |
| `tcp-accept` | `port`, `fd`, `remoteAddress`, `remotePort` | ported runtime: a new connection on a listening port |
| `pipe-accept` | `port`, `fd`, `remoteAddress`, `remotePort` | ported runtime: a new Unix-socket connection |
| `tls-peer` | `fd`, `certs` | the peer's certificates (TLS between two processes) |
| `udp-msg` | `port`, `data`, `from: { address, port }` | a datagram |
| `http-req` | `rid`, `port`, `method`, `url`, `headers`, `hasBody`, `upgrade?` | legacy runtime: an HTTP request for its server |
| `http-body`, `http-body-end`, `http-abort` | `rid`, `data` | legacy runtime: request body / abort |
| `ws-msg`, `ws-close` | `rid`, `data`, `binary`, `code`, `reason` | legacy runtime: WebSocket from the client |
| `loop-res`, `loop-res-data`, `loop-res-end`, `loop-res-error` | `crid`, … | legacy runtime: response to `loop-req` |

## Synchronous syscall channel

Every process thread gets its own `SharedArrayBuffer`. The worker writes a request, posts `{ t: 'sys' }` to
the kernel and blocks in `Atomics.wait` until the kernel has written the answer (`src/shared/syncchan.ts`).

### Layout

| Bytes | Content |
|---|---|
| 0–63 | header: 16 `Int32` slots (`HEADER_BYTES = 64`), 5 used |
| 64 – end | data region: 4 MiB − 64 bytes = 4194240 bytes per round (`DEFAULT_CHANNEL_BYTES = 4 * 1024 * 1024`) |

| Slot | Name | Values |
|---|---|---|
| `[0]` | state | `0` idle, `1` request written, `2` response written |
| `[1]` | JSON length | byte length of the whole message's UTF-8 JSON |
| `[2]` | binary length | byte length of the whole message's binary payload |
| `[3]` | bytes this round | how many bytes of the message are in the data region now |
| `[4]` | flags | `1` = more chunks follow |

A message is its UTF-8 JSON immediately followed by its binary payload.

### One round

```text
worker (SyncClient)                         kernel (SyncServer)
write data, [1..4]
Atomics.store([0], 1)
postMessage({ t: 'sys' })  ───────────────▶ onmessage: receive() (only if [0] == 1)
while ([0] == 1) Atomics.wait([0], 1)        … runs the syscall (may be async) …
                                             respond(): write data, [1..4]
                            ◀─────────────── Atomics.store([0], 2); Atomics.notify([0])
read the answer
Atomics.store([0], 0)
```

### Messages larger than the data region

- **Request:** the worker sends the message in rounds of at most 4194240 bytes with flag `1` on all but
  the last. The kernel collects the chunks (`[1]` and `[2]` give the total size), acknowledges each
  intermediate chunk with state `2` and `[3] = 0`, and handles the request after the last.
- **Response:** the kernel writes the first chunk with flag `1`. The worker copies it, sends an empty
  "continue" round (`[1..4] = 0`, state `1`, another `sys` message), and the kernel writes the next chunk,
  until a chunk without the flag.

### Request and response bodies

| Direction | JSON | Binary |
|---|---|---|
| request | `{ op: string, …arguments }` | optional (data for `write`, `writeFile`, …) |
| success | `{ ok: value }` (`undefined` becomes `null`) | — |
| success with bytes | `{ ok: null, bin: true }` when the result is a `Uint8Array`; `{ ok: rest, bin: true }` when it is an object with a `__bin` field | the bytes |
| error | `{ err: code, msg: message }` (`code` defaults to `EIO`) | — |
| unknown `op` | `{ err: 'ENOSYS', msg: 'unknown syscall <op>' }` | — |

On the worker side `sys(op, args, bin)` (`src/node/sys.ts`, used by both runtimes) returns `ok` (or the
bytes, or `ok` with a `bin` field) and throws a `SysError` with `code` for `err`.

### Operations

| Group | `op` |
|---|---|
| Files | `stat`, `fstat`, `fdKind`, `access`, `open`, `close`, `read`, `write`, `lseek`, `readFile`, `writeFile`, `readdir`, `mkdir`, `mkdtemp`, `rmdir`, `rm`, `unlink`, `rename`, `link`, `symlink`, `readlink`, `realpath`, `chmod`, `fchmod`, `utimes`, `futimes`, `truncate`, `ftruncate`, `copyFile`, `cp`, `watch`, `unwatch` |
| Modules | `resolve`, `moduleFormat`, `esmRegister` |
| Process | `getcwd`, `umask`, `chdir`, `exit`, `execve`, `kill`, `sigaction`, `spawn`, `spawnSync`, `isatty`, `ttySize`, `setRawMode` |
| Threads | `threadReserve`, `watchThread`, `threadExit` |
| UDP | `udpBind`, `udpJoin`, `udpRecv`, `udpClose`, `udpSend` |
| Network | `listen`, `unlisten`, `listenShare`, `tlsHello`, `tcpConnect`, `tcpConnectOut`, `tcpSetTls`, `shutdown`, `unixListen`, `unixUnlisten`, `unixConnect`, `portInfo` |

Their arguments and semantics are described in [Kernel](kernel.md) (implementation:
`src/kernel/syscalls.ts`).
