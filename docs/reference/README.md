# OpenVessel reference

[日本語](README.ja.md)

The detailed technical documentation of OpenVessel: every option of the host API, the embedding and
deployment requirements, the wire protocols, and how each part of the system inside the tab works —
kernel, file system, processes, shell, package managers, native modules and the Node.js runtime.
It describes OpenVessel as it is in this repository (see `package.json` for the version, and
`openvessel.node` for the Node.js version it ports).

For an overview first, read [How OpenVessel works](../how-it-works.md); for what does and doesn't
work in a browser, [Compatibility](../compatibility.md).

## Getting started

| Page | Contents |
|---|---|
| [Getting started](getting-started.md) | From an empty page to `npm install`, `astro build` and a live preview: what to serve, the headers, the first `boot()`. |

## Embedding

| Page | Contents |
|---|---|
| [Host API](host-api.md) | `OpenVessel.boot()` and every option, files, processes, events, previews, errors. |
| [Network policy](network-policy.md) | Modes, presets, allow/deny patterns, the decision order and the permission prompt. |
| [Deployment](deployment.md) | The three origins, the files in `dist/`, every required header, hosts that can't set headers. |
| [Preview](preview.md) | How a dev server on a virtual port is shown in an iframe: HTTP and WebSocket bridging, URLs. |
| [Protocol](protocol.md) | The messages between the host page, the runtime, the preview and the processes. |

## Inside OpenVessel

| Page | Contents |
|---|---|
| [Kernel](kernel.md) | The kernel worker, system calls, virtual networking, outgoing HTTP, the initial system. |
| [File system](filesystem.md) | The in-memory file system: inodes, modes, links, errors, watchers. |
| [Processes](processes.md) | Processes, file descriptors, pipes, the terminal and signals. |
| [Shell and commands](shell.md) | `sh` grammar and built-ins, and every command with its options. |
| [Package managers](package-managers.md) | The built-in `npm`, `pnpm`, `yarn` and `bun`: commands, install, lockfiles, scripts. |
| [Native modules](native-modules.md) | WebAssembly builds, WASI, napi-rs and emnapi, compat packages. |
| [Node.js runtime](nodejs-runtime.md) | How Node.js runs in a worker: boot, event loop, modules, TypeScript, fetch, workers. |
| [Bindings](bindings.md) | Every `internalBinding()` module and its state. |

## Working on OpenVessel

| Page | Contents |
|---|---|
| [Building and maintaining](building.md) | The build scripts, generated data, following a Node.js release, releasing. |
| [Testing](testing.md) | Unit tests, end-to-end tests, Node.js's own test suite and the Astro corpus. |

## Stability

The host API (`dist/host` and its type declarations) and the embedding requirements are covered by
semantic versioning from 1.0.0. The internals described in the "Inside OpenVessel" pages and the
[Protocol](protocol.md) page may change in any release; see the [changelog](../../CHANGELOG.md).
