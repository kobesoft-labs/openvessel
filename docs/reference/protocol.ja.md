# 通信の形式

[English](protocol.md)

OpenVessel の部品どうしのやり取りの形です。ホスト ↔ ランタイムの手順と RPC、カーネルのイベント、プレビューの中継と
プレビューの通り道、ランタイムの Service Worker の `/__ov/…` の窓口、カーネルとプロセスの Worker のメッセージ、同期の
システムコールの通り道をまとめます。不具合を調べる人と、`dist/host` を使わずに自分でホストを書く人のためのページです。

> **安定性。** semver の対象は、ホスト API（`dist/host` とその型宣言）と、3 つのオリジンで埋め込むための条件だけです
> （[CHANGELOG](../../CHANGELOG.md) の「Stability」）。このページの内容はすべて内部のもので、`src/` の内部と
> `dist/runtime`・`dist/preview` の中のファイルは、パッチのリリースを含めてどのリリースでも変わりえます。自分で書く
> ホストは、OpenVessel のある 1 つの版に合わせて作る必要があります。

## 通り道の一覧

| あいだ | 運び方 | 形 | ソース |
|---|---|---|---|
| ホストのページ ↔ ランタイムの iframe | `window.postMessage` | `{ t: 'openvessel-…' }` | `src/host/index.ts`・`src/runtime/runtime.ts` |
| ホストのページ ↔ カーネル | `MessagePort`（手順の中で渡す） | RPC `{ id, m, a }`／`{ id, r }`／`{ id, e }`、イベント `{ ev, … }` | `src/kernel/index.ts` |
| ランタイムの iframe → カーネルの Worker | `Worker.postMessage` | `{ t: 'host-port' \| 'sw-port' \| 'policy' }` | `src/runtime/runtime.ts` |
| ランタイムの Service Worker ↔ カーネル | `MessagePort` | `{ id, k: 'esm' \| 'net', … }` | `src/runtime/sw.ts` |
| プロセス・カーネルのコード → ランタイムの Service Worker | HTTP（`fetch`・`import`・同期の XHR） | `/__ov/…` の URL | `src/runtime/sw.ts` |
| ホストのページ ↔ プレビューの中継の iframe | `window.postMessage` | `{ t: 'openvessel-preview-…' }` | `src/host/index.ts`・`src/preview/relay.ts` |
| 中継 ↔ プレビューの Service Worker | `ServiceWorker.postMessage` | `{ t: 'kernel-port' \| 'default-port' \| 'need-kernel-port' }` | `src/preview/relay.ts`・`src/preview/sw.ts` |
| プレビューの Service Worker ↔ カーネル | `MessagePort` | `{ id, k: 'req' \| 'body' \| … }` | `src/preview/sw.ts`・`src/kernel/index.ts` |
| プレビューのページ ↔ プレビューの Service Worker | `postMessage` と、WebSocket ごとの `MessagePort` | `{ t: 'ws-connect' }`、`{ t: 'open' \| 'msg' \| 'close' \| 'send' }` | `src/preview/inject.ts` |
| カーネル ↔ プロセスの Worker | `Worker.postMessage` | `{ t: … }` | `src/kernel/kernel.ts`・`src/kernel/syscalls.ts`・`src/kernel/net.ts` |
| プロセスの Worker → カーネル（システムコール） | `SharedArrayBuffer` と `Atomics` | JSON とバイナリ | `src/shared/syncchan.ts` |

## ホスト ↔ ランタイムの手順

```text
host page                                   runtime.html (runtime origin)
─────────                                   ─────────────────────────────
append <iframe src=".../runtime.html" allow="cross-origin-isolated">
                              ◀──────────── { t: 'openvessel-runtime-loaded' }            (to '*')
new MessageChannel()
{ t: 'openvessel-connect', port, init } ──▶  checks; registers sw.js; starts kernel.js
   (to the runtime origin, port transferred)  kernel ◀ { t: 'policy', policy }   (if init.policy)
                                              kernel ◀ { t: 'sw-port', port }
                                              sw.js  ◀ { t: 'kernel-port', port }
                                              kernel ◀ { t: 'host-port', port }
port ◀──────────────────────────────────────  { ev: 'ready' }                    (from the kernel)
```

### window のメッセージ

| メッセージ | 向き | フィールド | 注意 |
|---|---|---|---|
| `openvessel-runtime-loaded` | ランタイム → 親 | — | `runtime.js` が動いたとき、宛先 `'*'` で送る |
| `openvessel-connect` | ホスト → ランタイム | `port: MessagePort`・`init: { policy?: Partial<NetworkPolicy> }` | `window.parent` からのものを 1 回だけ受け付ける。`port` が `MessagePort` でなければ無視する |
| `openvessel-error` | ランタイム → 親 | `message: string` | 宛先 `'*'` で送る |

