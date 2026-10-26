# パッケージマネージャ

[English](package-managers.md)

OpenVessel は、カーネル向けに書いた自前のパッケージマネージャを持ち、`npm`・`pnpm`・`yarn`・`bun` をその入口に
しています。このページでは、すべてのコマンドとフラグ、スクリプトの動かし方、`install` が依存を解決して
`node_modules` を並べる方法、読む lockfile、レジストリへのつなぎ方を説明します（`src/kernel/npm/`）。

## 概要

- 実装は 1 つ（`src/kernel/npm/cli.ts`）で、カーネルの Worker の中で非同期のプログラムとして動きます。本物の npm・
  pnpm・Yarn・Bun ではなく、`node` のプロセスも起こしません。
- 4 つの入口はどれも同じ方法で入れます。npm と同じ、巻き上げた（hoisted）`node_modules` です。pnpm の
  ストアや `.pnpm` ディレクトリ、Yarn の Plug'n'Play はありません。
- lockfile は版の手がかりとしてだけ読みます。lockfile を書くのは `yarn` だけです（v1 の形の `yarn.lock`。
  [yarn.lock](#yarnlock)）。それ以外に `node_modules` のほかで書くのは `node_modules/.package-lock.json` だけです
  （[隠れ lockfile](#隠れ-lockfile)）。
- レジストリへの通信は、ほかの外向きの要求と同じく、ランタイムでネットワークポリシーの確認を受けます（[ネットワークポリシー](network-policy.ja.md)）。
- ライフサイクルスクリプトはプロジェクト自身のものだけを動かし、依存のものは動かしません。
- ネイティブのパッケージは、入れるときに WebAssembly 版か互換パッケージに置き換えます
  （[ネイティブのモジュール](native-modules.ja.md)）。

### プログラム

どれも `/usr/bin` に登録されます（`src/kernel/npm/cli.ts` の `installNpm()`）。

| プログラム | 動き | `-v` で出す版 |
|---|---|---|
| `npm` | `npm` の入口 | `10.9.3` |
| `pnpm` | `pnpm` の入口 | `9.15.9` |
| `yarn` | `yarn` の入口 | `1.22.22` |
| `bun` | `bun` の入口 | `1.2.21` |
| `npx` | `npm exec`。コマンド名の後ろに `--` を差し込む（`npx -y tsc --help` は `npm exec -y -- tsc --help` として動く） | — |
| `pnpx` | `pnpm dlx <引数>` | — |
| `bunx` | `bun x <引数>` | — |
| `corepack` | 標準エラーに `corepack: package managers are built into OpenVessel; nothing to do` を出し、終了コード 0 | — |

入口どうしで、インストーラーとスクリプトの動かし方は同じです。違うのは、版、スクリプトに渡すユーザーエージェント、
持っているコマンドと、名前だけでスクリプトを動かせるかどうか（[コマンド](#コマンド)）、オプションを読む場所
（[オプション](#オプション)）、ワークスペースの選び方（[ワークスペースを選ぶ](#ワークスペースを選ぶ)）、スクリプトの
前の見出し、install の後の要約の行、`yarn.lock` です。

## コマンド行

### オプション

オプションは `parseFlags()` が読みます。どの引数をオプションとして読むかは、本物と同じく入口とコマンドで変わります。

- コマンド名より前の引数は、いつもその入口のオプションです（`npm -s run build`・`pnpm --filter a build`）。
- `npm` は `--` より前ならどこでも、コマンド名の後ろでもオプションを読みます（`npm run build -s`・
  `npm install foo -D`）。`--` の後ろはすべてそのまま渡します。
- `pnpm`・`yarn`・`bun` がコマンド名の後ろでオプションを読むのは、引数を渡さないコマンド（`install`・`add`・
  `remove`・`view` など）だけです。`run`・`exec`・`dlx` と、名前で動かすスクリプトでは、コマンドとスクリプト・
  パッケージ・コマンドの名前のあいだにあるものがその入口のオプションで、名前の後ろはすべてそのまま渡します。
  `yarn build --watch`・`pnpm run build --watch` は `--watch` つきでスクリプトを動かします。
- `npx` はコマンド名の後ろに `--` を差し込み（[プログラム](#プログラム)）、`pnpx`・`bunx` はパッケージ名の後ろを
  すべて渡すので、`npx tsc --noEmit`・`bunx tsc --watch` ではフラグが残ります。
- `-h`・`--help` で使い方を出すのは、オプションを読む場所にあるときだけです。`--` の後ろや、引数を渡すスクリプト・
  コマンドの名前の後ろでは、そのスクリプトやコマンドのものです。`npx tsc --help`・`npm run x -- --help` は
  `tsc --help`・`x --help` を動かします。

| オプション | 効果 |
|---|---|
| `-D`・`--save-dev`・`--dev`（`bun` では `-d` も） | `add`・`install <pkg>`: `devDependencies` に書く。`npm` の `-d` は `--loglevel info` で、効果はない |
| `-E`・`--save-exact`・`--exact` | `add`・`install <pkg>`: 解決した版をそのまま書く |
| `-g`・`--global` | `install`・`add`・`uninstall`・`remove`: [グローバルに入れる](#グローバルに入れる)。`prefix`・`root`・`bin`・`ls`: グローバルの場所 |
| `--production`・`--prod`・`--omit=dev`・`-P`（`pnpm`）・`-p`（`bun`） | プロジェクト（とワークスペース）の `devDependencies` を入れない |
| `--include=dev` | `NODE_ENV=production` でも `devDependencies` を入れる |
| `--omit=optional`・`--no-optional` | （すべてのパッケージの）`optionalDependencies` を入れない。`--include=optional` で取り消す |
| `--ignore-scripts` | プロジェクトの install のライフサイクルスクリプトを動かさない |
| `-y`・`--yes` | `exec`: ないパッケージを警告なしで入れる。`init`: `package.json` があっても書く |
| `--no`・`--no-yes` | `npm exec`・`npx`: ないパッケージを入れずに断る |
| `-s`・`--silent`・`--loglevel=silent`・`--reporter=silent` | 要約の行・警告・進み具合を出さない。`run` は見出しも失敗の文も出さない |
| `--legacy-peer-deps`・`--force` | peer 依存を入れない |
| `--json` | `view`: JSON で出す |
| `--if-present` | `run`: スクリプトがなくてもエラーにしない |
| `--frozen-lockfile`・`--pure-lockfile`・`--no-lockfile` | `yarn`: `yarn.lock` を書かない |
| `--prefix <dir>`・`-C <dir>`・`--dir <dir>`・`--cwd <dir>` と `=` の形 | 作業ディレクトリの代わりに `<dir>` から始める |
| `-w <x>`・`--workspace <x>`・`--workspaces`・`-ws`・`--include-workspace-root` | `npm`: [ワークスペースを選ぶ](#ワークスペースを選ぶ) |
| `--filter <x>`・`-F <x>`・`-r`・`--recursive`・`-w`・`--workspace-root`・`--include-workspace-root` | `pnpm`（`bun` は `--filter`・`-F`）: [ワークスペースを選ぶ](#ワークスペースを選ぶ) |
| `-p <spec>`・`--package <spec>` と `=` の形 | `exec`・`dlx`: 入れるパッケージ（[exec](#execnpxdlx)） |
| `-c <cmd>`・`--call <cmd>` | `npm exec`: パッケージのコマンドを `PATH` に入れてシェルのコマンドを動かす。`pnpm dlx` の `-c`・`--shell-mode`: パッケージの後ろの引数をシェルのコマンドとして動かす |
| `--` | 後ろをすべてそのまま渡す（`run` ならスクリプトへ、`exec` ならコマンドへ） |
| `-v`・`--version` | コマンドがなければ、入口の版を出して終了コード 0 |
| `-h`・`--help` | オプションを読む場所にあれば、短い使い方を出して終了コード 0 |
| そのほかのオプション | `npm`: `--<name>[=<value>]` は設定として残し、スクリプトに `npm_config_<name>` として渡す（`--no-<name>` は `false`）。`<name>` が npm の設定の名前でなければ、標準エラーに `npm warn Unknown cli config "--<name>". This will stop working in the next major version of npm.` を出す（`-s` なら出さない）。ほかの入口: 無視する（`--no-fund`・`--no-audit`・`--save` など） |

そのため `npm run build --watch` は、npm と同じく `--watch` なしでスクリプトを動かします（警告を出し、スクリプトの
環境には `npm_config_watch=true` が入ります）。`npm run build -- --watch` と書いてください。

### プロジェクトのディレクトリ

プロジェクトを相手にするコマンド（`install`・`ci`・`update`・`uninstall`・`run`・`test`・`ls`・`pkg` など）は、
作業ディレクトリ（または `--prefix`）から上へたどって、最初に `package.json` があるディレクトリを使います。
見つからなければ、始めたディレクトリをそのまま使います。`init`・`create`・`exec`・`view` は始めたディレクトリを
そのまま使います。

入れるコマンド（`install`・`add`・`ci`・`update`・`uninstall`・`prune` など）は、プロジェクトのディレクトリが
[ワークスペース](#ワークスペース)の 1 つなら、ワークスペースのルートを入れます。`add`・`uninstall` が書き換えるのは
そのワークスペース自身の `package.json` です。

### コマンド

コマンドの名前は入口ごとに違います。表にある名前は、プロジェクトに同じ名前のスクリプトがあってもそのコマンドを
動かします（`yarn info`・`pnpm show`・`bun build` はスクリプトになりません）。そうしたスクリプトは `<pm> run <name>` で
動かしてください。

| コマンド | `npm` | `pnpm` | `yarn` | `bun` | 動き |
|---|---|---|---|---|---|
| install | `install`・`i`・`in`・`ins`・`inst`・`insta`・`instal`・`isnt`・`isnta`・`isntal`・`isntall`・`add` | `install`・`i` | `install` | `install`・`i` | パッケージの引数があれば [add](#add)。なければプロジェクトを入れる。`-g` なら[グローバルに入れる](#グローバルに入れる) |
| add | — | `add` | `add` | `add`・`a` | install と同じ。パッケージがなければ `<pm> add requires at least one package`（終了コード 1） |
| ci | `ci`・`clean-install`・`ic`・`install-clean`・`isntall-clean` | `ci` | — | — | `node_modules` を消してから入れる。lockfile は要らず、`package.json` と食い違っていても調べない |
| update | `update`・`up`・`upgrade`・`udpate` | `update`・`up`・`upgrade` | `upgrade` | `update` | lockfile を無視して入れる（範囲の中でいちばん新しい版）。パッケージの引数は無視し、すべてを更新する |
| uninstall | `uninstall`・`unlink`・`remove`・`rm`・`r`・`un` | `remove`・`rm`・`uninstall`・`un`・`uni` | `remove` | `remove`・`rm` | 名前を `dependencies`・`devDependencies`・`optionalDependencies`・`peerDependencies` から消し、`package.json` を書いて入れ直す。`package.json` がなければ何も出さずに終了コード 1。`-g` ならグローバルのパッケージから消す |
| run | `run`・`run-script`・`rum`・`urn` | `run`・`run-script` | `run` | `run` | [スクリプトを動かす](#npm-run)。名前がなければ一覧を出す |
| test・start | `test`・`t`・`tst`・`start`・`stop`・`restart` | `test`・`t`・`tst`・`start`・`restart` | — | — | `run test`・`run start` など。`start` スクリプトがなく、プロジェクトに `server.js` があれば `node server.js` を動かす |
| exec | `exec`・`x` | `dlx` | `dlx` | `x` | [必要なら入れて、パッケージのコマンドを動かす](#execnpxdlx) |
| ローカルの exec | — | `exec` | `exec` | — | 入れずに、プロジェクトのコマンドを `PATH` に入れて動かす。プロジェクトかその上の `node_modules/.bin/<cmd>`、なければ（`pnpm exec`・`yarn exec`）`PATH` にあるどのプログラムでも |
| shell | — | — | — | `exec` | `bun exec "<script>"`: 引数を 1 つの `/bin/sh -c` のスクリプトとして、[スクリプトの環境](#スクリプトの環境)で動かす |
| create | （`init <name>`） | `create` | `create` | `create`・`c` | [`create-*` のパッケージを動かす](#create-と-init) |
| init | `init`・`create`・`innit` | `init` | `init` | `init` | 名前つきの `npm init`・`npm create` は `create` と同じ。ほかは [`package.json` を書く](#create-と-init) |
| view | `view`・`info`・`show`・`v` | `view`・`info`・`show`・`v` | `info` | `info` | [レジストリの情報を出す](#view) |
| ls | `ls`・`list`・`la`・`ll` | `list`・`ls`・`la`・`ll` | `list` | — | [直接の依存を並べる](#ls) |
| why | `why`・`explain` | `why` | `why` | `why` | `ls` と同じ出力 |
| reinstall | `prune`・`dedupe`・`ddp`・`rebuild`・`rb` | `prune`・`dedupe`・`rebuild`・`rb` | — | — | ふつうに入れる |
| config | `config`・`c`・`get`・`set` | `config`・`c`・`get`・`set` | `config` | — | [`.npmrc` の設定を読み書きする](#config)。`get`・`set` は `config get`・`config set` |
| pkg | `pkg` | `pkg` | — | — | [`package.json` の項目を読み書きする](#pkg) |
| cache | `cache` | — | `cache` | — | `cache clean`・`clear`・`verify`・`rm`: tarball のキャッシュを消して `Cache cleaned` を出す。ほかのサブコマンドは何もしない（終了コード 0） |
| prefix | `prefix` | `prefix` | — | — | プロジェクトのディレクトリを出す。`-g` なら `/usr/local` |
| root | `root` | `root` | — | — | `<プロジェクト>/node_modules` を出す。`-g` なら、グローバルのパッケージがある `/usr/local/lib/node_modules/.ov-global/node_modules` |
| bin | — | `bin` | `bin` | — | `<プロジェクト>/node_modules/.bin` を出す。`-g` なら `/usr/local/bin` |
| help | `help` | `help` | `help` | `help` | 使い方を出して終了コード 0 |
| global | — | — | `global` | — | `yarn global add`・`remove` は `add -g`・`remove -g`、`yarn global bin` は `bin -g`、`yarn global list` はグローバルのパッケージを並べる |
| workspace | — | — | `workspace`・`workspaces` | — | [ワークスペースを選ぶ](#ワークスペースを選ぶ) |
| pm | — | — | — | `pm` | `bun pm ls`（`npm ls` と同じ）・`bun pm bin [-g]`・`bun pm cache rm`・`bun pm view` |
| 対応していない（終了コード 0） | `audit`・`fund` | `audit` | `audit` | `audit` | 標準エラーに `<pm> <cmd> is not supported in OpenVessel` を出す |
| 対応していない（終了コード 1） | `doctor`・`outdated`・`login`・`publish`・`whoami`・`link`・`pack`・`version` など | `outdated`・`publish`・`link`・`pack`・`patch`・`store`・`deploy` など | `outdated`・`publish`・`link`・`pack`・`version`・`check` など | `test`・`build`・`outdated`・`link`・`publish`・`patch`・`upgrade`・`repl`・`list` | 標準エラーに `<pm> <cmd> is not supported in OpenVessel` を出す（`bun test`・`bun build` は Bun のテストランナーとバンドラーで、スクリプトではありません） |

コマンドがないとき:

- `npm` は使い方（最後が `npm@10.9.3`）を出し、終了コード 1 です。
- `pnpm`・`yarn`・`bun` はプロジェクトを入れます。

表にないコマンドのとき:

- `npm` は `Unknown command: "<cmd>"` と、`npm help` を動かすよう案内を出し、終了コード 1 です。
- `pnpm`・`yarn`・`bun` は、`package.json` に `<cmd>` という名前のスクリプトがあれば、続く引数をつけてそれを動かします
  （`yarn show`・`bun t` はスクリプトの `show`・`t` を動かします）。`-r` か `--filter` があれば（`pnpm`・`bun`）、
  `<cmd>` を[選んだワークスペース](#ワークスペースを選ぶ)のスクリプトとして動かします。
- スクリプトがなければ、`bun` は `<cmd>` が `.js`・`.mjs`・`.cjs`・`.ts`・`.mts`・`.tsx` で終わるとき
  `node <cmd> <引数>` を動かします。`pnpm` は `pnpm exec` と同じに動かします。`yarn`・`bun` はプロジェクトかその上の
  `node_modules/.bin/<cmd>` を動かし、なければ `error Command "<cmd>" not found.`（`yarn`）か
  `error: Script not found "<cmd>"`（`bun`）で失敗します（終了コード 1）。
- `bun run <file>` は `<file>` という名前のスクリプトを探します。ファイルを動かすのは `bun <file>` だけです。

### add

`install <pkg…>`・`add <pkg…>` は `package.json` を書き換えてから、プロジェクト全体を入れます。`package.json` が
なければ、`name`（ディレクトリの名前）と `version` `1.0.0` だけのものを作ります。

引数は `name` か `name@spec` です（スコープ付きなら `@scope/name@spec`）。書かれる内容:

| 引数 | 書かれる範囲 |
|---|---|
| `name` | `^<latest>`（`latest` の dist-tag の版） |
| `name@<range>`（そのままの版でない、正しい semver の範囲） | 渡した範囲のまま |
| `name@<version>`（そのままの版） | `^<version>` |
| `name@<dist-tag>`（`latest`・`next` など） | `^<tag が指す版>` |
| `name@file:…`・`link:…`・`workspace:…`・`http(s)://…`・`git…`・`github:…`・`npm:…` | 渡したまま。レジストリには問い合わせない |
| 上のどれかに `-E` | 解決した版そのもの（レジストリのものだけ） |

- `-D` がなければ `dependencies`、あれば `devDependencies` に書き、もう一方からは消します。書いた後、その項目を
  名前の順に並べ替えます。
- どの公開版にも合わない範囲は `npm error code ETARGET`・`npm error notarget No matching version found for <引数>.`
  で失敗します（終了コード 1）。レジストリのエラーは `npm error code <code>` とメッセージを出します（終了コード 1）。
- 名前のない引数（`user/repo`・`./dir`・URL だけ）は名前としてレジストリを引き、失敗します。`name@<spec>` と書くか、
  `package.json` に書いてください。
- `--save-optional`・`--save-peer` などは無視され、`dependencies` に書かれます。

### グローバルに入れる

`npm install -g <pkg…>`（`add -g` やほかの入口でも同じ）:

1. `/usr/local/lib/node_modules/.ov-global` をプロジェクトとして使います。なければ
   `{ "name": "global", "private": true }` の `package.json` で作ります。
2. そこへ [add](#add) と同じようにパッケージを足します。スクリプトはいつも動かしません。
3. `/usr/local/lib/node_modules/.ov-global/node_modules/.bin` の中身を、`/usr/local/bin` へ絶対パスのシンボリック
   リンクで張ります。同じ名前のリンクは置き換えます。`/usr/local/bin` は既定の `PATH` に入っています。

`npm root -g` は、パッケージがある `/usr/local/lib/node_modules/.ov-global/node_modules` を出します。
`uninstall -g <pkg…>`（`remove -g`・`yarn global remove`）は `.ov-global` のプロジェクトからパッケージを消し、
`/usr/local/bin` のリンクのうち、そこを指していてパッケージがなくなったものを消します。`ls -g` はグローバルの
パッケージを並べます。

### npm run

プロジェクトのディレクトリで `run <name> [引数…]` を動かすと:

1. `package.json` がない: `npm error code ENOENT`・`npm error Could not read package.json in <dir>`、終了コード 254。
2. 名前がない: `Scripts available in <name> via \`npm run-script\`:` と、各スクリプトとコマンドを出して終了コード 0。
3. `<name>` のスクリプトがない: `npm error Missing script: "<name>"` と案内、終了コード 1（どの入口でも）。
4. それ以外: `pre<name>`・`<name>`・`post<name>` を、あるものだけ順に動かします。引数は `<name>` にだけ渡します。
   `npm` では名前の後ろのオプションでない引数と `--` の後ろすべて、`pnpm`・`yarn`・`bun` では名前の後ろすべてです
   （[オプション](#オプション)）。名前のすぐ後ろの `--` は `yarn`・`bun` が捨て（`yarn` はスクリプトには要らないと
   警告します）、`pnpm` はそのまま渡します。0 以外で終わったスクリプトでそこまでとし、その終了コードを返します。
   `npm` で `-s` がなければ、失敗のときに次も出します。

```text
npm error Lifecycle script `build` failed with error:
npm error code 3
npm error path /home/user/app
npm error command failed
npm error command sh -c exit 3
```

スクリプトは `/bin/sh -c '<スクリプト> <引数>'` として、プロジェクトのディレクトリを作業ディレクトリにし、
[スクリプトの環境](#スクリプトの環境)で動きます。引数はスクリプトの文字列の後ろにつなげます。英数字と
`_ . / : = @ % + -` 以外を含む引数は一重引用符で囲みます。`-s` がなければ、各スクリプトの前に標準出力へ見出しを出します。

| 入口 | 見出し |
|---|---|
| `npm`・`pnpm`・`bun` | 空行、`> <name>@<version> <event>`、`> <コマンド>`、空行 |
| `yarn` | `$ <コマンド>` |

`pre`・`post` はいつも動きます。`--ignore-scripts` は `run` に効きません。

### ワークスペースを選ぶ

スクリプト・`exec`・`add`・`uninstall` は、プロジェクトの代わりに、（プロジェクトのディレクトリから見つけた）
ワークスペースのルートの[ワークスペース](#ワークスペース)を相手にできます。

| 入口 | 選び方 |
|---|---|
| `npm` | `-w <name>`・`--workspace=<name>`（くり返せる）: その名前のワークスペース、またはそのディレクトリとその下のワークスペース。`--workspaces`・`-ws`: すべて。`--include-workspace-root` でルートも足す。何にも合わない名前は `npm error No workspaces found:`・`npm error   --workspace=<name>`、終了コード 1 |
| `pnpm` | `--filter <sel>`・`-F <sel>`（くり返せる）: `<sel>` は名前（`*` 可）、`./path` か `{path}`（`*` 可）、除くなら `!<sel>`。依存をたどる `...`・`^` は外す（そのパッケージ自身を選ぶ）。`-r`・`--recursive`: すべてのワークスペース（ルートは `--include-workspace-root` のときだけ）。`-w`・`--workspace-root`: ルート |
| `bun` | `--filter <sel>`・`-F <sel>`。`pnpm` と同じ |
| `yarn` | `yarn workspace <name> <コマンド…>` は、そのワークスペースで始めたようにコマンドを動かす（なければ `error Unknown workspace "<name>".`）。`yarn workspaces run <スクリプト…>` はすべてのワークスペースでスクリプトを動かし、最初の失敗で止まる。`yarn workspaces info` は各ワークスペースの `location` と `workspaceDependencies` を JSON で出す |

- `run` と名前で動かすスクリプトは、選んだプロジェクトで順に動きます。`npm` はすべてで動かし、最後に失敗した終了コードを
  返します（スクリプトのないワークスペースは `Missing script` のエラー）。`pnpm`・`bun` はスクリプトのないプロジェクトを
  飛ばし、どれにもなければ失敗し（` ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "<name>" script`）、
  最初の失敗で止まります。フィルターに何も合わなければ、`pnpm` は `No projects matched the filters in "<root>"` を
  出します（終了コード 0）。
- `npm exec -w`・`pnpm exec --filter`・`-r` は、選んだプロジェクトそれぞれのディレクトリでコマンドを動かします。
- `install <pkg…> -w <name>`（`pnpm add --filter`）は、選んだワークスペースそれぞれの `package.json` にパッケージを
  足し、ワークスペースのルートを 1 回入れます。
- パッケージなしの `install`・`ci`・`update` は、いつもワークスペースのルート全体を入れます。

### install のライフサイクル

プロジェクトを入れるとき（`install`・`add`・`ci`・`update`・`uninstall`・`prune` など）、`--ignore-scripts` がなければ、
プロジェクト自身の `package.json` の次のスクリプトを、あるものだけ動かします。

| 順 | スクリプト | いつ |
|---|---|---|
| 1 | `preinstall` | 何かを解決する前 |
| 2 | `install` | `node_modules` を書いた後 |
| 3 | `postinstall` | |
| 4 | `preprepare` | |
| 5 | `prepare` | |
| 6 | `postprepare` | |

失敗したスクリプトがあると、その終了コードで install を止めます。見出しは `-s` でも出ます。要約の行は最後の
スクリプトの後に出ます。

動かさないもの: 依存のスクリプトすべて（ネイティブのバイナリをビルドしたりダウンロードしたりする
`preinstall`・`install`・`postinstall` も含む）、ワークスペースのパッケージのスクリプト、`exec`・`create`・
`install -g` で入れたパッケージのスクリプト。

### スクリプトの環境

`scriptEnv()` が、呼んだ側の環境に次を足して作ります。

| 変数 | 値 |
|---|---|
| `PATH` | プロジェクトのディレクトリと、その上の各ディレクトリ（`/` まで）の `<dir>/node_modules/.bin`、続けて呼んだ側の `PATH`（既定は `/usr/local/bin:/usr/bin:/bin`） |
| `npm_lifecycle_event` | スクリプトの名前（`build`・`prebuild`・`postinstall` など）。[exec](#execnpxdlx) では `npx` |
| `npm_lifecycle_script` | 動かすコマンド行（つなげた引数も含む） |
| `npm_package_name` | `package.json` の `name`。なければ空 |
| `npm_package_version` | `package.json` の `version`。なければ空 |
| `npm_package_json` | プロジェクトの `package.json` の絶対パス |
| `npm_config_user_agent` | `<pm>/<version> npm/? node/v22.23.4 linux x64 workspaces/false`。`exec` では元の値を残すので、`pnpm` のスクリプトの中の `npx` が動かすコマンドにも `pnpm` と見えます（`only-allow` などがこれに頼ります） |
| `npm_execpath` | `/usr/lib/node_modules/<pm>/bin/<pm>-cli.js` |
| `npm_node_execpath` | `/usr/bin/node` |
| `npm_command` | `test`・`start` のスクリプトならその名前、ほかは `run-script`（install 中も） |
| `INIT_CWD` | コマンドを始めた作業ディレクトリ |
| `NODE` | `/usr/bin/node` |
| `COLOR` | 標準出力が端末なら `1`、ちがえば `0` |
| `npm_config_<name>` | `npm` だけ。コマンド行の `--<name>[=<value>]` ごとに、名前の `-` を `_` にしたもの（`--watch` → `npm_config_watch=true`、`--mode=prod` → `npm_config_mode=prod`） |

ほかの `npm_package_*`・`npm_config_*` は設定しません。

```sh
$ npm pkg set scripts.where='echo $npm_lifecycle_event in $INIT_CWD'
$ npm run where -s
where in /home/user/app
```

### exec・npx・dlx

`npx <cmd> [引数…]`・`npm exec <cmd>`・`npm x`・`pnpm dlx`・`yarn dlx`・`pnpx`・`bunx`・`bun x`:

1. コマンドがない: `npm error npx requires a command`、終了コード 1。
2. コマンドに版がなく（`cowsay@1` でなく `cowsay`）、`--package` もなく、入れ直しを強いないとき:
   - 始めたディレクトリかその上のどこかに `node_modules/.bin/<cmd>` があれば、それを動かします（呼んだ側の
     作業ディレクトリで、[スクリプトの環境](#スクリプトの環境)で）。
   - なければ、`PATH` で見つかったプログラムをそのまま動かします。ただし `/bin/` にあるものと、名前が `create-` で
     始まるものは除きます（`npx node -e …` は `/usr/bin/node` を動かし、`/usr/local/bin` にグローバルに入れた
     コマンドも使われます）。
3. それ以外は `$HOME/.npm/_npx/<key>` に入れます。`<key>` はパッケージの指定で、英数字・`_`・`@`・`.`・`-` 以外の
   連なりを `_` にし、100 文字で切ったものです。そのディレクトリに、パッケージを依存に持つ `npx-cache` という名の
   `package.json` を置き（版がなければ `latest`）、スクリプトなしで静かに入れます。キャッシュのディレクトリが
   すでにあれば（`node_modules/.package-lock.json` がある）、新しい版を調べずにそのまま使います。入れ直しを強いる
   ときは別です。
4. 動かすコマンドはパッケージの `bin` から選びます。パッケージと同じ名前（スコープなし）のもの、なければ 1 つだけの
   もの、なければ `<スコープなしの名前>`。`--package` のときは `<cmd>` そのものです。ファイルがなければ
   `npm error could not determine executable to run for <cmd>`、終了コード 1。
5. 呼んだ側の作業ディレクトリで、スクリプトの環境（`npm_lifecycle_event=npx`）に、キャッシュの
   `node_modules/.bin` を `PATH` の先頭に足して動かします。

| 入口 | 入れ直しを強いる | 補足 |
|---|---|---|
| `npx`・`npm exec`・`npm x`・`bunx`・`bun x` | いいえ | |
| `pnpm dlx`・`yarn dlx`・`pnpx` | はい | |
| `create`・`init <name>` | はい | |

端末で尋ねることはしません。`npm exec`・`npx` がキャッシュにないパッケージを入れるときは、そのまま入れて、標準エラーに
`npm warn exec The following package was not found and will be installed: <name>@<version>` を出します（npm が尋ねられない
ときと同じです）。`-y`・`--yes`（か `-s`）なら警告なしで入れ、`--no` なら
`npm error npx canceled due to missing packages and no YES option: ["<spec>"]` で断ります（終了コード 1）。

`--package <spec>`・`-p <spec>`・`--package=<spec>`（くり返せる）は `<spec>` を入れ、その中から続くコマンドを動かします。
`npx -p typescript tsc --version`・`npm exec -p <spec> -- <cmd> [引数]` のように使います。`-c <cmd>`・`--call <cmd>` が
あれば、`npm exec` はパッケージのコマンドを `PATH` に入れて `<cmd>` を `/bin/sh -c` で動かします
（`npx -p cowsay -c 'cowsay hi'`）。

### create と init

`npm create <x> [引数]`・`npm init <x> [引数]`（と `pnpm`・`yarn`・`bun create`）は、雛形のパッケージを、入れ直しを
強いた `exec` で動かします。

| 引数 | 動かすパッケージ |
|---|---|
| `vite` | `create-vite` |
| `vite@5` | `create-vite@5` |
| `@scope` | `@scope/create` |
| `@scope/app` | `@scope/create-app`（スコープ付きの名前の後の版は捨てる） |

名前のない `npm init`（または最初の引数が `-` で始まるとき）は、尋ねずに `package.json` を書きます。

```json
{
  "name": "<ディレクトリ名を小文字にし、a-z 0-9 . _ - 以外を - にしたもの>",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": { "test": "echo \"Error: no test specified\" && exit 1" },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
```

`Wrote to <path>:` と JSON を出します。`package.json` があれば `package.json already exists in <dir>` を出して何も
変えません。`-y` があれば上書きします。

### view

`npm view <name>[@<spec>] [項目…]` は、パッケージのレジストリの完全な文書（`description`・`license`・`maintainers`・
`time` などを含むもの。インストーラーが使うのは省略版）を取ってきます。名前がないか `.` なら、プロジェクト自身の
パッケージを出します。出す版は、dist-tag が指す版（指定がなければ `latest`）か、範囲に合うすべての版です。

- 項目があれば、その版の manifest に文書の上の階層（`versions`・`dist-tags`・`time`・`maintainers` など）を合わせた
  ものから、点でつないだパス（`dist.tarball`・`dependencies.react`）で引きます。1 つの版の 1 つの項目で文字列なら
  そのまま、ほかは `util.inspect` のように（`'1.2.0'`・`[ 'a', 'b' ]`）出し、項目が複数なら `<項目> = <値>`、版が
  複数なら行の頭に `<name>@<version> ` をつけます。ない項目は何も出しません。
- 項目がなければ npm と同じ要約です。`<name>@<version> | <license> | deps: <n> | versions: <n>`、説明、ホームページ、
  キーワード、bin、`dist`（tarball・shasum・integrity・展開後の大きさ）、依存、メンテナー、dist-tags、公開日。
- `--json` なら、情報（か項目）を JSON で出します。合う版が複数なら配列です。
- 合う版がない: `npm error code E404`・`npm error 404 No match found for version <spec>`、終了コード 1。レジストリの
  エラーは `npm error code <code>` とメッセージを出し、終了コード 1。

### ls

`npm ls` は `<name>@<version> <dir>` を出し、続けて直接の依存（`dependencies`・`devDependencies`・
`optionalDependencies` をまとめて並べ替えたもの）を 1 行ずつ、`node_modules/.package-lock.json` に記録された版か
`UNMET DEPENDENCY` で出します。木の形、`--depth`、`--all` はありません。`ls -g` はグローバルのパッケージを並べます。

```text
app@1.0.0 /home/user/app
├── astro@5.14.1
└── is-odd@3.0.1
```

### config

| サブコマンド | 動き |
|---|---|
| `config get [key]` | [`.npmrc` と環境変数](#レジストリと-npmrc)から決まる値を出す。既定は `registry` → `https://registry.npmjs.org/`、`prefix` → `/usr/local`、ほかは `undefined`。キーがなければ `registry` |
| `config set <key>=<value>`・`config set <key> <value>` | `$HOME/.npmrc` に書く。`<key>=` で始まる行は置き換える |
| `config list`・`config ls` | 決まった設定をすべて `key = "value"` の形で出す |
| そのほか | 何もしない（終了コード 0） |

### pkg

| サブコマンド | 動き |
|---|---|
| `pkg get` | `package.json` 全体を JSON で出す |
| `pkg get <path>` | 点でつないだパスの値を JSON で出す（`"q"`・`{…}`）。なければ `undefined` |
| `pkg set <path>=<value>…` | 各パスに文字列の値を入れ（途中のオブジェクトは作る）、ファイルを書く |
| そのほか | 終了コード 1 |

## install

`src/kernel/npm/install.ts` の `Installer.run()` です。順に:

1. `package.json` を読む（なければ `npm error code ENOENT`・`npm error Could not read package.json:
   <dir>/package.json`、終了コード 254）。
2. lockfile の手がかりを読み（`update` では読まない）、`preinstall` を動かす。
3. overrides とワークスペースを集める。
4. 幅優先で木を解決する。
5. 新しいものと変わったものをダウンロードし、確かめて展開する（同時に 16 件まで）。
6. コマンドのリンクを張り、`node_modules/.package-lock.json` を書く。
7. 残りのライフサイクルスクリプトを動かし、要約を出す。

### 依存の種類

| 種類 | 入れる相手 |
|---|---|
| `dependencies` | すべてのパッケージ |
| `optionalDependencies` | すべてのパッケージ。`--omit=optional` なら入れない。解決できなくても警告で、エラーにしない |
| `devDependencies` | プロジェクトとワークスペースだけ。`--omit=dev` なら入れない |
| `peerDependencies` | すべての依存（プロジェクト自身は除く）。`peerDependenciesMeta` で optional のものは除く。`--legacy-peer-deps`・`--force`・`.npmrc` の `legacy-peer-deps=true` なら入れない |
| `bundleDependencies` | 特別には扱わない（tarball にあるものを展開する） |

`NODE_ENV=production` で、`--omit=dev`・`--include=dev`・`--production` のどれもなければ、npm と同じくプロジェクトの
`devDependencies` を入れません。`engines` と `libc` は調べません。

次の名前は、どこに書かれていても入れません: `fsevents`・`bufferutil`・`utf-8-validate`・`cpu-features`・`ssh2`。

### 指定の書き方

| `package.json` の指定 | 解決のしかた |
|---|---|
| semver の範囲・そのままの版・`*`・`""` | レジストリ。[版の選び方](#版の選び方) |
| dist-tag（`latest`・`next`・`beta`） | レジストリ。tag が指す版 |
| `npm:<name>@<range>`・`npm:<name>` | レジストリの `<name>` を、別名の下に入れる |
| `workspace:<range>` | その名前のワークスペースがあればそれ。なければ接頭辞を外してレジストリ（`*`・`^`・`~` はどの版でも） |
| `catalog:`・`catalog:<name>` | レジストリのどの版でも（`*`）。カタログは読まない |
| `file:<path>`・`link:<path>` | `<path>` へのシンボリックリンク。パスはプロジェクトのディレクトリから解決する。その依存も入れる |
| `user/repo`・`user/repo#ref`・`github:user/repo`・`git+https://github.com/…`・`git+ssh://git@github.com…`・`https://github.com/…`・`git://github.com/…` | tarball `https://codeload.github.com/<user>/<repo>/tar.gz/<ref>`（既定は `HEAD`。ref の `semver:` 接頭辞は外すだけで、範囲としては解決しない） |
| `http://…`・`https://…` | その URL の tarball |

ほかの git のホストには対応していません（指定が dist-tag として読まれ、`ETARGET` で失敗します）。GitHub と URL の
tarball には確かめる integrity がありません。

### 版の選び方

レジストリの指定では（`pickVersion()`）:

1. 正しい範囲でない: その名前の dist-tag が、ある版を指していればその版。なければなし。
2. lockfile の手がかりに、このパッケージの、実在して範囲に合う版があれば（プレリリースも可）、そのうちいちばん高いもの。
3. `latest` の dist-tag が範囲に合えば、それ。
4. 範囲に合ういちばん高い版。なければプレリリースも含めて同じように。

合う版がない: `npm error code ETARGET`・`npm error No matching version found for <name>@<range>.`、終了コード 1
（optional の依存なら警告）。この後、ネイティブのパッケージの決まりが版や中身を変えることがあります
（[ネイティブのモジュール](native-modules.ja.md)）。

### 置き場所

木は npm の巻き上げた形と同じように作ります（`choosePlacement()`・`findVisible()`）。

- 依存はまず、依存する側から見える同じ名前のパッケージを探します。依存する側自身の `node_modules`、続けて外側の
  `node_modules` をプロジェクトのルートまで（ワークスペースはルートにあるものとして数えます）。そのパッケージが
  指定に合い、peer の組も合えば使い回します。ワークスペースはいつも使い回します。
- peer 依存は、依存する側の入れ物から探し始めるので、依存する側の兄弟と同じものを共有します。見えている peer が
  範囲に合わなくてもそれを使い、`npm warn ERESOLVE <pkg>@<version> wants peer <peer>@"<range>", found <version>` と
  警告します。
- 新しいパッケージはできるだけ上に置きます。1 段ずつ上がり、その段に同じ名前のパッケージがなく、そこに置いても
  別の版へ解決済みの依存を隠さず、必要な peer が合うもの（依存する側が使うのと同じもの）に解決されるあいだは上がります。
- ネイティブの決まりで版を固定したパッケージは、依存する側の `node_modules` に置きます。
- パッケージの `dev`・`optional` の印は、dev でない・optional でない道が 1 本でも届けば外れます。

### 環境での絞り込み

解決した後、`os` か `cpu` が OpenVessel を除いているパッケージは入れません。OpenVessel は `os: linux`、
`cpu: wasm32` として数えます。`!` の否定も読み、空のリストは何でも受け入れます。optional でない依存を飛ばすときは
`npm warn EBADPLATFORM skipping <name>@<version> (needs <os> / <cpu>)` と出します。これで環境ごとのネイティブの
パッケージ（`cpu: ["x64"]`）は外れ、`wasm32` のパッケージは入ります。

解決中にほかに出す警告: `npm warn deprecated <name>@<version>: <message>` と
`npm warn optional skipping <name>@<spec>: <message>`。同じ警告は 1 回だけ出します。

### overrides と resolutions

プロジェクトの `package.json` の `overrides`（npm）・`resolutions`（Yarn）・`pnpm.overrides` を読みます。

- 値が文字列のものだけを使います。入れ子のオブジェクト（npm の、親ごとの overrides）は無視します。
- 先頭の `**/` を外し、キーについた版の指定（`foo@1`・`@scope/foo@1`）を捨てるので、どの版にも効きます。
- それでも `/` を含み、スコープ付きの名前でないキー（`a/b`、Yarn のパスの形）は無視します。
- 値が `$name` なら、プロジェクト自身の `dependencies`・`devDependencies` の `name` の指定を使います。なければ `*`。
- その名前への依存すべて（直接の依存も含む）の指定を置き換えます。

```json
{
  "dependencies": { "is-odd": "3.0.1" },
  "overrides": { "is-number": "6.0.0" }
}
```

### ワークスペース

ワークスペースのディレクトリは、`package.json` の `workspaces`（配列か `{ "packages": [...] }`）と、
`pnpm-workspace.yaml` の `packages:` のリスト（ブロックでもインラインでも。このファイルのほかのキーは読まない）から
取ります。両方を合わせて使います。

- パターンの区切りごとに、そのままの名前、`*` か `**`（`node_modules` と `.` で始まるもの以外のディレクトリ。1 段だけ）、
  または `*` を含む名前が使えます。`!` で始まるパターンは飛ばします（何も除きません）。
- `name` を持つ `package.json` があるディレクトリを数えます。プロジェクトのルート自身はワークスペースになりません。
- 各ワークスペースを `node_modules/<name>` に、ディレクトリへの相対のシンボリックリンクで置き、その
  `dependencies`・`optionalDependencies`・`devDependencies` をルートの木に入れます。
- ワークスペースの名前への依存は、範囲が何であってもそのワークスペースに解決します。
- ワークスペースの `bin` は、ルートの `node_modules/.bin` にリンクします。
- コマンドを選んだワークスペースで動かせます。[ワークスペースを選ぶ](#ワークスペースを選ぶ)を見てください。

### node_modules を書く

- 前回の install（`node_modules/.package-lock.json`）にあり、木からなくなったパッケージは消します。
- 前回の記録と版・出どころ・種類（リンクかどうか）が同じで、`package.json` がまだその版で、まだディレクトリ
  （リンクとワークスペースならシンボリックリンク）なら、そのパッケージには触りません。要約が `up to date` なら、
  何も変わっていません。
- そうでなければディレクトリを空にし（入れ子の `node_modules` は残す）、tarball を展開します。パスの最初の部分を
  外し、`..` を含むものは飛ばし、ディレクトリ・ふつうのファイル・シンボリックリンクを作り、ハードリンクとほかの
  種類は飛ばします。実行のビットが 1 つでもあるファイルは `0755`、ほかは `0644` です。
- パッケージを別の名前で入れるとき（`npm:` の別名、WebAssembly 版への置き換え、互換パッケージ）は、`package.json` を
  入れた `name` と `version` に書き換え、`_openvesselSource: "<元のパッケージ>@<version>"` を足します。この版は
  実際に展開した版です。
- `file:`・`link:` の依存とワークスペースは、相対のシンボリックリンクです。

### コマンドのリンク

木の中の `node_modules` ごとに、その中に直接あるパッケージの `bin` を、その `.bin`（`node_modules/.bin`、入れ子なら
`.../node_modules/x/node_modules/.bin`）にリンクします。

- 文字列の `bin` は、パッケージの名前（スコープなし）で張ります。`bin` がなければ `directories.bin` のディレクトリの
  ファイルすべてを使います。
- レジストリの manifest を先に、なければ展開した `package.json` を使います。
- `/` か `..` を含む名前は飛ばします。リンクは相対で、リンク先には実行の権限をつけます。
- 名前がぶつかったら、その入れ物の直接の依存が、巻き上げられた間接の依存に勝ちます。

### 隠れ lockfile

`node_modules/.package-lock.json` に、入れた木を記録します。

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

各項目は `version`・`resolved`（tarball の URL か、プロジェクトからの相対のリンク先）・`integrity` と、真のときだけ
`dev`・`optional`・`link` を持ちます。ワークスペースは npm の lockfile と同じく 2 項目です。`link: true` で `resolved` が
そのディレクトリの `node_modules/<name>` と、`name` と `version` を持つ `<ディレクトリ>` です。「up to date」の判定、消すものの判定、`npm ls`、`exec` のキャッシュの見分けに使います。版の手がかりには
使いません。

### 進み具合と要約

標準エラーが端末で `-s` がなければ、進み具合の行をその場で書き換えます（`\r\x1b[K`）。依存 50 件ごとの
`resolving… <n> packages`、`fetching <n> packages…`、パッケージ 25 件ごとの `extracting… <done>/<total>` です。
警告の前と最後に消します。

要約は標準出力に出します（`-s` なら出しません）。`<time>` は 1 秒未満なら `<n>ms`、それ以上は `<n.n>s` です。

| 入口 | 要約 |
|---|---|
| `npm`・`bun` | 空行に続けて `added <n> package(s)[, and audited <total+1> packages] in <time>`。何も足さなかったときは `up to date in <time>`。`audited` の部分は、すでに置いてあったパッケージがあるときに出ます |
| `pnpm` | `Packages: +<n>` と `Done in <time>` |
| `yarn` | `yarn.lock` を書いた（中身が変わった）ら `success Saved lockfile.`、何も変わらなければ `success Already up-to-date.`、続けて `Done in <time>.` |

## lockfile

`src/kernel/npm/lockfile.ts` の `readLockHints()` は、プロジェクトのディレクトリでこの順にファイルを探し、最初に
あって読めたもの（版が 1 つも取れなくても）を使います。

| ファイル | 読むもの |
|---|---|
| `package-lock.json` | v2・v3: `packages` の項目のうち、ルートと `link` の項目を除いたすべて。名前は項目の `name`、なければ最後の `node_modules/` の後ろのパス。v1: 入れ子の `dependencies` の木（`npm:` の別名の版は版だけにする） |
| `npm-shrinkwrap.json` | `package-lock.json` と同じ |
| `pnpm-lock.yaml` | `packages:` と `snapshots:` の中のキー。`name@version`（v6〜v9）と `/name/version`（v5）。引用符はあってもなくてもよく、peer の後ろ書きは無視する |
| `yarn.lock` | Yarn v1: 各項目の名前（`alias@npm:real@range` の別名は `real` として数える）と `version "x"`。Yarn Berry（`__metadata:` のあるファイル）: 各項目の `resolution: "<name>@npm:<version>"`。ワークスペースや patch など npm 以外の resolution は飛ばす。Berry の `checksum` は Yarn 自身の zip のハッシュなので使わない |
| `bun.lock` | ファイルの中の `"name@x.y.z"` の文字列すべて |

`bun.lockb`（バイナリ）は読みません。

読んだ結果は、パッケージの名前ごとの版の集まりにすぎません。[版の選び方](#版の選び方)の 2 で使い、範囲に合う、
固定された版のうちいちばん高いものが選ばれます。lockfile の木の形・`resolved` の URL・`integrity` は使わず、
`package.json` と食い違っていてもエラーにしません。`update` は lockfile を無視します。

### yarn.lock

`yarn` は入れた後、`yarn.lock` を Yarn v1 の形で書きます（`Installer.yarnLockfile()`）。`--frozen-lockfile`・
`--pure-lockfile`・`--no-lockfile` があれば書きません。中身が変わったときだけ書き直します。ほかの入口は lockfile を
書きません。

```text
# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


is-number@^6.0.0:
  version "6.0.0"
  resolved "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
  integrity sha512-…
```

- 入れたパッケージごとに 1 項目で、キーはそのパッケージに解決したすべての `name@spec`（依存する側が書いたままの
  指定。overrides の前）を並べ替えたものです。
- `resolved` は tarball の URL に `#<shasum>` をつけたものです。`dependencies`・`optionalDependencies` はレジストリの
  manifest のものなので、WebAssembly 版や互換パッケージに置き換えたパッケージも、レジストリのパッケージとして記録します。
- ワークスペース、`file:`・`link:` の依存、peer の依存は項目になりません。

## レジストリと .npmrc

### 設定

`readNpmrc()` は次を合わせます。後のものが勝ちます。

1. `$HOME/.npmrc`（`HOME` の既定は `/home/user`）
2. `/` からプロジェクトのディレクトリまでの各ディレクトリの `.npmrc`
3. 環境変数 `npm_config_<key>`（大文字小文字は問わず、キーは小文字にし、`_` を `-` にする）

行は `key = value` で、`#` か `;` で始まる行は注釈です。前後の引用符を外し、`${VAR}` を環境変数で置き換えます
（なければ空）。

効くキー:

| キー | 効果 |
|---|---|
| `registry` | スコープのないパッケージのレジストリの URL（既定は `https://registry.npmjs.org/`。最後に `/` を足す） |
| `@scope:registry` | `@scope/*` のパッケージのレジストリの URL |
| `legacy-peer-deps` | `true` なら `--legacy-peer-deps` と同じ |

ほかのキーは `npm config get`・`list` で見えるだけです。認証の設定（`_authToken`・`_auth`・`//host/:…`）は送りません。
要求に資格情報はつきません。

### 要求

レジストリと tarball への要求は、どれもカーネルからランタイムの Service Worker の `/__ov/net` へ行きます。そこで
カーネルの通信の方針に尋ね、ブラウザの `fetch` で要求します（Cookie なし、CORS のモード）。許可を求めるときに
見える呼び出し元は `npm` です。通信の方針の `npm` のセットは `registry.npmjs.org`・`registry.npmjs.com`・
`registry.yarnpkg.com`・`registry.npmmirror.com` を通します。GitHub の依存には `github` のセットか、
`codeload.github.com` を通す決まりが要ります（[通信の方針](network-policy.ja.md)）。相手は CORS のヘッダーを
返す必要があります。

| 要求 | 中身 |
|---|---|
| パッケージの情報 | `GET <registry><name>`。スコープ付きの名前の `/` は `%2f` にする。ヘッダー `accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*`（省略版の情報） |
| tarball | `dist.tarball` の URL への `GET`。gzip は先頭のバイトで見分け、`DecompressionStream` で戻す |
| 互換パッケージの tarball | `<ランタイムの基点>/compat/` から直接取る。ネットワークポリシーの確認は通らない（[ネイティブのモジュール](native-modules.ja.md)） |

上限とやり直し:

- 情報と tarball の要求は、合わせて同時に 16 件までです（1 つの `Registry` で共有）。
- 各要求は 3 回まで試し、間に 300 ms × 回数（情報）か 400 ms × 回数（tarball）待ちます。`E404` と `EACCES` は
  やり直しません。
- 解決中は、並んだ各依存の情報を前もって取りに行きます。

| 失敗 | `code` | メッセージ |
|---|---|---|
| 404 | `E404` | `404 Not Found - GET <url> - '<name>' is not in this registry.`（情報）または `404 Not Found - GET <url>` |
| ほかの HTTP の状態 | `E<status>` | `<status> <statusText> - GET <url>` |
| 通信の方針で断られた | `EACCES` | 外部通信の制御が出すメッセージ。続けて `npm error network access was denied by the OpenVessel network policy` |
| 通信の失敗・CORS | `ECONNREFUSED` | 外部通信の制御が出すメッセージ |
| integrity が合わない | `EINTEGRITY` | `integrity checksum failed for <url>` |

失敗した install は（どの入口でも）`npm error code <code>` と `npm error <message>` を出し、終了コード 1 です。

### キャッシュ

- パッケージの情報は、レジストリの設定ごとに、カーネルが動いているあいだメモリに置きます。同じパッケージの 2 度目の
  `install` や `view` は、ページを読み直すかレジストリの設定が変わるまで、レジストリに尋ねません。失敗した要求は
  覚えません。
- tarball は、ランタイムのオリジンの Cache Storage の `openvessel-npm-v1` に、URL をキーにして置きます。読み直しても
  残ります。キャッシュから取るたびに integrity を確かめ、合わなければ消して取り直します。`npm cache clean` は
  キャッシュ全体を消します。

### integrity

`verify()` は tarball を `dist.integrity`（Subresource Integrity。`sha512`・`sha384`・`sha256`・`sha1` のどれでも、
空白区切りで複数可。1 つ合えばよい）と比べます。integrity の文字列があっても対応するハッシュがなければ失敗です。
`integrity` がなければ 16 進の `dist.shasum`（SHA-1）を比べます。どちらもなければ（GitHub と URL の tarball）
確かめません。

## 終了コード

| コード | いつ |
|---|---|
| 0 | 成功。`-v`・`-h`・`help`。`audit`・`fund`。何もしない `config`・`cache` のサブコマンド |
| 1 | 解決・レジストリ・通信・integrity のエラー。スクリプトがない。知らないコマンド。コマンドなしの `npm`。パッケージなしの `add`。`doctor`・`outdated`・`login`・`publish`・`whoami`。コマンドかその実体がない `exec` |
| 254 | `install`・`run` で `package.json` がない |
| そのほか | 失敗したライフサイクルや `run` のスクリプト、または `exec` が動かしたプログラムの終了コード |

## semver

`src/kernel/npm/semver.ts` は、`package.json` で使う node-semver の範囲の書き方を実装しています。

| 書き方 | 意味 |
|---|---|
| `1.2.3`・`=1.2.3`・`v1.2.3` | その版だけ（先頭の `v`・`=` とビルドのメタデータ `+…` は無視） |
| `1`・`1.x`・`1.2`・`1.2.*` | 一部だけの版を範囲として（`>=1.0.0 <2.0.0-0` など） |
| `*`・`x`・`X`・`""` | どの版でも（`latest` などの dist-tag は範囲ではない） |
| `^1.2.3`・`^0.2.3`・`^0.0.3`・`^1.x` | キャレット。次のメジャーまで。`0.x` では次のマイナーかパッチまで |
| `~1.2.3`・`~1.2`・`~1`・`~>1.2` | チルダ。次のマイナーまで（`~1` は次のメジャーまで） |
| 完全な版か一部の版に `>`・`>=`・`<`・`<=` | 比較（`>1.2` → `>=1.3.0`、`<=1.2` → `<1.3.0-0`） |
| `1.2.3 - 2.3`・`1 - 2` | ハイフンの範囲（一部だけの上限は、次の版を含まない） |
| 空白で区切った比較 | かつ |
| `\|\|` | または |

プレリリースは node-semver と同じです。`1.2.3-beta.1` のような版は、同じ組の比較のどれかが同じ `1.2.3` の
プレリリースを持つときだけ範囲に合います（`includePrerelease` のときは別）。loose のモードや coerce はありません。
読んだ範囲はメモリに覚えます。外に出す関数: `parse`・`valid`・`compare`・`parseRange`・`validRange`・`satisfies`・
`maxSatisfying`・`minVersion`・`rsort`。

## ソースファイル

| ファイル | 中身 |
|---|---|
| `src/kernel/npm/cli.ts` | 入口・フラグ・コマンド・スクリプト・`.npmrc` |
| `src/kernel/npm/install.ts` | 解決・置き場所・ネイティブのパッケージの決まり・展開・コマンドのリンク・隠れ lockfile |
| `src/kernel/npm/lockfile.ts` | lockfile の読み取り |
| `src/kernel/npm/registry.ts` | レジストリと tarball の要求・キャッシュ・integrity |
| `src/kernel/npm/tar.ts` | gzip と tar（ustar・pax・GNU の長い名前） |
| `src/kernel/npm/semver.ts` | semver |
