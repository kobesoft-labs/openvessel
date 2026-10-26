# Testing

[日本語](testing.ja.md)

OpenVessel has four layers of tests: unit tests run by Node.js (including differential tests of the
bindings against real Node), end-to-end scripts that drive the playground in headless Chrome, Node.js's own
test suite run inside OpenVessel, and a corpus of real Astro sites. Below are the runners with their
arguments, environment variables, timeouts and result files, followed by how to add tests.

| Suite | Runner | Needs | Typical command |
|---|---|---|---|
| Unit | `scripts/test.mjs` | Node.js | `npm test` |
| End to end | `test/e2e/*.mjs` | a build (`dist/`), Google Chrome | `node test/e2e/harness.mjs 'node -v'` |
| Node's test suite | `test/node-compat/run.mjs` | a build, Chrome, `test/node-compat/.node/` | `node test/node-compat/run.mjs --port fs` |
| Astro corpus | `corpus/run.mjs` | a build, Chrome, `corpus/sites/`, network | `node corpus/run.mjs basics` |

Don't rebuild `dist/` while a browser suite is running: the running tests would load a mix of old and new
files.

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `OV_PORT_BASE` | `scripts/serve.mjs`, `test/e2e/harness.mjs` | the three server ports become base, base + 1, base + 2 (default 5170), and the browser profile becomes `node_modules/.cache/ov-chrome-<base>` (`ov-chrome` for 5170), so several suites can run side by side |
| `OV_HOST_PORT`, `OV_RUNTIME_PORT`, `OV_PREVIEW_PORT` | `scripts/serve.mjs` | set one port individually. The harness only knows `OV_PORT_BASE`, so don't use these with the test scripts |
| `HEADED` | `harness.mjs` (direct use), `project.mjs`, `dev.mjs`, `preview-port.mjs` | non-empty: show the browser window |
| `OV_CONSOLE` | `harness.mjs` | non-empty: print the page's console messages as `[console.<type>] <text>` (page errors are always printed as `[pageerror] …`) |
| `OV_TRACE` | `harness.mjs` | non-empty: turn on the kernel's trace (`debug.trace`), which logs `[trace]` lines to the console for spawns, pipe closes, EOF on reads and synchronous reads of fd 0 (visible with `OV_CONSOLE=1`) |
| `SETUP` | `run-file.mjs` | a command line run before the file is written |
| `PRINT` | `port-fs.mjs` | non-empty: print every scenario's actual output |
| `OV_TIMING` | the ported runtime | inside OpenVessel, not on the host: print boot timings ([Node.js runtime](nodejs-runtime.md#ov_timing)) |

## Unit tests

`npm test` runs `scripts/test.mjs`:

1. Collects `test/unit/*.test.ts` (an optional first argument keeps only files whose name contains it:
   `npm test -- zlib`).
2. Bundles them with esbuild into `node_modules/.cache/ov-tests/*.mjs` (`platform: 'node'`, ESM,
   `target: 'node22'`, inline source maps, npm packages left external). The directory is deleted first.
3. Runs `node --enable-source-maps --test <files>` and exits with its status.

| File | What it tests |
|---|---|
| `bindings-*.test.ts` | the bindings against fixtures recorded from real Node; see [Bindings](bindings.md#testing-bindings-against-real-node) |
| `bindings-v8.test.ts` | `internalBinding('v8')` fills the buffers `lib/v8.js` reads; `heap_utils` reports snapshots as unavailable |
| `npm-wasm-runtime.test.ts` | `pickWasmRuntime` (choosing a `@napi-rs/wasm-runtime` whose emnapi peer matches the binding) |
| `policy.test.ts` | the network policy's `decide`/`normalizePolicy` (presets, ask, allowlist, deny wins, only http(s) leaves) |
| `resolve.test.ts` | the module resolver (CJS lookup, `exports` conditions and patterns, `imports`, query strings) |
| `semver.test.ts` | the npm client's semver (ranges, prereleases, `maxSatisfying`, `minVersion`) |
| `sh.test.ts` | the shell and coreutils on a kernel without workers (`helpers.ts`: `makeKernel()`, `run()`) |

Helpers: `helpers.ts` (a `Kernel` with `sh`, `bash` and coreutils registered; `run(kernel, script, cwd,
argv)` returns `{ stdout, stderr, code }`), `binding-fixtures.ts` (`compareFixtures`), and
`zlib-loop-shim.ts`, imported first by `bindings-zlib.test.ts` so the event loop's `MessageChannel`
doesn't keep the test process alive.

### Regenerating fixtures

`node scripts/regen-fixtures.mjs [name…]` resolves the pinned Node with
`npx -y node@<version> -p process.execPath` and runs each generator under it with
`--expose-internals --no-warnings`, printing `<name>… ok` per job and
`fixtures recorded from node v<version>`. Jobs: `encoding`, `string_decoder`, `url`, `icu`,
`icu-width-table`, `http_parser`, `zlib`, `serdes`, `histogram`, `crypto`, `crypto-asym`,
`crypto-tables`. Every generator refuses to run under another Node version
(`run with node@<version> (got <version>)`).

## End-to-end scripts

All scripts in `test/e2e/` use `harness.mjs`. They start `scripts/serve.mjs` (using `OV_PORT_BASE`), launch
the system Chrome through `playwright-core` (`channel: 'chrome'`, persistent profile, `--js-flags=--stack-size=4000`),
open the playground at `http://localhost:<base>/`, wait for `window.ovReady`, and use the playground's
`window.ov` (an `OpenVessel` instance). The playground mounts a sample Astro 5 project at
`/home/user/app`. Runs use the ported runtime unless the command writes `legacy` to `/etc/openvessel/node`
(see [Node.js runtime](nodejs-runtime.md#selecting-the-runtime)).

`harness.mjs` exports:

| Function | Does |
|---|---|
| `startServer()` | spawns `scripts/serve.mjs` and resolves once it prints |
| `openBrowser({ headless = true, profile })` | launches Chrome, opens the playground, waits for `ovReady`; `OV_CONSOLE`, `OV_TRACE` apply |
| `exec(page, cmd, { cwd = '/home/user/app', timeout = 600000, allowAll = true })` | sets the network policy to `allow-all` (unless `allowAll: false`), runs `ov.exec(cmd, { cwd })`, returns `{ code, output, ms }` |
| `useLegacyRuntime(page)` | writes `legacy` to `/etc/openvessel/node`, so node processes started after it run on the legacy runtime |
| `usePortedRuntime(page)` | writes `port` to `/etc/openvessel/node`; the ported runtime is the default, so this only makes the choice explicit |

| Script | Arguments | What it does |
|---|---|---|
| `harness.mjs` | `[command]` (default `echo hello; node -e "console.log(process.version)"`) | runs one command line, prints its output and `[exit <code> in <ms>ms]` |
| `run-file.mjs` | `<local file> <vfs path> '<command>'` | runs `SETUP` if set, writes the local file into the VFS, runs the command |
| `watch.mjs` | `[--mount <dir>] '<command>' [seconds=20]` | spawns `/bin/sh -c <command>` (cwd `/home/user`, or `/home/user/app` with `--mount`, which copies a local project there first), streams the output every 200 ms, prints `[exit <code>]`, or `[still running after <n>s] ps:` and the process list when time runs out |
| `project.mjs` | `<dir> ['<command>']` (default `npm install && npm run build`) | replaces `/home/user/app` with a local project and runs the command (15-minute timeout). Skips `node_modules`, `.git`, `dist`, `.astro`, `.vercel`, `.netlify`, `.cache`, `.turbo`, `.output` and files over 64 MiB; keeps symlinks. Exports `collectFiles()` and `mountProject()` |
| `dev.mjs` | `[--legacy]` | `npm install` in `/home/user/app`, spawns `npm run dev`, waits for `server-ready`, checks the preview's `<h1>`, edits `src/pages/index.astro` and waits up to 30 s for the HMR update |
| `preview-port.mjs` | — | on the ported runtime: starts an `http` server on port 4000, loads it in the preview iframe (a 70000-byte chunked body) and POSTs to it from the iframe; prints `OK` or `FAIL` and exits 0/1 |
| `port-fs.mjs` | `[scenario…]` | on the ported runtime: runs the fs scenarios `dir`, `watch`, `watch2`, `cp`, `cp2`, `misc`, `misc2` (opendir/Dir, `fs.watch`, `fs.watchFile`, `fs.cp`/`cpSync`, readv/writev, FileHandle) and compares each output with the expected output recorded from Node v22.23.4 on Linux (`node:22.23.4-bookworm-slim` in Docker); prints `ok`/`FAIL` with a line diff, `all passed` or `<n> failed`, exits 0/1 |
| `esm-graph.mjs` | `[--port] <project dir> <entry path in VFS> [install command='npm install']` | mounts a project, installs, then walks the ES module graph the kernel serves under `/__ov/esm` (the legacy runtime's ESM service) and reports modules that don't load |
| `debug-esm.mjs` | `[--port] <vfs path…>` | runs `npm install`, then prints the first 3000 characters of `/__ov/esm<path>` for each path |

`dev.mjs` runs on the ported runtime; `--legacy` switches to the legacy runtime before anything runs, with
`useLegacyRuntime(page)` from `harness.mjs`. `esm-graph.mjs` and `debug-esm.mjs` work the other way round:
the ESM service they read is only used by the legacy runtime, so they select it with `useLegacyRuntime(page)`
unless `--port` is given, in which case the install runs on the ported runtime.

```bash
OV_PORT_BASE=5270 node test/e2e/harness.mjs \
  'mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node; node -p process.versions.node'
HEADED=1 node test/e2e/project.mjs ~/sites/blog 'npm install && npm run build'
node test/e2e/watch.mjs --mount ~/sites/blog 'npm run dev' 60
```

## Node's test suite

`test/node-compat/run.mjs` runs Node.js's own `test/parallel` tests inside OpenVessel and compares them
with real Node. What the numbers mean and the current results are on the
[Compatibility](../compatibility.md) page.

### Getting the tests

`node test/node-compat/fetch.mjs` sparse-clones `nodejs/node` at tag `v<NODE_VERSION>` into
`test/node-compat/.node/` (`git clone --depth 1 --filter=blob:none --sparse`), checking out only
`test/common`, `test/parallel` and `test/fixtures`; an existing checkout is moved to the pinned tag. It
writes `.node/package.json` as `{ "private": true, "type": "commonjs" }` so the repository's
`"type": "module"` doesn't apply to Node's CommonJS tests.

### Selection

A test is selected when its file name, without `test-` and the `.js`/`.mjs` extension, is one of these
module names or starts with one followed by `-` (the longest match wins): `fs`, `path`, `events`,
`event-emitter`, `eventemitter`, `stream`, `stream2`, `stream3`, `readable`, `buffer`, `util`, `worker`, `crypto`, `child-process`, `url`, `whatwg-url`,
`string-decoder`, `zlib`, `timers`, `process`, `module`, `require`, `readline`, `os`, `querystring`,
`assert`, `abortcontroller`, `console`, `vm`, `async-local-storage`, `next-tick`, `promises`,
`microtask`, `queue-microtask`, `wasi`.

A selected test is skipped when its source matches any of: `expose-internals`/`expose_internals`,
`internalBinding`, `--expose-gc`, `common/inspector`, `--inspect`, `--cpu-prof`, `--heap-prof`, `--prof`,
`--trace-`, `--report`, `--diagnostic`, `--allow-natives-syntax`, `--max-old-space`,
`--abort-on-uncaught`, `common/sea`, `common/v8`, `v8.setFlagsFromString`, `--experimental-permission`,
`--permission`, `process.binding`, `--snapshot`, `--build-snapshot`, `--frozen-intrinsics`, `--icu`,
`common/shared-lib-util`, `common/wpt`, `common/benchmark`, `common/debugger`, `--watch`.

### Flags

| Invocation | Does |
|---|---|
| `node test/node-compat/run.mjs --baseline [prefix…]` | runs the selected tests on real Node (`npx -y node@<NODE_VERSION>`, eight at a time, cwd `.node/`, `NODE_TEST_DIR` unset, 30 s each, then `SIGKILL`) and writes `results/baseline.json` |
| `node test/node-compat/run.mjs [--port] [prefix…]` | runs them in OpenVessel and writes the results, then prints the report |
| `node test/node-compat/run.mjs [--port] --report` | only rebuilds the report from the stored results |
| `--port` | run on the ported runtime and store results under `results/port/` instead of `results/` (the published numbers come from `results/port/`). Without it the harness writes `legacy` to `/etc/openvessel/node` and the tests run on the legacy runtime |
| `prefix…` | any other argument: keep only tests whose file name starts with `test-<prefix>` |

### How a run works

- Only tests that passed in `results/baseline.json` run (when the file exists). A selected test missing
  from the baseline is not run until `--baseline` is run again; the run starts with
  `warning: <n> selected tests are not in results/baseline.json and are skipped (run --baseline to add them): <files>`.
- The harness mounts at `/node` in the VFS: `package.json`, every file under `test/common` and
  `test/fixtures` up to 8 MiB, and the selected tests, sent in batches of about 4 MB per page evaluation.
- The policy is set to `allow-all`, and `window.ovNoAutoPreview` is set so the playground doesn't open a
  preview of ports the tests listen on.
- Four tests run at a time in one page, each as `node test/parallel/<file>` with cwd `/node` and
  `TEST_THREAD_ID=<0–3>` (so `test/common/tmpdir.js` gives each slot its own `.tmp.<id>`, as Node's runner
  does). A test gets 30 s, then `SIGKILL`; the harness waits 3 s more and gives the page evaluation
  15 s of slack.
- Tests listed in `limits/` run last (some of them can crash the browser). If the browser crashes, it is
  relaunched once for all tests in flight (with a throw-away profile in the OS temp directory, up to five
  attempts), and the test is run once more.
- Output that contains `1..0 # Skipped` counts as skipped, not passed.
- Results are written every 25 tests (with a progress line `<done>/<total> (<pass> pass so far, <s>s)`)
  and at the end. Earlier results in the file are kept, so runs of different prefixes accumulate.

### Results

| File | Contents |
|---|---|
| `results/baseline.json` | `{ "<test file>": { pass, skipped, code } }` from real Node (`code` is the exit code or the signal) |
| `results[/port]/ov.json` | `{ "<test file>": { mod, pass, skipped, code, timedOut, ms, error } }`; `code` −1 means no exit within the timeout, −2 a harness error; `error` is `TIMEOUT` or the first error line |
| `results[/port]/logs/<test file>.log` | the last 20000 characters of the test's output |
| `results[/port]/REPORT.md` | the report |

`test/node-compat/results/` is not in git.

The report counts, per module, every test in `ov.json` that passed on real Node:

| Column | Meaning |
|---|---|
| `pass` | passed in OpenVessel (tests in `limits/` excluded) |
| `target` | total minus `limits` |
| `%` | pass / target |
| `limits`, `total` | tests listed in `limits/`; all counted tests |
| `crash` | failed with an unexpected exception |
| `value` | an assertion found a different result |
| `timeout` | hung (30 s) |
| `shape` | only the error's `code`/`message`/`name`/`errno`/`syscall` or argument validation differs ("Missing expected exception" counts here) |

Below the table, failures are grouped by kind and by their first error line (numbers and quoted strings
normalised), with up to eight files per group. Tests listed in `limits/` that pass anyway are reported
as **Listed as limits but passing** so they can be removed from the list.

### limits/*.json

`test/node-compat/limits/<module>.json` lists the tests that can't pass in a browser, each with the
reason. Every file is one JSON object mapping a test file name to a sentence; all files are merged.

```json
{
  "test-process-env-tz.js": "Date's local time zone is the browser's, fixed for the page by its JS engine; setting process.env.TZ can't change it at runtime (Node calls tzset() and tells V8 to re-detect it)."
}
```

Current files: `assert`, `async-local-storage`, `buffer`, `child-process`, `crypto`, `fs`, `process`,
`stream`, `vm`, `worker`.

## Astro corpus

`corpus/` holds the list of real Astro sites used as an end-to-end test.

### corpus/sites.json

An array of sites. Official examples:

```json
{ "id": "astro-5-examples__blog", "repo": "withastro/astro", "ref": "astro@5.18.2", "path": "examples/blog", "astro": 5 }
```

Community sites have `id` `<owner>__<repo>`, `repo`, `ref` (the default branch), `sha` (the commit that
was downloaded; `null` for sites collected before it was recorded), `astro` (the major version) and
`stars`. Each site's files are in `corpus/sites/<id>/` (not in git; see `--restore` below).

### corpus/collect.mjs

`node corpus/collect.mjs [target=100] [majors=5,6,7]` needs an authenticated `gh`. It adds sites until the
list holds `target` entries:

1. the `examples/*` with a `build` script and an `astro.config.*` from the Astro release tags `astro@7.4.2`, `astro@6.4.8` and
   `astro@5.18.2` (ids `astro-<major>-examples__<name>`);
2. community repositories from GitHub searches (`topic:astro-theme`, `topic:astro-template`,
   `topic:astro-blog`, `topic:astro language:Astro`, `astro theme in:name,description language:Astro`,
   `astro portfolio language:Astro`, `starlight docs language:MDX`, each with `pushed:>2025-03-01`,
   sorted by stars, up to five pages of 50), skipping archived repositories, forks, repositories over
   200 MB, those without a `build` script, those whose `astro` dependency's major is not in `majors` and
   those without an `astro.config.*` at the root. The download is the default branch's current commit,
   recorded as `sha`.

A directory without an `astro.config.*` is not a site (`examples/toolbar-app` is a toolbar integration),
so it is never added. `sites.json` is rewritten after every addition. Ids already in `sites.json` are
skipped, so this form only adds sites.

`node corpus/collect.mjs --restore` downloads every listed site that `corpus/sites/` lacks (after a
fresh clone, that is all of them). Official examples come from one tarball per release tag and community sites from `sha`
(or the current head of `ref` when `sha` is `null`, which may differ from the files the results were
measured on). It prints `<restored> of <missing> missing sites restored (<listed> listed)` and exits 1 if
any failed. Directories in `corpus/sites/` that `sites.json` doesn't list are left alone and not run.

### corpus/run.mjs

`node corpus/run.mjs [--legacy] [filter…]` runs, for each site whose id contains one of the filters (all
sites without filters):

1. reload the playground (a fresh kernel), mount `corpus/sites/<id>` at `/home/user/app`;
2. pick the package manager: the `packageManager` field of `package.json` (`npm`, `pnpm`, `yarn`, `bun`),
   else `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock`/`bun.lockb` → bun, else npm;
3. `<pm> install`, then, if it succeeded, `<pm> run build`, each with `export CI=1 ASTRO_TELEMETRY_DISABLED=1`
   (and, with `--legacy`, the line that selects the legacy runtime) and a 15-minute timeout.

If the harness itself fails, the browser is relaunched and the run continues with the next site.

Results go to `corpus/results/port/` (the ported runtime, the default) or, with `--legacy`, to
`corpus/results/`. In the paths below, `[/port]` stands for that choice.

- `corpus/results[/port]/results.json`: `{ "<id>": { id, astro, install, build, ms, error } }`.
  `install`/`build` are booleans (`build` stays `null` when install failed), and `error` holds the last 12
  non-empty lines of the build output, or the last 8 of the install output.
- `corpus/results[/port]/logs/<id>.log`: `$ <pm> install`, its output and `[exit <code> <ms>ms]`, then the
  same for the build.

Existing entries of `results.json` are kept and overwritten per site. Each site prints
`[<i>/<n>] OK|FAIL|INST <id> (<s>s)` (FAIL: build failed, INST: install failed) with the last error lines,
and the run ends with `build ok: <x>/<total>, install ok: <y>`. `corpus/results/logs/` and
`corpus/results/port/` are not in git.

## Adding tests

- Unit test: add `test/unit/<name>.test.ts` using `node:test` and `node:assert/strict`; it is
  picked up by its suffix. Import source files directly (`../../src/…`); npm packages stay external.
- Differential binding test: write `test/fixtures-gen/<name>.cases.mjs` exporting
  `run(binding)` that returns `{ section: [{ args, r }] }`, a generator `test/fixtures-gen/<name>.mjs`
  that calls `generate('<binding name>', run)`, add the job to `scripts/regen-fixtures.mjs`, run it, and
  write `test/unit/bindings-<name>.test.ts` that calls
  `compareFixtures(run(createX()), fixture.results, known)`. List accepted differences in `known`, with
  the reason as the key.
- End-to-end check: write a script in `test/e2e/` using `startServer`, `openBrowser` and `exec` from
  `harness.mjs`; it runs on the ported runtime by default (use `useLegacyRuntime(page)` for the legacy
  one). Print a clear result and exit non-zero on failure, as `port-fs.mjs` and `preview-port.mjs` do.
- Node test that can't pass in a browser: add it to `test/node-compat/limits/<module>.json` with the
  reason; it then no longer counts toward the target. Remove it when the report lists it as passing.
- Corpus site: run `corpus/collect.mjs`, or add an entry to `corpus/sites.json` and put the files in
  `corpus/sites/<id>/`.

## Related pages

- [Building](building.md): prerequisites, `regen-fixtures.mjs` in the Node upgrade procedure
- [Bindings](bindings.md): what the differential tests compare
- [Compatibility](../compatibility.md): current results