ホストがランタイムのメッセージを受け取るのは、`ev.origin` がランタイムのオリジンで、`ev.source` がその iframe のときだけです。

### `runtime.js` の確認とエラー

| 順 | 確認 | `openvessel-error` のメッセージ |
|---|---|---|
| 1 | `ev.origin` が `<meta name="openvessel-allowed-hosts">` にある（空白かカンマで区切る。`*` はどこでも） | `origin <origin> is not allowed to use this runtime` |
| 2 | `location.ancestorOrigins` が（あれば）1 つ以下 | `the runtime must be embedded directly by the host page` |
| 3 | `crossOriginIsolated` | `OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).` |
| 4 | Service Worker の登録 | `service worker registration failed: <message>` |
| あと | カーネルの Worker の `error` イベント | `kernel failed: <message>` |

1 か 2 で失敗したあとも、ランタイムは次の `openvessel-connect` を受け付けます。ホストは最初の `openvessel-error` で
`boot()` を `OpenVessel: <message>` で reject し、`timeout`（既定 30000 ms）のうちに `ready` が来なければ
`OpenVessel: runtime did not start in time` で reject します。`boot()` が解決したあとに来た `openvessel-error` を、
`dist/host` は知らせません。

`runtime.js` の Service Worker の立ち上げ: `register('./sw.js', { scope: './', updateViaCache: 'none' })` のあと
`reg.update()`。Worker が installing か waiting のあいだは `controllerchange` を待ち、続いて `navigator.serviceWorker.ready`
を待ちます。それでもページに controller が無ければ `controllerchange` を待ちます（Worker は activate で `clients.claim()` を呼びます）。

### カーネルの Worker へのメッセージ

| メッセージ | 送り手 | はたらき |
|---|---|---|
| `{ t: 'policy', policy }` | `runtime.js`。`init.policy` があれば `host-port` の前に | 通信の方針を（整えて）設定する |
| `{ t: 'sw-port', port }` | `runtime.js`。起動時と、`controllerchange`・`need-kernel-port` のたびに | ランタイムの Service Worker への通り道をつなぐ |
| `{ t: 'host-port', port }` | `runtime.js` | ホストへの通り道をつなぎ（前のものは置き換える）、そこに `{ ev: 'ready' }` を送る |

## ホストの RPC

### 形

| メッセージ | 形 |
|---|---|
| 呼び出し（ホスト → カーネル） | `{ id: number, m: string, a: object }` |
| 結果（カーネル → ホスト） | `{ id, r: any }`。結果が `Uint8Array` なら（その `buffer` を）transfer する |
| エラー（カーネル → ホスト） | `{ id, e: { message: string, code?: string } }` |
| 知らないメソッド | `{ id, e: { message: 'unknown method <m>', code: 'ENOSYS' } }` |
| イベント（カーネル → ホスト） | `{ ev: string, … }`（`id` は無い） |
| プレビューの通り道の受け渡し（ホスト → カーネル。呼び出しではない） | `{ t: 'preview-port', port: MessagePort }` |

メソッドは同期のものも promise を返すものもあり、終わった順に答えます。ファイルシステムが投げるエラーは、errno の
`code`（`ENOENT`・`EEXIST`・`ENOTDIR`・`EISDIR`・`ENOTEMPTY` など）と errno の文（たとえば `no such file or directory`）を
`message` に持つ `KernelError` です。`dist/host` は `e` を `code` 付きの `Error` にします。

```js
// a minimal call over the host port
let next = 1;
const pending = new Map();
port.onmessage = ({ data }) => {
  if (data.id !== undefined && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.e ? reject(Object.assign(new Error(data.e.message), { code: data.e.code })) : resolve(data.r);
  } else if (data.ev) console.log('event', data);
};
const call = (m, a = {}) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { resolve, reject });
  port.postMessage({ id, m, a });
});
await call('ping'); // 'pong'
```

### メソッド

