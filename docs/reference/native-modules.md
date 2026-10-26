# Native modules

[日本語](native-modules.ja.md)

A browser tab can't load machine code, so OpenVessel never runs a native addon (`.node` file). This page
describes what happens instead: the rules by which `npm install` swaps native packages for WebAssembly
builds, how `.node` files fail at run time, the `node:wasi` implementation, how napi-rs `wasm32-wasi`
bindings and emnapi load, and the compat packages OpenVessel builds itself.

## Overview

| Approach | Where | Examples |
|---|---|---|
| Install the package's own WebAssembly build under the native package's name | installer (`src/kernel/npm/install.ts`) | `esbuild` → `esbuild-wasm`, `rollup` 4 → `@rollup/wasm-node`, `lightningcss` → `lightningcss-wasm` |
| Install the `wasm32-wasi` binding of a napi-rs package, with an emnapi that matches it | installer | `rolldown`, `@node-rs/xxhash` and other napi-rs packages |
| Move to a release line that has a WebAssembly build | installer | `sharp` < 0.33 → 0.34 |
| Install a compat package built by OpenVessel | installer + `compat/`, `scripts/build-compat.mjs` | Pagefind, `cn-font-split`, `@resvg/resvg-js` |
| Run WebAssembly with WASI preview1 | `node:wasi` (`src/node/wasi.ts`) | everything above that is built for WASI |
| Fail clearly | module loader, `process.dlopen` | any other `.node` file |

The package-manager side (resolution, placement, lockfiles) is in [Package managers](package-managers.md).

## What a process sees

| Item | Value | Why it matters |
|---|---|---|
| `process.platform`, `process.arch` | `linux`, `x64` (both runtimes) | Loaders pick per-platform packages by these; compat packages are published under the `linux-x64` name where a loader expects one. |
| `process.versions.napi` | `10` | |
| `process.report.getReport().header.glibcVersionRuntime` | `2.36` | `detect-libc` reads it, so the system counts as glibc, not musl. |
| `NAPI_RS_FORCE_WASI` | `true` in the kernel's default environment (`src/kernel/kernel.ts`) | Read by napi-rs generated loaders, which then load the `wasm32-wasi` package without trying native bindings first. Older loaders force WASI for any non-empty value, recent ones only for `true` or `error`; `true` works with both. |
| Platform used by the installer | `os: linux`, `cpu: wasm32` | Packages whose `cpu` is `x64`, `arm64`, … are skipped while installing. |

## Install-time rules

All rules are in `src/kernel/npm/install.ts`. They apply to every front end (`npm`, `pnpm`, `yarn`,
`bun`) and to `npx`.

### Order

For a registry dependency, `resolve()` does, in order:

