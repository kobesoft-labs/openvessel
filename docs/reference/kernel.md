# Kernel

[日本語](kernel.ja.md)

The kernel is the "operating system" of OpenVessel: one Web Worker that owns the file system, the
process table, pipes, terminals, sockets, virtual ports and the way out to the network. This page
describes its parts, its threading model, the complete system call table, virtual networking, the
outbound HTTP bridge, the ES module service, the builtin programs and what exists when it starts.

The file system and processes have their own pages: [File system](filesystem.md) and
[Processes](processes.md). For a gentler overview see [How OpenVessel works](../how-it-works.md).

## Responsibilities

| Area | What the kernel does | Source |
|---|---|---|
| File system | In-memory VFS with inodes, permissions, timestamps, symlinks, hard links, FIFOs, sockets and change events | `src/kernel/vfs.ts` |
| Processes | pids, process groups, argv/env/cwd, file descriptors, exit status, signals, `execve` | `src/kernel/kernel.ts`, `src/kernel/proc.ts` |
| I/O | Open file descriptions, pipes, socketpairs, the TTY line discipline | `src/kernel/io.ts` |
| System calls | Synchronous calls from node threads and their asynchronous messages | `src/kernel/syscalls.ts` |
| Virtual networking | TCP ports, Unix domain sockets, UDP ports, HTTP/WebSocket from the preview | `src/kernel/net.ts`, `src/kernel/tcp.ts` |
| Way out | HTTP/1.1 over raw sockets to outside hosts, through the network policy | `src/kernel/outbound.ts` |
| ES modules | Serves VFS files as browser ES modules to process workers | `src/kernel/esm.ts` |
| Programs | `sh`, coreutils, `npm`/`pnpm`/`yarn`/`bun`, `curl`/`wget`, run inside the kernel | `src/kernel/sh/`, `src/kernel/coreutils.ts`, `src/kernel/npm/`, `src/kernel/curl.ts` |
| Host channel | The API the embedding page uses (see [Host API](host-api.md) and [Protocol](protocol.md)) | `src/kernel/index.ts` |
| Network policy | Decides whether a request may leave (see [Network policy](network-policy.md)) | `src/kernel/index.ts`, `src/shared/policy.ts` |

`src/kernel/base.ts` holds one constant, `RUNTIME_BASE`: the URL of the directory the kernel script was
loaded from, without a trailing slash. The runtime's service worker answers `/__ov/…` under it.

## Threading model

### Workers

| Worker | Created by | Name | Runs |
|---|---|---|---|
| Kernel | the runtime iframe (`src/runtime/runtime.ts`) | `openvessel-kernel` | `dist/runtime/kernel.js`: the VFS, the process table, every builtin program (`sh`, coreutils, `npm`, …) |
| Process main thread | the kernel | `node:<pid>:<tid>` (or `node (idle)` when it came from the warm pool) | a Node.js runtime for one `node` process |
| Worker thread | the kernel, on request of a process (`worker_threads`) | as for the main thread | another Node.js runtime in the same process (same pid, same fd table) |

Builtin programs are not workers: they are `async` functions that run on the kernel's own event loop
(started with `queueMicrotask`). A builtin that waits for input or for a child process yields to the
kernel, which keeps serving other processes in the meantime.

### Warm worker pool

Loading and compiling the runtime script is most of a process's start-up cost, so the kernel keeps
idle process workers ready (`src/kernel/index.ts`):

- `WARM = 2` idle workers per runtime script URL.
- The pool for a URL is created on the first process start that uses that URL, and topped up again
  (`setTimeout(…, 0)`) every time a worker is taken.
- An idle worker does nothing until it receives its `init` message. If the pool is empty a new
  worker is created on the spot.