| メソッド | 引数（`a`） | 結果 |
|---|---|---|
| `ping` | — | `'pong'` |
| `fs.readFile` | `path`・`encoding?`（真ならどんな値でも UTF-8） | `Uint8Array`（コピー）。`encoding` があれば `string` |
| `fs.writeFile` | `path`・`data: string \| Uint8Array \| ArrayBuffer`・`mode?`（既定 `0o644`）・`mkdirs?`（既定 `true`: 親のディレクトリを作る） | `null` |
| `fs.mkdir` | `path`・`recursive?`（既定 `true`） | 最初に作ったディレクトリ（recursive のとき）か `null` |
| `fs.readdir` | `path`・`withTypes?` | `string[]`。`withTypes` があれば `{ name, type: 'dir' \| 'symlink' \| 'file' }[]`（ほかの種類はすべて `'file'`） |
| `fs.rm` | `path`・`recursive?`・`force?`（既定 `true`） | `null`。recursive なら `rm -rf` と同じ（`force: false` で無ければ `ENOENT`）。そうでなければ、ディレクトリは `rmdir`、ほかは `unlink`（シンボリックリンクはたどらない） |
| `fs.stat` | `path`（シンボリックリンクはたどる） | `{ dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs, isDirectory, isFile }` |
| `fs.exists` | `path` | `boolean` |
| `fs.rename` | `from`・`to` | `null` |
| `mount` | `files: Record<string, string \| Uint8Array \| ArrayBuffer \| null \| { dir: true } \| { symlink: string }>`・`path?`（既定 `/home/user/app`） | 項目の数。キーは `path` からの相対。`null` か `{ dir }` はディレクトリ、`{ symlink }` はシンボリックリンク（リンク先は渡したまま）、ほかはファイル（mode `0o644`、親は作る）。`.sh`/`.bash` で終わるファイルと、`#!` で始まる文字列の中身には実行のビットを付ける |
| `export` | `path`・`exclude?`（既定 `['node_modules', '.git']`。どの深さの名前とも照らし合わせる） | ふつうのファイルの `Record<string, Uint8Array>`。キーは `path` からの相対。シンボリックリンクは飛ばす |
| `spawn` | `argv: string[]`・`cwd?`（既定 `/home/user`。無ければ作る）・`env?`（既定の環境変数に重ねる）・`terminal?: { cols?, rows? }`（既定 80 × 24） | `{ pid }`。プロセスはそれぞれ自分のプロセスグループで始まる。`terminal` があれば stdin/stdout/stderr は 1 つの TTY、無ければ 3 本のパイプ |
| `input` | `pid`・`data: string \| Uint8Array \| null` | ホストが起動したプロセスでない、またはもう終わっていれば `false`。ほかは `true`。TTY: バイト列は行の規律を通る。パイプ: stdin に書く。`null` で stdin を閉じる。書き込みのエラーは無視する |
| `resize` | `pid`・`cols`・`rows` | `null`（端末のプロセスだけ。`SIGWINCH` を届ける） |
| `kill` | `pid`・`signal?`（既定 `'SIGTERM'`） | `null`。そのプロセスのプロセスグループ全体にシグナルを送る。エラー（知らない pid）は無視する |
| `ps` | — | 動いているプロセスの `{ pid, ppid, argv, cwd }[]` |
| `ports` | — | プレビューから届く待ち受けの `{ port, pid }[]`（旧ランタイムの `net.Server` の待ち受けは除く） |
| `network.setPolicy` | `policy: Partial<NetworkPolicy>` | 整えた方針 |
| `network.getPolicy` | — | いまの方針 |
| `network.clearSession` | — | `null`。「このセッション中は」の許可と拒否を忘れる |
| `permission.respond` | `id`・`decision: 'once' \| 'session' \| 'deny' \| 'deny-session'`（ほかは `deny`） | その問い合わせが無ければ `false`、あれば `true` |
| `watch` | `path`・`id`（呼ぶ側が決める） | `null`。以後、`path` とその下の変更ごとに、その `id` の `fs-change` イベント |
| `unwatch` | `id` | `null` |
| `debug.trace` | `on` | 新しい値（カーネルのトレースのログをコンソールに出すかどうか） |
| `debug.esm` | `pathname`・`search?` | `{ status, body, type }`。その `/__ov/…` のパスにランタイムの Service Worker が返すもの |

既定の環境変数は `PATH=/usr/local/bin:/usr/bin:/bin`・`HOME=/home/user`・`USER=user`・`LOGNAME=user`・`SHELL=/bin/sh`・
`TERM=xterm-256color`・`LANG=en_US.UTF-8`・`TMPDIR=/tmp`・`HOSTNAME=<カーネルのホスト名>`・`NAPI_RS_FORCE_WASI=1` です。
[カーネル](kernel.ja.md) と [ホスト API](host-api.ja.md) も見てください。

### イベント

