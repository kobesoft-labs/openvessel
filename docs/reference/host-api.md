# Host API

[日本語](host-api.ja.md)

The complete reference of the API an embedding page uses: `OpenVessel.boot()` and its options, files,
processes, the network policy, events, permission requests and the built-in dialog, previews,
teardown and errors. The source is `src/host/index.ts`; the declarations are
`dist/types/host/index.d.ts`. For a walkthrough, see [Getting started](getting-started.md).

## Exports

```ts
import OpenVessel from 'openvessel';               // default export: the OpenVessel class
import { OpenVessel, Process, PRESETS } from 'openvessel';
import type { BootOptions, SpawnOptions, PermissionRequest, PermissionDecision, NetworkPolicy, RuntimeErrorEvent } from 'openvessel';
```

| Export | Kind | Description |
|---|---|---|
| `OpenVessel` (also the default export) | class | One embedded runtime. Created only by `OpenVessel.boot()`. |
| `Process` | class | A process started by `spawn()`. Not constructed by user code. |
| `VesselProcess` | class (alias) | Deprecated alias of `Process` (renamed in 1.1.0). |
| `PRESETS` | object | The built-in host lists of the network policy, keyed by preset name ([Network policy](network-policy.md#presets)). |
| `BootOptions` | type | Options of `boot()`. |
| `SpawnOptions` | type | Options of `spawn()` and `exec()`. |
| `PermissionRequest` | type | What a permission handler receives. |
| `PermissionDecision` | type | `'once' \| 'session' \| 'deny' \| 'deny-session'`. |
| `NetworkPolicy` | type | `{ mode, presets, allow, deny }` ([Network policy](network-policy.md#the-policy-object)). |
| `RuntimeErrorEvent` | type | Payload of the `error` event ([Events](#events--on)). **New in 1.2.0.** |

Members marked `@internal` in the source (`_call`, `Process._data`, `Process._exit`) are not part of
the API.

## `OpenVessel.boot()`

```ts
static boot(opts: BootOptions): Promise<OpenVessel>
```

Embeds the runtime and resolves with a connected instance.

### `BootOptions`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `runtimeUrl` | `string` | required | Where `dist/runtime/` is served: the directory (`https://rt.example.com/`) or the `runtime.html` URL itself. Resolved against `location.href`; query and fragment are dropped. A last path segment without an extension names a directory (`https://rt.example.com/ov` is `https://rt.example.com/ov/`); one with an extension is a file in its directory. The frame loads `runtime.html` from that directory. If its origin equals the page's origin, `boot()` logs the warning `OpenVessel: the runtime should be served from its own origin` and continues. |
| `previewUrl` | `string` | none | Where `dist/preview/` is served. Its directory, found like `runtimeUrl`'s (`https://pv.example.com/app` is `https://pv.example.com/app/`), is the preview base. Without it, `previewUrl()` and `createPreview()` reject and `server-ready` events carry `url: null`. |
| `network` | `Partial<NetworkPolicy>` | `{ mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'], allow: [], deny: [] }` | The initial network policy. Missing fields take the defaults. |
| `onPermissionRequest` | `(req: PermissionRequest) => PermissionDecision \| Promise<PermissionDecision>` | the built-in dialog | Answers requests to hosts the policy doesn't decide ([Permission requests](#permission-requests)). |
| `locale` | `'ja' \| 'en'` | `'ja'` when `navigator.language` starts with `ja`, else `'en'` | Language of the built-in dialog. |
| `timeout` | `number` (ms) | `30000` | How long `boot()` waits for the kernel to be ready. |

### What `boot()` does

1. Rejects with `OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).` if `crossOriginIsolated` is false.
2. Creates a hidden iframe for `runtime.html` with `allow="cross-origin-isolated"`, `aria-hidden="true"`,
   `tabIndex = -1` and `position:absolute;width:0;height:0;border:0;visibility:hidden`, and appends it to
   `document.body` (the body must exist).
3. Waits for the frame's `openvessel-runtime-loaded` message (accepted only from the runtime origin and
   that frame), then hands the frame one end of a `MessageChannel` together with the network policy.
4. The runtime frame checks that the host origin is listed in its `openvessel-allowed-hosts` meta tag,
   that it is embedded directly by the top-level page, and that it is cross-origin isolated; it
   registers its service worker (`sw.js`, scope `./`), waits until the worker controls it, and starts
   the kernel worker (`kernel.js`).
5. Resolves when the kernel posts `ready`. If `network` was given, `boot()` then sets it once more with
   `network.setPolicy()` before resolving.

Errors reported by the runtime frame during boot reject `boot()` with `OpenVessel: <message>`
([Errors](#errors)). If nothing arrives within `timeout`, it rejects with
`OpenVessel: runtime did not start in time`. When `boot()` rejects, the runtime iframe and the message
listener it added are removed. Errors the runtime frame reports after `boot()` resolved go to the
`error` event ([Events](#events--on)).

### One instance per runtime origin

The runtime's service worker holds a single connection to a kernel — the one from the runtime frame
that connected last. A second instance on the same runtime origin in the same browser profile (another
`boot()` in the page, or the same page in another tab) takes it over: ES module loading in the earlier
instance's `node` processes then fails (`Error: module … is not registered`), and its network checks
are decided by the newer kernel. Use one instance per runtime origin at a time.

## Files — `vessel.fs`

All methods talk to the kernel's in-memory file system ([File system](filesystem.md)) and return
promises. Paths are always taken from the root: there is no working directory, and a relative path such
as `tmp/a` means `/tmp/a`. `.` and `..` components are resolved; symlinks in intermediate components
are followed (at most 40 levels, then `ELOOP`). Paths over 4096 bytes or components over 255 bytes fail
with `ENAMETOOLONG`. Errors reject with an `Error` whose `code` is the POSIX code and whose `message` is
the plain errno text (for example `no such file or directory`, not Node's
`ENOENT: no such file or directory, open '…'`).

| Method | Resolves with | Kernel behaviour |
|---|---|---|
| `readFile(path)` | `Uint8Array` | A copy of the file's bytes. |
| `readFile(path, 'utf8')` | `string` | The bytes decoded as UTF-8 (invalid sequences become U+FFFD). Any truthy encoding argument decodes as UTF-8. |
| `writeFile(path, data)` | `null` | Creates missing parent directories, then creates or replaces the file. |
| `mkdir(path, { recursive })` | `string \| null` | `recursive` defaults to **true**. |
| `readdir(path)` | `string[]` | Entry names. |
| `readdir(path, { withFileTypes: true })` | `{ name, type }[]` | `type` is `'dir'`, `'symlink'` or `'file'`. |
| `rm(path, { recursive, force })` | `null` | `rm -rf` when `recursive`; else `rmdir` or `unlink`. |
| `stat(path)` | stat object | Follows symlinks. |
| `exists(path)` | `boolean` | Never rejects. |
| `rename(from, to)` | `null` | `rename(2)`. |
| `watch(path, fn)` | `() => Promise<null>` | Subscribes to changes under `path`. |

### `fs.readFile(path, encoding?)`

- Without `encoding`: a new `Uint8Array` with the file's contents (its buffer is transferred, not
  shared).
- With `encoding` (typed `'utf8'`): the contents decoded as UTF-8. Other encodings are not supported;
  `'latin1'` also decodes as UTF-8.
- Symlinks are followed. A character device (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`)
  reads as empty.
- Errors: `ENOENT`, `ENOTDIR`, `EISDIR` (a directory), `ELOOP`, `ENAMETOOLONG`.

### `fs.writeFile(path, data)`

- `data`: a `string` (written as UTF-8) or a `Uint8Array` (copied). An `ArrayBuffer` is accepted too.
  Anything else rejects with `data must be a string or Uint8Array` (an `Error` without `code`).
- Missing parent directories are created (mode `0755`). A new file gets mode `0644`; an existing file
  keeps its mode, owner and inode, and its contents are replaced.
- A symlink at `path` is followed; a dangling symlink creates its target. Writing to a character device
  (`/dev/null`) passes the bytes to the device.
- Watchers see `rename` for a new file (and for each created directory) and `change` for the write.
- Errors: `EISDIR` (a directory), `ENOTDIR` (a parent component is a file), `EINVAL` (last component
  `.` or `..`), `EEXIST` (`/`), `ELOOP`, `ENAMETOOLONG`.

### `fs.mkdir(path, { recursive = true })`

- Recursive (the default): creates every missing component with mode `0755` and resolves with the
  first directory it created, or `null` when all existed. An existing non-directory component rejects
  with `ENOTDIR`.
- `recursive: false`: creates exactly one directory and resolves with `path`; `EEXIST` if the name
  exists, `ENOENT` if the parent is missing.

### `fs.readdir(path, { withFileTypes })`

- Names in creation order (not sorted), without `.` and `..`.
- `withFileTypes: true`: `{ name: string, type: 'dir' | 'symlink' | 'file' }[]`. Symlinks are reported
  as `'symlink'` (not followed); everything that is neither a directory nor a symlink — regular files,
  character devices, FIFOs, sockets — is `'file'`.
- `path` itself is followed if it is a symlink. Errors: `ENOENT`, `ENOTDIR`.

### `fs.rm(path, { recursive, force })`

| Options | Behaviour |
|---|---|
| `recursive: true` | Removes `path` and everything below it. Symlinks are removed, not followed. A missing `path` resolves when `force` is true or omitted, and rejects with `ENOENT` when `force: false`. |
| `recursive` omitted or false | A directory is removed only if empty (`ENOTEMPTY` otherwise); anything else is unlinked. A missing `path` always rejects with `ENOENT` — `force` is ignored. |

`/` itself can't be removed: `rm('/')` rejects with `EEXIST` — with `recursive: true`, only after
everything under it has been removed.

### `fs.stat(path)`

Follows symlinks and resolves with a plain object:

| Field | Value |
|---|---|
| `dev` | `2049` |
| `ino` | inode number |
| `mode` | type bits and permission bits (`0o100644` for a file written by the host) |
| `nlink` | link count |
| `uid`, `gid` | `1000` unless changed by a process |
| `rdev` | device number for character devices, else `0` |
| `size` | bytes for files; `4096` for directories; target length for symlinks (not reachable here, `stat` follows them) |
| `blksize` | `4096` |
| `blocks` | `ceil(size / 512)` |
| `atimeMs`, `mtimeMs`, `ctimeMs`, `birthtimeMs` | milliseconds since the epoch |
| `isDirectory` | `boolean` (a property, not a method) |
| `isFile` | `boolean` (a property, not a method) |

Errors: `ENOENT`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`.

### `fs.exists(path)`

`true` if `path` resolves (following symlinks), else `false`. A dangling symlink is `false`. It never
rejects.

### `fs.rename(from, to)`

Moves a file, symlink or directory. An existing file at `to` is replaced; an existing empty directory
is replaced by a directory; renaming onto itself does nothing. Errors: `ENOENT` (`from` or the parent of
`to` missing), `EINVAL` (a directory into itself), `EISDIR` (a non-directory onto a directory),
`ENOTEMPTY` (onto a non-empty directory), `ENOTDIR` (a directory onto a non-directory). Watchers see
`rename` for both paths.

### `fs.watch(path, fn)`

```ts
const stop = await vessel.fs.watch('/home/user/app', (ev) => console.log(ev.type, ev.path));
await stop();
```

- `fn` receives `{ type: 'rename' | 'change', path: string }` for every change whose path equals `path`
  or starts with `path + '/'` (a plain string prefix check; `path` is not normalised and need not
  exist).
- Changes come from every source: the host API, shell programs, npm, and `node` processes (including
  writes through open file descriptors).
- `rename`: a file, directory, symlink, FIFO or socket was created, removed or renamed (a rename reports
  both paths). `change`: contents written or truncated, `chmod`, `utimes`.
- The returned function unsubscribes and resolves with `null`.

## `mount()`

```ts
mount(
  files: Record<string, string | Uint8Array | null | { symlink: string }>,
  opts?: { path?: string },
): Promise<number>
```

Writes many entries at once and resolves with how many were processed.

| Value | Result |
|---|---|
| `string` | A file with the UTF-8 text. |
| `Uint8Array` | A file with the bytes (an `ArrayBuffer` is also accepted). |
| `null` | A directory (`mkdir -p`). |
| `{ symlink: target }` | A symlink to `target` (relative targets are resolved from the link's directory when used). Its parent directories are created. `EEXIST` if the name already exists. |

- `opts.path` defaults to `/home/user/app`; it is created if missing. Each key is joined as
  `<path>/<key>` with repeated slashes collapsed, so a leading `/` in a key does not make it absolute.
  `..` components are resolved, not rejected.
- Files are written like `fs.writeFile()`: parents created, new files mode `0644`, existing files keep
  their mode. A file whose name ends in `.sh` or `.bash`, or whose **string** value starts with `#!`,
  additionally gets the execute bits (`0755` for a new file).
- Entries are processed in the object's key order. It is not atomic: an invalid value (for example a
  number) rejects with `data must be a string or Uint8Array` after the entries before it were written.

## `export()`

```ts
export(path: string, opts?: { exclude?: string[] }): Promise<Record<string, Uint8Array>>
```

Reads a directory tree back as a flat map of relative paths (`'src/pages/index.astro'`) to copies of
the file contents.

- Only regular files are included. Symlinks, devices, FIFOs, sockets and empty directories are left out;
  symlinked directories below `path` are not followed (`path` itself is).
- `exclude` lists entry **names** skipped at any depth (exact match, not globs or paths). The default is
  `['node_modules', '.git']`; passing `exclude` replaces the default (`exclude: []` includes everything).
- Errors: `ENOENT`, `ENOTDIR` for `path`.

## Processes

### `spawn()`

```ts
spawn(command: string, args?: string[], opts?: SpawnOptions): Promise<Process>
```

Starts `command` with `args` and resolves with a [`Process`](#process) once the process exists.
`command` is looked up like `execvp`: a name without `/` is searched in `PATH`, and the kernel's
built-in programs (`sh`, coreutils, `npm`, …) are found even without a `/bin` entry. Scripts with a
shebang run their interpreter; `.js`, `.cjs` and `.mjs` files run with `node`; other files run with
`sh` ([Processes](processes.md)).

| `SpawnOptions` field | Type | Default | Meaning |
|---|---|---|---|
| `cwd` | `string` | `/home/user` | Working directory. Created (with parents) if it doesn't exist. |
| `env` | `Record<string, string>` | — | Added to (and overriding) the default environment below. |
| `terminal` | `{ cols: number; rows: number }` | — | Run on a new TTY of this size (each field defaults to 80 × 24 if missing). Without it, stdin, stdout and stderr are pipes. |

The default environment:

| Variable | Value |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/home/user` |
| `USER`, `LOGNAME` | `user` |
| `SHELL` | `/bin/sh` |
| `TERM` | `xterm-256color` |
| `LANG` | `en_US.UTF-8` |
| `TMPDIR` | `/tmp` |
| `HOSTNAME` | `openvessel` |
| `NAPI_RS_FORCE_WASI` | `true` |

Each spawned process starts its own process group, so `kill()` also reaches the children that stay in
that group. With `terminal`, the process is the terminal's foreground group.

Errors: `ENOENT` (`<cmd>: command not found`), `EACCES` (`<cmd>: Permission denied` — the file isn't
executable), `ELOOP` (more than 8 nested shebangs), and `ENOTDIR` if `cwd` can't be created.

Output that arrives before `spawn()` resolves is kept and delivered to the `Process`, as is an exit that
happens that early.

### `Process`

| Member | Type | Description |
|---|---|---|
| `pid` | `number` | Process id. |
| `output` | `ReadableStream<string>` | Everything the process writes, decoded as UTF-8 (streaming, so multi-byte characters split across chunks are kept whole; an incomplete sequence left at the end becomes U+FFFD). stdout and stderr are merged in arrival order. Closes when the process ends. Chunks queue until read; if you never read the stream, they stay in memory. |
| `exit` | `Promise<number>` | The exit code ([Exit codes](#exit-codes-and-signals)). Without a terminal it resolves when the process has exited **and** both output pipes have reached end of file (a background child still holding the pipe delays it); with a terminal, when the process has exited. If the kernel is gone first (`teardown()`, a fatal [`error`](#the-error-event)), it resolves with `137`. |
| `collected` | `string` (getter) | All output so far. When it grows past 2 000 000 characters it is cut to the last 1 000 000. |
| `write(data)` | `Promise<boolean>` | `string` (UTF-8) or `Uint8Array` to stdin — through the line discipline for a terminal. Resolves `false` when the process is gone, else `true` (also after `end()`, when the data is dropped). |
| `end()` | `Promise<boolean>` | Ends the input. A pipe process: closes stdin (the reader sees end of file); later writes are dropped. A terminal process: sends the EOF character `^D` through the line discipline, as pressing Ctrl-D does — at the start of a line the reader sees end of file; after a partial line that line is delivered first, and a second `end()` gives end of file; in raw mode the program reads the byte `0x04`. The terminal stays usable. Resolves `false` when the process is gone. (Before 1.2.0 it rejected on terminal processes.) |
| `resize(cols, rows)` | `Promise<null>` | Resizes the terminal and sends `SIGWINCH` to the processes on it. Does nothing for pipe processes. |
| `kill(signal = 'SIGTERM')` | `Promise<null>` | Sends `signal` to the process's whole process group. Always resolves `null`, also when the process is gone. |

### `exec()`

```ts
exec(commandLine: string, opts?: SpawnOptions): Promise<{ code: number; output: string }>
```

`spawn('/bin/sh', ['-c', commandLine], opts)`, then waits for `exit` and resolves with the code and
`collected` (stdout and stderr together, bounded as above). It never rejects because the command
failed — check `code`. With `opts.terminal` the output contains the terminal's `\r\n`.

### Exit codes and signals

- A normal exit gives its code. A process ended by a signal gives `128 + n` (`SIGINT` → 130,
  `SIGKILL` → 137, `SIGTERM` → 143), and the `process-exit` event carries the signal name.
- `kill()` accepts a name with or without `SIG` (`'SIGINT'`, `'INT'`) or a number. Known signals:
  `SIGHUP` 1, `SIGINT` 2, `SIGQUIT` 3, `SIGILL` 4, `SIGTRAP` 5, `SIGABRT` 6, `SIGBUS` 7, `SIGFPE` 8,
  `SIGKILL` 9, `SIGUSR1` 10, `SIGSEGV` 11, `SIGUSR2` 12, `SIGPIPE` 13, `SIGALRM` 14, `SIGTERM` 15,
  `SIGCHLD` 17, `SIGCONT` 18, `SIGSTOP` 19, `SIGTSTP` 20, `SIGTTIN` 21, `SIGTTOU` 22, `SIGWINCH` 28.
  An unknown name still ends the process and counts as 15 in the exit code (`143`).
- A `node` process that installed a handler (`process.on('SIGINT', …)`) receives the signal instead of
  being ended (except `SIGKILL`). `SIGWINCH`, `SIGCHLD` and `SIGCONT` don't end a process.

### `ps()`

```ts
ps(): Promise<{ pid: number; ppid: number; argv: string[]; cwd: string }[]>
```

Every running process in the kernel (not only those started by the host), with its current working
directory. `argv` is the command line as the kernel runs it (a script run through its shebang shows the
interpreter, for example `['node', '/home/user/app/node_modules/.bin/astro', 'dev']`). `ppid` is `0`
for processes started by the host.

### `ports()`

```ts
ports(): Promise<{ port: number; pid: number }[]>
```

The virtual ports being listened on, with the listening process. In the ported runtime every TCP
listener is included; in the legacy runtime only HTTP servers are (plain `net` servers are kept
internal and are not reported).

## Network policy — `vessel.network`

| Method | Resolves with | Description |
|---|---|---|
| `setPolicy(policy: Partial<NetworkPolicy>)` | `NetworkPolicy` | Replaces the whole policy. Missing fields take the **defaults**, not the current values (`setPolicy({ mode: 'allowlist' })` also resets `presets` to the four defaults and empties `allow`/`deny`). Unknown preset names are dropped. Resolves with the normalised policy. |
| `getPolicy()` | `NetworkPolicy` | The current policy. |
| `clearSession()` | `null` | Forgets the "for this session" decisions (both allow and deny). |

Session decisions survive `setPolicy()`. The model, the presets and the decision order are in
[Network policy](network-policy.md).

## Events — `on()`

```ts
on(event: 'error', fn: (ev: RuntimeErrorEvent) => void): () => void
on(event: 'server-ready' | 'port-closed' | 'permission-request' | 'permission-settled' | 'process-exit' | 'error',
   fn: (ev: any) => void): () => void
```

Returns a function that removes the listener. Listeners run synchronously in the order they were
added; an exception in one is logged with `console.error` and doesn't stop the others.

| Event | Payload | When |
|---|---|---|
| `server-ready` | `{ port: number, pid: number, url: string \| null }` | A process starts listening on a virtual port. In the ported runtime any TCP listener; in the legacy runtime HTTP servers only. `url` is the preview URL for `/` (`previewUrl` configured), else `null`. With `previewUrl`, the event starts the preview relay if it isn't running and is emitted once the relay is up, so `url` can be loaded at once; if the relay fails to start (at most 20 s), the event is emitted anyway, a non-fatal `error` reports the failure, and the next `previewUrl()` / `createPreview()` tries again. `server-ready` and `port-closed` keep their order. Port `0` is reported as the port the kernel picked (49152–65151). |
| `port-closed` | `{ port: number }` | The listener is gone (server closed, or its process exited). |
| `process-exit` | `{ pid: number, code: number, signal: string \| null }` | A process started by `spawn()`/`exec()` ended. Not emitted for processes those start themselves. |
| `permission-request` | `{ ev: 'permission-request', id: number, url: string, host: string, initiator: string, source: 'runtime' \| 'preview' }` | The kernel asks about a host. Listeners are informational; the answer comes from `onPermissionRequest` or the dialog. |
| `permission-settled` | `{ ev: 'permission-settled', id: number, host: string, allowed: boolean, decision: 'once' \| 'session' \| 'deny' \| 'deny-session' \| 'timeout' }` | A request was decided. `decision` is the answer, or `'timeout'` when nobody answered within 5 minutes (then `allowed` is `false`). An answer that isn't one of the four decisions arrives as `'deny'`. `decision` is **new in 1.2.0**. |
| `error` | `RuntimeErrorEvent`: `{ error: Error, message: string, fatal: boolean }` | **New in 1.2.0.** Something failed outside a call ([below](#the-error-event)). Without any `error` listener, the error is logged with `console.error`. |

### The `error` event

| Cause | `message` | `fatal` |
|---|---|---|
| The runtime frame reports an error after `boot()` (an uncaught error in the kernel worker) | `OpenVessel: kernel failed: <message>` | `false`. A worker keeps running after an uncaught error, so the host then checks that the kernel still answers: without an answer within 10 s, the same error is emitted again with `fatal: true`. |
| The runtime frame loads again (it was reloaded, or moved in the document, which reloads an iframe) | `OpenVessel: the runtime frame was reloaded; the kernel is gone` | `true` |
| The preview relay could not start for a `server-ready` event | `OpenVessel: preview relay did not start` | `false` |

When the error is fatal, the instance is shut down as by [`teardown()`](#teardown), except that event
listeners are kept: calls still waiting and every later call reject with that error, running
processes end (`exit` resolves with `137`, `process-exit` is emitted with `signal: 'SIGKILL'`), and the
runtime and relay iframes are removed. Boot a new instance to continue.

## Permission requests

When the policy says "ask" for a host ([Network policy](network-policy.md#permission-requests)), the
kernel sends one request per host, and the host page:

1. emits `permission-request` to listeners,
2. calls `onPermissionRequest(req)` if given, otherwise shows the built-in dialog,
3. sends the decision to the kernel. A handler that throws or rejects counts as `'deny'`; a value that
   isn't one of the four decisions also counts as a plain deny.

`PermissionRequest`:

| Field | Description |
|---|---|
| `id` | Request id (also in `permission-settled`). |
| `url` | The full URL of the first request that triggered it. |
| `host` | Lower-case host name without port (and without brackets for IPv6). |
| `initiator` | Who asked, as reported by the requesting side: `'npm'` for the kernel's own requests (`npm`, `pnpm`, `yarn`, `bun`, `curl`, `wget`), the pid and the start of the command line for a `node` process (for example `'7 node'`), `'preview'` for the preview page, `'process'` when not reported. Informational only. |
| `source` | `'runtime'` (a process or the kernel) or `'preview'` (the preview page). |

| `PermissionDecision` | Effect |
|---|---|
| `'once'` | Allow the waiting requests to this host; the next one asks again. |
| `'session'` | Allow, and allow this host without asking until `clearSession()`. |
| `'deny'` | Deny the waiting requests; the next one asks again. |
| `'deny-session'` | Deny, and deny this host without asking until `clearSession()`. |

Handlers are called concurrently, one call per request. A handler that never answers leaves the
request waiting until the kernel's 5-minute timeout denies it; answering after that has no effect.

### The built-in dialog

Used when `onPermissionRequest` is not given. It is a modal `<dialog>` appended to `document.body`
with inline styles (max width 440 px), and removed after the answer.

| Part | `en` | `ja` |
|---|---|---|
| Title | `Allow network access?` | `外部への接続の確認` |
| Text, preview | `The preview page wants to connect to:` | `プレビューのページ が次のサイトへ接続しようとしています。` |
| Text, runtime | `<initiator> wants to connect to:` (`A process` if empty) | `<initiator> が次のサイトへ接続しようとしています。`（空なら `プロセス`） |
| Host | `req.host` in a code block | same |
| URL | `req.url`, cut to 117 characters + `…` when longer than 120 | same |

Buttons, left to right:

| Button (`en`) | Button (`ja`) | Decision |
|---|---|---|
| `Deny for this session` | `このセッション中は拒否` | `'deny-session'` |
| `Deny` | `拒否` | `'deny'` |
| `Allow once` | `今回だけ許可` | `'once'` |
| `Allow for this session` (primary) | `このセッション中は許可` | `'session'` |

Escape (the dialog's `cancel` event) answers `'deny'`. Only one dialog is shown at a time; further
requests wait in a queue shared by all instances in the page. When a request is settled without the
dialog (the kernel's 5-minute timeout denies it), `permission-settled` closes its dialog, or takes it
out of the queue, and the next one is shown. `teardown()` does the same for the instance's dialogs.

## Preview

### `previewUrl()`

```ts
previewUrl(port: number, path = '/'): Promise<string>
```

Starts the preview relay if needed and resolves with
`<preview base>__ov/open?port=<port>&path=<encodeURIComponent(path)>`. Loading that URL in a frame shows
`path` from the server on `port`. Rejects with `OpenVessel: previewUrl was not configured` without
`previewUrl` in `boot()`.

The relay is a hidden iframe for `<preview base>__ov/relay.html` (styled like the runtime frame). The
first call (or the first `server-ready` event) starts it and waits up to 20 s for it to register the
preview service worker (`OpenVessel: preview relay did not start` otherwise). A failed start removes
the iframe, and the next call starts it again. Later calls make `port` the relay's default port and
return at once; one made while the relay is starting waits for it. How requests reach the server is described in
[Preview](preview.md).

### `createPreview()`

```ts
createPreview(port: number, opts?: { path?: string; container?: HTMLElement }): Promise<HTMLIFrameElement>
```

Calls `previewUrl(port, opts.path)` and creates an iframe with:

| Attribute | Value |
|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock` (no `allow-top-navigation`: the preview can't navigate your page) |
| `allow` | `clipboard-write; fullscreen` |
| `referrerpolicy` | `no-referrer` |
| `style` | `width:100%;height:100%;border:0;background:#fff` |
| `src` | the URL from `previewUrl()` |

It is appended to `opts.container` when given, otherwise returned unattached. Each call creates a new
iframe; reload one by setting its `src` again.

## `teardown()`

```ts
teardown(): void
```

Removes the runtime iframe (the kernel and every process end with it) and the relay iframe, closes
the channel, and removes the instance's message listeners and event listeners. Calls still waiting and
every later call reject with `OpenVessel: the instance was torn down`; running processes end (`exit`
resolves with `137`, and `process-exit` is emitted with `signal: 'SIGKILL'` before the listeners are
removed); the instance's built-in permission dialogs close. It doesn't remove preview iframes or
unregister the service workers. The instance can't be used afterwards; boot a new one instead.

## Errors

Every method that talks to the kernel rejects with an `Error` built from the kernel's answer:
`message` is the kernel's message and `code` its error code (`undefined` when the kernel error had
none; the original error class, such as `TypeError`, is not kept).

| Code | Produced by |
|---|---|
| `ENOENT` | Missing path (`fs.*`, `export`), unknown command in `spawn()` (`<cmd>: command not found`). |
| `ENOTDIR` | A path component is not a directory; `readdir`/`export` of a file; a recursive `mkdir` (or `writeFile`, `mount`) meeting a file where a directory is needed. |
| `EISDIR` | `readFile`/`writeFile` on a directory; `rename` of a file onto a directory. |
| `EEXIST` | `mkdir` without `recursive` on an existing name; a `{ symlink }` entry in `mount` whose name exists; creating or removing `/` itself. |
| `ENOTEMPTY` | `rm` without `recursive` on a non-empty directory; `rename` onto a non-empty directory. |
| `EINVAL` | `rename` of a directory into itself; a last path component of `.` or `..`. |
| `ELOOP` | More than 40 symlinks while resolving a path; more than 8 nested shebangs in `spawn()`. |
| `ENAMETOOLONG` | Path over 4096 bytes or a component over 255 bytes. |
| `EACCES` | `spawn()` of a file without execute permission (`<cmd>: Permission denied`). |
| `ENOSYS` | A method the kernel doesn't know (`unknown method <name>`) — happens when `dist/host` and the deployed `dist/runtime` come from different versions. |
| (none) | `data must be a string or Uint8Array` from `writeFile`, `mount` and `write`. |

Errors that are not from the kernel:

| Message | Thrown by |
|---|---|
| `OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).` | `boot()` |
| `OpenVessel: runtime did not start in time` | `boot()` after `timeout` |
| `OpenVessel: OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).` | `boot()` — the runtime frame isn't isolated |
| `OpenVessel: origin <origin> is not allowed to use this runtime` | `boot()` — `openvessel-allowed-hosts` |
| `OpenVessel: the runtime must be embedded directly by the host page` | `boot()` — the runtime frame has more than one ancestor |
| `OpenVessel: service worker registration failed: <message>` | `boot()` |
| `OpenVessel: kernel failed: <message>` | `boot()` — the kernel worker failed to load; after boot, the `error` event, and every call once it is fatal |
| `OpenVessel: previewUrl was not configured` | `previewUrl()`, `createPreview()` |
| `OpenVessel: preview relay did not start` | `previewUrl()`, `createPreview()` after 20 s; the `error` event when a `server-ready` started the relay |
| `OpenVessel: the runtime frame was reloaded; the kernel is gone` | the `error` event (fatal); every call afterwards |
| `OpenVessel: the instance was torn down` | every call waiting at, or made after, `teardown()` |

## Limits and timeouts

| Value | Where |
|---|---|
| 30 000 ms | default `timeout` of `boot()` |
| 20 000 ms | preview relay start (fixed) |
| 10 000 ms | after a non-fatal kernel error, the kernel must answer within this time or the error becomes fatal |
| 5 minutes | a permission request without an answer is denied |
| 2 000 000 / 1 000 000 characters | `Process.collected` is cut to the last 1 000 000 characters past 2 000 000 |
| 15 000 ms | the runtime and preview service workers wait this long for a kernel connection before failing a request |
| 80 × 24 | terminal size when `terminal.cols`/`rows` are missing |

## Stability

From 1.0.0 the host API (`dist/host` and its declarations) and the three-origin embedding requirements
follow semantic versioning ([CHANGELOG](../../CHANGELOG.md)). Not covered: `src/` internals, the files
inside `dist/runtime` and `dist/preview`, the messages between the parts ([Protocol](protocol.md)), and
the contents of the compat packages. `VesselProcess` remains as a deprecated alias of `Process`.
