# カーネル

[English](kernel.md)

カーネルは OpenVessel の「OS」です。Web Worker 1 つが、ファイルシステム・プロセスの表・パイプ・端末・ソケット・
仮想ポート・ネットワークへの出口を受け持ちます。このページでは、その部品、スレッドの構成、システムコールの全一覧、
仮想ネットワーク、外への HTTP の橋渡し、ES モジュールの配信、組み込みのプログラム、起動時にあるものを説明します。

ファイルシステムとプロセスには、それぞれ専用のページがあります（[ファイルシステム](filesystem.ja.md)・
[プロセス](processes.ja.md)）。全体の流れは [OpenVessel のしくみ](../how-it-works.ja.md) を見てください。

## 受け持つこと

| 分野 | カーネルがすること | ソース |
|---|---|---|
| ファイルシステム | メモリ上の VFS。inode・権限・時刻・シンボリックリンク・ハードリンク・FIFO・ソケット・変更の通知 | `src/kernel/vfs.ts` |
| プロセス | pid・プロセスグループ・argv/env/cwd・ファイル記述子・終了状態・シグナル・`execve` | `src/kernel/kernel.ts`、`src/kernel/proc.ts` |
| 入出力 | オープンファイル記述・パイプ・socketpair・TTY の行の規律 | `src/kernel/io.ts` |
| システムコール | node のスレッドからの同期の呼び出しと、非同期のメッセージ | `src/kernel/syscalls.ts` |
| 仮想ネットワーク | TCP のポート・Unix ドメインソケット・UDP のポート・プレビューからの HTTP/WebSocket | `src/kernel/net.ts`、`src/kernel/tcp.ts` |
| 外への出口 | 生のソケットで外のホストへ送る HTTP/1.1 を、ネットワークの方針に通して送る | `src/kernel/outbound.ts` |
| ES モジュール | VFS のファイルを、ブラウザの ES モジュールとしてプロセスの Worker に配る | `src/kernel/esm.ts` |
| プログラム | `sh`・coreutils・`npm`/`pnpm`/`yarn`/`bun`・`curl`/`wget`。カーネルの中で動く | `src/kernel/sh/`、`src/kernel/coreutils.ts`、`src/kernel/npm/`、`src/kernel/curl.ts` |
| ホストとの通信路 | 埋め込む側のページが使う API（[ホスト API](host-api.ja.md)・[通信の形式](protocol.ja.md)） | `src/kernel/index.ts` |
| ネットワークの方針 | 要求を外へ出してよいかを決める（[ネットワークの方針](network-policy.ja.md)） | `src/kernel/index.ts`、`src/shared/policy.ts` |

`src/kernel/base.ts` には定数が 1 つだけあります。`RUNTIME_BASE` は、カーネルのスクリプトを読み込んだディレクトリの
URL（末尾の `/` なし）です。ランタイムの Service Worker は、この下の `/__ov/…` に答えます。

## スレッドの構成

### Worker

| Worker | 作るもの | 名前 | 動かすもの |
|---|---|---|---|
| カーネル | ランタイムの iframe（`src/runtime/runtime.ts`） | `openvessel-kernel` | `dist/runtime/kernel.js`。VFS・プロセスの表・すべての組み込みプログラム（`sh`・coreutils・`npm` など） |
| プロセスのメインスレッド | カーネル | `node:<pid>:<tid>`（待機列から取ったものは `node (idle)`） | `node` のプロセス 1 つ分の Node.js ランタイム |
| ワーカースレッド | プロセスの求めに応じてカーネルが作る（`worker_threads`） | メインスレッドと同じ | 同じプロセスの中のもう 1 つの Node.js ランタイム（pid も fd の表も同じ） |

組み込みのプログラムは Worker ではありません。カーネル自身のイベントループの上で動く `async` 関数です
（`queueMicrotask` で始まります）。入力や子プロセスを待つあいだは処理をカーネルに返すので、カーネルはそのあいだも
ほかのプロセスに応え続けます。

### 温めた Worker の待機列

プロセスの起動にかかる時間の大半は、ランタイムのスクリプトの読み込みとコンパイルです。そこでカーネルは、何もしていない
プロセス用の Worker を用意しておきます（`src/kernel/index.ts`）。

- ランタイムのスクリプトの URL ごとに `WARM = 2` 個です。
- ある URL の待機列は、その URL を使う最初のプロセスの起動のときに作られます。Worker を 1 つ取るたびに
  （`setTimeout(…, 0)` で）補充します。
- 待機中の Worker は、`init` のメッセージを受け取るまで何もしません。待機列が空なら、その場で新しく作ります。
- ワーカースレッドも、メインスレッドと同じ待機列（そのプロセスのランタイムの待機列）から取ります。

### Node.js のランタイムの選択

ビルドには Node.js のランタイムが 2 つ入っています。

| ランタイム | スクリプト | ソース | 使われるとき |
|---|---|---|---|
| 旧ランタイム | `dist/runtime/process.js` | `src/node/`（手書きの Node 互換の層） | 既定 |
| 移植ランタイム | `dist/runtime/node-process.js` | `src/nodejs/`（Node 自身の `lib/` と、TypeScript で書いた `internalBinding()`） | VFS のファイル `/etc/openvessel/node` の中身が `port` のとき |

カーネルは node のプログラムが起動するたびに（新しいプロセスと `execve`）`/etc/openvessel/node` を読み、前後の空白を
除いて比べ、選んだランタイムをプロセスに記録します。プロセスのワーカースレッドは、実行中にファイルが変わっても、
いつもメインスレッドと同じランタイムになります。ほかの中身のときや、ファイルが無いときは旧ランタイムです。公開している互換性の数字
（[互換性](../compatibility.ja.md)）は、移植ランタイムのものです。

