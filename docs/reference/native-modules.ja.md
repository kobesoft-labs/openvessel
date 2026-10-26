# ネイティブモジュール

[English](native-modules.md)

ブラウザのタブは機械語を読み込めないため、OpenVessel がネイティブアドオン（`.node` ファイル）を実行することはありません。
このページでは、代わりにどう動くかを説明します。扱うのは、`npm install` がネイティブのパッケージを WebAssembly 版に
差し替えるルール、`.node` ファイルを実行しようとしたときのエラー、`node:wasi` の実装、napi-rs の `wasm32-wasi`
版と emnapi の読み込み、OpenVessel が自前でビルドしている互換パッケージです。

## 概要

| 方法 | 場所 | 例 |
|---|---|---|
| パッケージ自身の WebAssembly 版を、ネイティブのパッケージの名前でインストールする | インストーラー（`src/kernel/npm/install.ts`） | `esbuild` → `esbuild-wasm`、`rollup` 4 → `@rollup/wasm-node`、`lightningcss` → `lightningcss-wasm` |
| napi-rs のパッケージの `wasm32-wasi` 版を、それに合う emnapi と一緒にインストールする | インストーラー | `rolldown`・`@node-rs/xxhash` などの napi-rs のパッケージ |
| WebAssembly 版があるリリース系列に上げる | インストーラー | `sharp` < 0.33 → 0.34 |
| OpenVessel がビルドした互換パッケージをインストールする | インストーラー＋`compat/`・`scripts/build-compat.mjs` | Pagefind・`cn-font-split`・`@resvg/resvg-js` |
| WebAssembly を WASI preview1 で実行する | `node:wasi`（`src/node/wasi.ts`） | 上記のうち WASI 向けにビルドされたものすべて |
| 明確なエラーにする | モジュールローダー・`process.dlopen` | それ以外の `.node` ファイル |

パッケージマネージャー側の処理（依存の解決・配置・lockfile）については [パッケージマネージャ](package-managers.ja.md) を参照してください。

## プロセスから見えるもの

| 項目 | 値 | 意味 |
|---|---|---|
| `process.platform`・`process.arch` | `linux`・`x64`（両方のランタイム） | ローダーはこの値でプラットフォームごとのパッケージを選びます。互換パッケージは、ローダーがそれを期待する場合には `linux-x64` の名前で公開しています |
| `process.versions.napi` | `10` | |
| `process.report.getReport().header.glibcVersionRuntime` | `2.36` | `detect-libc` がこの値を読むので、musl ではなく glibc の環境と判定されます |
| `NAPI_RS_FORCE_WASI` | カーネルの既定の環境変数で `true`（`src/kernel/kernel.ts`） | napi-rs が生成するローダーがこの値を読み、ネイティブのバインディングを試さずに `wasm32-wasi` のパッケージを読み込みます。古いローダーは空でない値なら何でも、最近のローダーは `true` か `error` のときだけ WASI を強制します。`true` ならどちらでも有効です |
| インストーラーが使うプラットフォーム | `os: linux`・`cpu: wasm32` | `cpu` が `x64`・`arm64` などのパッケージは、インストール時にスキップします |

## インストール時の決まり

ルールはすべて `src/kernel/npm/install.ts` にあります。どのフロントエンド（`npm`・`pnpm`・`yarn`・`bun`）にも、`npx` にも適用されます。

### 順番

レジストリの依存パッケージについて、`resolve()` は次の順に処理します。

