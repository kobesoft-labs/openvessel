# ネイティブのモジュール

[English](native-modules.md)

ブラウザのタブは機械語を読み込めないので、OpenVessel はネイティブアドオン（`.node` ファイル）を決して動かしません。
このページでは、その代わりに起きることを説明します。`npm install` がネイティブのパッケージを WebAssembly 版に
差し替える決まり、`.node` ファイルを動かそうとしたときの失敗のしかた、`node:wasi` の実装、napi-rs の `wasm32-wasi`
版と emnapi の読み込み、OpenVessel が自分でビルドする互換パッケージです。

## 概要

| やり方 | 場所 | 例 |
|---|---|---|
| パッケージ自身の WebAssembly 版を、ネイティブのパッケージの名前で入れる | インストーラー（`src/kernel/npm/install.ts`） | `esbuild` → `esbuild-wasm`、`rollup` 4 → `@rollup/wasm-node`、`lightningcss` → `lightningcss-wasm` |
| napi-rs のパッケージの `wasm32-wasi` 版を、それに合う emnapi と一緒に入れる | インストーラー | `rolldown`・`@node-rs/xxhash` などの napi-rs のパッケージ |
| WebAssembly 版がある系列へ上げる | インストーラー | `sharp` < 0.33 → 0.34 |
| OpenVessel がビルドした互換パッケージを入れる | インストーラー＋`compat/`・`scripts/build-compat.mjs` | Pagefind・`cn-font-split`・`@resvg/resvg-js` |
| WebAssembly を WASI preview1 で動かす | `node:wasi`（`src/node/wasi.ts`） | 上のうち WASI 向けにビルドされたものすべて |
| はっきり失敗させる | モジュールの読み込み・`process.dlopen` | そのほかの `.node` ファイル |

パッケージマネージャの側（解決・置き場所・lockfile）は[パッケージマネージャ](package-managers.ja.md)にあります。

## プロセスから見えるもの

| 項目 | 値 | 意味 |
|---|---|---|
| `process.platform`・`process.arch` | `linux`・`x64`（両方の層） | 読み込み役はこれで環境ごとのパッケージを選びます。互換パッケージは、読み込み役が期待する場所では `linux-x64` の名前で出しています |
| `process.versions.napi` | `10` | |
| `process.report.getReport().header.glibcVersionRuntime` | `2.36` | `detect-libc` がこれを読むので、musl でなく glibc の環境として数えられます |
| `NAPI_RS_FORCE_WASI` | カーネルの既定の環境で `true`（`src/kernel/kernel.ts`） | napi-rs が生成する読み込み役が読み、ネイティブ版を試さずに `wasm32-wasi` のパッケージを読みます。古い読み込み役は空でない値なら何でも、最近のものは `true` か `error` のときだけ WASI を強制します。`true` はどちらでも効きます |
| インストーラーが使う環境 | `os: linux`・`cpu: wasm32` | `cpu` が `x64`・`arm64` などのパッケージは、入れるときに飛ばします |

## 入れるときの決まり

決まりはすべて `src/kernel/npm/install.ts` にあります。どの入口（`npm`・`pnpm`・`yarn`・`bun`）にも、`npx` にも効きます。

### 順番

レジストリの依存では、`resolve()` が次の順に進めます。

