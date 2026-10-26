# ファイルシステム

[English](filesystem.md)

OpenVessel には、カーネルの Worker の中で動く、メモリ上の POSIX 風のファイルシステムが 1 つあります
（`src/kernel/vfs.ts`）。このページでは、inode のモデル、パスの解決、権限、タイムスタンプ、リンク、ファイル記述子、
特殊ファイル、変更の通知、上限について説明し、Node の `fs` とホストページの `vessel.fs` がこれにどう対応するかを示します。

カーネルの起動時に存在するファイルは [カーネル](kernel.ja.md#起動時のファイルシステム) に、ファイルシステム関連の
システムコールは [システムコールの一覧](kernel.ja.md#ファイル) にあります。

## 概要

- OpenVessel のインスタンス全体でツリーは 1 つだけで、すべてのプロセスとホストページが共有します。
- データはすべてカーネルの Worker の JavaScript メモリ上にあり、永続化はしません。ページを再読み込みすると
  [起動時の状態](kernel.ja.md#起動時のファイルシステム) に戻ります。ファイルを保存して復元するには、ホスト API の
  `export()` と `mount()` を使います（[ホスト API](host-api.ja.md)）。（パッケージマネージャはダウンロードのキャッシュを
  ブラウザの Cache Storage に保存しますが、これはファイルシステムとは別のものです。[パッケージマネージャ](package-managers.ja.md)
  を参照してください。）
- プロセスがアクセスできるのはシステムコール経由だけです。組み込みプログラム（`sh`、coreutils、`npm`）とホスト API は
  VFS を直接呼び出します。
- デバイスは 1 つだけなので、すべての inode の `dev` は 2049 です。

## inode とファイルの種類

| 項目 | 意味 |
|---|---|
| `ino` | inode 番号。1（ルート）から作成順に数える。再利用しない |
| `mode` | ファイルの種類のビットと権限のビット（`0o7777`） |
| `uid`・`gid` | 常に 1000（`user`）。[所有者](#持ち主と権限) を参照 |
| `nlink` | 名前の数。ディレクトリは 2 + サブディレクトリの数 |
| `atimeMs`・`mtimeMs`・`ctimeMs`・`birthtimeMs` | エポックからのミリ秒（`Date.now()`） |
| `size` | 通常ファイルの論理サイズ |
| `data` | 通常ファイルのバイト列（`size` より短いことがあり、残りは 0 として読めるホール） |
| `entries` | ディレクトリのエントリ（名前 → inode）。追加した順 |
| `target` | シンボリックリンクのリンク先。指定されたとおりに保存する |
| `device`・`rdev` | キャラクタデバイス |
| `fifo` | FIFO の開いている端が共有するパイプ |

| 種類 | `S_IF*` | 作成元 | デフォルトの mode |
|---|---|---|---|
| 通常ファイル | `S_IFREG` 0o100000 | `open(O_CREAT)`・`writeFile`・`copyFile`・ホストの `writeFile`/`mount` | 指定した mode（[umask](#mode-と-umask) を参照） |
| ディレクトリ | `S_IFDIR` 0o040000 | `mkdir`・`mkdtemp` | 指定した mode（[umask](#mode-と-umask) を参照） |
| シンボリックリンク | `S_IFLNK` 0o120000 | `symlink` | 0o777 |
| キャラクタデバイス | `S_IFCHR` 0o020000 | 起動時のカーネルのみ | 0o666 |
| FIFO | `S_IFIFO` 0o010000 | `mkfifo` コマンド | `-m` の mode、または 0o666 から umask を除いたもの |
| ソケット | `S_IFSOCK` 0o140000 | Unix ドメインソケットのパスでの `listen()` | 0o777 から umask を除いたもの |
| ブロックデバイス | `S_IFBLK` 0o060000 | —（定義のみで作成しない） | |

`stat` は次の値を返します。

| 項目 | 値 |
|---|---|
| `dev` | 2049 |
| `rdev` | キャラクタデバイスはデバイス番号、それ以外は 0 |
| `size` | 通常ファイルはそのサイズ、ディレクトリは 4096、シンボリックリンクはリンク先の UTF-8 での長さ、それ以外は 0 |
| `blksize` | 4096 |
| `blocks` | 通常ファイルは `ceil(size / 512)`（ホールを含む）。ディレクトリとシンボリックリンクは 0 |

inode を持たない記述子（パイプ、socketpair の端、TTY）の `fstat` は、合成した値を返します。`dev` 0、`ino` 0、`nlink` 1、
uid/gid 1000、サイズ 0、時刻はすべて現在時刻で、mode はパイプなら `S_IFIFO|0600`、ソケットなら `S_IFSOCK|0600`、TTY
なら `S_IFCHR|0620` です。

## パスの解決

1. 相対パスは、呼び出したプロセスの作業ディレクトリを基準に解決します。
2. 結果は字句的に正規化します（`path.posix.normalize`/`resolve`）。`.` と `..` は検索の前に取り除くので、`link` が
   どこを指していても `/a/link/..` は `/a` になります。（ホスト API に渡したパスは正規化せず、`..` はディレクトリの
   実際の親をたどります。）
3. VFS はルートからパスの要素を順にたどります。途中にあるシンボリックリンクは常にたどります。最後の要素は、`stat`・
   `open`・`readFile` などではたどり、`lstat`・`readlink`・`unlink`・`rename`・`rm`・`symlink` ではたどりません。
4. 相対パスのリンク先は、そのリンクがあるディレクトリの実パスを基準に解決します。

| 上限・ルール | エラー |
|---|---|
| 1 回の検索で 40 個を超えるシンボリックリンクをたどった | `ELOOP` |
| パスが 4096 バイト以上（UTF-8） | `ENAMETOOLONG` |
| 要素が 255 バイトより長い | `ENAMETOOLONG` |
| 要素がディレクトリでない | `ENOTDIR` |
| ディレクトリでないものの末尾に `/` がある | `ENOTDIR` |
| 要素が存在しない | `ENOENT` |
| パスが空 | `ENOENT` |

## 持ち主と権限

### ユーザー

すべての inode は uid 1000、gid 1000（`user`）の所有で、プロセスもそのユーザーとして動きます（`process.getuid()` は
1000）。`chown` は何も変更しません。移植版ランタイムの `fs.chown`・`fs.fchown`・`fs.lchown` はパスや fd が存在するかを
確認するだけで、旧ランタイムでは何もせず、`chown` コマンドも何もしません。

### 調べること

プロセスは root ではなく uid 1000 で動くので、Linux と同じく権限のビットが適用されます。権限を確認するのは node の
プロセスからのシステムコールだけで、組み込みプログラムとホスト API では確認しません。

| 確認する権限 | 対象 | エラー |
|---|---|---|
| 既存ファイルの読み取り権限（`r`） | 読み取りの `open`、`readFile`、`copyFile`（コピー元） | `EACCES` |
| 既存ファイルの書き込み権限（`w`） | 書き込みまたは `O_TRUNC` 付きの `open`、`writeFile`（`O_APPEND` 付きも含む）、`truncate`、`copyFile`（既存のコピー先） | `EACCES` |
| ディレクトリの読み取り権限 | ディレクトリの `open`、`readdir`（`fs.readdir`・`fs.opendir`） | `EACCES` |
| ディレクトリの検索権限（`x`） | `chdir` | `EACCES` |
| エントリが増減するディレクトリの書き込み権限と検索権限（`w` と `x`） | 新規ファイルに対する `O_CREAT` 付きの `open`、新規ファイルの `writeFile`、新規ファイルへの `copyFile`、`mkdir`（最初の新しいエントリが作られるディレクトリ）、`mkdtemp`、`rmdir`、`unlink`、`rename`（移動元と移動先のディレクトリ）、`link`、`symlink` | `EACCES` |
| ファイルを実行するための実行権限（`x`） | `spawn`・`execve`・シェル | `EACCES`（`Permission denied`） |
| `access()` の `R_OK`・`W_OK`・`X_OK` | 対応するビット（ディレクトリの `X_OK` は検索権限） | `EACCES` |

どの確認でも、inode の uid が 1000 なら所有者のビット、そうでなく gid が 1000 ならグループのビット、どちらでもなければ
その他のビットを使います。実際には常に所有者のビットです。Linux と同じく、ファイルの権限は開くときに確認します。
`open(O_CREAT)` に mode 0o444 を指定して作ったファイルも、作成した記述子からは書き込めます。開いている記述子は、後で
`chmod` しても引き続き使えます。

次のものは確認しません。パスの途中にあるディレクトリの検索権限（確認するのは `chdir` だけ）、`chmod` と `utimes`（所有者は
常に実行でき、所有者は常にプロセスのユーザー）、旧ランタイムの `rm` と `cp`、`/tmp` のスティッキービット、カーネル自身が
処理する `/proc` と `/dev/tty` のパスです。

### mode と umask

| 操作 | 結果の権限ビット |
|---|---|
| ファイルを作成する `open(O_CREAT)`・`writeFile` | `mode & ~umask`（mode のデフォルトは 0o666） |
| `mkdir` | `mode & 0o1777 & ~umask`（mode のデフォルトは 0o777） |
| `mkdtemp` | `0o700 & ~umask` |
| Unix ドメインソケット（`listen(path)`） | `0o777 & ~umask` |
| `copyFile` | コピー元のビットをそのまま |
| `chmod`・`fchmod` | `mode & 0o7777` をそのまま |
| 組み込みプログラム（`mkdir`・`touch`・シェルのリダイレクトなど） | 上と同じ。umask はそのプログラムのもの |
| ホストの `writeFile`・`mount` | 0o644（`mount` は `*.sh`・`*.bash` と、`#!` で始まる文字列に `x` ビットを追加する） |
| ホストの `mkdir` | 0o755 |

umask はプロセスごとに持ちます。ホストが起動したプロセスは 0o022 で、それ以外は親の umask のコピーです（`execve` の
後も同じです）。umask はファイル、ディレクトリ、ソケットを作成するときにだけ適用するので、`umask 0` なら新しい
ディレクトリは 0o777 になります。変更するには `process.umask()`（どちらのランタイムでも使えます）か、シェルの組み込み
コマンド `umask` を使います。後者はシェル自身のリダイレクトと、その後シェルが起動するプログラムに適用されます。
ホスト API とカーネル自身のファイルは 0o022 を使います。

## 時刻

時刻はすべて `Date.now()`（ミリ秒単位）から取ります。`birthtimeMs` は作成時に設定し、その後は変わりません。

| 操作 | atime | mtime | ctime | 親ディレクトリの mtime と ctime |
|---|---|---|---|---|
| ファイル・ディレクトリ・シンボリックリンク・FIFO・ソケットを作成 | 設定 | 設定 | 設定 | 更新 |
| ファイル全体を書き込む（`writeFile`） | — | 更新 | 更新 | — |
| 記述子経由で書き込む | — | 更新 | 更新 | — |
| `truncate`・`ftruncate`・`open(O_TRUNC)` | — | 更新 | 更新 | — |
| ファイル全体を読み込む（`readFile`） | 更新 | — | — | — |
| 記述子経由で読み込む（バイトが返ったとき） | 更新 | — | — | — |
| `readdir`（名前のみ） | 更新（そのディレクトリ） | — | — | — |
| 種類付きの `readdir`・`opendir` | — | — | — | — |
| `unlink` | — | — | 更新 | 更新 |
| `rename` | — | — | 更新 | 更新（両方のディレクトリ） |
| `link` | — | — | 更新 | 更新 |
| `rmdir` | — | — | — | 更新 |
| `chmod` | — | — | 更新 | — |
| `utimes`・`futimes` | 指定した値 | 指定した値 | 更新 | — |
| `fchmod` | — | — | 更新 | — |

## リンク

### シンボリックリンク

- リンク先は指定されたとおりに保存し、確認はしません。リンク切れのリンクも作れます。
- `lstat().size` はリンク先の UTF-8 での長さです。
- リンク切れのシンボリックリンクを通してファイルを作成すると（`open(O_CREAT)`・`writeFile`）、リンク先が作られます。
  `O_EXCL` を付けた場合は `EEXIST` で失敗します。
- `utimes` はリンクをたどります。移植版ランタイムの `fs.lutimes()` は、リンク自体の時刻を変更します。
- `chmod` はリンクをたどります（`lchmod` はありません）。

### ハードリンク

`link()` は同じ inode に別の名前を追加して `nlink` を増やし、`unlink()` は減らします。名前か開いている記述子が 1 つでも
残っていれば、データにはアクセスできます。ディレクトリへのハードリンクは `EPERM` で失敗します。シンボリックリンクへの
ハードリンクは、シンボリックリンク自体へのリンクになります。

## ファイル記述子と open のフラグ

ファイル記述子はプロセスごとに持ちます（[プロセス](processes.ja.md#ファイル記述子と標準入出力)）。`open` は空いている
3 以上の最小の番号を返します。その番号がプロセスの `RLIMIT_NOFILE`（`ulimit -n`、デフォルトは 1024）に達する場合は
`EMFILE` で失敗します。オープンファイル記述（オフセットとフラグ）は、それを指すすべての記述子で共有します。子プロセスが
継承したものや他のプロセスに渡したものも含むので、オフセットも共有されます。

| フラグ | 値 | 動作 |
|---|---|---|
| `O_RDONLY` / `O_WRONLY` / `O_RDWR` | 0 / 1 / 2 | アクセスモード。書き込み専用の fd から読む、または読み取り専用の fd に書くと `EBADF` |
| `O_CREAT` | 0o100 | 存在しない通常ファイルを作成する |
| `O_EXCL` | 0o200 | `O_CREAT` と併用すると、名前が存在する場合（リンク切れのシンボリックリンクも含む）に `EEXIST` |
| `O_NOCTTY` | 0o400 | 無視 |
| `O_TRUNC` | 0o1000 | 書き込みアクセスがあれば、通常ファイルをサイズ 0 に切り詰める |
| `O_APPEND` | 0o2000 | 書き込みは常にファイルの末尾に行い、`write` に渡した位置は無視する |
| `O_NONBLOCK` | 0o4000 | `open` では無視 |
| `O_DIRECTORY` | 0o200000 | パスがディレクトリでなければ `ENOTDIR` |
| `O_NOFOLLOW` | 0o400000 | 最後の要素のシンボリックリンクをたどらず、`open` は `ELOOP` で失敗する |
| `O_SYNC` | 0o4010000 | 無視（すべて同期的に処理する） |

`open` には、ほかに次のルールがあります。

- `O_CREAT` なしで存在しないパスを開くと `ENOENT`（または `ENOTDIR`）になります。
- ディレクトリは読み取り専用で開けますが、読み込むと `EISDIR` になります。書き込みアクセスで開くと `EISDIR` になります。
- FIFO を開くと、そのパイプの端を取得します（[特殊ファイル](#特別なファイル) を参照）。
- `/dev/tty`・`/dev/fd/N`・`/proc/self/fd/N`・`/proc/<自分の pid>/fd/N` はカーネルが処理します（[特殊ファイル](#特別なファイル) を参照）。

## 読み書き

- `read` は要求した長さまでを返します（1 回あたり最大 16 MiB）。末尾以降から読むと 0 バイトが返ります。
- 位置を指定した `read`/`write`（`pread`/`pwrite`）はオフセットを動かしません。位置を指定しない場合は、オフセットを
  使って進めます。
- 末尾より先に書き込むと、その間は 0 で埋まります。サイズを大きくする `truncate` は 0 として読めるホールを残し、そこに
  書き込むかファイル全体を読み込むまで、そのためのメモリは使いません。
- `fsync`/`fdatasync` は、fd が開いているかを確認するだけです。
- ファイル全体の書き込み（`writeFile`）はデータを一度に置き換え、監視側には `change` イベントが 1 回届きます。記述子経由の
  書き込みは、書き込みのたびに `change` イベントを発生させます。

## ディレクトリの一覧

- エントリは追加した順、つまり名前を作成した順に返ります。`rename` で移ってきた名前は末尾に追加され、既存の名前に
  `rename` した場合はその名前の位置のままです。`.` と `..` は含みません。
- 種類付き（`withFileTypes`）の場合、各エントリの種類はそのエントリ自体の種類です（シンボリックリンクはシンボリック
  リンクのまま）。
- 移植版ランタイムの `fs.opendir` は、開いた時点の一覧のスナップショットを取り、`bufferSize` 件ずつ返します。
- `/proc` に表示されるのは `cpuinfo`・`meminfo`・`version` だけです。`/dev/fd` は空で、`readdir('/proc/self/fd')` は
  `ENOENT` で失敗します。

## 操作とエラー

パスの検索で起きるエラー（`ENOENT`・`ENOTDIR`・`ELOOP`・`ENAMETOOLONG`）と [権限の確認](#調べること) のほかに、
各操作が返すエラーは次のとおりです。

| 操作 | エラー | 補足 |
|---|---|---|
| `mkdir` | `EEXIST`（`/` の場合も）・`ENOENT`（親がなく、再帰でない場合）・`ENOTDIR` | 再帰の場合は最初に作成したディレクトリを返し、すべて存在していたときは `undefined` |
| `rmdir` | `ENOTDIR`・`ENOTEMPTY`・`EBUSY`（`/`） | |
| `unlink` | ディレクトリなら `EISDIR`（`/` も） | シンボリックリンクはリンク自体を削除する |
| `rename` | `EINVAL`（ディレクトリを自分自身の中へ）・`EISDIR`（ファイルをディレクトリの上へ）・`ENOTDIR`（ディレクトリをファイルの上へ）・`ENOTEMPTY`（空でないディレクトリの上へ）・`EBUSY`（どちらかが `/`） | 既存のファイルや空のディレクトリは置き換える。同じ inode を指す名前への rename は何もしない |
| `link` | `EPERM`（ディレクトリ）・`EEXIST` | |
| `symlink` | `EEXIST` | |
| `readlink` | `EINVAL`（シンボリックリンクでない） | |
| `open` | `EEXIST`・`EISDIR`・`ENOTDIR`（`O_DIRECTORY`）・`ENXIO`（端末がないときの `/dev/tty`） | |
| `read` | `EBADF`・`EISDIR` | |
| `write` | `EBADF`・`EISDIR`・`EPIPE`（読み手のいないパイプ） | |
| `writeFile` | `EEXIST`（`wx`）・`EISDIR`（`/` の場合も）・`ENOENT`（親がない） | キャラクタデバイスに書き込むと、そのデバイスに書き込む |
| `truncate`・`ftruncate` | `EISDIR`。inode を持たない記述子や、書き込み用に開いていない記述子の `ftruncate` は `EINVAL` | 通常ファイル以外のものは変更しない |
| `copyFile` | `EISDIR`（コピー元がディレクトリ）・`EEXIST`（`COPYFILE_EXCL`）・`ENOENT`（コピー先のディレクトリがない） | 両側でシンボリックリンクをたどる。`COPYFILE_FICLONE*` フラグは無視 |
| `lseek` | `ESPIPE`（通常ファイルでない）・`EINVAL`（結果が負） | |
| `fs.rm`（旧ランタイム） | `force` でなければ `ENOENT`、`ERR_FS_EISDIR`（`recursive` なしのディレクトリ） | 移植版ランタイムでは、上の呼び出しを使って Node 自身の `rm`（rimraf）を実行する |
| `fs.cp` | Node の `ERR_FS_CP_*` エラー | 移植版ランタイム: ネイティブ部分を実装し直したうえで Node の `cpSync` のチェックを行う。旧ランタイム: カーネルの `cp` |

## 特別なファイル

| パス | 内容 |
|---|---|
| `/dev/null` | 読み込むと何も返らず、書き込んだものは捨てる（rdev 0x103） |
| `/dev/zero` | 読み込むと 0 が返る。1 回あたり最大 64 KiB（rdev 0x105） |
| `/dev/random`・`/dev/urandom` | 読み込むと `crypto.getRandomValues` のバイトが返る。1 回あたり最大 64 KiB（rdev 0x108・0x109） |
| `/dev/tty` | 呼び出したプロセスの制御端末。なければ `ENXIO`。`stat` 用にキャラクタデバイスのノード（5,0）があり、開くと呼び出したプロセスの TTY を取得する |
| `/dev/stdin`・`/dev/stdout`・`/dev/stderr` | `/proc/self/fd/0`・`1`・`2` へのシンボリックリンク |
| `/dev/fd/N`・`/proc/self/fd/N`・`/proc/<自分の pid>/fd/N` | プロセスの fd N。通常ファイルは開き直し（独自のオフセット、新しい open のフラグ）、パイプ・ソケット・TTY は共有する。fd N が開いていなければ `ENOENT` |
| `/proc/self` | `lstat` ではシンボリックリンク（サイズは pid の桁数）で、`readlink` は pid を返す。`stat` ではディレクトリ（mode 0o555） |
| `/proc/<自分の pid>`・`/proc/<自分の pid>/fd` | `stat` ではディレクトリ（0o555 と 0o500） |
| `readlink('/proc/self/fd/N')` | ファイルのパス・`/dev/tty`・`pipe:[id]`・`socket:[id]` |
| `/proc/cpuinfo`・`/proc/meminfo`・`/proc/version` | 起動時に書き込む静的なファイル。CPU、メモリ、カーネルのバージョンは、移植版ランタイムの `os` モジュールが返すものと同じ（[起動時のファイルシステム](kernel.ja.md#起動時のファイルシステム)） |
| FIFO（`mkfifo`） | 下記を参照 |
| Unix ドメインソケット | `listen(path)` で作成する。`open` では接続しない（`net.connect(path)` を使う） |

他のプロセスの `/proc/<pid>` は存在せず（`ENOENT`）、`/proc` にはそれ以外のファイルもありません。キャラクタデバイスを
末尾まで読もうとすると終わりません（エンコーディングを指定しない `fs.readFileSync('/dev/zero')` は戻りません）。これは
Linux と同じ動作です。`readFile` システムコールは、デバイスを 1 回（最大 64 KiB）だけ読み込みます。

### FIFO

FIFO のパイプは、いずれかの端が開いている間だけ存在します。Linux と異なり、`open` がブロックすることはありません。

- 書き手より先に開いた読み手は、EOF を読むのではなく、データが来るのを待ちます。
- 読み手が開く前に書き込んだデータは、`EPIPE` で失敗せず、読み手のために保持します。
- すべての端が閉じるとパイプは破棄します。ただし、書き手が先に開いていて、そのデータがまだ読み手を待っている場合は
  残します。

パイプのバッファリングと EOF のルールは [プロセス](processes.ja.md#パイプ) にあります。

## 監視

### 変更の通知

VFS を変更する操作はすべて、`{ type, path }` のイベントを同期的に発生させます。デバウンスやまとめての通知はしません。
イベントのパスは操作に渡されたパスです（システムコールでは字句的に正規化した絶対パス、ホスト API では渡されたとおり）。

| イベント | 発生させる操作 |
|---|---|
| `rename` | ファイル・ディレクトリ・シンボリックリンク・ハードリンク・FIFO・ソケットの作成、`unlink`、`rmdir`、`rename`（古いパスと新しいパスに 1 回ずつ） |
| `change` | `writeFile`、記述子経由の書き込み（書き込みのたび）、`truncate`/`ftruncate`/`O_TRUNC`、`chmod`、`utimes`、`fchmod`/`futimes`（記述子を開いたときのパスで） |
| なし | 読み込み、`chown`、キャラクタデバイスへの書き込み |

イベントはパスで通知するので、別の名前（シンボリックリンク、ハードリンク、シンボリックリンクのディレクトリを経由した
別の表記）で変更した場合は、その名前でだけ通知されます。

### `watch` のシステムコール

`watch { id, p, recursive }` は、イベントのストリームにフィルターを登録します。一致したイベントは、呼び出したスレッドに
`{ t: 'watch', id, type, path }` として送ります。一致するのは、パスが次のいずれかの場合です。

- 監視しているパスそのもの
- `recursive` ならその下のすべてのパス（`/` を監視するとすべてのパス）、`recursive` でなければ直下の子

カーネルはパスが存在するかを確認しません。監視は `unwatch`、`execve`、プロセスの終了で終わります。

### `fs.watch`

| | 移植版ランタイム（`src/nodejs/bindings/fs_event_wrap.ts`） | 旧ランタイム（`src/node/fs.ts`） |
|---|---|---|
| パスが存在しない | `ENOENT`（先に stat する） | `ENOENT`（先に stat する） |
| 監視しているパス自体の `filename` | そのベース名 | そのベース名 |
| 下にあるエントリの `filename` | 相対パス | 相対パス |
| 監視しているファイル・ディレクトリが削除された、または置き換えられた | `change`（ファイルのみ）・`rename`・`rename` を通知して停止する（inotify と同じ） | パスで通知し続ける |
| `recursive: true` | Linux 向けの Node 自身の JavaScript 実装（`internal/fs/recursive_watch`）。再帰でない監視を組み合わせる | カーネルの再帰フィルター |
| `persistent: false` | そのハンドルはプロセスを存続させない | 同じ |

### `fs.watchFile`

移植版ランタイムは `interval` ミリ秒ごと（Node のデフォルトは 5007）に `stat` を呼び、ctime・mtime・birthtime・size・mode・
uid・gid・ino・dev のいずれかが異なれば変更とみなします（libuv のルール）。旧ランタイムは `min(interval, 1000)` ミリ秒
ごとにポーリングし、mtime・size・ino のいずれかが異なれば変更とみなします。どちらのランタイムでも、最初のポーリングは
基準値を記録するだけです。

### ホストの監視

`vessel.fs.watch(path, fn)` は常に再帰的です。そのパスと、その下のすべてのパスについて `fn({ type, path })` を
呼び出します。[ホスト API](host-api.ja.md) を参照してください。

## 大きさとメモリ

- 容量の制限（クォータ）はありません。ファイルとディレクトリを制限するのは、ブラウザがカーネルの Worker に割り当てる
  メモリだけで、`ENOSPC` を返すことはありません。
- ファイルのバッファは `max(必要な量, 現在の 2 倍, 64 バイト)` まで拡張しますが、必要な量を 64 MiB 以上超えて確保する
  ことはありません。
- `fs.statfs` は固定の値を返します。`type` 0xef53、`bsize` 4096、`blocks` 1048576、`bfree` 524288、`bavail` 524288、
  `files` 1048576、`ffree` 524288 です。
- `read` システムコール 1 回で返るのは最大 16 MiB です。4 MiB のチャネルより大きいシステムコールのメッセージは、
  複数回に分けて渡します。

## Node の `fs` とカーネルの対応

移植版ランタイムは `internalBinding('fs')` を実装し直しており（`src/nodejs/bindings/fs.ts`・`fs_dir.ts`・
`fs_event_wrap.ts`）、その上で Node 自身の `lib/fs.js` を変更せずに動かしています。バインディングの関数はどれも、Node の
3 つの形式で動きます。同期（例外を投げる）、コールバック（`FSReqCallback`。後のターンで完了）、Promise（`kUsePromises`）
です。エラーは Node の `UVException`（`ENOENT: no such file or directory, open '/x'`）になります。

| Node の API | システムコール |
|---|---|
| `access`・`exists` | `access`・`stat` |
| `open`・`fs.promises.open`（`FileHandle`） | `open` |
| `close` | `close` |
| `read`・`readv` | `read`（パイプ・TTY・ソケットでは、コールバックと Promise の形式は `readOnce` で非同期に待つ） |
| `'utf8'` の `readFile` | `readFile`。fd の場合やデフォルト以外のフラグの場合は `open` + `read` |
| `readFile`（その他のエンコーディング、`Buffer`） | Node がファイルを開き、`fstat` と `read` を呼ぶ |
| `write`・`writev`・`writeFile` | `write`・`writeFile` |
| `stat`・`lstat`・`fstat` | `stat`（`l`）・`fstat` |
| `statfs` | `stat` と固定の値 |
| `readdir`・`opendir` | `readdir`（種類付き） |
| `mkdir`・`mkdtemp`・`rmdir`・`unlink`・`rename`・`link`・`symlink`・`readlink`・`realpath` | 同じ名前の呼び出し |
| `rm` | Node の JavaScript 実装が `lstat`・`readdir`・`rmdir`・`unlink` を使う |
| `truncate` | Node がファイルを開いて `ftruncate` を呼ぶ |
| `ftruncate` | `ftruncate` |
| `copyFile` | `copyFile` |
| `cp` | Node の `cp` と `cpSyncCheckPaths`/`cpSyncCopyDir`/`cpSyncOverrideFile`。`stat`・`readdir`・`mkdir`・`copyFile`・`symlink`・`readlink`・`realpath`・`unlink`・`utimes` を使う |
| `chmod`・`fchmod` | `chmod`・`fchmod` |
| `chown`・`fchown`・`lchown` | `stat`/`fstat` のみ（id は無視） |
| `utimes`・`futimes`・`lutimes` | `utimes`（`lutimes` は `l` 付き）・`futimes` |
| `fsync`・`fdatasync` | `fstat` のみ |
| `watch` | `stat`・`watch`・`unwatch` |
| `watchFile` | タイマーで `stat` |

旧ランタイム（`src/node/fs.ts`）は、同じ呼び出しを使って `fs` を独自に実装しています。違いは次のとおりです。`rm` と
`cp` はカーネルの呼び出し 1 回（`rm`・`cp`）で処理し、`truncate` は `truncate` の呼び出しを使います。
`chown`/`fchown`/`lchown`/`fsync`/`fdatasync` は何もしません。`statfs` はパスを検索せずに固定の値を返します
（`type` 0x858458f6、件数はすべて 1048576）。

## ホスト API の `vessel.fs`

ホストページからの呼び出しは、権限の確認をせず、プロセスも経由せずに VFS を直接呼び出します（`src/kernel/index.ts`）。
パスは絶対パスで指定してください。相対パスは `/` を基準にします。

| ホストの呼び出し | カーネルの動作 |
|---|---|
| `fs.readFile(path, encoding?)` | ファイル全体を、`Uint8Array` のコピー、または `'utf8'` なら文字列で返す。ディレクトリは `EISDIR` |
| `fs.writeFile(path, data)` | 存在しない親ディレクトリを作成する。mode 0o644。`change`（新規なら `rename` も）イベントを発生させる |
| `fs.mkdir(path, { recursive = true })` | mode 0o755。最初に作成したディレクトリか `null` を返す |
| `fs.readdir(path, { withFileTypes })` | 名前、または `{ name, type }`。`type` は `dir`・`symlink`・`file`（それ以外すべて） |
| `fs.rm(path, { recursive, force })` | `recursive` ならツリーごと削除する。`force: false` でなければ、存在しなくてもエラーにしない。`/` は何も削除せずに `EBUSY` で失敗する。`recursive` でなければ、ディレクトリは `rmdir`（空であること）、それ以外は `unlink` |
| `fs.stat(path)` | stat の項目と `isDirectory`・`isFile`（シンボリックリンクはたどる） |
| `fs.exists(path)` | パスが解決できれば `true`（シンボリックリンクはたどる） |
| `fs.rename(from, to)` | `rename` と同じ |
| `fs.watch(path, fn)` | 再帰的（[ホストの監視](#ホストの監視) を参照） |
| `mount(files, { path = '/home/user/app' })` | 基準のディレクトリを作成する。各エントリは、`null` か `{ dir: true }` → ディレクトリ、`{ symlink }` → シンボリックリンク、それ以外 → ファイル（0o644。`*.sh`/`*.bash` と `#!` で始まる文字列には `x` ビットを追加）。エントリ数を返す |
| `export(path, { exclude = ['node_modules', '.git'] })` | `path` の下の通常ファイルを `{ 相対パス: Uint8Array }` で返す。どの深さでも `exclude` に含まれる名前、シンボリックリンク、特殊ファイルは除く |