```ts
// これから起動する node のプロセスをすべて移植ランタイムにする
await vessel.mount({ node: 'port' }, { path: '/etc/openvessel' });
```

```sh
mkdir -p /etc/openvessel && echo port > /etc/openvessel/node
```

### 同期のシステムコール

node のスレッドは、`SharedArrayBuffer` の通信路を通して、カーネルを同期で呼びます（`src/shared/syncchan.ts`）。

1. スレッドが要求（UTF-8 の JSON と、必要ならその後ろにバイナリ）をバッファに書き、状態の値を 1 にして、
   カーネルに `{ t: 'sys' }` を送ります。
2. 状態の値が変わるまで `Atomics.wait` で眠ります。
3. カーネルは要求を読んでシステムコールを実行し、応答を書き、状態の値を 2 にして `Atomics.notify` を呼びます。

| 定数 | 値 |
|---|---|
| スレッドごとの通信路の大きさ | 4 MiB（`DEFAULT_CHANNEL_BYTES`） |
| ヘッダー | 64 バイト。状態・JSON の長さ・バイナリの長さ・この回のバイト数・フラグ（`1` = 続きがある） |
| もっと大きいメッセージ | どちら向きも、何回かに分けて送る |
| スレッドごとに同時に出せる呼び出し | 1 つ |

要求は `{ op, ...args }` と、必要ならバイト列です。応答は `{ ok: 値 }`、`{ ok: 値, bin: true }` とバイト列、
または `{ err: コード, msg: メッセージ }` です。システムコールは非同期に終わることもあります（パイプからの読み取り、
`spawnSync`）。そのあいだ呼んだスレッドは止まったままで、カーネルはほかのすべてに応え続けます。

### 非同期のメッセージ

システムコールのほかに、スレッドとカーネルは `postMessage` のメッセージをやり取りします。

カーネル → プロセスのスレッド:

| メッセージ | 項目 | 意味 |
|---|---|---|
| `init` | `kind`（`main`/`thread`）・`pid`・`ppid`・`tid`・`argv`・`env`・`cwd`・`sab`・`ttys`・`hostname`・スレッドの項目 | ランタイムを始める（[プロセス](processes.ja.md#node-のプロセスの起動)） |
| `signal` | `sig` | プロセスが受け手を登録したシグナル、または `SIGWINCH` |
| `child-exit` | `pid`・`code`・`signal` | `spawn` で起動した子が終わった（起動したスレッドへ送る） |
| `fd-data` | `fd` または `id`・`data`（`null` = EOF）・`handle?`・`err?` | `readStart`/`readOnce` のデータ |
| `fd-writable` | `fd` | パイプ・ソケットのバッファが空いた（`writeWait` への返事） |
| `watch` | `id`・`type`・`path` | 監視しているパスの下での変更 |
| `ping` | `id` | 「前に送ったものは全部処理したか」（`pong` で答える） |
| `tcp-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | 待ち受けているポートへの新しい TCP の接続 |
| `pipe-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | Unix ドメインソケットへの新しい接続 |
| `tls-peer` | `fd`・`certs` | 相手の TLS の証明書（プロセスどうしの TLS） |
| `udp-msg` | `port`・`data`・`from` | データグラム |
| `thread-exit` | `tid`・`code`・`initFailed?`・`terminated?` | ワーカースレッドが終わった（親のスレッドへ送る） |
| `thread-gone` | `tid` | 見張っていたスレッドがもう無い |
| `http-req`・`http-body`・`http-body-end`・`http-abort`・`ws-msg`・`ws-close` | `rid` など | 旧ランタイムの HTTP サーバーへの要求 |
| `loop-res`・`loop-res-data`・`loop-res-end`・`loop-res-error` | `crid` など | 旧ランタイムのループバックの要求への応答 |

プロセスのスレッド → カーネル:

| メッセージ | 意味 |
|---|---|
| `sys` | 通信路でシステムコールが待っている |
| `pong` | `ping` への返事 |
| `readStart` / `readStop` | fd の `fd-data` の送り出しを始める・止める。パイプとソケットはデータがあるときだけ読むので、`readStop` でデータがなくなることはない |
| `readOnce` | 1 回だけ読み（`len` まで。既定 65536）、`id` 付きの `fd-data` で答える |
| `writeWait` | このパイプ・ソケットのバッファが空になったら（または読む人がいなくなったら）`fd-writable` を送る |
| `threadSpawn` / `threadKill` | ワーカースレッドを始める・止める |
| `loop-req`・`loop-body`・`loop-body-end`・`loop-abort` | 旧ランタイム: 仮想ポートへの HTTP の要求 |
| `http-res`・`http-res-data`・`http-res-end`・`http-res-error`・`ws-open`・`ws-send`・`ws-close` | 旧ランタイム: サーバーの応答 |

## システムコール

すべて `src/kernel/syscalls.ts` の `kernel.syscall` が振り分けます。パスはプロセスの作業ディレクトリから解決し、
字面の上で正規化します（`..` は探す前に取り除きます）。知らない名前は `ENOSYS`（`unknown syscall <op>`）です。
最後の列は、どちらのランタイムが使うかです（P = 移植、L = 旧）。

### ファイル

| システムコール | 引数 | 結果 | エラー | 補足 | 使う側 |
|---|---|---|---|---|---|
| `stat` | `p`・`l`（lstat） | stat のオブジェクト | `ENOENT`・`ENOTDIR`・`ELOOP`・`ENAMETOOLONG` | 呼んだプロセスの `/proc/self`・`/proc/<pid>`・`/proc/<pid>/fd`・`/proc/self/fd/N` にも答える（[特別なファイル](filesystem.ja.md#特別なファイル)） | P, L |
| `fstat` | `fd` | stat のオブジェクト | `EBADF` | inode の無い fd は作った値（tty `S_IFCHR\|0620`、パイプ `S_IFIFO\|0600`、ソケット `S_IFSOCK\|0600`） | P, L |
| `fdKind` | `fd` | `file`・`dir`・`pipe`・`tty`・`null`・`socket` または `null` | — | | P |
| `access` | `p`・`mode` | `null` | 探すときのエラー・`EACCES` | `R_OK`・`W_OK`・`X_OK` を権限のビットで調べる（[権限](filesystem.ja.md#持ち主と権限)） | P, L |
| `open` | `p`・`flags`（0）・`mode`（0o666） | fd（空いている 3 以上の最小の番号） | `ENOENT`・`ENOTDIR`・`EEXIST`・`EISDIR`・`EACCES`・`ENXIO`・`ELOOP`・`ENAMETOOLONG`・`EMFILE` | フラグが求める読み書きの権限がファイルに無いとき、また `O_CREAT` で書き込みと検索の権限の無いディレクトリに作ろうとすると `EACCES`。新しいファイルの mode は umask で削る。シンボリックリンクに `O_NOFOLLOW` なら `ELOOP`。`RLIMIT_NOFILE` に達すると `EMFILE` | P, L |
| `close` | `fd` | `null` | `EBADF` | その fd でカーネルが始めた読み取りも止める | P, L |
| `read` | `fd`・`len`（65536、最大 16 MiB）・`pos` | バイト列 | `EBADF`・`EISDIR` | パイプ・tty・ソケットは、データか EOF が来るまで待つ | P, L |
| `write` | `fd`・`pos`・`nonblock`・`sendHandle` とバイト列 | 書いたバイト数 | `EBADF`・`EISDIR`・`EPIPE`・`EINVAL` | パイプ・ソケットに `nonblock` で書くと、入る分だけ書く（0 = いっぱい）。`sendHandle` はハンドルを最初の 1 バイトに添える（ソケットだけ） | P, L |
| `lseek` | `fd`・`offset`・`whence`（0/1/2） | 新しい位置 | `ESPIPE`・`EINVAL`・`EBADF` | 通常のファイルだけ。末尾より先へも動ける | L（WASI） |
| `readFile` | `p` | バイト列 | `ENOENT`・`EISDIR`・`EACCES` など | キャラクタデバイスは 1 回分（最大 64 KiB）だけ読む。`/proc/self/fd/N` はその fd を EOF まで読む | P, L |
| `writeFile` | `p`・`flags`（0o1101）・`mode`（0o666）とバイト列 | `null` | `EEXIST`・`EISDIR`・`ENOENT`・`ENOTDIR`・`EACCES` | `O_APPEND` は `open` を通す。新しいファイルの mode は umask で削る | P, L |
| `readdir` | `p`・`types` | 名前、または `[名前, S_IF* の種類]` の組 | `ENOENT`・`ENOTDIR`・`EACCES` | 作った順。`.`/`..` は無い | P, L |
| `mkdir` | `p`・`mode`（0o777）・`recursive` | `recursive` なら最初に作ったディレクトリか `null` | `EEXIST`・`ENOENT`・`ENOTDIR`・`EACCES` | mode は umask で削る | P, L |
| `mkdtemp` | `prefix` | 作ったパス | `EACCES`・`ENOENT`・`EEXIST` | ランダムな 6 文字 `[A-Za-z0-9]`、mode 0o700 を umask で削ったもの、最大 100 回試す | P, L |
| `rmdir` | `p` | `null` | `ENOENT`・`ENOTDIR`・`ENOTEMPTY`・`EACCES`・`EBUSY` | `/` は `EBUSY` | P, L |
| `rm` | `p`・`recursive`・`force` | `null` | `ENOENT`・`ERR_FS_EISDIR` | 権限は調べない | L |
| `unlink` | `p` | `null` | `ENOENT`・`EISDIR`・`EACCES` | | P, L |
| `rename` | `from`・`to` | `null` | `ENOENT`・`EINVAL`・`EISDIR`・`ENOTDIR`・`ENOTEMPTY`・`EACCES` | | P, L |
| `link` | `from`・`to` | `null` | `EPERM`・`EEXIST`・`ENOENT`・`EACCES` | ハードリンク | P, L |
| `symlink` | `target`・`p` | `null` | `EEXIST`・`ENOENT`・`EACCES` | リンク先は渡されたまま記録する | P, L |
| `readlink` | `p` | 文字列 | `EINVAL`・`ENOENT` | `/proc/self` → pid。`/proc/self/fd/N` → パス・`/dev/tty`・`pipe:[id]`・`socket:[id]` | P, L |
| `realpath` | `p` | 文字列 | `ENOENT`・`ENOTDIR`・`ELOOP` | | P, L |
| `chmod` | `p`・`mode` | `null` | 探すときのエラー | シンボリックリンクはたどる | P, L |
| `fchmod` | `fd`・`mode` | `null` | `EBADF` | inode の無い fd には何もしない | P, L |
| `utimes` | `p`・`atime`・`mtime`（ミリ秒）・`l` | `null` | 探すときのエラー | シンボリックリンクはたどる。`l`（`lutimes`）ならリンクそのものの時刻を変える | P, L |
| `futimes` | `fd`・`atime`・`mtime`（ミリ秒） | `null` | `EBADF` | | P, L |
| `truncate` | `p`・`len`（0） | `null` | `EISDIR`・`EACCES`・探すときのエラー | 通常のファイル以外はそのまま | L |
| `ftruncate` | `fd`・`len`（0） | `null` | `EBADF`・`EINVAL` | 書き込み用に開いていない fd も `EINVAL` | P, L |
| `copyFile` | `from`・`to`・`excl` | `null` | `EISDIR`・`EEXIST`・`ENOENT`・`EACCES` | mode のビットも写す | P, L |
| `cp` | `from`・`to`・`force`・`errorOnExist`・`dereference` | `null` | `EEXIST`・`EISDIR` | 再帰。コピー先の親ディレクトリも作る | L |
| `watch` | `id`・`p`・`recursive` | `null` | — | 通知は `watch` のメッセージで送る（[監視](filesystem.ja.md#監視)） | P, L |
| `unwatch` | `id` | `null` | — | | P, L |

### モジュール

| システムコール | 引数 | 結果 | 使う側 |
|---|---|---|---|
| `resolve` | `kind`（`esm`/`cjs`）・`spec`・`from`・`conditions`・`exts`・`paths` | 解決したパス、または解決の記録 | L |
| `moduleFormat` | `p` | `module`・`commonjs`・`json`・`wasm`・`addon`・`module-typescript`・`commonjs-typescript` または `null` | L |
| `esmRegister` | `id`・`source` | `null`。プロセスが終わるまで、そのソースを `/__ov/mw/<pid>/<id>.mjs` で配る | P |

解決の条件は、ESM が `import`・`node`・`module-sync`・`default`、CommonJS が `require`・`node`・`module-sync`・`default` で、
渡された `conditions`（`--conditions`）を足します。

### プロセスとスレッド

| システムコール | 引数 | 結果 | エラー | 補足 | 使う側 |
|---|---|---|---|---|---|
| `getcwd` | — | 作業ディレクトリ | — | | P |
| `chdir` | `p` | 実際のパス（シンボリックリンクを解決したもの） | `ENOENT`・`ENOTDIR`・`EACCES` | 検索の権限が無ければ `EACCES` | P, L |
| `umask` | `mask`（省略可） | 前の値 | — | `mask & 0o777` を記録する。子プロセスに引き継がれる | P |
| `exit` | `code` | `null` | — | 終了状態は `code & 0xff`。[終了](processes.ja.md#終了) を参照 | P, L |
| `execve` | `argv`・`env`・`argv0` | うまくいけば返事は無い | `ENOENT`・`EACCES`・`ELOOP` | 何かを変える前に調べる | P |
| `kill` | `pid`・`sig` | `null` | `EINVAL`・`ESRCH` | `pid` 0 = 呼んだプロセスのプロセスグループ、-1 = 呼んだプロセス以外の全部、ほかの負の数 = プロセスグループ、`sig` 0 = あるかどうかを調べるだけ。[kill](processes.ja.md#kill) を参照 | P, L |
| `sigaction` | `sig`・`on` | `null` | — | プロセスがそのシグナルを自分で受けると記録する | P, L |
| `spawn` | `argv`・`argv0`・`env`・`cwd`・`stdio`・`keepStdioOnError` | `{ pid, fds, error? }` | `ENOENT`・`EACCES`・`ELOOP`・`EINVAL` | `fds` は、パイプの親の側の端 | P, L |
| `spawnSync` | `argv`・`argv0`・`env`・`cwd`・`stdio`・`timeout`・`killSignal` と標準入力のバイト列 | `{ pid, status, signal, outLen, error? }` と標準出力・標準エラーのバイト列 | `spawn` と同じ | 時間切れのあとは `error: 'ETIMEDOUT'` | P, L |
| `threadReserve` | `nodeId` | tid、または `{ tid, threadId }` | — | tid は 100000 から。`threadId` はプロセスごとに 1, 2, … | P, L |
| `watchThread` | `tid` | `null` | — | そのスレッドが終わったら `thread-gone`（もう無ければすぐ） | P |
| `threadExit` | `code` | `null` | — | 呼んだワーカースレッドを終える。親は `thread-exit` を受け取る | P, L |

### 端末

| システムコール | 引数 | 結果 | エラー | 使う側 |
|---|---|---|---|---|
| `isatty` | `fd` | fd が TTY なら `true` | — | L |
| `ttySize` | `fd` | `{ cols, rows }` または `null` | — | P, L |
| `setRawMode` | `fd`・`raw` | `null` | `ENOTTY` | P, L |

### ネットワーク

| システムコール | 引数 | 結果 | エラー | 補足 | 使う側 |
|---|---|---|---|---|---|
| `listen` | `port`（0 = 選ぶ）・`host`・`kind` | ポート | `EADDRINUSE` | `kind`: `raw`（バイト列）・`http`（旧ランタイムの HTTP サーバー）・それ以外 = TCP だけ | P, L |
| `unlisten` | `port` | `null` | — | | P, L |
| `listenShare` | `port` | `null` | `EINVAL` | ほかのプロセスから受け取った待ち受けのソケットで accept する | P |
| `tcpConnect` | `port`・`host` | `{ fd, self, localAddress, localPort }` | `ECONNREFUSED`・`EMFILE` | `raw` の待ち受けにだけつなぐ。`self`: 呼んだスレッド自身が受け付ける。`localAddress` / `localPort`: つなぐ側のソケットのループバックアドレス（`host` が IPv6 なら `::1`、それ以外は `127.0.0.1`）とエフェメラルポート（[接続](#接続)） | P |
| `tcpConnectOut` | `host`・`port`・`tls` | fd | — | 外のホストへの接続（[外への接続](#外への接続)） | P |
| `tcpSetTls` | `fd`・`servername` | 外への接続なら `true` | — | | P |
| `tlsHello` | `fd`・`certs` | `{ wait, certs }` | — | 2 つのプロセスのあいだで証明書を交換する | P |
| `shutdown` | `fd` | `null` | `EBADF`・`ENOTSOCK` | 片側を閉じる。相手は EOF を読む | P |
| `unixListen` | `p` | ソケットの inode の番号 | `EADDRINUSE`・`ENOENT`・`ENOTDIR` | ソケットのファイルを作る | P |
| `unixUnlisten` | `ino` | `null` | — | ソケットのファイルが同じ inode のままなら消す | P |
| `unixConnect` | `p` | fd | `ECONNREFUSED`・`ENOENT`・`EMFILE` | | P |
| `portInfo` | `port` | そこで待ち受けているか | — | | L |
| `udpBind` | `port`・`address`・`reuse` | ポート | `EADDRINUSE` | | P |
| `udpJoin` | `port` | `null` | `EINVAL` | 割り当て済みのポートに加わる（共有のソケット） | P |
| `udpRecv` | `port`・`on` | `null` | — | 受信を始める・止める | P |
| `udpClose` | `port` | `null` | — | | P |
| `udpSend` | `port`・`from`・`fromAddress` とバイト列 | `null` | — | 誰も割り当てていなければ失われる | P |

## エラーと errno の値

エラーは、コードの文字列とメッセージで通信路を通ります。移植ランタイムはこれを libuv のエラー（`UVException`、負の
`UV_*` の番号）に、旧ランタイムは `errno` = Linux の番号の負の値の Node 風のエラーにします。`E` で始まらないコード
（`ERR_FS_EISDIR`）は、その `code` を持つふつうの `Error` のままです。カーネルの中でそれ以外の例外が起きたときは、
その例外の `code`、無ければ `EIO` を返します。

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

表は `src/shared/errno.ts` のものです。メッセージの無いコードは、コードを小文字にしたものを使います。カーネルが
自分でメッセージを付けるエラーもあります: `<cmd>: command not found`（`ENOENT`）、`<cmd>: Permission denied`（`EACCES`）、
`<name>: builtin missing`（`ENOENT`）、`spawn: cwd <path> does not exist`（`ENOENT`）、
`Path is a directory: rm returned EISDIR (is a directory) <path>`（`ERR_FS_EISDIR`）。

## 仮想ネットワーク

利用者のマシンでは何も開きません。ポートはカーネルの表の項目で、接続はつながった 2 つのカーネルのソケットです。

### TCP のポート

- ポートの名前空間は、カーネル全体で 1 つです。待ち受けのアドレスは記録しますが、区別には使いません。
  `127.0.0.1:3000` と `::1:3000` で待ち受けるとぶつかり（`EADDRINUSE`）、どのループバックのアドレスへの接続も
  その待ち受けに届きます。
- ポート `0` は、49152〜65151 の空いているポートを選びます（`49152 + random(16000)`）。
- すでに待ち受けのあるポートは `EADDRINUSE` です。同じプロセスでも同じです。
- 待ち受けの種類:

| 種類 | 使う側 | 接続 | ホストに知らせるか |
|---|---|---|---|
| `raw` | 移植ランタイム（`net`・`http` など） | socketpair の上のバイト列 | 知らせる（`server-ready`・`ports()`） |
| `http` | 旧ランタイムの `http.Server` | HTTP のメッセージ（`http-req` など） | 知らせる |
| TCP だけ | 旧ランタイムの `net.Server` | —（プレビューからは `ECONNREFUSED`） | 知らせない |

- 待ち受けを始めると（種類 `raw` と `http`）、ホストに `server-ready { port, pid }` を送ります。閉じたとき、または
  プロセスが終わったときは `port-closed { port }` です。
- `execve` すると、そのプロセスの待ち受けは無くなります（Node は stdio 以外のすべての fd に close-on-exec を付けます）。
- 待ち受けのソケットをほかのプロセスへ送ると（`child.send(msg, server)`）共有になります。受け取ったプロセスは
  `listenShare` を呼び、接続は動いている持ち主のあいだで順番に配られます。持ち主が終わると、次の受け手がポートを
  引き継ぎます。

### 接続

`tcpConnect` は socketpair を作ります。待ち受けているプロセスは片方の端を新しい fd（空いている 3 以上の最小の番号）と
`tcp-accept` のメッセージで受け取り、呼んだ側はもう片方を受け取ります。socketpair は、ブロックしない書き手に対して
向きごとに 212992 バイトまでためます（[パイプ](processes.ja.md#パイプ)）。待ち受けているプロセスに空いている
ファイル記述子が無いとき（`EMFILE`）は受け付けられず、接続は拒否されます。

つなぐ側は、Linux の既定の範囲 32768〜60999 からエフェメラルポートをもらいます。前に渡した番号の次（始まりはランダム）で、
待ち受けに使われているポートと、開いているほかの接続が持っているポートは飛ばします。つなぐ側の端を閉じると、
そのポートはまた空きます。アドレスの細部:

| 接続元 | サーバーから見た `remoteAddress` / `remotePort` |
|---|---|
| プロセス（`tcpConnect`） | `127.0.0.1`（IPv6 のアドレスへつないだときは `::1`）/ そのエフェメラルポート（つなぐ側の `localPort`） |
| プレビュー、または旧ランタイムの HTTP の要求 | `127.0.0.1` / エフェメラルポート |
| Unix ドメインソケット | `''` / `0` |

### プレビューからの HTTP

プレビューの iframe の要求は、HTTP のメッセージとしてカーネルに届きます（[プレビュー](preview.ja.md)）。`raw` の待ち受けには、
カーネル（`src/kernel/tcp.ts`）が接続を開いて HTTP/1.1 で話します。

- 要求のヘッダーのうち `connection`・`keep-alive`・`transfer-encoding`・`upgrade`・`sec-websocket-key`・
  `sec-websocket-version` は取り除きます。`Host` が無ければ `Host: localhost:<port>` を足します。
- ふつうの要求には `Connection: close` を付けます。本文があって `Content-Length` の無い要求は
  `Transfer-Encoding: chunked` で送ります。
- WebSocket の要求には `Connection: Upgrade`・`Upgrade: websocket`・`Sec-WebSocket-Version: 13` と、ランダムな
  `Sec-WebSocket-Key` を付けます。
- 応答は読み解きます。`101` 以外の `1xx` は読み飛ばします。本文の終わりは、`Content-Length`・chunked
  （トレーラーは読んで捨てる）・接続の終わりのどれかで決めます。`204` と `304` は本文がありません。応答のヘッダーから
  `transfer-encoding`・`connection`・`keep-alive` を取り除きます。
- エラー: 応答の頭が来る前に接続が閉じた → `socket hang up`。本文が途中で切れた → `incomplete response`。
  誰も待ち受けていない → `connect ECONNREFUSED 127.0.0.1:<port>`。
- `101 Switching Protocols` のあとは、接続に WebSocket のフレームが流れます。テキストとバイナリのメッセージは
  そのまま渡し、ping には pong で答え、close のフレームで終わります（コードが無ければ 1005）。close のフレーム無しに
  接続が終わったときはコード 1006 を知らせます。

旧ランタイムの `http` の待ち受けには、要求を `http-req` のメッセージとして待ち受けているスレッドへ送ります。その前に
プロセスが終わると、要求は `server process exited` で失敗します。

### Unix ドメインソケット

- `listen(path)` は、そのパスにソケットのファイル（`S_IFSOCK`、mode 0o755）を作ります。名前がすでにあれば
  `EADDRINUSE` です。
- 待ち受けはソケットの inode で区別するので、ファイルの名前を変えてもかまいません。シンボリックリンク越しにもつながります。
- `connect(path)` は、ファイルがソケットでないとき、または誰も待ち受けていないとき `ECONNREFUSED` です。
- サーバーを閉じると、ソケットのファイルが同じ inode のままなら消します。プロセスが終わるか `execve` すると、
  そのプロセスの Unix の待ち受けは無くなります。

### UDP

- ポートの名前空間は別です（UDP のポートは TCP のポートとぶつかりません）。
- ポート `0` に割り当てると、49152〜65151 の空いているポートを選びます。使われているポートは `EADDRINUSE` ですが、
  `reuseAddr` を付ければ、プロセスどうしで共有します。
- データグラムはポートだけで届け先を決めます。誰も割り当てていないポートへのデータグラムは失われます。割り当て済みの
  ポートへのものは、受信しているメンバーが現れるまで最大 1024 個まで列で待ち、受信しているメンバーに順番に配ります。
- 送り手のアドレスは割り当てたアドレスです。無いとき、または `0.0.0.0` のときは `127.0.0.1` です。

### ループバックと代わりのアドレス

何がローカルかは、移植ランタイムが決めます（`src/nodejs/bindings/net.ts`）。

- `connect` でループバックとみなすもの: `localhost`・`127.*`・`::1`・`0.0.0.0`・`::`・空・`::ffff:127.0.0.1`。
  これらは仮想ポートへ行き（`tcpConnect`）、それ以外のアドレスは外へ行きます（`tcpConnectOut`）。
- `dns.lookup('localhost')` と、`.localhost` で終わる名前は `127.0.0.1` と `::1` になります。IP アドレスはそのまま返します。
- それ以外の名前には、`198.18.0.0/15` から代わりの IPv4 アドレスを付けます。最初に引いた順に（プロセスごとに）
  `198.18.0.1`・`198.18.0.2`・… です。代わりのアドレスに接続すると、もとの名前がカーネルに渡り、要求はその
  ホストへ出ていきます。そうした名前の IPv6 は見つかりません（`ENOTFOUND`）。`resolve4`/`resolveAny` は代わりの
  アドレスを返します。

## 外への接続

ブラウザはソケットを開けません。プロセスがループバック以外のアドレスに TCP でつなぐと（`tcpConnectOut`）、
プロセスは socketpair の片方の端を受け取ります。カーネルはもう片方の端から HTTP/1.1 の要求を読み
（`src/kernel/outbound.ts`）、1 つずつ、ランタイムの Service Worker の方針を通すプロキシ（`<RUNTIME_BASE>/__ov/net`）
経由の `fetch` で出し、応答を HTTP/1.1 のバイト列として書き戻します。このため、自前の HTTP クライアントを持つ
ライブラリ（undici・axios・got）も、そのまま動きます。

### 要求の読み取り

| 決まり | ふるまい |
|---|---|
| 最初のバイト | 要求の行に見えること（`/^[A-Z]{3,10} /`）。それ以外（別のプロトコル、本物の TLS のハンドシェイク）は、応答せずに接続を閉じる |
| 要求の行 | `METHOD target HTTP/1.0` または `HTTP/1.1`。違えば `400 Bad Request` を返して閉じる |
| 頭の大きさ | 空行まで最大 1 MiB。超えたら接続を閉じる |
| 本文 | `Transfer-Encoding: chunked`（拡張とトレーラーは無視）か `Content-Length`。どちらも無ければ空 |
| keep-alive | HTTP/1.1 は `Connection: close` が無ければ続ける。HTTP/1.0 は `Connection: keep-alive` のときだけ。1 本の接続の要求は 1 つずつ順に処理する |
| WebSocket | `Upgrade: websocket` には `501 Not Implemented` を返して閉じる |
| URL | 絶対形式の target はそのまま使う。そうでなければ `http(s)://` + `Host` ヘッダー（無ければ接続先のホスト。80/443 以外は `:port` 付き）+ パス |

### 転送と応答

- 要求のヘッダーのうち `connection`・`keep-alive`・`proxy-connection`・`transfer-encoding`・`upgrade`・`te`・`trailer`・
  `host`・`content-length` は送りません。Service Worker はさらに削ります（[ネットワークの方針](network-policy.ja.md)）。
- `GET` と `HEAD` はそのまま送り、ほかのメソッドは本当のメソッドを `x-ov-method` に入れて `POST` で送ります。
  許可を求める画面に出る送り主は `<pid> <argv[0..2]>`（最大 200 文字）です。
- 応答は `HTTP/1.1 <status> <statusText>` で書きます（statusText が空なら `OK`）。`fetch` が本文をすでに展開しているので
  `content-encoding`・`content-length`・`transfer-encoding`・`connection`・`keep-alive` を取り除き、本文を
  `Transfer-Encoding: chunked` で区切り直します。`204`・`304`・`1xx` と `HEAD` への応答には本文がありません。
- リダイレクトはブラウザがたどります。

### エラー

エラーは errno ではなく HTTP の応答になります。接続そのものは「できた」ことになっているからです。

| 状況 | 応答 |
|---|---|
| ネットワークの方針がそのホストを拒んだ | `403 Forbidden` |
| `fetch` が失敗した（ネットワークのエラー、CORS）、またはプロキシが失敗した | `502 Bad Gateway` |

どちらも `Content-Type: text/plain`・`Content-Length`・`Connection: close`・`X-OpenVessel-Error: 1` を持ち、本文は
メッセージです（たとえば `OpenVessel: network access to example.com was denied by the network policy`）。そのあと
接続は閉じます。外へ出られるのは HTTP/1.1 だけです。ほかのプロトコルや、生のソケットでの外への WebSocket は
使えません。

### TLS の素通し

通信路の上では TLS をしません。プロセスが外への接続に TLS をかけると（`tls.connect`、`https`）、プロセスの TLS の層は
TLS を始めるときに `tcpSetTls` を呼びます。カーネルはその接続を `https` として記録し（SNI の `servername` を
ホストにします）、プロセスの TLS の層は平文をそのまま通します。本物の TLS と証明書の確認は、ブラウザの `fetch` が
します。OpenVessel の中のプロセスどうしでは、TLS の接続の両端が `tlsHello` で証明書を交換し、バイト列はやはり平文の
ままです。`tls` の API への影響は [互換性](../compatibility.ja.md) を見てください。

## ES モジュールの配信

`src/kernel/esm.ts` は、VFS のファイルをブラウザの ES モジュールとして配ります。ランタイムの Service Worker が
（`RUNTIME_BASE` の下の）次の URL をカーネルへ回し、答えを `Content-Type: text/javascript; charset=utf-8` と
`Cache-Control: no-store` で返します。

| URL | 答え |
|---|---|
| `/__ov/esm/<絶対パス>[?query]` | そのファイルを ES モジュールにしたもの |
| `/__ov/builtin/<name>` | 組み込みのモジュール（`node:fs` など）を `globalThis.__ov.builtin(name)` から export し直すモジュール |
| `/__ov/esm-error?code=…&msg=…&names=…` | 解決できない import の代わり。`names` の名前（`default` も）を 1 回ずつ宣言し、評価されると `code` と `msg` の `Error` を投げる。import する側のモジュールはリンクできる |
| `/__ov/mw/<pid>/<id>.mjs` | `esmRegister` で登録したソース（移植ランタイムの `ModuleWrap`）。知らないキーには `ERR_INTERNAL_ASSERTION` を投げるモジュール |

生成するモジュールに書き込む URL は `RUNTIME_BASE` から始まる絶対 URL なので、ランタイムをサブパスで配信しても
動きます。

形式ごとの、ファイルからモジュールへの変え方:

| 形式 | モジュール |
|---|---|
| `module`（`.mjs`・`"type": "module"`・ES の構文と判定したもの） | import の指定子を上の URL に書き換え、`import.meta` → `globalThis.__ov.meta(<ファイルの URL>)`、`import()` → `globalThis.__ov.dimport(…)`、import の属性を取り除き、`#!` の行をコメントにし、`//# sourceURL=file://…` を足したソース |
| `module-typescript`（`.mts`、`"type": "commonjs"` の外の `.ts`） | sucrase で型を除いてから `module` と同じ |
| `commonjs`・`commonjs-typescript` | 表向きのモジュール: `default` = `globalThis.__ov.requireForImport(file)` の `module.exports`。cjs-module-lexer で見つけた名前付きの export も付ける（再 export は 8 段までたどる） |
| `json`（または `with { type: 'json' }` のときに付く `?ov-json`） | `export default JSON.parse(…)` |
| `addon`（`.node`） | エラー `ERR_DLOPEN_FAILED` |
| `wasm` | エラー `ERR_UNKNOWN_FILE_EXTENSION` |
| ファイルが無い / ディレクトリ | `ERR_MODULE_NOT_FOUND` / `ERR_UNSUPPORTED_DIR_IMPORT` |

モジュールを作れないときは、そのコードの `Error` を投げるモジュールで答えるので、エラーは import したところで
表に出ます。作ったモジュールはパスごとに、inode の番号・mtime・大きさをキーにして覚えておきます。4000 個を超えたら
すべて捨てます。`esmRegister` で登録したソースは、そのプロセスが終わると捨てます。旧ランタイムは ES モジュールを
`/__ov/esm/` から読み、移植ランタイムは自分でコンパイルするソースを登録して `/__ov/mw/` から読みます。

## 組み込みのプログラム

### 登録されているプログラム

組み込みのプログラムは名前で登録し、`#!/ov/builtin <name>` と書いた実行できる小さなファイル（mode 0o755）として
置きます。`PATH` にファイルが見つからなくても、登録された名前と同じコマンド名なら、その組み込みを動かします。

| ディレクトリ | プログラム |
|---|---|
| `/bin` | `sh`・`bash`・`dash`（同じシェル。[シェル](shell.ja.md)） |
| `/bin` | `ls`・`cat`・`mkdir`・`mkfifo`・`rm`・`rmdir`・`cp`・`mv`・`touch`・`ln`・`chmod`・`head`・`tail`・`wc`・`grep`・`egrep`・`fgrep`・`find`・`sort`・`uniq`・`cut`・`tr`・`sed`・`xargs`・`tee`・`env`・`which`・`basename`・`dirname`・`realpath`・`readlink`・`stat`・`du`・`df`・`free`・`date`・`sleep`・`uname`・`ps`・`kill`・`seq`・`yes`・`mktemp`・`base64`・`diff`・`clear`・`nproc`・`id`・`hostname`・`whoami`・`tty`・`stty`・`nohup`・`nice`・`less`・`more`・`file`・`rev`・`nl`・`timeout`・`time`・`truncate`・`sha256sum`・`sha1sum`・`sha512sum`・`md5sum`・`echo`・`printf`・`test`・`[`・`true`・`false`・`pwd`・`chown`（何もしない）・`sync`（何もしない） |
| `/usr/bin` | `env`（`#!/usr/bin/env` の行のための 2 つめ） |
| `/usr/bin` | `node`（`#!/ov/builtin node`。node のプロセスを起動する）と `nodejs`（`/usr/bin/node` へのシンボリックリンク） |
| `/usr/bin` | `npm`・`pnpm`・`yarn`・`bun`・`npx`・`pnpx`・`bunx`・`corepack`（[パッケージマネージャ](package-managers.ja.md)） |
| `/usr/bin` | `curl`・`wget` |

### curl と wget

`curl` と `wget` は、`npm` と同じ、方針を通すプロキシで取りに行きます。`curl` で使えるオプション:

| オプション | 効果 |
|---|---|
| `-X`・`--request <method>` | 要求のメソッド（既定 `GET`） |
| `-o`・`--output <file>` | 本文をファイルに書く |
| `-O`・`--remote-name` | URL のパスの最後の部分に書く（空なら `index.html`） |
| `-H`・`--header '<name>: <value>'` | 要求のヘッダーを足す |
| `-d`・`--data`・`--data-raw`・`--data-binary <data>` | 要求の本文。`GET` を `POST` に変える |
| `-I`・`--head` | `HEAD` の要求。状態の行とヘッダーだけ出す |
| `-i`・`--include` | 本文の前に状態の行とヘッダーを出す |
| `-f`・`--fail` | 状態が 400 以上なら `curl: (22) The requested URL returned error: <status>` を出して 22 で終わる |
| `-s`・`--silent`、`sSLfk` を組み合わせた短いフラグ | 受け付ける（組み合わせの中の `f` は `--fail`） |
| `-L`・`--location`・`-k`・`--insecure`・`--compressed` | 受け付ける。リダイレクトはいつもたどる |

スキームの無い URL には `http://` を付けます。終了コード: 0 成功、2 URL が無い（`curl: no URL specified!`）、
7 要求の失敗（`curl: (7) <message>`。方針による拒否も含む）、22 `--fail` のとき。`wget <url>` は URL のパスの最後の部分
（空なら `index.html`）に保存し、`wget -O <file> <url>` は `<file>` に、`-O -` は標準出力に書きます。ふるまいは
`curl -fsSL` と同じです。

## 起動時のファイルシステム

起動したときにカーネルが作るもの（`src/kernel/kernel.ts`・`src/kernel/index.ts`・`src/kernel/coreutils.ts`・
`src/kernel/npm/cli.ts`・`src/kernel/curl.ts`）:

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
| `/dev/fd` | ディレクトリ | 空。`/dev/fd/N` はプロセスごとに答える |
| `/dev/stdin`・`/dev/stdout`・`/dev/stderr` | シンボリックリンク | `/proc/self/fd/0`・`/1`・`/2` へ |
| `/proc/cpuinfo` | ファイル | `navigator.hardwareConcurrency`（不明なら 4）の数だけの項目（`processor`、`model name : OpenVessel Virtual CPU`、`cpu MHz : 2400.000`、`cpu cores`）。移植ランタイムの `os.cpus()` と同じ数 |
| `/proc/meminfo` | ファイル | `MemTotal: 8388608 kB`、`MemFree: 4194304 kB`、`MemAvailable: 4194304 kB`（移植ランタイムの `os.totalmem()` と `os.freemem()`） |
| `/proc/version` | ファイル | `Linux version 6.8.0-openvessel (user@openvessel) #1 SMP OpenVessel`（移植ランタイムの `os.release()` と `os.version()`） |
| `/bin/*`・`/usr/bin/*` | 実行できる小さなファイル | [登録されているプログラム](#登録されているプログラム) を参照 |
| `/usr/bin/nodejs` | シンボリックリンク | `/usr/bin/node` へ |
| `/home/user/.shrc` | ファイル | `alias ll='ls -l'`、`alias la='ls -la'` |

通常のファイルは mode 0644 で作ります。`/etc/openvessel/node` は起動時にはありません（旧ランタイムを使います）。
ホストが置くファイルは、既定で `/home/user/app` に入ります（[ホスト API](host-api.ja.md)）。ホスト名は `openvessel` です。

## 既定の環境変数

`kernel.defaultEnv()` は、ホストが起動するプロセスの環境変数（ホストが渡す `env` と合わせたもの）と、親の無いプロセスの
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
| `NAPI_RS_FORCE_WASI` | `1`（napi-rs のパッケージが WebAssembly 版を読む） |

子プロセスは、呼び出し側が渡さない限り、親の環境変数の写しを受け継ぎます。シェルは自分の変数を足します（`PWD` など。
[シェル](shell.ja.md)）。