| イベント | フィールド | いつ |
|---|---|---|
| `ready` | — | ホストへの通り道をつないだ直後 |
| `output` | `pid`・`data: Uint8Array`・`stream?: 'stdout' \| 'stderr'` | ホストが起動したプロセスの出力。端末のプロセスには `stream` が無い。パイプは最大 65536 バイトずつ読む |
| `exit` | `pid`・`code: number`・`signal: string \| null` | ホストが起動したプロセスが終わった（パイプのプロセスは、stdout と stderr が EOF になったあと） |
| `server-ready` | `port`・`pid` | プロセスが、プレビューから届くポートで待ち受けた |
| `port-closed` | `port` | その待ち受けが無くなった |
| `fs-change` | `id`・`type: 'rename' \| 'change'`・`path` | 監視しているパスの下の変更 |
| `permission-request` | `id`・`url`・`host`・`initiator`・`source: 'runtime' \| 'preview'` | あるホストについて方針が `ask` と言った。`permission.respond` で答える |
| `permission-settled` | `id`・`host`・`allowed: boolean` | 許可の問い合わせに答えが出た、または時間切れになった |

許可の問い合わせ: カーネルは、同じホスト名への同時の問い合わせを 1 つにまとめ（待っている全員に同じ答えを返す）、
5 分のうちに答えが無ければ拒否し、ホストへの通り道がつながっていなければすぐに拒否します。`session`／`deny-session` の
答えは、`network.clearSession` までホスト名ごとに覚えます。`initiator` は、パッケージマネージャなら `npm`、プロセスなら
`<pid> <argv…>`（最大 200 文字）、分からなければ `process`、プレビューなら `preview` です。[通信の方針](network-policy.ja.md)
を参照してください。

`dist/host` は `exit` を `process-exit` として出し直し、`server-ready` に `url` を足し、`permission-request` には自分で
（`onPermissionRequest` か組み込みのダイアログで）答えます。

## プレビューの中継

### ホスト ↔ 中継の iframe（`window.postMessage`）

| メッセージ | 向き | フィールド | 注意 |
|---|---|---|---|
| `openvessel-preview-loaded` | 中継 → 親（`'*'`） | — | プレビューの Service Worker を登録し、準備ができたあと |
| `openvessel-preview-connect` | ホスト → 中継 | `port: MessagePort`・`defaultPort: number` | もう片方の端は、ホストが `{ t: 'preview-port', port }` でカーネルに送ってある |
| `openvessel-preview-ready` | 中継 → 親（`'*'`） | — | ポートを Service Worker に渡した |
| `openvessel-preview-default-port` | ホスト → 中継 | `port: number` | 2 回目からの `previewUrl()` のたびに送る |
| `openvessel-preview-need-port` | 中継 → 親（`'*'`） | — | Service Worker が通り道をなくした。ホストは新しい `openvessel-preview-connect` で答える |

中継は `window.parent` からのメッセージだけを、ホストはプレビューのオリジンの中継の iframe からのメッセージだけを
受け取ります。ホストは `openvessel-preview-loaded` にも `openvessel-preview-need-port` にも、新しい通り道を作って答えます。

### 中継 ↔ プレビューの Service Worker

| メッセージ | 向き | フィールド | 受け付ける条件 |
|---|---|---|---|
| `kernel-port` | 中継 → SW | `port: MessagePort`・`defaultPort: number` | 送り手の URL のパスが `/relay.html` で終わる。0 でない `defaultPort` は既定のポートを置き換える |
| `default-port` | 中継 → SW | `port: number` | 送り手のパスが `/relay.html` で終わる |
| `need-kernel-port` | SW → パスが `/relay.html` で終わるすべての window のクライアント | — | SW に通り道が要るのに無い。最大 15 秒待つ（`preview is not connected to OpenVessel`） |

### プレビューのページ ↔ プレビューの Service Worker（WebSocket）

| メッセージ | 向き | フィールド |
|---|---|---|
| `ws-connect` | ページ → SW（`navigator.serviceWorker.controller`） | `port: MessagePort`（transfer）・`path`（パスとクエリ）・`protocols: string[]`・`vport: number`・`origin` |
| `open` | SW → ページ（そのポートで） | `protocol` |
| `msg` | SW → ページ | `data: string \| Uint8Array`・`binary: boolean` |
| `close` | SW → ページ | `code`・`reason`（SW にカーネルへの通り道が無いときは `1006`／`not connected`） |
| `send` | ページ → SW | `data: string \| Uint8Array`・`binary: boolean` |
| `close` | ページ → SW | `code`・`reason` |