1. 指定からバージョンを選ぶ（lockfile のヒント、`latest`、条件に合う最も高いバージョン）。
2. [系列の引き上げ](#系列の引き上げ): ネイティブ版しかない古い系列を、WebAssembly 版がある系列に上げる。
3. [互換パッケージ](#互換パッケージ): その名前とバージョンに対応する互換パッケージが登録されていれば、それを使って終了する。
4. [WebAssembly 版への置き換え](#webassembly-版への置き換え): 中身を WebAssembly 版のパッケージに差し替える。

パッケージの依存をキューに積む段階で、[napi-rs](#napi-rs-の-wasm32-wasi-版) と [sharp](#sharp) のルールが依存を追加・調整し、
[環境での絞り込み](#環境での絞り込み)が実行できないパッケージを除外します。

### インストールしないもの

`fsevents`・`bufferutil`・`utf-8-validate`・`cpu-features`・`ssh2` は、どこに記載されていてもスキップします（`SKIP`）。
これらを `require()` すると `MODULE_NOT_FOUND` で失敗します。

### WebAssembly 版への置き換え

`SUBSTITUTES`:

| パッケージ | インストールするもの | 条件 |
|---|---|---|
| `esbuild` | `esbuild-wasm` | すべてのバージョン |
| `rollup` | `@rollup/wasm-node` | メジャーバージョン 4 以上 |
| `lightningcss` | `lightningcss-wasm` | すべてのバージョン |
| `sass-embedded` | `sass`（Pure JavaScript の Dart Sass） | すべてのバージョン |

- 置き換え先のバージョンは、同じバージョンがあればそれ、無ければ `~<version>` で最も高いもの、それも無ければ `^<version>` で最も
  高いものです。どれも無いか、メタデータを取得できない場合は、元のパッケージをそのままインストールします。
- パッケージは、要求された名前とバージョンのまま扱います。`node_modules/esbuild` に配置され、その `package.json` には
  `"name": "esbuild"`、解決したバージョン、`"_openvesselSource": "esbuild-wasm@<version>"` が書き込まれます。ここでのバージョンは実際に展開した
  置き換え先のバージョンです（`~`/`^` のフォールバックで別のバージョンを選んだ場合は、解決したバージョンと異なります）。`bin` は置き換え先のもので、置き換え先に無ければ
  元のパッケージのものです。
- 依存の解決には置き換え先の manifest を使うので、ネイティブのパッケージのプラットフォームごとの `optionalDependencies`
  （`@esbuild/linux-x64` など）は要求しません。

### 系列の引き上げ

`UPGRADES`:

| パッケージ | バージョン | 代わりにインストールするもの |
|---|---|---|
| `sharp` | `<0.33.0` | `^0.34.0` で解決されるバージョン |

0.33 より前の sharp は、libvips を `.node` アドオンとして同梱していました。0.33 以降には WebAssembly 版があり、
利用側が使う範囲では API も同じです。`package.json` は変更しません。インストールされるバージョンは指定した範囲と食い違いますが、何も表示しません。

### napi-rs の wasm32-wasi 版

napi-rs のパッケージは、プラットフォームごとのバインディングのパッケージを `optionalDependencies` に列挙しています
（`@scope/pkg-linux-x64-gnu` など）。公開されている場合は、`@napi-rs/wasm-runtime` と emnapi の上で動く WebAssembly 版のバインディング
（`@scope/pkg-wasm32-wasi`、`cpu: ["wasm32"]`）もあります。

`withWasiBinding()`: すべてのパッケージ（プロジェクト自身を含む）の `optionalDependencies` について、`wasm32` を含む名前が
無く、名前が `-(linux|darwin|win32|freebsd|android)-(x64|arm64|arm|ia32)`（後ろに `-gnu`・`-musl`・`-msvc`・`-gnueabihf`・`-eabi`
が付いてもよい）で終わるエントリーがあれば、最初に見つかったそのネイティブのエントリーと同じ指定で `<base>-wasm32-wasi` を追加します。
そのパッケージが存在しない場合は、optional の依存として `npm warn optional skipping …` を表示してスキップします。

`withEmnapi()`: 名前が `-wasm32-wasi` で終わり、`dependencies` に `@emnapi/core` が無いパッケージには、
`@emnapi/core@^1.4.0` と `@emnapi/runtime@^1.4.0` を追加します。emnapi 1.x でビルドしたバインディングは、`@napi-rs/wasm-runtime`
の peer が見つけた emnapi をそのまま使うことが多く、それが別のバインディングの emnapi 2 になる場合があります（emnapi 2 のランタイムには、1.x の
ビルドが import する `napi_set_last_error` がありません）。emnapi 2 向けにビルドしたバインディングは、自分で依存に記載しています。

`pickWasmRuntime()`（1.1.1 から）: `-wasm32-wasi` のパッケージが `@napi-rs/wasm-runtime` に範囲指定で依存し、
`@emnapi/core` を厳密なバージョンで固定している場合、インストーラーはその範囲の中で、`peerDependencies['@emnapi/core']` が固定された
バージョンを受け入れる（プレリリースを含む）最新の `@napi-rs/wasm-runtime` を選びます。その peer を持たないリリースは
受け入れるものとして扱います。条件に合うものが無い場合、バインディングが emnapi を厳密なバージョンで固定していない場合、プロジェクトが `@napi-rs/wasm-runtime` を
overrides している場合は、範囲を通常どおり解決します。選んだバージョンはバインディング自身の `node_modules` にインストールするので、
ほかのパッケージがそれを使うことはありません。たとえば、`@emnapi/core@2.0.0-alpha.5` を固定し、`@napi-rs/wasm-runtime@~1.2.5` に依存するバインディングには
1.2.5 が入ります。1.2.6 の peer は `2.0.0-beta.2` しか受け入れないためです。

`DEP_PINS`: WebAssembly 版の依存を、ビルド時に使ったバージョンに固定し、依存元パッケージの隣にインストールします。

| パッケージ | バージョン | 依存 | 固定するバージョン |
|---|---|---|---|
| `@img/sharp-wasm32` | `<0.34.0` | `@emnapi/runtime` | `1.1.1` |

（これらのビルドの emscripten＋emnapi 1.1 のグルーコードは、`@emnapi/runtime` 1.2 で変更された callback-info のスタックを
使っているためです。）

### sharp

| ルール | 効果 |
|---|---|
| `UPGRADES` | `sharp` `<0.33.0` → `^0.34.0` |
| `withSharpWasm()` | `sharp` `>=0.35.0-0` で、`optionalDependencies` に `@img/sharp-wasm32` が無ければ `@img/sharp-wasm32@<同じバージョン>` を追加する（0.35 は WebAssembly 版を `@img/sharp-webcontainers-wasm32` として公開しているが、linux-x64 では `require('@img/sharp-wasm32')` にフォールバックする） |
| `DEP_PINS` | `@img/sharp-wasm32` `<0.34.0` に `@emnapi/runtime@1.1.1` |
| 環境での絞り込み | ネイティブの `@img/sharp-linux-x64` と `@img/sharp-libvips-*` は `cpu` により除外される |

```js
// ふつうに `npm install sharp` した後で動く
const sharp = require('sharp');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
```

### 環境での絞り込み

解決したパッケージの `os` が `linux` を受け入れない場合、または `cpu` が `wasm32` を受け入れない場合は、そのパッケージをスキップします（`!win32` の
ような否定も解釈し、空のリストはすべてを受け入れます）。optional でない依存の場合は
`npm warn EBADPLATFORM skipping <name>@<version> (needs …)` を表示します。`libc` と `engines` はチェックしません。互換
パッケージは manifest を置き換えるので、`os`/`cpu` は互換パッケージのもの（指定なし）になります。

### 特別に扱う名前

インストーラーが特別に扱うパッケージ名の一覧です。

| 名前 | ルール |
|---|---|
| `fsevents`・`bufferutil`・`utf-8-validate`・`cpu-features`・`ssh2` | インストールしない |
| `esbuild` | `esbuild-wasm` に置き換える |
| `rollup`（4 以上） | `@rollup/wasm-node` に置き換える |
| `lightningcss` | `lightningcss-wasm` に置き換える |
| `sass-embedded` | `sass` に置き換える |
| `sharp` | `<0.33` は引き上げる。`>=0.35` には `@img/sharp-wasm32` を追加する |
| `@img/sharp-wasm32` | `<0.34` には `@emnapi/runtime@1.1.1` |
| `@napi-rs/wasm-runtime` | バインディングの emnapi に合わせてバージョンを選ぶ（`pickWasmRuntime`） |
| `@emnapi/core`・`@emnapi/runtime` | 依存に記載していない `*-wasm32-wasi` パッケージに追加する |
| `*-wasm32-wasi` | emnapi を追加する。napi-rs のプラットフォームごとの optional の依存の隣に追加する |
| `@pagefind/linux-x64`・`cn-font-split`・`@resvg/resvg-js` | 互換パッケージ（`index.json` から） |

## .node ファイルの読み込み

`require()` の解決では、`.js`・`.json` の次に `.node` も試します（両方のランタイム）。そのため、ネイティブのファイルしか
含まないパッケージは、ファイルを見つけたうえで読み込みに失敗します。

| | 移植版ランタイム（`src/nodejs/bindings/process.ts`） | 旧ランタイム（`src/node/module.ts`・`src/node/process.ts`） |
|---|---|---|
| `require('x.node')` | Node 自身のローダーが `process.dlopen` を呼び、`ERR_DLOPEN_FAILED` を投げる | `ERR_DLOPEN_FAILED` を投げる: `Native addons are not supported in OpenVessel (tried to load <file>). Use the WebAssembly build of this package.` |
| `process.dlopen()` | glibc の `dlopen` に似たメッセージ（下記）で `ERR_DLOPEN_FAILED` を投げる | 同じ |
| `import 'x.node'` | `ERR_UNKNOWN_FILE_EXTENSION`（`--experimental-addon-modules` なしの Node 22 と同じ） | 失敗する |

`process.dlopen` のメッセージ（両方のランタイム）:

| ファイル | メッセージ |
|---|---|
| 存在しない | `<file>: cannot open shared object file: No such file or directory` |
| 64 バイト未満 | `<file>: file too short` |
| ELF のマジックナンバーで始まらない | `<file>: invalid ELF header` |
| ELF ファイル | `Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.` |

napi-rs のローダーはこれらのエラーを捕捉して次の候補に進み、最終的に `wasm32-wasi` のパッケージを読み込みます
（[動くときの napi-rs と emnapi](#動くときの-napi-rs-と-emnapi)）。

## node:wasi

カーネルのファイルシステム上で動く WASI preview1 の実装で、`src/node/wasi.ts` にあります。両方のランタイムが同じ import 関数を
使い、それを包む JavaScript の API だけが異なります。

### API

| | 移植版ランタイム | 旧ランタイム |
|---|---|---|
| モジュール | `internalBinding('wasi')`（`src/nodejs/bindings/wasi.ts`）の上で動く、Node 自身の `lib/wasi.js` | `src/node/wasi.ts` の `WASI` クラスをそのまま使う |
| `version` オプション | 必須。`'preview1'` か `'unstable'`。指定なし → `ERR_INVALID_ARG_TYPE`、それ以外の値 → `ERR_INVALID_ARG_VALUE` | 同じ |
| `getImportObject()` | `{ wasi_snapshot_preview1: … }`。`'unstable'` の場合は `{ wasi_unstable: … }` | 同じ |
| オプションの検証（`args`・`env`・`preopens`・`stdin`/`stdout`/`stderr`・`returnOnExit`） | Node のもの | 同じ検証とメッセージを `src/node/wasi.ts` に実装したもの |
| `env` の値が `undefined` のエントリー | 除外する（Node と同じ）。それ以外の値は `KEY=<String(値)>` になる | 同じ |
| `returnOnExit`（既定 `true`） | `start()` が終了コードを返す。`false` の場合は `proc_exit` でプロセスが終了する | 同じ |
| `start(instance)` | `_start` が必要で、`_initialize` があると拒否する（Node のチェック）。2 回目の呼び出しは `ERR_WASI_ALREADY_STARTED` | 同じ |
| `initialize(instance)` | `_start` があると拒否し、`_initialize` があれば呼ぶ | 同じ |
| メモリ | `instance.exports.memory` | 同じ |
| `ExperimentalWarning: WASI is an experimental feature…` | Node と同じく 1 回表示する | 表示しない |

```js
const { WASI } = require('node:wasi');
const fs = require('node:fs');

const wasi = new WASI({
  version: 'preview1',
  args: ['tool', ...process.argv.slice(2)],
  env: process.env,
  preopens: { '/': '/', '.': process.cwd() },
});
const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync('tool.wasm')), wasi.getImportObject());
process.exitCode = wasi.start(instance);
```

### import の関数

preview1 の 46 個の関数をすべて実装しています。ファイルを扱う関数はカーネルのシステムコールを経由するので、`fs` と同じ
メモリ上のファイルシステムを参照します。

| 関数 | 動作 |
|---|---|
| `args_get`・`args_sizes_get`・`environ_get`・`environ_sizes_get` | `args` と `env` から |
| `clock_time_get` | クロック 0（realtime）: `Date.now()` をナノ秒に換算した値（ミリ秒精度）。それ以外のクロック: `performance.timeOrigin + performance.now()` |
| `clock_res_get` | 常に 1000 ns |
| `fd_read`・`fd_write`・`fd_pread`・`fd_pwrite` | カーネルの `read`/`write`。iovec に対して scatter/gather で読み書きする |
| `fd_seek`・`fd_tell` | カーネルの `lseek` |
| `fd_close` | カーネルの fd を閉じる（0〜2 は対象外） |
| `fd_fdstat_get` | ファイルの種類、`APPEND` フラグ、すべての権限 |
| `fd_filestat_get`・`path_filestat_get` | カーネルの `fstat`/`stat`（`path_filestat_get` は `SYMLINK_FOLLOW` のときだけシンボリックリンクをたどる） |
| `fd_filestat_set_size` | カーネルの `ftruncate` |
| `fd_filestat_set_times`・`path_filestat_set_times` | カーネルの `utimes`。`fst_flags` で、どの時刻を変更するかと、現在時刻（`now`）にするかを選ぶ（時刻の指定と `now` を同時に指定すると `EINVAL`）。`path_filestat_set_times` は、`SYMLINK_FOLLOW` が無ければシンボリックリンク自体を変更する |
| `fd_readdir` | 先頭に `.` と `..`。`d_next` と `d_ino` はエントリーのインデックス＋1 |
| `fd_renumber` | エントリーを移動し、移動先は閉じる |
| `fd_prestat_get`・`fd_prestat_dir_name` | preopen したディレクトリ。fd 3 から |
| `path_open` | ディレクトリはディレクトリのハンドルになる。`CREAT`・`DIRECTORY`・`EXCL`・`TRUNC` と fd の `APPEND` フラグは `open` のフラグに対応する。読み書きのアクセスは要求された権限から決める。`SYMLINK_FOLLOW` なしで開いたパスの最後の要素がシンボリックリンクなら `ELOOP` |
| `path_create_directory`・`path_remove_directory`・`path_unlink_file`・`path_rename`・`path_link`・`path_symlink`・`path_readlink` | 対応するカーネルの呼び出し |
| `poll_oneoff` | クロックの購読は、最も短いタイムアウト（相対・絶対のどちらでも）までスレッドをブロックする（`Atomics.wait`）。fd の購読は即座に準備完了として返し、呼び出しをブロックしない |
| `random_get` | `crypto.getRandomValues` を 64 KiB ずつ呼ぶ |
| `proc_exit` | その終了コードで `start()` を終える（`returnOnExit` を参照） |
| `sched_yield`・`fd_advise`・`fd_allocate`・`fd_datasync`・`fd_sync`・`fd_fdstat_set_flags`・`fd_fdstat_set_rights` | 何もせずに成功を返す |
| `proc_raise`・`sock_accept`・`sock_recv`・`sock_send`・`sock_shutdown` | `ENOSYS`（52） |

### ファイルと preopens

- fd 0・1・2 はプロセスの標準入力・標準出力・標準エラー出力です（`stdin`・`stdout`・`stderr` を指定した場合は、そのカーネルの fd）。
- `preopens` の各エントリー `{ ゲストのパス: ホストのパス }` は、fd 3 から順にディレクトリの fd になります。ホストのパスは
  プロセスのカレントディレクトリを基準に解決します。
- パスの引数は、基準となるディレクトリの fd の下で、要素を 1 つずつたどって検索します（`src/node/wasi-path.ts`）。
  uvwasi がモジュールを preopens の中に閉じ込めるのと同じ方法です。すべての `path_*` の呼び出しがこの方法で検索します
  （`path_open`・`path_filestat_get`・`path_filestat_set_times`・`path_create_directory`・`path_remove_directory`・
  `path_unlink_file`・`path_rename`・`path_link`・`path_symlink` の新しいパス・`path_readlink`）。
  - 絶対パス、ディレクトリより上に出る `..`、リンク先がディレクトリの外になるシンボリックリンクは `ENOTCAPABLE`（76）になります。
    ただし uvwasi と同じく、モジュールから `/` に見えるディレクトリ（`/` という名前の preopen）より上への `..` は
    そのディレクトリにとどまります（そこでの `../x` は `x`）。
  - 途中のシンボリックリンクは、ディレクトリの中でたどります（絶対パスのリンク先はモジュールから見たパスとして、preopen の
    ゲストのパスを基準に解釈します）。最後の要素は `SYMLINK_FOLLOW` のときだけたどります。リンクが 32 個を超えると `ELOOP` です。
  - 途中のディレクトリが存在しなければ `ENOENT` です。最後の要素が存在しない場合の扱いは呼び出しに任せます（作成する呼び出しもあるため）。
- `path_symlink` が保存するリンクの内容はチェックしません。検索でそのリンクをたどるときに制限します。
- 権限（rights）は強制しません。どの fd もすべての権限を持つと報告します。

### エラー

カーネルのエラーは、WASI の errno の値として返します。

| エラー | errno | エラー | errno | エラー | errno |
|---|---:|---|---:|---|---:|
| `E2BIG` | 1 | `EINTR` | 27 | `ENOTCONN` | 53 |
| `EACCES` | 2 | `EINVAL` | 28 | `ENOTDIR` | 54 |
| `EADDRINUSE` | 3 | `EIO` | 29 | `ENOTEMPTY` | 55 |
| `EAGAIN` | 6 | `EISDIR` | 31 | `ENOTSUP` | 58 |
| `EBADF` | 8 | `ELOOP` | 32 | `ENOTTY` | 59 |
| `EBUSY` | 10 | `EMFILE` | 33 | `ENXIO` | 60 |
| `ECANCELED` | 11 | `EMLINK` | 34 | `EPERM` | 63 |
| `ECHILD` | 12 | `ENAMETOOLONG` | 37 | `EPIPE` | 64 |
| `ECONNREFUSED` | 14 | `ENFILE` | 41 | `ERANGE` | 68 |
| `ECONNRESET` | 15 | `ENODEV` | 43 | `EROFS` | 69 |
| `EEXIST` | 20 | `ENOENT` | 44 | `ESPIPE` | 70 |
| `EFAULT` | 21 | `ENOEXEC` | 45 | `ESRCH` | 71 |
| `EFBIG` | 22 | `ENOMEM` | 48 | `ETIMEDOUT` | 73 |
| | | `ENOSPC` | 51 | `EXDEV` | 75 |
| | | `ENOSYS` | 52 | `ENOTCAPABLE` | 76 |

それ以外のエラーは `EIO`（29）になります。存在しない fd は `EBADF`（8）、ファイルに対して `DIRECTORY` を付けた `path_open` は
`ENOTDIR`（54）です。

### スレッド

この WASI の実装には `thread-spawn` の import（wasi-threads）がありません。スレッドが必要なモジュールは、自身の
JavaScript 側でスレッドを用意します。napi-rs の `wasm32-wasi` のバインディングは、`WebAssembly.Memory` を共有する `worker_threads` の
Worker としてスレッドを起動します（OpenVessel のページは cross-origin isolated なので、共有メモリを使えます）。
通常の `wasm32-wasip1` 向けにビルドした WebAssembly はシングルスレッドで動きます。Pagefind の互換パッケージは、
シングルスレッドで動くようにパッチを当てています。

## 動くときの napi-rs と emnapi

napi-rs のパッケージが生成したローダー（`index.js`）は、まずプラットフォームごとのネイティブのバインディングを試します。どれもインストールされて
いないので、`-wasm32-wasi` のパッケージを読み込みます。そのパッケージの `<name>.wasi.cjs` は次の処理を行います。

- `<name>.wasm32-wasi.wasm` をコンパイルし、`node:wasi` の `WASI` インスタンスを作成して、`@napi-rs/wasm-runtime` と emnapi
  （`@emnapi/core`・`@emnapi/runtime`。WebAssembly 上に Node-API を実装したもの）を通じてモジュールをインスタンス化します。
- バインディングがスレッドを使う場合は、`wasi-worker.mjs` から `worker_threads` の Worker を起動します。

インストール時のルールが必要なのは、この 3 つのバージョンが整合していなければならないためです。バインディングはビルドに使った emnapi を固定し、
`@napi-rs/wasm-runtime` は対応する emnapi を peer に記載しています。メジャーバージョンの違う emnapi では、インスタンス化の時点で（import が足りずに）
失敗します。詳しくは [napi-rs の wasm32-wasi 版](#napi-rs-の-wasm32-wasi-版) を参照してください。

## 互換パッケージ

互換パッケージは、ネイティブコードしか提供していない npm パッケージの代わりになるものです。OpenVessel がビルドしてランタイムと
一緒に公開し、インストーラーが元のパッケージの名前とバージョンでインストールします。互換パッケージの中身は semver の対象外です
（`CHANGELOG.md` を参照）。

### ビルドされるファイル

`scripts/build-compat.mjs`（`scripts/build.mjs` から呼ばれるほか、`node scripts/build-compat.mjs` で単独でも実行できる）は、
`dist/runtime/compat/` に次のファイルを書き出します。

- `<id>-<version>.tgz`: npm の tarball にしたパッケージ（ustar 形式。パスはすべて `package/` の下）
- `index.json`: 置き換えるパッケージ名ごとに 1 エントリー

```json
{
  "@resvg/resvg-js": {
    "range": "^2.0.0",
    "file": "resvg-js-2.6.2.tgz",
    "integrity": "sha512-…",
    "pkg": {
      "name": "@openvessel/resvg-js-wasm",
      "version": "2.6.2",
      "description": "@resvg/resvg-js on @resvg/resvg-wasm (OpenVessel)",
      "license": "MPL-2.0",
      "main": "index.js",
      "types": "index.d.ts",
      "dependencies": { "@resvg/resvg-wasm": "2.6.2" }
    }
  }
}
```

| フィールド | 意味 |
|---|---|
| キー | 置き換える npm パッケージの名前 |
| `range` | 代替の対象となる、そのパッケージのバージョンの範囲 |
| `file` | `dist/runtime/compat/` 内の tarball の名前 |
| `integrity` | tarball の `sha512-` の SRI ハッシュ |
| `pkg` | 互換パッケージの `package.json`。インストーラーはこの `dependencies`・`bin` などを使う |

### インストーラーでの使われ方

`loadCompat()` は `<ランタイムのベース>/compat/index.json` を取得します（ランタイムのベースとは、カーネルのスクリプトを
配信しているディレクトリです）。取得できた一覧は、カーネルが動いている間は保持し続けます。取得に失敗した場合や OK 以外のレスポンスだった場合は、
そのインストールに限って空の一覧として扱い、次のインストールで再度取得します。

レジストリの依存パッケージについて、バージョンを選んで[系列の引き上げ](#系列の引き上げ)を適用したあと、パッケージの本来の名前（`npm:` の別名を
解決したあとの名前）のエントリーが一覧にあり、バージョンがその `range` を満たす（プレリリースを含む）場合は、次のように処理します。

- manifest は、`pkg` の `name` と `version` を要求されたパッケージのものに置き換えたものです。
- tarball は `<ランタイムのベース>/compat/<file>` です。ランタイムのオリジンから通常の `fetch` で取得し（ネットワークポリシーの
  確認は行いません）、`integrity` で検証し、レジストリの tarball と同じようにキャッシュします。
- 展開した `package.json` には、要求された `name` と `version`、そして `"_openvesselSource": "<互換パッケージの名前>@<version>"`
  が書き込まれます。この `<version>` は互換パッケージ自身のバージョンです（`pkg` にバージョンが無ければ要求されたバージョン）。
- [WebAssembly 版への置き換え](#webassembly-版への置き換え)は適用しません。

デプロイ先が `compat/` を配信していない場合は、ネイティブのパッケージを通常どおりインストールしようとします（そして環境での
絞り込みで除外されます）。

### pagefind

- 置き換える対象: `@pagefind/linux-x64` `^1.0.0`（Pagefind の npm のラッパーが linux/x64 で選ぶバイナリのパッケージ）
- パッケージ: `@openvessel/pagefind-wasi` 1.5.2
- ソース: `compat/pagefind/`
- 内容: `pagefind.wasm`・`bin/pagefind`・`bin/pagefind_extended`

`compat/pagefind/build.mjs` は crates.io から `pagefind` 1.5.2 の crate をダウンロードし、`compat/pagefind/wasi.patch` を当てて
`cargo build --release --target wasm32-wasip1 --no-default-features`（strip・LTO・codegen unit 1）を実行します。
cargo と `rustup target add wasm32-wasip1` が必要です。結果は `vendor/compat/pagefind/` にキャッシュします。
パッチは `target_os = "wasi"` のときだけ、次の変更を加えます。

- マルチスレッドの tokio ランタイムの代わりに、シングルスレッドの tokio ランタイム（`current_thread`。features は `rt`・`time`・`macros`・
  `sync`・`io-util`）を使う。
- 出力を `tokio::fs` ではなく `std::fs` で書き込む（`create_dir_all` と `File` だけを持つ小さな `wasi_fs` モジュール）。
- インデックス作成の処理を `spawn_blocking` ではなく、その場で実行する。
- `--service` モードの標準入力用・標準出力用の 2 つのスレッドを、1 つのループに置き換える。キューにあるレスポンスをすべて書き出し、
  次のリクエスト（`,` で終わる base64 の JSON）を読むまでブロックする。入力が終われば終了コード 0 で終了する。デコードできない
  メッセージにはエラーのレスポンスを返す。

`bin/pagefind` と `bin/pagefind_extended` は同じランチャーです。`args: ['pagefind', …argv]`・`env: process.env`・
`preopens: { '/': '/', '.': process.cwd() }`・`returnOnExit: true` の `node:wasi` インスタンスで実行し、`process.exitCode` に
モジュールの終了コードを設定します。`pagefind_extended` は `pagefind` と同じビルドを実行するので、extended 版にある CJK の
単語分割はありません。`pagefind` パッケージのコマンドラインと Node の API（`createIndex()` など。バイナリを
`--service` モードで実行するもの）は、ネイティブのバイナリと同じように動きます。

### cn-font-split

- 置き換える対象: `cn-font-split` `^7.0.0`
- パッケージ: `@openvessel/cn-font-split-wasi` 7.4.3
- ソース: `compat/cn-font-split/`
- 内容: 公開されている `cn-font-split` 7.4.3。`dist/node/index.js` と `dist/node/index.mjs` を差し替え、`dist/libffi-wasm32-wasip1.wasm` を追加したもの

`compat/cn-font-split/build.mjs` は、npm レジストリから `cn-font-split-7.4.3.tgz` を、プロジェクトの GitHub の
リリース 7.6.8 から `libffi-wasm32-wasip1.wasm` をダウンロードします。manifest は公開版のものから、依存の `koffi`、
`postinstall` スクリプト（ネイティブライブラリをダウンロードするもの）、`devDependencies` を取り除いたものです。

元の Node 向けのバックエンドは、Koffi（FFI）でネイティブライブラリを呼び出します。差し替えた `fontSplit(config)` は、同じ
ライブラリの `wasm32-wasip1` 版を `node:wasi` で実行します。

1. `config.input`（パスまたはバイト列）を読み込み、`config.subsets` を変換し、設定をパッケージの protobuf の
   `InputTemplate` としてシリアライズします。`outDir` が無ければ `Error('cn-font-split need outDir')`。
2. 一時ディレクトリ（`os.tmpdir()/cn-font-split-XXXXXX`）を作成し、`fonts/<key>`（設定）と空の `<key>/` を用意します。
   `<key>` はランダムな値です。
3. `args: [key]`・空の `env`・`preopens: { '/tmp': <一時ディレクトリ> }`・`returnOnExit: true` を指定し、`env` の import
   モジュールには何もしない `pthread_mutex_init`/`lock`/`unlock`/`destroy` を渡してモジュールを実行します。コンパイルした
   モジュールは後の呼び出しのために保持します。`CN_FONT_SPLIT_BIN` で `.wasm` ファイルのパスを上書きできます。
4. 終了コードが 0 以外なら `Error('cn-font-split exited with <code>')`。
5. `<key>/` 内のすべてのファイルを、`config.outputFile` または `fs-extra` の `outputFile` で `outDir` に書き込みます。
   `config.silent` でなければファイル名をログに出します。処理時間は `console.time` でログに出します。
6. 一時ディレクトリを削除します。

export するもの: `fontSplit`・`createAPI`・`decodeReporter`・`proto`（CommonJS と ESM）。シングルスレッドで動きます。

### resvg-js

- 置き換える対象: `@resvg/resvg-js` `^2.0.0`（`wasm32-wasi` 版の無い napi-rs のパッケージ）
- パッケージ: `@openvessel/resvg-js-wasm` 2.6.2。`@resvg/resvg-wasm` `2.6.2` に依存
- ソース: `compat/resvg-js/package/`（`index.js`・`index.d.ts`）

resvg-js は同期的に動き、フォントファイルを自分で読み込みます。一方 resvg-wasm は非同期に初期化し、フォントをバッファーで受け取ります。
`index.js` は次のように動きます。

- resvg-wasm の CommonJS のグルーコードに同期的な初期化処理を追加してコンパイルし、モジュールが require された時点で `index_bg.wasm` をインスタンス化します。
- `new Resvg(svg, options)`: `svg` は文字列か `Buffer` です。`options.font.fontFiles` と `options.font.fontDirs`
  （`.ttf`・`.otf`・`.ttc`・`.otc`・`.woff`・`.woff2` を再帰的に探す）を読み込み、指定された `fontBuffers` と合わせて
  `fontBuffers` に入れます。`loadSystemFonts` は無視します（システムフォントは存在しないため）。それ以外のオプションはそのまま
  resvg-wasm に渡します。
- `renderAsync(svg, options, signal)` は `new Resvg(svg, options).render()` の結果を返す Promise を返します。`signal` がすでに
  abort されていれば reject します。

export するもの: `Resvg`・`renderAsync`。`index.d.ts` に resvg-js の型定義があります。

```js
const { Resvg } = require('@resvg/resvg-js');
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', {
  font: { fontDirs: ['./fonts'] },
}).render().asPng();
```

### 互換パッケージの足し方

1. パッケージ自身のファイルを `compat/<id>/package/` に配置します。これらはベース（ある場合）の上にコピーされ、`package.json` は
   エントリーの `pkg` から生成されます。
2. ビルドやダウンロードが必要な場合は、`compat/<id>/build.mjs` を追加し、`outDir`（`vendor/compat/<id>/`。git 管理外）に書き出す
   `async function build(outDir)` を export します。この関数は、エントリーに記載した成果物が欠けている場合だけ
   実行されます。例外を投げると、ビルドは `compat <id>: not built (<message>); <names> will stay unavailable` と表示し、
   そのエントリーをスキップします。
3. `scripts/build-compat.mjs` の `COMPAT` にエントリーを追加します。

| フィールド | 意味 |
|---|---|
| `id` | `compat/` と `vendor/compat/` の下のディレクトリ名。tarball の名前のプレフィックスにもなる |
| `names` | 置き換える npm パッケージの名前（それぞれが `index.json` のエントリーになる） |
| `range` | 置き換える対象となる、それらのパッケージのバージョンの範囲 |
| `pkg` | `package.json` のオブジェクト。またはベースの `package.json` を受け取って返す関数。その `version` が tarball の名前に使われる |
| `artifacts` | 省略可。パッケージにコピーする `{ <vendor/compat/<id> 内のパス>: <パッケージ内のパス> }` |
| `base` | 省略可。出発点にする `vendor/compat/<id>/` 内のディレクトリ（展開した上流のパッケージなど） |

4. `node scripts/build-compat.mjs` を実行し、`dist/runtime/compat/index.json` にパッケージが載っていることを確認します。
   OpenVessel で元のパッケージをインストールし、その `package.json` に `_openvesselSource` があることを確認します。

```js
{
  id: 'example',
  names: ['example-native'],
  range: '^2.0.0',
  pkg: { name: '@openvessel/example-wasi', version: '2.1.0', main: 'index.js', license: 'MIT' },
  artifacts: { 'example.wasm': 'example.wasm' },
}
```

互換パッケージは元の API を保ちます。ローダーや利用側のコードは、元の名前のまま `require` します。ラッパーのパッケージが
実行するバイナリの場合は（Pagefind のように）、ラッパーが `linux`/`x64` で選ぶプラットフォームごとのパッケージの名前で互換パッケージを
作ってください。

## 動かせないもの

WebAssembly 版も互換パッケージも無いネイティブコードは動きません。具体的には、`.node` アドオン全般、Koffi のような FFI
ライブラリ、`workerd` のように独自のエンジンを組み込んだプログラム、ヘッドレスブラウザです。依存パッケージのインストールスクリプトは
実行しないので、`postinstall` でバイナリをダウンロードしたりコンパイルしたりするパッケージは、そのバイナリを得られません。
理由を含めた一覧は [互換性](../compatibility.ja.md) にあります。
