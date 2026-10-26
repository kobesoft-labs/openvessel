# ホスト API

[English](host-api.md)

OpenVessel を埋め込むページが使う API のリファレンスです。`OpenVessel.boot()` とそのオプション、ファイル、プロセス、
ネットワークポリシー、イベント、許可リクエストと組み込みのダイアログ、プレビュー、終了処理、エラーについて説明します。
ソースは `src/host/index.ts`、型定義は `dist/types/host/index.d.ts` です。順を追った説明は
[はじめに](getting-started.ja.md) を参照してください。

## エクスポート

```ts
import OpenVessel from 'openvessel';               // 既定のエクスポート: OpenVessel のクラス
import { OpenVessel, Process, PRESETS } from 'openvessel';
import type { BootOptions, SpawnOptions, PermissionRequest, PermissionDecision, NetworkPolicy, RuntimeErrorEvent } from 'openvessel';
```

| エクスポート | 種類 | 説明 |
|---|---|---|
| `OpenVessel`（既定のエクスポートも同じ） | クラス | 埋め込んだランタイム 1 つを表します。インスタンスは `OpenVessel.boot()` でのみ作成します。 |
| `Process` | クラス | `spawn()` で起動したプロセス。利用者のコードで生成するものではありません。 |
| `VesselProcess` | クラス（別名） | `Process` の非推奨の別名（1.1.0 で改名）。 |
| `PRESETS` | オブジェクト | ネットワークポリシーの組み込みのホスト一覧。プリセット名がキーです（[ネットワークポリシー](network-policy.ja.md#プリセット)）。 |
| `BootOptions` | 型 | `boot()` のオプション。 |
| `SpawnOptions` | 型 | `spawn()` と `exec()` のオプション。 |
| `PermissionRequest` | 型 | 許可リクエストのハンドラーが受け取る値。 |
| `PermissionDecision` | 型 | `'once' \| 'session' \| 'deny' \| 'deny-session'`。 |
| `NetworkPolicy` | 型 | `{ mode, presets, allow, deny }`（[ネットワークポリシー](network-policy.ja.md#ポリシーの形)）。 |
| `RuntimeErrorEvent` | 型 | `error` イベントの内容（[イベント](#イベント--on)）。1.2.0 で追加。 |

ソースで `@internal` が付いているメンバー（`_call`・`Process._data`・`Process._exit`）は API には含まれません。

## `OpenVessel.boot()`

```ts
static boot(opts: BootOptions): Promise<OpenVessel>
```

ランタイムを埋め込み、接続済みのインスタンスで解決します。

### `BootOptions`

| オプション | 型 | 既定値 | 意味 |
|---|---|---|---|
| `runtimeUrl` | `string` | 必須 | `dist/runtime/` を配信している場所。ディレクトリ（`https://rt.example.com/`）か、`runtime.html` の URL そのものを指定します。`location.href` を基準に解決し、クエリとフラグメントは除去します。パスの最後の要素に拡張子がなければディレクトリとみなし（`https://rt.example.com/ov` は `https://rt.example.com/ov/` と同じ）、拡張子があればそのディレクトリ内のファイルとみなします。フレームはそのディレクトリの `runtime.html` を読み込みます。ページと同じオリジンの場合、`boot()` は警告 `OpenVessel: the runtime should be served from its own origin` を出力して処理を続けます。 |
| `previewUrl` | `string` | なし | `dist/preview/` を配信している場所。`runtimeUrl` と同じ規則で求めたディレクトリ（`https://pv.example.com/app` は `https://pv.example.com/app/`）がプレビューのベースになります。指定しない場合、`previewUrl()` と `createPreview()` は失敗し、`server-ready` イベントの `url` は `null` になります。 |
| `network` | `Partial<NetworkPolicy>` | `{ mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'], allow: [], deny: [] }` | 初期のネットワークポリシー。指定しなかった項目は既定値になります。 |
| `onPermissionRequest` | `(req: PermissionRequest) => PermissionDecision \| Promise<PermissionDecision>` | 組み込みのダイアログ | ポリシーで許可・拒否が決まらないホストへのリクエストに応答します（[許可リクエスト](#許可リクエスト)）。 |
| `locale` | `'ja' \| 'en'` | `navigator.language` が `ja` で始まれば `'ja'`、それ以外は `'en'` | 組み込みのダイアログの言語。 |
| `timeout` | `number`（ms） | `30000` | `boot()` がカーネルの準備完了を待つ時間。 |

### `boot()` がすること

1. `crossOriginIsolated` が偽であれば、`OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).` で失敗します。
2. `runtime.html` を読み込む非表示の iframe を作成します。属性は `allow="cross-origin-isolated"`・`aria-hidden="true"`・
   `tabIndex = -1`、スタイルは `position:absolute;width:0;height:0;border:0;visibility:hidden` で、`document.body` に
   追加します（body が存在している必要があります）。
3. フレームから `openvessel-runtime-loaded` メッセージが届くのを待ちます（ランタイムのオリジンの、そのフレームからの
   メッセージだけを受け付けます）。届いたら、`MessageChannel` の一方のポートとネットワークポリシーをフレームに渡します。
4. ランタイムのフレームは、ホストのオリジンが自身の meta タグ `openvessel-allowed-hosts` に含まれていること、トップレベルの
   ページに直接埋め込まれていること、cross-origin isolated であることを確認します。そのうえで Service Worker（`sw.js`、
   スコープ `./`）を登録し、その Service Worker がページを制御するまで待ってから、カーネルの Worker（`kernel.js`）を起動します。
5. カーネルが `ready` を送ると解決します。`network` を指定していた場合は、解決する前に `network.setPolicy()` でもう一度
   設定します。

起動中にランタイムのフレームから通知されたエラーは、`OpenVessel: <メッセージ>` として `boot()` を失敗させます
（[エラー](#エラー)）。`timeout` までに何も届かなければ、`OpenVessel: runtime did not start in time` で失敗します。
`boot()` が失敗したときは、ランタイムの iframe と、`boot()` が追加したメッセージリスナーを削除します。
`boot()` の解決後にランタイムのフレームから通知されたエラーは、`error` イベントで届きます（[イベント](#イベント--on)）。

### ランタイムのオリジンごとに 1 つ

ランタイムの Service Worker が保持するカーネルとの接続は 1 本だけで、最後に接続したランタイムのフレームのものです。
同じブラウザプロファイルで、同じランタイムのオリジンに 2 つ目のインスタンスを作ると（同じページでもう一度 `boot()` を
呼ぶ、または同じページを別のタブで開く）、接続はそちらに引き継がれます。すると先のインスタンスの `node` プロセスは
ES モジュールを読み込めなくなり（`Error: module … is not registered`）、通信の判定も新しい側のカーネルが行うようになります。
ランタイムのオリジンごとに、同時に使うインスタンスは 1 つにしてください。

## ファイル — `vessel.fs`

どのメソッドもカーネルのメモリ上のファイルシステム（[ファイルシステム](filesystem.ja.md)）を操作し、Promise を
返します。パスは常にルートから解釈します。作業ディレクトリはなく、`tmp/a` のような相対パスは `/tmp/a` を意味します。
`.` と `..` は解決し、途中のシンボリックリンクはたどります（40 段まで。超えると `ELOOP`）。4096 バイトを超えるパスや
255 バイトを超える要素は `ENAMETOOLONG` になります。エラー時は `Error` で失敗し、`code` は POSIX のエラーコード、
`message` は errno の説明文だけです（例: `no such file or directory`。Node の
`ENOENT: no such file or directory, open '…'` の形式ではありません）。

| メソッド | 解決する値 | カーネルの動作 |
|---|---|---|
| `readFile(path)` | `Uint8Array` | ファイルのバイト列のコピー。 |
| `readFile(path, 'utf8')` | `string` | バイト列を UTF-8 としてデコードした文字列（不正なバイト列は U+FFFD）。真と評価される値であれば、どの encoding を渡しても UTF-8 でデコードします。 |
| `writeFile(path, data)` | `null` | 存在しない親ディレクトリを作成してから、ファイルを作成または置き換えます。 |
| `mkdir(path, { recursive })` | `string \| null` | `recursive` の既定値は `true`。 |
| `readdir(path)` | `string[]` | エントリ名。 |
| `readdir(path, { withFileTypes: true })` | `{ name, type }[]` | `type` は `'dir'`・`'symlink'`・`'file'` のいずれか。 |
| `rm(path, { recursive, force })` | `null` | `recursive` なら `rm -rf`、そうでなければ `rmdir` か `unlink`。 |
| `stat(path)` | stat オブジェクト | シンボリックリンクをたどります。 |
| `exists(path)` | `boolean` | 失敗しません。 |
| `rename(from, to)` | `null` | `rename(2)`。 |
| `watch(path, fn)` | `() => Promise<null>` | `path` 以下の変更を購読します。 |

### `fs.readFile(path, encoding?)`

- `encoding` なし: ファイルの内容を持つ新しい `Uint8Array`（バッファは共有せず、転送して渡します）。
- `encoding` あり（型は `'utf8'`）: 内容を UTF-8 としてデコードした文字列。ほかの encoding には対応していません。
  `'latin1'` を指定しても UTF-8 でデコードします。
- シンボリックリンクはたどります。キャラクタデバイス（`/dev/null`・`/dev/zero`・`/dev/random`・`/dev/urandom`）は
  空として読めます。
- エラー: `ENOENT`・`ENOTDIR`・`EISDIR`（ディレクトリ）・`ELOOP`・`ENAMETOOLONG`。

### `fs.writeFile(path, data)`

- `data`: `string`（UTF-8 で書き込む）か `Uint8Array`（コピーして書き込む）。`ArrayBuffer` も受け付けます。それ以外の値は
  `data must be a string or Uint8Array`（`code` のない `Error`）で失敗します。
- 存在しない親ディレクトリは作成します（モード `0755`）。新しいファイルのモードは `0644` です。既存のファイルは
  モード・所有者・inode を保ったまま、内容だけを置き換えます。
- `path` がシンボリックリンクならたどり、リンク先が存在しなければリンク先のファイルを作成します。キャラクタデバイス
  （`/dev/null`）に書き込むと、バイト列はデバイスに渡されます。
- 監視には、新しいファイル（と作成した各ディレクトリ）の `rename` と、書き込みの `change` が通知されます。
- エラー: `EISDIR`（ディレクトリ）・`ENOTDIR`（途中の要素がファイル）・`EINVAL`（最後の要素が `.` か `..`）・
  `EEXIST`（`/`）・`ELOOP`・`ENAMETOOLONG`。

### `fs.mkdir(path, { recursive = true })`

- 再帰（既定）: 存在しない要素をすべてモード `0755` で作成し、最初に作成したディレクトリで解決します。すべて存在して
  いれば `null` です。途中にディレクトリ以外のものがあると `ENOTDIR` で失敗します。
- `recursive: false`: ディレクトリを 1 つだけ作成し、`path` で解決します。同じ名前が存在すれば `EEXIST`、親が存在
  しなければ `ENOENT` です。

### `fs.readdir(path, { withFileTypes })`

- 名前は作成順（ソートしません）で、`.` と `..` は含みません。
- `withFileTypes: true`: `{ name: string, type: 'dir' | 'symlink' | 'file' }[]`。シンボリックリンクはたどらずに
  `'symlink'` とし、ディレクトリでもシンボリックリンクでもないもの（通常のファイル・キャラクタデバイス・FIFO・ソケット）は
  すべて `'file'` とします。
- `path` 自体がシンボリックリンクであればたどります。エラー: `ENOENT`・`ENOTDIR`。

### `fs.rm(path, { recursive, force })`

- `recursive: true`: `path` とその下のすべてを削除します。シンボリックリンクはたどらず、リンク自体を削除します。
  `path` が存在しない場合、`force` が true か省略されていれば解決し、`force: false` なら `ENOENT` で失敗します。
- `recursive` を省略または false: ディレクトリは空の場合だけ削除し（空でなければ `ENOTEMPTY`）、それ以外は unlink します。
  `path` が存在しなければ必ず `ENOENT` で失敗します（`force` は無視します）。

`/` 自体は削除できません。`rm('/')` は `EEXIST` で失敗します。`recursive: true` の場合は、その下をすべて削除した後で
失敗します。

### `fs.stat(path)`

シンボリックリンクをたどり、プレーンなオブジェクトで解決します。

| 項目 | 値 |
|---|---|
| `dev` | `2049` |
| `ino` | inode 番号 |
| `mode` | 種類のビットとパーミッションのビット（ホストが書き込んだファイルなら `0o100644`） |
| `nlink` | リンク数 |
| `uid`・`gid` | プロセスが変更しない限り `1000` |
| `rdev` | キャラクタデバイスならデバイス番号、それ以外は `0` |
| `size` | ファイルはバイト数、ディレクトリは `4096`、シンボリックリンクはリンク先の長さ（`stat` はリンクをたどるので、ここでは現れません） |
| `blksize` | `4096` |
| `blocks` | `ceil(size / 512)` |
| `atimeMs`・`mtimeMs`・`ctimeMs`・`birthtimeMs` | エポックからのミリ秒 |
| `isDirectory` | `boolean`（メソッドではなくプロパティ） |
| `isFile` | `boolean`（メソッドではなくプロパティ） |

エラー: `ENOENT`・`ENOTDIR`・`ELOOP`・`ENAMETOOLONG`。

### `fs.exists(path)`

`path` を解決できれば（シンボリックリンクもたどります）`true`、できなければ `false` を返します。リンク先のない
シンボリックリンクは `false` です。失敗することはありません。

### `fs.rename(from, to)`

ファイル・シンボリックリンク・ディレクトリを移動します。`to` に既存のファイルがあれば置き換えます。既存の空の
ディレクトリは、ディレクトリで置き換えられます。自分自身への rename は何もしません。エラー: `ENOENT`（`from` または
`to` の親が存在しない）・`EINVAL`（ディレクトリを自分自身の中へ移動）・`EISDIR`（ディレクトリ以外をディレクトリの位置へ）・
`ENOTEMPTY`（空でないディレクトリの位置へ）・`ENOTDIR`（ディレクトリをディレクトリ以外の位置へ）。監視には両方のパスの
`rename` が通知されます。

### `fs.watch(path, fn)`

```ts
const stop = await vessel.fs.watch('/home/user/app', (ev) => console.log(ev.type, ev.path));
await stop();
```

- `fn` は、パスが `path` と一致するか `path + '/'` で始まる変更ごとに `{ type: 'rename' | 'change', path: string }` を
  受け取ります（単純な文字列の前方一致で判定します。`path` は正規化せず、存在しなくてもかまいません）。
- 変更の発生元は問いません。ホスト API、シェルのプログラム、npm、`node` プロセス（開いたファイルディスクリプタ経由の
  書き込みを含む）のどれからの変更も通知されます。
- `rename`: ファイル・ディレクトリ・シンボリックリンク・FIFO・ソケットの作成、削除、名前の変更（名前の変更では両方の
  パスが通知されます）。`change`: 内容の書き込みや切り詰め、`chmod`、`utimes`。
- 戻り値の関数を呼ぶと購読を解除し、`null` で解決します。

## `mount()`

```ts
mount(
  files: Record<string, string | Uint8Array | null | { symlink: string }>,
  opts?: { path?: string },
): Promise<number>
```

複数のエントリをまとめて書き込み、処理した件数で解決します。

| 値 | 結果 |
|---|---|
| `string` | その文字列（UTF-8）を内容とするファイル。 |
| `Uint8Array` | そのバイト列を内容とするファイル（`ArrayBuffer` も受け付けます）。 |
| `null` | ディレクトリ（`mkdir -p`）。 |
| `{ symlink: 先 }` | `先` へのシンボリックリンク（相対パスのリンク先は、使用時にリンクのあるディレクトリから解決します）。親ディレクトリは作成します。同じ名前がすでにあれば `EEXIST`。 |

- `opts.path` の既定値は `/home/user/app` で、存在しなければ作成します。各キーは `<path>/<key>` として連結し、連続した `/` は
  1 つにまとめます。そのため、キーの先頭に `/` があっても絶対パスにはなりません。`..` はエラーにせず、解決します。
- ファイルは `fs.writeFile()` と同じように書き込みます（親ディレクトリを作成し、新しいファイルは `0644`、既存のファイルは
  モードを保持）。名前が `.sh` か `.bash` で終わるファイルと、値が `#!` で始まる文字列のファイルには、さらに実行ビットが
  付きます（新しいファイルなら `0755`）。
- エントリはオブジェクトのキーの順に処理します。アトミックではありません。不正な値（たとえば数値）があると、それより
  前のエントリを書き込んだ後で `data must be a string or Uint8Array` で失敗します。

## `export()`

```ts
export(path: string, opts?: { exclude?: string[] }): Promise<Record<string, Uint8Array>>
```

ディレクトリツリーを読み出し、相対パス（`'src/pages/index.astro'`）をキー、ファイル内容のコピーを値とするフラットな
オブジェクトで返します。

- 含まれるのは通常のファイルだけです。シンボリックリンク・デバイス・FIFO・ソケット・空のディレクトリは含みません。
  `path` の下にあるディレクトリへのシンボリックリンクはたどりません（`path` 自体はたどります）。
- `exclude` には、どの階層でもスキップするエントリの名前を指定します（完全一致。glob やパスは使えません）。既定値は
  `['node_modules', '.git']` で、`exclude` を指定すると既定値は置き換えられます（`exclude: []` ならすべて含みます）。
- エラー: `path` についての `ENOENT`・`ENOTDIR`。

## プロセス

### `spawn()`

```ts
spawn(command: string, args?: string[], opts?: SpawnOptions): Promise<Process>
```

`command` を `args` 付きで起動し、プロセスが作成された時点で [`Process`](#process) で解決します。`command` は `execvp` と
同じ方法で探します。`/` を含まない名前は `PATH` から探し、カーネルに組み込まれたプログラム（`sh`・coreutils・`npm` など）は
`/bin` にエントリがなくても見つかります。shebang のあるスクリプトはそのインタプリタで、`.js`・`.cjs`・`.mjs` のファイルは
`node` で、それ以外のファイルは `sh` で実行します（[プロセス](processes.ja.md)）。

| `SpawnOptions` の項目 | 型 | 既定値 | 意味 |
|---|---|---|---|
| `cwd` | `string` | `/home/user` | 作業ディレクトリ。存在しなければ（親も含めて）作成します。 |
| `env` | `Record<string, string>` | — | 下記の既定の環境変数に追加します（同じ名前は上書き）。 |
| `terminal` | `{ cols: number; rows: number }` | — | このサイズの新しい TTY 上で実行します（指定のない項目は 80 × 24）。指定しない場合、標準入力・標準出力・標準エラーはパイプになります。 |

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
| `NAPI_RS_FORCE_WASI` | `true` |

起動したプロセスはそれぞれ新しいプロセスグループを作るので、`kill()` は同じグループに残っている子プロセスにも届きます。
`terminal` を指定すると、そのプロセスが端末のフォアグラウンドのグループになります。

エラー: `ENOENT`（`<cmd>: command not found`）・`EACCES`（`<cmd>: Permission denied`。ファイルに実行権限がない）・`ELOOP`
（shebang の入れ子が 8 段を超えた）、および `cwd` を作成できないときの `ENOTDIR`。

`spawn()` が解決する前に届いた出力は保持され、`Process` に渡されます。その間にプロセスが終了した場合も同様です。

### `Process`

| メンバー | 型 | 説明 |
|---|---|---|
| `pid` | `number` | プロセス ID。 |
| `output` | `ReadableStream<string>` | プロセスが書き出したすべての内容を UTF-8 でデコードしたもの（ストリームとしてデコードするので、チャンクをまたぐマルチバイト文字も崩れません。末尾に不完全なバイト列が残れば U+FFFD になります）。標準出力と標準エラーは届いた順にまとめて流れます。プロセスが終了すると閉じます。チャンクは読まれるまでキューに溜まるので、読まなければメモリに残り続けます。 |
| `exit` | `Promise<number>` | 終了コード（[終了コードとシグナル](#終了コードとシグナル)）。端末なしの場合は、プロセスが終了し、かつ両方の出力パイプが EOF に達したときに解決します（パイプを握ったままのバックグラウンドの子プロセスがあると遅れます）。端末ありの場合は、プロセスが終了したときに解決します。先にカーネルが失われた場合（`teardown()`、致命的な [`error`](#error-イベント)）は `137` で解決します。 |
| `collected` | `string`（getter） | これまでの出力のすべて。2 000 000 文字を超えると、末尾の 1 000 000 文字に切り詰めます。 |
| `write(data)` | `Promise<boolean>` | `string`（UTF-8）か `Uint8Array` を標準入力に書き込みます。端末の場合はラインディシプリンを経由します。プロセスがすでになければ `false`、それ以外は `true` で解決します（`end()` の後も `true` ですが、データは破棄されます）。 |
| `end()` | `Promise<boolean>` | 入力を終了します。パイプのプロセスでは標準入力を閉じます（読み手は EOF を受け取り、以降の書き込みは破棄されます）。端末のプロセスでは、Ctrl-D を押したときと同じく EOF 文字 `^D` をラインディシプリンに送ります。行頭であれば読み手は EOF を受け取ります。入力途中の行がある場合はまずその行が渡され、もう一度 `end()` を呼ぶと EOF になります。raw モードではプログラムがバイト `0x04` を読みます。端末はその後も使えます。プロセスがすでになければ `false` で解決します。（1.2.0 より前は、端末のプロセスでは失敗していました。） |
| `resize(cols, rows)` | `Promise<null>` | 端末のサイズを変更し、その端末上のプロセスに `SIGWINCH` を送ります。パイプのプロセスでは何もしません。 |
| `kill(signal = 'SIGTERM')` | `Promise<null>` | `signal` をプロセスのプロセスグループ全体に送ります。プロセスがすでになくても、常に `null` で解決します。 |

### `exec()`

```ts
exec(commandLine: string, opts?: SpawnOptions): Promise<{ code: number; output: string }>
```

`spawn('/bin/sh', ['-c', commandLine], opts)` を実行して `exit` を待ち、終了コードと `collected`（標準出力と標準エラーを
まとめたもの。上限は上記と同じ）で解決します。コマンドが失敗しても reject はしないので、`code` を確認してください。
`opts.terminal` を指定すると、出力の改行は端末の `\r\n` になります。

### 終了コードとシグナル

- 正常に終了した場合は、その終了コードになります。シグナルで終了したプロセスは `128 + n`（`SIGINT` → 130、
  `SIGKILL` → 137、`SIGTERM` → 143）になり、`process-exit` イベントにシグナル名が入ります。
- `kill()` は、`SIG` の付いた名前と付かない名前（`'SIGINT'`・`'INT'`）、および番号を受け付けます。対応しているシグナル:
  `SIGHUP` 1・`SIGINT` 2・`SIGQUIT` 3・`SIGILL` 4・`SIGTRAP` 5・`SIGABRT` 6・`SIGBUS` 7・`SIGFPE` 8・`SIGKILL` 9・
  `SIGUSR1` 10・`SIGSEGV` 11・`SIGUSR2` 12・`SIGPIPE` 13・`SIGALRM` 14・`SIGTERM` 15・`SIGCHLD` 17・`SIGCONT` 18・
  `SIGSTOP` 19・`SIGTSTP` 20・`SIGTTIN` 21・`SIGTTOU` 22・`SIGWINCH` 28。知らない名前でもプロセスは終了し、終了コードでは
  15 として扱います（`143`）。
- ハンドラーを登録した `node` プロセス（`process.on('SIGINT', …)`）は、終了せずにシグナルを受け取ります（`SIGKILL` を除く）。
  `SIGWINCH`・`SIGCHLD`・`SIGCONT` ではプロセスは終了しません。

### `ps()`

```ts
ps(): Promise<{ pid: number; ppid: number; argv: string[]; cwd: string }[]>
```

カーネルで動いているすべてのプロセス（ホストが起動したものに限りません）と、それぞれの現在の作業ディレクトリを
返します。`argv` はカーネルが実際に実行しているコマンドラインです（shebang 経由で動いているスクリプトでは
インタプリタが見えます。例: `['node', '/home/user/app/node_modules/.bin/astro', 'dev']`）。ホストが起動したプロセスの
`ppid` は `0` です。

### `ports()`

```ts
ports(): Promise<{ port: number; pid: number }[]>
```

待ち受け中の仮想ポートと、待ち受けているプロセスを返します。移植版ランタイムではすべての TCP の待ち受けが含まれます。
旧ランタイムでは HTTP サーバーだけが含まれます（素の `net` サーバーは内部で扱うだけで、ここには現れません）。

## ネットワークポリシー — `vessel.network`

| メソッド | 解決する値 | 説明 |
|---|---|---|
| `setPolicy(policy: Partial<NetworkPolicy>)` | `NetworkPolicy` | ポリシー全体を置き換えます。指定しなかった項目は、現在の値ではなく既定値になります（`setPolicy({ mode: 'allowlist' })` は `presets` も既定の 4 つに戻し、`allow`・`deny` を空にします）。存在しないプリセット名は無視します。正規化したポリシーで解決します。 |
| `getPolicy()` | `NetworkPolicy` | 現在のポリシー。 |
| `clearSession()` | `null` | 「このセッション中は」の判断（許可・拒否とも）をクリアします。 |

セッション中の判断は `setPolicy()` では消えません。ポリシーの考え方、プリセット、判定の順序は
[ネットワークポリシー](network-policy.ja.md) で説明しています。

## イベント — `on()`

```ts
on(event: 'error', fn: (ev: RuntimeErrorEvent) => void): () => void
on(event: 'server-ready' | 'port-closed' | 'permission-request' | 'permission-settled' | 'process-exit' | 'error',
   fn: (ev: any) => void): () => void
```

リスナーを解除する関数を返します。リスナーは登録順に同期的に呼ばれます。どれかが例外を投げても `console.error` に
出力するだけで、残りのリスナーは呼ばれます。

| イベント | 内容 | 発生するとき |
|---|---|---|
| `server-ready` | `{ port: number, pid: number, url: string \| null }` | プロセスが仮想ポートで待ち受けを始めたとき。移植版ランタイムではすべての TCP の待ち受け、旧ランタイムでは HTTP サーバーだけが対象です。`url` は `/` を表示するプレビューの URL（`previewUrl` を設定している場合）で、設定していなければ `null` です。`previewUrl` を設定していると、プレビューの中継が動いていなければ起動し、中継の起動後にイベントを発生させるので、`url` はすぐに読み込めます。中継の起動に失敗した場合（最長 20 秒）もイベントは発生し、失敗は致命的でない `error` で通知され、次の `previewUrl()`・`createPreview()` で起動を再試行します。`server-ready` と `port-closed` の順序は保たれます。ポート `0` は、カーネルが選んだポート（49152〜65151）として通知されます。 |
| `port-closed` | `{ port: number }` | 待ち受けがなくなったとき（サーバーが閉じた、またはそのプロセスが終了した）。 |
| `process-exit` | `{ pid: number, code: number, signal: string \| null }` | `spawn()`・`exec()` で起動したプロセスが終了したとき。それらのプロセスがさらに起動したプロセスでは発生しません。 |
| `permission-request` | `{ ev: 'permission-request', id: number, url: string, host: string, initiator: string, source: 'runtime' \| 'preview' }` | カーネルがホストへの接続の許可を求めたとき。リスナーは通知を受けるだけで、応答するのは `onPermissionRequest` かダイアログです。 |
| `permission-settled` | `{ ev: 'permission-settled', id: number, host: string, allowed: boolean, decision: 'once' \| 'session' \| 'deny' \| 'deny-session' \| 'timeout' }` | 許可リクエストの結果が決まったとき。`decision` は応答の内容で、5 分以内に誰も応答しなかった場合は `'timeout'`（このとき `allowed` は `false`）になります。4 つの決定のいずれでもない応答は `'deny'` として届きます。`decision` は 1.2.0 で追加。 |
| `error` | `RuntimeErrorEvent`: `{ error: Error, message: string, fatal: boolean }` | 1.2.0 で追加。API 呼び出しとは関係なく何かが失敗したとき（[下記](#error-イベント)）。`error` のリスナーが 1 つもなければ、`console.error` に出力します。 |

### `error` イベント

このイベントは次の 3 つの場合に発生します。

- `boot()` の後にランタイムのフレームがエラーを通知した（カーネルの Worker で捕捉されなかったエラー）: `message` は
  `OpenVessel: kernel failed: <message>`、`fatal` は `false` です。Worker は捕捉されないエラーの後も動き続けるため、
  ホストはカーネルがまだ応答するかを確認します。10 秒以内に応答がなければ、同じエラーを `fatal: true` でもう一度通知します。
- ランタイムのフレームが再度読み込まれた（リロードされた、またはドキュメント内で移動された。iframe は移動すると
  再読み込みされます）: `message` は `OpenVessel: the runtime frame was reloaded; the kernel is gone`、`fatal` は `true` です。
- `server-ready` イベントのためにプレビューの中継を起動できなかった: `message` は `OpenVessel: preview relay did not start`、
  `fatal` は `false` です。

致命的なエラーの場合、イベントリスナーを残すことを除いて [`teardown()`](#teardown) と同じようにインスタンスを停止します。
応答待ちの呼び出しとその後のすべての呼び出しはそのエラーで失敗し、実行中のプロセスは終了し（`exit` は `137` で解決し、
`process-exit` が `signal: 'SIGKILL'` で発生します）、ランタイムと中継の iframe は削除されます。続けて使うには、
新しいインスタンスを起動してください。

## 許可リクエスト

ポリシーがあるホストについて「確認する」と判定すると（[ネットワークポリシー](network-policy.ja.md#許可リクエスト)）、
カーネルはホストごとに 1 つのリクエストを送り、ホストページは次の処理を行います。

1. リスナーに `permission-request` を通知します。
2. `onPermissionRequest(req)` が指定されていれば呼び、なければ組み込みのダイアログを表示します。
3. 決定をカーネルに送ります。ハンドラーが例外を投げたり reject したりした場合は `'deny'` として扱います。4 つの決定の
   いずれでもない値も、通常の拒否になります。

`PermissionRequest`:

| 項目 | 説明 |
|---|---|
| `id` | リクエストの ID（`permission-settled` にも含まれます）。 |
| `url` | このリクエストのきっかけになった最初の通信の完全な URL。 |
| `host` | 小文字のホスト名。ポートは含まず、IPv6 の角かっこも除きます。 |
| `initiator` | 接続しようとしている主体で、リクエスト元が申告した値です。カーネル自身のリクエスト（`npm`・`pnpm`・`yarn`・`bun`・`curl`・`wget`）は `'npm'`、`node` プロセスは pid とコマンドラインの先頭（例: `'7 node'`）、プレビューのページは `'preview'`、申告がなければ `'process'` です。表示用の情報で、判定には使いません。 |
| `source` | `'runtime'`（プロセスかカーネル）か `'preview'`（プレビューのページ）。 |

| `PermissionDecision` | 効果 |
|---|---|
| `'once'` | このホストへの待機中のリクエストを許可します。次のリクエストでは再度確認します。 |
| `'session'` | 許可し、`clearSession()` まではこのホストを確認なしで許可します。 |
| `'deny'` | 待機中のリクエストを拒否します。次のリクエストでは再度確認します。 |
| `'deny-session'` | 拒否し、`clearSession()` まではこのホストを確認なしで拒否します。 |

ハンドラーはリクエストごとに 1 回、並行して呼ばれます。応答しないハンドラーは、カーネルの 5 分のタイムアウトで拒否される
までリクエストを待たせます。タイムアウト後に応答しても効果はありません。

### 組み込みのダイアログ

`onPermissionRequest` を指定しない場合に使われます。モーダルの `<dialog>` を `document.body` に追加し（インライン
スタイル、最大幅 440 px）、応答後に削除します。

| 部分 | `en` | `ja` |
|---|---|---|
| タイトル | `Allow network access?` | `外部への接続の確認` |
| 本文（プレビュー） | `The preview page wants to connect to:` | `プレビューのページ が次のサイトへ接続しようとしています。` |
| 本文（ランタイム） | `<initiator> wants to connect to:`（空なら `A process`） | `<initiator> が次のサイトへ接続しようとしています。`（空なら `プロセス`） |
| ホスト | `req.host` をコードブロックで表示 | 同じ |
| URL | `req.url`。120 文字を超える場合は 117 文字 + `…` | 同じ |

ボタン（左から順に）:

| ボタン（`en`） | ボタン（`ja`） | 決定 |
|---|---|---|
| `Deny for this session` | `このセッション中は拒否` | `'deny-session'` |
| `Deny` | `拒否` | `'deny'` |
| `Allow once` | `今回だけ許可` | `'once'` |
| `Allow for this session`（プライマリ） | `このセッション中は許可` | `'session'` |

Escape キー（ダイアログの `cancel` イベント）は `'deny'` になります。一度に表示するダイアログは 1 つだけで、ほかの
リクエストはキューで待機します。このキューはページ内のすべてのインスタンスで共有されます。ダイアログを経由せずに
リクエストの結果が決まった場合（カーネルの 5 分のタイムアウトで拒否された場合）は、`permission-settled` によって
そのダイアログを閉じるかキューから取り除き、次のダイアログを表示します。`teardown()` も、そのインスタンスのダイアログを
同じように処理します。

## プレビュー

### `previewUrl()`

```ts
previewUrl(port: number, path = '/'): Promise<string>
```

必要に応じてプレビューの中継を起動し、`<プレビューのベース>__ov/open?port=<port>&path=<encodeURIComponent(path)>` で
解決します。この URL をフレームに読み込むと、`port` のサーバーの `path` が表示されます。`boot()` に `previewUrl` を
指定していなければ `OpenVessel: previewUrl was not configured` で失敗します。

中継は `<プレビューのベース>__ov/relay.html` を読み込む非表示の iframe です（スタイルはランタイムのフレームと同じ）。
最初の呼び出し（または最初の `server-ready` イベント）で起動し、プレビューの Service Worker が登録されるまで最大 20 秒
待ちます（間に合わなければ `OpenVessel: preview relay did not start`）。起動に失敗すると iframe を削除し、次の呼び出しで
もう一度起動します。2 回目以降の呼び出しは、`port` を中継の既定のポートにしてすぐに返ります。中継の起動中に呼んだ場合は、
起動の完了を待ちます。リクエストがサーバーに届く仕組みは [プレビュー](preview.ja.md) で説明しています。

### `createPreview()`

```ts
createPreview(port: number, opts?: { path?: string; container?: HTMLElement }): Promise<HTMLIFrameElement>
```

`previewUrl(port, opts.path)` を呼び、次の属性を持つ iframe を作成します。

| 属性 | 値 |
|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock`（`allow-top-navigation` を含まないので、プレビューからホストページを遷移させることはできません） |
| `allow` | `clipboard-write; fullscreen` |
| `referrerpolicy` | `no-referrer` |
| `style` | `width:100%;height:100%;border:0;background:#fff` |
| `src` | `previewUrl()` が返した URL |

`opts.container` を指定すればそこに追加し、指定しなければどこにも追加せずに返します。呼ぶたびに新しい iframe を作成します。
再読み込みするには `src` を設定し直してください。

## `teardown()`

```ts
teardown(): void
```

ランタイムの iframe（カーネルとすべてのプロセスもこれとともに終了します）と中継の iframe を削除し、通信チャネルを閉じ、
インスタンスのメッセージリスナーとイベントリスナーを解除します。応答待ちの呼び出しとその後のすべての呼び出しは
`OpenVessel: the instance was torn down` で失敗します。実行中のプロセスは終了し（`exit` は `137` で解決し、リスナーを
解除する前に `process-exit` が `signal: 'SIGKILL'` で発生します）、そのインスタンスの組み込みの許可ダイアログは閉じます。
プレビューの iframe と Service Worker の登録は削除しません。終了処理の後はインスタンスを使えないので、新しいインスタンスを
起動してください。

## エラー

カーネルと通信するメソッドは、カーネルの応答から作った `Error` で失敗します。`message` はカーネルのメッセージ、`code` は
そのエラーコードです（カーネルのエラーにコードがなければ `undefined`。`TypeError` などの元のエラークラスは保持されません）。

| コード | 発生する場面 |
|---|---|
| `ENOENT` | パスが存在しない（`fs.*`・`export`）。`spawn()` のコマンドが見つからない（`<cmd>: command not found`）。 |
| `ENOTDIR` | パスの途中の要素がディレクトリでない。ファイルに対する `readdir`・`export`。再帰的な `mkdir`（または `writeFile`・`mount`）で、ディレクトリが必要な位置にファイルがあった。 |
| `EISDIR` | ディレクトリに対する `readFile`・`writeFile`。ファイルをディレクトリの位置へ `rename`。 |
| `EEXIST` | `recursive` なしの `mkdir` で同じ名前が存在する。`mount` の `{ symlink }` のエントリで同じ名前が存在する。`/` 自体の作成・削除。 |
| `ENOTEMPTY` | 空でないディレクトリに対する `recursive` なしの `rm`。空でないディレクトリの位置へ `rename`。 |
| `EINVAL` | ディレクトリを自分自身の中へ `rename`。パスの最後の要素が `.` か `..`。 |
| `ELOOP` | パスの解決でシンボリックリンクが 40 を超えた。`spawn()` で shebang の入れ子が 8 段を超えた。 |
| `ENAMETOOLONG` | パスが 4096 バイトを超えた、または要素が 255 バイトを超えた。 |
| `EACCES` | 実行権限のないファイルを `spawn()` した（`<cmd>: Permission denied`）。 |
| `ENOSYS` | カーネルが知らないメソッド（`unknown method <name>`）。`dist/host` とデプロイした `dist/runtime` のバージョンが異なるときに起きます。 |
| （なし） | `writeFile`・`mount`・`write` の `data must be a string or Uint8Array`。 |

カーネル以外から発生するエラー:

| メッセージ | 発生元 |
|---|---|
| `OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).` | `boot()` |
| `OpenVessel: runtime did not start in time` | `timeout` を過ぎたときの `boot()` |
| `OpenVessel: OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).` | `boot()`。ランタイムのフレームが isolated でない |
| `OpenVessel: origin <origin> is not allowed to use this runtime` | `boot()`。`openvessel-allowed-hosts` による拒否 |
| `OpenVessel: the runtime must be embedded directly by the host page` | `boot()`。ランタイムのフレームの祖先が 2 つ以上ある |
| `OpenVessel: service worker registration failed: <message>` | `boot()` |
| `OpenVessel: kernel failed: <message>` | `boot()`。カーネルの Worker を読み込めなかった。起動後は `error` イベントで通知され、致命的になった後はすべての呼び出し |
| `OpenVessel: previewUrl was not configured` | `previewUrl()`・`createPreview()` |
| `OpenVessel: preview relay did not start` | 20 秒を過ぎたときの `previewUrl()`・`createPreview()`。`server-ready` が中継を起動した場合は `error` イベント |
| `OpenVessel: the runtime frame was reloaded; the kernel is gone` | `error` イベント（致命的）と、その後のすべての呼び出し |
| `OpenVessel: the instance was torn down` | `teardown()` の時点で応答待ちだった呼び出しと、その後のすべての呼び出し |

## 上限と待ち時間

| 値 | 対象 |
|---|---|
| 30 000 ms | `boot()` の `timeout` の既定値 |
| 20 000 ms | プレビューの中継の起動（固定） |
| 10 000 ms | 致命的でないカーネルのエラーの後、この時間内にカーネルが応答しなければ致命的なエラーになる |
| 5 分 | 応答のない許可リクエストを拒否するまでの時間 |
| 2 000 000 / 1 000 000 文字 | `Process.collected` は 2 000 000 文字を超えると末尾の 1 000 000 文字に切り詰める |
| 15 000 ms | ランタイムとプレビューの Service Worker が、リクエストを失敗させるまでカーネルとの接続を待つ時間 |
| 80 × 24 | `terminal.cols`・`rows` が指定されていないときの端末のサイズ |

## 安定性

1.0.0 以降、ホスト API（`dist/host` とその型定義）と、3 つのオリジンで埋め込むための要件はセマンティックバージョニングに
従います（[CHANGELOG](../../CHANGELOG.md)）。対象外なのは、`src/` の内部実装、`dist/runtime` と `dist/preview` の中の
ファイル、各部品間のメッセージ（[通信プロトコル](protocol.ja.md)）、互換パッケージの中身です。`VesselProcess` は
`Process` の非推奨の別名として残しています。