- Worker threads are taken from the same pool as main threads (the pool of their process's runtime).

### Choosing the Node.js runtime

The build contains two Node.js runtimes:

| Runtime | Script | Source | Used when |
|---|---|---|---|
| The ported runtime | `dist/runtime/node-process.js` | `src/nodejs/` (Node's own `lib/` with `internalBinding()` in TypeScript) | by default |
| The legacy runtime | `dist/runtime/process.js` | `src/node/` (a hand-written Node-compatible layer) | the VFS file `/etc/openvessel/node` contains `legacy` |

The kernel reads `/etc/openvessel/node` (trimmed) every time a node program starts — a new process
or an `execve` — and records the choice in the process; the process's worker threads always get the
same runtime as its main thread, even when the file changes while it runs. Any other content
(including `port`, which selected the ported runtime before it became the default), or a missing file,
selects the ported runtime. The published compatibility numbers ([compatibility](../compatibility.md))
refer to the ported runtime.

```ts
// select the legacy runtime for every node process started from now on
await vessel.mount({ node: 'legacy' }, { path: '/etc/openvessel' });
```

```sh
mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node
```

### Synchronous system calls

A node thread calls the kernel synchronously over a `SharedArrayBuffer` channel
(`src/shared/syncchan.ts`):

1. The thread writes the request (UTF-8 JSON followed by an optional binary payload) into the buffer,
   sets the state word to 1 and posts `{ t: 'sys' }` to the kernel.
2. It sleeps in `Atomics.wait` until the state word changes.
3. The kernel decodes the request, runs the system call, writes the response, sets the state word to
   2 and calls `Atomics.notify`.

| Constant | Value |
|---|---|
| Channel size per thread | 4 MiB (`DEFAULT_CHANNEL_BYTES`) |
| Header | 64 bytes: state, JSON length, binary length, bytes this round, flags (`1` = more chunks follow) |
| Larger messages | split into several rounds in both directions |
| Calls in flight per thread | one |

Request: `{ op, ...args }` plus optional bytes. Response: `{ ok: value }`, `{ ok: value, bin: true }`
plus bytes, or `{ err: code, msg: message }`. A system call may finish asynchronously (a read from a
pipe, `spawnSync`); the calling thread stays blocked while the kernel goes on serving everybody else.

### Asynchronous messages

Besides system calls, threads and the kernel exchange `postMessage` messages.

Kernel → process thread:

| Message | Fields | Meaning |
|---|---|---|
| `init` | `kind` (`main`/`thread`), `pid`, `ppid`, `tid`, `argv`, `env`, `cwd`, `sab`, `ttys`, `hostname`, thread fields | Start the runtime (see [Processes](processes.md#starting-node-processes)) |
| `signal` | `sig` | A signal the process installed a handler for, or `SIGWINCH` |
| `child-exit` | `pid`, `code`, `signal` | A child started with `spawn` has exited (sent to the thread that spawned it) |
| `fd-data` | `fd` or `id`, `data` (`null` = EOF), `handle?`, `err?` | Data for `readStart`/`readOnce` |
| `fd-writable` | `fd` | The pipe/socket buffer has drained (answer to `writeWait`) |
| `watch` | `id`, `type`, `path` | A file system change under a watched path |
| `ping` | `id` | "Have you handled everything sent before?" (answered with `pong`) |
| `tcp-accept` | `port`, `fd`, `remoteAddress`, `remotePort` | A new TCP connection on a listening port |
| `pipe-accept` | `port`, `fd`, `remoteAddress`, `remotePort` | A new connection on a Unix domain socket |
| `tls-peer` | `fd`, `certs` | The other end's TLS certificates (process-to-process TLS) |
| `udp-msg` | `port`, `data`, `from` | A datagram |
| `thread-exit` | `tid`, `code`, `initFailed?`, `terminated?` | A worker thread ended (sent to its parent thread) |
| `thread-gone` | `tid` | A watched thread no longer exists |
| `http-req`, `http-body`, `http-body-end`, `http-abort`, `ws-msg`, `ws-close` | `rid`, … | A request for an HTTP server of the legacy runtime |
| `loop-res`, `loop-res-data`, `loop-res-end`, `loop-res-error` | `crid`, … | The response to a loopback request of the legacy runtime |

Process thread → kernel:

| Message | Meaning |
|---|---|
| `sys` | A system call is waiting in the channel |
| `pong` | Answer to `ping` |
| `readStart` / `readStop` | Start/stop pushing `fd-data` for an fd. Pipes and sockets are read only when data is there, so a `readStop` never loses data |
| `readOnce` | Read once (up to `len`, default 65536) and answer with `fd-data` carrying `id` |
| `writeWait` | Send `fd-writable` once the buffer of this pipe/socket is empty or nobody reads it |
| `threadSpawn` / `threadKill` | Start/terminate a worker thread |
| `loop-req`, `loop-body`, `loop-body-end`, `loop-abort` | Legacy runtime: HTTP request to a virtual port |
| `http-res`, `http-res-data`, `http-res-end`, `http-res-error`, `ws-open`, `ws-send`, `ws-close` | Legacy runtime: a server's response |

## System calls

All calls are dispatched by `kernel.syscall` in `src/kernel/syscalls.ts`. Paths are resolved against
the process's working directory and normalized lexically (`..` is removed before the lookup). An
unknown name fails with `ENOSYS` (`unknown syscall <op>`). Which runtime uses each call is shown in
the last column (P = ported, L = legacy).

### Files

| Syscall | Arguments | Result | Errors | Notes | Used by |
|---|---|---|---|---|---|
| `stat` | `p`, `l` (lstat) | stat object | `ENOENT`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG` | Also answers `/proc/self`, `/proc/<pid>`, `/proc/<pid>/fd` and `/proc/self/fd/N` of the caller ([special files](filesystem.md#special-files)) | P, L |
| `fstat` | `fd` | stat object | `EBADF` | fds without an inode get a synthetic stat (tty `S_IFCHR\|0620`, pipe `S_IFIFO\|0600`, socket `S_IFSOCK\|0600`) | P, L |
| `fdKind` | `fd` | `file`, `dir`, `pipe`, `tty`, `null`, `socket` or `null` | — | | P |
| `access` | `p`, `mode` | `null` | lookup errors, `EACCES` | `R_OK`, `W_OK`, `X_OK` against the permission bits ([permissions](filesystem.md#ownership-and-permissions)) | P, L |
| `open` | `p`, `flags` (0), `mode` (0o666) | fd (lowest free ≥ 3) | `ENOENT`, `ENOTDIR`, `EEXIST`, `EISDIR`, `EACCES`, `ENXIO`, `ELOOP`, `ENAMETOOLONG`, `EMFILE` | `EACCES` when the file lacks the read/write permission the flags ask for, or when `O_CREAT` creates in a directory without write+search permission; a new file's mode is masked with the umask; `ELOOP` for `O_NOFOLLOW` on a symlink; `EMFILE` at `RLIMIT_NOFILE` | P, L |
| `close` | `fd` | `null` | `EBADF` | Also stops a kernel reader started on the fd | P, L |
| `read` | `fd`, `len` (65536, at most 16 MiB), `pos` | bytes | `EBADF`, `EISDIR` | Pipes, ttys and sockets block until data or EOF | P, L |
| `write` | `fd`, `pos`, `nonblock`, `sendHandle` + bytes | bytes written | `EBADF`, `EISDIR`, `EPIPE`, `EINVAL` | `nonblock` on a pipe/socket writes only what fits (0 = full). `sendHandle` attaches a handle to the first byte (sockets only) | P, L |
| `lseek` | `fd`, `offset`, `whence` (0/1/2) | new offset | `ESPIPE`, `EINVAL`, `EBADF` | Regular files only; seeking past the end is allowed | L (WASI) |
| `readFile` | `p` | bytes | `ENOENT`, `EISDIR`, `EACCES`, … | A character device returns one read of at most 64 KiB; `/proc/self/fd/N` reads that fd to EOF | P, L |
| `writeFile` | `p`, `flags` (0o1101), `mode` (0o666) + bytes | `null` | `EEXIST`, `EISDIR`, `ENOENT`, `ENOTDIR`, `EACCES` | `O_APPEND` goes through `open`; a new file's mode is masked with the umask | P, L |
| `readdir` | `p`, `types` | names, or `[name, S_IF* type]` pairs | `ENOENT`, `ENOTDIR`, `EACCES` | Creation order, no `.`/`..` | P, L |
| `mkdir` | `p`, `mode` (0o777), `recursive` | `recursive`: first directory created or `null` | `EEXIST`, `ENOENT`, `ENOTDIR`, `EACCES` | mode masked with the umask | P, L |
| `mkdtemp` | `prefix` | the new path | `EACCES`, `ENOENT`, `EEXIST` | 6 random characters `[A-Za-z0-9]`, mode 0o700 masked with the umask, up to 100 attempts | P, L |
| `rmdir` | `p` | `null` | `ENOENT`, `ENOTDIR`, `ENOTEMPTY`, `EACCES`, `EBUSY` | `EBUSY` for `/` | P, L |
| `rm` | `p`, `recursive`, `force` | `null` | `ENOENT`, `ERR_FS_EISDIR` | No permission check | L |
| `unlink` | `p` | `null` | `ENOENT`, `EISDIR`, `EACCES` | | P, L |
| `rename` | `from`, `to` | `null` | `ENOENT`, `EINVAL`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EACCES` | | P, L |
| `link` | `from`, `to` | `null` | `EPERM`, `EEXIST`, `ENOENT`, `EACCES` | Hard link | P, L |
| `symlink` | `target`, `p` | `null` | `EEXIST`, `ENOENT`, `EACCES` | Target stored as given | P, L |
| `readlink` | `p` | string | `EINVAL`, `ENOENT` | `/proc/self` → pid; `/proc/self/fd/N` → path, `/dev/tty`, `pipe:[id]` or `socket:[id]` | P, L |
| `realpath` | `p` | string | `ENOENT`, `ENOTDIR`, `ELOOP` | | P, L |
| `chmod` | `p`, `mode` | `null` | lookup errors | Follows symlinks | P, L |
| `fchmod` | `fd`, `mode` | `null` | `EBADF` | No effect on fds without an inode | P, L |
| `utimes` | `p`, `atime`, `mtime` (ms), `l` | `null` | lookup errors | Follows symlinks; with `l` (`lutimes`) sets the link's own times | P, L |
| `futimes` | `fd`, `atime`, `mtime` (ms) | `null` | `EBADF` | | P, L |
| `truncate` | `p`, `len` (0) | `null` | `EISDIR`, `EACCES`, lookup errors | Non-regular files are left alone | L |
| `ftruncate` | `fd`, `len` (0) | `null` | `EBADF`, `EINVAL` | `EINVAL` also for an fd not open for writing | P, L |
| `copyFile` | `from`, `to`, `excl` | `null` | `EISDIR`, `EEXIST`, `ENOENT`, `EACCES` | Copies the mode bits | P, L |
| `cp` | `from`, `to`, `force`, `errorOnExist`, `dereference` | `null` | `EEXIST`, `EISDIR` | Recursive; creates the destination's parent directories | L |
| `watch` | `id`, `p`, `recursive` | `null` | — | Events are posted as `watch` messages ([watchers](filesystem.md#watchers)) | P, L |
| `unwatch` | `id` | `null` | — | | P, L |

### Modules

| Syscall | Arguments | Result | Used by |
|---|---|---|---|
| `resolve` | `kind` (`esm`/`cjs`), `spec`, `from`, `conditions`, `exts`, `paths` | resolved path or resolution record | L |
| `moduleFormat` | `p` | `module`, `commonjs`, `json`, `wasm`, `addon`, `module-typescript`, `commonjs-typescript` or `null` | L |
| `esmRegister` | `id`, `source` | `null`: the source is served at `/__ov/mw/<pid>/<id>.mjs` until the process exits | P |

Resolution conditions: `import`, `node`, `module-sync`, `default` for ESM and `require`, `node`,
`module-sync`, `default` for CommonJS, plus any `conditions` passed (`--conditions`).

### Processes and threads

| Syscall | Arguments | Result | Errors | Notes | Used by |
|---|---|---|---|---|---|
| `getcwd` | — | the working directory | — | | P |
| `chdir` | `p` | the real path (symlinks resolved) | `ENOENT`, `ENOTDIR`, `EACCES` | `EACCES` without search permission | P, L |
| `umask` | `mask` (optional) | the previous mask | — | Stores `mask & 0o777`; children inherit it | P |
| `exit` | `code` | `null` | — | Status `code & 0xff`. See [exit](processes.md#exit) | P, L |
| `execve` | `argv`, `env`, `argv0` | no reply on success | `ENOENT`, `EACCES`, `ELOOP` | Checked before anything changes | P |
| `kill` | `pid`, `sig` | `null` | `EINVAL`, `ESRCH` | `pid` 0 = the caller's process group, -1 = every process but the caller, other negative = a process group; `sig` 0 = existence check. See [kill](processes.md#kill) | P, L |
| `sigaction` | `sig`, `on` | `null` | — | Marks a signal as handled by the process | P, L |
| `spawn` | `argv`, `argv0`, `env`, `cwd`, `stdio`, `keepStdioOnError` | `{ pid, fds, error? }` | `ENOENT`, `EACCES`, `ELOOP`, `EINVAL` | `fds`: the parent's ends of the pipes | P, L |
| `spawnSync` | `argv`, `argv0`, `env`, `cwd`, `stdio`, `timeout`, `killSignal` + stdin bytes | `{ pid, status, signal, outLen, error? }` + stdout and stderr bytes | as `spawn` | `error: 'ETIMEDOUT'` after the timeout | P, L |
| `threadReserve` | `nodeId` | a tid, or `{ tid, threadId }` | — | tids from 100000; `threadId` counts 1, 2, … per process | P, L |
| `watchThread` | `tid` | `null` | — | `thread-gone` when that thread ends (at once if it already has) | P |
| `threadExit` | `code` | `null` | — | Ends the calling worker thread; the parent gets `thread-exit` | P, L |

### Terminals

| Syscall | Arguments | Result | Errors | Used by |
|---|---|---|---|---|
| `isatty` | `fd` | `true` when the fd is a TTY | — | L |
| `ttySize` | `fd` | `{ cols, rows }` or `null` | — | P, L |
| `setRawMode` | `fd`, `raw` | `null` | `ENOTTY` | P, L |

### Network

| Syscall | Arguments | Result | Errors | Notes | Used by |
|---|---|---|---|---|---|
| `listen` | `port` (0 = pick), `host`, `kind` | the port | `EADDRINUSE` | `kind`: `raw` (byte streams), `http` (legacy HTTP server), anything else = TCP-only | P, L |
| `unlisten` | `port` | `null` | — | | P, L |
| `listenShare` | `port` | `null` | `EINVAL` | Accept on a listening socket received from another process | P |
| `tcpConnect` | `port`, `host` | `{ fd, self, localAddress, localPort }` | `ECONNREFUSED`, `EMFILE` | Only to `raw` listeners. `self`: the caller's own thread accepts it. `localAddress` / `localPort`: the connecting socket's loopback address (`::1` when `host` is IPv6, else `127.0.0.1`) and ephemeral port ([connections](#connections)) | P |
| `tcpConnectOut` | `host`, `port`, `tls` | fd | — | A connection to an outside host ([outbound](#outbound-connections)) | P |
| `tcpSetTls` | `fd`, `servername` | `true` if it is an outbound connection | — | | P |
| `tlsHello` | `fd`, `certs` | `{ wait, certs }` | — | Exchanges certificates between two processes | P |
| `shutdown` | `fd` | `null` | `EBADF`, `ENOTSOCK` | Half-close: the peer reads EOF | P |
| `unixListen` | `p` | the socket's inode number | `EADDRINUSE`, `ENOENT`, `ENOTDIR` | Creates the socket file | P |
| `unixUnlisten` | `ino` | `null` | — | Removes the socket file if it is still the same inode | P |
| `unixConnect` | `p` | fd | `ECONNREFUSED`, `ENOENT`, `EMFILE` | | P |
| `portInfo` | `port` | whether anything listens there | — | | L |
| `udpBind` | `port`, `address`, `reuse` | the port | `EADDRINUSE` | | P |
| `udpJoin` | `port` | `null` | `EINVAL` | Join a bound port (a shared socket) | P |
| `udpRecv` | `port`, `on` | `null` | — | Start/stop receiving | P |
| `udpClose` | `port` | `null` | — | | P |
| `udpSend` | `port`, `from`, `fromAddress` + bytes | `null` | — | Lost when nobody is bound | P |

## Errors and errno values

Errors cross the channel as a code string and a message. The ported runtime turns them into libuv
errors (`UVException`, negative `UV_*` numbers); the legacy runtime builds Node-style errors with
`errno` = minus the Linux number. Codes that don't start with `E` (`ERR_FS_EISDIR`) stay plain `Error`s
with that `code`. Any other exception inside the kernel is reported with its own `code`, or `EIO`.

| Code | Number | Message |
|---|---|---|
| `EPERM` | 1 | operation not permitted |
| `ENOENT` | 2 | no such file or directory |
| `ESRCH` | 3 | no such process |
| `EINTR` | 4 | eintr |
| `EIO` | 5 | eio |
| `ENXIO` | 6 | enxio |
| `E2BIG` | 7 | e2big |
| `ENOEXEC` | 8 | exec format error |
| `EBADF` | 9 | bad file descriptor |
| `ECHILD` | 10 | no child processes |
| `EAGAIN` | 11 | resource temporarily unavailable |
| `ENOMEM` | 12 | enomem |
| `EACCES` | 13 | permission denied |
| `EFAULT` | 14 | efault |
| `EBUSY` | 16 | resource busy or locked |
| `EEXIST` | 17 | file already exists |
| `EXDEV` | 18 | cross-device link not permitted |
| `ENODEV` | 19 | enodev |
| `ENOTDIR` | 20 | not a directory |
| `EISDIR` | 21 | illegal operation on a directory |
| `EINVAL` | 22 | invalid argument |
| `ENFILE` | 23 | enfile |
| `EMFILE` | 24 | too many open files |
| `ENOTTY` | 25 | inappropriate ioctl for device |
| `EFBIG` | 27 | efbig |
| `ENOSPC` | 28 | no space left on device |
| `ESPIPE` | 29 | invalid seek |
| `EROFS` | 30 | read-only file system |
| `EMLINK` | 31 | emlink |
| `EPIPE` | 32 | broken pipe |
| `ERANGE` | 34 | erange |
| `ENAMETOOLONG` | 36 | name too long |
| `ENOSYS` | 38 | function not implemented |
| `ENOTEMPTY` | 39 | directory not empty |
| `ELOOP` | 40 | too many symbolic links encountered |
| `ENOTSOCK` | 88 | socket operation on non-socket |
| `ENOTSUP` | 95 | operation not supported on socket |
| `EADDRINUSE` | 98 | address already in use |
| `EADDRNOTAVAIL` | 99 | eaddrnotavail |
| `ENETUNREACH` | 101 | enetunreach |
| `ECONNRESET` | 104 | connection reset by peer |
| `ENOTCONN` | 107 | socket is not connected |
| `ETIMEDOUT` | 110 | connection timed out |
| `ECONNREFUSED` | 111 | connection refused |
| `EHOSTUNREACH` | 113 | ehostunreach |
| `ECANCELED` | 125 | ecanceled |

The table is `src/shared/errno.ts`; codes without a message use the lower-cased code. The kernel
also sets its own messages for some errors: `<cmd>: command not found` (`ENOENT`),
`<cmd>: Permission denied` (`EACCES`), `<name>: builtin missing` (`ENOENT`),
`spawn: cwd <path> does not exist` (`ENOENT`) and
`Path is a directory: rm returned EISDIR (is a directory) <path>` (`ERR_FS_EISDIR`).

## Virtual networking

Nothing is opened on the user's machine. Ports are entries in kernel tables, and a connection is a
pair of connected kernel sockets.

### TCP ports

- One port namespace for the whole kernel. The listening address is recorded but is not part of the
  key: listening on `127.0.0.1:3000` and `::1:3000` conflicts (`EADDRINUSE`), and a connection to
  any loopback address reaches the listener.
- Port `0` picks a free port in 49152–65151 (`49152 + random(16000)`).
- A port that is already listened on fails with `EADDRINUSE`, also for the same process.
- Listener kinds:

| Kind | Who | Connections | Shown to the host |
|---|---|---|---|
| `raw` | the ported runtime (`net`, `http`, …) | byte streams over socketpairs | yes (`server-ready`, `ports()`) |
| `http` | `http.Server` of the legacy runtime | HTTP messages (`http-req` …) | yes |
| TCP-only | `net.Server` of the legacy runtime | — (the preview gets `ECONNREFUSED`) | no |

- Starting to listen (kinds `raw` and `http`) emits `server-ready { port, pid }` to the host;
  closing, or the process exiting, emits `port-closed { port }`.
- `execve` drops the process's listeners (Node marks every fd but stdio close-on-exec).
- A listening socket sent to another process (`child.send(msg, server)`) is shared: the receiving
  process calls `listenShare`, and connections are handed out round-robin among the running owners.
  When the owner exits, the next acceptor takes over the port.

### Connections

`tcpConnect` creates a socketpair: the listener's process gets one end as a new fd (lowest free ≥ 3)
and a `tcp-accept` message; the caller gets the other end. Each socketpair direction buffers up to
212992 bytes for non-blocking writers (see [pipes](processes.md#pipes)). A listener's process that has
no descriptor left (`EMFILE`) can't accept: the connection is refused.

The connecting side gets an ephemeral port from Linux's default range 32768–60999: the next one after
the last given (starting at a random place), skipping ports that are listened on or held by another
open connection. It is free again once the connecting end is closed. Address details:

| Connection from | `remoteAddress` / `remotePort` seen by the server |
|---|---|
| a process (`tcpConnect`) | `127.0.0.1` (`::1` when it connected to an IPv6 address) / its ephemeral port, which is its `localPort` |
| the preview or a legacy-runtime HTTP request | `127.0.0.1` / an ephemeral port |
| a Unix domain socket | `''` / `0` |

### HTTP from the preview

The preview iframe's requests reach the kernel as HTTP messages (see [Preview](preview.md)). For a
`raw` listener the kernel (`src/kernel/tcp.ts`) opens a connection and speaks HTTP/1.1 on it:

- Request headers `connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `sec-websocket-key` and
  `sec-websocket-version` are removed. `Host: localhost:<port>` is added when missing.
- A normal request gets `Connection: close`; a request with a body and no `Content-Length` is sent
  with `Transfer-Encoding: chunked`.
- A WebSocket request gets `Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Version: 13`
  and a random `Sec-WebSocket-Key`.
- The response is parsed: `1xx` responses other than `101` are skipped; the body is delimited by
  `Content-Length`, chunked encoding (trailers are read and dropped) or the end of the connection;
  `204` and `304` have no body. `transfer-encoding`, `connection` and `keep-alive` are removed from
  the response headers.
- Errors: no response head before the connection closed → `socket hang up`; a body cut short →
  `incomplete response`; nobody listening → `connect ECONNREFUSED 127.0.0.1:<port>`.
- After `101 Switching Protocols` the connection carries WebSocket frames: text and binary messages
  are passed on, a ping is answered with a pong, a close frame ends it (code 1005 when it has none),
  and the connection ending without one reports code 1006.

For a legacy `http` listener the request is posted to the listening thread as `http-req` messages; if
the process exits first the request fails with `server process exited`.

### Unix domain sockets

- `listen(path)` creates a socket file (`S_IFSOCK`, mode 0o755) at the path; `EADDRINUSE` if the name
  exists.
- Listeners are keyed by the socket's inode, so the file can be renamed; connecting through a symlink
  works.
- `connect(path)` fails with `ECONNREFUSED` when the file is not a socket or nobody listens on it.
- Closing the server removes the socket file if it still is the same inode. A process's Unix
  listeners go away when it exits or calls `execve`.

### UDP

- A separate port namespace (UDP ports don't clash with TCP ports).
- Bind port `0` picks a free port in 49152–65151; binding a port in use fails with `EADDRINUSE`
  unless `reuseAddr` is set, in which case the processes share it.
- Datagrams are routed by port only. A datagram to a port nobody bound is lost; one to a bound port
  waits in a queue of at most 1024 datagrams until a member receives, and is delivered round-robin
  among the receiving members.
- The sender's address is the bound address, or `127.0.0.1` when it is unset or `0.0.0.0`.

### Loopback and stand-in addresses

The ported runtime decides what is local (`src/nodejs/bindings/net.ts`):

- Loopback for `connect`: `localhost`, `127.*`, `::1`, `0.0.0.0`, `::`, empty, `::ffff:127.0.0.1`.
  These go to virtual ports (`tcpConnect`); any other address goes out (`tcpConnectOut`).
- `dns.lookup('localhost')` and names ending in `.localhost` give `127.0.0.1` and `::1`. IP literals
  are returned as they are.
- Any other name gets a stand-in IPv4 address from `198.18.0.0/15`: `198.18.0.1`, `198.18.0.2`, … in
  the order names are first looked up (per process). Connecting to a stand-in address sends the
  original name to the kernel, so the request goes out to that host. IPv6 lookups of such names
  find nothing (`ENOTFOUND`); `resolve4`/`resolveAny` return the stand-in address.

## Outbound connections

A browser can't open sockets. A TCP connection from a process to a non-loopback address
(`tcpConnectOut`) gives the process one end of a socketpair; the kernel reads HTTP/1.1 requests from
the other end (`src/kernel/outbound.ts`), makes each one with `fetch` through the runtime service
worker's policy-checked proxy (`<RUNTIME_BASE>/__ov/net`) and writes the response back as HTTP/1.1
bytes. Libraries with their own HTTP client (undici, axios, got) therefore work unchanged.

### Request parsing

| Rule | Behaviour |
|---|---|
| First bytes | Must look like a request line (`/^[A-Z]{3,10} /`). Anything else — another protocol, a real TLS handshake — closes the connection without a response |
| Request line | `METHOD target HTTP/1.0` or `HTTP/1.1`; otherwise `400 Bad Request` and the connection closes |
| Head size | At most 1 MiB up to the blank line; beyond that the connection closes |
| Body | `Transfer-Encoding: chunked` (extensions and trailers ignored) or `Content-Length`; otherwise empty |
| Keep-alive | HTTP/1.1 unless `Connection: close`; HTTP/1.0 only with `Connection: keep-alive`. Requests on one connection are handled one after another |
| WebSocket | `Upgrade: websocket` gets `501 Not Implemented` and the connection closes |
| URL | An absolute-form target is used as is. Otherwise `http(s)://` + the `Host` header (or the target host, with `:port` unless it is 80/443) + the path |

### Forwarding and response

- Request headers `connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `upgrade`,
  `te`, `trailer`, `host` and `content-length` are not forwarded. The service worker drops more
  (see [Network policy](network-policy.md)).
- `GET` and `HEAD` are sent as they are; other methods are sent as `POST` with the real method in
  `x-ov-method`. The initiator shown in permission prompts is `<pid> <argv[0..2]>` (at most 200
  characters).
- The response is written as `HTTP/1.1 <status> <statusText>` (status text `OK` when empty).
  `content-encoding`, `content-length`, `transfer-encoding`, `connection` and `keep-alive` are
  removed — `fetch` has already decoded the body — and the body is re-framed with
  `Transfer-Encoding: chunked`. `204`, `304`, `1xx` and `HEAD` responses have no body.
- Redirects are followed by the browser.

### Errors

Errors are HTTP responses, not errno values: the connection itself was "established".

| Situation | Response |
|---|---|
| The network policy denied the host | `403 Forbidden` |
| `fetch` failed (network error, CORS) or the proxy failed | `502 Bad Gateway` |

Both carry `Content-Type: text/plain`, `Content-Length`, `Connection: close` and
`X-OpenVessel-Error: 1`, the body is the message (for example
`OpenVessel: network access to example.com was denied by the network policy`), and the connection
closes afterwards. Only HTTP/1.1 can go out: other protocols and outgoing WebSockets over raw
sockets are not supported.

### TLS pass-through

TLS is not done on the wire. When a process puts TLS on an outbound connection (`tls.connect`,
`https`), its TLS layer calls `tcpSetTls` before writing anything: the kernel marks the connection as
`https` (with the SNI `servername` as host) and the process's TLS layer passes plaintext through. The
browser's `fetch` does the real TLS and verifies the certificate. Between two processes inside
OpenVessel, both ends of a TLS connection exchange their certificates through `tlsHello` and the
bytes stay plaintext as well. See [compatibility](../compatibility.md) for what this means for
`tls` APIs.

## ES module service

`src/kernel/esm.ts` serves files of the VFS as browser ES modules. The runtime service worker
forwards these URLs (under `RUNTIME_BASE`) to the kernel and returns the answer with
`Content-Type: text/javascript; charset=utf-8` and `Cache-Control: no-store`:

| URL | Answer |
|---|---|
| `/__ov/esm/<absolute path>[?query]` | the file as an ES module |
| `/__ov/builtin/<name>` | a module re-exporting a builtin (`node:fs` …) from `globalThis.__ov.builtin(name)` |
| `/__ov/esm-error?code=…&msg=…&names=…` | stands in for an import that can't be resolved: declares each of `names` once (`default` included) and throws an `Error` with `code` and `msg` when it is evaluated, so the importing module still links |
| `/__ov/mw/<pid>/<id>.mjs` | a source registered with `esmRegister` (the ported runtime's `ModuleWrap`); an unknown key gives a module that throws `ERR_INTERNAL_ASSERTION` |

The URLs written into generated modules are absolute and start with `RUNTIME_BASE`, so they keep
working when the runtime is served under a sub-path.

How a file is turned into a module, by format:

| Format | Module |
|---|---|
| `module` (`.mjs`, `"type": "module"`, or detected ES syntax) | the source with import specifiers rewritten to the URLs above, `import.meta` → `globalThis.__ov.meta(<file URL>)`, `import()` → `globalThis.__ov.dimport(…)`, import attributes removed, a `#!` line commented out, and `//# sourceURL=file://…` appended |
| `module-typescript` (`.mts`, `.ts` outside `"type": "commonjs"`) | types stripped with sucrase, then as `module` |
| `commonjs`, `commonjs-typescript` | a facade: `default` = `module.exports` from `globalThis.__ov.requireForImport(file)`, plus named exports found by cjs-module-lexer (re-exports followed up to 8 levels) |
| `json` (or `?ov-json`, set for `with { type: 'json' }`) | `export default JSON.parse(…)` |
| `addon` (`.node`) | error `ERR_DLOPEN_FAILED` |
| `wasm` | error `ERR_UNKNOWN_FILE_EXTENSION` |
| missing file / directory | `ERR_MODULE_NOT_FOUND` / `ERR_UNSUPPORTED_DIR_IMPORT` |

A module that can't be generated is answered with a module that throws an `Error` with the code
shown, so the error surfaces where the import happens. Generated modules are cached per path, keyed by the inode number,
mtime and size; the cache is cleared when it holds more than 4000 entries. Sources registered with
`esmRegister` are dropped when their process exits. The legacy runtime loads ES modules through
`/__ov/esm/`; the ported runtime registers the sources it compiles and loads them through `/__ov/mw/`.

## Builtin programs

### Registered programs

A builtin is registered under a name and installed as an executable stub file containing
`#!/ov/builtin <name>` (mode 0o755). A bare command name that matches a registered builtin runs it
even when no file is found on `PATH`.

| Directory | Programs |
|---|---|
| `/bin` | `sh`, `bash`, `dash` (one shell, see [Shell](shell.md)) |
| `/bin` | `ls`, `cat`, `mkdir`, `mkfifo`, `rm`, `rmdir`, `cp`, `mv`, `touch`, `ln`, `chmod`, `head`, `tail`, `wc`, `grep`, `egrep`, `fgrep`, `find`, `sort`, `uniq`, `cut`, `tr`, `sed`, `xargs`, `tee`, `env`, `which`, `basename`, `dirname`, `realpath`, `readlink`, `stat`, `du`, `df`, `free`, `date`, `sleep`, `uname`, `ps`, `kill`, `seq`, `yes`, `mktemp`, `base64`, `diff`, `clear`, `nproc`, `id`, `hostname`, `whoami`, `tty`, `stty`, `nohup`, `nice`, `less`, `more`, `file`, `rev`, `nl`, `timeout`, `time`, `truncate`, `sha256sum`, `sha1sum`, `sha512sum`, `md5sum`, `echo`, `printf`, `test`, `[`, `true`, `false`, `pwd`, `chown` (does nothing), `sync` (does nothing) |
| `/usr/bin` | `env` (a second stub, for `#!/usr/bin/env` lines) |
| `/usr/bin` | `node` (`#!/ov/builtin node`: starts a node process) and `nodejs` (a symlink to `/usr/bin/node`) |
| `/usr/bin` | `npm`, `pnpm`, `yarn`, `bun`, `npx`, `pnpx`, `bunx`, `corepack` (see [Package managers](package-managers.md)) |
| `/usr/bin` | `curl`, `wget` |

### curl and wget

`curl` and `wget` fetch through the same policy-checked proxy as `npm`. Supported `curl` options:

| Option | Effect |
|---|---|
| `-X`, `--request <method>` | Request method (default `GET`) |
| `-o`, `--output <file>` | Write the body to a file |
| `-O`, `--remote-name` | Write to the URL's last path segment (`index.html` when empty) |
| `-H`, `--header '<name>: <value>'` | Add a request header |
| `-d`, `--data`, `--data-raw`, `--data-binary <data>` | Request body; switches `GET` to `POST` |
| `-I`, `--head` | `HEAD` request; print the status line and headers only |
| `-i`, `--include` | Print the status line and headers before the body |
| `-f`, `--fail` | Exit 22 with `curl: (22) The requested URL returned error: <status>` for status ≥ 400 |
| `-s`, `--silent`, and combined short flags of `sSLfk` | Accepted (`f` in a combination means `--fail`) |
| `-L`, `--location`, `-k`, `--insecure`, `--compressed` | Accepted; redirects are always followed |

A URL without a scheme gets `http://`. Exit codes: 0 success, 2 no URL (`curl: no URL specified!`),
7 request failed (`curl: (7) <message>`, including a policy denial), 22 with `--fail`.
`wget <url>` saves to the URL's last path segment (`index.html` when empty); `wget -O <file> <url>`
saves to `<file>`, and `-O -` writes to stdout. It behaves like `curl -fsSL`.

## Initial file system

What the kernel creates when it starts (`src/kernel/kernel.ts`, `src/kernel/index.ts`,
`src/kernel/coreutils.ts`, `src/kernel/npm/cli.ts`, `src/kernel/curl.ts`):

| Path | Type | Content / mode |
|---|---|---|
| `/bin`, `/usr/bin`, `/usr/local/bin`, `/usr/lib/node_modules`, `/usr/local/lib`, `/home/user`, `/etc`, `/dev`, `/proc`, `/var/tmp`, `/root`, `/opt` | directories | 0755 (with the parents `/usr`, `/usr/local`, `/usr/lib`, `/home`, `/var`) |
| `/tmp` | directory | 1777 |
| `/etc/passwd` | file | `root:x:0:0:root:/root:/bin/sh`, `user:x:1000:1000:user:/home/user:/bin/sh`, `nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin` |
| `/etc/group` | file | `root:x:0:`, `user:x:1000:`, `nogroup:x:65534:` |
| `/etc/hostname` | file | `openvessel` |
| `/etc/hosts` | file | `127.0.0.1 localhost`, `::1 localhost` |
| `/etc/os-release` | file | `NAME="OpenVessel"`, `ID=openvessel`, `PRETTY_NAME="OpenVessel"` |
| `/etc/shells` | file | `/bin/sh`, `/bin/bash` |
| `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` | character devices | 0666 |
| `/dev/fd` | directory | empty; `/dev/fd/N` is answered per process |
| `/dev/stdin`, `/dev/stdout`, `/dev/stderr` | symlinks | to `/proc/self/fd/0`, `/1`, `/2` |
| `/proc/cpuinfo` | file | one entry (`processor`, `model name : OpenVessel Virtual CPU`, `cpu MHz : 2400.000`, `cpu cores`) per `navigator.hardwareConcurrency` (4 when unknown), as many as the ported runtime's `os.cpus()` |
| `/proc/meminfo` | file | `MemTotal: 8388608 kB`, `MemFree: 4194304 kB`, `MemAvailable: 4194304 kB` (the ported runtime's `os.totalmem()` and `os.freemem()`) |
| `/proc/version` | file | `Linux version 6.8.0-openvessel (user@openvessel) #1 SMP OpenVessel` (the ported runtime's `os.release()` and `os.version()`) |
| `/bin/*`, `/usr/bin/*` | executable stubs | see [registered programs](#registered-programs) |
| `/usr/bin/nodejs` | symlink | to `/usr/bin/node` |
| `/home/user/.shrc` | file | `alias ll='ls -l'`, `alias la='ls -la'` |

Regular files are created with mode 0644. `/etc/openvessel/node` does not exist at start (the ported
runtime is used). Files the host mounts go to `/home/user/app` by default (see [Host API](host-api.md)).
The host name is `openvessel`.

## Default environment

`kernel.defaultEnv()` is the environment of processes the host starts (merged with the `env` the host
passes) and of processes started without a parent:

| Variable | Value |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/home/user` |
| `USER` | `user` |
| `LOGNAME` | `user` |
| `SHELL` | `/bin/sh` |
| `TERM` | `xterm-256color` |
| `LANG` | `en_US.UTF-8` |
| `TMPDIR` | `/tmp` |
| `HOSTNAME` | `openvessel` |
| `NAPI_RS_FORCE_WASI` | `true` (napi-rs packages load their WebAssembly build) |

A child process inherits a copy of its parent's environment unless the caller passes one. The shell
adds variables of its own (`PWD` and others, see [Shell](shell.md)).
