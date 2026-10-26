# カーネル

[English](kernel.md)

カーネルは OpenVessel の「OS」にあたるもので、1 つの Web Worker がファイルシステム、プロセステーブル、パイプ、端末、
ソケット、仮想ポート、外部ネットワークとの通信を担当します。このページでは、カーネルの構成要素、スレッドモデル、
システムコールの一覧、仮想ネットワーク、外部への HTTP の中継、ES モジュールの配信、組み込みプログラム、起動時の
ファイルシステムを説明します。

ファイルシステムとプロセスについては、それぞれ [ファイルシステム](filesystem.ja.md) と [プロセス](processes.ja.md) の
ページがあります。全体の概要は [OpenVessel の仕組み](../how-it-works.ja.md) を参照してください。

## 役割

| 分野 | カーネルの処理 | ソース |
|---|---|---|
| ファイルシステム | メモリ上の VFS。inode・パーミッション・タイムスタンプ・シンボリックリンク・ハードリンク・FIFO・ソケット・変更イベント | `src/kernel/vfs.ts` |
| プロセス | pid・プロセスグループ・argv/env/cwd・ファイル記述子・終了状態・シグナル・`execve` | `src/kernel/kernel.ts`、`src/kernel/proc.ts` |
| 入出力 | オープンファイル記述・パイプ・socketpair・TTY のライン規律 | `src/kernel/io.ts` |
| システムコール | node のスレッドからの同期呼び出しと、非同期メッセージ | `src/kernel/syscalls.ts` |
| 仮想ネットワーク | TCP のポート・Unix ドメインソケット・UDP のポート・プレビューからの HTTP/WebSocket | `src/kernel/net.ts`、`src/kernel/tcp.ts` |
| 外部への通信 | raw ソケットで外部のホストへ送る HTTP/1.1 を、ネットワークポリシーを通して送信する | `src/kernel/outbound.ts` |
| ES モジュール | VFS のファイルを、ブラウザの ES モジュールとしてプロセスの Worker に配信する | `src/kernel/esm.ts` |
| プログラム | `sh`・coreutils・`npm`/`pnpm`/`yarn`/`bun`・`curl`/`wget`。カーネルの中で動く | `src/kernel/sh/`、`src/kernel/coreutils.ts`、`src/kernel/npm/`、`src/kernel/curl.ts` |
| ホストとの通信 | 埋め込み側のページが使う API（[ホスト API](host-api.ja.md)・[通信の形式](protocol.ja.md)） | `src/kernel/index.ts` |
| ネットワークポリシー | リクエストを外部に送ってよいかを判定する（[ネットワークポリシー](network-policy.ja.md)） | `src/kernel/index.ts`、`src/shared/policy.ts` |

`src/kernel/base.ts` には `RUNTIME_BASE` という定数が 1 つだけあります。カーネルのスクリプトを読み込んだディレクトリの
URL（末尾の `/` なし）で、ランタイムの Service Worker はこの下の `/__ov/…` へのリクエストに応答します。

## スレッドモデル

### Worker

| Worker | 作成元 | 名前 | 実行内容 |
|---|---|---|---|
| カーネル | ランタイムの iframe（`src/runtime/runtime.ts`） | `openvessel-kernel` | `dist/runtime/kernel.js`。VFS・プロセスの表・すべての組み込みプログラム（`sh`・coreutils・`npm` など） |
| プロセスのメインスレッド | カーネル | `node:<pid>:<tid>`（ウォームプールから取り出したものは `node (idle)`） | `node` のプロセス 1 つ分の Node.js ランタイム |
| ワーカースレッド | プロセスの要求に応じてカーネルが作成（`worker_threads`） | メインスレッドと同じ | 同じプロセスの中のもう 1 つの Node.js ランタイム（pid も fd の表も同じ） |

組み込みプログラムは Worker ではなく、カーネル自身のイベントループ上で動く `async` 関数です（`queueMicrotask` で
開始します）。入力や子プロセスを待つ間は制御をカーネルに戻すので、カーネルはその間もほかのプロセスの処理を続けます。

### Worker のウォームプール

プロセスの起動時間の大半は、ランタイムのスクリプトの読み込みとコンパイルにかかります。そのためカーネルは、待機状態の
プロセス用 Worker をあらかじめ用意しておきます（`src/kernel/index.ts`）。

- ランタイムのスクリプトの URL ごとに `WARM = 2` 個を用意します。
- ある URL のプールは、その URL を使うプロセスが最初に起動したときに作成します。Worker を 1 つ取り出すたびに
  （`setTimeout(…, 0)` で）補充します。
- 待機中の Worker は、`init` メッセージを受け取るまで何もしません。プールが空のときは、その場で新しく作成します。
- ワーカースレッドも、メインスレッドと同じプール（そのプロセスのランタイムのプール）から取り出します。

### Node.js ランタイムの選択

ビルドには 2 つの Node.js ランタイムが含まれています。

| ランタイム | スクリプト | ソース | 使われるとき |
|---|---|---|---|
| 移植版ランタイム | `dist/runtime/node-process.js` | `src/nodejs/`（Node 自身の `lib/` と、TypeScript で書いた `internalBinding()`） | 既定 |
| 旧ランタイム | `dist/runtime/process.js` | `src/node/`（Node 互換の機能を独自に実装したもの） | VFS のファイル `/etc/openvessel/node` の中身が `legacy` のとき |

カーネルは node のプログラムが起動するたびに（新しいプロセスの起動時と `execve` のとき）`/etc/openvessel/node` を読み、
前後の空白を除いた内容で判定して、選んだランタイムをプロセスに記録します。プロセスのワーカースレッドは、実行中に
ファイルが変わっても、常にメインスレッドと同じランタイムを使います。内容がそれ以外のとき（移植版ランタイムが既定になる
前にそれを選ぶために使っていた `port` を含む）や、ファイルが無いときは移植版ランタイムを使います。公開している互換性の
数値（[互換性](../compatibility.ja.md)）は、移植版ランタイムで計測したものです。

```ts
// これから起動する node のプロセスをすべて旧ランタイムにする
await vessel.mount({ node: 'legacy' }, { path: '/etc/openvessel' });
```

```sh
mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node
```

### 同期のシステムコール

node のスレッドは、`SharedArrayBuffer` のチャネルを通してカーネルを同期的に呼び出します（`src/shared/syncchan.ts`）。

