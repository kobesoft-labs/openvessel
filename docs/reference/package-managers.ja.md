# パッケージマネージャ

[English](package-managers.md)

OpenVessel は、カーネル用に書いた独自のパッケージマネージャを持っており、`npm`・`pnpm`・`yarn`・`bun` はその
フロントエンドです（`src/kernel/npm/`）。このページには、すべてのコマンドとフラグ、スクリプトの実行方法、`install` が
依存関係を解決して `node_modules` を構成する方法、読み込む lockfile、レジストリへのアクセス方法をまとめています。

## 概要

- 実装は 1 つ（`src/kernel/npm/cli.ts`）で、カーネルの Worker 内で非同期のプログラムとして動きます。本物の npm・pnpm・
  Yarn・Bun ではなく、`node` プロセスも起動しません。
- 4 つのフロントエンドはどれも同じ方法でインストールします。npm と同じ、巻き上げ（hoisting）方式の `node_modules` です。
  pnpm のコンテンツアドレス方式のストアや `.pnpm` ディレクトリ、Yarn の Plug'n'Play はありません。
- lockfile はバージョンのヒントとしてだけ読みます。lockfile を書き出すのは `yarn` だけです（v1 形式の `yarn.lock`。
  [yarn.lock](#yarnlock) を参照）。それ以外では、`node_modules` のほかに書き込むファイルは
  `node_modules/.package-lock.json` だけです（[隠し lockfile](#隠し-lockfile) を参照）。
- レジストリとの通信は、ほかの外部へのリクエストと同じく、ランタイムでネットワークポリシーの確認を受けます
  （[ネットワークポリシー](network-policy.ja.md)）。
- ライフサイクルスクリプトはプロジェクト自身のものだけを実行し、依存パッケージのものは実行しません。
- ネイティブのパッケージは、インストール時に WebAssembly 版か互換パッケージに置き換えます
  （[ネイティブモジュール](native-modules.ja.md)）。

### プログラム

どのプログラムも `/usr/bin` に登録されます（`src/kernel/npm/cli.ts` の `installNpm()`）。

| プログラム | 動作 | `-v` で表示するバージョン |
|---|---|---|
| `npm` | `npm` のフロントエンド | `10.9.3` |
| `pnpm` | `pnpm` のフロントエンド | `9.15.9` |
| `yarn` | `yarn` のフロントエンド | `1.22.22` |
| `bun` | `bun` のフロントエンド | `1.2.21` |
| `npx` | `npm exec`。コマンド名の後ろに `--` を挿入する（`npx -y tsc --help` は `npm exec -y -- tsc --help` として実行される） | — |
| `pnpx` | `pnpm dlx <引数>` | — |
| `bunx` | `bun x <引数>` | — |
| `corepack` | 標準エラーに `corepack: package managers are built into OpenVessel; nothing to do` を出力し、終了コード 0 | — |

インストーラーとスクリプトの実行部分は、すべてのフロントエンドで共通です。フロントエンドごとに異なるのは、
バージョン、スクリプトに渡すユーザーエージェント、使えるコマンドと名前だけでスクリプトを実行できるかどうか
（[コマンド](#コマンド)）、オプションを読む位置（[オプション](#オプション)）、ワークスペースの選び方
（[ワークスペースを選ぶ](#ワークスペースを選ぶ)）、スクリプトの前に出すバナー、インストール後の要約行、そして
`yarn.lock` です。

## コマンドライン

### オプション

オプションは `parseFlags()` が解析します。どの引数をオプションとして読むかは、本物のクライアントと同じく、
フロントエンドとコマンドによって変わります。

- コマンド名より前の引数は、常にクライアントのオプションです（`npm -s run build`・`pnpm --filter a build`）。
- `npm` は `--` より前であれば、コマンド名の後ろでもオプションを読みます（`npm run build -s`・`npm install foo -D`）。
  `--` より後ろはすべてそのまま渡します。
- `pnpm`・`yarn`・`bun` がコマンド名の後ろでオプションを読むのは、引数を渡さないコマンド（`install`・`add`・`remove`・
  `view` など）だけです。`run`・`exec`・`dlx` と名前で実行するスクリプトでは、コマンドとスクリプト名・パッケージ名・
  コマンド名の間にあるものがクライアントのオプションで、その名前より後ろはすべてそのまま渡します。
  `yarn build --watch` や `pnpm run build --watch` は、スクリプトを `--watch` 付きで実行します。
- `npx` はコマンド名の後ろに `--` を挿入し（[プログラム](#プログラム)）、`pnpx`・`bunx` はパッケージ名より後ろを
  すべて渡します。そのため `npx tsc --noEmit` や `bunx tsc --watch` ではフラグがそのまま残ります。
- `-h`・`--help` で使い方を表示するのは、オプションを読む位置にある場合だけです。`--` の後ろや、引数をそのまま渡す
  スクリプト名・コマンド名の後ろにある場合は、そのスクリプトやコマンドへの引数になります。`npx tsc --help` と
  `npm run x -- --help` は、それぞれ `tsc --help` と `x --help` を実行します。

| オプション | 効果 |
|---|---|
| `-D`・`--save-dev`・`--dev`（`bun` では `-d` も） | `add`・`install <pkg>`: `devDependencies` に保存する。`npm` の `-d` は `--loglevel info` で、効果はない |
| `-E`・`--save-exact`・`--exact` | `add`・`install <pkg>`: 解決したバージョンをそのまま保存する |
| `-g`・`--global` | `install`・`add`・`uninstall`・`remove`: [グローバルインストール](#グローバルインストール)。`prefix`・`root`・`bin`・`ls`: グローバルのパス |
| `--production`・`--prod`・`--omit=dev`・`-P`（`pnpm`）・`-p`（`bun`） | プロジェクト（とワークスペース）の `devDependencies` をインストールしない |
| `--include=dev` | `NODE_ENV=production` でも `devDependencies` をインストールする |
| `--omit=optional`・`--no-optional` | （すべてのパッケージの）`optionalDependencies` をインストールしない。`--include=optional` で取り消す |
| `--ignore-scripts` | プロジェクトのインストール時のライフサイクルスクリプトを実行しない |
| `-y`・`--yes` | `exec`: 見つからないパッケージを警告なしでインストールする。`init`: `package.json` があっても書き込む |
| `--no`・`--no-yes` | `npm exec`・`npx`: 見つからないパッケージのインストールを拒否する |
| `-s`・`--silent`・`--loglevel=silent`・`--reporter=silent` | 要約行・警告・進捗を表示しない。`run` はバナーも失敗時のメッセージも表示しない |
| `--legacy-peer-deps`・`--force` | peer 依存をインストールしない |
| `--json` | `view`: JSON で出力する |
| `--if-present` | `run`: スクリプトがなくてもエラーにしない |
| `--frozen-lockfile`・`--pure-lockfile`・`--no-lockfile` | `yarn`: `yarn.lock` を書き出さない |
| `--prefix <dir>`・`-C <dir>`・`--dir <dir>`・`--cwd <dir>` と `=` の形式 | 作業ディレクトリの代わりに `<dir>` を起点にする |
| `-w <x>`・`--workspace <x>`・`--workspaces`・`-ws`・`--include-workspace-root` | `npm`: [ワークスペースを選ぶ](#ワークスペースを選ぶ) |
| `--filter <x>`・`-F <x>`・`-r`・`--recursive`・`-w`・`--workspace-root`・`--include-workspace-root` | `pnpm`（`bun` は `--filter`・`-F`）: [ワークスペースを選ぶ](#ワークスペースを選ぶ) |
| `-p <spec>`・`--package <spec>` と `=` の形式 | `exec`・`dlx`: インストールするパッケージ（[exec](#execnpxdlx) を参照） |
| `-c <cmd>`・`--call <cmd>` | `npm exec`: パッケージの実行ファイルを `PATH` に入れた状態でシェルコマンドを実行する。`pnpm dlx` の `-c`・`--shell-mode`: パッケージより後ろの引数をシェルコマンドとして実行する |
| `--` | 後ろをすべてそのまま渡す（`run` ならスクリプトへ、`exec` ならコマンドへ） |
| `-v`・`--version` | コマンドがなければ、フロントエンドのバージョンを表示して終了コード 0 |
| `-h`・`--help` | オプションを読む位置にあれば、短い使い方を表示して終了コード 0 |
| そのほかのオプション | `npm`: `--<name>[=<value>]` は設定として保持し、スクリプトに `npm_config_<name>` として渡す（`--no-<name>` は `false`）。`<name>` が npm の設定名でなければ、標準エラーに `npm warn Unknown cli config "--<name>". This will stop working in the next major version of npm.` を出力する（`-s` のときは出力しない）。ほかのフロントエンド: 無視する（`--no-fund`・`--no-audit`・`--save` など） |

そのため、`npm run build --watch` は npm と同じく `--watch` なしでスクリプトを実行します（警告が出て、スクリプトの
環境には `npm_config_watch=true` が入ります）。`npm run build -- --watch` と書いてください。

### プロジェクトのディレクトリ

プロジェクトを対象にするコマンド（`install`・`ci`・`update`・`uninstall`・`run`・`test`・`ls`・`pkg` など）は、
作業ディレクトリ（または `--prefix`）から上にたどり、最初に見つかった `package.json` のあるディレクトリを使います。
見つからなければ、起点のディレクトリをそのまま使います。`init`・`create`・`exec`・`view` は起点のディレクトリを
そのまま使います。

インストールを行うコマンド（`install`・`add`・`ci`・`update`・`uninstall`・`prune` など）は、プロジェクトのディレクトリが
[ワークスペース](#ワークスペース)の 1 つであれば、ワークスペースのルートをインストールします。ただし `add`・`uninstall` が
書き換えるのは、そのワークスペース自身の `package.json` です。

### コマンド

コマンド名はフロントエンドごとに異なります。表にある名前は、プロジェクトに同じ名前のスクリプトがあってもそのコマンドを
実行します（`yarn info`・`pnpm show`・`bun build` がスクリプトとして実行されることはありません）。そうしたスクリプトは
`<pm> run <name>` で実行してください。

| コマンド | `npm` | `pnpm` | `yarn` | `bun` | 動作 |
|---|---|---|---|---|---|
| install | `install`・`i`・`in`・`ins`・`inst`・`insta`・`instal`・`isnt`・`isnta`・`isntal`・`isntall`・`add` | `install`・`i` | `install` | `install`・`i` | パッケージの引数があれば [add](#add)。なければプロジェクトをインストールする。`-g` なら[グローバルインストール](#グローバルインストール) |
| add | — | `add` | `add` | `add`・`a` | install と同じ。パッケージがなければ `<pm> add requires at least one package` で失敗する（終了コード 1） |
| ci | `ci`・`clean-install`・`ic`・`install-clean`・`isntall-clean` | `ci` | — | — | `node_modules` を削除してからインストールする。lockfile は必須ではなく、`package.json` との整合性も確認しない |
| update | `update`・`up`・`upgrade`・`udpate` | `update`・`up`・`upgrade` | `upgrade` | `update` | lockfile を無視してインストールする（範囲内の最新バージョン）。パッケージの引数は無視し、すべてを更新する |
| uninstall | `uninstall`・`unlink`・`remove`・`rm`・`r`・`un` | `remove`・`rm`・`uninstall`・`un`・`uni` | `remove` | `remove`・`rm` | 名前を `dependencies`・`devDependencies`・`optionalDependencies`・`peerDependencies` から削除し、`package.json` を書き込んでインストールする。`package.json` がなければ何も出力せずに終了コード 1。`-g` ならグローバルのパッケージから削除する |
| run | `run`・`run-script`・`rum`・`urn` | `run`・`run-script` | `run` | `run` | [スクリプトを実行する](#npm-run)。名前がなければスクリプトの一覧を表示する |
| test・start | `test`・`t`・`tst`・`start`・`stop`・`restart` | `test`・`t`・`tst`・`start`・`restart` | — | — | `run test`・`run start` など。`start` スクリプトがなく、プロジェクトのディレクトリに `server.js` があれば `node server.js` を実行する |
| exec | `exec`・`x` | `dlx` | `dlx` | `x` | [必要ならインストールして、パッケージの実行ファイルを実行する](#execnpxdlx) |
| ローカルの exec | — | `exec` | `exec` | — | インストールせずに、プロジェクトの実行ファイルを `PATH` に入れた状態でコマンドを実行する。プロジェクトかその上位の `node_modules/.bin/<cmd>`、なければ（`pnpm exec`・`yarn exec`）`PATH` 上の任意のプログラム |
| shell | — | — | — | `exec` | `bun exec "<script>"`: 引数全体を 1 つの `/bin/sh -c` スクリプトとして、[スクリプトの環境](#スクリプトの環境)で実行する |
| create | （`init <name>`） | `create` | `create` | `create`・`c` | [`create-*` パッケージを実行する](#create-と-init) |
| init | `init`・`create`・`innit` | `init` | `init` | `init` | 名前付きの `npm init`・`npm create` は `create` と同じ。それ以外は [`package.json` を書き込む](#create-と-init) |
| view | `view`・`info`・`show`・`v` | `view`・`info`・`show`・`v` | `info` | `info` | [レジストリのメタデータを表示する](#view) |
| ls | `ls`・`list`・`la`・`ll` | `list`・`ls`・`la`・`ll` | `list` | — | [直接の依存を一覧表示する](#ls) |
| why | `why`・`explain` | `why` | `why` | `why` | `ls` と同じ出力 |
| reinstall | `prune`・`dedupe`・`ddp`・`rebuild`・`rb` | `prune`・`dedupe`・`rebuild`・`rb` | — | — | 通常のインストールを行う |
| config | `config`・`c`・`get`・`set` | `config`・`c`・`get`・`set` | `config` | — | [`.npmrc` の設定を読み書きする](#config)。`get`・`set` は `config get`・`config set` と同じ |
| pkg | `pkg` | `pkg` | — | — | [`package.json` の項目を読み書きする](#pkg) |
| cache | `cache` | — | `cache` | — | `cache clean`・`clear`・`verify`・`rm`: tarball のキャッシュを削除して `Cache cleaned` を表示する。ほかのサブコマンドは何もしない（終了コード 0） |
| prefix | `prefix` | `prefix` | — | — | プロジェクトのディレクトリを表示する。`-g` なら `/usr/local` |
| root | `root` | `root` | — | — | `<プロジェクト>/node_modules` を表示する。`-g` なら、グローバルのパッケージがある `/usr/local/lib/node_modules/.ov-global/node_modules` |
| bin | — | `bin` | `bin` | — | `<プロジェクト>/node_modules/.bin` を表示する。`-g` なら `/usr/local/bin` |
| help | `help` | `help` | `help` | `help` | 使い方を表示して終了コード 0 |
| global | — | — | `global` | — | `yarn global add`・`remove` は `add -g`・`remove -g`、`yarn global bin` は `bin -g`、`yarn global list` はグローバルのパッケージを一覧表示する |
| workspace | — | — | `workspace`・`workspaces` | — | [ワークスペースを選ぶ](#ワークスペースを選ぶ) |
| pm | — | — | — | `pm` | `bun pm ls`（`npm ls` と同じ）・`bun pm bin [-g]`・`bun pm cache rm`・`bun pm view` |
| 非対応（終了コード 0） | `audit`・`fund` | `audit` | `audit` | `audit` | 標準エラーに `<pm> <cmd> is not supported in OpenVessel` を出力する |
| 非対応（終了コード 1） | `doctor`・`outdated`・`login`・`publish`・`whoami`・`link`・`pack`・`version` など | `outdated`・`publish`・`link`・`pack`・`patch`・`store`・`deploy` など | `outdated`・`publish`・`link`・`pack`・`version`・`check` など | `test`・`build`・`outdated`・`link`・`publish`・`patch`・`upgrade`・`repl`・`list` | 標準エラーに `<pm> <cmd> is not supported in OpenVessel` を出力する（`bun test`・`bun build` は Bun のテストランナーとバンドラーで、スクリプトではありません） |

コマンドを指定しなかった場合:

- `npm` は使い方（最後の行は `npm@10.9.3`）を表示し、終了コード 1 で終了します。
- `pnpm`・`yarn`・`bun` はプロジェクトをインストールします。

表にないコマンドの場合:

- `npm` は `Unknown command: "<cmd>"` と、`npm help` の実行を促すメッセージを表示し、終了コード 1 で終了します。
- `pnpm`・`yarn`・`bun` は、`package.json` に `<cmd>` という名前のスクリプトがあれば、続く引数を付けてそれを実行します
  （`yarn show`・`bun t` はスクリプトの `show`・`t` を実行します）。`-r` か `--filter` がある場合（`pnpm`・`bun`）は、
  [選んだワークスペース](#ワークスペースを選ぶ)で `<cmd>` をスクリプトとして実行します。
- スクリプトがなければ、`bun` は `<cmd>` が `.js`・`.mjs`・`.cjs`・`.ts`・`.mts`・`.tsx` で終わる場合に
  `node <cmd> <引数>` を実行します。`pnpm` は `pnpm exec` と同じように実行します。`yarn`・`bun` はプロジェクトかその上位の
  `node_modules/.bin/<cmd>` を実行し、それもなければ `error Command "<cmd>" not found.`（`yarn`）か
  `error: Script not found "<cmd>"`（`bun`）で失敗します（終了コード 1）。
- `bun run <file>` は `<file>` という名前のスクリプトを探します。ファイルを実行するのは `bun <file>` だけです。

### add

`install <pkg…>`・`add <pkg…>` は `package.json` を更新してから、プロジェクト全体をインストールします。`package.json` が
なければ、`name`（ディレクトリ名）と `version` `1.0.0` を持つものを作成します。

各引数は `name` か `name@spec` です（スコープ付きの名前なら `@scope/name@spec`）。保存される内容は次のとおりです。

| 引数 | 保存される範囲 |
|---|---|
| `name` | `^<latest>`（dist-tag `latest` のバージョン） |
| `name@<range>`（完全なバージョン以外の、有効な semver の範囲） | 指定した範囲のまま |
| `name@<version>`（完全なバージョン） | `^<version>` |
| `name@<dist-tag>`（`latest`・`next` など） | `^<タグが指すバージョン>` |
| `name@file:…`・`link:…`・`workspace:…`・`http(s)://…`・`git…`・`github:…`・`npm:…` | 指定したまま。レジストリには問い合わせない |
| 上記のいずれかに `-E` を付けた場合 | 解決したバージョンそのもの（レジストリの指定のみ） |

- `-D` がなければ `dependencies` に、`-D` があれば `devDependencies` に保存し、もう一方からは削除します。保存後、その
  項目を名前順にソートします。
- 公開済みのどのバージョンにも一致しない範囲は、`npm error code ETARGET`・`npm error notarget No matching version found for <引数>.`
  で失敗します（終了コード 1）。レジストリのエラーでは `npm error code <code>` とメッセージを表示します（終了コード 1）。
- 名前のない引数（`user/repo`・`./dir`・URL だけのもの）は名前としてレジストリで検索され、失敗します。`name@<spec>` の形で
  書くか、`package.json` に直接書いてください。
- `--save-optional`・`--save-peer` などのフラグは無視され、`dependencies` に保存されます。

### グローバルインストール

`npm install -g <pkg…>`（`add -g` や、ほかのフロントエンドでも同様）は次のように動作します。

1. `/usr/local/lib/node_modules/.ov-global` をプロジェクトとして使います。存在しなければ、
   `{ "name": "global", "private": true }` の `package.json` で作成します。
2. そこに [add](#add) と同じ方法でパッケージを追加します。スクリプトは常に実行しません。
3. `/usr/local/lib/node_modules/.ov-global/node_modules/.bin` のすべてのエントリを、絶対パスのシンボリックリンクとして
   `/usr/local/bin` に作成します。同じ名前のリンクがあれば置き換えます。`/usr/local/bin` は既定の `PATH` に含まれています。

`npm root -g` は、パッケージが置かれている `/usr/local/lib/node_modules/.ov-global/node_modules` を表示します。
`uninstall -g <pkg…>`（`remove -g`・`yarn global remove`）は `.ov-global` プロジェクトからパッケージを削除し、
`/usr/local/bin` のリンクのうち、そのプロジェクト内を指していてパッケージがなくなったものを削除します。`ls -g` は
グローバルのパッケージを一覧表示します。

### npm run

プロジェクトのディレクトリで `run <name> [引数…]` を実行すると、次のように動作します。

1. `package.json` がない: `npm error code ENOENT`・`npm error Could not read package.json in <dir>`、終了コード 254。
2. 名前がない: `Scripts available in <name> via \`npm run-script\`:` と、各スクリプトとそのコマンドを表示して終了コード 0。
3. `<name>` というスクリプトがない: `npm error Missing script: "<name>"` とヒントを表示し、終了コード 1（どのフロントエンドでも同じ）。
4. それ以外の場合は、`pre<name>`・`<name>`・`post<name>` のうち定義されているものを順に実行します。引数は `<name>` にだけ
   渡します。渡すのは、`npm` では名前より後ろのオプション以外の引数と `--` より後ろのすべて、`pnpm`・`yarn`・`bun` では
   名前より後ろのすべてです（[オプション](#オプション)）。名前の直後の `--` は、`yarn`・`bun` では取り除き（`yarn` は
   スクリプトには `--` が不要だと警告します）、`pnpm` ではそのまま渡します。0 以外で終了したスクリプトがあるとそこで
   止め、その終了コードを返します。`npm` で `-s` がない場合は、失敗時に次の内容も表示します。

```text
npm error Lifecycle script `build` failed with error:
npm error code 3
npm error path /home/user/app
npm error command failed
npm error command sh -c exit 3
```

各スクリプトは、プロジェクトのディレクトリを作業ディレクトリとし、[スクリプトの環境](#スクリプトの環境)で
`/bin/sh -c '<スクリプト> <引数>'` として実行します。引数はスクリプトの文字列の末尾に連結します。英数字と
`_ . / : = @ % + -` 以外の文字を含む引数は、シングルクォートで囲みます。`-s` がなければ、各スクリプトの前に標準出力へ
バナーを出力します。`npm`・`pnpm`・`bun` のバナーは空行、`> <name>@<version> <event>`、`> <コマンド>`、空行の 4 行で、
`yarn` のバナーは `$ <コマンド>` です。

`pre`・`post` のスクリプトは常に実行します。`--ignore-scripts` は `run` には影響しません。

### ワークスペースを選ぶ

スクリプト・`exec`・`add`・`uninstall` は、プロジェクトの代わりに、ワークスペースのルート（プロジェクトのディレクトリから
探します）にある[ワークスペース](#ワークスペース)を対象にできます。

| フロントエンド | 選び方 |
|---|---|
| `npm` | `-w <name>`・`--workspace=<name>`（複数指定可）: その名前のワークスペース、またはそのディレクトリ以下にあるワークスペース。`--workspaces`・`-ws`: すべてのワークスペース。`--include-workspace-root` でルートも加える。どれにも一致しない名前は `npm error No workspaces found:`・`npm error   --workspace=<name>`、終了コード 1 |
| `pnpm` | `--filter <sel>`・`-F <sel>`（複数指定可）: `<sel>` は名前（`*` 可）、`./path` か `{path}`（`*` 可）、除外する場合は `!<sel>`。依存をたどるセレクターの `...` と `^` は取り除く（そのパッケージ自身が選ばれる）。`-r`・`--recursive`: すべてのワークスペース（ルートは `--include-workspace-root` のときだけ）。`-w`・`--workspace-root`: ルート |
| `bun` | `--filter <sel>`・`-F <sel>`。`pnpm` と同じ |
| `yarn` | `yarn workspace <name> <コマンド…>` は、そのワークスペースで起動したものとしてコマンドを実行する（存在しなければ `error Unknown workspace "<name>".`）。`yarn workspaces run <スクリプト…>` はすべてのワークスペースでスクリプトを実行し、最初の失敗で止まる。`yarn workspaces info` は各ワークスペースの `location` と `workspaceDependencies` を JSON で出力する |

- `run` と名前で実行するスクリプトは、選んだプロジェクトで順に実行します。`npm` はすべてで実行し、最後に失敗した終了コードを
  返します（スクリプトのないワークスペースは `Missing script` エラーになります）。`pnpm`・`bun` はスクリプトのない
  プロジェクトをスキップし、どれにもなければ失敗し（` ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "<name>" script`）、
  最初の失敗で止まります。フィルターに一致するものがなければ、`pnpm` は `No projects matched the filters in "<root>"` を
  表示します（終了コード 0）。
- `npm exec -w`・`pnpm exec --filter`・`-r` は、選んだ各プロジェクトのディレクトリでコマンドを実行します。
- `install <pkg…> -w <name>`（`pnpm add --filter`）は、選んだ各ワークスペースの `package.json` にパッケージを追加してから、
  ワークスペースのルートを 1 回インストールします。
- パッケージを指定しない `install`・`ci`・`update` は、常にワークスペースのルート全体をインストールします。

### install のライフサイクル

プロジェクトをインストールするとき（`install`・`add`・`ci`・`update`・`uninstall`・`prune` など）、`--ignore-scripts` が
なければ、プロジェクト自身の `package.json` にある次のスクリプトのうち、定義されているものを実行します。

| 順序 | スクリプト | タイミング |
|---|---|---|
| 1 | `preinstall` | 依存の解決を始める前 |
| 2 | `install` | `node_modules` を書き込んだ後 |
| 3 | `postinstall` | |
| 4 | `preprepare` | |
| 5 | `prepare` | |
| 6 | `postprepare` | |

スクリプトが失敗すると、その終了コードでインストールを中止します。バナーは `-s` でも表示します。要約行は最後の
スクリプトの後に表示します。

次のスクリプトは実行しません。依存パッケージのスクリプト（ネイティブバイナリをビルドまたはダウンロードする
`preinstall`・`install`・`postinstall` を含む）、ワークスペースのパッケージのスクリプト、`exec`・`create`・`install -g` で
インストールしたパッケージのスクリプトです。

### スクリプトの環境

`scriptEnv()` が、呼び出し元の環境に次の変数を加えて作ります。

| 変数 | 値 |
|---|---|
| `PATH` | プロジェクトのディレクトリと、その上位の各ディレクトリ（`/` まで）の `<dir>/node_modules/.bin`、続いて呼び出し元の `PATH`（既定は `/usr/local/bin:/usr/bin:/bin`） |
| `npm_lifecycle_event` | スクリプト名（`build`・`prebuild`・`postinstall` など）。[exec](#execnpxdlx) では `npx` |
| `npm_lifecycle_script` | 実行するコマンドライン（連結した引数を含む） |
| `npm_package_name` | `package.json` の `name`。なければ空 |
| `npm_package_version` | `package.json` の `version`。なければ空 |
| `npm_package_json` | プロジェクトの `package.json` の絶対パス |
| `npm_config_user_agent` | `<pm>/<version> npm/? node/v22.23.4 linux x64 workspaces/false`。`exec` では既存の値を残すので、`pnpm` のスクリプト内で `npx` が起動した実行ファイルにも `pnpm` と見えます（`only-allow` などのツールはこれを前提にしています） |
| `npm_execpath` | `/usr/lib/node_modules/<pm>/bin/<pm>-cli.js` |
| `npm_node_execpath` | `/usr/bin/node` |
| `npm_command` | `test`・`start` のスクリプトではその名前、それ以外は `run-script`（インストール中も同じ） |
| `INIT_CWD` | コマンドを起動したときの作業ディレクトリ |
| `NODE` | `/usr/bin/node` |
| `COLOR` | 標準出力が端末なら `1`、そうでなければ `0` |
| `npm_config_<name>` | `npm` のみ。コマンドラインの `--<name>[=<value>]` ごとに、名前の `-` を `_` に置き換えたもの（`--watch` → `npm_config_watch=true`、`--mode=prod` → `npm_config_mode=prod`） |

これ以外の `npm_package_*`・`npm_config_*` 変数は設定しません。

```sh
$ npm pkg set scripts.where='echo $npm_lifecycle_event in $INIT_CWD'
$ npm run where -s
where in /home/user/app
```

### exec・npx・dlx

`npx <cmd> [引数…]`・`npm exec <cmd>`・`npm x`・`pnpm dlx`・`yarn dlx`・`pnpx`・`bunx`・`bun x` は次のように動作します。

1. コマンドがない: `npm error npx requires a command`、終了コード 1。
2. コマンドにバージョンがなく（`cowsay@1` ではなく `cowsay`）、`--package` も指定されておらず、再インストールが
   強制されない場合:
   - 起点のディレクトリかその上位のどこかに `node_modules/.bin/<cmd>` があれば、それを実行します（呼び出し元の作業
     ディレクトリで、[スクリプトの環境](#スクリプトの環境)を使います）。
   - なければ、`PATH` で見つかったプログラムを直接実行します。ただし `/bin/` にあるものと、名前が `create-` で始まる
     ものは除きます（そのため `npx node -e …` は `/usr/bin/node` を実行し、`/usr/local/bin` にグローバルインストールした
     実行ファイルも使われます）。
3. それ以外の場合は、パッケージを `$HOME/.npm/_npx/<key>` にインストールします。`<key>` はパッケージの指定から、英数字・
   `_`・`@`・`.`・`-` 以外の文字の連続をそれぞれ `_` に置き換え、100 文字で切ったものです。このディレクトリに、
   パッケージを依存に持つ `npx-cache` という名前の `package.json` を作成し（バージョンがなければ `latest`）、スクリプトを
   無視して出力なしでインストールします。キャッシュのディレクトリがすでにあれば（`node_modules/.package-lock.json` が
   存在する）、新しいバージョンを確認せずにそのまま使います。ただし再インストールが強制される場合は除きます。
4. 実行ファイルはパッケージの `bin` から選びます。パッケージ名（スコープを除く）と同じ名前のもの、なければ唯一のもの、
   それもなければ `<スコープを除いた名前>` です。`--package` を指定した場合は `<cmd>` そのものです。ファイルが存在
   しなければ `npm error could not determine executable to run for <cmd>`、終了コード 1。
5. 呼び出し元の作業ディレクトリで、スクリプトの環境（`npm_lifecycle_event=npx`）に、キャッシュの `node_modules/.bin` を
   `PATH` の先頭に加えた状態で実行します。

`npx`・`npm exec`・`npm x`・`bunx`・`bun x` は再インストールを強制しません。`pnpm dlx`・`yarn dlx`・`pnpx`・`create`・
`init <name>` は再インストールを強制します。

端末での確認プロンプトはありません。`npm exec`・`npx` がキャッシュにないパッケージをインストールするときは、そのまま
インストールを進め、標準エラーに `npm warn exec The following package was not found and will be installed: <name>@<version>` を
出力します（npm が確認できない状況での動作と同じです）。`-y`・`--yes`（または `-s`）を指定すると警告なしでインストールし、
`--no` を指定すると `npm error npx canceled due to missing packages and no YES option: ["<spec>"]` で拒否します（終了コード 1）。

`--package <spec>`・`-p <spec>`・`--package=<spec>`（複数指定可）は `<spec>` をインストールし、続くコマンドをその中から
実行します。`npx -p typescript tsc --version`・`npm exec -p <spec> -- <cmd> [引数]` のように使います。`-c <cmd>`・
`--call <cmd>` を指定すると、`npm exec` はパッケージの実行ファイルを `PATH` に入れた状態で `<cmd>` を `/bin/sh -c` で
実行します（`npx -p cowsay -c 'cowsay hi'`）。

### create と init

`npm create <x> [引数]`・`npm init <x> [引数]`（と `pnpm`・`yarn`・`bun create`）は、スターターパッケージを、再インストールを
強制した `exec` で実行します。

| 引数 | 実行するパッケージ |
|---|---|
| `vite` | `create-vite` |
| `vite@5` | `create-vite@5` |
| `@scope` | `@scope/create` |
| `@scope/app` | `@scope/create-app`（スコープ付きの名前の後ろのバージョンは取り除く） |

名前を指定しない `npm init`（または最初の引数が `-` で始まる場合）は、確認なしで `package.json` を書き込みます。

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

`Wrote to <path>:` と JSON を表示します。`package.json` がすでにあれば `package.json already exists in <dir>` を表示して
何も変更しません。`-y` を指定した場合は上書きします。

### view

`npm view <name>[@<spec>] [項目…]` は、パッケージのレジストリのフルドキュメント（`description`・`license`・`maintainers`・
`time` などを含むもの。インストーラーが使うのは省略版）を取得します。名前がないか `.` の場合は、プロジェクト自身の
パッケージを表示します。表示するバージョンは、dist-tag が指すバージョン（指定がなければ `latest`）か、範囲に一致する
すべてのバージョンです。

- 項目を指定した場合は、そのバージョンの manifest にドキュメントのトップレベル（`versions`・`dist-tags`・`time`・
  `maintainers` など）をマージしたものから、ドット区切りのパス（`dist.tarball`・`dependencies.react`）で値を取り出します。
  1 つのバージョンの 1 つの項目が文字列であればそのまま表示し、それ以外は `util.inspect` と同じ形式（`'1.2.0'`・
  `[ 'a', 'b' ]`）で表示します。項目が複数あれば `<項目> = <値>` の形式で、バージョンが複数あれば各行の先頭に
  `<name>@<version> ` を付けます。存在しない項目は何も表示しません。
- 項目を指定しない場合は、npm と同じ要約を表示します。`<name>@<version> | <license> | deps: <n> | versions: <n>`、説明、
  ホームページ、キーワード、bin、`dist`（tarball・shasum・integrity・展開後のサイズ）、依存、メンテナー、dist-tags、公開日です。
- `--json` を指定すると、データ（または項目）を JSON で出力します。複数のバージョンが一致した場合は配列になります。
- 一致するバージョンがない: `npm error code E404`・`npm error 404 No match found for version <spec>`、終了コード 1。
  レジストリのエラーでは `npm error code <code>` とメッセージを表示し、終了コード 1。

### ls

`npm ls` は `<name>@<version> <dir>` を表示し、続けて直接の依存（`dependencies`・`devDependencies`・
`optionalDependencies` をまとめてソートしたもの）を 1 行ずつ、`node_modules/.package-lock.json` に記録された
バージョンか `UNMET DEPENDENCY` とともに表示します。ツリー表示、`--depth`、`--all` はありません。`ls -g` はグローバルの
パッケージを一覧表示します。

```text
app@1.0.0 /home/user/app
├── astro@5.14.1
└── is-odd@3.0.1
```

### config

| サブコマンド | 動作 |
|---|---|
| `config get [key]` | [`.npmrc` と環境変数](#レジストリと-npmrc)から決まる実際の値を表示する。既定値は `registry` → `https://registry.npmjs.org/`、`prefix` → `/usr/local`、それ以外は `undefined`。キーを省略すると `registry` |
| `config set <key>=<value>`・`config set <key> <value>` | `$HOME/.npmrc` に書き込む。`<key>=` で始まる行があれば置き換える |
| `config list`・`config ls` | 有効なすべての設定を `key = "value"` の形式で表示する |
| それ以外 | 何もしない（終了コード 0） |

### pkg

| サブコマンド | 動作 |
|---|---|
| `pkg get` | `package.json` 全体を JSON で表示する |
| `pkg get <path>` | ドット区切りのパスの値を JSON で表示する（`"q"`・`{…}`）。存在しなければ `undefined` |
| `pkg set <path>=<value>…` | 各パスに文字列の値を設定し（途中のオブジェクトは作成する）、ファイルを書き込む |
| それ以外 | 終了コード 1 |

## install

`src/kernel/npm/install.ts` の `Installer.run()` が、次の順に処理します。

1. `package.json` を読み込む（なければ `npm error code ENOENT`・`npm error Could not read package.json:
   <dir>/package.json`、終了コード 254）。
2. lockfile のヒントを読み込み（`update` では読まない）、`preinstall` を実行する。
3. overrides とワークスペースを収集する。
4. 幅優先で依存ツリーを解決する。
5. 新しいパッケージと変更のあったパッケージをすべてダウンロードし、検証して展開する（同時に 16 リクエストまで）。
6. 実行ファイルのリンクを作成し、`node_modules/.package-lock.json` を書き込む。
7. 残りのライフサイクルスクリプトを実行し、要約を表示する。

### 依存の種類

| 種類 | インストール対象 |
|---|---|
| `dependencies` | すべてのパッケージ |
| `optionalDependencies` | すべてのパッケージ。`--omit=optional` ならインストールしない。解決に失敗してもエラーではなく警告になる |
| `devDependencies` | プロジェクトとそのワークスペースのみ。`--omit=dev` ならインストールしない |
| `peerDependencies` | すべての依存パッケージ（プロジェクト自身は除く）。`peerDependenciesMeta` で optional とされた peer は除く。`--legacy-peer-deps`・`--force`、または `.npmrc` の `legacy-peer-deps=true` があればインストールしない |
| `bundleDependencies` | 特別な扱いはしない（tarball に含まれているものを展開する） |

`NODE_ENV=production` で、`--omit=dev`・`--include=dev`・`--production` のいずれも指定されていない場合、npm と同じく
プロジェクトの `devDependencies` はインストールしません。`engines` と `libc` はチェックしません。

次の名前のパッケージは、どこに記載されていてもインストールしません: `fsevents`・`bufferutil`・`utf-8-validate`・
`cpu-features`・`ssh2`。

### 指定の書き方

| `package.json` での指定 | 解決方法 |
|---|---|
| semver の範囲、完全なバージョン、`*`、`""` | レジストリ。[バージョンの選び方](#バージョンの選び方)を参照 |
| dist-tag（`latest`・`next`・`beta`） | レジストリ。タグが指すバージョン |
| `npm:<name>@<range>`・`npm:<name>` | レジストリのパッケージ `<name>` を、別名でインストールする |
| `workspace:<range>` | その名前のワークスペースがあればそれ。なければ接頭辞を除いてレジストリから（`*`・`^`・`~` は任意のバージョン） |
| `catalog:`・`catalog:<name>` | レジストリの任意のバージョン（`*`）。カタログは読まない |
| `file:<path>`・`link:<path>` | `<path>` へのシンボリックリンク。パスはプロジェクトのディレクトリを基準に解決する。リンク先の依存もインストールする |
| `user/repo`・`user/repo#ref`・`github:user/repo`・`git+https://github.com/…`・`git+ssh://git@github.com…`・`https://github.com/…`・`git://github.com/…` | tarball `https://codeload.github.com/<user>/<repo>/tar.gz/<ref>`（既定は `HEAD`。ref の `semver:` 接頭辞は取り除くだけで、範囲としては解決しない） |
| `http://…`・`https://…` | その URL の tarball |

GitHub 以外の git ホストには対応していません（指定が dist-tag として扱われ、`ETARGET` で失敗します）。GitHub と URL の
tarball には、検証に使う integrity がありません。

### バージョンの選び方

レジストリの指定では、次の順にバージョンを選びます（`pickVersion()`）。

1. 有効な範囲でない場合: その名前の dist-tag が存在するバージョンを指していればそのバージョン。なければ該当なし。
2. lockfile のヒントに、このパッケージの存在するバージョンで範囲を満たすもの（プレリリースも可）があれば、その中で
   最も新しいもの。
3. dist-tag `latest` が範囲を満たせば、そのバージョン。
4. 範囲を満たす最も新しいバージョン。なければ、プレリリースも含めて同じように選ぶ。

一致するバージョンがない場合: `npm error code ETARGET`・`npm error No matching version found for <name>@<range>.`、
終了コード 1（optional の依存なら警告）。この後、ネイティブパッケージのルールによってバージョンや中身が変わることが
あります（[ネイティブモジュール](native-modules.ja.md)）。

### 配置

ツリーは npm の巻き上げ方式と同じように構築します（`choosePlacement()`・`findVisible()`）。

- 依存はまず、依存元から見える同じ名前のパッケージを探します。依存元自身の `node_modules`、続いてプロジェクトのルートまでの
  外側の各 `node_modules` を探します（ワークスペースはルートにあるものとして扱います）。見つかったパッケージが指定を満たし、
  peer の組み合わせも互換であれば、それを再利用します。ワークスペースは常に再利用します。
- peer 依存では、依存元の親の階層から探し始めるので、peer は依存元の兄弟と共有されます。見えている peer が範囲を満たさない
  場合もそれを使い、`npm warn ERESOLVE <pkg>@<version> wants peer <peer>@"<range>", found <version>` という警告を出します。
- 新しいパッケージはできるだけ上の階層に配置します。その階層に同じ名前のパッケージがなく、そこに置いても別のバージョンに
  解決済みの依存を隠さず、必要な peer が互換のインスタンス（依存元が使うのと同じインスタンス）に解決される限り、1 段ずつ
  上に移動します。
- ネイティブパッケージのルールで固定されたパッケージは、依存元の `node_modules` に置いたままにします。
- パッケージの `dev`・`optional` フラグは、dev でも optional でもない経路が 1 つでも届けばクリアされます。

### プラットフォームでの絞り込み

解決の後、`os` または `cpu` で OpenVessel が除外されているパッケージはスキップします。OpenVessel は `os: linux`、
`cpu: wasm32` として扱います。`!` による否定にも対応し、空のリストはすべてを受け入れます。optional でない依存を
スキップするときは `npm warn EBADPLATFORM skipping <name>@<version> (needs <os> / <cpu>)` を出力します。この仕組みにより、
プラットフォームごとのネイティブパッケージ（`cpu: ["x64"]`）は除外され、`wasm32` のパッケージはインストールされます。

解決中に出力されるほかの警告は、`npm warn deprecated <name>@<version>: <message>` と
`npm warn optional skipping <name>@<spec>: <message>` です。同じ警告は 1 回だけ出力します。

### overrides と resolutions

プロジェクトの `package.json` にある `overrides`（npm）・`resolutions`（Yarn）・`pnpm.overrides` を読み込みます。

- 値が文字列のものだけを使います。入れ子のオブジェクト（npm の親ごとの overrides）は無視します。
- 先頭の `**/` を取り除き、キーに付いたバージョン指定（`foo@1`・`@scope/foo@1`）も取り除くので、override はすべての
  バージョンに適用されます。
- それでも `/` を含み、スコープ付きの名前でもないキー（`a/b`、Yarn のパスのパターン）は無視します。
- 値が `$name` の場合は、プロジェクト自身の `dependencies`・`devDependencies` にある `name` の指定を使います。なければ `*` です。
- override は、その名前への依存すべて（直接の依存を含む）の指定を置き換えます。

```json
{
  "dependencies": { "is-odd": "3.0.1" },
  "overrides": { "is-number": "6.0.0" }
}
```

### ワークスペース

ワークスペースのディレクトリは、`package.json` の `workspaces`（配列か `{ "packages": [...] }`）と、
`pnpm-workspace.yaml` の `packages:` のリスト（ブロック形式でもインライン形式でもよい。このファイルのほかのキーは
読まない）から取得し、両方を合わせて使います。

- パターンの各セグメントには、名前そのもの、`*` か `**`（`node_modules` とドットで始まるディレクトリを除く任意の
  ディレクトリ。1 階層のみ）、または `*` ワイルドカードを含む名前を使えます。`!` で始まるパターンはスキップします
  （除外の意味にはなりません）。
- `name` を持つ `package.json` があるディレクトリをワークスペースとして扱います。プロジェクトのルート自体はワークスペースに
  なりません。
- 各ワークスペースは、そのディレクトリへの相対シンボリックリンクとして `node_modules/<name>` に配置し、その
  `dependencies`・`optionalDependencies`・`devDependencies` をルートのツリーにインストールします。
- ワークスペースの名前への依存は、範囲に関係なくそのワークスペースに解決します。
- ワークスペースの `bin` は、ルートの `node_modules/.bin` にリンクします。
- 選んだワークスペースでコマンドを実行できます。[ワークスペースを選ぶ](#ワークスペースを選ぶ)を参照してください。

### node_modules の書き込み

- 前回のインストール（`node_modules/.package-lock.json`）にあり、今回のツリーにはないパッケージは削除します。
- 前回の記録とバージョン・取得元・種類（リンクかどうか）が同じで、`package.json` がまだそのバージョンで、ディレクトリ
  （リンクとワークスペースの場合はシンボリックリンク）のままであれば、そのパッケージには手を付けません。要約が
  `up to date` であれば、何も変更されていません。
- それ以外の場合は、ディレクトリを空にし（入れ子の `node_modules` は残します）、tarball を展開します。パスの最初の要素は
  取り除き、`..` を含むエントリはスキップし、ディレクトリ・通常のファイル・シンボリックリンクを作成し、ハードリンクと
  そのほかの種類のエントリはスキップします。実行ビットが 1 つでも立っているファイルは `0755`、それ以外は `0644` です。
- パッケージを別の名前でインストールする場合（`npm:` の別名、WebAssembly 版への置き換え、互換パッケージ）は、
  `package.json` をインストールした `name` と `version` に書き換え、`_openvesselSource: "<元のパッケージ>@<version>"` という
  項目を追加します。この `version` は実際に展開したバージョンです。
- `file:`・`link:` の依存とワークスペースは、相対シンボリックリンクです。

### コマンドのリンク

ツリー内の各 `node_modules` ディレクトリについて、その直下にあるパッケージの `bin` を、そのディレクトリの `.bin`
（`node_modules/.bin`、入れ子のパッケージなら `.../node_modules/x/node_modules/.bin`）にリンクします。

- 文字列の `bin` は、パッケージ名（スコープを除く）でリンクします。`bin` がなければ `directories.bin` を使います（その
  ディレクトリ内のすべてのファイル）。
- レジストリの manifest を優先し、次に展開した `package.json` を使います。
- `/` か `..` を含む名前はスキップします。リンクは相対パスで、リンク先には実行権限を付けます。
- 名前が衝突した場合は、そのディレクトリの直接の依存が、巻き上げられた間接の依存より優先されます。

### 隠し lockfile

`node_modules/.package-lock.json` に、インストールしたツリーを記録します。

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

各エントリは `version`・`resolved`（tarball の URL、またはプロジェクトからの相対パスで表したリンク先）・`integrity` を持ち、
`dev`・`optional`・`link` は true のときだけ持ちます。ワークスペースは npm の lockfile と同じく 2 つのエントリになります。
`link: true` で `resolved` がそのディレクトリである `node_modules/<name>` と、`name` と `version` を持つ `<ディレクトリ>` です。
このファイルは、「up to date」の判定、不要なパッケージの削除、`npm ls`、`exec` のキャッシュディレクトリの判別に使います。
バージョンのヒントとしては読みません。

### 進捗表示と要約

標準エラーが端末で `-s` がない場合は、進捗の行をその場で書き換えて表示します（`\r\x1b[K`）。依存 50 件ごとの
`resolving… <n> packages`、`fetching <n> packages…`、パッケージ 25 件ごとの `extracting… <done>/<total>` です。
この行は警告の前と最後に消去します。

要約は標準出力に出力します（`-s` のときは出力しません）。`<time>` は 1 秒未満なら `<n>ms`、それ以上なら `<n.n>s` です。

- `npm`・`bun`: 空行に続いて `added <n> package(s)[, and audited <total+1> packages] in <time>`。何も追加しなかった場合は
  `up to date in <time>`。`audited` の部分は、すでに配置済みのパッケージがあるときに表示されます。
- `pnpm`: `Packages: +<n>` と `Done in <time>`。
- `yarn`: `yarn.lock` を書き込んだ（内容が変わった）場合は `success Saved lockfile.`、何も変わらなかった場合は
  `success Already up-to-date.`、続いて `Done in <time>.`。

## lockfile

`src/kernel/npm/lockfile.ts` の `readLockHints()` は、プロジェクトのディレクトリで次のファイルをこの順に探し、最初に
見つかって解析できたもの（バージョンが 1 つも得られなくても）を使います。

| ファイル | 読み取る内容 |
|---|---|
| `package-lock.json` | v2・v3: `packages` のエントリのうち、ルートと `link` のエントリを除くすべて。名前はエントリの `name`、なければ最後の `node_modules/` より後ろのパス。v1: 入れ子の `dependencies` ツリー（`npm:` の別名のバージョンはバージョン部分だけにする） |
| `npm-shrinkwrap.json` | `package-lock.json` と同じ |
| `pnpm-lock.yaml` | `packages:` と `snapshots:` セクションのキー。`name@version`（v6〜v9）と `/name/version`（v5）。クォートの有無は問わず、peer のサフィックスは無視する |
| `yarn.lock` | Yarn v1: 各エントリの名前（`alias@npm:real@range` の別名は `real` として扱う）と `version "x"`。Yarn Berry（`__metadata:` を含むファイル）: 各エントリの `resolution: "<name>@npm:<version>"`。ワークスペースや patch など npm 以外の resolution はスキップする。Berry の `checksum` は Yarn 独自の zip アーカイブのハッシュなので使わない |
| `bun.lock` | ファイル内のすべての `"name@x.y.z"` の文字列 |

`bun.lockb`（バイナリ形式）は読みません。

読み取った結果は、パッケージ名ごとのバージョンの集合にすぎません。これは [バージョンの選び方](#バージョンの選び方)の
2 番目の手順で使われ、範囲を満たすロック済みのバージョンのうち最も新しいものが選ばれます。lockfile のツリー構造・
`resolved` の URL・`integrity` の値は使わず、`package.json` と食い違っていてもエラーにはしません。`update` は lockfile を
無視します。

### yarn.lock

インストールの後、`yarn` は `yarn.lock` を Yarn v1 形式で書き出します（`Installer.yarnLockfile()`）。`--frozen-lockfile`・
`--pure-lockfile`・`--no-lockfile` のいずれかがあれば書き出しません。ファイルは内容が変わったときだけ書き直します。ほかの
フロントエンドは lockfile を書き出しません。

```text
# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


is-number@^6.0.0:
  version "6.0.0"
  resolved "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
  integrity sha512-…
```

- インストールしたパッケージごとに 1 エントリで、キーはそのパッケージに解決したすべての `name@spec`（依存元が書いたままの
  指定で、override 適用前のもの）をソートしたものです。
- `resolved` は tarball の URL に `#<shasum>` を付けたものです。`dependencies`・`optionalDependencies` はレジストリの
  manifest の内容なので、WebAssembly 版や互換パッケージに置き換えたパッケージも、レジストリのパッケージとして記録されます。
- ワークスペース、`file:`・`link:` の依存、peer の依存関係にはエントリを作りません。

## レジストリと .npmrc

### 設定

`readNpmrc()` は次の順に設定を読み込んでマージします。後のものが優先されます。

1. `$HOME/.npmrc`（`HOME` の既定値は `/home/user`）
2. `/` からプロジェクトのディレクトリまでの各ディレクトリにある `.npmrc`
3. 環境変数 `npm_config_<key>`（大文字・小文字は問いません。キーは小文字にし、`_` を `-` に置き換えます）

各行は `key = value` の形式で、`#` か `;` で始まる行はコメントです。値の前後の引用符は取り除き、`${VAR}` は環境変数の
値に置き換えます（未設定なら空）。

効果のあるキー:

- `registry`: スコープのないパッケージのレジストリの URL（既定値は `https://registry.npmjs.org/`。末尾に `/` を補います）。
- `@scope:registry`: `@scope/*` のパッケージのレジストリの URL。
- `legacy-peer-deps`: `true` なら `--legacy-peer-deps` と同じ。

ほかのキーは `npm config get`・`list` で参照できるだけです。認証の設定（`_authToken`・`_auth`・`//host/:…`）は送信せず、
リクエストには認証情報を付けません。

### リクエスト

レジストリと tarball へのリクエストは、すべてカーネルからランタイムの Service Worker の `/__ov/net` エンドポイントに
送られます。Service Worker はカーネルのネットワークポリシーに問い合わせたうえで、ブラウザの `fetch` でリクエストを
実行します（Cookie なし、CORS モード）。許可リクエストに表示される呼び出し元は `npm` です。ネットワークポリシーの
プリセット `npm` は `registry.npmjs.org`・`registry.npmjs.com`・`registry.yarnpkg.com`・`registry.npmmirror.com` を
許可します。GitHub の依存には、プリセット `github` か `codeload.github.com` を許可するルールが必要です
（[ネットワークポリシー](network-policy.ja.md)）。接続先は CORS ヘッダーを返す必要があります。

- パッケージのメタデータ: `GET <registry><name>`。スコープ付きの名前の `/` は `%2f` にエンコードし、ヘッダーは
  `accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*`（省略版のメタデータ）です。
- tarball: `dist.tarball` の URL への `GET`。gzip はマジックバイトで判別し、`DecompressionStream` で展開します。
- 互換パッケージの tarball: `<ランタイムのベース>/compat/` から直接取得します。ネットワークポリシーの確認は経由しません
  （[ネイティブモジュール](native-modules.ja.md)）。

上限と再試行:

- メタデータと tarball のリクエストは、合わせて同時に 16 件までです（1 つの `Registry` オブジェクトで共有）。
- 各リクエストは最大 3 回試行し、試行の間に 300 ms × 試行回数（メタデータ）または 400 ms × 試行回数（tarball）待ちます。
  `E404` と `EACCES` は再試行しません。
- 解決中は、列挙された各依存のメタデータを先行して取得します。

| 失敗 | `code` | メッセージ |
|---|---|---|
| 404 | `E404` | `404 Not Found - GET <url> - '<name>' is not in this registry.`（メタデータ）または `404 Not Found - GET <url>` |
| その他の HTTP ステータス | `E<status>` | `<status> <statusText> - GET <url>` |
| ネットワークポリシーによる拒否 | `EACCES` | 外部通信のプロキシのメッセージ、続いて `npm error network access was denied by the OpenVessel network policy` |
| ネットワークの障害、CORS | `ECONNREFUSED` | 外部通信のプロキシのメッセージ |
| integrity の不一致 | `EINTEGRITY` | `integrity checksum failed for <url>` |

インストールに失敗すると、（どのフロントエンドでも）`npm error code <code>` と `npm error <message>` を表示し、終了コード 1 で
終了します。

### キャッシュ

- メタデータは、レジストリの設定ごとに、カーネルが動いている間メモリにキャッシュします。同じパッケージに対する 2 回目の
  `install` や `view` は、ページを再読み込みするかレジストリの設定が変わるまで、レジストリに再度問い合わせません。失敗した
  リクエストはキャッシュしません。
- tarball は、ランタイムのオリジンの Cache Storage にあるキャッシュ `openvessel-npm-v1` に、URL をキーとして保存します。
  このキャッシュは再読み込みしても残ります。キャッシュした tarball は読み出すたびに integrity を検証し、一致しなければ
  削除して再ダウンロードします。`npm cache clean` はキャッシュ全体を削除します。

### integrity

`verify()` は tarball を `dist.integrity`（Subresource Integrity。`sha512`・`sha384`・`sha256`・`sha1` のいずれでもよく、
空白区切りで複数指定可。1 つのハッシュが一致すれば十分）と照合します。integrity の文字列があっても対応するハッシュが
含まれていなければ、検証は失敗します。`integrity` がなければ、16 進数の `dist.shasum`（SHA-1）を照合します。どちらも
ない場合（GitHub と URL の tarball）は検証しません。

## 終了コード

| コード | 条件 |
|---|---|
| 0 | 成功。`-v`・`-h`・`help`。`audit`・`fund`。何もしない `config`・`cache` のサブコマンド |
| 1 | 解決・レジストリ・ネットワーク・integrity のエラー。スクリプトがない。不明なコマンド。コマンドなしの `npm`。パッケージなしの `add`。`doctor`・`outdated`・`login`・`publish`・`whoami`。コマンドまたは実行ファイルが見つからない `exec` |
| 254 | `install`・`run` で `package.json` がない |
| その他 | 失敗したライフサイクルスクリプトや `run` のスクリプト、または `exec` で起動したプログラムの終了コード |

## semver

`src/kernel/npm/semver.ts` は、`package.json` で使われる node-semver の範囲の構文を実装しています。

| 構文 | 意味 |
|---|---|
| `1.2.3`・`=1.2.3`・`v1.2.3` | そのバージョンのみ（先頭の `v`・`=` とビルドメタデータ `+…` は無視） |
| `1`・`1.x`・`1.2`・`1.2.*` | 部分的なバージョンを範囲として扱う（`>=1.0.0 <2.0.0-0` など） |
| `*`・`x`・`X`・`""` | 任意のバージョン（`latest` などの dist-tag は範囲ではない） |
| `^1.2.3`・`^0.2.3`・`^0.0.3`・`^1.x` | キャレット。次のメジャーバージョンまで。`0.x` では次のマイナーまたはパッチまで |
| `~1.2.3`・`~1.2`・`~1`・`~>1.2` | チルダ。次のマイナーバージョンまで（`~1` は次のメジャーまで） |
| 完全または部分的なバージョンに付けた `>`・`>=`・`<`・`<=` | 比較演算子（`>1.2` → `>=1.3.0`、`<=1.2` → `<1.3.0-0`） |
| `1.2.3 - 2.3`・`1 - 2` | ハイフン範囲（部分的な上限は、次のバージョンを含まない） |
| 空白区切りの比較演算子 | AND |
| `\|\|` | OR |

プレリリースの扱いは node-semver と同じです。`1.2.3-beta.1` のようなバージョンは、同じ組の比較演算子のどれかが同じ
`1.2.3` のプレリリースを持つ場合にだけ範囲を満たします（`includePrerelease` を指定した場合を除く）。loose モードや
coerce はありません。解析した範囲はメモリにキャッシュします。エクスポートしている関数: `parse`・`valid`・`compare`・
`parseRange`・`validRange`・`satisfies`・`maxSatisfying`・`minVersion`・`rsort`。

## ソースファイル

| ファイル | 内容 |
|---|---|
| `src/kernel/npm/cli.ts` | フロントエンド・フラグ・コマンド・スクリプト・`.npmrc` |
| `src/kernel/npm/install.ts` | 依存の解決・配置・ネイティブパッケージのルール・展開・実行ファイルのリンク・隠し lockfile |
| `src/kernel/npm/lockfile.ts` | lockfile の読み取り |
| `src/kernel/npm/registry.ts` | レジストリと tarball のリクエスト・キャッシュ・integrity |
| `src/kernel/npm/tar.ts` | gzip と tar（ustar・pax・GNU の長い名前） |
| `src/kernel/npm/semver.ts` | semver |
