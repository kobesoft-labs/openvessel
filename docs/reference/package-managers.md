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
- Lockfiles are read as version hints only. Only `yarn` writes one (`yarn.lock` in the v1 format, see
  [yarn.lock](#yarnlock)); otherwise the only file written besides `node_modules` is
  `node_modules/.package-lock.json` (see [Hidden lockfile](#hidden-lockfile)).
- Registry traffic is checked against the network policy in the runtime like every other outgoing request
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
| `npx` | `npm exec`, with an `--` inserted after the command name: `npx -y tsc --help` runs as `npm exec -y -- tsc --help` | — |
| `pnpx` | `pnpm dlx <args>` | — |
| `bunx` | `bun x <args>` | — |
| `corepack` | prints `corepack: package managers are built into OpenVessel; nothing to do` to stderr, exit 0 | — |

The front ends share the installer and the script runner. They differ in the version, the user agent
given to scripts, which commands they have and whether a script can be run by its name
([Commands](#commands)), where options are read ([Options](#options)), how workspaces are selected
([Selecting workspaces](#selecting-workspaces)), the banner before a script, the summary line after an
install, and `yarn.lock`.

## Command line

### Options

Options are parsed by `parseFlags()`. Which arguments are read as options depends on the front end and
the command, as in the real clients:

- The arguments before the command name are always the client's options (`npm -s run build`,
  `pnpm --filter a build`).
- `npm` reads options anywhere before `--`, after the command name too (`npm run build -s`,
  `npm install foo -D`). Everything after `--` is passed on.
- `pnpm`, `yarn` and `bun` read options after the command name only for commands that don't pass
  arguments on (`install`, `add`, `remove`, `view`, …). For `run`, `exec`, `dlx` and a script run by its
  name, the options between the command and the script, package or command name are the client's, and
  everything after that name is passed on unchanged: `yarn build --watch` and `pnpm run build --watch`
  run the script with `--watch`.
- `npx` inserts an `--` after the command name (see [Programs](#programs)), and `pnpx`/`bunx` pass on
  everything after the package name, so `npx tsc --noEmit`, `bunx tsc --watch` keep their flags.
- `-h`/`--help` print the usage text only where options are read. After `--`, or after a script or command
  name whose arguments are passed on, they belong to the script or command: `npx tsc --help` and
  `npm run x -- --help` run `tsc --help` and `x --help`.

| Option | Effect |
|---|---|
| `-D`, `--save-dev`, `--dev` (and `-d` with `bun`) | `add`/`install <pkg>`: save to `devDependencies`. With `npm`, `-d` is `--loglevel info` and has no effect. |
| `-E`, `--save-exact`, `--exact` | `add`/`install <pkg>`: save the exact resolved version. |
| `-g`, `--global` | `install`/`add`, `uninstall`/`remove`: [global install](#global-install). `prefix`, `root`, `bin`, `ls`: the global paths. |
| `--production`, `--prod`, `--omit=dev`, `-P` (`pnpm`), `-p` (`bun`) | Don't install the project's `devDependencies` (or the workspaces'). |
| `--include=dev` | Install them even with `NODE_ENV=production`. |
| `--omit=optional`, `--no-optional` | Don't install `optionalDependencies` (of any package); `--include=optional` undoes it. |
| `--ignore-scripts` | Don't run the project's install lifecycle scripts. |
| `-y`, `--yes` | `exec`: install a missing package without the warning. `init`: write `package.json` even if one exists. |
| `--no`, `--no-yes` | `npm exec`/`npx`: refuse to install a missing package. |
| `-s`, `--silent`, `--loglevel=silent`, `--reporter=silent` | No summary line, no warnings, no progress; `run` prints no banner and no failure message. |
| `--legacy-peer-deps`, `--force` | Don't install peer dependencies. |
| `--json` | `view`: print JSON. |
| `--if-present` | `run`: a missing script is not an error. |
| `--frozen-lockfile`, `--pure-lockfile`, `--no-lockfile` | `yarn`: don't write `yarn.lock`. |
| `--prefix <dir>`, `-C <dir>`, `--dir <dir>`, `--cwd <dir>` and the `=` forms | Use `<dir>` instead of the working directory as the starting point. |
| `-w <x>`, `--workspace <x>`, `--workspaces`, `-ws`, `--include-workspace-root` | `npm`: [select workspaces](#selecting-workspaces). |
| `--filter <x>`, `-F <x>`, `-r`, `--recursive`, `-w`, `--workspace-root`, `--include-workspace-root` | `pnpm` (`bun`: `--filter`/`-F`): [select workspaces](#selecting-workspaces). |
| `-p <spec>`, `--package <spec>` and the `=` forms | `exec`/`dlx`: the package to install (see [exec](#exec-npx-dlx)). |
| `-c <cmd>`, `--call <cmd>` | `npm exec`: run a shell command with the packages' binaries on `PATH`. `pnpm dlx -c`/`--shell-mode`: the arguments after the package are a shell command. |
| `--` | Everything after it is passed through unchanged (to the script for `run`, to the command for `exec`). |
| `-v`, `--version` | With no command: print the front end's version, exit 0. |
| `-h`, `--help` | Where options are read: print a short usage text, exit 0. |
| any other option | `npm`: a `--<name>[=<value>]` option is kept as config, given to scripts as `npm_config_<name>` (`--no-<name>` as `false`), and if `<name>` is not one of npm's config names, `npm warn Unknown cli config "--<name>". This will stop working in the next major version of npm.` is printed to stderr (not with `-s`). Other front ends: ignored (e.g. `--no-fund`, `--no-audit`, `--save`). |

So `npm run build --watch` runs the script without `--watch` (with the warning, and with
`npm_config_watch=true` in its environment), like npm; write `npm run build -- --watch`.

### Project directory

Commands that work on a project (`install`, `ci`, `update`, `uninstall`, `run`, `test`, `ls`, `pkg`, …)
use the nearest directory containing `package.json`, searching upward from the working directory (or
from `--prefix`). If there is none, the starting directory itself is used. `init`, `create`, `exec` and
`view` use the starting directory directly.

Commands that install (`install`, `add`, `ci`, `update`, `uninstall`, `prune`, …) install the workspace
root when the project directory is one of its [workspaces](#workspaces); `add` and `uninstall` still
change the workspace's own `package.json`.

### Commands

Each front end has its own command names. A name in the table runs that command, also when the project
has a script of the same name (`yarn info`, `pnpm show` and `bun build` are never scripts); use
`<pm> run <name>` for such a script.

| Command | `npm` | `pnpm` | `yarn` | `bun` | Behaviour |
|---|---|---|---|---|---|
| install | `install`, `i`, `in`, `ins`, `inst`, `insta`, `instal`, `isnt`, `isnta`, `isntal`, `isntall`, `add` | `install`, `i` | `install` | `install`, `i` | With package arguments: [add](#add) them. Without: install the project. With `-g`: [global install](#global-install). |
| add | — | `add` | `add` | `add`, `a` | As install; without packages fails with `<pm> add requires at least one package` (exit 1). |
| ci | `ci`, `clean-install`, `ic`, `install-clean`, `isntall-clean` | `ci` | — | — | Delete `node_modules`, then install. A lockfile is not required, and is not checked against `package.json`. |
| update | `update`, `up`, `upgrade`, `udpate` | `update`, `up`, `upgrade` | `upgrade` | `update` | Install while ignoring lockfiles (newest versions within the ranges). Package arguments are ignored; everything is updated. |
| uninstall | `uninstall`, `unlink`, `remove`, `rm`, `r`, `un` | `remove`, `rm`, `uninstall`, `un`, `uni` | `remove` | `remove`, `rm` | Remove the names from `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, write `package.json`, install. Exit 1 without output if there is no `package.json`. With `-g`: from the global packages. |
| run | `run`, `run-script`, `rum`, `urn` | `run`, `run-script` | `run` | `run` | [Run a script](#npm-run). Without a name: list the scripts. |
| test, start | `test`, `t`, `tst`, `start`, `stop`, `restart` | `test`, `t`, `tst`, `start`, `restart` | — | — | `run test` / `run start` / …. `start` without a `start` script runs `node server.js` if `server.js` exists in the project directory. |
| exec | `exec`, `x` | `dlx` | `dlx` | `x` | [Install if needed and run a package's binary](#exec-npx-dlx). |
| local exec | — | `exec` | `exec` | — | Run a command with the project's binaries on `PATH`, without installing: a `node_modules/.bin/<cmd>` of the project or an ancestor, else (`pnpm exec` and `yarn exec`) any program on `PATH`. |
| shell | — | — | — | `exec` | `bun exec "<script>"`: run the arguments as one `/bin/sh -c` script with the [script environment](#script-environment). |
| create | (`init <name>`) | `create` | `create` | `create`, `c` | [Run a `create-*` package](#create-and-init). |
| init | `init`, `create`, `innit` | `init` | `init` | `init` | `npm init`/`npm create` with a name: same as `create`. Otherwise: [write a `package.json`](#create-and-init). |
| view | `view`, `info`, `show`, `v` | `view`, `info`, `show`, `v` | `info` | `info` | [Show registry metadata](#view). |
| ls | `ls`, `list`, `la`, `ll` | `list`, `ls`, `la`, `ll` | `list` | — | [List direct dependencies](#ls). |
| why | `why`, `explain` | `why` | `why` | `why` | Same output as `ls`. |
| reinstall | `prune`, `dedupe`, `ddp`, `rebuild`, `rb` | `prune`, `dedupe`, `rebuild`, `rb` | — | — | Run a normal install. |
| config | `config`, `c`, `get`, `set` | `config`, `c`, `get`, `set` | `config` | — | [Read and write `.npmrc` settings](#config). `get`/`set` are `config get`/`config set`. |
| pkg | `pkg` | `pkg` | — | — | [Read and write `package.json` fields](#pkg). |
| cache | `cache` | — | `cache` | — | `cache clean`, `clear`, `verify`, `rm`: delete the tarball cache and print `Cache cleaned`. Other subcommands do nothing (exit 0). |
| prefix | `prefix` | `prefix` | — | — | Print the project directory; with `-g`, `/usr/local`. |
| root | `root` | `root` | — | — | Print `<project>/node_modules`; with `-g`, `/usr/local/lib/node_modules/.ov-global/node_modules`, where global packages are. |
| bin | — | `bin` | `bin` | — | Print `<project>/node_modules/.bin`; with `-g`, `/usr/local/bin`. |
| help | `help` | `help` | `help` | `help` | Print the usage text, exit 0. |
| global | — | — | `global` | — | `yarn global add`/`remove` are `add -g`/`remove -g`; `yarn global bin` is `bin -g`; `yarn global list` lists the global packages. |
| workspace | — | — | `workspace`, `workspaces` | — | [Selecting workspaces](#selecting-workspaces). |
| pm | — | — | — | `pm` | `bun pm ls` (as `npm ls`), `bun pm bin [-g]`, `bun pm cache rm`, `bun pm view`. |
| not supported, exit 0 | `audit`, `fund` | `audit` | `audit` | `audit` | Print `<pm> <cmd> is not supported in OpenVessel` to stderr. |
| not supported, exit 1 | `doctor`, `outdated`, `login`, `publish`, `whoami`, `link`, `pack`, `version`, … | `outdated`, `publish`, `link`, `pack`, `patch`, `store`, `deploy`, … | `outdated`, `publish`, `link`, `pack`, `version`, `check`, … | `test`, `build`, `outdated`, `link`, `publish`, `patch`, `upgrade`, `repl`, `list` | Print `<pm> <cmd> is not supported in OpenVessel` to stderr. (`bun test` and `bun build` are Bun's test runner and bundler, not the scripts.) |

No command:

- `npm` prints its usage text (ending with `npm@10.9.3`) and exits 1.
- `pnpm`, `yarn` and `bun` install the project.

Any other command:

- `npm` prints `Unknown command: "<cmd>"` and a hint to run `npm help`, exit 1.
- `pnpm`, `yarn` and `bun` run the script `<cmd>` with the arguments that follow if `package.json` has
  one (`yarn show`, `bun t` run the scripts `show` and `t`). With `-r` or `--filter` (`pnpm`, `bun`),
  `<cmd>` is run as a script in the [selected workspaces](#selecting-workspaces).
- Otherwise `bun` runs `node <cmd> <args>` when `<cmd>` ends in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or
  `.tsx`; `pnpm` runs it like `pnpm exec`; `yarn` and `bun` run a `node_modules/.bin/<cmd>` of the
  project or an ancestor, and otherwise fail with `error Command "<cmd>" not found.` (`yarn`) or
  `error: Script not found "<cmd>"` (`bun`), exit 1.
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
| `name@<dist-tag>` (`latest`, `next`, …) | `^<version the tag points to>` |
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

`npm root -g` prints `/usr/local/lib/node_modules/.ov-global/node_modules`, where the packages are.
`uninstall -g <pkg…>` (`remove -g`, `yarn global remove`) removes the packages from the `.ov-global`
project and deletes the links in `/usr/local/bin` that point into it and whose package is gone.
`ls -g` lists the global packages.

### npm run

`run <name> [args…]` in the project directory:

1. No `package.json`: `npm error code ENOENT` / `npm error Could not read package.json in <dir>`, exit 254.
2. No name: prints `Scripts available in <name> via \`npm run-script\`:` and each script with its
   command, exit 0.
3. No script `<name>`: `npm error Missing script: "<name>"` and a hint, exit 1 (with every front end).
4. Otherwise runs `pre<name>`, `<name>`, `post<name>`, each only if defined. The arguments go to
   `<name>` only: with `npm`, the arguments after the name that are not options and everything after
   `--`; with `pnpm`, `yarn` and `bun`, everything after the name ([Options](#options)). `yarn` and `bun`
   drop an `--` right after the name (`yarn` warns that scripts don't require it); `pnpm` passes it on. The first script that exits non-zero
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

### Selecting workspaces

Scripts, `exec` and `add`/`uninstall` can work on [workspaces](#workspaces) of the workspace root (found
from the project directory) instead of the project:

| Front end | Selection |
|---|---|
| `npm` | `-w <name>`/`--workspace=<name>` (repeatable): the workspace with that name, or the workspaces in that directory or below it. `--workspaces`/`-ws`: all of them. `--include-workspace-root` adds the root. A name that matches nothing: `npm error No workspaces found:` / `npm error   --workspace=<name>`, exit 1. |
| `pnpm` | `--filter <sel>`/`-F <sel>` (repeatable): `<sel>` is a name (with `*`), `./path` or `{path}` (with `*`), or `!<sel>` to exclude; the dependency selectors `...` and `^` are dropped (the package itself is selected). `-r`/`--recursive`: all workspaces (the root only with `--include-workspace-root`). `-w`/`--workspace-root`: the root. |
| `bun` | `--filter <sel>`/`-F <sel>`, as `pnpm`. |
| `yarn` | `yarn workspace <name> <command…>` runs the command as if started in that workspace (`error Unknown workspace "<name>".` if there is none). `yarn workspaces run <script…>` runs the script in every workspace, stopping at the first failure. `yarn workspaces info` prints each workspace's `location` and `workspaceDependencies` as JSON. |

- `run` and scripts run by name run in each selected project in turn. `npm` runs every one and returns
  the last failing exit code (a workspace without the script is a `Missing script` error). `pnpm` and
  `bun` skip projects without the script, fail if none has it
  (` ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "<name>" script`), and stop
  at the first failure. When the filters match nothing, `pnpm` prints
  `No projects matched the filters in "<root>"` (exit 0).
- `npm exec -w`, `pnpm exec --filter`/`-r` run the command in each selected project's directory.
- `install <pkg…> -w <name>` (`pnpm add --filter`) adds the packages to each selected workspace's
  `package.json`, then installs the workspace root once.
- `install` without packages, `ci` and `update` always install the whole workspace root.

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
| `npm_config_<name>` | `npm` only: each `--<name>[=<value>]` option of the command line, with `-` in the name replaced by `_` (`--watch` → `npm_config_watch=true`, `--mode=prod` → `npm_config_mode=prod`) |

No other `npm_package_*` or `npm_config_*` variables are set.

```sh
$ npm pkg set scripts.where='echo $npm_lifecycle_event in $INIT_CWD'
$ npm run where -s
where in /home/user/app
```

### exec, npx, dlx

`npx <cmd> [args…]`, `npm exec <cmd>`, `npm x`, `pnpm dlx`, `yarn dlx`, `pnpx`, `bunx` and `bun x`:

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
| `npx`, `npm exec`, `npm x`, `bunx`, `bun x` | no | |
| `pnpm dlx`, `yarn dlx`, `pnpx` | yes | |
| `create`, `init <name>` | yes | |

There is no terminal prompt. When `npm exec`/`npx` installs a package that is not in the cache, it goes
ahead and prints `npm warn exec The following package was not found and will be installed: <name>@<version>`
to stderr, as npm does when it cannot ask; `-y`/`--yes` (or `-s`) installs without the warning, and
`--no` refuses with `npm error npx canceled due to missing packages and no YES option: ["<spec>"]`
(exit 1).

`--package <spec>` / `-p <spec>` / `--package=<spec>` (repeatable) installs `<spec>` and runs the
following command from it: `npx -p typescript tsc --version`, `npm exec -p <spec> -- <cmd> [args]`.
With `-c <cmd>`/`--call <cmd>`, `npm exec` runs `<cmd>` with `/bin/sh -c` and the packages' binaries on
`PATH` (`npx -p cowsay -c 'cowsay hi'`).

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

`npm view <name>[@<spec>] [field…]` fetches the package's full registry document (with `description`,
`license`, `maintainers`, `time`, …; the installer uses the abbreviated one). Without a name, or with
`.`, it shows the project's own package. The versions shown are the one a dist-tag points to (`latest`
without a spec), or every version matching a range.

- With fields, each is looked up in the version's manifest merged with the document's top level
  (`versions`, `dist-tags`, `time`, `maintainers`, …), with dotted paths (`dist.tarball`,
  `dependencies.react`). A single field of a single version prints a string raw; otherwise values are
  printed like `util.inspect` (`'1.2.0'`, `[ 'a', 'b' ]`), several fields as `<field> = <value>`, and
  several versions each prefixed with `<name>@<version> `. Missing fields print nothing.
- Without fields, npm's summary: `<name>@<version> | <license> | deps: <n> | versions: <n>`, the
  description, homepage, keywords, bin, `dist` (tarball, shasum, integrity, unpacked size),
  dependencies, maintainers, dist-tags and the publish date.
- `--json` prints the data (or the fields) as JSON; an array when several versions match.
- No matching version: `npm error code E404` / `npm error 404 No match found for version <spec>`, exit 1.
  A registry error prints `npm error code <code>` and the message, exit 1.

### ls

`npm ls` prints `<name>@<version> <dir>`, then one line per direct dependency (`dependencies`,
`devDependencies` and `optionalDependencies` together, sorted) with the version recorded in
`node_modules/.package-lock.json`, or `UNMET DEPENDENCY`. There is no tree, `--depth` or `--all`.
`ls -g` lists the global packages.

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

With `NODE_ENV=production` and none of `--omit=dev`, `--include=dev`, `--production`, the project's
`devDependencies` are not installed, as with npm. `engines` and `libc` are not checked.

These names are never installed, whatever lists them: `fsevents`, `bufferutil`, `utf-8-validate`,
`cpu-features`, `ssh2`.

### Specifiers

| Spec in `package.json` | Resolved as |
|---|---|
| semver range, exact version, `*`, `""` | registry, see [Version selection](#version-selection) |
| dist-tag (`latest`, `next`, `beta`) | registry, the version the tag points to |
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
- Commands can be run in selected workspaces, see [Selecting workspaces](#selecting-workspaces).

### Writing node_modules

- Packages from the previous install (in `node_modules/.package-lock.json`) that are no longer in the
  tree are deleted.
- A package is left alone if the previous record has the same version, source and kind (link or not),
  its `package.json` still has that version, and it is still a directory (a symlink for links and
  workspaces). A summary of `up to date` means nothing changed.
- Otherwise its directory is emptied (its nested `node_modules` is kept) and the tarball is unpacked:
  the first path component is removed, entries containing `..` are skipped, directories, regular files
  and symlinks are created, hard links and other entry types are skipped. Files with any execute bit
  get mode `0755`, others `0644`.
- When a package is installed under another name (an `npm:` alias, a WebAssembly substitute, a compat
  package), its `package.json` is rewritten with the installed `name` and `version` and a field
  `_openvesselSource: "<source package>@<version>"`, with the version that was actually unpacked.
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

Each entry has `version`, `resolved` (tarball URL, or a link's target relative to the project),
`integrity`, and `dev`, `optional`, `link` when true. A workspace has two entries, as in npm's lockfile:
`node_modules/<name>` with `link: true` and `resolved` its directory, and `<directory>` with its `name`
and `version`. It is used for "up to date" checks, pruning, `npm ls`, and by `exec` to recognize a
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
| `yarn` | `success Saved lockfile.` when `yarn.lock` was written (it changed), `success Already up-to-date.` when nothing changed, then `Done in <time>.` |

## Lockfiles

`readLockHints()` in `src/kernel/npm/lockfile.ts` looks for these files in the project directory, in
this order, and uses the first one that exists and parses (even if it yields no versions):

| File | What is read |
|---|---|
| `package-lock.json` | v2/v3: every entry of `packages` except the root and `link` entries; the name is the entry's `name` or the path after the last `node_modules/`. v1: the nested `dependencies` tree (`npm:` alias versions are reduced to the version). |
| `npm-shrinkwrap.json` | as `package-lock.json` |
| `pnpm-lock.yaml` | keys in the `packages:` and `snapshots:` sections: `name@version` (v6–v9) and `/name/version` (v5), quoted or not, with peer suffixes ignored |
| `yarn.lock` | Yarn v1: each entry's names (aliases `alias@npm:real@range` count as `real`) and its `version "x"`. Yarn Berry (a file with `__metadata:`): each entry's `resolution: "<name>@npm:<version>"`; workspace, patch and other non-npm resolutions are skipped. Berry's `checksum` is Yarn's hash of its own zip archive and is not used. |
| `bun.lock` | every `"name@x.y.z"` string in the file |

`bun.lockb` (binary) is not read.

The result is only a set of versions per package name. It is used in [Version selection](#version-selection)
step 2: the highest locked version that satisfies the range wins. The tree shape, `resolved` URLs and
`integrity` values of the lockfile are not used, and a lockfile that disagrees with `package.json` is
not an error. `update` ignores lockfiles.

### yarn.lock

After an install, `yarn` writes `yarn.lock` in the Yarn v1 format (`Installer.yarnLockfile()`), unless
`--frozen-lockfile`, `--pure-lockfile` or `--no-lockfile` is given; the file is only rewritten when its
contents change. Other front ends write no lockfile.

```text
# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


is-number@^6.0.0:
  version "6.0.0"
  resolved "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
  integrity sha512-…
```

- One entry per installed package, keyed by every `name@spec` that resolved to it (the spec as written
  by the dependent, before overrides), sorted.
- `resolved` is the tarball URL with `#<shasum>`; `dependencies` and `optionalDependencies` are those of
  the registry manifest, so a package replaced by a WebAssembly build or compat package is recorded as
  the registry package.
- Workspaces, `file:`/`link:` dependencies and peer edges get no entry.

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
| Compat tarball | fetched directly from `<runtime base>/compat/`, without the network policy check ([Native modules](native-modules.md)) |

Limits and retries:

- At most 16 metadata and tarball requests run at once (shared by one `Registry` object).
- Each request is tried up to 3 times, waiting 300 ms × attempt (metadata) or 400 ms × attempt
  (tarballs) between tries. `E404` and `EACCES` are not retried.
- While resolving, metadata of each listed dependency is requested ahead of time.

| Failure | `code` | Message |
|---|---|---|
| 404 | `E404` | `404 Not Found - GET <url> - '<name>' is not in this registry.` (metadata) or `404 Not Found - GET <url>` |
| other HTTP status | `E<status>` | `<status> <statusText> - GET <url>` |
| refused by the network policy | `EACCES` | the outbound proxy's message, then `npm error network access was denied by the OpenVessel network policy` |
| network failure, CORS | `ECONNREFUSED` | the outbound proxy's message |
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
| 0 | success; `-v`, `-h`, `help`; `audit`, `fund`; `config`/`cache` subcommands that do nothing |
| 1 | resolution, registry, network or integrity errors; missing script; unknown command; `npm` without a command; `add` without packages; `doctor`, `outdated`, `login`, `publish`, `whoami`; `exec` without a command or binary |
| 254 | no `package.json` for `install` or `run` |
| other | the exit code of a failing lifecycle or `run` script, or of the program started by `exec` |

## semver

`src/kernel/npm/semver.ts` implements the node-semver range syntax used in `package.json`:

| Syntax | Meaning |
|---|---|
| `1.2.3`, `=1.2.3`, `v1.2.3` | exactly that version (leading `v`/`=` ignored, build metadata `+…` ignored) |
| `1`, `1.x`, `1.2`, `1.2.*` | partial versions as ranges (`>=1.0.0 <2.0.0-0`, …) |
| `*`, `x`, `X`, `""` | any version (a dist-tag such as `latest` is not a range) |
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
