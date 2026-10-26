# File system

[日本語](filesystem.ja.md)

OpenVessel has one in-memory, POSIX-like file system that lives in the kernel worker
(`src/kernel/vfs.ts`). This page specifies its inode model, path resolution, permissions,
timestamps, links, file descriptors, special files, change events and limits, and how Node's `fs`
and the host page's `vessel.fs` map onto it.

What exists when the kernel starts is listed in [Kernel](kernel.md#initial-file-system); the file
system system calls are in the [system call table](kernel.md#files).

## Overview

- One tree for the whole OpenVessel instance, shared by all processes and the host page.
- Everything is held in JavaScript memory of the kernel worker. Nothing is persisted: reloading the
  page starts from the [initial layout](kernel.md#initial-file-system). Use the host API's `export()`
  and `mount()` to save and restore files ([Host API](host-api.md)). (The package managers keep their
  download cache in the browser's Cache Storage, which is separate from the file system; see
  [Package managers](package-managers.md).)
- Processes reach it only through system calls; builtin programs (`sh`, coreutils, `npm`) and the
  host API call the VFS directly.
- There is one device: `dev` is 2049 for every inode.

## Inodes and file types

| Field | Meaning |
|---|---|
| `ino` | Inode number, counting from 1 (the root) in creation order; never reused |
| `mode` | File type bits and permission bits (`0o7777`) |
| `uid`, `gid` | Always 1000 (`user`); see [ownership](#ownership-and-permissions) |
| `nlink` | Number of names; directories: 2 + number of subdirectories |
| `atimeMs`, `mtimeMs`, `ctimeMs`, `birthtimeMs` | Milliseconds since the epoch (`Date.now()`) |
| `size` | Logical size of a regular file |
| `data` | The bytes of a regular file (may be shorter than `size`: the rest is a hole that reads as zeros) |
| `entries` | Directory entries (name → inode), in insertion order |
| `target` | Symlink target, stored as given |
| `device`, `rdev` | Character devices |
| `fifo` | The pipe shared by the open ends of a FIFO |

| Type | `S_IF*` | Created by | Default mode |
|---|---|---|---|
| Regular file | `S_IFREG` 0o100000 | `open(O_CREAT)`, `writeFile`, `copyFile`, host `writeFile`/`mount` | requested mode, see [umask](#modes-and-umask) |
| Directory | `S_IFDIR` 0o040000 | `mkdir`, `mkdtemp` | requested mode, see [umask](#modes-and-umask) |
| Symbolic link | `S_IFLNK` 0o120000 | `symlink` | 0o777 |
| Character device | `S_IFCHR` 0o020000 | the kernel at start only | 0o666 |
| FIFO | `S_IFIFO` 0o010000 | the `mkfifo` program | `-m` mode, or 0o666 minus the umask |
| Socket | `S_IFSOCK` 0o140000 | `listen()` on a Unix domain socket path | 0o777 minus the umask |
| Block device | `S_IFBLK` 0o060000 | — (defined, never created) | |

`stat` results:

| Field | Value |
|---|---|
| `dev` | 2049 |
| `rdev` | device number for character devices, otherwise 0 |
| `size` | regular file: its size; directory: 4096; symlink: UTF-8 length of the target; others: 0 |
| `blksize` | 4096 |
| `blocks` | `ceil(size / 512)` for regular files (holes included); 0 for directories and symlinks |

`fstat` of a descriptor that has no inode (a pipe, a socketpair end, a TTY) returns a synthetic
result: `dev` 0, `ino` 0, `nlink` 1, uid/gid 1000, size 0, all times "now", and mode
`S_IFIFO|0600` (pipe), `S_IFSOCK|0600` (socket), `S_IFCHR|0620` (TTY).

## Path resolution

1. A relative path is resolved against the calling process's working directory.
2. The result is normalized **lexically** (`path.posix.normalize`/`resolve`): `.` and `..` are
   removed before the lookup, so `/a/link/..` is `/a` even when `link` points elsewhere. (Paths
   given to the host API are not normalized; there `..` follows the directory's real parent.)
3. The VFS walks the components from the root. A symlink in the middle is always followed; the last
   component is followed for `stat`, `open`, `readFile` and friends and not for `lstat`,
   `readlink`, `unlink`, `rename`, `rm`, `symlink`.
4. A relative symlink target is resolved against the real path of the directory containing the link.

| Limit / rule | Error |
|---|---|
| More than 40 symlinks followed in one lookup | `ELOOP` |
| Path of 4096 bytes or more (UTF-8) | `ENAMETOOLONG` |
| A component longer than 255 bytes | `ENAMETOOLONG` |
| A component that is not a directory | `ENOTDIR` |
| A trailing `/` on something that is not a directory | `ENOTDIR` |
| A missing component | `ENOENT` |
| An empty path | `ENOENT` |

## Ownership and permissions

### Users

Every inode belongs to uid 1000, gid 1000 (`user`), and processes run as that user
(`process.getuid()` is 1000). `chown` doesn't change anything: in the ported runtime `fs.chown`,
`fs.fchown` and `fs.lchown` only check that the path or fd exists; in the legacy runtime they do
nothing; the `chown` program does nothing.

### What is checked

Processes run as uid 1000, not as root, so the permission bits apply to them as on Linux. They are
checked for system calls from node processes; builtin programs and the host API are not checked.

| Check | Where | Error |
|---|---|---|
| Read permission (`r`) on an existing file | `open` for reading, `readFile`, `copyFile` (source) | `EACCES` |
| Write permission (`w`) on an existing file | `open` for writing or with `O_TRUNC`, `writeFile` (also with `O_APPEND`), `truncate`, `copyFile` (an existing destination) | `EACCES` |
| Read permission on a directory | `open` of a directory, `readdir` (`fs.readdir`, `fs.opendir`) | `EACCES` |
| Search permission (`x`) on a directory | `chdir` | `EACCES` |
| Write and search permission (`w` and `x`) on the directory that gets or loses an entry | `open` with `O_CREAT` of a new file, `writeFile` of a new file, `copyFile` to a new file, `mkdir` (the directory that gets the first new entry), `mkdtemp`, `rmdir`, `unlink`, `rename` (source and destination directories), `link`, `symlink` | `EACCES` |
| Execute permission (`x`) to run a file | `spawn`, `execve`, the shell | `EACCES` (`Permission denied`) |
| `R_OK`, `W_OK`, `X_OK` in `access()` | the matching bits; `X_OK` on a directory is search permission | `EACCES` |

Each check uses the owner bits when the inode's uid is 1000, else the group bits when its gid is 1000,
else the other bits — in practice always the owner bits. As on Linux, the permission of a file is
checked when it is opened: a file created by `open(O_CREAT)` with mode 0o444 can be written through
the descriptor that created it, and an open descriptor keeps working after a `chmod`.

Not checked: search permission on the directories along a path (only `chdir` checks it), `chmod` and
`utimes` (the owner may always do them, and the owner is always the process's user), the legacy
runtime's `rm` and `cp`, the sticky bit of `/tmp`, and the kernel's own `/proc` and `/dev/tty` paths.

### Modes and umask

| Operation | Resulting permission bits |
|---|---|
| `open(O_CREAT)`, `writeFile` creating a file | `mode & ~umask` (mode defaults to 0o666) |
| `mkdir` | `mode & 0o1777 & ~umask` (mode defaults to 0o777) |
| `mkdtemp` | `0o700 & ~umask` |
| Unix domain socket (`listen(path)`) | `0o777 & ~umask` |
| `copyFile` | the source's bits, exactly |
| `chmod`, `fchmod` | `mode & 0o7777`, exactly |
| Builtin programs (`mkdir`, `touch`, the shell's redirections, …) | as above, with the program's umask |
| Host `writeFile`, `mount` | 0o644; `mount` adds `x` bits to `*.sh`, `*.bash` and to strings starting with `#!` |
| Host `mkdir` | 0o755 |

The umask is per process: 0o022 for a process the host starts, otherwise a copy of its parent's (also
across `execve`). It is applied when a file, directory or socket is created and nowhere else, so with
`umask 0` a new directory gets 0o777. It is changed with `process.umask()` (both runtimes) or the
shell's `umask` builtin, which affects the shell's own redirections and the programs it starts
afterwards. The host API and the kernel's own files use 0o022.

## Timestamps

All times come from `Date.now()` (millisecond resolution). `birthtimeMs` is set at creation and never
changes.

| Operation | atime | mtime | ctime | Parent directory mtime + ctime |
|---|---|---|---|---|
| Create a file, directory, symlink, FIFO or socket | set | set | set | updated |
| Write a whole file (`writeFile`) | — | updated | updated | — |
| Write through a descriptor | — | updated | updated | — |
| `truncate`, `ftruncate`, `open(O_TRUNC)` | — | updated | updated | — |
| Read a whole file (`readFile`) | updated | — | — | — |
| Read through a descriptor (when it returns bytes) | updated | — | — | — |
| `readdir` (names only) | updated (the directory) | — | — | — |
| `readdir` with types, `opendir` | — | — | — | — |
| `unlink` | — | — | updated | updated |
| `rename` | — | — | updated | updated (both directories) |
| `link` | — | — | updated | updated |
| `rmdir` | — | — | — | updated |
| `chmod` | — | — | updated | — |
| `utimes`, `futimes` | given value | given value | updated | — |
| `fchmod` | — | — | updated | — |

## Links

### Symbolic links

- The target is stored verbatim and not checked; dangling links are allowed.
- `lstat().size` is the UTF-8 length of the target.
- Creating a file through a dangling symlink (`open(O_CREAT)`, `writeFile`) creates the target;
  with `O_EXCL` it fails with `EEXIST`.
- `utimes` follows the link; `fs.lutimes()` (ported runtime) changes the times of the link itself.
- `chmod` follows the link (there is no `lchmod`).

### Hard links

`link()` adds another name for the same inode and increments `nlink`; `unlink()` decrements it. The
data stays reachable while any name or open descriptor refers to it. Hard links to directories fail
with `EPERM`. A hard link to a symlink links the symlink itself.

## File descriptors and open flags

File descriptors are per process ([Processes](processes.md#file-descriptors-and-stdio)). `open`
returns the lowest free number ≥ 3, or fails with `EMFILE` when that would reach the process's
`RLIMIT_NOFILE` (`ulimit -n`, 1024 by default). An open file description (offset, flags) is shared by all
descriptors that refer to it — inherited by a child or passed to another process — so they share the
offset.

| Flag | Value | Behaviour |
|---|---|---|
| `O_RDONLY` / `O_WRONLY` / `O_RDWR` | 0 / 1 / 2 | Access mode; reading a write-only fd or writing a read-only fd fails with `EBADF` |
| `O_CREAT` | 0o100 | Create a missing regular file |
| `O_EXCL` | 0o200 | With `O_CREAT`: `EEXIST` if the name exists (also a dangling symlink) |
| `O_NOCTTY` | 0o400 | Ignored |
| `O_TRUNC` | 0o1000 | With write access: truncate a regular file to 0 |
| `O_APPEND` | 0o2000 | Every write goes to the end of the file; a position passed to `write` is ignored |
| `O_NONBLOCK` | 0o4000 | Ignored by `open` |
| `O_DIRECTORY` | 0o200000 | `ENOTDIR` if the path is not a directory |
| `O_NOFOLLOW` | 0o400000 | A symlink in the last component is not followed: `open` fails with `ELOOP` |
| `O_SYNC` | 0o4010000 | Ignored (everything is synchronous) |

Other rules of `open`:

- A missing path without `O_CREAT` fails with `ENOENT` (or `ENOTDIR`).
- A directory can be opened read-only; reading it fails with `EISDIR`. Opening it with write access
  fails with `EISDIR`.
- Opening a FIFO gives an end of its pipe (see [special files](#special-files)).
- `/dev/tty`, `/dev/fd/N`, `/proc/self/fd/N` and `/proc/<own pid>/fd/N` are handled by the kernel
  (see [special files](#special-files)).

## Reading and writing

- `read` returns up to the requested length (at most 16 MiB per call). Reading at or past the end
  returns 0 bytes.
- `read`/`write` with a position (`pread`/`pwrite`) don't move the offset; without one they use and
  advance it.
- Writing past the end fills the gap with zeros. `truncate` to a larger size leaves a hole that reads
  as zeros; no memory is taken for it until the file is written there or read whole.
- `fsync`/`fdatasync` only check that the fd is open.
- Writing a whole file (`writeFile`) replaces the data in one step; watchers see one `change` event.
  Writing through a descriptor raises one `change` event per write.

## Directory listing

- Entries are returned in insertion order — the order names were created. A name that arrives by
  `rename` is appended; renaming onto an existing name keeps that name's position. `.` and `..` are
  not listed.
- With types (`withFileTypes`), each entry's type is that of the entry itself (a symlink stays a
  symlink).
- The ported runtime's `fs.opendir` takes a snapshot of the listing when it opens and hands it out in
  batches of `bufferSize`.
- `/proc` lists only `cpuinfo`, `meminfo` and `version`; `/dev/fd` is empty;
  `readdir('/proc/self/fd')` fails with `ENOENT`.

## Operations and errors

Errors of each operation besides the path lookup errors (`ENOENT`, `ENOTDIR`, `ELOOP`,
`ENAMETOOLONG`) and the [permission checks](#what-is-checked):

| Operation | Errors | Notes |
|---|---|---|
| `mkdir` | `EEXIST` (also for `/`), `ENOENT` (missing parent, not recursive), `ENOTDIR` | Recursive: returns the first directory created, `undefined` when all existed |
| `rmdir` | `ENOTDIR`, `ENOTEMPTY`, `EBUSY` (`/`) | |
| `unlink` | `EISDIR` for a directory (also `/`) | Removes symlinks themselves |
| `rename` | `EINVAL` (a directory into itself), `EISDIR` (file onto a directory), `ENOTDIR` (directory onto a file), `ENOTEMPTY` (onto a non-empty directory), `EBUSY` (`/` on either side) | Replaces an existing file or empty directory; renaming a name onto the same inode does nothing |
| `link` | `EPERM` (directory), `EEXIST` | |
| `symlink` | `EEXIST` | |
| `readlink` | `EINVAL` (not a symlink) | |
| `open` | `EEXIST`, `EISDIR`, `ENOTDIR` (`O_DIRECTORY`), `ENXIO` (`/dev/tty` without a terminal) | |
| `read` | `EBADF`, `EISDIR` | |
| `write` | `EBADF`, `EISDIR`, `EPIPE` (pipe without readers) | |
| `writeFile` | `EEXIST` (`wx`), `EISDIR` (also for `/`), `ENOENT` (missing parent) | Writing to a character device writes to the device |
| `truncate`, `ftruncate` | `EISDIR`; `ftruncate` of a descriptor without an inode or not open for writing: `EINVAL` | Other non-regular files are left unchanged |
| `copyFile` | `EISDIR` (source is a directory), `EEXIST` (`COPYFILE_EXCL`), `ENOENT` (missing destination directory) | Follows symlinks on both sides; `COPYFILE_FICLONE*` flags are ignored |
| `lseek` | `ESPIPE` (not a regular file), `EINVAL` (negative result) | |
| `fs.rm` (legacy) | `ENOENT` unless `force`, `ERR_FS_EISDIR` (directory without `recursive`) | The ported runtime runs Node's own `rm` (rimraf) on top of the calls above |
| `fs.cp` | Node's `ERR_FS_CP_*` errors | Ported: Node's `cpSync` checks with the native half reimplemented; legacy: the kernel's `cp` |

## Special files

| Path | What it is |
|---|---|
| `/dev/null` | Reads return nothing, writes are discarded (rdev 0x103) |
| `/dev/zero` | Reads return zeros, at most 64 KiB per read (rdev 0x105) |
| `/dev/random`, `/dev/urandom` | Reads return `crypto.getRandomValues` bytes, at most 64 KiB per read (rdev 0x108, 0x109) |
| `/dev/tty` | The calling process's controlling terminal; `ENXIO` when it has none. A character device node (5,0) exists for `stat`; opening it gives the calling process's TTY |
| `/dev/stdin`, `/dev/stdout`, `/dev/stderr` | Symlinks to `/proc/self/fd/0`, `1`, `2` |
| `/dev/fd/N`, `/proc/self/fd/N`, `/proc/<own pid>/fd/N` | The process's fd N: a regular file is opened anew (own offset, the new open's flags); a pipe, socket or TTY is shared. `ENOENT` if fd N is not open |
| `/proc/self` | `lstat`: a symlink (size = digits of the pid); `readlink` returns the pid; `stat`: a directory (mode 0o555) |
| `/proc/<own pid>`, `/proc/<own pid>/fd` | Directories in `stat` (0o555 and 0o500) |
| `readlink('/proc/self/fd/N')` | The file's path, `/dev/tty`, `pipe:[id]` or `socket:[id]` |
| `/proc/cpuinfo`, `/proc/meminfo`, `/proc/version` | Static files written at start, with the CPUs, memory and kernel version the ported runtime's `os` module reports ([initial file system](kernel.md#initial-file-system)) |
| FIFOs (`mkfifo`) | See below |
| Unix domain sockets | Created by `listen(path)`; `open` doesn't connect to them (use `net.connect(path)`) |

Other processes' `/proc/<pid>` entries don't exist (`ENOENT`), and `/proc` holds no other files. Reading
a character device to its end never finishes (`fs.readFileSync('/dev/zero')` without an encoding
doesn't return), as on Linux; the `readFile` system call reads a device once (up to 64 KiB).

### FIFOs

A FIFO's pipe exists while any end is open. Unlike Linux, `open` never blocks:

- A reader opened before any writer waits for data instead of reading EOF.
- Data written before any reader has opened is kept for the reader instead of failing with `EPIPE`.
- When all ends are closed the pipe is dropped, unless a writer came first and its data still waits
  for a reader.

Pipe buffering and EOF rules are in [Processes](processes.md#pipes).

## Watchers

### Change events

Every mutation of the VFS produces an event `{ type, path }` synchronously — no debouncing, no
coalescing — with the path the operation was given (absolute and lexically normalized for system
calls, as given for the host API):

| Event | Produced by |
|---|---|
| `rename` | creating a file, directory, symlink, hard link, FIFO or socket; `unlink`; `rmdir`; `rename` (one event for the old path, one for the new) |
| `change` | `writeFile`, every write through a descriptor, `truncate`/`ftruncate`/`O_TRUNC`, `chmod`, `utimes`, and `fchmod`/`futimes` (under the path the descriptor was opened with) |
| none | reads, `chown`, writes to character devices |

Because events carry paths, a change made through another name (a symlink, a hard link, a different
spelling through a symlinked directory) is reported under that name only.

### `watch` system call

`watch { id, p, recursive }` registers a filter on the event stream; matching events are posted to
the thread that called it as `{ t: 'watch', id, type, path }`:

- the watched path itself,
- with `recursive`, any path below it (a watch on `/` sees every path); without, its direct children.

The kernel doesn't check that the path exists. Watches end with `unwatch`, `execve` or the process's
exit.

### `fs.watch`

| | Ported runtime (`src/nodejs/bindings/fs_event_wrap.ts`) | Legacy runtime (`src/node/fs.ts`) |
|---|---|---|
| Missing path | `ENOENT` (stat first) | `ENOENT` (stat first) |
| `filename` for the watched path itself | its basename | its basename |
| `filename` for an entry below | relative path | relative path |
| Watched file or directory deleted or replaced | reports `change` (files only), `rename`, `rename`, then stops — as inotify does | keeps reporting by path |
| `recursive: true` | Node's own JavaScript watcher for Linux (`internal/fs/recursive_watch`), built from non-recursive watches | the kernel's recursive filter |
| `persistent: false` | the handle doesn't keep the process alive | same |

### `fs.watchFile`

| | Ported runtime | Legacy runtime |
|---|---|---|
| Polling | `stat` every `interval` ms (Node's default 5007) | every `min(interval, 1000)` ms |
| Change detected when | ctime, mtime, birthtime, size, mode, uid, gid, ino or dev differ (libuv's rule) | mtime, size or ino differ |
| First poll | baseline only | baseline only |

### Host watches

`vessel.fs.watch(path, fn)` is always recursive: `fn({ type, path })` is called for the path and
every path below it. See [Host API](host-api.md).

## Size and memory

- No quota: files and directories are limited only by the memory the browser gives the kernel worker.
  `ENOSPC` is never returned.
- A file's buffer grows to `max(needed, 2 × current, 64 bytes)`, but never more than 64 MiB beyond
  what is needed.
- `fs.statfs` reports fixed numbers: `type` 0xef53, `bsize` 4096, `blocks` 1048576, `bfree` 524288,
  `bavail` 524288, `files` 1048576, `ffree` 524288.
- One `read` system call returns at most 16 MiB; one system call message larger than the 4 MiB channel
  is passed in several rounds.

## How Node's `fs` maps onto the kernel

The ported runtime reimplements `internalBinding('fs')` (`src/nodejs/bindings/fs.ts`,
`fs_dir.ts`, `fs_event_wrap.ts`); Node's own `lib/fs.js` sits on top unchanged. Every binding
function works in the three modes of Node: synchronous (throws), callback (`FSReqCallback`, completed
on a later turn) and promise (`kUsePromises`). Errors become Node's `UVException`s
(`ENOENT: no such file or directory, open '/x'`).

| Node API | System calls |
|---|---|
| `access`, `exists` | `access`, `stat` |
| `open`, `fs.promises.open` (`FileHandle`) | `open` |
| `close` | `close` |
| `read`, `readv` | `read` (for pipes, TTYs and sockets the callback and promise forms wait asynchronously with `readOnce`) |
| `readFile` with `'utf8'` | `readFile`, or `open` + `read` for an fd or non-default flags |
| `readFile` (other encodings, `Buffer`) | Node opens the file and calls `fstat` and `read` |
| `write`, `writev`, `writeFile` | `write`, `writeFile` |
| `stat`, `lstat`, `fstat` | `stat` (`l`), `fstat` |
| `statfs` | `stat`, fixed numbers |
| `readdir`, `opendir` | `readdir` (with types) |
| `mkdir`, `mkdtemp`, `rmdir`, `unlink`, `rename`, `link`, `symlink`, `readlink`, `realpath` | the call of the same name |
| `rm` | Node's JavaScript implementation over `lstat`, `readdir`, `rmdir`, `unlink` |
| `truncate` | Node opens the file and calls `ftruncate` |
| `ftruncate` | `ftruncate` |
| `copyFile` | `copyFile` |
| `cp` | Node's `cp` with `cpSyncCheckPaths`/`cpSyncCopyDir`/`cpSyncOverrideFile` over `stat`, `readdir`, `mkdir`, `copyFile`, `symlink`, `readlink`, `realpath`, `unlink`, `utimes` |
| `chmod`, `fchmod` | `chmod`, `fchmod` |
| `chown`, `fchown`, `lchown` | `stat`/`fstat` only (ids ignored) |
| `utimes`, `futimes`, `lutimes` | `utimes` (`lutimes` with `l`), `futimes` |
| `fsync`, `fdatasync` | `fstat` only |
| `watch` | `stat`, `watch`, `unwatch` |
| `watchFile` | `stat` on a timer |

The legacy runtime (`src/node/fs.ts`) implements `fs` by hand over the same calls, with these
differences: `rm` and `cp` are single kernel calls (`rm`, `cp`), `truncate` uses the `truncate` call,
`chown`/`fchown`/`lchown`/`fsync`/`fdatasync` do nothing, and `statfs` returns fixed values without a
lookup (`type` 0x858458f6, every count 1048576).

## The host API's `vessel.fs`

The host page's calls go to the VFS directly, without permission checks and without a process
(`src/kernel/index.ts`). Paths should be absolute; a relative path is taken from `/`.

| Host call | Kernel behaviour |
|---|---|
| `fs.readFile(path, encoding?)` | Whole file; a `Uint8Array` copy, or a string with `'utf8'`. `EISDIR` for a directory |
| `fs.writeFile(path, data)` | Creates missing parent directories, mode 0o644; `change` (and `rename` when new) events |
| `fs.mkdir(path, { recursive = true })` | Mode 0o755; returns the first directory created, or `null` |
| `fs.readdir(path, { withFileTypes })` | Names, or `{ name, type }` with `type` `dir`, `symlink` or `file` (everything else) |
| `fs.rm(path, { recursive, force })` | `recursive`: removes the tree, missing is fine unless `force: false`; `/` fails with `EBUSY` before anything is removed. Otherwise: `rmdir` for a directory (must be empty), `unlink` for anything else |
| `fs.stat(path)` | The stat fields plus `isDirectory` and `isFile` (follows symlinks) |
| `fs.exists(path)` | `true` if the path resolves (follows symlinks) |
| `fs.rename(from, to)` | As `rename` |
| `fs.watch(path, fn)` | Recursive; see [host watches](#host-watches) |
| `mount(files, { path = '/home/user/app' })` | Creates the base directory; per entry: `null` or `{ dir: true }` → directory, `{ symlink }` → symlink, otherwise a file (0o644, plus `x` bits for `*.sh`/`*.bash` and strings starting with `#!`). Returns the number of entries |
| `export(path, { exclude = ['node_modules', '.git'] })` | Regular files below `path` as `{ relativePath: Uint8Array }`; skips names in `exclude` at any depth, symlinks and special files |
