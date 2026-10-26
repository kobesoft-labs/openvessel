# Package managers

[日本語](package-managers.ja.md)

OpenVessel has its own package manager client, written for the kernel, with `npm`, `pnpm`, `yarn` and
`bun` as front ends. This page specifies every command and flag, how scripts run, how `install`
resolves and lays out `node_modules`, which lockfiles are read, and how the registry is reached
(`src/kernel/npm/`).

## Overview

- The client is one implementation (`src/kernel/npm/cli.ts`) that runs inside the kernel worker as an
  async program. It is not the real npm, pnpm, Yarn or Bun, and it does not start a `node` process.
- All four front ends install the same way: an npm-style hoisted `node_modules` tree. There is no
  pnpm content-addressed store or `.pnpm` directory, and no Yarn Plug'n'Play.
- Lockfiles are read as version hints only. No lockfile is written or updated by any front end; the
  only file written besides `node_modules` is `node_modules/.package-lock.json` (see
  [Hidden lockfile](#hidden-lockfile)).
- Registry traffic goes through the runtime's network gate like every other outgoing request
  ([Network policy](network-policy.md)).
- Lifecycle scripts run only for the project itself, never for dependencies.
- Native packages are replaced by WebAssembly builds or compat packages while installing
  ([Native modules](native-modules.md)).

### Programs

All programs are registered in `/usr/bin` (`installNpm()` in `src/kernel/npm/cli.ts`).

| Program | Runs as | Version printed by `-v` |
|---|---|---|
| `npm` | the `npm` front end | `10.9.3` |
| `pnpm` | the `pnpm` front end | `9.15.9` |
| `yarn` | the `yarn` front end | `1.22.22` |
| `bun` | the `bun` front end | `1.2.21` |
| `npx` | `npm exec -- <args>`, with every `-y`/`--yes` removed from the arguments | — |
| `pnpx` | `pnpm dlx <args>` | — |
| `bunx` | `bun x <args>` | — |
| `corepack` | prints `corepack: package managers are built into OpenVessel; nothing to do` to stderr, exit 0 | — |

The front end changes only a few things: the version, the user agent given to scripts, the summary line
after an install, the banner before a script, what happens with no command, and whether an unknown
command runs a script (see [Commands](#commands)).

## Command line

### Flags

Flags are parsed by `parseFlags()` the same way for every command and every front end. They may appear
anywhere before `--`.

| Flag | Effect |
|---|---|
| `-D`, `-d`, `--save-dev`, `--dev` | `add`/`install <pkg>`: save to `devDependencies`. |
| `-E`, `--save-exact`, `--exact` | `add`/`install <pkg>`: save the exact resolved version. |
| `-g`, `--global` | `install`/`add`: global install. `prefix`, `root`: print the global path. |
| `--production`, `--prod`, `-P`, `--omit=dev` | Don't install the project's `devDependencies` (or the workspaces'). |
| `--omit=optional`, `--no-optional` | Don't install `optionalDependencies` (of any package). |
| `--ignore-scripts` | Don't run the project's install lifecycle scripts. |
| `-y`, `--yes` | `init`: write `package.json` even if one exists. |
| `-s`, `--silent`, `--loglevel=silent`, `--reporter=silent` | No summary line, no warnings, no progress; `run` prints no banner and no failure message. |
| `--legacy-peer-deps`, `--force` | Don't install peer dependencies. |
| `--prefix <dir>`, `-C <dir>`, `--dir <dir>`, `--cwd <dir>` and the `=` forms | Use `<dir>` instead of the working directory as the starting point. |
| `-w <x>`, `--workspace <x>`, `--filter <x>`, `-F <x>` and the `=` forms | Accepted (the value is consumed) but has no effect. |
| `--` | Everything after it is passed through unchanged (to the script for `run`, to the command for `exec`). |
| `-v`, `--version` | With no command: print the front end's version, exit 0. |
| `-h`, `--help` | Anywhere in the arguments, even after `--`: print a short usage text, exit 0. |
| any other argument starting with `-` | Ignored (e.g. `--no-fund`, `--no-audit`, `--frozen-lockfile`, `--save`). |

Two consequences of this parsing:

- An unknown flag before `--` is dropped, also for `run` and `exec`: `yarn build --watch` and
  `npm run build --watch` run the script without `--watch`. Use `npm run build -- --watch`. `npx`
  puts all its arguments after `--`, so `npx tsc --noEmit` keeps the flag.
- Because `-h`/`--help` are checked first, `npx tsc --help` or `npm run x -- --help` print the
  OpenVessel usage text instead of running anything.

### Project directory

Commands that work on a project (`install`, `ci`, `update`, `uninstall`, `run`, `test`, `ls`, `pkg`, …)
use the nearest directory containing `package.json`, searching upward from the working directory (or
from `--prefix`). If there is none, the starting directory itself is used. `init`, `create`, `exec` and
`view` use the starting directory directly.

### Commands

| Command | Aliases | Behaviour |
|---|---|---|
| `install` | `i`, `in`, `isntall`, `add` | With package arguments: [add](#add) them. Without: install the project. `add` without arguments fails with `<pm> add requires at least one package` (exit 1). With `-g`: [global install](#global-install). |
| `ci` | `clean-install`, `install-clean` | Delete `node_modules`, then install. A lockfile is not required, and is not checked against `package.json`. |
| `update` | `up`, `upgrade` | Install while ignoring lockfiles (newest versions within the ranges). Package arguments are ignored; everything is updated. |
| `uninstall` | `remove`, `rm`, `un`, `unlink` | Remove the names from `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, write `package.json`, install. Exit 1 without output if there is no `package.json`. |
| `run` | `run-script`, `rum`, `urn` | [Run a script](#npm-run). Without a name: list the scripts. |
| `test` | `t`, `tst` | `run test` |
| `start`, `stop`, `restart` | — | `run start` / `run stop` / `run restart`. `start` without a `start` script runs `node server.js` if `server.js` exists in the project directory. |
| `exec` | `x`, `dlx` | [Run a package's binary](#exec-npx-dlx). |
| `create` | — | [Run a `create-*` package](#create-and-init). |
| `init` | — | With a name: same as `create`. Without one (or with only flags): [write a `package.json`](#create-and-init). |
| `view` | `info`, `show`, `v` | [Show registry metadata](#view). |
| `ls` | `list`, `ll`, `la` | [List direct dependencies](#ls). |
| `why` | `explain` | Same output as `ls`. |
| `prune`, `dedupe`, `rebuild` | `ddp`, `rb` | Run a normal install. |
| `config` | `c` | [Read and write `.npmrc` settings](#config). |
| `pkg` | — | [Read and write `package.json` fields](#pkg). |
| `cache` | — | `cache clean`, `cache clear`, `cache verify`: delete the tarball cache and print `Cache cleaned`. Other subcommands do nothing (exit 0). |
| `prefix` | — | Print the project directory; with `-g`, `/usr/local`. |
| `root` | — | Print `<project>/node_modules`; with `-g`, `/usr/local/lib/node_modules`. |
| `bin` | — | Print `<project>/node_modules/.bin`. |
| `audit`, `fund` | — | Print `<pm> <cmd> is not supported in OpenVessel` to stderr, exit 0. |
| `doctor`, `outdated`, `login`, `publish`, `whoami` | — | Print `<pm> <cmd> is not supported in OpenVessel` to stderr, exit 1. |

No command:

- `npm` prints its usage text (ending with `npm@10.9.3`) and exits 1.
- `pnpm`, `yarn` and `bun` install the project.

Any other command:

- `npm` prints `Unknown command: "<cmd>"` and a hint, exit 1. (`npm help` is not a command and also ends
  here.)
- `pnpm`, `yarn` and `bun` run the script `<cmd>` if `package.json` has one. Otherwise `bun` runs
  `node <cmd> <args>` when `<cmd>` ends in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.tsx`. Otherwise the
  command is run like [`exec`](#exec-npx-dlx). The commands in the table take precedence over scripts:
  `yarn show` runs `view` even if the project has a `show` script; use `yarn run show`.
- `bun run <file>` looks for a script named `<file>`; only `bun <file>` runs a file.

### add

`install <pkg…>` / `add <pkg…>` updates `package.json`, then installs the whole project. If there is no
`package.json`, one is created with `name` (the directory's name) and `version` `1.0.0`.

Each argument is `name` or `name@spec` (`@scope/name@spec` for scoped names). What is saved:

| Argument | Saved range |
|---|---|
| `name` | `^<latest>` (the `latest` dist-tag) |
| `name@<range>` (a valid semver range other than an exact version) | the range as given |
| `name@<version>` (exact) | `^<version>` |
| `name@<dist-tag>` | `^<version the tag points to>` |
| `name@latest` | `latest` (it parses as a range, see [semver](#semver)) |
| `name@file:…`, `link:…`, `workspace:…`, `http(s)://…`, `git…`, `github:…`, `npm:…` | the spec as given, without contacting the registry |
| any of the above with `-E` | the exact resolved version (registry specs only) |

- Without `-D` the name goes to `dependencies`, with `-D` to `devDependencies`; it is removed from the
  other of the two. The field is then sorted by name.
- A range that matches no published version fails with
  `npm error code ETARGET` / `npm error notarget No matching version found for <arg>.` (exit 1). A
  registry error prints `npm error code <code>` and the message (exit 1).
- Arguments without a name (`user/repo`, `./dir`, a bare URL) are looked up in the registry as names and
  fail. Write them as `name@<spec>` or put them in `package.json`.
- `--save-optional`, `--save-peer` and similar flags are ignored; the name goes to `dependencies`.

### Global install

`npm install -g <pkg…>` (also `add -g`, and the same with the other front ends):

1. Uses `/usr/local/lib/node_modules/.ov-global` as a project, creating it with a `package.json` of
   `{ "name": "global", "private": true }` when missing.
2. Adds the packages there (as [add](#add) does), always with scripts ignored.
3. Links every entry of `/usr/local/lib/node_modules/.ov-global/node_modules/.bin` into
   `/usr/local/bin` as an absolute symlink, replacing existing links of the same name. `/usr/local/bin`
   is on the default `PATH`.

`npm root -g` prints `/usr/local/lib/node_modules`, not the `.ov-global` directory. `uninstall -g` has
no global mode; it works on the current project.

### npm run

`run <name> [args…]` in the project directory:

1. No `package.json`: `npm error code ENOENT` / `npm error Could not read package.json in <dir>`, exit 254.
2. No name: prints `Scripts available in <name> via \`npm run-script\`:` and each script with its
   command, exit 0.
3. No script `<name>`: `npm error Missing script: "<name>"` and a hint, exit 1 (with every front end).
4. Otherwise runs `pre<name>`, `<name>`, `post<name>`, each only if defined. The arguments (those after
   `--`, and plain arguments after the name) go to `<name>` only. The first script that exits non-zero
   stops the sequence; its exit code is returned. With `npm`, and without `-s`, a failure also prints:

```text
npm error Lifecycle script `build` failed with error:
npm error code 3
npm error path /home/user/app
npm error command failed
npm error command sh -c exit 3
```

Each script runs as `/bin/sh -c '<script> <args>'` with the project directory as working directory and
the [script environment](#script-environment). Arguments are appended to the script text; an argument
that contains anything other than letters, digits and `_ . / : = @ % + -` is single-quoted. Before each
script a banner is written to stdout, unless `-s` is given:

| Front end | Banner |
|---|---|
| `npm`, `pnpm`, `bun` | an empty line, `> <name>@<version> <event>`, `> <command>`, an empty line |
| `yarn` | `$ <command>` |

`pre`/`post` scripts always run; `--ignore-scripts` does not affect `run`.

### Install lifecycle

When the project is installed (`install`, `add`, `ci`, `update`, `uninstall`, `prune`, …) and
`--ignore-scripts` is not given, these scripts of the project's own `package.json` run, each only if
defined:

| Order | Script | When |
|---|---|---|
| 1 | `preinstall` | before anything is resolved |
| 2 | `install` | after `node_modules` is written |
| 3 | `postinstall` | |
| 4 | `preprepare` | |
| 5 | `prepare` | |
| 6 | `postprepare` | |

A script that fails stops the install with its exit code. The banner is printed even with `-s`. The
summary line comes after the last script.

Not run: any script of a dependency (including `preinstall`/`install`/`postinstall` that build or
download native binaries), scripts of workspace packages, and scripts of packages installed by `exec`,
`create` or `install -g`.

### Script environment

Built by `scriptEnv()` from the caller's environment plus:

| Variable | Value |
|---|---|
| `PATH` | `<dir>/node_modules/.bin` for the project directory and each of its ancestors up to `/`, then the caller's `PATH` (default `/usr/local/bin:/usr/bin:/bin`) |
| `npm_lifecycle_event` | the script name (`build`, `prebuild`, `postinstall`, …); `npx` for [exec](#exec-npx-dlx) |
| `npm_lifecycle_script` | the command line run, including appended arguments |
| `npm_package_name` | `name` from `package.json`, or empty |
| `npm_package_version` | `version` from `package.json`, or empty |
| `npm_package_json` | absolute path of the project's `package.json` |
| `npm_config_user_agent` | `<pm>/<version> npm/? node/v22.23.4 linux x64 workspaces/false`. For `exec`, an existing value is kept, so a binary started by `npx` inside a `pnpm` script still sees `pnpm` (tools like `only-allow` rely on this). |
| `npm_execpath` | `/usr/lib/node_modules/<pm>/bin/<pm>-cli.js` |
| `npm_node_execpath` | `/usr/bin/node` |
| `npm_command` | `test` or `start` for those scripts, otherwise `run-script` (also during install) |
| `INIT_CWD` | the working directory the command was started in |
| `NODE` | `/usr/bin/node` |
| `COLOR` | `1` if stdout is a terminal, else `0` |

No other `npm_package_*` or `npm_config_*` variables are set.

```sh
$ npm pkg set scripts.where='echo $npm_lifecycle_event in $INIT_CWD'
$ npm run where -s
where in /home/user/app
```

### exec, npx, dlx

`npx <cmd> [args…]`, `npm exec <cmd>`, `npm x`, `pnpm dlx`, `yarn dlx`, `pnpx`, `bunx`, and the
fallback for unknown `pnpm`/`yarn`/`bun` commands:

1. No command: `npm error npx requires a command`, exit 1.
2. If the command has no version (`cowsay`, not `cowsay@1`), no `--package` was given, and the install
   is not forced:
   - a `node_modules/.bin/<cmd>` in the starting directory or any ancestor is run (in the caller's
     working directory, with the [script environment](#script-environment));
   - else a program found on `PATH` is run directly, unless it lives in `/bin/` or the name starts with
     `create-` (so `npx node -e …` runs `/usr/bin/node`, and globally installed binaries in
     `/usr/local/bin` are used).
3. Otherwise the package is installed into `$HOME/.npm/_npx/<key>`, where `<key>` is the package
   spec(s) with every run of characters other than letters, digits, `_`, `@`, `.`, `-` replaced by `_`,
   cut to 100 characters. The directory gets a `package.json` named `npx-cache` with the package as a
   dependency (no version → `latest`) and is installed silently with scripts ignored. An existing cache
   directory (it has `node_modules/.package-lock.json`) is reused as is, without checking for newer
   versions, unless the install is forced.
4. The binary is chosen from the package's `bin`: the one named like the package (without its scope),
   else the only one, else `<name without scope>`. With `--package`, it is `<cmd>` itself. If the file
   doesn't exist: `npm error could not determine executable to run for <cmd>`, exit 1.
5. It runs in the caller's working directory with the script environment
   (`npm_lifecycle_event=npx`) and the cache's `node_modules/.bin` first on `PATH`.

| Entry | Forced reinstall | Notes |
|---|---|---|
| `npx`, `npm exec`, `npm x`, `bunx`, `npm dlx` | no | |
| `pnpm dlx`, `yarn dlx`, `pnpx` | yes | |
| `create`, `init <name>` | yes | |

`--package <spec>` / `-p <spec>` / `--package=<spec>` installs `<spec>` and runs the following command
from it. This works with `npm exec -p <spec> -- <cmd> [args]`. With `npx -p …` the flags end up after
the implicit `--` and are taken as the command, which fails with
`npm error could not determine executable to run for -p`.

### create and init

`npm create <x> [args]`, `npm init <x> [args]` (and `pnpm`/`yarn`/`bun create`) run a starter package
through `exec` with a forced reinstall:

| Argument | Package run |
|---|---|
| `vite` | `create-vite` |
| `vite@5` | `create-vite@5` |
| `@scope` | `@scope/create` |
| `@scope/app` | `@scope/create-app` (a version after a scoped name is dropped) |

`npm init` with no name (or whose first argument starts with `-`) writes a `package.json` without
asking:

```json
{
  "name": "<directory name, lower-cased, characters other than a-z 0-9 . _ - replaced by ->",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": { "test": "echo \"Error: no test specified\" && exit 1" },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
```

It prints `Wrote to <path>:` and the JSON. If `package.json` exists, it prints
`package.json already exists in <dir>` and changes nothing, unless `-y` is given, which overwrites it.

### view

`npm view <name>[@<spec>] [field…]` fetches the package's metadata. The version is the `latest` tag, the
highest version matching a range, or the version a dist-tag points to.

- With fields, each is printed on its own line: `versions` (all published versions), `dist-tags`, or a
  dotted path into that version's manifest (`dependencies.react`). Strings are printed raw, everything
  else as indented JSON.
- Without fields, a summary: `<name>@<version> | <license> | deps: <n>`, the description and the
  dist-tags.
- No argument, or no matching version: exit 1 without output. A registry error prints
  `npm error code <code>` and the message, exit 1.

The metadata is the abbreviated document the installer uses, which has no `description` or `license`,
so the summary shows `Proprietary` and an empty description, and fields that only exist in the full
document print `undefined`.

### ls

`npm ls` prints `<name>@<version> <dir>`, then one line per direct dependency (`dependencies`,
`devDependencies` and `optionalDependencies` together, sorted) with the version recorded in
`node_modules/.package-lock.json`, or `UNMET DEPENDENCY`. There is no tree, `--depth` or `--all`.

```text
app@1.0.0 /home/user/app
├── astro@5.14.1
└── is-odd@3.0.1
```

### config

| Subcommand | Behaviour |
|---|---|
| `config get [key]` | Prints the effective value from the [`.npmrc` files and environment](#registry-and-npmrc). Defaults: `registry` → `https://registry.npmjs.org/`, `prefix` → `/usr/local`, others → `undefined`. Without a key, `registry`. |
| `config set <key>=<value>`, `config set <key> <value>` | Writes to `$HOME/.npmrc`, replacing a line that starts with `<key>=`. |
| `config list`, `config ls` | Prints every effective setting as `key = "value"`. |
| anything else | Nothing, exit 0. |

### pkg

| Subcommand | Behaviour |
|---|---|
| `pkg get` | Prints the whole `package.json` as JSON. |
| `pkg get <path>` | Prints the value at a dotted path as JSON (`"q"`, `{…}`), or `undefined` if it is missing. |
| `pkg set <path>=<value>…` | Sets each dotted path to the string value, creating objects on the way, and writes the file. |
| anything else | Exit 1. |

## Install

`Installer.run()` in `src/kernel/npm/install.ts`. In order:

1. Read `package.json` (missing → `npm error code ENOENT` / `npm error Could not read package.json:
   <dir>/package.json`, exit 254).
2. Read lockfile hints (not for `update`), run `preinstall`.
3. Collect overrides and workspaces.
4. Resolve the tree breadth-first.
5. Download, verify and unpack every new or changed package (up to 16 requests at a time).
6. Link binaries, write `node_modules/.package-lock.json`.
7. Run the remaining lifecycle scripts, print the summary.

### Dependency kinds

| Kind | Installed for |
|---|---|
| `dependencies` | every package |
| `optionalDependencies` | every package, unless `--omit=optional`. A failure to resolve one is a warning, not an error. |
| `devDependencies` | the project and its workspaces only, unless `--omit=dev` |
| `peerDependencies` | every dependency (not the project), except peers marked optional in `peerDependenciesMeta`, unless `--legacy-peer-deps`/`--force` or `legacy-peer-deps=true` in `.npmrc` |
| `bundleDependencies` | not handled specially (whatever the tarball contains is unpacked) |

`NODE_ENV` has no effect on what is installed. `engines` and `libc` are not checked.

These names are never installed, whatever lists them: `fsevents`, `bufferutil`, `utf-8-validate`,
`cpu-features`, `ssh2`.

### Specifiers

| Spec in `package.json` | Resolved as |
|---|---|
| semver range, exact version, `*`, `""`, `latest` | registry, see [Version selection](#version-selection) |
| other dist-tag (`next`, `beta`) | registry, the version the tag points to |
| `npm:<name>@<range>`, `npm:<name>` | registry package `<name>`, installed under the alias |
| `workspace:<range>` | the workspace of that name if there is one, else the registry with the prefix removed (`*`, `^`, `~` mean any version) |
| `catalog:`, `catalog:<name>` | any version (`*`) from the registry; catalogs are not read |
| `file:<path>`, `link:<path>` | a symlink to `<path>`, resolved against the project directory; its dependencies are installed |
| `user/repo`, `user/repo#ref`, `github:user/repo`, `git+https://github.com/…`, `git+ssh://git@github.com…`, `https://github.com/…`, `git://github.com/…` | the tarball `https://codeload.github.com/<user>/<repo>/tar.gz/<ref>` (`HEAD` by default; a `semver:` prefix in the ref is removed, not resolved) |
| `http://…`, `https://…` | a tarball at that URL |

Other git hosts are not supported (the spec is taken as a dist-tag and fails with `ETARGET`).
GitHub and URL tarballs have no integrity to check.

### Version selection

For a registry spec (`pickVersion()`):

1. Not a valid range: the dist-tag of that name, if it points to an existing version; else none.
2. If the lockfile hints contain versions of this package that exist and satisfy the range (prereleases
   allowed), the highest of them.
3. The `latest` dist-tag, if it satisfies the range.
4. The highest version that satisfies the range, then the same with prereleases allowed.

No match: `npm error code ETARGET` / `npm error No matching version found for <name>@<range>.`, exit 1
(a warning for optional dependencies). After that, the native-package rules may change the version or
the contents ([Native modules](native-modules.md)).

### Placement

The tree is built like npm's hoisted layout (`choosePlacement()`, `findVisible()`):

- A dependency first looks for a package of that name visible from the dependent: in the dependent's own
  `node_modules`, then each enclosing `node_modules` up to the project root (workspaces count as being
  at the root). If that package satisfies the spec and has a compatible peer set, it is reused. A
  workspace is always reused.
- For a peer dependency the search starts at the dependent's container, so the peer is shared with the
  dependent's siblings. If a visible peer doesn't satisfy the range, it is used anyway with the warning
  `npm warn ERESOLVE <pkg>@<version> wants peer <peer>@"<range>", found <version>`.
- A new package is placed as high as possible: it moves up one level at a time while the level has no
  package of that name, placing it there would not shadow an already-resolved dependency on another
  version, and its required peers would still resolve to compatible instances (the same instances the
  dependent uses).
- Packages pinned by the native rules stay in their dependent's `node_modules`.
- A package's flags `dev`/`optional` are cleared as soon as any non-dev/non-optional path reaches it.

### Platform filter

After resolving, a package whose `os` or `cpu` excludes OpenVessel is skipped. OpenVessel counts as
`os: linux` and `cpu: wasm32`; lists with `!` negations are honoured, empty lists accept everything.
Skipping prints `npm warn EBADPLATFORM skipping <name>@<version> (needs <os> / <cpu>)` unless the
dependency is optional. This is what keeps per-platform native packages (`cpu: ["x64"]`) out and lets
`wasm32` packages in.

Other warnings printed while resolving: `npm warn deprecated <name>@<version>: <message>` and
`npm warn optional skipping <name>@<spec>: <message>`. Each warning is printed once.

### Overrides and resolutions

Read from `overrides` (npm), `resolutions` (Yarn) and `pnpm.overrides` in the project's `package.json`.

- Only string values are used; nested objects (npm's per-parent overrides) are ignored.
- A leading `**/` is removed, and a version selector on the key (`foo@1`, `@scope/foo@1`) is dropped, so
  the override applies to every version.
- Keys that still contain `/` and aren't scoped names (`a/b`, Yarn's path patterns) are ignored.
- A value `$name` takes the project's own `dependencies`/`devDependencies` spec for `name`, or `*`.
- The override replaces the spec of every dependency on that name, direct ones included.

```json
{
  "dependencies": { "is-odd": "3.0.1" },
  "overrides": { "is-number": "6.0.0" }
}
```

### Workspaces

Workspace directories come from `workspaces` in `package.json` (an array, or `{ "packages": [...] }`)
and from the `packages:` list of `pnpm-workspace.yaml` (block or inline list; other keys of that file
are not read). Both are used together.

- Pattern segments: a literal name, `*` or `**` (any directory except `node_modules` and dot-directories,
  one level only), or a segment with `*` wildcards. Patterns starting with `!` are skipped (they don't
  exclude anything).
- A directory counts if it has a `package.json` with a `name`; the project root itself is never a
  workspace.
- Each workspace is linked as `node_modules/<name>` → relative symlink to its directory, and its
  `dependencies`, `optionalDependencies` and `devDependencies` are installed in the root tree.
- A dependency on a workspace's name resolves to the workspace whatever its range.
- Workspace `bin` entries are linked into the root `node_modules/.bin`.
- `--workspace`/`--filter` do not select workspaces; commands always work on the root project.

### Writing node_modules

- Packages from the previous install (in `node_modules/.package-lock.json`) that are no longer in the
  tree are deleted.
- A package is left alone if the previous record has the same version and source and its
  `package.json` still has that version. A summary of `up to date` means nothing changed.
- Otherwise its directory is emptied (its nested `node_modules` is kept) and the tarball is unpacked:
  the first path component is removed, entries containing `..` are skipped, directories, regular files
  and symlinks are created, hard links and other entry types are skipped. Files with any execute bit
  get mode `0755`, others `0644`.
- When a package is installed under another name (an `npm:` alias, a WebAssembly substitute, a compat
  package), its `package.json` is rewritten with the installed `name` and `version` and a field
  `_openvesselSource: "<source package>@<version>"`.
- `file:`/`link:` dependencies and workspaces are relative symlinks.

### Binaries

For each `node_modules` directory in the tree, the `bin` entries of the packages directly in it are
linked into its `.bin` (`node_modules/.bin`, or `.../node_modules/x/node_modules/.bin` for nested
packages):

- `bin` as a string is named after the package (without its scope); `directories.bin` is used when
  there is no `bin` (every file in that directory).
- The manifest from the registry is used first, then the unpacked `package.json`.
- Names containing `/` or `..` are skipped. Links are relative; the target is made executable.
- On a name conflict, the container's direct dependencies win over hoisted transitive ones.

### Hidden lockfile

`node_modules/.package-lock.json` records the installed tree:

```json
{
  "name": "app",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "node_modules/is-odd": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",
      "integrity": "sha512-…"
    }
  }
}
```

Each entry has `version`, `resolved` (tarball URL or link target), `integrity`, and `dev`, `optional`,
`link` when true. It is used for "up to date" checks, pruning, `npm ls`, and by `exec` to recognize a
cache directory. It is not read for version hints.

### Progress and summary

When stderr is a terminal and `-s` is not given, a progress line is rewritten in place
(`\r\x1b[K`): `resolving… <n> packages` every 50 dependencies, `fetching <n> packages…`, and
`extracting… <done>/<total>` every 25 packages. It is cleared before warnings and at the end.

The summary goes to stdout (not with `-s`). `<time>` is `<n>ms` below one second, else `<n.n>s`.

| Front end | Summary |
|---|---|
| `npm`, `bun` | an empty line, then `added <n> package(s)[, and audited <total+1> packages] in <time>`, or `up to date in <time>` when nothing was added. The `audited` part appears when some packages were already in place. |
| `pnpm` | `Packages: +<n>` and `Done in <time>` |
| `yarn` | `success Saved lockfile.` and `Done in <time>.` (no lockfile is actually written) |

## Lockfiles

`readLockHints()` in `src/kernel/npm/lockfile.ts` looks for these files in the project directory, in
this order, and uses the first one that exists and parses (even if it yields no versions):

| File | What is read |
|---|---|
| `package-lock.json` | v2/v3: every entry of `packages` except the root and `link` entries; the name is the entry's `name` or the path after the last `node_modules/`. v1: the nested `dependencies` tree (`npm:` alias versions are reduced to the version). |
| `npm-shrinkwrap.json` | as `package-lock.json` |
| `pnpm-lock.yaml` | keys in the `packages:` and `snapshots:` sections: `name@version` (v6–v9) and `/name/version` (v5), quoted or not, with peer suffixes ignored |
| `yarn.lock` | Yarn v1: each entry's names (aliases `alias@npm:real@range` count as `real`) and its `version "x"`. Yarn Berry files are parsed with the same rules, but their `name@npm:range` keys produce names that never match a package, so a Berry lockfile has no effect. |
| `bun.lock` | every `"name@x.y.z"` string in the file |

`bun.lockb` (binary) is not read.

The result is only a set of versions per package name. It is used in [Version selection](#version-selection)
step 2: the highest locked version that satisfies the range wins. The tree shape, `resolved` URLs and
`integrity` values of the lockfile are not used, and a lockfile that disagrees with `package.json` is
not an error. `update` ignores lockfiles. No front end writes or updates a lockfile.

## Registry and .npmrc

### Settings

`readNpmrc()` merges, later ones winning:

1. `$HOME/.npmrc` (default `HOME` is `/home/user`),
2. `.npmrc` in every directory from `/` down to the project directory,
3. environment variables `npm_config_<key>` (any case; the key is lower-cased and `_` becomes `-`).

Lines are `key = value`; lines starting with `#` or `;` are comments; surrounding quotes are removed
and `${VAR}` is replaced from the environment (empty if unset).

Keys that have an effect:

| Key | Effect |
|---|---|
| `registry` | Registry URL for unscoped packages (default `https://registry.npmjs.org/`; a trailing `/` is added). |
| `@scope:registry` | Registry URL for `@scope/*` packages. |
| `legacy-peer-deps` | `true`: same as `--legacy-peer-deps`. |

Every other key is only visible to `npm config get/list`. Authentication settings (`_authToken`,
`_auth`, `//host/:…`) are not sent; requests carry no credentials.

### Requests

Every registry and tarball request goes from the kernel to the runtime service worker's `/__ov/net`
endpoint, which asks the kernel's network policy and then performs the request with the browser's
`fetch` (no cookies, CORS mode). The initiator shown in permission requests is `npm`. The `npm` preset
of the network policy allows `registry.npmjs.org`, `registry.npmjs.com`, `registry.yarnpkg.com` and
`registry.npmmirror.com`; GitHub dependencies need the `github` preset or an allow rule for
`codeload.github.com` ([Network policy](network-policy.md)). The host must answer with CORS headers.

| Request | Details |
|---|---|
| Package metadata | `GET <registry><name>` with `/` in scoped names encoded as `%2f`, header `accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*` (abbreviated metadata) |
| Tarball | `GET` of the `dist.tarball` URL; gzip is detected by its magic bytes and decompressed with `DecompressionStream` |
| Compat tarball | fetched directly from `<runtime base>/compat/`, not through the network gate ([Native modules](native-modules.md)) |

Limits and retries:

- At most 16 metadata and tarball requests run at once (shared by one `Registry` object).
- Each request is tried up to 3 times, waiting 300 ms × attempt (metadata) or 400 ms × attempt
  (tarballs) between tries. `E404` and `EACCES` are not retried.
- While resolving, metadata of each listed dependency is requested ahead of time.

| Failure | `code` | Message |
|---|---|---|
| 404 | `E404` | `404 Not Found - GET <url> - '<name>' is not in this registry.` (metadata) or `404 Not Found - GET <url>` |
| other HTTP status | `E<status>` | `<status> <statusText> - GET <url>` |
| refused by the network policy | `EACCES` | the gate's message, then `npm error network access was denied by the OpenVessel network policy` |
| network failure, CORS | `ECONNREFUSED` | the gate's message |
| integrity mismatch | `EINTEGRITY` | `integrity checksum failed for <url>` |

An install that fails prints `npm error code <code>` and `npm error <message>` (with every front end) and
exits 1.

### Caches

- Metadata is cached in memory per registry configuration for the life of the kernel: a second
  `install` or `view` of the same package doesn't ask the registry again until the page is reloaded or
  the registry settings change. Failed requests are not cached.
- Tarballs are cached in the runtime origin's Cache Storage, in the cache `openvessel-npm-v1`, keyed by
  URL. The cache survives reloads. A cached tarball is verified against its integrity every time it is
  read; on a mismatch it is deleted and downloaded again. `npm cache clean` deletes the whole cache.

### Integrity

`verify()` checks a tarball against `dist.integrity` (Subresource Integrity: any of `sha512`, `sha384`,
`sha256`, `sha1`, space-separated; one matching hash is enough). If an integrity string is present but
has no supported hash, the check fails. Without `integrity`, a hex `dist.shasum` (SHA-1) is checked.
With neither (GitHub and URL tarballs), nothing is checked.

## Exit codes

| Code | When |
|---|---|
| 0 | success; `-v`, `-h`; `audit`, `fund`; `config`/`cache` subcommands that do nothing |
| 1 | resolution, registry, network or integrity errors; missing script; unknown command; `npm` without a command; `add` without packages; `doctor`, `outdated`, `login`, `publish`, `whoami`; `exec` without a command or binary |
| 254 | no `package.json` for `install` or `run` |
| other | the exit code of a failing lifecycle or `run` script, or of the program started by `exec` |

## semver

`src/kernel/npm/semver.ts` implements the node-semver range syntax used in `package.json`:

| Syntax | Meaning |
|---|---|
| `1.2.3`, `=1.2.3`, `v1.2.3` | exactly that version (leading `v`/`=` ignored, build metadata `+…` ignored) |
| `1`, `1.x`, `1.2`, `1.2.*` | partial versions as ranges (`>=1.0.0 <2.0.0-0`, …) |
| `*`, `x`, `X`, `""`, `latest` | any version |
| `^1.2.3`, `^0.2.3`, `^0.0.3`, `^1.x` | caret: up to the next major, or minor/patch for `0.x` |
| `~1.2.3`, `~1.2`, `~1`, `~>1.2` | tilde: up to the next minor (next major for `~1`) |
| `>`, `>=`, `<`, `<=` with full or partial versions | comparators (`>1.2` → `>=1.3.0`, `<=1.2` → `<1.3.0-0`) |
| `1.2.3 - 2.3`, `1 - 2` | hyphen ranges (partial upper bounds are exclusive of the next version) |
| space-separated comparators | AND |
| `\|\|` | OR |

Prereleases follow node-semver: a version like `1.2.3-beta.1` satisfies a range only if a comparator in
the same set has a prerelease on the same `1.2.3`, unless `includePrerelease` is set. There is no loose
mode and no coercion. Parsed ranges are cached in memory. Exported functions: `parse`, `valid`,
`compare`, `parseRange`, `validRange`, `satisfies`, `maxSatisfying`, `minVersion`, `rsort`.

## Source files

| File | Contents |
|---|---|
| `src/kernel/npm/cli.ts` | front ends, flags, commands, scripts, `.npmrc` |
| `src/kernel/npm/install.ts` | resolution, placement, native-package rules, unpacking, bins, hidden lockfile |
| `src/kernel/npm/lockfile.ts` | lockfile readers |
| `src/kernel/npm/registry.ts` | registry and tarball requests, caches, integrity |
| `src/kernel/npm/tar.ts` | gzip and tar (ustar, pax, GNU long names) |
| `src/kernel/npm/semver.ts` | semver |
