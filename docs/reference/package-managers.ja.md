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
- lockfile は版の手がかりとしてだけ読みます。どの入口も lockfile を書きも更新もしません。`node_modules` の
  ほかに書くのは `node_modules/.package-lock.json` だけです（[隠れ lockfile](#隠れ-lockfile)）。
- レジストリへの通信は、ほかの外向きの要求と同じくランタイムの関所を通ります（[通信の方針](network-policy.ja.md)）。
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
| `npx` | `npm exec -- <引数>`。引数から `-y`・`--yes` をすべて取り除く | — |
| `pnpx` | `pnpm dlx <引数>` | — |
| `bunx` | `bun x <引数>` | — |
| `corepack` | 標準エラーに `corepack: package managers are built into OpenVessel; nothing to do` を出し、終了コード 0 | — |

入口によって変わるのは次の点だけです。版、スクリプトに渡すユーザーエージェント、install の後の要約の行、
スクリプトの前の見出し、コマンドなしのときの動き、知らないコマンドでスクリプトを動かすかどうか
（[コマンド](#コマンド)）。

## コマンド行

### フラグ

フラグは、どのコマンド・どの入口でも `parseFlags()` が同じように読みます。`--` より前ならどこに置いてもかまいません。

| フラグ | 効果 |
|---|---|
| `-D`・`-d`・`--save-dev`・`--dev` | `add`・`install <pkg>`: `devDependencies` に書く |
| `-E`・`--save-exact`・`--exact` | `add`・`install <pkg>`: 解決した版をそのまま書く |
| `-g`・`--global` | `install`・`add`: グローバルに入れる。`prefix`・`root`: グローバルの場所を出す |
| `--production`・`--prod`・`-P`・`--omit=dev` | プロジェクト（とワークスペース）の `devDependencies` を入れない |
| `--omit=optional`・`--no-optional` | （すべてのパッケージの）`optionalDependencies` を入れない |
| `--ignore-scripts` | プロジェクトの install のライフサイクルスクリプトを動かさない |
| `-y`・`--yes` | `init`: `package.json` があっても書く |
| `-s`・`--silent`・`--loglevel=silent`・`--reporter=silent` | 要約の行・警告・進み具合を出さない。`run` は見出しも失敗の文も出さない |
| `--legacy-peer-deps`・`--force` | peer 依存を入れない |
| `--prefix <dir>`・`-C <dir>`・`--dir <dir>`・`--cwd <dir>` と `=` の形 | 作業ディレクトリの代わりに `<dir>` から始める |
| `-w <x>`・`--workspace <x>`・`--filter <x>`・`-F <x>` と `=` の形 | 受け付ける（値も読み取る）が、効果はない |
| `--` | 後ろをすべてそのまま渡す（`run` ならスクリプトへ、`exec` ならコマンドへ） |
| `-v`・`--version` | コマンドがなければ、入口の版を出して終了コード 0 |
| `-h`・`--help` | 引数のどこにあっても（`--` の後でも）短い使い方を出して終了コード 0 |
| `-` で始まるそのほかの引数 | 無視する（`--no-fund`・`--no-audit`・`--frozen-lockfile`・`--save` など） |

この読み方から、次のことが起きます。

- `--` より前の知らないフラグは、`run` や `exec` でも捨てられます。`yarn build --watch` や
  `npm run build --watch` は `--watch` なしでスクリプトを動かします。`npm run build -- --watch` と書いてください。
  `npx` は引数をすべて `--` の後ろに置くので、`npx tsc --noEmit` ではフラグが残ります。
- `-h`・`--help` を最初に調べるので、`npx tsc --help` や `npm run x -- --help` は何も動かさず、OpenVessel の
  使い方を出します。

### プロジェクトのディレクトリ

プロジェクトを相手にするコマンド（`install`・`ci`・`update`・`uninstall`・`run`・`test`・`ls`・`pkg` など）は、
作業ディレクトリ（または `--prefix`）から上へたどって、最初に `package.json` があるディレクトリを使います。
見つからなければ、始めたディレクトリをそのまま使います。`init`・`create`・`exec`・`view` は始めたディレクトリを
そのまま使います。

### コマンド

| コマンド | 別名 | 動き |
|---|---|---|
| `install` | `i`・`in`・`isntall`・`add` | パッケージの引数があれば [add](#add)。なければプロジェクトを入れる。引数なしの `add` は `<pm> add requires at least one package`（終了コード 1）。`-g` なら[グローバルに入れる](#グローバルに入れる) |
| `ci` | `clean-install`・`install-clean` | `node_modules` を消してから入れる。lockfile は要らず、`package.json` と食い違っていても調べない |
| `update` | `up`・`upgrade` | lockfile を無視して入れる（範囲の中でいちばん新しい版）。パッケージの引数は無視し、すべてを更新する |
| `uninstall` | `remove`・`rm`・`un`・`unlink` | 名前を `dependencies`・`devDependencies`・`optionalDependencies`・`peerDependencies` から消し、`package.json` を書いて入れ直す。`package.json` がなければ何も出さずに終了コード 1 |
| `run` | `run-script`・`rum`・`urn` | [スクリプトを動かす](#npm-run)。名前がなければ一覧を出す |
| `test` | `t`・`tst` | `run test` |
| `start`・`stop`・`restart` | — | `run start`・`run stop`・`run restart`。`start` スクリプトがなく、プロジェクトに `server.js` があれば `node server.js` を動かす |
| `exec` | `x`・`dlx` | [パッケージのコマンドを動かす](#execnpxdlx) |
| `create` | — | [`create-*` のパッケージを動かす](#create-と-init) |
| `init` | — | 名前があれば `create` と同じ。なければ（フラグだけでも）[`package.json` を書く](#create-と-init) |
| `view` | `info`・`show`・`v` | [レジストリの情報を出す](#view) |
| `ls` | `list`・`ll`・`la` | [直接の依存を並べる](#ls) |
| `why` | `explain` | `ls` と同じ出力 |
| `prune`・`dedupe`・`rebuild` | `ddp`・`rb` | ふつうに入れる |
| `config` | `c` | [`.npmrc` の設定を読み書きする](#config) |
| `pkg` | — | [`package.json` の項目を読み書きする](#pkg) |
| `cache` | — | `cache clean`・`cache clear`・`cache verify`: tarball のキャッシュを消して `Cache cleaned` を出す。ほかのサブコマンドは何もしない（終了コード 0） |
| `prefix` | — | プロジェクトのディレクトリを出す。`-g` なら `/usr/local` |
| `root` | — | `<プロジェクト>/node_modules` を出す。`-g` なら `/usr/local/lib/node_modules` |
| `bin` | — | `<プロジェクト>/node_modules/.bin` を出す |
| `audit`・`fund` | — | 標準エラーに `<pm> <cmd> is not supported in OpenVessel` を出し、終了コード 0 |
| `doctor`・`outdated`・`login`・`publish`・`whoami` | — | 標準エラーに `<pm> <cmd> is not supported in OpenVessel` を出し、終了コード 1 |

コマンドがないとき:

- `npm` は使い方（最後が `npm@10.9.3`）を出し、終了コード 1 です。
- `pnpm`・`yarn`・`bun` はプロジェクトを入れます。

表にないコマンドのとき:

- `npm` は `Unknown command: "<cmd>"` と案内を出し、終了コード 1 です（`npm help` もコマンドではないので、ここに来ます）。
- `pnpm`・`yarn`・`bun` は、`package.json` に `<cmd>` という名前のスクリプトがあればそれを動かします。なければ、
  `bun` は `<cmd>` が `.js`・`.mjs`・`.cjs`・`.ts`・`.mts`・`.tsx` で終わるとき `node <cmd> <引数>` を動かします。
  それ以外は [`exec`](#execnpxdlx) と同じに動かします。表のコマンドはスクリプトより先に効きます。プロジェクトに
  `show` スクリプトがあっても `yarn show` は `view` を動かすので、`yarn run show` と書いてください。
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
| `name@<dist-tag>` | `^<tag が指す版>` |
| `name@latest` | `latest`（範囲として読めるため。[semver](#semver)） |
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

`npm root -g` が出すのは `/usr/local/lib/node_modules` で、`.ov-global` ではありません。`uninstall -g` には
グローバルの動きがなく、今のプロジェクトを相手にします。

### npm run

プロジェクトのディレクトリで `run <name> [引数…]` を動かすと:

1. `package.json` がない: `npm error code ENOENT`・`npm error Could not read package.json in <dir>`、終了コード 254。
2. 名前がない: `Scripts available in <name> via \`npm run-script\`:` と、各スクリプトとコマンドを出して終了コード 0。
3. `<name>` のスクリプトがない: `npm error Missing script: "<name>"` と案内、終了コード 1（どの入口でも）。
4. それ以外: `pre<name>`・`<name>`・`post<name>` を、あるものだけ順に動かします。引数（`--` の後ろと、名前の後の
   ふつうの引数）は `<name>` にだけ渡します。0 以外で終わったスクリプトでそこまでとし、その終了コードを返します。
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

ほかの `npm_package_*`・`npm_config_*` は設定しません。

```sh
$ npm pkg set scripts.where='echo $npm_lifecycle_event in $INIT_CWD'
$ npm run where -s
where in /home/user/app
```

### exec・npx・dlx

`npx <cmd> [引数…]`・`npm exec <cmd>`・`npm x`・`pnpm dlx`・`yarn dlx`・`pnpx`・`bunx`、それに `pnpm`・`yarn`・`bun` の
知らないコマンドの行き先:

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
| `npx`・`npm exec`・`npm x`・`bunx`・`npm dlx` | いいえ | |
| `pnpm dlx`・`yarn dlx`・`pnpx` | はい | |
| `create`・`init <name>` | はい | |

`--package <spec>`・`-p <spec>`・`--package=<spec>` は `<spec>` を入れ、その中から続くコマンドを動かします。
`npm exec -p <spec> -- <cmd> [引数]` なら動きます。`npx -p …` ではフラグが暗黙の `--` の後ろに入り、コマンドとして
扱われるので、`npm error could not determine executable to run for -p` で失敗します。

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

`npm view <name>[@<spec>] [項目…]` はパッケージの情報を取ってきます。版は `latest` の tag、範囲に合ういちばん高い版、
または dist-tag が指す版です。

- 項目があれば、1 つずつ行に出します。`versions`（公開されたすべての版）、`dist-tags`、またはその版の manifest の中を
  点でつないだパス（`dependencies.react`）。文字列はそのまま、ほかは字下げした JSON で出します。
- 項目がなければ要約です。`<name>@<version> | <license> | deps: <n>`、説明、dist-tags。
- 引数がない、または合う版がない: 何も出さずに終了コード 1。レジストリのエラーは `npm error code <code>` と
  メッセージを出し、終了コード 1。

情報はインストーラーと同じ省略版の文書で、`description` も `license` もありません。そのため要約は `Proprietary` と
空の説明になり、完全な文書にしかない項目は `undefined` と出ます。

### ls

`npm ls` は `<name>@<version> <dir>` を出し、続けて直接の依存（`dependencies`・`devDependencies`・
`optionalDependencies` をまとめて並べ替えたもの）を 1 行ずつ、`node_modules/.package-lock.json` に記録された版か
`UNMET DEPENDENCY` で出します。木の形、`--depth`、`--all` はありません。

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

`NODE_ENV` は入れるものに影響しません。`engines` と `libc` は調べません。

次の名前は、どこに書かれていても入れません: `fsevents`・`bufferutil`・`utf-8-validate`・`cpu-features`・`ssh2`。

### 指定の書き方

| `package.json` の指定 | 解決のしかた |
|---|---|
| semver の範囲・そのままの版・`*`・`""`・`latest` | レジストリ。[版の選び方](#版の選び方) |
| ほかの dist-tag（`next`・`beta`） | レジストリ。tag が指す版 |
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
- `--workspace`・`--filter` でワークスペースは選べません。コマンドはいつもルートのプロジェクトを相手にします。

### node_modules を書く

- 前回の install（`node_modules/.package-lock.json`）にあり、木からなくなったパッケージは消します。
- 前回の記録と版も出どころも同じで、`package.json` がまだその版なら、そのパッケージには触りません。要約が
  `up to date` なら、何も変わっていません。
- そうでなければディレクトリを空にし（入れ子の `node_modules` は残す）、tarball を展開します。パスの最初の部分を
  外し、`..` を含むものは飛ばし、ディレクトリ・ふつうのファイル・シンボリックリンクを作り、ハードリンクとほかの
  種類は飛ばします。実行のビットが 1 つでもあるファイルは `0755`、ほかは `0644` です。
- パッケージを別の名前で入れるとき（`npm:` の別名、WebAssembly 版への置き換え、互換パッケージ）は、`package.json` を
  入れた `name` と `version` に書き換え、`_openvesselSource: "<元のパッケージ>@<version>"` を足します。
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

各項目は `version`・`resolved`（tarball の URL かリンク先）・`integrity` と、真のときだけ `dev`・`optional`・`link` を
持ちます。「up to date」の判定、消すものの判定、`npm ls`、`exec` のキャッシュの見分けに使います。版の手がかりには
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
| `yarn` | `success Saved lockfile.` と `Done in <time>.`（lockfile は実際には書きません） |

## lockfile

`src/kernel/npm/lockfile.ts` の `readLockHints()` は、プロジェクトのディレクトリでこの順にファイルを探し、最初に
あって読めたもの（版が 1 つも取れなくても）を使います。

| ファイル | 読むもの |
|---|---|
| `package-lock.json` | v2・v3: `packages` の項目のうち、ルートと `link` の項目を除いたすべて。名前は項目の `name`、なければ最後の `node_modules/` の後ろのパス。v1: 入れ子の `dependencies` の木（`npm:` の別名の版は版だけにする） |
| `npm-shrinkwrap.json` | `package-lock.json` と同じ |
| `pnpm-lock.yaml` | `packages:` と `snapshots:` の中のキー。`name@version`（v6〜v9）と `/name/version`（v5）。引用符はあってもなくてもよく、peer の後ろ書きは無視する |
| `yarn.lock` | Yarn v1: 各項目の名前（`alias@npm:real@range` の別名は `real` として数える）と `version "x"`。Yarn Berry のファイルも同じ決まりで読みますが、`name@npm:range` のキーから取れる名前がどのパッケージとも合わないので、Berry の lockfile は効きません |
| `bun.lock` | ファイルの中の `"name@x.y.z"` の文字列すべて |

`bun.lockb`（バイナリ）は読みません。

読んだ結果は、パッケージの名前ごとの版の集まりにすぎません。[版の選び方](#版の選び方)の 2 で使い、範囲に合う、
固定された版のうちいちばん高いものが選ばれます。lockfile の木の形・`resolved` の URL・`integrity` は使わず、
`package.json` と食い違っていてもエラーにしません。`update` は lockfile を無視します。どの入口も lockfile を書きも
更新もしません。

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
| 互換パッケージの tarball | `<ランタイムの基点>/compat/` から直接取る。関所は通らない（[ネイティブのモジュール](native-modules.ja.md)） |

上限とやり直し:

- 情報と tarball の要求は、合わせて同時に 16 件までです（1 つの `Registry` で共有）。
- 各要求は 3 回まで試し、間に 300 ms × 回数（情報）か 400 ms × 回数（tarball）待ちます。`E404` と `EACCES` は
  やり直しません。
- 解決中は、並んだ各依存の情報を前もって取りに行きます。

| 失敗 | `code` | メッセージ |
|---|---|---|
| 404 | `E404` | `404 Not Found - GET <url> - '<name>' is not in this registry.`（情報）または `404 Not Found - GET <url>` |
| ほかの HTTP の状態 | `E<status>` | `<status> <statusText> - GET <url>` |
| 通信の方針で断られた | `EACCES` | 関所のメッセージ。続けて `npm error network access was denied by the OpenVessel network policy` |
| 通信の失敗・CORS | `ECONNREFUSED` | 関所のメッセージ |
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
| 0 | 成功。`-v`・`-h`。`audit`・`fund`。何もしない `config`・`cache` のサブコマンド |
| 1 | 解決・レジストリ・通信・integrity のエラー。スクリプトがない。知らないコマンド。コマンドなしの `npm`。パッケージなしの `add`。`doctor`・`outdated`・`login`・`publish`・`whoami`。コマンドかその実体がない `exec` |
| 254 | `install`・`run` で `package.json` がない |
| そのほか | 失敗したライフサイクルや `run` のスクリプト、または `exec` が動かしたプログラムの終了コード |

## semver

`src/kernel/npm/semver.ts` は、`package.json` で使う node-semver の範囲の書き方を実装しています。

| 書き方 | 意味 |
|---|---|
| `1.2.3`・`=1.2.3`・`v1.2.3` | その版だけ（先頭の `v`・`=` とビルドのメタデータ `+…` は無視） |
| `1`・`1.x`・`1.2`・`1.2.*` | 一部だけの版を範囲として（`>=1.0.0 <2.0.0-0` など） |
| `*`・`x`・`X`・`""`・`latest` | どの版でも |
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
