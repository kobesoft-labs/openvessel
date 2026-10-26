# Changelog

OpenVessel follows [Semantic Versioning](https://semver.org). Each release states the Node.js
version it ports; see [docs/NODE-VERSION.md](docs/NODE-VERSION.md) for how that version is tracked.

## 1.1.1 — 2026-10-26 · Node.js v22.23.4

- Fix: `npm install` could pick a `@napi-rs/wasm-runtime` whose emnapi peer doesn't match the emnapi a
  WebAssembly binding pins (wasm-runtime 1.2.6 with rolldown's binding: rolldown, and so Astro 7, failed to
  load). The installer now takes the newest release in the binding's range whose peer accepts that emnapi.

## 1.1.0 — 2026-10-25 · Node.js v22.23.4

- The class returned by `spawn()` is now `Process` (was `VesselProcess`). Only the entry point keeps the
  product name; every type reachable from it has a neutral name. `VesselProcess` stays as a deprecated alias.

## 1.0.0 — 2026-10-25 · Node.js v22.23.4

First stable release.

- Runs Node.js v22.23.4's own `lib/` in a browser tab; the C++ half (`internalBinding()`) is
  re-implemented in TypeScript on a small kernel (file system, processes, pipes, TTY, sockets, `sh`).
- `npm`, `pnpm`, `yarn` and `bun` clients, installing real projects from the npm registry.
- Astro 7, 6 and 5: `install`, `build` and `dev` with hot module replacement, previewed in an iframe.
  131 of a corpus of 147 real sites build.
- Node's own test suite: 1237 of the 1237 tests a browser can pass (34 more are listed with the reason).
- Native packages are installed as their WebAssembly builds; compat packages cover Pagefind,
  resvg-js and cn-font-split.
- Outgoing network goes through one policy gate (`ask`, `allowlist`, `allow-all`); servers use
  virtual ports and are never reachable from outside.
- Host API (`OpenVessel.boot`, `mount`, `export`, `spawn`, `exec`, `ps`, `ports`, `on`,
  `createPreview`, `previewUrl`, `teardown`) with TypeScript declarations.

### Stability

From 1.0.0 the host API (`dist/host`, with its declarations) and the three-origin embedding
requirements are covered by semver. Not covered: `src/` internals, the files inside `dist/runtime`
and `dist/preview`, and the contents of the compat packages.