1. 指定から版を選ぶ（lockfile の手がかり・`latest`・合ういちばん高い版）。
2. [系列の引き上げ](#系列の引き上げ): ネイティブだけの古い系列を、WebAssembly 版がある系列へ上げる。
3. [互換パッケージ](#互換パッケージ): その名前と版に登録があれば、それを使ってここで終わる。
4. [WebAssembly 版への置き換え](#webassembly-版への置き換え): 中身を WebAssembly のパッケージに替える。

パッケージの依存を並べるときに、[napi-rs](#napi-rs-の-wasm32-wasi-版) と [sharp](#sharp) の決まりが依存を足したり
変えたりし、[環境での絞り込み](#環境での絞り込み)が動かせないパッケージを外します。

### 決して入れないもの

`fsevents`・`bufferutil`・`utf-8-validate`・`cpu-features`・`ssh2` は、どこに書かれていても飛ばします（`SKIP`）。
これらを `require()` すると `MODULE_NOT_FOUND` で失敗します。

### WebAssembly 版への置き換え

`SUBSTITUTES`:

| パッケージ | 中身の出どころ | 条件 |
|---|---|---|
| `esbuild` | `esbuild-wasm` | どの版でも |
| `rollup` | `@rollup/wasm-node` | メジャー版が 4 以上 |
| `lightningcss` | `lightningcss-wasm` | どの版でも |
| `sass-embedded` | `sass`（JavaScript だけの Dart Sass） | どの版でも |

- 置き換え先の版は、同じ版があればそれ、なければ `~<version>` のいちばん高い版、なければ `^<version>` のいちばん
  高い版です。どれもないか、情報が取れなければ、元のパッケージをそのまま入れます。
- パッケージは頼まれた名前と版のままです。`node_modules/esbuild` に置かれ、その `package.json` には
  `"name": "esbuild"`、解決した版、`"_openvesselSource": "esbuild-wasm@<version>"` が入ります。この版は実際に展開した
  置き換え先の版です（`~`・`^` で別の版を選んだときは、解決した版と違います）。`bin` は置き換え先のもの、なければ
  元のものです。
- 依存に使う manifest は置き換え先のものなので、ネイティブのパッケージの環境ごとの `optionalDependencies`
  （`@esbuild/linux-x64` など）は要求しません。

### 系列の引き上げ

`UPGRADES`:

| パッケージ | 版 | 代わりに入れるもの |
|---|---|---|
| `sharp` | `<0.33.0` | `^0.34.0` で決まる版 |

0.33 より前の sharp は libvips を `.node` アドオンとして同梱していました。0.33 以降には WebAssembly 版があり、
呼ぶ側が使う範囲では API が同じです。`package.json` は変えません。入る版は範囲と食い違い、何も表示しません。

### napi-rs の wasm32-wasi 版

napi-rs のパッケージは、環境ごとのバイナリのパッケージを `optionalDependencies` に並べます
（`@scope/pkg-linux-x64-gnu` など）。出している場合は、`@napi-rs/wasm-runtime` と emnapi の上で動く WebAssembly 版
（`@scope/pkg-wasm32-wasi`、`cpu: ["wasm32"]`）もあります。

`withWasiBinding()`: すべてのパッケージ（プロジェクト自身も）の `optionalDependencies` で、`wasm32` を含む名前が
なく、`-(linux|darwin|win32|freebsd|android)-(x64|arm64|arm|ia32)` に `-gnu`・`-musl`・`-msvc`・`-gnueabihf`・`-eabi`
が続いてもよい形で終わる名前があれば、最初のそのネイティブの項目と同じ指定で `<base>-wasm32-wasi` を足します。
そのパッケージがなければ、optional の依存として `npm warn optional skipping …` を出して飛ばします。

`withEmnapi()`: 名前が `-wasm32-wasi` で終わり、`dependencies` に `@emnapi/core` がないパッケージには、
`@emnapi/core@^1.4.0` と `@emnapi/runtime@^1.4.0` を足します。emnapi 1.x でビルドした版は、`@napi-rs/wasm-runtime`
の peer が見つける emnapi に頼ることが多く、それが別の版の emnapi 2 になることがあります（その実行時には、1.x の
ビルドが import する `napi_set_last_error` がありません）。emnapi 2 向けの版は自分で書いています。

`pickWasmRuntime()`（1.1.1 から）: `-wasm32-wasi` のパッケージが `@napi-rs/wasm-runtime` に範囲で依存し、
`@emnapi/core` をそのままの版で固定しているとき、その範囲の中で、`peerDependencies['@emnapi/core']` が固定された版を
受け入れる（プレリリースも含めて）いちばん新しい `@napi-rs/wasm-runtime` を選びます。その peer を持たない版は
受け入れます。合うものがない、版の emnapi がそのままの版でない、プロジェクトが `@napi-rs/wasm-runtime` を
overrides している、のどれかなら、範囲をふつうに解決します。選んだ版はその版自身の `node_modules` に置くので、
ほかのパッケージは拾いません。例: `@emnapi/core@2.0.0-alpha.5` を固定し `@napi-rs/wasm-runtime@~1.2.5` に依存する版は
1.2.5 になります。1.2.6 の peer は `2.0.0-beta.2` しか受け入れないからです。

`DEP_PINS`: WebAssembly 版の依存を、ビルドしたときの版に固定し、依存する側の隣に置きます。

| パッケージ | 版 | 依存 | 固定する版 |
|---|---|---|---|
| `@img/sharp-wasm32` | `<0.34.0` | `@emnapi/runtime` | `1.1.1` |

（これらのビルドの emscripten＋emnapi 1.1 のつなぎは、`@emnapi/runtime` 1.2 で変わった callback-info のスタックを
使います。）

### sharp

| 決まり | 効果 |
|---|---|
| `UPGRADES` | `sharp` `<0.33.0` → `^0.34.0` |
| `withSharpWasm()` | `sharp` `>=0.35.0-0` で、`optionalDependencies` に `@img/sharp-wasm32` がなければ `@img/sharp-wasm32@<同じ版>` を足す（0.35 は WebAssembly 版を `@img/sharp-webcontainers-wasm32` として出すが、linux-x64 では `require('@img/sharp-wasm32')` に落ちる） |
| `DEP_PINS` | `@img/sharp-wasm32` `<0.34.0` に `@emnapi/runtime@1.1.1` |
| 環境での絞り込み | ネイティブの `@img/sharp-linux-x64` と `@img/sharp-libvips-*` は `cpu` で外れる |

```js
// ふつうに `npm install sharp` した後で動く
const sharp = require('sharp');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
```

### 環境での絞り込み

解決したパッケージは、`os` が `linux` を受け入れないか、`cpu` が `wasm32` を受け入れなければ飛ばします（`!win32` の
ような否定も読み、空のリストは何でも受け入れます）。optional でない依存なら
`npm warn EBADPLATFORM skipping <name>@<version> (needs …)` を出します。`libc` と `engines` は調べません。互換
パッケージは manifest を置き換えるので、`os`・`cpu` は互換パッケージのもの（なし）になります。

### 特別に扱う名前

インストーラーが特別に扱うパッケージの名前すべて:

| 名前 | 決まり |
|---|---|
| `fsevents`・`bufferutil`・`utf-8-validate`・`cpu-features`・`ssh2` | 決して入れない |
| `esbuild` | `esbuild-wasm` に置き換え |
| `rollup`（4 以上） | `@rollup/wasm-node` に置き換え |
| `lightningcss` | `lightningcss-wasm` に置き換え |
| `sass-embedded` | `sass` に置き換え |
| `sharp` | `<0.33` は引き上げ。`>=0.35` には `@img/sharp-wasm32` を足す |
| `@img/sharp-wasm32` | `<0.34` には `@emnapi/runtime@1.1.1` |
| `@napi-rs/wasm-runtime` | 版の emnapi に合わせて版を選ぶ（`pickWasmRuntime`） |
| `@emnapi/core`・`@emnapi/runtime` | 書いていない `*-wasm32-wasi` のパッケージに足す |
| `*-wasm32-wasi` | emnapi を足す。napi-rs の環境ごとの optional の依存の隣に足す |
| `@pagefind/linux-x64`・`cn-font-split`・`@resvg/resvg-js` | 互換パッケージ（`index.json` から） |

## .node ファイルの読み込み

`require()` の解決は、`.js`・`.json` の次に `.node` も試します（両方の層）。そのため、ネイティブのファイルだけを
持つパッケージは、ファイルを見つけたうえで読み込みに失敗します。

| | 移植版ランタイム（`src/nodejs/bindings/process.ts`） | 旧ランタイム（`src/node/module.ts`・`src/node/process.ts`） |
|---|---|---|
| `require('x.node')` | Node 自身の読み込みが `process.dlopen` を呼び、`ERR_DLOPEN_FAILED` を投げる | `ERR_DLOPEN_FAILED` を投げる: `Native addons are not supported in OpenVessel (tried to load <file>). Use the WebAssembly build of this package.` |
| `process.dlopen()` | glibc の `dlopen` に似たメッセージ（下）で `ERR_DLOPEN_FAILED` を投げる | 同じ |
| `import 'x.node'` | `ERR_UNKNOWN_FILE_EXTENSION`（`--experimental-addon-modules` なしの Node 22 と同じ） | 失敗する |

`process.dlopen` のメッセージ（どちらの層も）:

| ファイル | メッセージ |
|---|---|
| ない | `<file>: cannot open shared object file: No such file or directory` |
| 64 バイトより短い | `<file>: file too short` |
| ELF の印で始まらない | `<file>: invalid ELF header` |
| ELF のファイル | `Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.` |

napi-rs の読み込み役はこれらのエラーを受け止めて次の候補へ進み、最後に `wasm32-wasi` のパッケージにたどり着きます
（[動くときの napi-rs と emnapi](#動くときの-napi-rs-と-emnapi)）。

## node:wasi

カーネルのファイルシステムの上の WASI preview1 で、`src/node/wasi.ts` にあります。両方の層が同じ import の関数を
使い、その周りの JavaScript の API がちがいます。

### API

| | 移植版ランタイム | 旧ランタイム |
|---|---|---|
| モジュール | `internalBinding('wasi')`（`src/nodejs/bindings/wasi.ts`）の上の、Node 自身の `lib/wasi.js` | `src/node/wasi.ts` の `WASI` クラスそのもの |
| `version` | 必須。`'preview1'` か `'unstable'`。ない → `ERR_INVALID_ARG_TYPE`、ほかの値 → `ERR_INVALID_ARG_VALUE` | 同じ |
| `getImportObject()` | `{ wasi_snapshot_preview1: … }`。`'unstable'` なら `{ wasi_unstable: … }` | 同じ |
| 設定の検査（`args`・`env`・`preopens`・`stdin`・`stdout`・`stderr`・`returnOnExit`） | Node のもの | 同じ検査とメッセージを `src/node/wasi.ts` に書いたもの |
| `env` の値が `undefined` の項目 | 除く（Node と同じ）。ほかの値は `KEY=<String(値)>` | 同じ |
| `returnOnExit`（既定 `true`） | `start()` が終了コードを返す。`false` なら `proc_exit` でプロセスが終わる | 同じ |
| `start(instance)` | `_start` が要り、`_initialize` は拒む（Node の検査）。2 度目は `ERR_WASI_ALREADY_STARTED` | 同じ |
| `initialize(instance)` | `_start` は拒み、`_initialize` があれば呼ぶ | 同じ |
| メモリ | `instance.exports.memory` | 同じ |
| `ExperimentalWarning: WASI is an experimental feature…` | Node と同じく 1 回出る | 出ない |

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

preview1 の 46 の関数がすべてあります。ファイルに触る関数はカーネルのシステムコールを通るので、`fs` と同じ
メモリ上のファイルシステムが見えます。

| 関数 | 動き |
|---|---|
| `args_get`・`args_sizes_get`・`environ_get`・`environ_sizes_get` | `args` と `env` から |
| `clock_time_get` | 時計 0（実時間）: `Date.now()` をナノ秒にしたもの（ミリ秒の細かさ）。ほかの時計: `performance.timeOrigin + performance.now()` |
| `clock_res_get` | いつも 1000 ns |
| `fd_read`・`fd_write`・`fd_pread`・`fd_pwrite` | カーネルの `read`・`write`。iovec ごとに読み書きする |
| `fd_seek`・`fd_tell` | カーネルの `lseek` |
| `fd_close` | カーネルの fd を閉じる（0〜2 は閉じない） |
| `fd_fdstat_get` | ファイルの種類・`APPEND` の印・すべての権利 |
| `fd_filestat_get`・`path_filestat_get` | カーネルの `fstat`・`stat`（`path_filestat_get` は `SYMLINK_FOLLOW` のときだけリンクをたどる） |
| `fd_filestat_set_size` | カーネルの `ftruncate` |
| `fd_filestat_set_times`・`path_filestat_set_times` | カーネルの `utimes`。`fst_flags` で変える時刻と「いま」にするかを選ぶ（時刻と「いま」を両方指定すると `EINVAL`）。`path_filestat_set_times` は `SYMLINK_FOLLOW` がなければリンクそのものを変える |
| `fd_readdir` | 先頭に `.` と `..`。`d_next` と `d_ino` は項目の番号＋1 |
| `fd_renumber` | 項目を移し、移し先は閉じる |
| `fd_prestat_get`・`fd_prestat_dir_name` | 前もって開いたディレクトリ。fd 3 から |
| `path_open` | ディレクトリはディレクトリの取っ手になる。`CREAT`・`DIRECTORY`・`EXCL`・`TRUNC` と fd の `APPEND` の印は `open` の flags に対応する。読み書きのどちらかは求めた権利から決める。`SYMLINK_FOLLOW` なしで開いた最後の部分がシンボリックリンクなら `ELOOP` |
| `path_create_directory`・`path_remove_directory`・`path_unlink_file`・`path_rename`・`path_link`・`path_symlink`・`path_readlink` | 対応するカーネルの呼び出し |
| `poll_oneoff` | 時計の購読は、いちばん短い待ち時間（相対でも絶対でも）だけスレッドを止める（`Atomics.wait`）。fd の購読はすぐに準備できたと返し、呼び出しを止めない |
| `random_get` | `crypto.getRandomValues` を 64 KiB ずつ |
| `proc_exit` | その終了コードで `start()` を終える（`returnOnExit` を参照） |
| `sched_yield`・`fd_advise`・`fd_allocate`・`fd_datasync`・`fd_sync`・`fd_fdstat_set_flags`・`fd_fdstat_set_rights` | 何もせずに成功する |
| `proc_raise`・`sock_accept`・`sock_recv`・`sock_send`・`sock_shutdown` | `ENOSYS`（52） |

### ファイルと preopens

- fd 0・1・2 はプロセスの標準入力・標準出力・標準エラーです（`stdin`・`stdout`・`stderr` を渡せば、そのカーネルの fd）。
- `preopens` の各項目 `{ ゲストのパス: ホストのパス }` は、fd 3 からのディレクトリの fd になります。ホストのパスは
  プロセスの作業ディレクトリから解決します。
- パスの引数は、それが相対となるディレクトリの fd の下で、1 段ずつたどって探します（`src/node/wasi-path.ts`）。
  uvwasi がモジュールを preopens の中に閉じ込めるのと同じです。パスを取る呼び出しはすべてこうします
  （`path_open`・`path_filestat_get`・`path_filestat_set_times`・`path_create_directory`・`path_remove_directory`・
  `path_unlink_file`・`path_rename`・`path_link`・`path_symlink` の新しいパス・`path_readlink`）。
  - 絶対パス、ディレクトリより上への `..`、行き先がディレクトリの外になるシンボリックリンクは `ENOTCAPABLE`（76）。
    ただし uvwasi と同じく、モジュールから `/` に見えるディレクトリ（`/` という名前の preopen）より上への `..` は
    そこにとどまる（そこでの `../x` は `x`）
  - 途中のシンボリックリンクはディレクトリの中でたどる（絶対パスの行き先はモジュールから見たパスとして、preopen の
    ゲストのパスからの位置で読む）。最後の部分は `SYMLINK_FOLLOW` のときだけたどる。32 個を超えると `ELOOP`
  - 途中のディレクトリがなければ `ENOENT`。最後の部分がないときは呼び出しに任せる（作る呼び出しもある）
- `path_symlink` が書き込むリンクの中身は検査しません。たどるときに閉じ込めます。
- 権利は効かせません。どの fd もすべての権利を持つと答えます。

### エラー

カーネルのエラーは WASI の errno の値で返します。

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

そのほかのエラーは `EIO`（29）です。知らない fd は `EBADF`（8）、ファイルに `DIRECTORY` をつけた `path_open` は
`ENOTDIR`（54）です。

### スレッド

この WASI の実装には `thread-spawn` の import（wasi-threads）がありません。スレッドが要るモジュールは、自分の
JavaScript でそれを用意します。napi-rs の `wasm32-wasi` 版は、`WebAssembly.Memory` を共有する `worker_threads` の
Worker としてスレッドを起こします（OpenVessel のページは cross-origin isolated なので、共有メモリが使えます）。
ふつうの `wasm32-wasip1` 向けにビルドした WebAssembly は 1 本のスレッドで動きます。Pagefind の互換パッケージは、
そう動くようにパッチを当てています。

## 動くときの napi-rs と emnapi

napi-rs のパッケージが生成した読み込み役（`index.js`）は、まず環境ごとのネイティブ版を試します。どれも入って
いないので、`-wasm32-wasi` のパッケージを読みます。そのパッケージの `<name>.wasi.cjs` は:

- `<name>.wasm32-wasi.wasm` をコンパイルし、`node:wasi` の `WASI` を作り、`@napi-rs/wasm-runtime` と emnapi
  （`@emnapi/core`・`@emnapi/runtime`。WebAssembly の上に Node-API を実装するもの）を通してモジュールを動かします。
- 版がスレッドを使うときは、`wasi-worker.mjs` から `worker_threads` の Worker を起こします。

入れるときの決まりがあるのは、この 3 つが合っていなければならないからです。版は自分をビルドした emnapi を固定し、
`@napi-rs/wasm-runtime` は使える emnapi を peer に書き、メジャー版のちがう emnapi は動かすときに（import が足りずに）
失敗します。[napi-rs の wasm32-wasi 版](#napi-rs-の-wasm32-wasi-版)を参照してください。

## 互換パッケージ

互換パッケージは、ネイティブのコードしか持たない npm のパッケージの代わりです。OpenVessel がビルドしてランタイムと
一緒に置き、インストーラーが元のパッケージの名前と版で入れます。互換パッケージの中身は semver の対象ではありません
（`CHANGELOG.md` を参照）。

### ビルドされるファイル

`scripts/build-compat.mjs`（`scripts/build.mjs` が呼ぶ。`node scripts/build-compat.mjs` で単独でも動く）が
`dist/runtime/compat/` に書きます。

| ファイル | 中身 |
|---|---|
| `<id>-<version>.tgz` | npm の tarball にしたパッケージ（ustar。パスはすべて `package/` の下） |
| `index.json` | 置き換えるパッケージの名前ごとに 1 項目 |

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

| 項目 | 意味 |
|---|---|
| キー | 置き換える npm のパッケージの名前 |
| `range` | 代わりを務める、そのパッケージの版 |
| `file` | `dist/runtime/compat/` の中の tarball の名前 |
| `integrity` | tarball の `sha512-` の SRI のハッシュ |
| `pkg` | 互換パッケージの `package.json`。インストーラーはこの `dependencies`・`bin` などを使う |

### インストーラーでの使われ方

`loadCompat()` は `<ランタイムの基点>/compat/index.json` を取ってきます（ランタイムの基点は、カーネルのスクリプトが
置かれたディレクトリです）。取れた一覧はカーネルが動いているあいだ使い続けます。取れなかったり OK でなかったり
すれば、そのインストールだけ空の一覧として扱い、次のインストールでまた取りにいきます。

レジストリの依存で、版を選んで[系列の引き上げ](#系列の引き上げ)をした後、パッケージの本当の名前（`npm:` の別名を
たどった後）の項目が一覧にあり、版がその `range` に合えば（プレリリースも含む）:

- manifest は `pkg` に、頼まれたパッケージの `name` と `version` を入れたものです。
- tarball は `<ランタイムの基点>/compat/<file>` です。ランタイムのオリジンからふつうの `fetch` で取得し（ネットワークポリシーの
  確認は通りません）、`integrity` で確かめ、レジストリの tarball と同じようにキャッシュします。
- 展開した `package.json` には、頼まれた `name` と `version`、`"_openvesselSource": "<互換パッケージの名前>@<version>"`
  が入ります。この版は互換パッケージ自身の版です（`pkg` に版がなければ頼まれた版）。
- [WebAssembly 版への置き換え](#webassembly-版への置き換え)はしません。

配置先が `compat/` を出していなければ、ネイティブのパッケージをいつもどおり入れようとします（そして環境での
絞り込みで外れます）。

### pagefind

| | |
|---|---|
| 置き換えるもの | `@pagefind/linux-x64` `^1.0.0`（Pagefind の npm の包みが linux/x64 で選ぶバイナリのパッケージ） |
| パッケージ | `@openvessel/pagefind-wasi` 1.5.2 |
| ソース | `compat/pagefind/` |
| 中身 | `pagefind.wasm`・`bin/pagefind`・`bin/pagefind_extended` |

`compat/pagefind/build.mjs` は crates.io から `pagefind` 1.5.2 の crate を取り、`compat/pagefind/wasi.patch` を当てて
`cargo build --release --target wasm32-wasip1 --no-default-features`（strip・LTO・codegen unit 1）を動かします。
cargo と `rustup target add wasm32-wasip1` が要ります。結果は `vendor/compat/pagefind/` にキャッシュします。
パッチは `target_os = "wasi"` のときだけ、次のように変えます。

- 複数スレッドの tokio の代わりに、1 本のスレッドの tokio（`current_thread`。features は `rt`・`time`・`macros`・
  `sync`・`io-util`）を使う。
- 出力を `tokio::fs` でなく `std::fs` で書く（`create_dir_all` と `File` だけの小さな `wasi_fs` モジュール）。
- 索引づくりを `spawn_blocking` でなく、その場で動かす。
- `--service` のモードの標準入力・標準出力の 2 本のスレッドを、1 つのループに替える。並んだ応答をすべて書き、
  次の要求（`,` で終わる base64 の JSON）を読むまで止まる。入力が終われば終了コード 0 で終わる。読めない
  メッセージにはエラーの応答を返す。

`bin/pagefind` と `bin/pagefind_extended` は同じ起動役です。`args: ['pagefind', …argv]`・`env: process.env`・
`preopens: { '/': '/', '.': process.cwd() }`・`returnOnExit: true` の `node:wasi` で動かし、`process.exitCode` に
モジュールの終了コードを入れます。`pagefind_extended` は `pagefind` と同じビルドを動かすので、extended 版の CJK の
単語分けはありません。`pagefind` パッケージのコマンド行と Node の API（`createIndex()` など。バイナリを
`--service` のモードで動かすもの）は、ネイティブのバイナリと同じように動きます。

### cn-font-split

| | |
|---|---|
| 置き換えるもの | `cn-font-split` `^7.0.0` |
| パッケージ | `@openvessel/cn-font-split-wasi` 7.4.3 |
| ソース | `compat/cn-font-split/` |
| 中身 | 公開されている `cn-font-split` 7.4.3。`dist/node/index.js` と `dist/node/index.mjs` を差し替え、`dist/libffi-wasm32-wasip1.wasm` を足したもの |

`compat/cn-font-split/build.mjs` は npm のレジストリから `cn-font-split-7.4.3.tgz` を、プロジェクトの GitHub の
リリース 7.6.8 から `libffi-wasm32-wasip1.wasm` を取ってきます。manifest は公開されているものから、`koffi` の依存、
`postinstall` のスクリプト（ネイティブのライブラリをダウンロードするもの）、`devDependencies` を外したものです。

元の Node 向けの実装は、Koffi（FFI）でネイティブのライブラリを呼びます。差し替えた `fontSplit(config)` は、同じ
ライブラリの `wasm32-wasip1` 版を `node:wasi` で動かします。

1. `config.input`（パスかバイト列）を読み、`config.subsets` を変換し、設定をパッケージの protobuf の
   `InputTemplate` にします。`outDir` がなければ `Error('cn-font-split need outDir')`。
2. 一時ディレクトリ（`os.tmpdir()/cn-font-split-XXXXXX`）を作り、`fonts/<key>`（設定）と空の `<key>/` を置きます。
   `<key>` はでたらめな値です。
3. `args: [key]`・空の `env`・`preopens: { '/tmp': <一時ディレクトリ> }`・`returnOnExit: true` で、`env` の import
   モジュールに何もしない `pthread_mutex_init`・`lock`・`unlock`・`destroy` を渡して動かします。コンパイルした
   モジュールは次の呼び出しのために残します。`CN_FONT_SPLIT_BIN` で `.wasm` ファイルのパスを変えられます。
4. 終了コードが 0 でなければ `Error('cn-font-split exited with <code>')`。
5. `<key>/` の中のファイルをすべて、`config.outputFile` か `fs-extra` の `outputFile` で `outDir` に書きます。
   `config.silent` でなければ名前を出します。かかった時間は `console.time` で出します。
6. 一時ディレクトリを消します。

外に出すもの: `fontSplit`・`createAPI`・`decodeReporter`・`proto`（CommonJS と ESM）。1 本のスレッドで動きます。

### resvg-js

| | |
|---|---|
| 置き換えるもの | `@resvg/resvg-js` `^2.0.0`（`wasm32-wasi` 版のない napi-rs のパッケージ） |
| パッケージ | `@openvessel/resvg-js-wasm` 2.6.2。`@resvg/resvg-wasm` `2.6.2` に依存 |
| ソース | `compat/resvg-js/package/`（`index.js`・`index.d.ts`） |

resvg-js は同期で、フォントのファイルを自分で読みます。resvg-wasm は非同期で初期化し、フォントをバイト列で受け取ります。
`index.js` は:

- resvg-wasm の CommonJS のつなぎに同期の初期化を足してコンパイルし、読み込んだ時点で `index_bg.wasm` を動かします。
- `new Resvg(svg, options)`: `svg` は文字列か `Buffer`。`options.font.fontFiles` と `options.font.fontDirs`
  （`.ttf`・`.otf`・`.ttc`・`.otc`・`.woff`・`.woff2` を下の階層まで探す）を読み、渡された `fontBuffers` と合わせて
  `fontBuffers` にします。`loadSystemFonts` は無視します（システムのフォントはありません）。ほかの設定はそのまま
  resvg-wasm に渡します。
- `renderAsync(svg, options, signal)` は `new Resvg(svg, options).render()` の Promise を返します。`signal` がすでに
  中止されていれば拒否します。

外に出すもの: `Resvg`・`renderAsync`。`index.d.ts` に resvg-js の型があります。

```js
const { Resvg } = require('@resvg/resvg-js');
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', {
  font: { fontDirs: ['./fonts'] },
}).render().asPng();
```

### 互換パッケージの足し方

1. パッケージ自身のファイルを `compat/<id>/package/` に置きます。土台（あれば）の上にコピーされ、`package.json` は
   項目の `pkg` から書かれます。
2. ビルドやダウンロードが要るなら、`outDir`（`vendor/compat/<id>/`。git の外）に書く
   `async function build(outDir)` を出す `compat/<id>/build.mjs` を足します。項目に書いた成果物が欠けているときだけ
   動きます。例外を投げると、ビルドは `compat <id>: not built (<message>); <names> will stay unavailable` を出し、
   その項目を飛ばします。
3. `scripts/build-compat.mjs` の `COMPAT` に項目を足します。

| 項目 | 意味 |
|---|---|
| `id` | `compat/` と `vendor/compat/` の下のディレクトリの名前。tarball の名前の頭にもなる |
| `names` | 置き換える npm のパッケージの名前（それぞれ `index.json` の項目になる） |
| `range` | 置き換える、それらのパッケージの版 |
| `pkg` | `package.json` のオブジェクト。または土台の `package.json` を受け取って返す関数。その `version` が tarball の名前になる |
| `artifacts` | 省略可。パッケージにコピーする `{ <vendor/compat/<id> の中のパス>: <パッケージの中のパス> }` |
| `base` | 省略可。始めにする `vendor/compat/<id>/` の中のディレクトリ（展開した元のパッケージなど） |

4. `node scripts/build-compat.mjs` を動かし、`dist/runtime/compat/index.json` にパッケージが載ったか確かめます。
   OpenVessel で元のパッケージを入れ、その `package.json` の `_openvesselSource` を確かめます。

```js
{
  id: 'example',
  names: ['example-native'],
  range: '^2.0.0',
  pkg: { name: '@openvessel/example-wasi', version: '2.1.0', main: 'index.js', license: 'MIT' },
  artifacts: { 'example.wasm': 'example.wasm' },
}
```

互換パッケージは元の API を保ちます。読み込み役や呼ぶ側は、元の名前のまま `require` します。包みのパッケージが
動かすバイナリなら（Pagefind のように）、包みが `linux`・`x64` で選ぶ環境ごとのパッケージの名前で互換パッケージを
作ります。

## 動かせないもの

WebAssembly 版も互換パッケージもないネイティブのコードは動きません。`.node` アドオン全般、Koffi のような FFI の
ライブラリ、`workerd` のように自前のエンジンを抱えたプログラム、ヘッドレスのブラウザです。依存の install スクリプトは
動かさないので、`postinstall` でバイナリをダウンロードしたりコンパイルしたりするパッケージはそれを得られません。
理由つきの一覧は[互換性](../compatibility.ja.md)にあります。
