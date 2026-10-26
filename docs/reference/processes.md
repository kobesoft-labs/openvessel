# Processes

[日本語](processes.ja.md)

This page specifies processes in the OpenVessel kernel: their life cycle, how programs are found and
started, file descriptors and stdio, pipes and sockets, signals, process groups and the terminal
(TTY). The sources are `src/kernel/kernel.ts`, `src/kernel/proc.ts`, `src/kernel/io.ts` and
`src/kernel/syscalls.ts`.

The kernel as a whole is described in [Kernel](kernel.md), the shell in [Shell](shell.md), and the
Node.js runtime inside a process in [Node.js runtime](nodejs-runtime.md).

## The process record

| Field | Meaning |
|---|---|
| `pid` | Process id: 1, 2, 3, … in start order for the whole kernel; never reused |
| `ppid` | Parent's pid; 0 for processes the host started, and for orphans (there is no init process: the host plays its part) |
| `pgid` | Process group ([process groups](#process-groups-and-job-control)) |
| `argv` | Arguments. For a node process `argv[0]` is `node` (see [argv0](#argv-env-and-cwd)) |
| `env` | Environment (a plain object of strings) |
| `cwd` | Working directory (a real path after `chdir`) |
| `umask` | File mode creation mask: 0o022 for processes the host starts, otherwise inherited from the parent ([modes and umask](filesystem.md#modes-and-umask)) |
| `nofile` | `RLIMIT_NOFILE`: 1024, inherited from the parent; set with the shell's `ulimit -n` |
| `runtime` | Node processes: the Node.js runtime chosen when the program started ([starting node processes](#starting-node-processes)) |
| `fds` | File descriptor table |
| `tty` | Controlling terminal, inherited from the parent |
| `kind` | `builtin` (runs in the kernel) or `node` (runs in workers) |
| `title` | `node`, or the builtin's name |
| `state`, `status` | `running` or `exited`; exit status `{ code, signal }` |
| `children` | pids of child processes |
| `handledSignals` | Signals the process installed handlers for |
| `threads` | Node threads (main thread and worker threads) of a node process |

The host's `ps()` and the `ps` program list running processes only (`PID`, `PPID` and `argv`).

## Life cycle

### Spawning

`kernel.spawn()` does the following, synchronously:

1. Takes the environment (the given one, else a copy of the parent's, else the
   [default environment](kernel.md#default-environment)) and the working directory (the given one,
   else the parent's, else `/home/user`).
2. Finds out how to run `argv` ([finding programs](#finding-programs)). Errors are thrown here, before
   a pid is taken: `ENOENT` (`<cmd>: command not found`), `EACCES` (`<cmd>: Permission denied`),
   `ELOOP` (interpreter chain too deep), `EINVAL` (empty `argv`).
3. Takes the next pid, sets the process group, the controlling TTY, `nofile` and `umask`, and installs
   the given stdio descriptors as fds 0, 1, 2, … (each gets a new reference).
4. Starts the program: a builtin runs on the kernel's event loop; a node program gets a worker
   ([starting node processes](#starting-node-processes)).

The `spawn` system call additionally checks that a given `cwd` exists and is a directory
(`ENOENT`, `spawn: cwd <path> does not exist`). The host's `spawn` uses `/home/user` when no `cwd` is
given and creates the directory if it is missing.

### argv, env and cwd

- A node program started directly (`node app.js`, or a path whose file is `#!/ov/builtin node`)
  keeps the caller's `argv[0]` (`process.argv0`, for example `node`); `execve`/`spawn` may pass
  another one (`argv0`). Started through a script's `#!` line, `argv[0]` is `node`. The ported
  runtime reports `process.execPath` and `process.argv[0]` as `/usr/bin/node`.
- The environment is passed whole: a child doesn't merge the parent's environment with the one given.
- `chdir` resolves symlinks: the new `cwd` is a real path. It fails with `ENOENT` or `ENOTDIR`.

### Exit

A process ends in one of these ways:

| How | Status |
|---|---|
| A node process calls `exit` (`process.exit`, end of the event loop) | `code & 0xff` (`process.exit(300)` gives 44) |
| A builtin program returns or calls `ctx.exit(n)` | `n` |
| A builtin program throws | prints `<name>: <message>` to stderr, status 1 |
| A builtin program writes to a pipe nobody reads (`EPIPE`) | 141 |
| A signal terminates it | `{ code: null, signal }` |
| A node process's main worker fails (`onerror`) | 1 |
| `process.abort()` (ported runtime) | 134 |

When a node process calls `exit`, the kernel lets readers catch up before tearing it down: if the
process wrote to pipes that other processes are still reading, the kernel waits until they are
drained (up to 250 ms); if other processes are reading sockets this process writes to, the kernel
sends them a `ping` and waits for their `pong` (up to 250 ms). The exiting thread never runs again.

Then, in this order: all worker threads are terminated, all fds are closed (pipe readers see EOF),
waiters are told, the process's TCP listeners and Unix socket listeners are released (`port-closed`
reaches the host), its watches and UDP ports go away, and its children are re-parented to pid 0 (they
are no longer its children).

The exit status as a number (what `$?` and the host's `exit` event show) is the code, or
`128 + signal number` for a signal (`143` for `SIGTERM`, `130` for `SIGINT`, `158` for `SIGPWR`).

The record of an exited process stays in the process table for 60 seconds; then it is dropped (also
when it had children: they were re-parented when it exited). There is no `waitpid`: a parent that started a
child with the `spawn` system call gets a `child-exit` message (`pid`, `code`, `signal`) on the thread that spawned it, and
signalling an exited process fails with `ESRCH`.

### execve

`execve(argv, env, argv0)` (Node's `process.execve`, ported runtime) replaces the program of a
process:

- The new program is looked up first; `ENOENT`, `EACCES` or `ELOOP` leave the process untouched.
- Every fd above 2 is closed, watches are removed, the old program's threads are terminated, the set
  of handled signals is cleared, and the process's TCP and Unix listeners are released.
- The pid, ppid, process group, `cwd`, fds 0–2, controlling TTY, `nofile` and `umask` stay.
- The new image gets the given `argv` and `env`; a node program gets the runtime `/etc/openvessel/node`
  selects now.

## Finding programs

`argv[0]` is resolved like this (`kernel.planExec`):

1. **A name with a `/`** is a path, relative to `cwd`. It must exist and not be a directory.
2. **A bare name** is looked up in each `PATH` entry in order (relative entries are taken relative to
   `cwd`, and an empty entry — `PATH=/bin:`, `PATH=:/bin`, `a::b` — is `cwd` itself, as POSIX says). An
   unset `PATH` is `/bin:/usr/bin` (glibc's `execvp`). The first regular file the process may execute
   wins (symlinks are followed).
3. **Not found:** if a builtin program of that name is registered, it runs (even without a file in
   `/bin`). Otherwise `ENOENT`, `<cmd>: command not found` (the shell exits 127).
4. **Found:** the process must have execute permission on the file, otherwise `EACCES`,
   `<cmd>: Permission denied` (the shell exits 126). The kernel reads the first 256 bytes:

| First line / file | Runs as |
|---|---|
| `#!/ov/builtin node` | a node process (this is `/usr/bin/node`) |
| `#!/ov/builtin <name>` | the builtin `<name>` (`ENOENT`, `<name>: builtin missing` if not registered) |
| `#!/usr/bin/env <arg>` or `#!/bin/env <arg>` | what GNU `env` does with `<arg>` (below), then as `#!<command> [args]` with `<command>` looked up on `PATH` |
| `#!<interp> [arg]` where the base name of `<interp>` is `node`, `nodejs`, `bun` or `deno` | a node process: `node [arg] <file> <arguments…>` |
| `#!<interp> [arg]` (anything else) | `<interp> [arg] <file> <arguments…>`, resolved again from step 1 |
| no `#!`, file name ends in `.js`, `.cjs` or `.mjs` | `node <file> <arguments…>` |
| no `#!`, anything else | `sh <file> <arguments…>` (as POSIX shells do for `ENOEXEC`) |

- As on Linux, everything after the interpreter on the `#!` line (blanks around it removed) is passed
  as **one** argument: `#!/usr/bin/node --a --b` runs `node '--a --b' <file>`.
- `#!/usr/bin/env`: without `-S`, the argument is one word — a `NAME=value` assignment or the command's
  name, so `#!/usr/bin/env node --flag` looks for a program called `node --flag` and fails with
  `ENOENT`, as on Linux. With `-S` (`#!/usr/bin/env -S node --flag`) the rest is split into words with
  GNU `env -S`'s rules (blanks, `'…'` and `"…"`, backslash escapes such as `\_` for a space, `${NAME}`,
  `#` comments); leading options `-i`, `-u NAME` and `--`, then `NAME=value` words are applied to the
  program's environment, and the next word is the command.
- A chain of interpreters may hold at most 9 files (the program and 8 interpreters), otherwise
  `ELOOP`.
- An interpreter that doesn't exist (`#!/usr/bin/python3`) gives `ENOENT`.
- Package binaries in `node_modules/.bin` are symlinks to the packages' bin files, which the
  installer makes executable; they run through their `#!/usr/bin/env node` line. The `.js` rule looks
  at the name that was run, not at the symlink's target.

```sh
printf '#!/usr/bin/env node\nconsole.log(process.argv.slice(2))\n' > hello
chmod +x hello
./hello a b          # [ 'a', 'b' ]
```

## Builtin programs and node processes

| | Builtin program | Node process |
|---|---|---|
| Examples | `sh`, `ls`, `grep`, `npm`, `curl` | `node`, scripts, package binaries |
| Runs in | the kernel worker, as an `async` function | its own Web Worker(s) |
| Reaches the kernel | directly (`ProgramContext`: fds, VFS, `spawn`) | through [system calls](kernel.md#system-calls) |
| Blocking | never blocks the kernel; waits with `await` | blocks its own thread in `Atomics.wait` during a system call |
| Signals | `onSignal` hook, else terminated (see [signals](#signals)) | delivered to handlers, else terminated |
| Start cost | a microtask | a worker from the warm pool, then the Node.js bootstrap |

## Starting node processes

1. The kernel takes a worker for the runtime selected by `/etc/openvessel/node` (`legacy` → the legacy
   runtime `process.js`, anything else or missing → the ported runtime `node-process.js`, the default; read when the
   program starts and recorded in the process, whose worker threads get the same runtime). Two idle
   workers per runtime are kept loaded ([warm worker pool](kernel.md#warm-worker-pool)).
2. It creates a 4 MiB `SharedArrayBuffer` channel for the thread's system calls.
3. It posts `init`:

| Field | Value |
|---|---|
| `t` | `init` |
| `kind` | `main` (or `thread` for a worker thread) |
| `pid`, `ppid`, `tid` | ids |
| `argv`, `env`, `cwd` | the process's |
| `sab` | the system call channel |
| `ttys` | for fds 0, 1, 2: `{ cols, rows }` if it is a TTY, else `null` |
| `hostname` | `openvessel` |
| thread fields | `file`, `eval`, `evalType`, `execArgv`, `workerData`, `envData`, `port`, `name`, `threadId`, `resourceLimits`, `envRings`, `trackUnmanagedFds`, `sharedEnv` |

The runtime then boots Node.js and runs the program. Everything else — the event loop, modules, the
`process` object — is the runtime's ([Node.js runtime](nodejs-runtime.md)).

### Worker threads

`worker_threads` are more workers of the same process: same pid, same fd table, same `cwd`.

- tids for worker threads are reserved with `threadReserve` and count from 100000; Node's
  `threadId` counts 1, 2, … per process.
- A new thread is refused with `EMFILE` (`initFailed`) when
  `threads × 8 + 30 > nofile` (each Node thread holds descriptors of its own). With the default
  `nofile` of 1024 a process can have up to 125 threads; `ulimit -n` changes the limit for the
  processes the shell starts afterwards.
- `threadKill` (`worker.terminate()`) ends a thread at once (`thread-exit` with code 1,
  `terminated: true`).
- Kernel replies go to the thread that asked, so a worker thread keeps working while the main thread
  blocks in `Atomics.wait`.

## File descriptors and stdio

- Each process has its own table. Descriptors refer to shared open file descriptions with a
  reference count; a description is closed when its last reference goes.
- New descriptors (`open`, the parent's pipe ends, accepted connections, received handles) take the
  lowest free number ≥ 3. That number must be below `nofile` (`RLIMIT_NOFILE`, `ulimit -n`), otherwise
  the call fails with `EMFILE` and nothing is created; with the default of 1024 a process can open
  1021 descriptors besides 0–2.
- The child inherits only what is passed as its stdio; there is no close-on-exec flag.
- Writing to stdout/stderr (fds 0–2) of the ported runtime writes the whole buffer synchronously, as
  Node does for pipes and files on Linux.

### stdio of the spawn system call

`stdio` is a list indexed by child fd (default `['pipe', 'pipe', 'pipe']`):

| Entry | Child fd | Parent gets |
|---|---|---|
| `'pipe'`, `'overlapped'` at index 0 | the read end of a new pipe | the write end (an fd ≥ 3) |
| `'pipe'`, `'overlapped'` at index 1, 2 | the write end of a new pipe | the read end |
| `'pipe'`, `'overlapped'` at index ≥ 3 | one end of a socketpair (duplex) | the other end |
| `'ipc'` | one end of a socketpair | the other end |
| `'inherit'` | the parent's fd with the same number (none if not open) | — |
| a number `n` | the parent's fd `n` | — |
| `'ignore'`, `null`, `undefined` | `/dev/null` (read-only at 0, write-only otherwise) | — |
| anything else | no fd | — |

If the program can't be started, the child's ends are closed; with `keepStdioOnError` (used by the
ported runtime) `ENOENT`/`EACCES` is returned as `{ pid: 0, fds, error }` and the parent's ends stay
open, so its streams read EOF as with libuv. The ported runtime maps Node's options this way: `pipe`
and `overlapped` → `pipe` (or `ipc`), `inherit` → `inherit`, `{ fd }` → the number, a stream with a
handle → its fd, everything else → `ignore`.

### spawnSync

`spawnSync` blocks the calling thread until the child has exited and both output pipes have closed.

- `'pipe'` at 0 gets the given input, then EOF. At 1 and 2 the output is collected and returned;
  at ≥ 3 a pipe is created and its read end discarded.
- `'inherit'` and numbers as above; anything else (including `'ipc'`) is `/dev/null`.
- `timeout` (ms): the child is sent `killSignal` (default `SIGTERM`) and the result carries
  `error: 'ETIMEDOUT'`.
- `maxBuffer` is applied by the runtime afterwards (`ENOBUFS`).

## Pipes

`createPipe()` makes a one-way byte channel with a read end and a write end (`src/kernel/io.ts`).

| Property | Behaviour |
|---|---|
| Buffer | A list of chunks without a size limit: a blocking write always takes all bytes at once and never waits |
| Capacity | 65536 bytes — only for non-blocking writers (`write` with `nonblock`): they write what fits and get 0 when full |
| Back-pressure | The ported runtime writes non-stdio pipes and sockets non-blocking, queues the rest and asks for `fd-writable`, which comes when the buffer is empty again (or nobody reads) |
| Reads | Return what is buffered, up to the requested size; with nothing buffered a read waits |
| EOF | When every write end is closed and the buffer is empty |
| No readers | A write fails with `EPIPE`. No `SIGPIPE` is generated: node processes get the `EPIPE` error (Node ignores `SIGPIPE` anyway); builtin programs exit with status 141 |
| Last reader closes | Buffered data is discarded |
| Pushing to a process | After `readStart` the kernel posts `fd-data` messages of at most 64 KiB whenever data arrives, and `data: null` at EOF |
| Identity | Each pipe has a number, shown by `readlink('/proc/self/fd/N')` as `pipe:[N]` |

```sh
yes | head -2      # head exits; yes gets EPIPE and ends with status 141
```

### Socketpairs

A socketpair (`'ipc'` stdio, extra stdio pipes, TCP and Unix socket connections) is two pipes
crossed over:

- Capacity for non-blocking writers: 212992 bytes per direction.
- `shutdown()` closes this end's write side: the peer reads EOF, this end can still read.
- Closing an end closes both directions.
- A handle (a socket, a server, a pipe) can be sent with data (`child.send(msg, handle)`): it is
  attached to the first byte of that write and received by the reader that reads that byte; a reader
  that reads the byte without asking for handles drops it.

FIFOs are described in [File system](filesystem.md#fifos).

## Signals

### Signal table

The kernel knows Linux's signals (`src/kernel/proc.ts`). Without a handler, each has its default
action from signal(7):

| Signal | Number | Default action |
|---|---|---|
| `SIGHUP` | 1 | terminate |
| `SIGINT` | 2 | terminate |
| `SIGQUIT` | 3 | terminate (core) |
| `SIGILL` | 4 | terminate (core) |
| `SIGTRAP` | 5 | terminate (core) |
| `SIGABRT` (`SIGIOT`) | 6 | terminate (core) |
| `SIGBUS` | 7 | terminate (core) |
| `SIGFPE` | 8 | terminate (core) |
| `SIGKILL` | 9 | terminate (also with a handler) |
| `SIGUSR1` | 10 | terminate |
| `SIGSEGV` | 11 | terminate (core) |
| `SIGUSR2` | 12 | terminate |
| `SIGPIPE` | 13 | terminate |
| `SIGALRM` | 14 | terminate |
| `SIGTERM` | 15 | terminate |
| `SIGSTKFLT` | 16 | terminate |
| `SIGCHLD` (`SIGCLD`) | 17 | ignore |
| `SIGCONT` | 18 | continue — ignored, as nothing is ever stopped |
| `SIGSTOP` | 19 | stop — terminates (also with a handler) |
| `SIGTSTP` | 20 | stop — terminates |
| `SIGTTIN` | 21 | stop — terminates |
| `SIGTTOU` | 22 | stop — terminates |
| `SIGURG` | 23 | ignore |
| `SIGXCPU` | 24 | terminate (core) |
| `SIGXFSZ` | 25 | terminate (core) |
| `SIGVTALRM` | 26 | terminate |
| `SIGPROF` | 27 | terminate |
| `SIGWINCH` | 28 | ignore (a node process still gets the message, for the terminal size) |
| `SIGIO` (`SIGPOLL`) | 29 | terminate |
| `SIGPWR` | 30 | terminate |
| `SIGSYS` (`SIGUNUSED`) | 31 | terminate (core) |
| `SIG32`, `SIG33` | 32, 33 | terminate |
| `SIGRTMIN`, `SIGRTMIN+1` … `SIGRTMIN+15`, `SIGRTMAX-14` … `SIGRTMAX-1`, `SIGRTMAX` | 34–64 | terminate |

Names are those `kill -l` shows; the kernel also accepts them without `SIG`, the aliases in brackets,
`SIGRTMIN+n`/`SIGRTMAX-n` in any spelling of the range, and `SIG<number>`. Signals cross the channel
by number from the ported runtime and by name from the legacy runtime; either way
`process.kill(pid, 'SIGPWR')` arrives as `SIGPWR`.

"Terminate (core)" ends the process like "terminate" (there is no core dump). There is no stopped
state, so the stop signals end the process too, and `SIGCONT` never has anything to continue.

### Delivery

- A node process that has a handler for a signal (it called `sigaction` — `process.on('SIGINT', …)`)
  receives `{ t: 'signal', sig }` and keeps running. `SIGKILL` and `SIGSTOP` are never delivered to a
  handler.
- The legacy runtime registers handlers for `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGUSR1`,
  `SIGUSR2`, `SIGWINCH`, `SIGBREAK`, `SIGPIPE`, `SIGCONT` and `SIGTSTP`; the ported runtime for any
  signal Node's `process.on` accepts.
- Terminating a node process terminates its workers at once; there is no further JavaScript (no
  `exit` event).
- A builtin program may install `onSignal` and swallow a signal (the interactive shell swallows
  `SIGINT`, `SIGTSTP`, `SIGQUIT` and `SIGWINCH`). Otherwise the default action applies; when it
  terminates, the program's `AbortSignal` fires and its status is set at once; whatever the program
  returns later is ignored.

### kill

`kill { pid, sig }` (`process.kill`, `child.kill`), as kill(2):

| `pid` | Target |
|---|---|
| `> 0` | that process |
| `0` | every running process in the caller's process group (the caller included) |
| `-1` | every running process except the caller |
| `< -1` | every running process in group `-pid` |

| `sig` | Effect |
|---|---|
| `0` | only checks that the target exists and is running |
| a number 1–64, or a signal's name | delivered to each target as described above (the caller last) |
| anything else | `EINVAL` |

A target that doesn't exist or has exited — for a group or `-1`, no running process at all — gives
`ESRCH`. Every process may signal every other process (there is no permission check). The host's
`kill(pid, signal)` signals the whole process group of `pid` and never fails.

## Process groups and job control

- `pgid` of a new process: a new group (`pgid = pid`) when asked for (`pgid: 0`), else the given
  group, else the parent's group.
- Processes the host starts get a group of their own, so the host's `kill` reaches the process and
  everything it started in the same group.
- In a non-interactive shell, the commands of a pipeline share one new group (the pid of the first
  command started); other commands stay in the shell's group. The interactive shell starts every
  command in a group of its own and makes it the TTY's foreground group while it runs.
- Keyboard signals (`^C`, `^\`, `^Z`) go to the TTY's foreground group.
- There is no job control: no stopped jobs, no `fg`/`bg`, `jobs` prints nothing. `^Z` terminates the
  foreground job (status 148).
- There are no sessions, and a program can't change its process group (Node's `detached` option is
  ignored).

## The terminal (TTY)

A TTY is created when the host starts a process with a terminal
(`spawn(…, { terminal: { cols, rows } })`). The process gets the TTY as fds 0, 1 and 2, as its controlling terminal (inherited by its children)
and as the foreground group's terminal. Output is sent to the host as `output` events.

| Property | Value |
|---|---|
| Size | `cols` 80 and `rows` 24 unless given; `resize(cols, rows)` from the host changes it |
| `SIGWINCH` | sent on every resize to every running process whose controlling terminal it is |
| Id | 1, 2, … per TTY; the `tty` program prints `/dev/pts/<id>` |
| `isatty` | true for fds that are the TTY (`fstat` mode `S_IFCHR\|0620`) |
| `/dev/tty` | opens the controlling terminal; `ENXIO` without one |

### Output

Output is passed through with one change, also in raw mode: a line feed that is not preceded by a
carriage return in the same write becomes CR LF (`ONLCR`).

### Line discipline (cooked mode)

Input is collected into a line and handed to readers when the line ends.

| Input | Effect | Echo |
|---|---|---|
| printable bytes, tab | added to the line | the byte |
| `CR` (13) or `LF` (10) | `LF` is added and the line is delivered | `LF` (shown as CR LF) |
| `^C` (3) | the line is discarded; `SIGINT` to the foreground group | `^C` and a new line |
| `^\` (28) | the line is discarded; `SIGQUIT` to the foreground group | — |
| `^Z` (26) | `SIGTSTP` to the foreground group (the line is kept) | — |
| `^D` (4) on an empty line | end of file: one read returns EOF | — |
| `^D` with text on the line | the line is delivered without a line feed | — |
| `DEL` (127) or `^H` (8) | removes the last UTF-8 character from the line (nothing on an empty line) | `BS SP BS` |
| `^U` (21) | discards the line (nothing on an empty line) | `CR` `ESC[K` |
| `ESC` (27) | added to the line | — (the bytes after it are echoed as usual) |
| other control bytes | added to the line | — |

There is no limit on the line length or on input waiting to be read. An end of file is consumed by the
one reader that gets it.

### Raw mode and echo

| Setting | Effect |
|---|---|
| `setRawMode(true)` (`process.stdin.setRawMode`) | raw on, echo off: bytes go to readers as they arrive; `^C`, `^Z`, `^\`, `^D` are ordinary bytes |
| `setRawMode(false)` | raw off, echo on |
| `stty raw` / `stty -raw`, `stty sane`, `stty cooked` | raw on / off (echo unchanged) |
| `stty echo` / `stty -echo` | echo on / off |
| `stty size` | prints `<rows> <cols>` |

When a foreground command of the interactive shell exits, the shell turns raw mode off and echo on.

## Limits

| Limit | Value |
|---|---|
| Processes | no limit; pids are never reused |
| Descriptors per process | numbers below `nofile` (`EMFILE` beyond) |
| `nofile` (`ulimit -n`) | 1024 by default; limits descriptors and worker threads: a thread is refused when `threads × 8 + 30 > nofile` |
| Interpreter chain (`#!`) | 9 files (`ELOOP`) |
| `#!` line | read from the first 256 bytes |
| One `read` system call | 16 MiB |
| System call channel | 4 MiB per thread (larger messages in several rounds) |
| Pipe capacity for non-blocking writers | 65536 bytes; socketpairs 212992 bytes per direction |
| `fd-data` chunk | 64 KiB |
| Wait at exit for readers | 250 ms |
| Exited process kept in the table | 60 s |
| CPU time, memory | no limits in the kernel (worker threads may pass `resourceLimits` to their runtime) |