ポートの選び方は [プレビュー](preview.ja.md#websocket) を参照してください。

## プレビューの通り道

プレビューの Service Worker とカーネルのあいだのものです（`src/kernel/index.ts` の `attachPreview`）。すべてのメッセージは、
Service Worker が決める数の `id` と文字列の `k` を持ちます。カーネルはそれ以外を無視します。

| `k` | 向き | フィールド | 意味 |
|---|---|---|---|
| `req` | SW → カーネル | `id`・`port`・`method`・`url`（パスとクエリ）・`headers: [string, string][]`・`hasBody` | HTTP の要求を始める |
| `body` | SW → カーネル | `id`・`data: Uint8Array`（transfer） | 要求の本文（SW はひとまとめで送る） |
| `body-end` | SW → カーネル | `id` | 要求の本文の終わり（本文を持つメソッドなら、空でも送る） |
| `abort` | SW → カーネル | `id` | ページが応答の本文を取り消した |
| `head` | カーネル → SW | `id`・`status`・`statusText`・`headers: [string, string][]` | 応答の頭 |
| `data` | カーネル → SW | `id`・`data: Uint8Array` | 本文の塊 |
| `end` | カーネル → SW | `id` | 応答の終わり |
| `error` | カーネル → SW | `id`・`msg` | 要求が失敗した（`connect ECONNREFUSED 127.0.0.1:<port>`・`socket hang up`・`incomplete response`・`server process exited` など） |
| `ws-open` | SW → カーネル | `id`・`port`・`url`・`headers` | WebSocket を開く |
| `ws-opened` | カーネル → SW | `id`・`protocol: string \| null` | サーバーが upgrade を受けた |
| `ws-msg` | 両方 | `id`・`data: string \| Uint8Array`・`binary` | メッセージ |
| `ws-close` | SW → カーネル | `id`・`code`（`Number(code) \|\| 1000`）・`reason` | ページから閉じる |
| `ws-closed` | カーネル → SW | `id`・`code`・`reason` | サーバーが閉じた、または開けなかった（`1006`、理由はエラーのメッセージ） |
| `net` | SW → カーネル | `id`・`url` | プレビューがこの外の URL を取ってよいか（initiator `preview`、source `preview`） |
| `net-result` | カーネル → SW | `id`・`allow: boolean` | 答え |

この通り道でカーネルにできることは、これだけです。ファイルシステム・プロセス・方針のメソッドは、ホストの通り道にしか
ありません。

## ランタイムの Service Worker

`dist/runtime/sw.js` は、スコープの中の同じオリジンへの要求を扱います。下のパスはランタイムのディレクトリからの相対です
（照らし合わせる前にスコープを取り除きます）。

### 窓口

| パス | メソッド | 答え |
|---|---|---|
| `/__ov/esm/<VFS の絶対パス>[?query]` | どれでも | カーネルが VFS のファイルから作る ES モジュール（[下](#モジュールの窓口)）。旧ランタイムが使う |
| `/__ov/builtin/<name>[.mjs]` | どれでも | 組み込みモジュール（`node:fs` など）をかぶせた ES モジュール。旧ランタイムが使う |
| `/__ov/mw/<pid>/<id>.mjs` | どれでも | 移植ランタイムが `esmRegister` のシステムコールで登録したモジュールのソース |
| `/__ov/net?url=<エンコードした URL>` | どれでも | 通信の関所（[下](#__ovnet)） |
| `/__ov/ping` | どれでも | `pong`（`text/plain`） |
| ほかのすべて | `GET` | サーバーから取り、分離のヘッダーが無ければ足す |
| ほかのすべて | ほか | 扱わない（サーバーへ行く） |

### モジュールの窓口

モジュールの応答は `content-type: <type>; charset=utf-8`・`cache-control: no-store`・
`cross-origin-resource-policy: same-origin` と、カーネルが返したステータスを持ちます。エラーは投げるモジュールとして
届けるので、`import` は正しい `code` で失敗します。

| 場合 | モジュールが投げるエラーの `code` |
|---|---|
| ファイルが無い | `ERR_MODULE_NOT_FOUND`（`Cannot find module '<path>'`） |
| ディレクトリ | `ERR_UNSUPPORTED_DIR_IMPORT` |
| `.node` のアドオン | `ERR_DLOPEN_FAILED`（`Native addons are not supported in OpenVessel: <path>`） |
| ES モジュールとしての `.wasm` | `ERR_UNKNOWN_FILE_EXTENSION` |
| `/__ov/mw/` の id が登録されていない | `ERR_INTERNAL_ASSERTION`（`module <pid>/<id> is not registered`） |
| 15 秒のうちにカーネルへの通り道が無い | ステータス 200、`text/javascript`、`throw new Error("OpenVessel kernel is not connected");` |

`/__ov/esm/` では、カーネルが形式ごとに変換します。JSON → `export default JSON.parse(…)`（クエリのパラメーター `ov-json`
でも強制できる）。CommonJS → `globalThis.__ov.requireForImport()` をかぶせ、`cjs-module-lexer` で見つけた名前を export
するもの。ES モジュール → 指定子を `/__ov/esm/…`・`/__ov/builtin/…` の URL に書き換え、`import.meta`・`import()` を
`globalThis.__ov` 経由にしたソース。TypeScript の ES モジュール → 先に sucrase で型を取り除く。結果は inode・mtime・
大きさでキャッシュします（4000 件を超えると空にします）。登録した `/__ov/mw/` のソースは、そのプロセスが終わると捨てます。

### `/__ov/net`

ランタイムからネットワークへの唯一の道です。使うのは、移植ランタイムの `fetch` と旧ランタイムの通信の層（プロセスの
Worker から）、カーネルの npm のクライアント（`initiator` は `npm`）、そしてカーネルの外向きの TCP の橋渡し（ソケットに
書かれた HTTP/1.1 をこの要求に変える。`src/kernel/outbound.ts`）です。

要求:

| 部分 | 中身 |
|---|---|
| URL | `<ランタイムの基準>/__ov/net?url=<encodeURIComponent(相手)>` |
| メソッド | `GET` と `HEAD` はそのまま。ほかはすべて本文付きの `POST` で送る |
| `x-ov-method` | 本当のメソッド（既定は要求のメソッド） |
| `x-ov-h` | `encodeURIComponent(JSON.stringify([[name, value], …]))`: 送るヘッダー |
| `x-ov-by` | 許可の確認に出す `encodeURIComponent(initiator)`（既定 `process`） |
| `x-ov-redirect` | `error` ならリダイレクトで失敗させる。ほか（または無し）はリダイレクトをたどる |

Service Worker はカーネルに尋ね（`{ k: 'net', url, initiator }`）、ブラウザが決めるヘッダー（`host`・`connection`・
`content-length`・`keep-alive`・`transfer-encoding`・`upgrade`・`te`・`trailer`・`expect`・`cookie`・`cookie2`・`origin`・
`referer`・`accept-encoding`・`access-control-request-headers`・`access-control-request-method`・`date`・`dnt`・`via`・
`proxy-connection`・`sec-*`・`proxy-*`）を除いて、`credentials: 'omit'`・`mode: 'cors'`・`cache: 'no-store'` で相手を
`fetch` します。

要求をしたときの応答（ステータスはいつも `200`）:

| ヘッダー | 中身 |
|---|---|
| `x-ov-status` | 本当のステータス |
| `x-ov-status-text` | URI エンコードしたステータスの文 |
| `x-ov-url` | URI エンコードした最後の URL（リダイレクトのあと） |
| `x-ov-redirected` | `1` か `0` |
| `x-ov-rh` | ブラウザが見せる応答のヘッダーの JSON を URI エンコードしたもの（CORS の決まりのとおり、safelist のものと `Access-Control-Expose-Headers` のものだけ） |
| `content-type` | 本当の content type。無ければ `application/octet-stream` |
| `cache-control` | `no-store` |

本文はストリームします。`204`・`205`・`304`・`HEAD` では空です。失敗:

| ステータス | `x-ov-error` | `x-ov-message`（URI エンコード。プレーンテキストの本文も同じ） |
|---|---|---|
| `403` | `denied` | `OpenVessel: network access to <host> was denied by the network policy` |
| `502` | `network` | `request to <host> failed: <message>. The server may not allow cross-origin requests (CORS) from the browser.` |
| `502` | `network` | カーネルへの通り道を得られなかった（`OpenVessel kernel is not connected`） |

移植ランタイムの `fetch` はこれらを `TypeError('fetch failed')` にし、その `cause` の `code` を `EACCES`（`denied`）・
`ETIMEDOUT`（`timeout`）・`ECONNREFUSED`（ほか）にします。外向きの TCP の橋渡しは、HTTP の `403` か `502` をソケットに書き戻します。

### Service Worker ↔ ランタイムのフレームとカーネル

| メッセージ | 向き | フィールド |
|---|---|---|
| `kernel-port` | `runtime.html` → SW | `port: MessagePort`。URL のパスが `/runtime.html` で終わる window のクライアントからだけ受け付ける |
| `ping` | `runtime.html` → SW | 無視する（`clients.claim()` で `controllerchange` が起きるように送るもの） |
| `need-kernel-port` | SW → パスが `/runtime.html` で終わるすべての window のクライアント | SW が通り道をなくした。`runtime.js` は新しい `sw-port`／`kernel-port` を送って答える |
| `{ id, k: 'esm', pathname, search }` | SW → カーネル | モジュールを読む |
| `{ id, status, body, type }` | カーネル → SW | そのモジュール |
| `{ id, k: 'net', url, initiator }` | SW → カーネル | `url` への方針の判断（`source` は `runtime`） |
| `{ id, allow }` | カーネル → SW | 答え |

Service Worker は通り道を最大 15 秒待ちます。カーネルの答えには時間切れがありません。

## カーネルとプロセスのメッセージ

プロセス（と `worker_threads` のスレッド）は、それぞれカーネルが作る Web Worker です。次のメッセージはその Worker の
`postMessage` で、システムコールは [同期の通り道](#同期のシステムコールの通り道) を使います。

### `init`

新しい Worker への最初のメッセージです。

| フィールド | 中身 |
|---|---|
| `t` | `'init'` |
| `kind` | `'main'` か `'thread'` |
| `pid`・`ppid`・`tid` | id |
| `argv`・`env`・`cwd` | プロセスのコマンドライン・環境変数・作業ディレクトリ |
| `sab` | システムコールの通り道の `SharedArrayBuffer`（4 MiB） |
| `ttys` | `{ 0, 1, 2 }` → TTY の記述子なら `{ cols, rows }`、ほかは `null` |
| `hostname` | カーネルのホスト名 |
| スレッドだけ | `file`・`eval`・`evalType`・`execArgv`・`workerData`・`envData`・`port`（transfer した `MessagePort`）・`name`・`threadId`・`resourceLimits`・`envRings`・`trackUnmanagedFds`・`sharedEnv` |

### プロセス → カーネル

| `t` | フィールド | 意味 |
|---|---|---|
| `sys` | — | 「共有のバッファにシステムコールの要求がある」 |
| `pong` | `id` | `ping` への答え |
| `readStart` | `fd` | `fd` のデータを `fd-data` で届け始める |
| `readStop` | `fd` | やめる |
| `readOnce` | `fd`・`len?`（既定 65536）・`id` | 1 回だけ読む。`id` 付きの `fd-data` で答える |
| `writeWait` | `fd` | パイプ・ソケットのバッファが空いたら `fd-writable` を送る |
| `threadSpawn` | `tid`・`file`・`eval`・`argv`・`port` など | `worker_threads` のスレッドを始める |
| `threadKill` | `tid` | スレッドを止める |
| `loop-req`・`loop-body`・`loop-body-end`・`loop-abort` | `crid`・`port`・`method`・`url`・`headers`・`data` | 旧ランタイム: 仮想ポートへの HTTP の要求 |
| `http-res`・`http-res-data`・`http-res-end`・`http-res-error` | `rid`・`status`・`statusText`・`headers`・`data`・`msg` | 旧ランタイム: `http-req` への応答 |
| `ws-open`・`ws-send`・`ws-close` | `rid`・`protocol`・`headers`・`data`・`binary`・`code`・`reason` | 旧ランタイム: WebSocket のサーバーの側 |

### カーネル → プロセス

| `t` | フィールド | 意味 |
|---|---|---|
| `ping` | `id` | 「それまでに送ったものを片付けたら答えて」（読んでいる相手がいるプロセスが終わるときに使う） |
| `fd-data` | `fd` か `id`・`data: Uint8Array \| null`（`null` は EOF）・`err?`・`handle?` | 読んだデータ。`handle` は IPC で受け取った記述子の説明 |
| `fd-writable` | `fd` | バッファが空いた |
| `signal` | `sig` | プロセスが扱うシグナル（と `SIGWINCH`） |
| `child-exit` | `pid`・`code`・`signal` | `spawn` のシステムコールで起動した子が終わった |
| `watch` | `id`・`type`・`path` | `watch` のシステムコールへのファイルシステムの変更 |
| `thread-exit` | `tid`・`code`・`initFailed?`・`terminated?` | スレッドが終わった |
| `thread-gone` | `tid` | 見張っていたスレッドがいなくなった |
| `tcp-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | 移植ランタイム: 待ち受けのポートへの新しい接続 |
| `pipe-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | 移植ランタイム: Unix ソケットへの新しい接続 |
| `tls-peer` | `fd`・`certs` | 相手の証明書（2 つのプロセスのあいだの TLS） |
| `udp-msg` | `port`・`data`・`from: { address, port }` | データグラム |
| `http-req` | `rid`・`port`・`method`・`url`・`headers`・`hasBody`・`upgrade?` | 旧ランタイム: サーバーへの HTTP の要求 |
| `http-body`・`http-body-end`・`http-abort` | `rid`・`data` | 旧ランタイム: 要求の本文・取り消し |
| `ws-msg`・`ws-close` | `rid`・`data`・`binary`・`code`・`reason` | 旧ランタイム: クライアントからの WebSocket |
| `loop-res`・`loop-res-data`・`loop-res-end`・`loop-res-error` | `crid` など | 旧ランタイム: `loop-req` への応答 |

## 同期のシステムコールの通り道

プロセスのスレッドは、それぞれ自分の `SharedArrayBuffer` を持ちます。Worker は要求を書き、カーネルに `{ t: 'sys' }` を
送り、カーネルが答えを書くまで `Atomics.wait` で止まります（`src/shared/syncchan.ts`）。

### 配置

| バイト | 中身 |
|---|---|
| 0〜63 | 頭: `Int32` の枠が 16（`HEADER_BYTES = 64`）。使うのは 5 つ |
| 64〜最後 | データの領域: 1 回あたり 4 MiB − 64 バイト = 4194240 バイト（`DEFAULT_CHANNEL_BYTES = 4 * 1024 * 1024`） |

| 枠 | 名前 | 値 |
|---|---|---|
| `[0]` | 状態 | `0` 空き、`1` 要求を書いた、`2` 答えを書いた |
| `[1]` | JSON の長さ | メッセージ全体の UTF-8 の JSON のバイト数 |
| `[2]` | バイナリの長さ | メッセージ全体のバイナリのバイト数 |
| `[3]` | この回のバイト数 | いまデータの領域にあるメッセージのバイト数 |
| `[4]` | 印 | `1` = まだ続きがある |

メッセージは、UTF-8 の JSON のすぐあとにバイナリを続けたものです。

### 1 回のやり取り

```text
worker (SyncClient)                         kernel (SyncServer)
write data, [1..4]
Atomics.store([0], 1)
postMessage({ t: 'sys' })  ───────────────▶ onmessage: receive() (only if [0] == 1)
while ([0] == 1) Atomics.wait([0], 1)        … runs the syscall (may be async) …
                                             respond(): write data, [1..4]
                            ◀─────────────── Atomics.store([0], 2); Atomics.notify([0])
read the answer
Atomics.store([0], 0)
```

### データの領域より大きいメッセージ

- **要求:** Worker はメッセージを最大 4194240 バイトずつ、最後の回を除いて印 `1` を付けて送ります。カーネルは塊を集め
  （全体の大きさは `[1]` と `[2]`）、途中の塊には状態 `2`・`[3] = 0` で受け取ったことを返し、最後の塊のあとで要求を処理します。
- **答え:** カーネルは最初の塊を印 `1` 付きで書きます。Worker はそれを写し、空の「続けて」の回（`[1..4] = 0`、状態 `1`、
  もう一度 `sys` のメッセージ）を送り、カーネルが次の塊を書きます。印の無い塊まで続けます。

### 要求と答えの中身

| 向き | JSON | バイナリ |
|---|---|---|
| 要求 | `{ op: string, …引数 }` | あってもよい（`write`・`writeFile` などのデータ） |
| 成功 | `{ ok: 値 }`（`undefined` は `null` になる） | — |
| バイト列付きの成功 | 結果が `Uint8Array` なら `{ ok: null, bin: true }`、`__bin` を持つオブジェクトなら `{ ok: 残り, bin: true }` | そのバイト列 |
| エラー | `{ err: code, msg: message }`（`code` の既定は `EIO`） | — |
| 知らない `op` | `{ err: 'ENOSYS', msg: 'unknown syscall <op>' }` | — |

Worker の側の `sys(op, args, bin)`（`src/node/sys.ts`。両方のランタイムが使う）は、`ok`（またはバイト列、または `bin`
フィールド付きの `ok`）を返し、`err` なら `code` 付きの `SysError` を投げます。

### 操作

| まとまり | `op` |
|---|---|
| ファイル | `stat`・`fstat`・`fdKind`・`access`・`open`・`close`・`read`・`write`・`lseek`・`readFile`・`writeFile`・`readdir`・`mkdir`・`mkdtemp`・`rmdir`・`rm`・`unlink`・`rename`・`link`・`symlink`・`readlink`・`realpath`・`chmod`・`fchmod`・`utimes`・`futimes`・`truncate`・`ftruncate`・`copyFile`・`cp`・`watch`・`unwatch` |
| モジュール | `resolve`・`moduleFormat`・`esmRegister` |
| プロセス | `getcwd`・`umask`・`chdir`・`exit`・`execve`・`kill`・`sigaction`・`spawn`・`spawnSync`・`isatty`・`ttySize`・`setRawMode` |
| スレッド | `threadReserve`・`watchThread`・`threadExit` |
| UDP | `udpBind`・`udpJoin`・`udpRecv`・`udpClose`・`udpSend` |
| ネットワーク | `listen`・`unlisten`・`listenShare`・`tlsHello`・`tcpConnect`・`tcpConnectOut`・`tcpSetTls`・`shutdown`・`unixListen`・`unixUnlisten`・`unixConnect`・`portInfo` |

引数と意味は [カーネル](kernel.ja.md) にあります（実装は `src/kernel/syscalls.ts`）。
