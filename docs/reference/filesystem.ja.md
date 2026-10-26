# ファイルシステム

[English](filesystem.md)

OpenVessel には、カーネルの Worker の中にある、メモリ上の POSIX 風のファイルシステムが 1 つあります
（`src/kernel/vfs.ts`）。このページでは、その inode の作り、パスの解決、権限、時刻、リンク、ファイル記述子、
特別なファイル、変更の通知、上限と、Node の `fs` とホストのページの `vessel.fs` がどう対応するかを定めます。

カーネルの起動時にあるものは [カーネル](kernel.ja.md#起動時のファイルシステム) に、ファイルシステムのシステムコールは
[システムコールの一覧](kernel.ja.md#ファイル) にあります。

## 概要

- OpenVessel のインスタンス全体で木は 1 つです。すべてのプロセスとホストのページが共有します。
- すべてカーネルの Worker の JavaScript のメモリにあります。保存はしません。ページを読み込み直すと
  [起動時の状態](kernel.ja.md#起動時のファイルシステム) から始まります。ファイルを取っておいて戻すには、ホスト API の
  `export()` と `mount()` を使います（[ホスト API](host-api.ja.md)）。（パッケージマネージャは、ダウンロードの
  キャッシュをブラウザの Cache Storage に置きます。これはファイルシステムとは別です。[パッケージマネージャ](package-managers.ja.md)）
- プロセスはシステムコールを通してだけ触れます。組み込みのプログラム（`sh`・coreutils・`npm`）とホスト API は、
  VFS を直接呼びます。
- デバイスは 1 つです。すべての inode の `dev` は 2049 です。

## inode とファイルの種類

| 項目 | 意味 |
|---|---|
| `ino` | inode の番号。1（ルート）から作った順に数える。使い回さない |
| `mode` | ファイルの種類のビットと権限のビット（`0o7777`） |
| `uid`・`gid` | いつも 1000（`user`）。[持ち主](#持ち主と権限) を参照 |
| `nlink` | 名前の数。ディレクトリは 2 + 子のディレクトリの数 |
| `atimeMs`・`mtimeMs`・`ctimeMs`・`birthtimeMs` | エポックからのミリ秒（`Date.now()`） |
| `size` | 通常のファイルの論理的な大きさ |
| `data` | 通常のファイルのバイト列（`size` より短いことがある。残りは 0 として読める穴） |
| `entries` | ディレクトリの中身（名前 → inode）。入れた順 |
| `target` | シンボリックリンクのリンク先。渡されたまま |
| `device`・`rdev` | キャラクタデバイス |
| `fifo` | FIFO の開いている端が共有するパイプ |

| 種類 | `S_IF*` | 作るもの | 既定の mode |
|---|---|---|---|
| 通常のファイル | `S_IFREG` 0o100000 | `open(O_CREAT)`・`writeFile`・`copyFile`・ホストの `writeFile`/`mount` | 求めた mode。[umask](#mode-と-umask) を参照 |
| ディレクトリ | `S_IFDIR` 0o040000 | `mkdir`・`mkdtemp` | 求めた mode。[umask](#mode-と-umask) を参照 |
| シンボリックリンク | `S_IFLNK` 0o120000 | `symlink` | 0o777 |
| キャラクタデバイス | `S_IFCHR` 0o020000 | 起動時のカーネルだけ | 0o666 |
| FIFO | `S_IFIFO` 0o010000 | `mkfifo` のプログラム | `-m` の mode、または 0o666 から umask を除いたもの |
| ソケット | `S_IFSOCK` 0o140000 | Unix ドメインソケットのパスでの `listen()` | 0o777 から umask を除いたもの |
| ブロックデバイス | `S_IFBLK` 0o060000 | —（定義だけで作らない） | |

`stat` の結果:

| 項目 | 値 |
|---|---|
| `dev` | 2049 |
| `rdev` | キャラクタデバイスはデバイスの番号、ほかは 0 |
| `size` | 通常のファイルはその大きさ、ディレクトリは 4096、シンボリックリンクはリンク先の UTF-8 の長さ、ほかは 0 |
| `blksize` | 4096 |
| `blocks` | 通常のファイルは `ceil(size / 512)`（穴も含む）。ディレクトリとシンボリックリンクは 0 |

inode の無い記述子（パイプ、socketpair の端、TTY）の `fstat` は、作った値を返します。`dev` 0、`ino` 0、`nlink` 1、
uid/gid 1000、大きさ 0、時刻はすべて「いま」で、mode は `S_IFIFO|0600`（パイプ）・`S_IFSOCK|0600`（ソケット）・
`S_IFCHR|0620`（TTY）です。

## パスの解決

1. 相対パスは、呼んだプロセスの作業ディレクトリから解決します。
2. 結果は**字面の上で**正規化します（`path.posix.normalize`/`resolve`）。`.` と `..` は探す前に取り除くので、
   `link` がどこを指していても `/a/link/..` は `/a` です。（ホスト API に渡したパスは正規化しません。そこでは `..` は
   ディレクトリの実際の親をたどります。）
3. VFS はルートから部品を 1 つずつたどります。途中のシンボリックリンクはいつもたどります。最後の部品は、`stat`・
   `open`・`readFile` などではたどり、`lstat`・`readlink`・`unlink`・`rename`・`rm`・`symlink` ではたどりません。
4. 相対のリンク先は、そのリンクのあるディレクトリの実際のパスから解決します。

| 上限・決まり | エラー |
|---|---|
| 1 回の検索で 40 個を超えるシンボリックリンクをたどった | `ELOOP` |
| パスが 4096 バイト以上（UTF-8） | `ENAMETOOLONG` |
| 部品が 255 バイトより長い | `ENAMETOOLONG` |
| 部品がディレクトリでない | `ENOTDIR` |
| ディレクトリでないものの後ろに `/` がある | `ENOTDIR` |
| 部品が無い | `ENOENT` |
| パスが空 | `ENOENT` |

## 持ち主と権限

### ユーザー

すべての inode は uid 1000、gid 1000（`user`）のもので、プロセスもそのユーザーとして動きます（`process.getuid()` は
1000）。`chown` は何も変えません。移植版ランタイムの `fs.chown`・`fs.fchown`・`fs.lchown` はパスや fd があるかを
調べるだけ、旧ランタイムでは何もせず、`chown` のプログラムも何もしません。

### 調べること

プロセスは root ではなく uid 1000 で動くので、Linux と同じく権限のビットが効きます。調べるのは node のプロセスからの
システムコールです。組み込みのプログラムとホスト API では調べません。

| 調べること | どこで | エラー |
|---|---|---|
| すでにあるファイルの読み取りの権限（`r`） | 読むための `open`、`readFile`、`copyFile`（元） | `EACCES` |
| すでにあるファイルの書き込みの権限（`w`） | 書くための、または `O_TRUNC` 付きの `open`、`writeFile`（`O_APPEND` 付きも）、`truncate`、`copyFile`（すでにある先） | `EACCES` |
| ディレクトリの読み取りの権限 | ディレクトリの `open`、`readdir`（`fs.readdir`・`fs.opendir`） | `EACCES` |
| ディレクトリの検索の権限（`x`） | `chdir` | `EACCES` |
| 項目が増える・減るディレクトリの書き込みと検索の権限（`w` と `x`） | 新しいファイルの `O_CREAT` 付きの `open`、新しいファイルの `writeFile`、新しいファイルへの `copyFile`、`mkdir`（最初の新しい項目が入るディレクトリ）、`mkdtemp`、`rmdir`、`unlink`、`rename`（元と先のディレクトリ）、`link`、`symlink` | `EACCES` |
| ファイルを実行するための実行の権限（`x`） | `spawn`・`execve`・シェル | `EACCES`（`Permission denied`） |
| `access()` の `R_OK`・`W_OK`・`X_OK` | 対応するビット。ディレクトリの `X_OK` は検索の権限 | `EACCES` |

どれも、inode の uid が 1000 なら持ち主のビット、そうでなく gid が 1000 ならグループのビット、どちらでもなければ
ほかの人のビットを見ます。実際には、いつも持ち主のビットです。Linux と同じく、ファイルの権限は開くときに調べます。
`open(O_CREAT)` で mode 0o444 で作ったファイルも、作った記述子からは書けます。開いている記述子は、あとで `chmod`
しても使えます。

調べないこと: パスの途中のディレクトリの検索の権限（調べるのは `chdir` だけ）、`chmod` と `utimes`（持ち主はいつも
できて、持ち主はいつもプロセスのユーザー）、旧ランタイムの `rm` と `cp`、`/tmp` のスティッキービット、カーネル自身が
答える `/proc` と `/dev/tty` のパス。

### mode と umask

| 操作 | できる権限のビット |
|---|---|
| ファイルを作る `open(O_CREAT)`・`writeFile` | `mode & ~umask`（mode の既定は 0o666） |
| `mkdir` | `mode & 0o1777 & ~umask`（mode の既定は 0o777） |
| `mkdtemp` | `0o700 & ~umask` |
| Unix ドメインソケット（`listen(path)`） | `0o777 & ~umask` |
| `copyFile` | 元のファイルのビットそのまま |
| `chmod`・`fchmod` | `mode & 0o7777` そのまま |
| 組み込みのプログラム（`mkdir`・`touch`・シェルのリダイレクトなど） | 上と同じ。umask はそのプログラムのもの |
| ホストの `writeFile`・`mount` | 0o644。`mount` は `*.sh`・`*.bash` と、`#!` で始まる文字列に `x` のビットを足す |
| ホストの `mkdir` | 0o755 |

umask はプロセスごとです。ホストが起動したプロセスは 0o022、それ以外は親の umask を受け継ぎます（`execve` でも
変わりません）。umask を使うのはファイル・ディレクトリ・ソケットを作るときだけなので、`umask 0` なら新しい
ディレクトリは 0o777 になります。変えるには `process.umask()`（どちらのランタイムも）か、シェルの組み込みの `umask` を
使います。後者はシェル自身のリダイレクトと、そのあとシェルが起動するプログラムに効きます。ホスト API とカーネル自身のファイルは 0o022 です。

## 時刻

時刻はすべて `Date.now()`（ミリ秒の単位）です。`birthtimeMs` は作ったときに決まり、変わりません。

| 操作 | atime | mtime | ctime | 親のディレクトリの mtime と ctime |
|---|---|---|---|---|
| ファイル・ディレクトリ・シンボリックリンク・FIFO・ソケットを作る | 設定 | 設定 | 設定 | 更新 |
| ファイル全体を書く（`writeFile`） | — | 更新 | 更新 | — |
| 記述子を通して書く | — | 更新 | 更新 | — |
| `truncate`・`ftruncate`・`open(O_TRUNC)` | — | 更新 | 更新 | — |
| ファイル全体を読む（`readFile`） | 更新 | — | — | — |
| 記述子を通して読む（バイトが返ったとき） | 更新 | — | — | — |
| `readdir`（名前だけ） | 更新（そのディレクトリ） | — | — | — |
| 種類付きの `readdir`・`opendir` | — | — | — | — |
| `unlink` | — | — | 更新 | 更新 |
| `rename` | — | — | 更新 | 更新（両方のディレクトリ） |
| `link` | — | — | 更新 | 更新 |
| `rmdir` | — | — | — | 更新 |
| `chmod` | — | — | 更新 | — |
| `utimes`・`futimes` | 渡した値 | 渡した値 | 更新 | — |
| `fchmod` | — | — | 更新 | — |

## リンク

### シンボリックリンク

- リンク先は字句どおりに記録し、調べません。行き先の無いリンクも作れます。
- `lstat().size` はリンク先の UTF-8 の長さです。
- 行き先の無いシンボリックリンクを通してファイルを作ると（`open(O_CREAT)`・`writeFile`）、リンク先ができます。
  `O_EXCL` 付きなら `EEXIST` です。
- `utimes` はリンクをたどります。移植版ランタイムの `fs.lutimes()` は、リンクそのものの時刻を変えます。
- `chmod` はリンクをたどります（`lchmod` はありません）。

### ハードリンク

`link()` は同じ inode に名前をもう 1 つ付けて `nlink` を増やし、`unlink()` は減らします。名前か開いている記述子が
1 つでも残っていれば、データは残ります。ディレクトリへのハードリンクは `EPERM` です。シンボリックリンクへの
ハードリンクは、シンボリックリンクそのものにつながります。

## ファイル記述子と open のフラグ

ファイル記述子はプロセスごとです（[プロセス](processes.ja.md#ファイル記述子と標準入出力)）。`open` は、空いている 3 以上の
最小の番号を返します。その番号がプロセスの `RLIMIT_NOFILE`（`ulimit -n`、既定は 1024）に届くときは `EMFILE` です。オープンファイル記述（位置とフラグ）は、それを指すすべての記述子が共有します。子が受け継いだもの
やほかのプロセスに渡したものも同じなので、位置も共有します。

| フラグ | 値 | ふるまい |
|---|---|---|
| `O_RDONLY` / `O_WRONLY` / `O_RDWR` | 0 / 1 / 2 | 読み書きの別。書き込み専用の fd を読む、読み取り専用の fd に書くと `EBADF` |
| `O_CREAT` | 0o100 | 無い通常のファイルを作る |
| `O_EXCL` | 0o200 | `O_CREAT` と一緒に使うと、名前があれば `EEXIST`（行き先の無いシンボリックリンクでも） |
| `O_NOCTTY` | 0o400 | 無視 |
| `O_TRUNC` | 0o1000 | 書き込みありなら、通常のファイルを 0 に切り詰める |
| `O_APPEND` | 0o2000 | 書き込みはいつもファイルの末尾へ。`write` に渡した位置は無視 |
| `O_NONBLOCK` | 0o4000 | `open` では無視 |
| `O_DIRECTORY` | 0o200000 | ディレクトリでなければ `ENOTDIR` |
| `O_NOFOLLOW` | 0o400000 | 最後の部品のシンボリックリンクをたどらない。`open` は `ELOOP` で失敗する |
| `O_SYNC` | 0o4010000 | 無視（すべて同期） |

`open` のほかの決まり:

- `O_CREAT` 無しで無いパスを開くと `ENOENT`（または `ENOTDIR`）です。
- ディレクトリは読み取り専用で開けます。読むと `EISDIR` です。書き込みありで開くと `EISDIR` です。
- FIFO を開くと、そのパイプの端が手に入ります（[特別なファイル](#特別なファイル)）。
- `/dev/tty`・`/dev/fd/N`・`/proc/self/fd/N`・`/proc/<自分の pid>/fd/N` はカーネルが扱います（[特別なファイル](#特別なファイル)）。

## 読み書き

- `read` は、求めた長さまでを返します（1 回で最大 16 MiB）。末尾またはその先から読むと 0 バイトです。
- 位置を付けた `read`/`write`（`pread`/`pwrite`）は位置を動かしません。付けなければ、位置を使って進めます。
- 末尾より先に書くと、あいだは 0 で埋まります。大きくする `truncate` は 0 として読める穴を残し、そこに書くか全体を
  読むまでメモリを使いません。
- `fsync`/`fdatasync` は、fd が開いているかを調べるだけです。
- ファイル全体を書く（`writeFile`）と、データは 1 回で入れ替わり、監視には `change` が 1 回届きます。記述子を通した
  書き込みは、1 回ごとに `change` を出します。

## ディレクトリの一覧

- 項目は入れた順、つまり名前を作った順に返ります。`rename` で入ってきた名前は末尾に付きます。すでにある名前の上に
  `rename` したときは、その名前の位置のままです。`.` と `..` は出ません。
- 種類付き（`withFileTypes`）の種類は、その項目自身のものです（シンボリックリンクはシンボリックリンクのまま）。
- 移植版ランタイムの `fs.opendir` は、開いたときの一覧の写しを取り、`bufferSize` ずつ渡します。
- `/proc` に出るのは `cpuinfo`・`meminfo`・`version` だけです。`/dev/fd` は空で、`readdir('/proc/self/fd')` は
  `ENOENT` です。

## 操作とエラー

パスを探すときのエラー（`ENOENT`・`ENOTDIR`・`ELOOP`・`ENAMETOOLONG`）と [権限の確認](#調べること) のほかに、
各操作が返すエラー:

| 操作 | エラー | 補足 |
|---|---|---|
| `mkdir` | `EEXIST`（`/` でも）・`ENOENT`（親が無い。再帰でないとき）・`ENOTDIR` | 再帰なら最初に作ったディレクトリを返す。全部あったときは `undefined` |
| `rmdir` | `ENOTDIR`・`ENOTEMPTY`・`EBUSY`（`/`） | |
| `unlink` | ディレクトリなら `EISDIR`（`/` も） | シンボリックリンクはリンクそのものを消す |
| `rename` | `EINVAL`（ディレクトリを自分の中へ）・`EISDIR`（ファイルをディレクトリの上へ）・`ENOTDIR`（ディレクトリをファイルの上へ）・`ENOTEMPTY`（空でないディレクトリの上へ）・`EBUSY`（どちらかが `/`） | すでにあるファイルや空のディレクトリは置き換える。同じ inode の名前の上への rename は何もしない |
| `link` | `EPERM`（ディレクトリ）・`EEXIST` | |
| `symlink` | `EEXIST` | |
| `readlink` | `EINVAL`（シンボリックリンクでない） | |
| `open` | `EEXIST`・`EISDIR`・`ENOTDIR`（`O_DIRECTORY`）・`ENXIO`（端末の無いときの `/dev/tty`） | |
| `read` | `EBADF`・`EISDIR` | |
| `write` | `EBADF`・`EISDIR`・`EPIPE`（読む人のいないパイプ） | |
| `writeFile` | `EEXIST`（`wx`）・`EISDIR`（`/` でも）・`ENOENT`（親が無い） | キャラクタデバイスに書くと、そのデバイスに書く |
| `truncate`・`ftruncate` | `EISDIR`。inode の無い記述子や、書き込み用に開いていない記述子の `ftruncate` は `EINVAL` | ほかの、通常のファイルでないものはそのまま |
| `copyFile` | `EISDIR`（元がディレクトリ）・`EEXIST`（`COPYFILE_EXCL`）・`ENOENT`（コピー先のディレクトリが無い） | 両側でシンボリックリンクをたどる。`COPYFILE_FICLONE*` のフラグは無視 |
| `lseek` | `ESPIPE`（通常のファイルでない）・`EINVAL`（結果が負） | |
| `fs.rm`（旧） | `force` でなければ `ENOENT`、`ERR_FS_EISDIR`（`recursive` 無しのディレクトリ） | 移植版ランタイムは、上の呼び出しの上で Node 自身の `rm`（rimraf）を動かす |
| `fs.cp` | Node の `ERR_FS_CP_*` のエラー | 移植: Node の `cpSync` の確認を、ネイティブの半分を作り直して行う。旧: カーネルの `cp` |

## 特別なファイル

| パス | 何か |
|---|---|
| `/dev/null` | 読むと何も返らず、書いたものは捨てる（rdev 0x103） |
| `/dev/zero` | 読むと 0 が返る。1 回で最大 64 KiB（rdev 0x105） |
| `/dev/random`・`/dev/urandom` | 読むと `crypto.getRandomValues` のバイトが返る。1 回で最大 64 KiB（rdev 0x108・0x109） |
| `/dev/tty` | 呼んだプロセスの制御端末。無ければ `ENXIO`。`stat` のための文字デバイス（5,0）があり、開くと呼んだプロセスの TTY が手に入る |
| `/dev/stdin`・`/dev/stdout`・`/dev/stderr` | `/proc/self/fd/0`・`1`・`2` へのシンボリックリンク |
| `/dev/fd/N`・`/proc/self/fd/N`・`/proc/<自分の pid>/fd/N` | プロセスの fd N。通常のファイルは開き直す（自分の位置、新しい open のフラグ）。パイプ・ソケット・TTY は共有する。fd N が開いていなければ `ENOENT` |
| `/proc/self` | `lstat` ではシンボリックリンク（大きさ = pid の桁数）、`readlink` は pid を返す、`stat` ではディレクトリ（mode 0o555） |
| `/proc/<自分の pid>`・`/proc/<自分の pid>/fd` | `stat` ではディレクトリ（0o555 と 0o500） |
| `readlink('/proc/self/fd/N')` | ファイルのパス・`/dev/tty`・`pipe:[id]`・`socket:[id]` |
| `/proc/cpuinfo`・`/proc/meminfo`・`/proc/version` | 起動時に書いた固定のファイル。CPU・メモリ・カーネルのバージョンは移植版ランタイムの `os` モジュールが返すものと同じ（[起動時のファイルシステム](kernel.ja.md#起動時のファイルシステム)） |
| FIFO（`mkfifo`） | 下を参照 |
| Unix ドメインソケット | `listen(path)` で作る。`open` ではつながらない（`net.connect(path)` を使う） |

ほかのプロセスの `/proc/<pid>` はありません（`ENOENT`）。`/proc` にほかのファイルもありません。キャラクタデバイスを
終わりまで読もうとすると終わりません（エンコーディング無しの `fs.readFileSync('/dev/zero')` は戻りません）。これは
Linux と同じです。`readFile` のシステムコールは、デバイスを 1 回（最大 64 KiB）だけ読みます。

### FIFO

FIFO のパイプは、どれかの端が開いているあいだだけあります。Linux と違って、`open` は待ちません。

- 書き手より先に開いた読み手は、EOF を読むのではなく、データを待ちます。
- 読み手が開く前に書いたデータは、`EPIPE` で失敗せずに、読み手のために取っておきます。
- すべての端が閉じるとパイプは無くなります。ただし、書き手が先に来て、そのデータがまだ読み手を待っているときは
  残ります。

パイプのため方と EOF の決まりは [プロセス](processes.ja.md#パイプ) にあります。

## 監視

### 変更の通知

VFS を変える操作はすべて、`{ type, path }` の通知をその場で出します。まとめたり間引いたりはしません。パスは、
操作に渡されたものです（システムコールは絶対パスで字面の上で正規化したもの、ホスト API は渡されたまま）。

| 通知 | 出すもの |
|---|---|
| `rename` | ファイル・ディレクトリ・シンボリックリンク・ハードリンク・FIFO・ソケットを作る、`unlink`、`rmdir`、`rename`（古いパスに 1 回、新しいパスに 1 回） |
| `change` | `writeFile`、記述子を通した書き込みのたびに、`truncate`/`ftruncate`/`O_TRUNC`、`chmod`、`utimes`、`fchmod`/`futimes`（記述子を開いたときのパスで） |
| 出さない | 読み取り、`chown`、キャラクタデバイスへの書き込み |

通知はパスで届くので、別の名前（シンボリックリンク、ハードリンク、シンボリックリンクのディレクトリを通した別の書き方）
で変えたときは、その名前でだけ知らされます。

### `watch` のシステムコール

`watch { id, p, recursive }` は、通知の流れに絞り込みを登録します。当てはまる通知は、呼んだスレッドへ
`{ t: 'watch', id, type, path }` として送ります。

- 監視しているパスそのもの
- `recursive` ならその下のすべてのパス（`/` の監視はすべてのパス）、無ければ直下の子

カーネルはパスがあるかを調べません。監視は `unwatch`・`execve`・プロセスの終了で終わります。

### `fs.watch`

| | 移植版ランタイム（`src/nodejs/bindings/fs_event_wrap.ts`） | 旧ランタイム（`src/node/fs.ts`） |
|---|---|---|
| パスが無い | `ENOENT`（先に stat する） | `ENOENT`（先に stat する） |
| 監視しているパスそのものの `filename` | その最後の名前 | その最後の名前 |
| 下にある項目の `filename` | 相対パス | 相対パス |
| 監視しているファイル・ディレクトリが消えた・置き換わった | `change`（ファイルだけ）・`rename`・`rename` を出して止まる（inotify と同じ） | パスで知らせ続ける |
| `recursive: true` | Linux 用の Node 自身の JavaScript の監視（`internal/fs/recursive_watch`）。再帰でない監視を組み合わせる | カーネルの再帰の絞り込み |
| `persistent: false` | そのハンドルはプロセスを生かしておかない | 同じ |

### `fs.watchFile`

| | 移植版ランタイム | 旧ランタイム |
|---|---|---|
| 見に行く間隔 | `interval` ミリ秒ごとに `stat`（Node の既定は 5007） | `min(interval, 1000)` ミリ秒ごと |
| 変わったとみなすとき | ctime・mtime・birthtime・size・mode・uid・gid・ino・dev のどれかが違う（libuv の決まり） | mtime・size・ino のどれかが違う |
| 最初の 1 回 | 基準を取るだけ | 基準を取るだけ |

### ホストの監視

`vessel.fs.watch(path, fn)` はいつも再帰です。そのパスと、その下のすべてのパスについて `fn({ type, path })` を
呼びます。[ホスト API](host-api.ja.md) を参照してください。

## 大きさとメモリ

- 割り当ての上限はありません。ファイルとディレクトリを縛るのは、ブラウザがカーネルの Worker に与えるメモリだけです。
  `ENOSPC` は返しません。
- ファイルのバッファは `max(必要な量, いまの 2 倍, 64 バイト)` まで育ちますが、必要な量より 64 MiB を超えて多くは
  取りません。
- `fs.statfs` は固定の数を返します: `type` 0xef53、`bsize` 4096、`blocks` 1048576、`bfree` 524288、`bavail` 524288、
  `files` 1048576、`ffree` 524288。
- `read` のシステムコール 1 回で返るのは最大 16 MiB です。4 MiB の通信路より大きいシステムコールのメッセージは、
  何回かに分けて渡します。

## Node の `fs` とカーネルの対応

移植版ランタイムは `internalBinding('fs')` を作り直しています（`src/nodejs/bindings/fs.ts`・`fs_dir.ts`・
`fs_event_wrap.ts`）。その上には Node 自身の `lib/fs.js` が、そのまま乗っています。バインディングの関数はどれも、
Node の 3 つの形で動きます: 同期（例外を投げる）、コールバック（`FSReqCallback`。後のターンで完了）、Promise
（`kUsePromises`）。エラーは Node の `UVException`（`ENOENT: no such file or directory, open '/x'`）になります。

| Node の API | システムコール |
|---|---|
| `access`・`exists` | `access`・`stat` |
| `open`・`fs.promises.open`（`FileHandle`） | `open` |
| `close` | `close` |
| `read`・`readv` | `read`（パイプ・TTY・ソケットでは、コールバックと Promise の形は `readOnce` で非同期に待つ） |
| `'utf8'` の `readFile` | `readFile`。fd のときや既定でないフラグのときは `open` + `read` |
| `readFile`（ほかのエンコーディング、`Buffer`） | Node がファイルを開き、`fstat` と `read` を呼ぶ |
| `write`・`writev`・`writeFile` | `write`・`writeFile` |
| `stat`・`lstat`・`fstat` | `stat`（`l`）・`fstat` |
| `statfs` | `stat` と固定の数 |
| `readdir`・`opendir` | `readdir`（種類付き） |
| `mkdir`・`mkdtemp`・`rmdir`・`unlink`・`rename`・`link`・`symlink`・`readlink`・`realpath` | 同じ名前の呼び出し |
| `rm` | Node の JavaScript の実装が `lstat`・`readdir`・`rmdir`・`unlink` を使う |
| `truncate` | Node がファイルを開いて `ftruncate` を呼ぶ |
| `ftruncate` | `ftruncate` |
| `copyFile` | `copyFile` |
| `cp` | Node の `cp` と `cpSyncCheckPaths`/`cpSyncCopyDir`/`cpSyncOverrideFile`。`stat`・`readdir`・`mkdir`・`copyFile`・`symlink`・`readlink`・`realpath`・`unlink`・`utimes` を使う |
| `chmod`・`fchmod` | `chmod`・`fchmod` |
| `chown`・`fchown`・`lchown` | `stat`/`fstat` だけ（id は無視） |
| `utimes`・`futimes`・`lutimes` | `utimes`（`lutimes` は `l` 付き）・`futimes` |
| `fsync`・`fdatasync` | `fstat` だけ |
| `watch` | `stat`・`watch`・`unwatch` |
| `watchFile` | タイマーで `stat` |

旧ランタイム（`src/node/fs.ts`）は、同じ呼び出しの上に `fs` を手で書いています。違いは次のとおりです: `rm` と `cp` は
カーネルの呼び出し 1 回（`rm`・`cp`）、`truncate` は `truncate` の呼び出しを使う、`chown`/`fchown`/`lchown`/`fsync`/
`fdatasync` は何もしない、`statfs` はパスを探さずに固定の値を返す（`type` 0x858458f6、数はすべて 1048576）。

## ホスト API の `vessel.fs`

ホストのページからの呼び出しは、権限を調べず、プロセスも通さずに、VFS を直接呼びます（`src/kernel/index.ts`）。
パスは絶対パスにしてください。相対パスは `/` からとみなします。

| ホストの呼び出し | カーネルのふるまい |
|---|---|
| `fs.readFile(path, encoding?)` | ファイル全体。`Uint8Array` の写し、`'utf8'` なら文字列。ディレクトリは `EISDIR` |
| `fs.writeFile(path, data)` | 無い親ディレクトリを作る。mode 0o644。`change`（新しければ `rename` も）を出す |
| `fs.mkdir(path, { recursive = true })` | mode 0o755。最初に作ったディレクトリか `null` を返す |
| `fs.readdir(path, { withFileTypes })` | 名前、または `{ name, type }`。`type` は `dir`・`symlink`・`file`（それ以外すべて） |
| `fs.rm(path, { recursive, force })` | `recursive` なら木ごと消す。`force: false` でなければ、無くてもかまわない。`/` は何も消さずに `EBUSY` で失敗する。そうでなければ、ディレクトリは `rmdir`（空であること）、ほかは `unlink` |
| `fs.stat(path)` | stat の項目と `isDirectory`・`isFile`（シンボリックリンクはたどる） |
| `fs.exists(path)` | パスが解決できれば `true`（シンボリックリンクはたどる） |
| `fs.rename(from, to)` | `rename` と同じ |
| `fs.watch(path, fn)` | 再帰。[ホストの監視](#ホストの監視) を参照 |
| `mount(files, { path = '/home/user/app' })` | 基準のディレクトリを作る。項目ごとに: `null` か `{ dir: true }` → ディレクトリ、`{ symlink }` → シンボリックリンク、それ以外 → ファイル（0o644。`*.sh`/`*.bash` と `#!` で始まる文字列には `x` のビットを足す）。項目の数を返す |
| `export(path, { exclude = ['node_modules', '.git'] })` | `path` の下の通常のファイルを `{ 相対パス: Uint8Array }` で返す。どの深さでも `exclude` の名前、シンボリックリンク、特別なファイルは飛ばす |