1. Pick the version from the spec (lockfile hints, `latest`, highest match).
2. [Upgrades](#upgrades): move an old native-only line to one with a WebAssembly build.
3. [Compat packages](#compat-packages): if one is registered for the name and version, use it and stop.
4. [WebAssembly substitutes](#webassembly-substitutes): swap the contents for the WebAssembly package.

While the package's dependencies are queued, [napi-rs](#napi-rs-bindings) and [sharp](#sharp) rules add
or adjust dependencies, and the [platform filter](#platform-filter) drops packages that can't run.

### Never installed

`fsevents`, `bufferutil`, `utf-8-validate`, `cpu-features` and `ssh2` are skipped wherever they are
listed (`SKIP`). A `require()` of one of them fails with `MODULE_NOT_FOUND`.

### WebAssembly substitutes

`SUBSTITUTES`:

| Package | Installed from | Condition |
|---|---|---|
| `esbuild` | `esbuild-wasm` | any version |
| `rollup` | `@rollup/wasm-node` | major version 4 or later |
| `lightningcss` | `lightningcss-wasm` | any version |
| `sass-embedded` | `sass` (the pure JavaScript Dart Sass) | any version |

- The version of the substitute is the same version if it exists, else the highest `~<version>`, else the
  highest `^<version>`. If none exists or its metadata can't be fetched, the original package is
  installed unchanged.
- The package keeps the requested name and version: it is placed at `node_modules/esbuild`, its
  `package.json` gets `"name": "esbuild"`, the resolved version, and
  `"_openvesselSource": "esbuild-wasm@<version>"` with the version of the substitute that was unpacked
  (which differs from the resolved one when the `~`/`^` fallback picked another). Its `bin` is the
  substitute's, or the original's if the substitute has none.
- The manifest used for dependencies is the substitute's, so the native package's per-platform
  `optionalDependencies` (`@esbuild/linux-x64`, …) are not requested.

### Upgrades

`UPGRADES`:

| Package | Versions | Installed instead |
|---|---|---|
| `sharp` | `<0.33.0` | the version `^0.34.0` resolves to |

sharp before 0.33 bundled libvips as a `.node` addon; 0.33 and later have a WebAssembly build with the
same API for what callers use. `package.json` is not changed; the installed version differs from the
range, and nothing is printed.

### napi-rs bindings

napi-rs packages list one binding package per platform in `optionalDependencies`
(`@scope/pkg-linux-x64-gnu`, …) and, when they publish one, a WebAssembly binding
(`@scope/pkg-wasm32-wasi`, `cpu: ["wasm32"]`) that runs on `@napi-rs/wasm-runtime` and emnapi.

`withWasiBinding()`: for the `optionalDependencies` of every package (including the project), if no
name contains `wasm32` and some name ends in
`-(linux|darwin|win32|freebsd|android)-(x64|arm64|arm|ia32)` with an optional
`-gnu`/`-musl`/`-msvc`/`-gnueabihf`/`-eabi` suffix, the entry `<base>-wasm32-wasi` is added with the
spec of the first such native entry. If that package doesn't exist, the optional dependency is skipped
with `npm warn optional skipping …`.

`withEmnapi()`: a package whose name ends in `-wasm32-wasi` and whose `dependencies` don't list
`@emnapi/core` gets `@emnapi/core@^1.4.0` and `@emnapi/runtime@^1.4.0` added. Bindings built with
emnapi 1.x often rely on whatever emnapi `@napi-rs/wasm-runtime`'s peer finds, which may be another
binding's emnapi 2 (whose runtime lacks `napi_set_last_error`, which 1.x builds import). Bindings built
for emnapi 2 list it themselves.

`pickWasmRuntime()` (since 1.1.1): when a `-wasm32-wasi` package depends on `@napi-rs/wasm-runtime` with
a range, and pins an exact `@emnapi/core` version, the installer takes the newest `@napi-rs/wasm-runtime`
in that range whose `peerDependencies['@emnapi/core']` accepts the pinned version (prereleases
included); a release without that peer is accepted. If nothing fits, or the binding doesn't pin an exact
emnapi, or the project overrides `@napi-rs/wasm-runtime`, the range is resolved normally. The chosen
version is installed in the binding's own `node_modules`, so other packages don't pick it up. Example:
a binding pinning `@emnapi/core@2.0.0-alpha.5` with `@napi-rs/wasm-runtime@~1.2.5` gets 1.2.5, because
1.2.6's peer only accepts `2.0.0-beta.2`.

`DEP_PINS`: dependencies of WebAssembly builds pinned to the version they were built against, installed
next to the dependent:

| Package | Versions | Dependency | Pinned to |
|---|---|---|---|
| `@img/sharp-wasm32` | `<0.34.0` | `@emnapi/runtime` | `1.1.1` |

(The emscripten + emnapi 1.1 glue of those builds uses a callback-info stack that `@emnapi/runtime` 1.2
changed.)

### sharp

| Rule | Effect |
|---|---|
| `UPGRADES` | `sharp` `<0.33.0` → `^0.34.0` |
| `withSharpWasm()` | `sharp` `>=0.35.0-0` without `@img/sharp-wasm32` in its `optionalDependencies` gets `@img/sharp-wasm32@<the same version>` added. (0.35 ships its WebAssembly build as `@img/sharp-webcontainers-wasm32`, but on linux-x64 it falls back to `require('@img/sharp-wasm32')`.) |
| `DEP_PINS` | `@img/sharp-wasm32` `<0.34.0` gets `@emnapi/runtime@1.1.1` |
| platform filter | the native `@img/sharp-linux-x64` and `@img/sharp-libvips-*` packages are skipped by `cpu` |

```js
// works after a plain `npm install sharp`
const sharp = require('sharp');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
```

### Platform filter

A resolved package is skipped when its `os` doesn't accept `linux` or its `cpu` doesn't accept
`wasm32` (negations like `!win32` are honoured; empty lists accept anything). For a non-optional
dependency this prints `npm warn EBADPLATFORM skipping <name>@<version> (needs …)`. `libc` and
`engines` are not checked. Compat packages replace the manifest, so their `os`/`cpu` are those of the
compat package (none).

### Special-cased names

Every package name the installer treats specially:

| Name | Rule |
|---|---|
| `fsevents`, `bufferutil`, `utf-8-validate`, `cpu-features`, `ssh2` | never installed |
| `esbuild` | replaced by `esbuild-wasm` |
| `rollup` (≥ 4) | replaced by `@rollup/wasm-node` |
| `lightningcss` | replaced by `lightningcss-wasm` |
| `sass-embedded` | replaced by `sass` |
| `sharp` | `<0.33` upgraded; `>=0.35` gets `@img/sharp-wasm32` |
| `@img/sharp-wasm32` | `<0.34` gets `@emnapi/runtime@1.1.1` |
| `@napi-rs/wasm-runtime` | version chosen by the binding's emnapi (`pickWasmRuntime`) |
| `@emnapi/core`, `@emnapi/runtime` | added to `*-wasm32-wasi` packages that don't list them |
| `*-wasm32-wasi` | gets emnapi; added next to napi-rs per-platform optional dependencies |
| `@pagefind/linux-x64`, `cn-font-split`, `@resvg/resvg-js` | compat packages (from `index.json`) |

## Loading .node files

`require()` resolution tries `.node` after `.js` and `.json` (both runtimes), so a package that ships
only a native file finds it and then fails to load it.

| | Ported runtime (`src/nodejs/bindings/process.ts`) | Legacy runtime (`src/node/module.ts`, `src/node/process.ts`) |
|---|---|---|
| `require('x.node')` | Node's own loader calls `process.dlopen`, which throws `ERR_DLOPEN_FAILED` | throws `ERR_DLOPEN_FAILED`: `Native addons are not supported in OpenVessel (tried to load <file>). Use the WebAssembly build of this package.` |
| `process.dlopen()` | throws `ERR_DLOPEN_FAILED` with a message like glibc's `dlopen` (below) | the same |
| `import 'x.node'` | `ERR_UNKNOWN_FILE_EXTENSION` (as in Node 22 without `--experimental-addon-modules`) | fails |

Messages of `process.dlopen` (both runtimes):

| File | Message |
|---|---|
| doesn't exist | `<file>: cannot open shared object file: No such file or directory` |
| shorter than 64 bytes | `<file>: file too short` |
| doesn't start with the ELF magic | `<file>: invalid ELF header` |
| an ELF file | `Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.` |

napi-rs loaders catch these errors and go on to their next candidate, ending at the `wasm32-wasi`
package ([napi-rs and emnapi at run time](#napi-rs-and-emnapi-at-run-time)).

## node:wasi

WASI preview1 on the kernel's file system, in `src/node/wasi.ts`. Both runtimes use the same import
functions; the JavaScript API around them differs.

### API

| | Ported runtime | Legacy runtime |
|---|---|---|
| Module | Node's own `lib/wasi.js` over `internalBinding('wasi')` (`src/nodejs/bindings/wasi.ts`) | the `WASI` class of `src/node/wasi.ts` directly |
| `version` option | required: `'preview1'` or `'unstable'`; missing → `ERR_INVALID_ARG_TYPE`, other values → `ERR_INVALID_ARG_VALUE` | the same |
| `getImportObject()` | `{ wasi_snapshot_preview1: … }`, or `{ wasi_unstable: … }` for `'unstable'` | the same |
| Option validation (`args`, `env`, `preopens`, `stdin`/`stdout`/`stderr`, `returnOnExit`) | Node's | the same checks and messages, written out in `src/node/wasi.ts` |
| `env` entries with value `undefined` | left out (as in Node); other values become `KEY=<String(value)>` | the same |
| `returnOnExit` (default `true`) | `start()` returns the exit code; with `false`, `proc_exit` ends the process | the same |
| `start(instance)` | requires `_start`, rejects `_initialize` (Node's checks); `ERR_WASI_ALREADY_STARTED` on a second call | the same |
| `initialize(instance)` | rejects `_start`, calls `_initialize` if present | the same |
| Memory | `instance.exports.memory` | the same |
| `ExperimentalWarning: WASI is an experimental feature…` | printed once, as in Node | not printed |

```js
const { WASI } = require('node:wasi');
const fs = require('node:fs');

const wasi = new WASI({
  version: 'preview1',
  args: ['tool', ...process.argv.slice(2)],
  env: process.env,
  preopens: { '/': '/', '.': process.cwd() },
});
const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync('tool.wasm')), wasi.getImportObject());
process.exitCode = wasi.start(instance);
```

### Imports

All 46 preview1 functions exist. Functions that touch files go through the kernel's system calls, so
they see the same in-memory file system as `fs`.

| Function | Behaviour |
|---|---|
| `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get` | from `args` and `env` |
| `clock_time_get` | clock 0 (realtime): `Date.now()` in nanoseconds (millisecond resolution); other clocks: `performance.timeOrigin + performance.now()` |
| `clock_res_get` | always 1000 ns |
| `fd_read`, `fd_write`, `fd_pread`, `fd_pwrite` | kernel `read`/`write`; scatter/gather over the iovecs |
| `fd_seek`, `fd_tell` | kernel `lseek` |
| `fd_close` | closes the kernel fd (not for 0–2) |
| `fd_fdstat_get` | file type, `APPEND` flag, all rights |
| `fd_filestat_get`, `path_filestat_get` | kernel `fstat`/`stat` (`path_filestat_get` follows symlinks only with `SYMLINK_FOLLOW`) |
| `fd_filestat_set_size` | kernel `ftruncate` |
| `fd_filestat_set_times`, `path_filestat_set_times` | kernel `utimes`; `fst_flags` pick which times change and whether to `now` (setting a time and `now` together is `EINVAL`); `path_filestat_set_times` changes a symlink itself unless `SYMLINK_FOLLOW` |
| `fd_readdir` | entries with `.` and `..` first; `d_next` and `d_ino` are the entry's index + 1 |
| `fd_renumber` | moves the entry, closing the target |
| `fd_prestat_get`, `fd_prestat_dir_name` | preopened directories, from fd 3 on |
| `path_open` | directories become directory handles; `CREAT`, `DIRECTORY`, `EXCL`, `TRUNC` and the `APPEND` fd flag map to `open` flags; read/write access comes from the requested rights; a last component that is a symlink, opened without `SYMLINK_FOLLOW`, is `ELOOP` |
| `path_create_directory`, `path_remove_directory`, `path_unlink_file`, `path_rename`, `path_link`, `path_symlink`, `path_readlink` | the matching kernel calls |
| `poll_oneoff` | clock subscriptions block the thread (`Atomics.wait`) for the shortest timeout, relative or absolute; fd subscriptions are reported ready at once and make the call not block |
| `random_get` | `crypto.getRandomValues` in 64 KiB pieces |
| `proc_exit` | ends `start()` with the code (see `returnOnExit`) |
| `sched_yield`, `fd_advise`, `fd_allocate`, `fd_datasync`, `fd_sync`, `fd_fdstat_set_flags`, `fd_fdstat_set_rights` | succeed and do nothing |
| `proc_raise`, `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown` | `ENOSYS` (52) |

### Files and preopens

- fds 0, 1, 2 are the process's stdin, stdout and stderr (or the kernel fds given as `stdin`,
  `stdout`, `stderr`).
- Each `preopens` entry `{ guestPath: hostPath }` becomes a directory fd from 3 on; `hostPath` is resolved
  against the process's working directory.
- A path argument is looked up beneath the directory fd it is relative to (`src/node/wasi-path.ts`),
  one component at a time, the way uvwasi confines a module to its preopens. Every `path_*` call does
  this (`path_open`, `path_filestat_get`, `path_filestat_set_times`, `path_create_directory`,
  `path_remove_directory`, `path_unlink_file`, `path_rename`, `path_link`, `path_symlink`'s new path,
  `path_readlink`):
  - an absolute path, `..` above the directory, or a symlink whose target leads out of it is
    `ENOTCAPABLE` (76). The exception, as in uvwasi, is that `..` above a directory the module sees as `/` (a
    preopen named `/`) stays at it, so `../x` there is `x`;
  - symlinks on the way are followed inside the directory (an absolute target is read in the module's
    view, relative to the preopen's guest path); the last component is followed only with
    `SYMLINK_FOLLOW`; more than 32 links is `ELOOP`;
  - a missing directory on the way is `ENOENT`; a missing last component is left to the call (it may
    create it).
- The text a `path_symlink` stores is not checked; it is confined when a lookup follows it.
- Rights are not enforced; every fd reports all rights.

### Errors

Kernel errors are returned as WASI errno values:

| Error | errno | Error | errno | Error | errno |
|---|---:|---|---:|---|---:|
| `E2BIG` | 1 | `EINTR` | 27 | `ENOTCONN` | 53 |
| `EACCES` | 2 | `EINVAL` | 28 | `ENOTDIR` | 54 |
| `EADDRINUSE` | 3 | `EIO` | 29 | `ENOTEMPTY` | 55 |
| `EAGAIN` | 6 | `EISDIR` | 31 | `ENOTSUP` | 58 |
| `EBADF` | 8 | `ELOOP` | 32 | `ENOTTY` | 59 |
| `EBUSY` | 10 | `EMFILE` | 33 | `ENXIO` | 60 |
| `ECANCELED` | 11 | `EMLINK` | 34 | `EPERM` | 63 |
| `ECHILD` | 12 | `ENAMETOOLONG` | 37 | `EPIPE` | 64 |
| `ECONNREFUSED` | 14 | `ENFILE` | 41 | `ERANGE` | 68 |
| `ECONNRESET` | 15 | `ENODEV` | 43 | `EROFS` | 69 |
| `EEXIST` | 20 | `ENOENT` | 44 | `ESPIPE` | 70 |
| `EFAULT` | 21 | `ENOEXEC` | 45 | `ESRCH` | 71 |
| `EFBIG` | 22 | `ENOMEM` | 48 | `ETIMEDOUT` | 73 |
| | | `ENOSPC` | 51 | `EXDEV` | 75 |
| | | `ENOSYS` | 52 | `ENOTCAPABLE` | 76 |

Any other error is `EIO` (29). An unknown fd is `EBADF` (8); `path_open` with `DIRECTORY` on a file is
`ENOTDIR` (54).

### Threads

The WASI implementation has no `thread-spawn` import (wasi-threads). A module that needs threads gets
them from its own JavaScript: napi-rs `wasm32-wasi` bindings start their threads as `worker_threads`
workers that share a `WebAssembly.Memory` (OpenVessel's pages are cross-origin isolated, so shared
memory is available). WebAssembly built for plain `wasm32-wasip1` runs single-threaded; the Pagefind
compat build is patched to work that way.

## napi-rs and emnapi at run time

A napi-rs package's generated loader (`index.js`) tries the native per-platform bindings first; none is
installed, so it loads the `-wasm32-wasi` package. That package's `<name>.wasi.cjs`:

- compiles `<name>.wasm32-wasi.wasm`, creates a `node:wasi` `WASI` instance and instantiates the module
  through `@napi-rs/wasm-runtime` and emnapi (`@emnapi/core`, `@emnapi/runtime`), which implement
  Node-API on top of WebAssembly;
- starts `worker_threads` workers from `wasi-worker.mjs` when the binding uses threads.

The install-time rules exist because these three parts must match: the binding pins the emnapi it was
built with, `@napi-rs/wasm-runtime` names the emnapi it supports as a peer, and an emnapi of the wrong
major version fails at instantiation (missing imports). See [napi-rs bindings](#napi-rs-bindings).

## Compat packages

A compat package stands in for an npm package that only ships native code. OpenVessel builds it,
publishes it with the runtime, and the installer installs it under the original package's name and
version. The contents of compat packages are not covered by semver (see `CHANGELOG.md`).

### Built files

`scripts/build-compat.mjs` (run by `scripts/build.mjs`, or alone with `node scripts/build-compat.mjs`)
writes into `dist/runtime/compat/`:

- `<id>-<version>.tgz`: the package as an npm tarball (ustar, every path under `package/`)
- `index.json`: one entry per replaced package name

```json
{
  "@resvg/resvg-js": {
    "range": "^2.0.0",
    "file": "resvg-js-2.6.2.tgz",
    "integrity": "sha512-…",
    "pkg": {
      "name": "@openvessel/resvg-js-wasm",
      "version": "2.6.2",
      "description": "@resvg/resvg-js on @resvg/resvg-wasm (OpenVessel)",
      "license": "MPL-2.0",
      "main": "index.js",
      "types": "index.d.ts",
      "dependencies": { "@resvg/resvg-wasm": "2.6.2" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| key | the npm package name being replaced |
| `range` | the versions of that package it stands in for |
| `file` | tarball name in `dist/runtime/compat/` |
| `integrity` | `sha512-` SRI hash of the tarball |
| `pkg` | the compat package's `package.json`; its `dependencies`, `bin`, … are what the installer uses |

### How the installer uses them

`loadCompat()` fetches `<runtime base>/compat/index.json` (the runtime base is the directory the kernel
script is served from). An index that was fetched is kept for the life of the kernel. A failed or non-OK
fetch counts as an empty index for that install only; the next install asks again.

For a registry dependency, after the version is picked and [upgrades](#upgrades) applied, if the index
has an entry for the package's real name (after `npm:` aliases) and the version satisfies its `range`
(prereleases included):

- the manifest is `pkg` with `name` and `version` set to the requested package's;
- the tarball is `<runtime base>/compat/<file>`, fetched with a plain `fetch` from the runtime origin
  (without the network policy check), checked against `integrity`, and cached like registry tarballs;
- the unpacked `package.json` gets the requested `name` and `version` and
  `"_openvesselSource": "<compat package name>@<version>"`, with the compat package's own version (the
  requested one if its `pkg` has none);
- [WebAssembly substitutes](#webassembly-substitutes) are not applied.

If the deployment doesn't serve `compat/`, the native packages are installed as usual (and skipped by
the platform filter).

### pagefind

- Replaces: `@pagefind/linux-x64` `^1.0.0` (the binary package Pagefind's npm wrapper picks for linux/x64)
- Package: `@openvessel/pagefind-wasi` 1.5.2
- Source: `compat/pagefind/`
- Contents: `pagefind.wasm`, `bin/pagefind`, `bin/pagefind_extended`

`compat/pagefind/build.mjs` downloads the `pagefind` 1.5.2 crate from crates.io, applies
`compat/pagefind/wasi.patch` and runs
`cargo build --release --target wasm32-wasip1 --no-default-features` (stripped, LTO, one codegen unit).
It needs cargo and `rustup target add wasm32-wasip1`; the result is cached in `vendor/compat/pagefind/`.
The patch, for `target_os = "wasi"` only:

- uses a single-threaded tokio runtime (`current_thread`; features `rt`, `time`, `macros`, `sync`,
  `io-util`) instead of the multi-threaded one;
- writes output with `std::fs` (a small `wasi_fs` module with `create_dir_all` and `File`) instead of
  `tokio::fs`;
- runs indexing work inline instead of `spawn_blocking`;
- replaces the two stdin/stdout threads of `--service` mode with one loop: write every queued
  response, then block reading the next request (base64 JSON terminated by `,`); end of input exits 0;
  an undecodable message is answered with an error response.

`bin/pagefind` and `bin/pagefind_extended` are the same launcher: a `node:wasi` instance with
`args: ['pagefind', …argv]`, `env: process.env`, `preopens: { '/': '/', '.': process.cwd() }`,
`returnOnExit: true`, and `process.exitCode` set to the module's exit code. `pagefind_extended` runs the
same build as `pagefind`, so it doesn't have the extended build's CJK segmentation. The command line and the Node API
of the `pagefind` package (`createIndex()` and so on, which run the binary in `--service` mode) work as
with the native binary.

### cn-font-split

- Replaces: `cn-font-split` `^7.0.0`
- Package: `@openvessel/cn-font-split-wasi` 7.4.3
- Source: `compat/cn-font-split/`
- Contents: the published `cn-font-split` 7.4.3 package, with `dist/node/index.js` and
  `dist/node/index.mjs` replaced and `dist/libffi-wasm32-wasip1.wasm` added

`compat/cn-font-split/build.mjs` downloads `cn-font-split-7.4.3.tgz` from the npm registry and
`libffi-wasm32-wasip1.wasm` from the project's GitHub release 7.6.8. The manifest is the published one
without the `koffi` dependency, without the `postinstall` script (which downloads a native library) and
without `devDependencies`.

The upstream Node backend calls a native library through Koffi (FFI). The replacement `fontSplit(config)`
runs the same library's `wasm32-wasip1` build with `node:wasi`:

1. Reads `config.input` (a path, or bytes), converts `config.subsets` and serializes the config as the
   package's protobuf `InputTemplate`. No `outDir` → `Error('cn-font-split need outDir')`.
2. Creates a temporary directory (`os.tmpdir()/cn-font-split-XXXXXX`) with `fonts/<key>` (the config)
   and an empty `<key>/`, where `<key>` is random.
3. Runs the module with `args: [key]`, an empty `env`, `preopens: { '/tmp': <temporary directory> }`,
   `returnOnExit: true`, and no-op `pthread_mutex_init`/`lock`/`unlock`/`destroy` in the `env` import
   module. The compiled module is kept for later calls. `CN_FONT_SPLIT_BIN` overrides the path of the
   `.wasm` file.
4. A non-zero exit → `Error('cn-font-split exited with <code>')`.
5. Every file in `<key>/` is written to `outDir` with `config.outputFile` or `fs-extra`'s `outputFile`,
   and its name logged unless `config.silent`. The time is logged with `console.time`.
6. The temporary directory is removed.

Exports: `fontSplit`, `createAPI`, `decodeReporter`, `proto` (CommonJS and ESM). It runs
single-threaded.

### resvg-js

- Replaces: `@resvg/resvg-js` `^2.0.0` (a napi-rs package without a `wasm32-wasi` build)
- Package: `@openvessel/resvg-js-wasm` 2.6.2, depending on `@resvg/resvg-wasm` `2.6.2`
- Source: `compat/resvg-js/package/` (`index.js`, `index.d.ts`)

resvg-js is synchronous and reads font files itself; resvg-wasm initializes asynchronously and takes font
buffers. `index.js`:

- compiles resvg-wasm's CommonJS glue with an added synchronous initializer and instantiates
  `index_bg.wasm` when the module is required;
- `new Resvg(svg, options)`: `svg` is a string or `Buffer`; `options.font.fontFiles` and
  `options.font.fontDirs` (searched recursively for `.ttf`, `.otf`, `.ttc`, `.otc`, `.woff`, `.woff2`)
  are read into `fontBuffers` together with any given `fontBuffers`; `loadSystemFonts` is ignored (there
  are no system fonts); all other options go to resvg-wasm unchanged;
- `renderAsync(svg, options, signal)` returns a promise of `new Resvg(svg, options).render()`, rejecting
  if `signal` is already aborted.

Exports: `Resvg`, `renderAsync`. `index.d.ts` carries the resvg-js types.

```js
const { Resvg } = require('@resvg/resvg-js');
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', {
  font: { fontDirs: ['./fonts'] },
}).render().asPng();
```

### Adding a compat package

1. Put the package's own files in `compat/<id>/package/`. They are copied over the base (if any), and
   `package.json` is written from the entry's `pkg`.
2. If something has to be built or downloaded, add `compat/<id>/build.mjs` exporting
   `async function build(outDir)` that writes into `outDir` (`vendor/compat/<id>/`, outside git). It runs
   only when an artifact listed in the entry is missing; if it throws, the build prints
   `compat <id>: not built (<message>); <names> will stay unavailable` and skips the entry.
3. Add an entry to `COMPAT` in `scripts/build-compat.mjs`:

| Field | Meaning |
|---|---|
| `id` | directory name under `compat/` and `vendor/compat/`, and the tarball's name prefix |
| `names` | the npm package names it replaces (each gets an `index.json` entry) |
| `range` | the versions of those packages it replaces |
| `pkg` | the `package.json` object, or a function that receives the base's `package.json` and returns it; its `version` names the tarball |
| `artifacts` | optional `{ <path in vendor/compat/<id>>: <path in the package> }` copied into the package |
| `base` | optional directory in `vendor/compat/<id>/` to start from (e.g. an unpacked upstream package) |

4. Run `node scripts/build-compat.mjs` and check that `dist/runtime/compat/index.json` lists the
   package. Install the original package in OpenVessel and confirm `_openvesselSource` in its
   `package.json`.

```js
{
  id: 'example',
  names: ['example-native'],
  range: '^2.0.0',
  pkg: { name: '@openvessel/example-wasi', version: '2.1.0', main: 'index.js', license: 'MIT' },
  artifacts: { 'example.wasm': 'example.wasm' },
}
```

A compat package keeps the original's API: loaders and callers still `require` the original name. For a
binary that a wrapper package runs (as with Pagefind), name the compat package after the per-platform
package the wrapper picks for `linux`/`x64`.

## What can't work

Native code that has no WebAssembly build and no compat package can't run: `.node` addons in general,
FFI libraries such as Koffi, programs embedding their own engine such as `workerd`, and headless browsers.
Install scripts of dependencies are not run, so packages that download or compile a binary in
`postinstall` don't get it. See [Compatibility](../compatibility.md) for the list with reasons.