1. スレッドがリクエスト（UTF-8 の JSON と、必要に応じてその後ろのバイナリ）をバッファに書き込み、状態ワードを 1 にして、
   カーネルに `{ t: 'sys' }` を送ります。
2. 状態ワードが変わるまで `Atomics.wait` でスリープします。
3. カーネルはリクエストをデコードしてシステムコールを実行し、レスポンスを書き込んで状態ワードを 2 にし、`Atomics.notify` を呼びます。

| 定数 | 値 |
|---|---|
| スレッドごとのチャネルのサイズ | 4 MiB（`DEFAULT_CHANNEL_BYTES`） |
| ヘッダー | 64 バイト。状態・JSON の長さ・バイナリの長さ・今回のバイト数・フラグ（`1` = 後続のチャンクがある） |
| それより大きいメッセージ | どちらの方向も、複数回に分けて送る |
| スレッドごとに同時に実行できる呼び出し | 1 つ |

リクエストは `{ op, ...args }` と、必要に応じてバイト列です。レスポンスは `{ ok: 値 }`、`{ ok: 値, bin: true }` とバイト列、
または `{ err: コード, msg: メッセージ }` のいずれかです。システムコールが非同期に完了することもあります（パイプからの
読み取り、`spawnSync` など）。その間、呼び出したスレッドはブロックされたままで、カーネルはほかのスレッドへの応答を続けます。

### 非同期メッセージ

システムコールのほかに、スレッドとカーネルは `postMessage` でメッセージをやり取りします。

カーネル → プロセスのスレッド:

| メッセージ | 項目 | 意味 |
|---|---|---|
| `init` | `kind`（`main`/`thread`）・`pid`・`ppid`・`tid`・`argv`・`env`・`cwd`・`sab`・`ttys`・`hostname`・スレッド用の項目 | ランタイムを起動する（[プロセス](processes.ja.md#node-のプロセスの起動)） |
| `signal` | `sig` | プロセスがハンドラを登録したシグナル、または `SIGWINCH` |
| `child-exit` | `pid`・`code`・`signal` | `spawn` で起動した子プロセスが終了した（起動したスレッドに送る） |
| `fd-data` | `fd` または `id`・`data`（`null` = EOF）・`handle?`・`err?` | `readStart`/`readOnce` のデータ |
| `fd-writable` | `fd` | パイプ・ソケットのバッファが空いた（`writeWait` への応答） |
| `watch` | `id`・`type`・`path` | 監視しているパス以下での変更 |
| `ping` | `id` | 「それまでに送ったものをすべて処理したか」の確認（`pong` で応答する） |
| `tcp-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | listen しているポートへの新しい TCP 接続 |
| `pipe-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | Unix ドメインソケットへの新しい接続 |
| `tls-peer` | `fd`・`certs` | 相手の TLS の証明書（プロセスどうしの TLS） |
| `udp-msg` | `port`・`data`・`from` | データグラム |
| `thread-exit` | `tid`・`code`・`initFailed?`・`terminated?` | ワーカースレッドが終了した（親のスレッドに送る） |
| `thread-gone` | `tid` | 監視していたスレッドが存在しなくなった |
| `http-req`・`http-body`・`http-body-end`・`http-abort`・`ws-msg`・`ws-close` | `rid` など | 旧ランタイムの HTTP サーバーへのリクエスト |
| `loop-res`・`loop-res-data`・`loop-res-end`・`loop-res-error` | `crid` など | 旧ランタイムのループバックのリクエストに対するレスポンス |

プロセスのスレッド → カーネル:

| メッセージ | 意味 |
|---|---|
| `sys` | チャネルでシステムコールが待機している |
| `pong` | `ping` への応答 |
| `readStart` / `readStop` | fd の `fd-data` の送信を開始・停止する。パイプとソケットはデータがあるときだけ読むので、`readStop` でデータが失われることはない |
| `readOnce` | 1 回だけ読み取り（`len` まで。既定は 65536）、`id` 付きの `fd-data` で応答する |
| `writeWait` | このパイプ・ソケットのバッファが空になったら（または読み手がいなくなったら）`fd-writable` を送る |
| `threadSpawn` / `threadKill` | ワーカースレッドを起動・終了する |
| `loop-req`・`loop-body`・`loop-body-end`・`loop-abort` | 旧ランタイム: 仮想ポートへの HTTP リクエスト |
| `http-res`・`http-res-data`・`http-res-end`・`http-res-error`・`ws-open`・`ws-send`・`ws-close` | 旧ランタイム: サーバーのレスポンス |

## システムコール

すべての呼び出しは `src/kernel/syscalls.ts` の `kernel.syscall` が振り分けます。パスはプロセスの作業ディレクトリを基準に
解決し、字句的に正規化します（`..` はパスの探索の前に取り除きます）。未知の名前は `ENOSYS`（`unknown syscall <op>`）で
失敗します。最後の列は、そのシステムコールを使うランタイムです（P = 移植版、L = 旧）。

### ファイル

| システムコール | 引数 | 結果 | エラー | 補足 | 使う側 |
|---|---|---|---|---|---|
| `stat` | `p`・`l`（lstat） | stat のオブジェクト | `ENOENT`・`ENOTDIR`・`ELOOP`・`ENAMETOOLONG` | 呼んだプロセスの `/proc/self`・`/proc/<pid>`・`/proc/<pid>/fd`・`/proc/self/fd/N` にも答える（[特別なファイル](filesystem.ja.md#特別なファイル)） | P, L |
| `fstat` | `fd` | stat のオブジェクト | `EBADF` | inode の無い fd は作った値（tty `S_IFCHR\|0620`、パイプ `S_IFIFO\|0600`、ソケット `S_IFSOCK\|0600`） | P, L |
| `fdKind` | `fd` | `file`・`dir`・`pipe`・`tty`・`null`・`socket` または `null` | — | | P |
| `access` | `p`・`mode` | `null` | パス探索のエラー・`EACCES` | `R_OK`・`W_OK`・`X_OK` をパーミッションのビットで確認する（[パーミッション](filesystem.ja.md#持ち主と権限)） | P, L |
| `open` | `p`・`flags`（0）・`mode`（0o666） | fd（空いている 3 以上の最小の番号） | `ENOENT`・`ENOTDIR`・`EEXIST`・`EISDIR`・`EACCES`・`ENXIO`・`ELOOP`・`ENAMETOOLONG`・`EMFILE` | フラグが要求する読み書きのパーミッションがファイルに無いとき、また `O_CREAT` で書き込みと検索のパーミッションが無いディレクトリに作成しようとしたときは `EACCES`。新しいファイルの mode には umask を適用する。シンボリックリンクに `O_NOFOLLOW` なら `ELOOP`。`RLIMIT_NOFILE` に達すると `EMFILE` | P, L |
| `close` | `fd` | `null` | `EBADF` | その fd でカーネルが開始した読み取りも停止する | P, L |
| `read` | `fd`・`len`（65536、最大 16 MiB）・`pos` | バイト列 | `EBADF`・`EISDIR` | パイプ・tty・ソケットは、データか EOF が来るまでブロックする | P, L |
| `write` | `fd`・`pos`・`nonblock`・`sendHandle` とバイト列 | 書いたバイト数 | `EBADF`・`EISDIR`・`EPIPE`・`EINVAL` | パイプ・ソケットに `nonblock` で書き込むと、入る分だけを書く（0 = バッファが満杯）。`sendHandle` はハンドルを最初の 1 バイトに添付する（ソケットのみ） | P, L |
| `lseek` | `fd`・`offset`・`whence`（0/1/2） | 新しい位置 | `ESPIPE`・`EINVAL`・`EBADF` | 通常のファイルのみ。末尾より先へのシークも可能 | L（WASI） |
| `readFile` | `p` | バイト列 | `ENOENT`・`EISDIR`・`EACCES` など | キャラクタデバイスは 1 回分（最大 64 KiB）だけ読み取る。`/proc/self/fd/N` はその fd を EOF まで読む | P, L |
| `writeFile` | `p`・`flags`（0o1101）・`mode`（0o666）とバイト列 | `null` | `EEXIST`・`EISDIR`・`ENOENT`・`ENOTDIR`・`EACCES` | `O_APPEND` は `open` を経由する。新しいファイルの mode には umask を適用する | P, L |
| `readdir` | `p`・`types` | 名前、または `[名前, S_IF* の種類]` の組 | `ENOENT`・`ENOTDIR`・`EACCES` | 作成順。`.`/`..` は含まない | P, L |
| `mkdir` | `p`・`mode`（0o777）・`recursive` | `recursive` のときは最初に作成したディレクトリか `null` | `EEXIST`・`ENOENT`・`ENOTDIR`・`EACCES` | mode には umask を適用する | P, L |
| `mkdtemp` | `prefix` | 作成したパス | `EACCES`・`ENOENT`・`EEXIST` | ランダムな 6 文字 `[A-Za-z0-9]`、mode は 0o700 に umask を適用したもの、最大 100 回試行する | P, L |
| `rmdir` | `p` | `null` | `ENOENT`・`ENOTDIR`・`ENOTEMPTY`・`EACCES`・`EBUSY` | `/` は `EBUSY` | P, L |
| `rm` | `p`・`recursive`・`force` | `null` | `ENOENT`・`ERR_FS_EISDIR` | パーミッションは確認しない | L |
| `unlink` | `p` | `null` | `ENOENT`・`EISDIR`・`EACCES` | | P, L |
| `rename` | `from`・`to` | `null` | `ENOENT`・`EINVAL`・`EISDIR`・`ENOTDIR`・`ENOTEMPTY`・`EACCES` | | P, L |
| `link` | `from`・`to` | `null` | `EPERM`・`EEXIST`・`ENOENT`・`EACCES` | ハードリンク | P, L |
| `symlink` | `target`・`p` | `null` | `EEXIST`・`ENOENT`・`EACCES` | リンク先は渡された文字列のまま保存する | P, L |
| `readlink` | `p` | 文字列 | `EINVAL`・`ENOENT` | `/proc/self` → pid。`/proc/self/fd/N` → パス・`/dev/tty`・`pipe:[id]`・`socket:[id]` | P, L |
| `realpath` | `p` | 文字列 | `ENOENT`・`ENOTDIR`・`ELOOP` | | P, L |
| `chmod` | `p`・`mode` | `null` | パス探索のエラー | シンボリックリンクをたどる | P, L |
| `fchmod` | `fd`・`mode` | `null` | `EBADF` | inode の無い fd では何もしない | P, L |
| `utimes` | `p`・`atime`・`mtime`（ミリ秒）・`l` | `null` | パス探索のエラー | シンボリックリンクをたどる。`l`（`lutimes`）のときはリンク自体の時刻を設定する | P, L |
| `futimes` | `fd`・`atime`・`mtime`（ミリ秒） | `null` | `EBADF` | | P, L |
| `truncate` | `p`・`len`（0） | `null` | `EISDIR`・`EACCES`・パス探索のエラー | 通常のファイル以外は変更しない | L |
| `ftruncate` | `fd`・`len`（0） | `null` | `EBADF`・`EINVAL` | 書き込み用に開いていない fd でも `EINVAL` | P, L |
| `copyFile` | `from`・`to`・`excl` | `null` | `EISDIR`・`EEXIST`・`ENOENT`・`EACCES` | mode のビットもコピーする | P, L |
| `cp` | `from`・`to`・`force`・`errorOnExist`・`dereference` | `null` | `EEXIST`・`EISDIR` | 再帰的にコピーする。コピー先の親ディレクトリも作成する | L |
| `watch` | `id`・`p`・`recursive` | `null` | — | イベントは `watch` メッセージで送る（[監視](filesystem.ja.md#監視)） | P, L |
| `unwatch` | `id` | `null` | — | | P, L |

### モジュール

| システムコール | 引数 | 結果 | 使う側 |
|---|---|---|---|
| `resolve` | `kind`（`esm`/`cjs`）・`spec`・`from`・`conditions`・`exts`・`paths` | 解決したパス、または解決結果のレコード | L |
| `moduleFormat` | `p` | `module`・`commonjs`・`json`・`wasm`・`addon`・`module-typescript`・`commonjs-typescript` または `null` | L |
| `esmRegister` | `id`・`source` | `null`。プロセスが終了するまで、そのソースを `/__ov/mw/<pid>/<id>.mjs` で配信する | P |

解決に使う条件は、ESM では `import`・`node`・`module-sync`・`default`、CommonJS では `require`・`node`・`module-sync`・`default` で、
これに渡された `conditions`（`--conditions`）を加えます。

### プロセスとスレッド

| システムコール | 引数 | 結果 | エラー | 補足 | 使う側 |
|---|---|---|---|---|---|
| `getcwd` | — | 作業ディレクトリ | — | | P |
| `chdir` | `p` | 実際のパス（シンボリックリンクを解決したもの） | `ENOENT`・`ENOTDIR`・`EACCES` | 検索のパーミッションが無ければ `EACCES` | P, L |
| `umask` | `mask`（省略可） | 前の値 | — | `mask & 0o777` を保存する。子プロセスに継承される | P |
| `exit` | `code` | `null` | — | 終了状態は `code & 0xff`。[終了](processes.ja.md#終了) を参照 | P, L |
| `execve` | `argv`・`env`・`argv0` | 成功時は応答なし | `ENOENT`・`EACCES`・`ELOOP` | 状態を変更する前に検査する | P |
| `kill` | `pid`・`sig` | `null` | `EINVAL`・`ESRCH` | `pid` 0 = 呼んだプロセスのプロセスグループ、-1 = 呼んだプロセス以外の全部、ほかの負の数 = プロセスグループ、`sig` 0 = 存在確認のみ。[kill](processes.ja.md#kill) を参照 | P, L |
| `sigaction` | `sig`・`on` | `null` | — | プロセスがそのシグナルをハンドルすることを記録する | P, L |
| `spawn` | `argv`・`argv0`・`env`・`cwd`・`stdio`・`keepStdioOnError` | `{ pid, fds, error? }` | `ENOENT`・`EACCES`・`ELOOP`・`EINVAL` | `fds` は、パイプの親プロセス側の端 | P, L |
| `spawnSync` | `argv`・`argv0`・`env`・`cwd`・`stdio`・`timeout`・`killSignal` と標準入力のバイト列 | `{ pid, status, signal, outLen, error? }` と標準出力・標準エラーのバイト列 | `spawn` と同じ | タイムアウト後は `error: 'ETIMEDOUT'` | P, L |
| `threadReserve` | `nodeId` | tid、または `{ tid, threadId }` | — | tid は 100000 から。`threadId` はプロセスごとに 1, 2, … | P, L |
| `watchThread` | `tid` | `null` | — | そのスレッドが終了したら `thread-gone` を送る（すでに終了していればすぐに送る） | P |
| `threadExit` | `code` | `null` | — | 呼び出したワーカースレッドを終了する。親は `thread-exit` を受け取る | P, L |

### 端末

| システムコール | 引数 | 結果 | エラー | 使う側 |
|---|---|---|---|---|
| `isatty` | `fd` | fd が TTY なら `true` | — | L |
| `ttySize` | `fd` | `{ cols, rows }` または `null` | — | P, L |
| `setRawMode` | `fd`・`raw` | `null` | `ENOTTY` | P, L |

### ネットワーク

| システムコール | 引数 | 結果 | エラー | 補足 | 使う側 |
|---|---|---|---|---|---|
| `listen` | `port`（0 = 自動で選ぶ）・`host`・`kind` | ポート | `EADDRINUSE` | `kind`: `raw`（バイトストリーム）・`http`（旧ランタイムの HTTP サーバー）・それ以外 = TCP のみ | P, L |
| `unlisten` | `port` | `null` | — | | P, L |
| `listenShare` | `port` | `null` | `EINVAL` | ほかのプロセスから受け取った listen 中のソケットで accept する | P |
| `tcpConnect` | `port`・`host` | `{ fd, self, localAddress, localPort }` | `ECONNREFUSED`・`EMFILE` | `raw` の listener にのみ接続する。`self`: 呼び出したスレッド自身が accept する。`localAddress` / `localPort`: 接続する側のソケットのループバックアドレス（`host` が IPv6 なら `::1`、それ以外は `127.0.0.1`）とエフェメラルポート（[接続](#接続)） | P |
| `tcpConnectOut` | `host`・`port`・`tls` | fd | — | 外部ホストへの接続（[外部への接続](#外部への接続)） | P |
| `tcpSetTls` | `fd`・`servername` | 外部への接続なら `true` | — | | P |
| `tlsHello` | `fd`・`certs` | `{ wait, certs }` | — | 2 つのプロセスの間で証明書を交換する | P |
| `shutdown` | `fd` | `null` | `EBADF`・`ENOTSOCK` | ハーフクローズ。相手は EOF を読む | P |
| `unixListen` | `p` | ソケットの inode 番号 | `EADDRINUSE`・`ENOENT`・`ENOTDIR` | ソケットファイルを作成する | P |
| `unixUnlisten` | `ino` | `null` | — | ソケットファイルが同じ inode のままなら削除する | P |
| `unixConnect` | `p` | fd | `ECONNREFUSED`・`ENOENT`・`EMFILE` | | P |
| `portInfo` | `port` | そのポートで listen しているかどうか | — | | L |
| `udpBind` | `port`・`address`・`reuse` | ポート | `EADDRINUSE` | | P |
| `udpJoin` | `port` | `null` | `EINVAL` | bind 済みのポートに参加する（共有ソケット） | P |
| `udpRecv` | `port`・`on` | `null` | — | 受信を開始・停止する | P |
| `udpClose` | `port` | `null` | — | | P |
| `udpSend` | `port`・`from`・`fromAddress` とバイト列 | `null` | — | どのソケットも bind していなければ破棄される | P |

## エラーと errno の値

エラーはコード文字列とメッセージとしてチャネルを通ります。移植版ランタイムはこれを libuv のエラー（`UVException`、負の
`UV_*` の番号）に変換し、旧ランタイムは `errno` に Linux のエラー番号の負の値を入れた Node 形式のエラーを作ります。`E` で
始まらないコード（`ERR_FS_EISDIR`）は、その `code` を持つ通常の `Error` のままです。カーネル内でそれ以外の例外が発生した
ときは、その例外自身の `code`、無ければ `EIO` として返します。

| コード | 番号 | メッセージ |
|---|---|---|
| `EPERM` | 1 | operation not permitted |
| `ENOENT` | 2 | no such file or directory |
| `ESRCH` | 3 | no such process |
| `EINTR` | 4 | eintr |
| `EIO` | 5 | eio |
| `ENXIO` | 6 | enxio |
| `E2BIG` | 7 | e2big |
| `ENOEXEC` | 8 | exec format error |
| `EBADF` | 9 | bad file descriptor |
| `ECHILD` | 10 | no child processes |
| `EAGAIN` | 11 | resource temporarily unavailable |
| `ENOMEM` | 12 | enomem |
| `EACCES` | 13 | permission denied |
| `EFAULT` | 14 | efault |
| `EBUSY` | 16 | resource busy or locked |
| `EEXIST` | 17 | file already exists |
| `EXDEV` | 18 | cross-device link not permitted |
| `ENODEV` | 19 | enodev |
| `ENOTDIR` | 20 | not a directory |
| `EISDIR` | 21 | illegal operation on a directory |
| `EINVAL` | 22 | invalid argument |
| `ENFILE` | 23 | enfile |
| `EMFILE` | 24 | too many open files |
| `ENOTTY` | 25 | inappropriate ioctl for device |
| `EFBIG` | 27 | efbig |
| `ENOSPC` | 28 | no space left on device |
| `ESPIPE` | 29 | invalid seek |
| `EROFS` | 30 | read-only file system |
| `EMLINK` | 31 | emlink |
| `EPIPE` | 32 | broken pipe |
| `ERANGE` | 34 | erange |
| `ENAMETOOLONG` | 36 | name too long |
| `ENOSYS` | 38 | function not implemented |
| `ENOTEMPTY` | 39 | directory not empty |
| `ELOOP` | 40 | too many symbolic links encountered |
| `ENOTSOCK` | 88 | socket operation on non-socket |
| `ENOTSUP` | 95 | operation not supported on socket |
| `EADDRINUSE` | 98 | address already in use |
| `EADDRNOTAVAIL` | 99 | eaddrnotavail |
| `ENETUNREACH` | 101 | enetunreach |
| `ECONNRESET` | 104 | connection reset by peer |
| `ENOTCONN` | 107 | socket is not connected |
| `ETIMEDOUT` | 110 | connection timed out |
| `ECONNREFUSED` | 111 | connection refused |
| `EHOSTUNREACH` | 113 | ehostunreach |
| `ECANCELED` | 125 | ecanceled |

この表は `src/shared/errno.ts` の内容です。メッセージの無いコードは、コードを小文字にしたものをメッセージとして使います。
カーネルが独自のメッセージを設定するエラーもあります: `<cmd>: command not found`（`ENOENT`）、`<cmd>: Permission denied`（`EACCES`）、
`<name>: builtin missing`（`ENOENT`）、`spawn: cwd <path> does not exist`（`ENOENT`）、
`Path is a directory: rm returned EISDIR (is a directory) <path>`（`ERR_FS_EISDIR`）。

## 仮想ネットワーク

利用者のマシン上では何もポートを開きません。ポートはカーネル内のテーブルのエントリで、接続は互いにつながった 2 つのカーネルソケットです。

### TCP のポート

- ポートの名前空間はカーネル全体で 1 つです。listen のアドレスは記録しますが、キーには含めません。そのため
  `127.0.0.1:3000` と `::1:3000` で listen すると競合し（`EADDRINUSE`）、どのループバックアドレスへの接続も
  その listener に届きます。
- ポート `0` を指定すると、49152〜65151 の空いているポートを選びます（`49152 + random(16000)`）。
- すでに listen されているポートは、同じプロセスからでも `EADDRINUSE` になります。
- listener の種類:

| 種類 | 使用するもの | 接続 | ホストへの通知 |
|---|---|---|---|
| `raw` | 移植版ランタイム（`net`・`http` など） | socketpair 上のバイトストリーム | あり（`server-ready`・`ports()`） |
| `http` | 旧ランタイムの `http.Server` | HTTP メッセージ（`http-req` など） | あり |
| TCP のみ | 旧ランタイムの `net.Server` | —（プレビューからは `ECONNREFUSED`） | なし |

- listen を開始すると（種類 `raw` と `http`）、ホストに `server-ready { port, pid }` を送ります。クローズしたとき、または
  プロセスが終了したときは `port-closed { port }` を送ります。
- `execve` すると、そのプロセスの listener は削除されます（Node は stdio 以外のすべての fd に close-on-exec を設定するため）。
- listen 中のソケットをほかのプロセスに送ると（`child.send(msg, server)`）、そのソケットは共有になります。受け取った
  プロセスは `listenShare` を呼び、接続は実行中の所有者の間でラウンドロビンで振り分けられます。所有者が終了すると、
  次の accept 側がポートを引き継ぎます。

### 接続

`tcpConnect` は socketpair を作成します。listen しているプロセスは一方の端を新しい fd（空いている 3 以上の最小の番号）と
`tcp-accept` メッセージで受け取り、呼び出し側はもう一方の端を受け取ります。socketpair は、ノンブロッキングの書き手に対して
方向ごとに 212992 バイトまでバッファします（[パイプ](processes.ja.md#パイプ) を参照）。listen しているプロセスに空いている
ファイル記述子が無いとき（`EMFILE`）は accept できず、接続は拒否されます。

接続する側には、Linux の既定の範囲 32768〜60999 からエフェメラルポートを割り当てます。前回割り当てた番号の次の番号
（開始位置はランダム）を使い、listen 中のポートと、ほかの開いている接続が使っているポートはスキップします。接続した側の
端を閉じると、そのポートは再び使えるようになります。サーバーから見た `remoteAddress` / `remotePort` は次のとおりです。

- プロセスからの接続（`tcpConnect`）: `127.0.0.1`（IPv6 アドレスに接続したときは `::1`）/ そのエフェメラルポート
  （接続した側の `localPort`）
- プレビュー、または旧ランタイムの HTTP リクエストからの接続: `127.0.0.1` / エフェメラルポート
- Unix ドメインソケットからの接続: `''` / `0`

### プレビューからの HTTP

プレビューの iframe からのリクエストは、HTTP メッセージとしてカーネルに届きます（[プレビュー](preview.ja.md)）。`raw` の
listener に対しては、カーネル（`src/kernel/tcp.ts`）が接続を開き、HTTP/1.1 で通信します。

- リクエストヘッダーのうち `connection`・`keep-alive`・`transfer-encoding`・`upgrade`・`sec-websocket-key`・
  `sec-websocket-version` は取り除きます。`Host` が無ければ `Host: localhost:<port>` を足します。
- 通常のリクエストには `Connection: close` を付けます。ボディがあって `Content-Length` の無いリクエストは
  `Transfer-Encoding: chunked` で送ります。
- WebSocket のリクエストには `Connection: Upgrade`・`Upgrade: websocket`・`Sec-WebSocket-Version: 13` と、ランダムな
  `Sec-WebSocket-Key` を付けます。
- レスポンスは解析します。`101` 以外の `1xx` はスキップします。ボディの終わりは、`Content-Length`、chunked
  エンコーディング（トレーラーは読み取って破棄）、接続の終了のいずれかで判断します。`204` と `304` にはボディがありません。
  レスポンスヘッダーから `transfer-encoding`・`connection`・`keep-alive` を取り除きます。
- エラー: レスポンスのヘッダーが届く前に接続が閉じた場合は `socket hang up`、ボディが途中で切れた場合は
  `incomplete response`、listen しているものが無い場合は `connect ECONNREFUSED 127.0.0.1:<port>` です。
- `101 Switching Protocols` のあとは、接続上を WebSocket のフレームが流れます。テキストとバイナリのメッセージは
  そのまま渡し、ping には pong で応答し、close フレームで終了します（コードが無ければ 1005）。close フレームなしに
  接続が終了したときはコード 1006 を通知します。

旧ランタイムの `http` の listener に対しては、リクエストを `http-req` メッセージとして listen しているスレッドに送ります。
それより先にプロセスが終了した場合、リクエストは `server process exited` で失敗します。

### Unix ドメインソケット

- `listen(path)` は、そのパスにソケットファイル（`S_IFSOCK`、mode 0o755）を作成します。同じ名前がすでにあれば
  `EADDRINUSE` になります。
- listener はソケットの inode をキーにしているので、ファイル名を変更してもかまいません。シンボリックリンク経由でも接続できます。
- `connect(path)` は、ファイルがソケットでないとき、または listen しているものが無いときに `ECONNREFUSED` で失敗します。
- サーバーをクローズすると、ソケットファイルが同じ inode のままなら削除します。プロセスが終了するか `execve` すると、
  そのプロセスの Unix ドメインソケットの listener は削除されます。

### UDP

- ポートの名前空間は TCP とは別です（UDP のポートは TCP のポートと競合しません）。
- ポート `0` に bind すると、49152〜65151 の空いているポートを選びます。使用中のポートへの bind は `EADDRINUSE` に
  なりますが、`reuseAddr` を指定した場合はプロセス間でポートを共有します。
- データグラムの配送先はポートだけで決まります。どのソケットも bind していないポートへのデータグラムは破棄されます。
  bind 済みのポートへのデータグラムは、受信中のメンバーが現れるまで最大 1024 個までキューで待ち、受信中のメンバーに
  ラウンドロビンで配送されます。
- 送信元のアドレスは bind したアドレスです。未設定または `0.0.0.0` のときは `127.0.0.1` になります。

### ループバックと代理アドレス

どのアドレスをローカルとみなすかは、移植版ランタイムが判定します（`src/nodejs/bindings/net.ts`）。

- `connect` でループバックとみなすもの: `localhost`・`127.*`・`::1`・`0.0.0.0`・`::`・空文字列・`::ffff:127.0.0.1`。
  これらは仮想ポートに接続し（`tcpConnect`）、それ以外のアドレスは外部に接続します（`tcpConnectOut`）。
- `dns.lookup('localhost')` と、`.localhost` で終わる名前は `127.0.0.1` と `::1` に解決します。IP アドレスはそのまま返します。
- それ以外の名前には、`198.18.0.0/15` の範囲から代理の IPv4 アドレスを割り当てます。プロセスごとに、最初に lookup した
  順で `198.18.0.1`・`198.18.0.2`・… となります。代理アドレスに接続すると元の名前がカーネルに渡され、リクエストは
  そのホストに送られます。こうした名前の IPv6 の lookup では何も見つかりません（`ENOTFOUND`）。`resolve4`/`resolveAny` は
  代理アドレスを返します。

## 外部への接続

ブラウザはソケットを開けません。プロセスがループバック以外のアドレスに TCP で接続すると（`tcpConnectOut`）、
プロセスは socketpair の一方の端を受け取ります。カーネルはもう一方の端から HTTP/1.1 のリクエストを読み取り
（`src/kernel/outbound.ts`）、1 件ずつ、ランタイムの Service Worker のプロキシ（`<RUNTIME_BASE>/__ov/net`。ネットワーク
ポリシーのチェックを行う）を経由して `fetch` で送信し、レスポンスを HTTP/1.1 のバイト列として書き戻します。そのため、
独自の HTTP クライアントを持つライブラリ（undici・axios・got）も変更なしで動きます。

### リクエストの解析

| ルール | 動作 |
|---|---|
| 最初のバイト | リクエスト行の形（`/^[A-Z]{3,10} /`）でなければならない。それ以外（別のプロトコル、本物の TLS のハンドシェイクなど）は、レスポンスを返さずに接続を閉じる |
| リクエスト行 | `METHOD target HTTP/1.0` または `HTTP/1.1`。それ以外なら `400 Bad Request` を返して接続を閉じる |
| ヘッダー部のサイズ | 空行まで最大 1 MiB。超えた場合は接続を閉じる |
| ボディ | `Transfer-Encoding: chunked`（拡張とトレーラーは無視）または `Content-Length`。どちらも無ければ空 |
| keep-alive | HTTP/1.1 は `Connection: close` が無ければ維持する。HTTP/1.0 は `Connection: keep-alive` のときだけ維持する。1 本の接続上のリクエストは 1 件ずつ順に処理する |
| WebSocket | `Upgrade: websocket` には `501 Not Implemented` を返して接続を閉じる |
| URL | absolute-form の target はそのまま使う。それ以外は `http(s)://` + `Host` ヘッダー（無ければ接続先のホスト。80/443 以外は `:port` 付き）+ パス |

### 転送とレスポンス

- リクエストヘッダーのうち `connection`・`keep-alive`・`proxy-connection`・`transfer-encoding`・`upgrade`・`te`・`trailer`・
  `host`・`content-length` は転送しません。Service Worker はさらに多くのヘッダーを削除します（[ネットワークポリシー](network-policy.ja.md)）。
- `GET` と `HEAD` はそのまま送り、ほかのメソッドは実際のメソッドを `x-ov-method` に入れて `POST` として送ります。
  許可を求めるダイアログに表示されるリクエスト元は `<pid> <argv[0..2]>`（最大 200 文字）です。
- レスポンスは `HTTP/1.1 <status> <statusText>` として書き込みます（statusText が空なら `OK`）。`fetch` がボディをすでに
  デコードしているので、`content-encoding`・`content-length`・`transfer-encoding`・`connection`・`keep-alive` を取り除き、
  ボディを `Transfer-Encoding: chunked` で区切り直します。`204`・`304`・`1xx` と `HEAD` へのレスポンスにはボディがありません。
- リダイレクトはブラウザがたどります。

### エラー

接続自体は「確立した」ことになっているため、エラーは errno ではなく HTTP のレスポンスとして返します。ネットワーク
ポリシーがそのホストを拒否した場合は `403 Forbidden`、`fetch` が失敗した場合（ネットワークエラー、CORS）やプロキシが
失敗した場合は `502 Bad Gateway` です。

どちらのレスポンスにも `Content-Type: text/plain`・`Content-Length`・`Connection: close`・`X-OpenVessel-Error: 1` が付き、
ボディはメッセージです（例: `OpenVessel: network access to example.com was denied by the network policy`）。その後、
接続は閉じます。外部に送れるのは HTTP/1.1 だけで、ほかのプロトコルや、raw ソケットでの外部への WebSocket には
対応していません。

### TLS のパススルー

通信路上では TLS を行いません。プロセスが外部への接続に TLS を使う場合（`tls.connect`、`https`）、プロセスの TLS レイヤーは
何かを書き込む前に `tcpSetTls` を呼びます。カーネルはその接続を `https` として記録し（SNI の `servername` をホストに
します）、プロセスの TLS レイヤーは平文をそのまま通します。実際の TLS と証明書の検証は、ブラウザの `fetch` が行います。
OpenVessel 内のプロセス同士の場合も、TLS 接続の両端が `tlsHello` で証明書を交換するだけで、バイト列は平文のままです。
`tls` の API への影響は [互換性](../compatibility.ja.md) を参照してください。

## ES モジュールの配信

`src/kernel/esm.ts` は、VFS のファイルをブラウザの ES モジュールとして配信します。ランタイムの Service Worker が
（`RUNTIME_BASE` 以下の）次の URL へのリクエストをカーネルに転送し、結果を `Content-Type: text/javascript; charset=utf-8` と
`Cache-Control: no-store` 付きで返します。

| URL | レスポンス |
|---|---|
| `/__ov/esm/<絶対パス>[?query]` | そのファイルを ES モジュールに変換したもの |
| `/__ov/builtin/<name>` | 組み込みモジュール（`node:fs` など）を `globalThis.__ov.builtin(name)` から再 export するモジュール |
| `/__ov/esm-error?code=…&msg=…&names=…` | 解決できない import の代わりになるモジュール。`names` の各名前（`default` を含む）を 1 回ずつ宣言し、評価されると `code` と `msg` を持つ `Error` を投げる。そのため import する側のモジュールはリンクできる |
| `/__ov/mw/<pid>/<id>.mjs` | `esmRegister` で登録したソース（移植版ランタイムの `ModuleWrap`）。未知のキーには `ERR_INTERNAL_ASSERTION` を投げるモジュールを返す |

生成したモジュールに書き込む URL は `RUNTIME_BASE` から始まる絶対 URL なので、ランタイムをサブパスで配信しても
動作します。

ファイルからモジュールへの変換方法は、形式ごとに次のとおりです。

| 形式 | モジュール |
|---|---|
| `module`（`.mjs`・`"type": "module"`・ES の構文と判定したもの） | import の指定子を上記の URL に書き換え、`import.meta` → `globalThis.__ov.meta(<ファイルの URL>)`、`import()` → `globalThis.__ov.dimport(…)`、import 属性を削除し、`#!` の行をコメントアウトし、末尾に `//# sourceURL=file://…` を追加したソース |
| `module-typescript`（`.mts`、`"type": "commonjs"` の外の `.ts`） | sucrase で型を除去したあと、`module` と同じ処理 |
| `commonjs`・`commonjs-typescript` | ファサードモジュール: `default` = `globalThis.__ov.requireForImport(file)` の `module.exports`。cjs-module-lexer で検出した名前付き export も加える（再 export は 8 階層までたどる） |
| `json`（または `with { type: 'json' }` のときに付く `?ov-json`） | `export default JSON.parse(…)` |
| `addon`（`.node`） | エラー `ERR_DLOPEN_FAILED` |
| `wasm` | エラー `ERR_UNKNOWN_FILE_EXTENSION` |
| ファイルが無い / ディレクトリ | `ERR_MODULE_NOT_FOUND` / `ERR_UNSUPPORTED_DIR_IMPORT` |

モジュールを生成できないときは、表のコードを持つ `Error` を投げるモジュールを返すので、エラーは import した箇所で
発生します。生成したモジュールはパスごとに、inode 番号・mtime・サイズをキーにしてキャッシュします。キャッシュが 4000 件を
超えるとすべて破棄します。`esmRegister` で登録したソースは、そのプロセスが終了すると破棄します。旧ランタイムは ES モジュールを
`/__ov/esm/` から読み込み、移植版ランタイムは自分でコンパイルするソースを登録して `/__ov/mw/` から読み込みます。

## 組み込みプログラム

### 登録されているプログラム

組み込みプログラムは名前で登録し、`#!/ov/builtin <name>` と書いた実行可能なスタブファイル（mode 0o755）として
配置します。`PATH` 上にファイルが見つからなくても、コマンド名が登録済みの名前と一致すれば、その組み込みプログラムを実行します。

| ディレクトリ | プログラム |
|---|---|
| `/bin` | `sh`・`bash`・`dash`（実体は同じシェル。[シェル](shell.ja.md)） |
| `/bin` | `ls`・`cat`・`mkdir`・`mkfifo`・`rm`・`rmdir`・`cp`・`mv`・`touch`・`ln`・`chmod`・`head`・`tail`・`wc`・`grep`・`egrep`・`fgrep`・`find`・`sort`・`uniq`・`cut`・`tr`・`sed`・`xargs`・`tee`・`env`・`which`・`basename`・`dirname`・`realpath`・`readlink`・`stat`・`du`・`df`・`free`・`date`・`sleep`・`uname`・`ps`・`kill`・`seq`・`yes`・`mktemp`・`base64`・`diff`・`clear`・`nproc`・`id`・`hostname`・`whoami`・`tty`・`stty`・`nohup`・`nice`・`less`・`more`・`file`・`rev`・`nl`・`timeout`・`time`・`truncate`・`sha256sum`・`sha1sum`・`sha512sum`・`md5sum`・`echo`・`printf`・`test`・`[`・`true`・`false`・`pwd`・`chown`（何もしない）・`sync`（何もしない） |
| `/usr/bin` | `env`（`#!/usr/bin/env` の行のための 2 つ目のスタブ） |
| `/usr/bin` | `node`（`#!/ov/builtin node`。node のプロセスを起動する）と `nodejs`（`/usr/bin/node` へのシンボリックリンク） |
| `/usr/bin` | `npm`・`pnpm`・`yarn`・`bun`・`npx`・`pnpx`・`bunx`・`corepack`（[パッケージマネージャ](package-managers.ja.md)） |
| `/usr/bin` | `curl`・`wget` |

### curl と wget

`curl` と `wget` は、`npm` と同じく、ネットワークポリシーのチェックを行うプロキシを経由して取得します。`curl` で使えるオプションは次のとおりです。

| オプション | 効果 |
|---|---|
| `-X`・`--request <method>` | リクエストのメソッド（既定は `GET`） |
| `-o`・`--output <file>` | ボディをファイルに書き込む |
| `-O`・`--remote-name` | URL のパスの最後のセグメントをファイル名として書き込む（空なら `index.html`） |
| `-H`・`--header '<name>: <value>'` | リクエストヘッダーを追加する |
| `-d`・`--data`・`--data-raw`・`--data-binary <data>` | リクエストのボディ。`GET` を `POST` に切り替える |
| `-I`・`--head` | `HEAD` リクエスト。ステータス行とヘッダーだけを表示する |
| `-i`・`--include` | ボディの前にステータス行とヘッダーを表示する |
| `-f`・`--fail` | ステータスが 400 以上なら `curl: (22) The requested URL returned error: <status>` を表示して 22 で終了する |
| `-s`・`--silent`、`sSLfk` を組み合わせた短いフラグ | 受け付ける（組み合わせの中の `f` は `--fail`） |
| `-L`・`--location`・`-k`・`--insecure`・`--compressed` | 受け付ける。リダイレクトは常にたどる |

スキームの無い URL には `http://` を付けます。終了コードは、0 が成功、2 が URL の指定なし（`curl: no URL specified!`）、
7 がリクエストの失敗（`curl: (7) <message>`。ポリシーによる拒否も含む）、22 が `--fail` 指定時のエラーです。`wget <url>` は
URL のパスの最後のセグメント（空なら `index.html`）に保存し、`wget -O <file> <url>` は `<file>` に保存します。`-O -` を
指定すると標準出力に書き出します。動作は `curl -fsSL` と同じです。

## 起動時のファイルシステム

カーネルが起動時に作成するものは次のとおりです（`src/kernel/kernel.ts`・`src/kernel/index.ts`・`src/kernel/coreutils.ts`・
`src/kernel/npm/cli.ts`・`src/kernel/curl.ts`）。

| パス | 種類 | 中身 / mode |
|---|---|---|
| `/bin`・`/usr/bin`・`/usr/local/bin`・`/usr/lib/node_modules`・`/usr/local/lib`・`/home/user`・`/etc`・`/dev`・`/proc`・`/var/tmp`・`/root`・`/opt` | ディレクトリ | 0755（親の `/usr`・`/usr/local`・`/usr/lib`・`/home`・`/var` も） |
| `/tmp` | ディレクトリ | 1777 |
| `/etc/passwd` | ファイル | `root:x:0:0:root:/root:/bin/sh`、`user:x:1000:1000:user:/home/user:/bin/sh`、`nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin` |
| `/etc/group` | ファイル | `root:x:0:`、`user:x:1000:`、`nogroup:x:65534:` |
| `/etc/hostname` | ファイル | `openvessel` |
| `/etc/hosts` | ファイル | `127.0.0.1 localhost`、`::1 localhost` |
| `/etc/os-release` | ファイル | `NAME="OpenVessel"`、`ID=openvessel`、`PRETTY_NAME="OpenVessel"` |
| `/etc/shells` | ファイル | `/bin/sh`、`/bin/bash` |
| `/dev/null`・`/dev/zero`・`/dev/random`・`/dev/urandom` | キャラクタデバイス | 0666 |
| `/dev/fd` | ディレクトリ | 空。`/dev/fd/N` はプロセスごとに解決する |
| `/dev/stdin`・`/dev/stdout`・`/dev/stderr` | シンボリックリンク | `/proc/self/fd/0`・`/1`・`/2` へ |
| `/proc/cpuinfo` | ファイル | `navigator.hardwareConcurrency`（不明なら 4）の数だけのエントリ（`processor`、`model name : OpenVessel Virtual CPU`、`cpu MHz : 2400.000`、`cpu cores`）。移植版ランタイムの `os.cpus()` と同じ数 |
| `/proc/meminfo` | ファイル | `MemTotal: 8388608 kB`、`MemFree: 4194304 kB`、`MemAvailable: 4194304 kB`（移植版ランタイムの `os.totalmem()` と `os.freemem()`） |
| `/proc/version` | ファイル | `Linux version 6.8.0-openvessel (user@openvessel) #1 SMP OpenVessel`（移植版ランタイムの `os.release()` と `os.version()`） |
| `/bin/*`・`/usr/bin/*` | 実行可能なスタブファイル | [登録されているプログラム](#登録されているプログラム) を参照 |
| `/usr/bin/nodejs` | シンボリックリンク | `/usr/bin/node` へ |
| `/home/user/.shrc` | ファイル | `alias ll='ls -l'`、`alias la='ls -la'` |

通常のファイルは mode 0644 で作成します。`/etc/openvessel/node` は起動時には存在しません（移植版ランタイムを使います）。
ホストがマウントするファイルは、既定で `/home/user/app` に配置されます（[ホスト API](host-api.ja.md)）。ホスト名は `openvessel` です。

## 既定の環境変数

`kernel.defaultEnv()` は、ホストが起動するプロセス（ホストが渡す `env` とマージする）と、親を持たずに起動するプロセスの
環境変数です。

| 変数 | 値 |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/home/user` |
| `USER` | `user` |
| `LOGNAME` | `user` |
| `SHELL` | `/bin/sh` |
| `TERM` | `xterm-256color` |
| `LANG` | `en_US.UTF-8` |
| `TMPDIR` | `/tmp` |
| `HOSTNAME` | `openvessel` |
| `NAPI_RS_FORCE_WASI` | `true`（napi-rs のパッケージが WebAssembly 版のビルドを読み込む） |

子プロセスは、呼び出し側が環境変数を渡さない限り、親の環境変数のコピーを継承します。シェルは独自の変数を追加します
（`PWD` など。[シェル](shell.ja.md) を参照）。
