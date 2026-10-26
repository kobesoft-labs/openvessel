# Building and maintaining

[日本語](building.ja.md)

This page covers how OpenVessel is built from source and kept up to date: prerequisites, the npm scripts,
every build script and what it reads and writes, how to follow a new Node.js release, and how releases
are cut. Running the tests is in [Testing](testing.md).

## Prerequisites

| Tool | Needed for |
|---|---|
| Node.js and npm | everything. The unit-test bundle targets `node22`; `npx -y node@<pinned version>` is fetched by the fixture and baseline scripts, so they need network access to the npm registry |
| Docker (able to run `linux/amd64` images) | `scripts/gen-node-data.mjs`, `scripts/gen-builtins.mjs` and `scripts/node-upgrade-check.mjs` — once per Node version, to create `vendor/node/`, `src/node/data/` and `src/shared/builtin-exports.json` |
| `curl` | `gen-node-data.mjs` (downloads Node's `LICENSE`), the zlib WebAssembly build |
| Rust (`cargo`) with `rustup target add wasm32-wasip1` | rebuilding the Pagefind compat package when `vendor/compat/pagefind/` is missing |
| LLVM `clang` with the wasm32 target and `wasm-ld` | only to rebuild the brotli/zstd WebAssembly (`src/nodejs/bindings/zlib/wasm/build.mjs`) |
| Google Chrome | the end-to-end tests, Node's test suite and the corpus (driven through `playwright-core` with `channel: 'chrome'`) |
| `git` | `test/node-compat/fetch.mjs` (sparse clone of nodejs/node) |
| GitHub CLI `gh`, authenticated | `corpus/collect.mjs` (also to restore `corpus/sites/` in a fresh clone), and `gh release create` when releasing |

A fresh checkout builds like this:

```bash
npm install
node scripts/gen-node-data.mjs   # once (Docker): vendor/node/ and src/node/data/
npm run build                    # dist/
npm run serve                    # host :5170, runtime :5171, preview :5172
```

## npm scripts

| Script | Command | What it does |
|---|---|---|
| `build` | `node scripts/build.mjs` | full build into `dist/` |
| `dev` | `node scripts/build.mjs --watch & node scripts/serve.mjs` | rebuild on change and serve |
| `serve` | `node scripts/serve.mjs` | serve `dist/` on three origins |
| `test` | `node scripts/test.mjs` | unit tests ([Testing](testing.md)) |
| `typecheck` | `tsc --noEmit -p .` | type-checks `src/`, `test/` and `playground/` (`tsconfig.json`) |
| `build:types` | `node scripts/build-types.mjs` | emits the host API's declarations into `dist/types/` |

## scripts/build.mjs

Bundles everything with esbuild. Flags:

| Flag | Effect |
|---|---|
| (none) | deletes `dist/`, copies the static files, runs all esbuild builds once, then generates `nodelib.js`, copies amaro and builds the compat packages |
| `--watch` | does **not** delete `dist/`; copies the static files and starts an esbuild watch context per entry. `nodelib.js`, `amaro.js` and the compat packages are not (re)generated in this mode, so a previous full build must have produced them |
| `--minify` | minifies every bundle |

Common esbuild options: `bundle`, `sourcemap: 'linked'`, `target: 'es2022'`, `platform: 'browser'`,
`legalComments: 'none'`, `define: { global: 'globalThis' }`. The legacy runtime and the other bundles
alias `events`, `process`, `string_decoder` and `abort-controller` to the shims in `src/node/` and resolve
`process/`, `string_decoder/` and `cjs-module-lexer/lexer.js` through a small plugin; the ported runtime's
bundles use no aliases.

| Entry | Source | Output | Format |
|---|---|---|---|
| `kernel` | `src/kernel/index.ts` | `dist/runtime/kernel.js` | ESM, code splitting into `dist/runtime/chunks/[name]-[hash].js` |
| `process` | `src/node/worker.ts` | `dist/runtime/process.js` (legacy runtime) | ESM, shares chunks with `kernel` |
| `runtime` | `src/runtime/runtime.ts` | `dist/runtime/runtime.js` | IIFE |
| `sw` | `src/runtime/sw.ts` | `dist/runtime/sw.js` (runtime service worker) | IIFE |
| `node-process` | `src/nodejs/boot.ts` | `dist/runtime/node-process.js` (ported runtime); `./nodelib.js` stays an external import | ESM |
| `ts-strip` | `src/nodejs/ts-strip.ts` | `dist/runtime/ts-strip.js` (sucrase, for `require(esm)`) | IIFE |
| `relay`, `inject` | `src/preview/relay.ts`, `src/preview/inject.ts` | `dist/preview/__ov/relay.js`, `dist/preview/__ov/inject.js` | IIFE |
| `__ov-sw` | `src/preview/sw.ts` | `dist/preview/__ov-sw.js` (at the preview's root, so it controls the whole origin without a `Service-Worker-Allowed` header) | IIFE |
| `index` | `src/host/index.ts` | `dist/host/index.js` (the package's `main`) | ESM |
| `app` | `playground/app.ts` | `dist/playground/app.js` (CSS through the `css` loader) | ESM |

Static files copied: `src/runtime/runtime.html` → `dist/runtime/runtime.html`,
`src/preview/relay.html` → `dist/preview/__ov/relay.html`, `playground/index.html` and `playground/app.css`
→ `dist/playground/`, `node_modules/@xterm/xterm/css/xterm.css` → `dist/playground/xterm.css`.

After the esbuild builds (full build only):

| Step | Output |
|---|---|
| `genNodeLib()`, if `vendor/node/natives.json` exists | `dist/runtime/nodelib.js` and `dist/runtime/NODE-LICENSE.txt` (Node's `LICENSE`, with the notices of its bundled dependencies). If `vendor/node` is missing the build prints `vendor/node missing: run node scripts/gen-node-data.mjs to build the ported Node runtime` and the ported runtime can't start |
| copy amaro | `node_modules/amaro/dist/index.js` → `dist/runtime/amaro.js`; `dist/runtime/AMARO-LICENSE.txt` (amaro's and swc's licenses) |
| `buildCompat()` | `dist/runtime/compat/*.tgz` and `dist/runtime/compat/index.json` |

The build ends with `built dist/`.

## Node data

### gen-node-data.mjs

`node scripts/gen-node-data.mjs` extracts everything OpenVessel needs from a real Node.js of the pinned
version (`NODE_VERSION` in `src/node/version.ts`). It runs a dumper script on stdin inside the official
image:

```bash
docker run --rm -i --platform linux/amd64 --hostname openvessel -e HOME=/home/user \
  node:<version>-bookworm-slim node --expose-internals --no-warnings -
```

The Linux x64 image is used because OpenVessel reports itself as Linux x64, so errno, signal and `O_*`
values match the kernel's. The dumper calls `internalBinding()` for a fixed list of 68 binding names (a name that doesn't exist in
that version is recorded as `__missing`) and records each one's shape; it also records `internalBinding('builtins').natives` and process data.

| Output | Contents | In git |
|---|---|---|
| `vendor/node/natives.json` | every builtin's source (`lib/` and `deps/`), exactly as Node embeds them | no |
| `vendor/node/lib/<id>.js` | the same sources as files, for reading and grepping | no |
| `vendor/node/LICENSE` | Node's license, downloaded from `raw.githubusercontent.com/nodejs/node/v<version>/LICENSE` with `curl` | no |
| `src/node/data/bindings.json` | each binding's constants and API shape (functions, classes and their prototype methods, typed arrays, maps, symbols), plus `uv.__errmap` | yes |
| `src/node/data/process.json` | `versions`, `release`, `features`, `config`, `optionValues`, `optionInfo` (options and aliases), `embedderOptions`, `envSettings`, `types`, `builtinCategories`, and `globals` (each global name after bootstrap → enumerable) | yes |

Shape encoding (read back by `src/nodejs/bindings/shape.ts`, see [Bindings](bindings.md)): functions
become `{ __fn, proto?, statics? }`, typed arrays `{ __typed, length, values? }` (values only up to 64
elements), and `__num`, `__bigint`, `__symbol`, `__map`, `__set`, `__ref`, `__object`, `__array`,
`__throws` and `__missing` mark the other cases; deeply nested values are cut off (`__object`,
`__array`). What running the dumper itself
changed is undone (`--expose-internals`, `--no-warnings` and `--require` reset; the stdin script's
globals `__filename`, `__dirname`, `module`, `exports`, `require`, `shape` removed from `globals`).
It prints `node v<version>: <n> builtins, <m> bindings`.

### gen-nodelib.mjs

Called by `build.mjs` (or run alone: `node scripts/gen-nodelib.mjs`, writing
`dist/runtime/nodelib.js` and printing `{ count, bytes, overrides }`). It reads
`vendor/node/natives.json`, replaces every builtin that has a file under `src/nodejs/overrides/<id>.js`
(see [Node.js runtime](nodejs-runtime.md#overrides)), leaves out `internal/deps/v8/tools/*` (V8's
profiler tools), and writes one ES module:

```js
// Generated by scripts/gen-nodelib.mjs from Node.js 22.23.4 — see vendor/node/LICENSE.
export const ids = [/* every builtin id, sorted */];
export const params = { 'fs': 'exports, require, module, process, internalBinding, primordials', /* … */ };
export const sources = { 'fs': '…source text…', /* … */ };
```

Sources are kept as strings and compiled one at a time on first use; see
[Node.js runtime](nodejs-runtime.md#nodelibjs-and-lazy-compilation). (`ids` still lists the skipped
`internal/deps/v8/tools/*` ids; they have no `params` or `sources` entry.)

### Other generators

| Script | Reads | Writes | When |
|---|---|---|---|
| `scripts/gen-builtins.mjs` | the pinned version's `module.builtinModules` plus the `node:`-only modules (`sea`, `sqlite`, `test`, `test/reporters`) and each module's export names, from Node in the official `node:<version>-bookworm-slim` image (linux/amd64, Docker) like `gen-node-data.mjs` | `src/shared/builtin-exports.json` (named exports of builtin facades, used by the kernel's ESM service for the legacy runtime) | after a Node upgrade |
| `scripts/vendor-node-path.mjs [path/to/lib/path.js]` | Node's `lib/path.js` (default `vendor/node/lib/path.js`, the pinned version's, written by `gen-node-data.mjs`) | `src/shared/node-path.ts` (primordials turned into plain calls; `process.cwd()`/`process.env` and `glob` wired to OpenVessel) | after a Node upgrade if `lib/path.js` changed |
| `scripts/regen-fixtures.mjs [name…]` | real Node of the pinned version (`npx -y node@<version>`) | `test/unit/fixtures/*.json`, the ICU width table in `src/nodejs/bindings/icu.ts`, `src/nodejs/bindings/crypto/tables.ts` | after a Node upgrade ([Testing](testing.md)) |
| `src/nodejs/bindings/zlib/wasm/build.mjs` | brotli 1.1.0 and zstd 1.5.7 release tarballs (sha256-checked), `node-brotli.patch` | `src/nodejs/bindings/zlib/brotli-wasm.ts`, `zstd-wasm.ts` (raw-deflated, base64; committed) | only to change library versions or build flags. Needs `clang`/`wasm-ld`; override with `CLANG`, `WASM_LD`; work directory `WORK_DIR` (default `<tmp>/ov-zlib-wasm`) |

## Compat packages

`scripts/build-compat.mjs` (also run by `build.mjs`; alone: `node scripts/build-compat.mjs`, which prints
`compat: <names>`) builds stand-ins for npm packages that only ship native binaries. The npm installer
installs them in place of the native package, keeping the requested name and version (see
[Native modules](native-modules.md)).

```text
compat/<id>/package/    the package's own files (package.json is generated)
compat/<id>/build.mjs   optional: builds artifacts into vendor/compat/<id>/ (cached, not in git)
```

| Id | Replaces | Range | Published as | Artifacts |
|---|---|---|---|---|
| `pagefind` | `@pagefind/linux-x64` | `^1.0.0` | `@openvessel/pagefind-wasi` 1.5.2 | `pagefind.wasm`: the `pagefind` 1.5.2 crate from crates.io with `compat/pagefind/wasi.patch`, `cargo build --release --target wasm32-wasip1 --no-default-features` (strip, LTO, one codegen unit) |
| `cn-font-split` | `cn-font-split` | `^7.0.0` | `@openvessel/cn-font-split-wasi` (version of the upstream package, 7.4.3) | the published package 7.4.3 from the npm registry plus `libffi-wasm32-wasip1.wasm` 7.6.8 from the project's GitHub release; the `koffi` dependency and the `postinstall` script are removed |
| `resvg-js` | `@resvg/resvg-js` | `^2.0.0` | `@openvessel/resvg-js-wasm` 2.6.2, depending on `@resvg/resvg-wasm` 2.6.2 | none |

For each package: if an artifact is missing from `vendor/compat/<id>/` and a `build.mjs` exists, it runs;
if that fails the build prints `compat <id>: not built (<reason>); <names> will stay unavailable` and goes
on without it. The files are staged under a `package/` directory and packed as ustar
(`tar -czf <id>-<version>.tgz --format ustar`, with `COPYFILE_DISABLE=1`). `index.json` maps each replaced
name to `{ range, file, integrity, pkg }`, where `integrity` is the tarball's `sha512-…`.

## Type declarations

`node scripts/build-types.mjs` deletes `dist/types/`, runs `npx tsc -p tsconfig.types.json`
(declarations only, for `src/host/index.ts` and what it imports) and rewrites `.ts` import specifiers in
the emitted `.d.ts` files to `.js`. Run it **after** `npm run build`, because a full build deletes `dist/`.
`package.json` points `types` at `dist/types/host/index.d.ts`.

## Local server: serve.mjs

`node scripts/serve.mjs` serves `dist/` on three origins, bound to `127.0.0.1`:

| Site | Port | Directory | Headers |
|---|---|---|---|
| host | `OV_HOST_PORT`, else `OV_PORT_BASE` (default 5170) | `dist/playground` | COOP `same-origin`, COEP `require-corp`, CORP `same-origin` |
| runtime | `OV_RUNTIME_PORT`, else base + 1 | `dist/runtime` | COOP, COEP, CORP `cross-origin`, and a CSP: `default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; connect-src 'self' data: blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors http://localhost:<host port>` — except on `/sw.js`, the network gate, which must not inherit `connect-src 'self'` |
| preview | `OV_PREVIEW_PORT`, else base + 2 | `dist/preview` | COOP, COEP, CORP `cross-origin`, `Service-Worker-Allowed: /` |

Every response has `cache-control: no-cache`; a path ending in `/` serves `index.html`; content types
cover `.html`, `.js`, `.mjs`, `.css`, `.map`, `.json`, `.wasm`, `.svg`, `.png` (else
`application/octet-stream`); missing files get `404 not found` with the site's headers. It logs one line
per site (`playground: http://localhost:5170/` …). `OV_PORT_BASE` lets several servers (and test runs)
share a machine. What a production deployment needs is in [Deployment](deployment.md).

## Following a Node.js release

The Node version OpenVessel ports is pinned in one place, `NODE_VERSION` in `src/node/version.ts`;
`package.json` repeats it as `openvessel.node`. [NODE-VERSION.md](../NODE-VERSION.md) (Japanese) keeps
the current version and the history.

1. **See what changes.** `node scripts/node-upgrade-check.mjs <new version>` dumps the target version with
   the same Docker dumper and compares it with the pinned data (`vendor/node`, `src/node/data`). It writes
   `docs/node-upgrades/<current>-to-<new>.md` with these sections:
   - *Builtins (lib/)*: added, removed and changed builtins, with lines removed/added; a changed file
     whose new lines call `internalBinding(` is marked **(binding use changed)**;
   - *Bindings*: per binding, members added, removed or changed in kind (`function`, `class(methods)`,
     typed array and length, symbol, or the value);
   - *CLI options*: added, removed, defaults changed;
   - *process.versions*: bundled dependency versions that changed.
   It prints a one-line summary. Without a version it prints `usage: node scripts/node-upgrade-check.mjs <version>` and exits with 1.
   Signature changes that keep a member's name (for example `ModuleWrap.link()` in 22.23) don't show up
   in the report.
2. Set the version in `src/node/version.ts` (and `openvessel.node` in `package.json`).
3. Regenerate the data and expectations:
   ```bash
   node scripts/gen-node-data.mjs     # vendor/node, src/node/data (Docker)
   node scripts/gen-builtins.mjs      # src/shared/builtin-exports.json (Docker)
   node scripts/vendor-node-path.mjs  # src/shared/node-path.ts, if lib/path.js changed
   node scripts/regen-fixtures.mjs    # binding fixtures from real Node of the new version
   node test/node-compat/fetch.mjs    # Node's tests at the same version
   ```
4. Bring `src/nodejs/bindings/` up to the binding changes in the report, and check that the files in
   `src/nodejs/overrides/` still fit the new `lib/`.
5. Rebuild and measure:
   ```bash
   node scripts/build.mjs
   node test/node-compat/run.mjs --baseline
   node test/node-compat/run.mjs --port && node test/node-compat/run.mjs --port --report
   node corpus/run.mjs --port
   ```
   The numbers must not drop below the previous version's ([Testing](testing.md)).
6. Update the current version and the history in `docs/NODE-VERSION.md`.

The previous upgrade's report is [node-upgrades/22.20.0-to-22.23.4.md](../node-upgrades/22.20.0-to-22.23.4.md).

## Releasing

The full procedure is [RELEASING.md](../RELEASING.md). In short:

- Versions are OpenVessel's own semver; the ported Node version appears in the release title
  (`OpenVessel <version> — Node.js <node>`), the notes and `package.json` → `openvessel.node`. A fix or a
  Node patch release is a patch; a feature or a Node minor release is a minor; breaking the host API or
  the embedding requirements, or a new Node major, is a major.
- Releases are built on a maintainer's machine (the build needs `vendor/` and the cached compat
  packages), from `main`: set the version in `package.json` and `package-lock.json`, check
  `openvessel.node`, add a `CHANGELOG.md` section, then
  `npm run build && node scripts/build-types.mjs && npm run typecheck && npm test`; re-run Node's suite
  and the corpus if the runtime changed and update the numbers in `README.md` and
  `docs/compatibility.md`; `npm pack`; commit `Release <version>`, tag `v<version>`, push both;
  `gh release create v<version> openvessel-<version>.tgz --title "OpenVessel <version> — Node.js <node>"`
  (`--prerelease` for a release candidate); optionally `npm publish --provenance --access public` of the
  same tarball.
- The published package contains `dist/` only (`files` in `package.json`). Covered by semver: the host
  API in `dist/host` with its declarations and the three-origin embedding requirements; not covered:
  `src/`, the files inside `dist/runtime` and `dist/preview`, the compat packages' contents.

## Repository layout

| Path | Contents | In git |
|---|---|---|
| `src/host/` | the host API (`OpenVessel.boot`, …) — [Host API](host-api.md) | yes |
| `src/kernel/` | the kernel: VFS, processes, pipes, TTY, sockets, `sh`, coreutils, npm, ESM service, virtual ports, outbound HTTP | yes |
| `src/nodejs/` | the ported Node.js runtime: `boot.ts`, `loop.ts`, `options.ts`, `env.ts`, `fetch.ts`, `typescript.ts`, `bindings/`, `overrides/` | yes |
| `src/node/` | the legacy runtime; also `version.ts` (the pinned Node version), `data/` (dumped Node data), and modules the ported runtime reuses (`sys.ts`, `native.ts`, `wasi.ts`) | yes |
| `src/runtime/` | the runtime iframe page and its service worker | yes |
| `src/preview/` | the preview relay, injected script and service worker | yes |
| `src/shared/` | code shared by kernel, runtime and host (path, resolver, policy, errno, sync channel) | yes |
| `playground/` | the development playground served on the host port | yes |
| `compat/` | compat package sources | yes |
| `scripts/` | build, data, serve and test scripts | yes |
| `test/unit/`, `test/fixtures-gen/` | unit tests and fixture generators | yes |
| `test/e2e/` | end-to-end scripts (headless Chrome) | yes |
| `test/node-compat/` | runner for Node's own tests, `limits/`; `.node/` and `results/` are not in git | partly |
| `corpus/` | the Astro site list and runner; `sites/` and run logs are not in git | partly |
| `docs/` | documentation; `docs/node-upgrades/` holds upgrade reports | yes |
| `vendor/` | `vendor/node/` (Node's sources, license), `vendor/compat/` (built compat artifacts) | no |
| `dist/` | build output | no |

## Related pages

- [Testing](testing.md)
- [Bindings](bindings.md), [Node.js runtime](nodejs-runtime.md)
- [Deployment](deployment.md), [Native modules](native-modules.md)
