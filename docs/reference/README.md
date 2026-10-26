# OpenVessel reference

[日本語](README.ja.md)

This is the detailed technical documentation for OpenVessel. It covers every option of the host API, the
embedding and deployment requirements, the wire protocols, and how each part of the system inside the tab
works: the kernel, file system, processes, shell, package managers, native modules and the Node.js runtime.
It describes OpenVessel as it is in this repository (see `package.json` for the version, and
`openvessel.node` for the Node.js version it ports).

If you want an overview first, read [How OpenVessel works](../how-it-works.md). For what does and doesn't
work in a browser, see [Compatibility](../compatibility.md).

## Getting started

[Getting started](getting-started.md) goes from an empty page to `npm install`, `astro build` and a live
preview. It covers what to serve, the headers and the first `boot()`.

## Embedding

- [Host API](host-api.md): `OpenVessel.boot()` and every option, files, processes, events, previews, errors.
- [Network policy](network-policy.md): modes, presets, allow/deny patterns, the decision order and the
  permission prompt.
- [Deployment](deployment.md): the three origins, the files in `dist/`, every required header, hosts that
  can't set headers.
- [Preview](preview.md): how a dev server on a virtual port is shown in an iframe, HTTP and WebSocket
  bridging, URLs.
- [Protocol](protocol.md): the messages between the host page, the runtime, the preview and the processes.

## Inside OpenVessel

- [Kernel](kernel.md): the kernel worker, system calls, virtual networking, outgoing HTTP, the initial system.
- [File system](filesystem.md): the in-memory file system, with inodes, modes, links, errors and watchers.
- [Processes](processes.md): processes, file descriptors, pipes, the terminal and signals.
- [Shell and commands](shell.md): `sh` grammar and built-ins, and every command with its options.
- [Package managers](package-managers.md): the built-in `npm`, `pnpm`, `yarn` and `bun`, with commands,
  install, lockfiles and scripts.
- [Native modules](native-modules.md): WebAssembly builds, WASI, napi-rs and emnapi, compat packages.
- [Node.js runtime](nodejs-runtime.md): how Node.js runs in a worker, covering boot, the event loop, modules,
  TypeScript, fetch and workers.
- [Bindings](bindings.md): every `internalBinding()` module and its state.

## Working on OpenVessel

- [Building and maintaining](building.md): the build scripts, generated data, following a Node.js release,
  releasing.
- [Testing](testing.md): unit tests, end-to-end tests, Node.js's own test suite and the Astro corpus.

## Stability

The host API (`dist/host` and its type declarations) and the embedding requirements follow semantic
versioning from 1.0.0. The internals described in the "Inside OpenVessel" pages and the
[Protocol](protocol.md) page may change in any release; see the [changelog](../../CHANGELOG.md).
