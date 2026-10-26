# ホスト API

[English](host-api.md)

埋め込む側のページが使う API の、すべての仕様です。`OpenVessel.boot()` とそのオプション、ファイル、プロセス、
通信の方針、イベント、許可の問い合わせと組み込みのダイアログ、プレビュー、後片付け、エラーを扱います。ソースは
`src/host/index.ts`、型の宣言は `dist/types/host/index.d.ts` です。順を追った説明は [はじめに](getting-started.ja.md)
にあります。

## エクスポート

```ts
import OpenVessel from 'openvessel';               // 既定のエクスポート: OpenVessel のクラス
import { OpenVessel, Process, PRESETS } from 'openvessel';
import type { BootOptions, SpawnOptions, PermissionRequest, PermissionDecision, NetworkPolicy } from 'openvessel';
```

| エクスポート | 種類 | 説明 |
|---|---|---|
| `OpenVessel`（既定のエクスポートも同じ） | クラス | 埋め込んだランタイム 1 つ。`OpenVessel.boot()` だけが作ります。 |
| `Process` | クラス | `spawn()` で起動したプロセス。利用する側で作るものではありません。 |
| `VesselProcess` | クラス（別名） | `Process` の非推奨の別名（1.1.0 で改名）。 |
| `PRESETS` | オブジェクト | 通信の方針の、用意したホストの一覧。セットの名前がキーです（[通信の方針](network-policy.ja.md#用意したセット)）。 |
| `BootOptions` | 型 | `boot()` のオプション。 |
| `SpawnOptions` | 型 | `spawn()` と `exec()` のオプション。 |
| `PermissionRequest` | 型 | 許可の問い合わせの処理に渡るもの。 |
| `PermissionDecision` | 型 | `'once' \| 'session' \| 'deny' \| 'deny-session'`。 |
| `NetworkPolicy` | 型 | `{ mode, presets, allow, deny }`（[通信の方針](network-policy.ja.md#ポリシーの形)）。 |

ソースで `@internal` と書いたメンバー（`_call`・`Process._data`・`Process._exit`）は API に含みません。

## `OpenVessel.boot()`

```ts
static boot(opts: BootOptions): Promise<OpenVessel>
```

ランタイムを埋め込み、つながったインスタンスで解決します。

### `BootOptions`

| オプション | 型 | 既定 | 意味 |
|---|---|---|---|
| `runtimeUrl` | `string` | 必須 | `dist/runtime/` を配っている場所。`location.href` を基準に解決し、フレームは `new URL('runtime.html', runtimeUrl)` を読みます。ディレクトリを最後の `/` 付きで（`https://rt.example.com/`）、または `runtime.html` の URL そのものを渡します。ページと同じオリジンだと、`boot()` は警告 `OpenVessel: the runtime should be served from its own origin` を出して続けます。 |
| `previewUrl` | `string` | なし | `dist/preview/` を配っている場所。そのディレクトリ（`new URL('./', previewUrl)`）がプレビューの基準になるので、最後は `/` にします。無いと `previewUrl()` と `createPreview()` は失敗し、`server-ready` の `url` は `null` です。 |
| `network` | `Partial<NetworkPolicy>` | `{ mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'], allow: [], deny: [] }` | 最初の通信の方針。無い項目は既定の値になります。 |
| `onPermissionRequest` | `(req: PermissionRequest) => PermissionDecision \| Promise<PermissionDecision>` | 組み込みのダイアログ | 方針で決まらないホストへの要求に答えます（[許可の問い合わせ](#許可の問い合わせ)）。 |
| `locale` | `'ja' \| 'en'` | `navigator.language` が `ja` で始まれば `'ja'`、ほかは `'en'` | 組み込みのダイアログの言語。 |
| `timeout` | `number`（ms） | `30000` | `boot()` がカーネルの準備を待つ長さ。 |

### `boot()` がすること

1. `crossOriginIsolated` が偽なら、`OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).` で失敗します。
2. `runtime.html` の見えない iframe を作ります。属性は `allow="cross-origin-isolated"`・`aria-hidden="true"`・
   `tabIndex = -1`、スタイルは `position:absolute;width:0;height:0;border:0;visibility:hidden` で、`document.body` に
   足します（body が要ります）。
3. フレームからの `openvessel-runtime-loaded` を待ちます（ランタイムのオリジンの、そのフレームからのものだけを受けます）。
   届いたら、`MessageChannel` の片側と通信の方針をフレームに渡します。
4. ランタイムのフレームは、ホストのオリジンが自分の meta タグ `openvessel-allowed-hosts` にあること、最上位のページに
   直接埋め込まれていること、cross-origin isolated であることを確かめます。そのうえで Service Worker（`sw.js`、
   スコープ `./`）を登録し、それがページを受け持つのを待ち、カーネルの Worker（`kernel.js`）を起動します。
5. カーネルが `ready` を送ると解決します。`network` を渡していたら、解決の前に `network.setPolicy()` でもう 1 度
   設定します。

起動の途中でランタイムのフレームが知らせたエラーは、`OpenVessel: <メッセージ>` で `boot()` を失敗させます
（[エラー](#エラー)）。`timeout` までに何も届かなければ `OpenVessel: runtime did not start in time` で失敗します。
`boot()` が解決したあとにランタイムのフレームが知らせたエラーは無視されます。

### ランタイムのオリジンごとに 1 つ

ランタイムの Service Worker が持つカーネルへの接続は 1 本だけで、最後につないだランタイムのフレームのものです。
同じブラウザのプロファイルで、同じランタイムのオリジンに 2 つ目のインスタンス（同じページでもう 1 度 `boot()`、
または同じページを別のタブで）を作ると、接続をそちらが引き取ります。先のインスタンスの `node` のプロセスは ES
モジュールを読めなくなり（`Error: module … is not registered`）、通信の判定も新しいほうのカーネルがします。
ランタイムのオリジンごとに、同時に使うのは 1 つにしてください。

## ファイル — `vessel.fs`

どのメソッドもカーネルのメモリ上のファイルシステム（[ファイルシステム](filesystem.ja.md)）を相手にし、Promise を
返します。パスはいつもルートから読みます。作業ディレクトリは無く、`tmp/a` のような相対パスは `/tmp/a` の意味です。
`.` と `..` は解決し、途中のシンボリックリンクはたどります（40 段まで。それを超えると `ELOOP`）。4096 バイトを超える
パスや、255 バイトを超える要素は `ENAMETOOLONG` です。エラーは `Error` で失敗し、`code` は POSIX のコード、
`message` は errno の短い文です（例: `no such file or directory`。Node の
`ENOENT: no such file or directory, open '…'` の形ではありません）。

| メソッド | 解決する値 | カーネルの動き |
|---|---|---|
| `readFile(path)` | `Uint8Array` | ファイルのバイト列の写し。 |
| `readFile(path, 'utf8')` | `string` | バイト列を UTF-8 として読んだもの（不正な並びは U+FFFD）。真になる値なら、どの encoding も UTF-8 で読みます。 |
| `writeFile(path, data)` | `null` | 無い親ディレクトリを作り、ファイルを作るか置き換えます。 |
| `mkdir(path, { recursive })` | `string \| null` | `recursive` の既定は **true**。 |
| `readdir(path)` | `string[]` | 項目の名前。 |
| `readdir(path, { withFileTypes: true })` | `{ name, type }[]` | `type` は `'dir'`・`'symlink'`・`'file'`。 |
| `rm(path, { recursive, force })` | `null` | `recursive` なら `rm -rf`、そうでなければ `rmdir` か `unlink`。 |
| `stat(path)` | stat のオブジェクト | シンボリックリンクをたどります。 |
| `exists(path)` | `boolean` | 失敗しません。 |
| `rename(from, to)` | `null` | `rename(2)`。 |
| `watch(path, fn)` | `() => Promise<null>` | `path` の下の変更を受け取ります。 |

### `fs.readFile(path, encoding?)`

- `encoding` なし: ファイルの中身を入れた新しい `Uint8Array`（バッファは共有ではなく、移して渡します）。
- `encoding` あり（型は `'utf8'`）: 中身を UTF-8 として読んだ文字列。ほかの encoding には対応していません。
  `'latin1'` でも UTF-8 で読みます。
- シンボリックリンクはたどります。文字デバイス（`/dev/null`・`/dev/zero`・`/dev/random`・`/dev/urandom`）は空として
  読めます。
- エラー: `ENOENT`・`ENOTDIR`・`EISDIR`（ディレクトリ）・`ELOOP`・`ENAMETOOLONG`。

### `fs.writeFile(path, data)`

- `data`: `string`（UTF-8 で書く）か `Uint8Array`（写して書く）。`ArrayBuffer` も受けます。ほかの値は
  `data must be a string or Uint8Array`（`code` の無い `Error`）で失敗します。
- 無い親ディレクトリは作ります（モード `0755`）。新しいファイルのモードは `0644`。あるファイルはモード・持ち主・
  inode をそのままに、中身だけ置き換えます。
- `path` がシンボリックリンクならたどり、先が無ければ先のファイルを作ります。文字デバイス（`/dev/null`）に書くと、
  バイト列はデバイスに渡ります。
- 監視には、新しいファイル（と作った各ディレクトリ）の `rename` と、書き込みの `change` が届きます。
- エラー: `EISDIR`（ディレクトリ）・`ENOTDIR`（途中がファイル）・`EINVAL`（最後の要素が `.` か `..`）・
  `EEXIST`（`/`）・`ELOOP`・`ENAMETOOLONG`。

### `fs.mkdir(path, { recursive = true })`

- 再帰（既定）: 無い要素をすべてモード `0755` で作り、最初に作ったディレクトリで解決します。全部あれば `null` です。
  途中にディレクトリでないものがあると `ENOTDIR` です。
- `recursive: false`: ディレクトリを 1 つだけ作り、`path` で解決します。名前があれば `EEXIST`、親が無ければ
  `ENOENT` です。

### `fs.readdir(path, { withFileTypes })`

- 名前は作った順（並べ替えません）で、`.` と `..` は含みません。
- `withFileTypes: true`: `{ name: string, type: 'dir' | 'symlink' | 'file' }[]`。シンボリックリンクはたどらずに
  `'symlink'`、ディレクトリでもシンボリックリンクでもないもの（普通のファイル・文字デバイス・FIFO・ソケット）は
  すべて `'file'` です。
- `path` 自体がシンボリックリンクならたどります。エラー: `ENOENT`・`ENOTDIR`。

### `fs.rm(path, { recursive, force })`

| オプション | 動き |
|---|---|
| `recursive: true` | `path` と、その下のすべてを消します。シンボリックリンクはたどらずにリンクを消します。`path` が無いとき、`force` が true か省略なら解決し、`force: false` なら `ENOENT` で失敗します。 |
| `recursive` が省略か false | ディレクトリは空のときだけ消します（そうでなければ `ENOTEMPTY`）。ほかは unlink します。`path` が無ければ必ず `ENOENT` で失敗します（`force` は見ません）。 |

`/` 自体は消せません。`rm('/')` は `EEXIST` で失敗します。`recursive: true` だと、その下をすべて消したあとで
失敗します。

### `fs.stat(path)`

シンボリックリンクをたどり、ただのオブジェクトで解決します。

| 項目 | 値 |
|---|---|
| `dev` | `2049` |
| `ino` | inode の番号 |
| `mode` | 種類のビットと権限のビット（ホストが書いたファイルなら `0o100644`） |
| `nlink` | リンクの数 |
| `uid`・`gid` | プロセスが変えない限り `1000` |
| `rdev` | 文字デバイスならデバイスの番号、ほかは `0` |
| `size` | ファイルはバイト数、ディレクトリは `4096`、シンボリックリンクは先の長さ（`stat` はたどるのでここでは出ません） |
| `blksize` | `4096` |
| `blocks` | `ceil(size / 512)` |
| `atimeMs`・`mtimeMs`・`ctimeMs`・`birthtimeMs` | エポックからのミリ秒 |
| `isDirectory` | `boolean`（メソッドではなく値） |
| `isFile` | `boolean`（メソッドではなく値） |

エラー: `ENOENT`・`ENOTDIR`・`ELOOP`・`ENAMETOOLONG`。

### `fs.exists(path)`

`path` がたどれれば（シンボリックリンクもたどって）`true`、そうでなければ `false` です。先の無いシンボリックリンクは
`false` です。失敗はしません。

### `fs.rename(from, to)`

ファイル・シンボリックリンク・ディレクトリを移します。`to` にあるファイルは置き換えます。空のディレクトリは、
ディレクトリで置き換えられます。自分自身への rename は何もしません。エラー: `ENOENT`（`from` か `to` の親が無い）・
`EINVAL`（ディレクトリを自分の中へ）・`EISDIR`（ディレクトリでないものをディレクトリの上へ）・`ENOTEMPTY`（空でない
ディレクトリの上へ）・`ENOTDIR`（ディレクトリをディレクトリでないものの上へ）。監視には両方のパスの `rename` が
届きます。

### `fs.watch(path, fn)`

```ts
const stop = await vessel.fs.watch('/home/user/app', (ev) => console.log(ev.type, ev.path));
await stop();
```

- `fn` には、パスが `path` と同じか `path + '/'` で始まる変更ごとに `{ type: 'rename' | 'change', path: string }` が
  届きます（文字列の前方一致だけで比べます。`path` は正規化せず、無くてもかまいません）。
- 変更はどこから起きたものでも届きます。ホスト API・シェルのプログラム・npm・`node` のプロセス（開いたファイル
  記述子からの書き込みも）です。
- `rename`: ファイル・ディレクトリ・シンボリックリンク・FIFO・ソケットを作った・消した・名前を変えた（名前の変更は
  両方のパス）。`change`: 中身の書き込みや切り詰め、`chmod`、`utimes`。
- 返す関数は購読をやめ、`null` で解決します。

## `mount()`

```ts
mount(
  files: Record<string, string | Uint8Array | null | { symlink: string }>,
  opts?: { path?: string },
): Promise<number>
```

たくさんの項目をまとめて書き、処理した数で解決します。

| 値 | 結果 |
|---|---|
| `string` | その文字列（UTF-8）のファイル。 |
| `Uint8Array` | そのバイト列のファイル（`ArrayBuffer` も受けます）。 |
| `null` | ディレクトリ（`mkdir -p`）。 |
| `{ symlink: 先 }` | `先` へのシンボリックリンク（相対の先は、使うときにリンクのディレクトリから解決します）。親のディレクトリは作ります。名前がもうあれば `EEXIST`。 |

- `opts.path` の既定は `/home/user/app` で、無ければ作ります。キーは `<path>/<key>` とつなぎ、続いた `/` は 1 つに
  します。キーの先頭の `/` で絶対パスにはなりません。`..` は解決します（断りません）。
- ファイルは `fs.writeFile()` と同じに書きます（親を作り、新しいファイルは `0644`、あるファイルはモードそのまま）。
  名前が `.sh` か `.bash` で終わるファイルと、値が `#!` で始まる**文字列**のファイルは、さらに実行のビットが付きます
  （新しいファイルなら `0755`）。
- 項目はオブジェクトのキーの順に処理します。まとめて成功か失敗かにはなりません。不正な値（例えば数）があると、
  それより前の項目を書いたあとで `data must be a string or Uint8Array` で失敗します。

## `export()`

```ts
export(path: string, opts?: { exclude?: string[] }): Promise<Record<string, Uint8Array>>
```

ディレクトリの木を、相対パス（`'src/pages/index.astro'`）からファイルの中身の写しへの平らな表として読み出します。

- 入るのは普通のファイルだけです。シンボリックリンク・デバイス・FIFO・ソケット・空のディレクトリは入りません。
  `path` の下にあるシンボリックリンクのディレクトリはたどりません（`path` 自体はたどります）。
- `exclude` は、どの深さでも飛ばす項目の**名前**です（完全一致。glob やパスではありません）。既定は
  `['node_modules', '.git']` で、`exclude` を渡すと既定と置き換わります（`exclude: []` なら全部入ります）。
- エラー: `path` の `ENOENT`・`ENOTDIR`。

## プロセス

### `spawn()`

```ts
spawn(command: string, args?: string[], opts?: SpawnOptions): Promise<Process>
```

`command` を `args` 付きで起動し、プロセスができたところで [`Process`](#process) で解決します。`command` は
`execvp` と同じく探します。`/` を含まない名前は `PATH` から探し、カーネルの組み込みのプログラム（`sh`・coreutils・
`npm` など）は `/bin` に無くても見つかります。shebang のあるスクリプトはそのインタプリタで、`.js`・`.cjs`・`.mjs` は
`node` で、ほかのファイルは `sh` で動かします（[プロセス](processes.ja.md)）。

| `SpawnOptions` の項目 | 型 | 既定 | 意味 |
|---|---|---|---|
| `cwd` | `string` | `/home/user` | 作業ディレクトリ。無ければ（親も含めて）作ります。 |
| `env` | `Record<string, string>` | — | 下の既定の環境変数に足します（同じ名前は上書き）。 |
| `terminal` | `{ cols: number; rows: number }` | — | この大きさの新しい TTY で動かします（無い項目は 80 × 24）。無ければ標準入力・標準出力・標準エラーはパイプです。 |

既定の環境変数:

| 変数 | 値 |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/home/user` |
| `USER`・`LOGNAME` | `user` |
| `SHELL` | `/bin/sh` |
| `TERM` | `xterm-256color` |
| `LANG` | `en_US.UTF-8` |
| `TMPDIR` | `/tmp` |
| `HOSTNAME` | `openvessel` |
| `NAPI_RS_FORCE_WASI` | `1` |

起動したプロセスはそれぞれ自分のプロセスグループを始めます。なので `kill()` は、同じグループにいる子にも届きます。
`terminal` を付けると、そのプロセスが端末の前面のグループになります。

エラー: `ENOENT`（`<cmd>: command not found`）・`EACCES`（`<cmd>: Permission denied`。実行の権限が無い）・`ELOOP`
（shebang の入れ子が 8 段を超えた）、`cwd` を作れないときの `ENOTDIR`。

`spawn()` が解決する前に届いた出力は取っておいて `Process` に渡します。その間に終わったときも同じです。

### `Process`

| メンバー | 型 | 説明 |
|---|---|---|
| `pid` | `number` | プロセスの番号。 |
| `output` | `ReadableStream<string>` | プロセスが書いたものすべてを UTF-8 で読んだもの（続けて読むので、チャンクをまたぐ多バイト文字も崩れません）。標準出力と標準エラーは届いた順に混ざります。プロセスが終わると閉じます。チャンクは読まれるまで溜まるので、読まなければメモリに残ります。 |
| `exit` | `Promise<number>` | 終了コード（[終了コードとシグナル](#終了コードとシグナル)）。端末なしでは、プロセスが終わり、**しかも**両方の出力のパイプが終わりに達したときに解決します（パイプを握ったままの裏の子がいると遅れます）。端末ありでは、プロセスが終わったときです。 |
| `collected` | `string`（getter） | これまでの出力のすべて。2 000 000 文字を超えると、最後の 1 000 000 文字に切り詰めます。 |
| `write(data)` | `Promise<boolean>` | `string`（UTF-8）か `Uint8Array` を標準入力へ。端末なら行の規律を通ります。プロセスがもう無ければ `false`、ほかは `true` で解決します（`end()` のあとも `true` で、データは捨てます）。 |
| `end()` | `Promise<boolean>` | パイプのプロセスの標準入力を閉じます（読む側はファイルの終わりを受け取ります）。端末のプロセスでは `data must be a string or Uint8Array` で失敗します。代わりに行の先頭で `'\x04'` を書きます。 |
| `resize(cols, rows)` | `Promise<null>` | 端末の大きさを変え、その端末のプロセスに `SIGWINCH` を送ります。パイプのプロセスでは何もしません。 |
| `kill(signal = 'SIGTERM')` | `Promise<null>` | `signal` をプロセスのプロセスグループ全体に送ります。プロセスがもう無くても、いつも `null` で解決します。 |

### `exec()`

```ts
exec(commandLine: string, opts?: SpawnOptions): Promise<{ code: number; output: string }>
```

`spawn('/bin/sh', ['-c', commandLine], opts)` のあと `exit` を待ち、終了コードと `collected`（標準出力と標準エラーを
合わせたもの。上と同じ上限）で解決します。コマンドが失敗しても失敗にはしません。`code` を見てください。
`opts.terminal` を付けると、出力は端末の `\r\n` になります。

### 終了コードとシグナル

- 普通に終われば、その終了コードです。シグナルで終わったプロセスは `128 + 番号`（`SIGINT` → 130、`SIGKILL` → 137、
  `SIGTERM` → 143）で、`process-exit` のイベントにシグナルの名前が入ります。
- `kill()` は、`SIG` の有る名前・無い名前（`'SIGINT'`・`'INT'`）と番号を受けます。分かるシグナル: `SIGHUP` 1・
  `SIGINT` 2・`SIGQUIT` 3・`SIGILL` 4・`SIGTRAP` 5・`SIGABRT` 6・`SIGBUS` 7・`SIGFPE` 8・`SIGKILL` 9・`SIGUSR1` 10・
  `SIGSEGV` 11・`SIGUSR2` 12・`SIGPIPE` 13・`SIGALRM` 14・`SIGTERM` 15・`SIGCHLD` 17・`SIGCONT` 18・`SIGSTOP` 19・
  `SIGTSTP` 20・`SIGTTIN` 21・`SIGTTOU` 22・`SIGWINCH` 28。知らない名前でもプロセスは終わり、終了コードでは 15 と
  数えます（`143`）。
- 処理を登録した `node` のプロセス（`process.on('SIGINT', …)`）は、終わる代わりにシグナルを受け取ります
  （`SIGKILL` は除く）。`SIGWINCH`・`SIGCHLD`・`SIGCONT` ではプロセスは終わりません。

### `ps()`

```ts
ps(): Promise<{ pid: number; ppid: number; argv: string[]; cwd: string }[]>
```

カーネルで動いているすべてのプロセス（ホストが起動したものに限りません）と、そのいまの作業ディレクトリです。
`argv` はカーネルが実際に動かしているコマンド行です（shebang で動くスクリプトはインタプリタが見えます。例:
`['node', '/home/user/app/node_modules/.bin/astro', 'dev']`）。ホストが起動したプロセスの `ppid` は `0` です。

### `ports()`

```ts
ports(): Promise<{ port: number; pid: number }[]>
```

待ち受け中の仮想ポートと、待ち受けているプロセスです。移植した層ではすべての TCP の待ち受けが入ります。旧来の層では
HTTP のサーバーだけです（ただの `net` のサーバーは中で使うだけで、出てきません）。

## 通信の方針 — `vessel.network`

| メソッド | 解決する値 | 説明 |
|---|---|---|
| `setPolicy(policy: Partial<NetworkPolicy>)` | `NetworkPolicy` | 方針の全体を置き換えます。無い項目は、いまの値ではなく**既定の値**になります（`setPolicy({ mode: 'allowlist' })` は `presets` も既定の 4 つに戻し、`allow`・`deny` を空にします）。無いセットの名前は捨てます。整えた方針で解決します。 |
| `getPolicy()` | `NetworkPolicy` | いまの方針。 |
| `clearSession()` | `null` | 「このセッション中は」の判断（許可も拒否も）を忘れます。 |

セッション中の判断は `setPolicy()` では消えません。考え方・用意したセット・判定の順番は
[通信の方針](network-policy.ja.md) にあります。

## イベント — `on()`

```ts
on(event: 'server-ready' | 'port-closed' | 'permission-request' | 'permission-settled' | 'process-exit',
   fn: (ev: any) => void): () => void
```

リスナーを外す関数を返します。リスナーは登録した順にその場で呼ばれます。1 つが例外を投げても `console.error` に
出すだけで、ほかは呼ばれます。

| イベント | 中身 | いつ |
|---|---|---|
| `server-ready` | `{ port: number, pid: number, url: string \| null }` | プロセスが仮想ポートで待ち受けを始めたとき。移植した層ではすべての TCP の待ち受け、旧来の層では HTTP のサーバーだけです。`url` は `/` を出すプレビューの URL（`previewUrl` があるとき）で、無ければ `null`。プレビューの中継を待たずに作るので、中継が動いていることを確かめるには `previewUrl()` か `createPreview()` を使います。ポート `0` は、カーネルが選んだポート（49152〜65151）で届きます。 |
| `port-closed` | `{ port: number }` | 待ち受けが無くなったとき（サーバーが閉じた、またはそのプロセスが終わった）。 |
| `process-exit` | `{ pid: number, code: number, signal: string \| null }` | `spawn()`・`exec()` で起動したプロセスが終わったとき。それらがさらに起動したプロセスでは届きません。 |
| `permission-request` | `{ ev: 'permission-request', id: number, url: string, host: string, initiator: string, source: 'runtime' \| 'preview' }` | カーネルがホストについて尋ねたとき。リスナーは知らせを受けるだけで、答えるのは `onPermissionRequest` かダイアログです。 |
| `permission-settled` | `{ ev: 'permission-settled', id: number, host: string, allowed: boolean }` | 問い合わせが決まったとき（答えたとき、または 5 分たって打ち切られたとき）。 |

## 許可の問い合わせ

方針があるホストについて「尋ねる」と決めると（[通信の方針](network-policy.ja.md#許可の問い合わせ)）、カーネルは
ホストごとに 1 つ問い合わせを送り、ホストのページは次のようにします。

1. リスナーに `permission-request` を送ります。
2. `onPermissionRequest(req)` があれば呼び、無ければ組み込みのダイアログを出します。
3. 答えをカーネルに送ります。処理が例外を投げたり失敗したりしたら `'deny'` です。4 つのどれでもない値も、ただの拒否に
   なります。

`PermissionRequest`:

| 項目 | 説明 |
|---|---|
| `id` | 問い合わせの番号（`permission-settled` にも入ります）。 |
| `url` | 問い合わせのきっかけになった最初の要求の、完全な URL。 |
| `host` | 小文字のホスト名。ポートは含まず、IPv6 の角かっこも外します。 |
| `initiator` | 誰が求めたか。求めた側が名乗ったものです。カーネル自身の要求（`npm`・`pnpm`・`yarn`・`bun`・`curl`・`wget`）は `'npm'`、`node` のプロセスは pid とコマンド行の頭（例: `'7 node'`）、プレビューのページは `'preview'`、名乗りが無ければ `'process'`。表示のためだけのものです。 |
| `source` | `'runtime'`（プロセスかカーネル）か `'preview'`（プレビューのページ）。 |

| `PermissionDecision` | 効き目 |
|---|---|
| `'once'` | このホストへの待っている要求を許します。次はまた尋ねます。 |
| `'session'` | 許し、`clearSession()` までこのホストは尋ねずに許します。 |
| `'deny'` | 待っている要求を断ります。次はまた尋ねます。 |
| `'deny-session'` | 断り、`clearSession()` までこのホストは尋ねずに断ります。 |

処理は問い合わせごとに 1 回、並行して呼ばれます。答えない処理は、カーネルの 5 分の打ち切りで拒否になるまで
問い合わせを待たせます。そのあとに答えても効きません。

### 組み込みのダイアログ

`onPermissionRequest` を渡さないときに使います。モーダルの `<dialog>` を `document.body` に足し（インラインの
スタイル、最大幅 440 px）、答えたら取り除きます。

| 部分 | `en` | `ja` |
|---|---|---|
| 題 | `Allow network access?` | `外部への接続の確認` |
| 文（プレビュー） | `The preview page wants to connect to:` | `プレビューのページ が次のサイトへ接続しようとしています。` |
| 文（ランタイム） | `<initiator> wants to connect to:`（空なら `A process`） | `<initiator> が次のサイトへ接続しようとしています。`（空なら `プロセス`） |
| ホスト | `req.host` をコードの枠で | 同じ |
| URL | `req.url`。120 文字を超えると 117 文字 + `…` | 同じ |

ボタン（左から）:

| ボタン（`en`） | ボタン（`ja`） | 答え |
|---|---|---|
| `Deny for this session` | `このセッション中は拒否` | `'deny-session'` |
| `Deny` | `拒否` | `'deny'` |
| `Allow once` | `今回だけ許可` | `'once'` |
| `Allow for this session`（主ボタン） | `このセッション中は許可` | `'session'` |

Escape（ダイアログの `cancel` イベント）は `'deny'` です。一度に出すダイアログは 1 つで、ほかの問い合わせは
順番待ちになります。この順番待ちは、ページの中のすべてのインスタンスで共通です。カーネルの 5 分の打ち切りが先に
拒否すると、ダイアログは開いたまま残り、あとで押した答えは無視されます。

## プレビュー

### `previewUrl()`

```ts
previewUrl(port: number, path = '/'): Promise<string>
```

必要ならプレビューの中継を起動し、`<プレビューの基準>__ov/open?port=<port>&path=<encodeURIComponent(path)>` で解決
します。この URL をフレームに読み込むと、`port` のサーバーの `path` が出ます。`boot()` に `previewUrl` が無ければ
`OpenVessel: previewUrl was not configured` で失敗します。

中継は `<プレビューの基準>__ov/relay.html` の見えない iframe です（ランタイムのフレームと同じスタイル）。最初の
呼び出しで起動し、プレビューの Service Worker が登録されるのを 20 秒まで待ちます（過ぎると
`OpenVessel: preview relay did not start`）。起動に失敗すると、やり直しはしません。2 回目からは、`port` を中継の
既定のポートにして、すぐに返ります。要求がサーバーに届くしくみは [プレビュー](preview.ja.md) にあります。

### `createPreview()`

```ts
createPreview(port: number, opts?: { path?: string; container?: HTMLElement }): Promise<HTMLIFrameElement>
```

`previewUrl(port, opts.path)` を呼び、次の iframe を作ります。

| 属性 | 値 |
|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock`（`allow-top-navigation` は無いので、プレビューは自分のページを移動させられません） |
| `allow` | `clipboard-write; fullscreen` |
| `referrerpolicy` | `no-referrer` |
| `style` | `width:100%;height:100%;border:0;background:#fff` |
| `src` | `previewUrl()` の URL |

`opts.container` があればそこに足し、無ければどこにも足さずに返します。呼ぶたびに新しい iframe を作ります。
読み込み直すには `src` を設定し直します。

## `teardown()`

```ts
teardown(): void
```

ランタイムの iframe（カーネルとすべてのプロセスも一緒に終わる）と中継の iframe を外し、通り道を閉じます。プレビューの
iframe は外さず、開いている許可のダイアログも閉じません。待っている呼び出しは解決も失敗もしないままで、Service
Worker の登録も外しません。このあとインスタンスは使えません。新しく起動してください。

## エラー

カーネルとやり取りするメソッドは、カーネルの答えから作った `Error` で失敗します。`message` はカーネルのメッセージ、
`code` はそのエラーコードです（カーネルのエラーにコードが無ければ `undefined`。`TypeError` などの元のクラスは
残りません）。

| コード | 出るところ |
|---|---|
| `ENOENT` | パスが無い（`fs.*`・`export`）、`spawn()` のコマンドが無い（`<cmd>: command not found`）。 |
| `ENOTDIR` | パスの途中がディレクトリでない。ファイルに `readdir`・`export`。再帰の `mkdir`（や `writeFile`・`mount`）が、ディレクトリが要るところでファイルに当たった。 |
| `EISDIR` | ディレクトリに `readFile`・`writeFile`。ファイルをディレクトリの上へ `rename`。 |
| `EEXIST` | `recursive` なしの `mkdir` で名前がある。`mount` の `{ symlink }` の名前がある。`/` そのものを作る・消す。 |
| `ENOTEMPTY` | 空でないディレクトリに `recursive` なしの `rm`。空でないディレクトリの上へ `rename`。 |
| `EINVAL` | ディレクトリを自分の中へ `rename`。パスの最後の要素が `.` か `..`。 |
| `ELOOP` | パスを解決するのにシンボリックリンクが 40 を超えた。`spawn()` の shebang の入れ子が 8 段を超えた。 |
| `ENAMETOOLONG` | パスが 4096 バイトを、要素が 255 バイトを超えた。 |
| `EACCES` | 実行の権限が無いファイルを `spawn()`（`<cmd>: Permission denied`）。 |
| `ENOSYS` | カーネルの知らないメソッド（`unknown method <name>`）。`dist/host` と配っている `dist/runtime` の版が違うときに起きます。 |
| （なし） | `writeFile`・`mount`・`write`、端末のプロセスの `end` の `data must be a string or Uint8Array`。 |

カーネルから来ないエラー:

| メッセージ | 出すもの |
|---|---|
| `OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).` | `boot()` |
| `OpenVessel: runtime did not start in time` | `timeout` を過ぎた `boot()` |
| `OpenVessel: OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).` | `boot()`。ランタイムのフレームが isolated でない |
| `OpenVessel: origin <origin> is not allowed to use this runtime` | `boot()`。`openvessel-allowed-hosts` |
| `OpenVessel: the runtime must be embedded directly by the host page` | `boot()`。ランタイムのフレームの祖先が 2 つ以上 |
| `OpenVessel: service worker registration failed: <message>` | `boot()` |
| `OpenVessel: kernel failed: <message>` | `boot()`。カーネルの Worker が読み込めなかった |
| `OpenVessel: previewUrl was not configured` | `previewUrl()`・`createPreview()` |
| `OpenVessel: preview relay did not start` | 20 秒を過ぎた `previewUrl()`・`createPreview()` |

## 上限と待ち時間

| 値 | どこの |
|---|---|
| 30 000 ms | `boot()` の `timeout` の既定 |
| 20 000 ms | プレビューの中継の起動（固定） |
| 5 分 | 答えの無い許可の問い合わせを拒否にするまで |
| 2 000 000 / 1 000 000 文字 | `Process.collected` は 2 000 000 文字を超えると最後の 1 000 000 文字に切り詰める |
| 15 000 ms | ランタイムとプレビューの Service Worker が、カーネルへの接続を待ってから要求を失敗させるまで |
| 80 × 24 | `terminal.cols`・`rows` が無いときの端末の大きさ |

## 安定性

1.0.0 からは、ホスト API（`dist/host` と型の宣言）と、3 つのオリジンで埋め込むための条件が、セマンティック
バージョニングに従います（[CHANGELOG](../../CHANGELOG.md)）。含まないもの: `src/` の中のしくみ、`dist/runtime` と
`dist/preview` の中のファイル、部品どうしのメッセージ（[通信の形式](protocol.ja.md)）、互換パッケージの中身。
`VesselProcess` は `Process` の非推奨の別名として残っています。
