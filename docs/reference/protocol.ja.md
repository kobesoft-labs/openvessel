# 通信の形式

[English](protocol.md)

OpenVessel の各部品の間でやり取りするメッセージの形式を説明します。対象は、ホスト ↔ ランタイムのハンドシェイクと RPC、カーネルのイベント、
プレビューの中継とプレビューのチャネル、ランタイムの Service Worker の `/__ov/…` エンドポイント、カーネルとプロセスの Worker の間のメッセージ、
同期のシステムコールのチャネルです。不具合の調査や、`dist/host` を使わずに独自のホストを実装する場合に参照してください。

> **安定性。** semver の対象は、ホスト API（`dist/host` とその型宣言）と、3 つのオリジンで埋め込むための要件だけです
> （[CHANGELOG](../../CHANGELOG.md) の「Stability」）。このページの内容はすべて内部仕様で、`src/` の内部と
> `dist/runtime`・`dist/preview` の中のファイルは、パッチリリースを含むどのリリースでも変わる可能性があります。独自の
> ホストは、OpenVessel の特定の 1 つのバージョンに合わせて作る必要があります。

## チャネルの一覧

| 区間 | 通信手段 | 形式 | ソース |
|---|---|---|---|
| ホストのページ ↔ ランタイムの iframe | `window.postMessage` | `{ t: 'openvessel-…' }` | `src/host/index.ts`・`src/runtime/runtime.ts` |
| ホストのページ ↔ カーネル | `MessagePort`（ハンドシェイクの中で渡す） | RPC `{ id, m, a }`／`{ id, r }`／`{ id, e }`、イベント `{ ev, … }` | `src/kernel/index.ts` |
| ランタイムの iframe → カーネルの Worker | `Worker.postMessage` | `{ t: 'host-port' \| 'sw-port' \| 'policy' }` | `src/runtime/runtime.ts` |
| ランタイムの Service Worker ↔ カーネル | `MessagePort` | `{ id, k: 'esm' \| 'net', … }` | `src/runtime/sw.ts` |
| プロセス・カーネルのコード → ランタイムの Service Worker | HTTP（`fetch`・`import`・同期 XHR） | `/__ov/…` の URL | `src/runtime/sw.ts` |
| ホストのページ ↔ プレビューの中継用 iframe | `window.postMessage` | `{ t: 'openvessel-preview-…' }` | `src/host/index.ts`・`src/preview/relay.ts` |
| 中継 ↔ プレビューの Service Worker | `ServiceWorker.postMessage` | `{ t: 'kernel-port' \| 'default-port' \| 'need-kernel-port' }` | `src/preview/relay.ts`・`src/preview/sw.ts` |
| プレビューの Service Worker ↔ カーネル | `MessagePort` | `{ id, k: 'req' \| 'body' \| … }` | `src/preview/sw.ts`・`src/kernel/index.ts` |
| プレビューのページ ↔ プレビューの Service Worker | `postMessage` と、WebSocket ごとの `MessagePort` | `{ t: 'ws-connect' \| 'ws-check' }`、`{ t: 'open' \| 'msg' \| 'close' \| 'send' }` | `src/preview/inject.ts` |
| カーネル ↔ プロセスの Worker | `Worker.postMessage` | `{ t: … }` | `src/kernel/kernel.ts`・`src/kernel/syscalls.ts`・`src/kernel/net.ts` |
| プロセスの Worker → カーネル（システムコール） | `SharedArrayBuffer` と `Atomics` | JSON とバイナリ | `src/shared/syncchan.ts` |

## ホスト ↔ ランタイムの手順

```text
host page                                   runtime.html (runtime origin)
─────────                                   ─────────────────────────────
append <iframe src=".../runtime.html" allow="cross-origin-isolated">
                              ◀──────────── { t: 'openvessel-runtime-loaded' }            (to '*')
new MessageChannel()
{ t: 'openvessel-connect', port, init } ──▶  checks; starts __ov/k/<kid>/kernel.js
   (to the runtime origin, port transferred)  kernel ◀ { t: 'policy', policy }   (if init.policy)
                                              kernel ◀ { t: 'sw-port', port }
                                              sw.js  ◀ { t: 'kernel-port', port, kid }
                                              kernel ◀ { t: 'host-port', port }
port ◀──────────────────────────────────────  { ev: 'ready' }                    (from the kernel)
```

### window のメッセージ

| メッセージ | 方向 | フィールド | 備考 |
|---|---|---|---|
| `openvessel-runtime-loaded` | ランタイム → 親 | — | `runtime.js` の実行後、宛先 `'*'` で送信する |
| `openvessel-connect` | ホスト → ランタイム | `port: MessagePort`・`init: { policy?: Partial<NetworkPolicy> }` | `window.parent` からのものを 1 回だけ受け付ける。`port` が `MessagePort` でなければ無視する |
| `openvessel-error` | ランタイム → 親 | `message: string` | 宛先 `'*'` で送信する |

ホストがランタイムからのメッセージを受け付けるのは、`ev.origin` がランタイムのオリジンで、かつ `ev.source` がその iframe の場合だけです。

### `runtime.js` の確認とエラー

| 順序 | 確認内容 | `openvessel-error` のメッセージ |
|---|---|---|
| 1 | `ev.origin` が `<meta name="openvessel-allowed-hosts">` に含まれる（空白かカンマ区切り。`*` は任意のオリジン） | `origin <origin> is not allowed to use this runtime` |
| 2 | `location.ancestorOrigins` が（存在する場合）1 エントリー以下 | `the runtime must be embedded directly by the host page` |
| 3 | Service Worker の登録 | `service worker registration failed: <message>` |
| 4 | `crossOriginIsolated`（Worker がフレームを制御したあと） | `OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).` |
| 以降 | カーネルの Worker の `error` イベント | `kernel failed: <message>` |

確認 1 か 2 で失敗したあとも、ランタイムは次の `openvessel-connect` を受け付けます。ホストは、最初の `openvessel-error` を受け取ると
`boot()` を `OpenVessel: <message>` で reject し、`timeout`（既定 30000 ms）が過ぎても `ready` が届かなければ
`OpenVessel: runtime did not start in time` で reject します。`boot()` が resolve したあとに届いた `openvessel-error` は、
`dist/host` からは通知されません。

`runtime.js` での Service Worker の起動は次の流れです。まず `register('./sw.js', { scope: './', updateViaCache: 'none' })` を呼び、続いて
`reg.update()` を呼びます。Worker が installing か waiting の間は `controllerchange` を待ち、そのあと `navigator.serviceWorker.ready`
を待ちます。それでもページに controller が無ければ `controllerchange` を待ちます（Worker は activate 時に `clients.claim()` を呼びます）。
この処理は `runtime.html` の読み込み時、`openvessel-runtime-loaded` を送信する前にすでに行われます。Worker の制御下に入ってもフレームが
cross-origin isolated でなければ、`runtime.js` は Worker が付ける分離用ヘッダーを適用するために 1 回だけリロードします（`sessionStorage` のフラグ `openvessel-coi-reload`）。
それでも isolated にならないフレームは、確認 4 でエラーになります。

各ランタイムのフレームはランダムなカーネル ID `<kid>`（16 桁の 16 進数）を選び、カーネルを
`__ov/k/<kid>/kernel.js` として起動します。カーネルとそのプロセスの Worker が自身の URL からの相対で要求するものはすべてこの
プレフィックスの下にあり、Service Worker はそのリクエストを、その `kid` でチャネルを登録したカーネルに送ります
（[ランタイムの Service Worker](#ランタイムの-service-worker)）。

### カーネルの Worker へのメッセージ

| メッセージ | 送信元 | 動作 |
|---|---|---|
| `{ t: 'policy', policy }` | `runtime.js`。`init.policy` が指定されていれば `host-port` より前に送る | ネットワークポリシーを（正規化して）設定する |
| `{ t: 'sw-port', port }` | `runtime.js`。起動時、`controllerchange` のたび、自身の `kid` を指定した（または指定のない）`need-kernel-port` のたびに送る | ランタイムの Service Worker とのチャネルを接続する |
| `{ t: 'host-port', port }` | `runtime.js` | ホストとのチャネルを接続し（既存のものは置き換える）、そのチャネルに `{ ev: 'ready' }` を送る |

## ホストの RPC

### 形

| メッセージ | 形式 |
|---|---|
| 呼び出し（ホスト → カーネル） | `{ id: number, m: string, a: object }` |
| 結果（カーネル → ホスト） | `{ id, r: any }`。結果が `Uint8Array` の場合は（その `buffer` を）transfer する |
| エラー（カーネル → ホスト） | `{ id, e: { message: string, code?: string } }` |
| 未知のメソッド | `{ id, e: { message: 'unknown method <m>', code: 'ENOSYS' } }`（カーネル自身が定義したメソッド名だけが対象で、`toString` などの継承した名前は未知のメソッドとして扱う） |
| イベント（カーネル → ホスト） | `{ ev: string, … }`（`id` なし） |
| プレビューのチャネルの受け渡し（ホスト → カーネル。呼び出しではない） | `{ t: 'preview-port', port: MessagePort }` |

メソッドには同期のものと Promise を返すものがあり、完了した順に応答します。ファイルシステムが投げるエラーは
`KernelError` で、errno の `code`（`ENOENT`・`EEXIST`・`ENOTDIR`・`EISDIR`・`ENOTEMPTY` など）と、errno の説明文（たとえば `no such file or directory`）を
`message` に持ちます。カーネルは呼び出しの前に必須の引数（`path`・`from`/`to`・`files`・`argv`・`pid`・
`cols`/`rows`・`id`）をチェックし、Node と同じ `ERR_INVALID_ARG_TYPE`（`The "path" argument must be of type string. Received …`）を投げます。
`argv` が空の場合は `ERR_INVALID_ARG_VALUE` です。エラーには必ず `code` が付きます。`code` を持たないその他のエラーには
`ERR_INVALID_ARG_TYPE`（`TypeError`）、`ERR_OUT_OF_RANGE`（`RangeError`）、`ERR_INVALID_ARG_VALUE` のいずれかを付けます。
`dist/host` は `e` を `code` 付きの `Error` に変換します。

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
| `fs.readFile` | `path`・`encoding?`（truthy な値なら何でも UTF-8） | `Uint8Array`（コピー）。`encoding` を指定すると `string` |
| `fs.writeFile` | `path`・`data: string \| Uint8Array \| ArrayBuffer`・`mode?`（既定 `0o644`）・`mkdirs?`（既定 `true`: 親ディレクトリを作成する） | `null` |
| `fs.mkdir` | `path`・`recursive?`（既定 `true`） | 最初に作成したディレクトリ（recursive の場合）、または `null` |
| `fs.readdir` | `path`・`withTypes?` | `string[]`。`withTypes` を指定すると `{ name, type: 'dir' \| 'symlink' \| 'file' }[]`（それ以外のノードの種類はすべて `'file'`） |
| `fs.rm` | `path`・`recursive?`・`force?`（既定 `true`） | `null`。recursive の場合は `rm -rf` と同じ（`force: false` で対象が無ければ `ENOENT`）。それ以外は、ディレクトリなら `rmdir`、それ以外なら `unlink`（シンボリックリンクはたどらない） |
| `fs.stat` | `path`（シンボリックリンクはたどる） | `{ dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs, isDirectory, isFile }` |
| `fs.exists` | `path` | `boolean` |
| `fs.rename` | `from`・`to` | `null` |
| `mount` | `files: Record<string, string \| Uint8Array \| ArrayBuffer \| null \| { dir: true } \| { symlink: string }>`・`path?`（既定 `/home/user/app`） | エントリーの数。キーは `path` からの相対パス。`null` か `{ dir }` はディレクトリ、`{ symlink }` はシンボリックリンク（リンク先は指定したまま）、それ以外はファイル（mode `0o644`、親ディレクトリは作成する）。`.sh`/`.bash` で終わるファイルと、内容が `#!` で始まる文字列のファイルには実行ビットを付ける |
| `export` | `path`・`exclude?`（既定 `['node_modules', '.git']`。どの階層の名前にも一致させる） | 通常ファイルの `Record<string, Uint8Array>`。キーは `path` からの相対パス。シンボリックリンクはスキップする |
| `spawn` | `argv: string[]`・`cwd?`（既定 `/home/user`。無ければ作成する）・`env?`（既定の環境変数に上書きでマージする）・`terminal?: { cols?, rows? }`（既定 80 × 24） | `{ pid }`。各プロセスは独自のプロセスグループで起動する。`terminal` を指定すると stdin/stdout/stderr は 1 つの TTY、指定しなければ 3 本のパイプ |
| `input` | `pid`・`data: string \| Uint8Array \| null` | ホストが起動したプロセスでないか、すでに終了している場合は `false`、それ以外は `true`。TTY の場合、バイト列はライン規律を通る。パイプの場合は stdin に書き込み、`null` で stdin を閉じる。書き込みエラーは無視する |
| `resize` | `pid`・`cols`・`rows` | `null`（ターミナルのプロセスのみ。`SIGWINCH` を送る） |
| `kill` | `pid`・`signal?`（既定 `'SIGTERM'`） | `null`。そのプロセスのプロセスグループ全体にシグナルを送る。エラー（未知の pid）は無視する |
| `ps` | — | 実行中のプロセスの `{ pid, ppid, argv, cwd }[]` |
| `ports` | — | プレビューから到達できる待ち受けの `{ port, pid }[]`（旧ランタイムの `net.Server` の待ち受けは含まない） |
| `network.setPolicy` | `policy: Partial<NetworkPolicy>` | 正規化したポリシー |
| `network.getPolicy` | — | 現在のポリシー |
| `network.clearSession` | — | `null`。「このセッション中」の許可と拒否をリセットする |
| `permission.respond` | `id`・`decision: 'once' \| 'session' \| 'deny' \| 'deny-session'`（それ以外の値は `deny`） | 該当する保留中のリクエストが無ければ `false`、あれば `true` |
| `watch` | `path`・`id`（呼び出し側が決める） | `null`。以降、`path` とその配下の変更ごとに、その `id` の `fs-change` イベントを送る |
| `unwatch` | `id` | `null` |
| `debug.trace` | `on` | 新しい値（カーネルのトレースログをコンソールに出力するかどうかを切り替える） |
| `debug.esm` | `pathname`・`search?` | `{ status, body, type }`。その `/__ov/…` のパスに対してランタイムの Service Worker が返す内容 |

既定の環境変数は `PATH=/usr/local/bin:/usr/bin:/bin`・`HOME=/home/user`・`USER=user`・`LOGNAME=user`・`SHELL=/bin/sh`・
`TERM=xterm-256color`・`LANG=en_US.UTF-8`・`TMPDIR=/tmp`・`HOSTNAME=<カーネルのホスト名>`・`NAPI_RS_FORCE_WASI=true` です。
[カーネル](kernel.ja.md) と [ホスト API](host-api.ja.md) もあわせて参照してください。

### イベント

| イベント | フィールド | 発生するタイミング |
|---|---|---|
| `ready` | — | ホストとのチャネルを接続した直後 |
| `output` | `pid`・`data: Uint8Array`・`stream?: 'stdout' \| 'stderr'` | ホストが起動したプロセスの出力。ターミナルのプロセスでは `stream` が無い。パイプは最大 65536 バイトずつ読む |
| `exit` | `pid`・`code: number`・`signal: string \| null` | ホストが起動したプロセスが終了した（パイプのプロセスの場合は、stdout と stderr が EOF に達したあと） |
| `server-ready` | `port`・`pid` | プロセスが、プレビューから到達できるポートで待ち受けを始めた |
| `port-closed` | `port` | その待ち受けが無くなった |
| `fs-change` | `id`・`type: 'rename' \| 'change'`・`path` | 監視しているパスの配下で変更があった |
| `permission-request` | `id`・`url`・`host`・`initiator`・`source: 'runtime' \| 'preview'` | あるホストについてポリシーが `ask` を返した。`permission.respond` で応答する |
| `permission-settled` | `id`・`host`・`allowed: boolean`・`decision: 'once' \| 'session' \| 'deny' \| 'deny-session' \| 'timeout'` | 許可リクエストに応答があった、または 5 分でタイムアウトした |

許可リクエストの扱いは次のとおりです。カーネルは、同じホスト名について同時に発生した確認を 1 つにまとめ（待っているすべての呼び出し元に同じ結果を返します）、
5 分以内に応答が無ければ拒否し、ホストとのチャネルが接続されていない間は即座に拒否します。`session`／`deny-session` の
判断は、`network.clearSession` を呼ぶまでホスト名ごとに記憶します。`initiator` は、パッケージマネージャーなら `npm`、プロセスなら
`<pid> <argv…>`（最大 200 文字）、不明な場合は `process`、プレビューなら `preview` です。詳しくは [ネットワークポリシー](network-policy.ja.md)
を参照してください。

`dist/host` は `exit` を `process-exit` として発行し直し、`server-ready` に `url` を追加し、`permission-request` には自身で
（`onPermissionRequest` か組み込みのダイアログで）応答します。

## プレビューの中継

### ホスト ↔ 中継用 iframe（`window.postMessage`）

| メッセージ | 方向 | フィールド | 備考 |
|---|---|---|---|
| `openvessel-preview-loaded` | 中継 → 親（`'*'`） | — | プレビューの Service Worker が登録され、準備ができたあと |
| `openvessel-preview-connect` | ホスト → 中継 | `port: MessagePort`・`defaultPort: number` | もう一方の端は、ホストが `{ t: 'preview-port', port }` としてカーネルに送信済み |
| `openvessel-preview-ready` | 中継 → 親（`'*'`） | — | ポートを Service Worker に渡した |
| `openvessel-preview-default-port` | ホスト → 中継 | `port: number` | 2 回目以降の `previewUrl()` のたびに送る |
| `openvessel-preview-need-port` | 中継 → 親（`'*'`） | — | Service Worker がチャネルを失った。ホストは新しい `openvessel-preview-connect` で応答する |

中継は `window.parent` からのメッセージだけを受け付け、ホストはプレビューのオリジンにある中継用 iframe からのメッセージだけを
受け付けます。ホストは、`openvessel-preview-loaded` と `openvessel-preview-need-port` のどちらに対しても、新しいチャネルを作成して応答します。

### 中継 ↔ プレビューの Service Worker

| メッセージ | 方向 | フィールド | 受け付ける条件 |
|---|---|---|---|
| `kernel-port` | 中継 → SW | `port: MessagePort`・`defaultPort: number` | 送信元が中継である（URL のパスが `<スコープ>__ov/relay.html` と完全に一致する、フレーム内の window）。0 以外の `defaultPort` は既定のポートを置き換える。それまでのチャネルは閉じる |
| `default-port` | 中継 → SW | `port: number` | 送信元が中継である |
| `need-kernel-port` | SW → 中継のすべての window クライアント | — | SW にチャネルが必要だが無い。最大 15 秒待つ（`preview is not connected to OpenVessel`。その間、外部へのリクエストは拒否する） |

中継自身は、`openvessel-preview-connect` と `openvessel-preview-default-port` を親からだけ、しかも親が中継と別の
オリジンである場合にだけ受け付けます。

### プレビューのページ ↔ プレビューの Service Worker（WebSocket）

| メッセージ | 方向 | フィールド |
|---|---|---|
| `ws-check` | ページ → SW | `url`（外部の `ws:`／`wss:` の URL）・`port: MessagePort`（transfer）。SW は `http:`／`https:` の URL と同じようにカーネルに確認し、そのポートに `{ allow: boolean }` で応答する |
| `ws-connect` | ページ → SW（`navigator.serviceWorker.controller`） | `port: MessagePort`（transfer）・`path`（パスとクエリ）・`protocols: string[]`・`vport: number`・`origin` |
| `open` | SW → ページ（そのポート上） | `protocol` |
| `msg` | SW → ページ | `data: string \| Uint8Array`・`binary: boolean` |
| `close` | SW → ページ | `code`・`reason`（SW がカーネルとのチャネルを持っていない場合は `1006`／`not connected`） |
| `send` | ページ → SW | `data: string \| Uint8Array`・`binary: boolean` |
| `close` | ページ → SW | `code`・`reason` |

ポートの選び方については [プレビュー](preview.ja.md#websocket) を参照してください。

## プレビューのチャネル

プレビューの Service Worker とカーネルの間のチャネルです（`src/kernel/index.ts` の `attachPreview`）。すべてのメッセージは、
Service Worker が採番する数値の `id` と、文字列の `k` を持ちます。カーネルはそれ以外のメッセージを無視します。

| `k` | 方向 | フィールド | 意味 |
|---|---|---|---|
| `req` | SW → カーネル | `id`・`port`・`method`・`url`（パスとクエリ）・`headers: [string, string][]`・`hasBody` | HTTP リクエストを開始する |
| `body` | SW → カーネル | `id`・`data: Uint8Array`（transfer） | リクエストボディ（SW は一度にまとめて送る） |
| `body-end` | SW → カーネル | `id` | リクエストボディの終わり（ボディを持つメソッドでは、空の場合も送る） |
| `abort` | SW → カーネル | `id` | ページがレスポンスボディをキャンセルした |
| `head` | カーネル → SW | `id`・`status`・`statusText`・`headers: [string, string][]` | レスポンスのヘッダー部分 |
| `data` | カーネル → SW | `id`・`data: Uint8Array` | ボディのチャンク |
| `end` | カーネル → SW | `id` | レスポンスの終わり |
| `error` | カーネル → SW | `id`・`msg` | リクエストが失敗した（`connect ECONNREFUSED 127.0.0.1:<port>`・`socket hang up`・`incomplete response`・`server process exited` など） |
| `ws-open` | SW → カーネル | `id`・`port`・`url`・`headers` | WebSocket を開く |
| `ws-opened` | カーネル → SW | `id`・`protocol: string \| null` | サーバーが upgrade を受け入れた |
| `ws-msg` | 双方向 | `id`・`data: string \| Uint8Array`・`binary` | メッセージ |
| `ws-close` | SW → カーネル | `id`・`code`（`Number(code) \|\| 1000`）・`reason` | ページ側から閉じる |
| `ws-closed` | カーネル → SW | `id`・`code`・`reason` | サーバーが閉じた、または開けなかった（`1006`、reason はエラーメッセージ。サーバーが upgrade に通常のレスポンスを返した場合は `Unexpected server response: <status>`） |
| `net` | SW → カーネル | `id`・`url` | プレビューがこの外部 URL を取得してよいかの確認（initiator `preview`、source `preview`） |
| `net-result` | カーネル → SW | `id`・`allow: boolean`・`cache: boolean`・`timeout: boolean` | 判断の結果。`cache` はポリシーか「このセッション中」の応答から決まった場合に true（SW が再利用してよい）。`timeout` は確認に応答が無かった場合 |
| `net-flush` | カーネル → SW | —（`id` なし） | ポリシーかセッション中の判断が変わった。キャッシュした許可を破棄する |

Service Worker がチャネルを置き換えたり失ったりすると（ポートの `close` イベント）、カーネルはそのチャネル上でまだ開いているリクエストと
WebSocket を中断します。

このチャネルでカーネルが行えるのはこれだけです。ファイルシステム・プロセス・ポリシーのメソッドは、ホストとのチャネルにしか
ありません。

## ランタイムの Service Worker

`dist/runtime/sw.js` は、スコープ内の同一オリジンへのリクエストを処理します。以下のパスは、ランタイムのディレクトリからの相対パスです
（照合の前にスコープを取り除きます）。その配下のカーネルのプレフィックス `/__ov/k/<kid>/` からの相対パスでもよく、プレフィックスの下への
リクエストはカーネル `<kid>` に送られます。プレフィックスの無い `/__ov/…` へのリクエスト（旧ランタイムのルートからの URL）は、リファラー
（あるカーネルのプレフィックスの下にあるファイルか、そのカーネルが返したモジュール）が示すカーネルに送られ、判断できなければ最後に接続した
カーネルに送られます。

### エンドポイント

| パス | メソッド | 応答 |
|---|---|---|
| `/__ov/esm/<VFS の絶対パス>[?query]` | すべて | カーネルが VFS のファイルから生成する ES モジュール（[後述](#モジュールのエンドポイント)）。旧ランタイムが使う |
| `/__ov/builtin/<name>[.mjs]` | すべて | 組み込みモジュール（`node:fs` など）のファサードとなる ES モジュール。旧ランタイムが使う |
| `/__ov/mw/<pid>/<id>.mjs` | すべて | 移植版ランタイムが `esmRegister` システムコールで登録したモジュールのソース |
| `/__ov/esm-error?…` | すべて | カーネルが解決できなかった import のエラーを投げるモジュール（カーネルが応答する） |
| `/__ov/net?url=<エンコードした URL>` | すべて | ネットワークポリシーを確認する外部通信のプロキシ（[後述](#__ovnet)） |
| `/__ov/ping` | すべて | `pong`（`text/plain`） |
| `/__ov/k/<kid>/<file>`（エンドポイント以外） | `GET`・`HEAD` | ランタイムのディレクトリの `<file>` を、要求された URL のまま分離用ヘッダーを付けた新しいレスポンスとして返す（`kernel.js`・`process.js`・チャンク・`compat/` がプレフィックスの下でも動くようにするため） |
| その他すべて | `GET` | サーバーから取得し、分離用ヘッダーが無ければ追加する |
| その他すべて | その他 | 処理しない（サーバーに送られる） |

### モジュールのエンドポイント

モジュールのレスポンスには `content-type: <type>; charset=utf-8`・`cache-control: no-store`・
`cross-origin-resource-policy: same-origin` が付き、ステータスはカーネルが返したものになります。エラーは例外を投げるモジュールとして
返すので、`import` は正しい `code` で失敗します。

| ケース | モジュールが投げるエラーの `code` |
|---|---|
| ファイルが無い | `ERR_MODULE_NOT_FOUND`（`Cannot find module '<path>'`） |
| ディレクトリ | `ERR_UNSUPPORTED_DIR_IMPORT` |
| `.node` アドオン | `ERR_DLOPEN_FAILED`（`Native addons are not supported in OpenVessel: <path>`） |
| ES モジュールとしての `.wasm` | `ERR_UNKNOWN_FILE_EXTENSION` |
| `/__ov/mw/` の id が登録されていない | `ERR_INTERNAL_ASSERTION`（`module <pid>/<id> is not registered`） |
| 15 秒以内にカーネルとのチャネルが得られない | ステータス 200、`text/javascript`、`throw new Error("OpenVessel kernel is not connected");` |

`/__ov/esm/` では、カーネルが形式ごとに次のように変換します。JSON は `export default JSON.parse(…)` にします（クエリパラメーター `ov-json`
でも強制できます）。CommonJS は、`globalThis.__ov.requireForImport()` のファサードにし、`cjs-module-lexer` で見つけた名前付き export を付けます。
ES モジュールは、指定子を `/__ov/esm/…`・`/__ov/builtin/…` の URL に書き換え、`import.meta`・`import()` を
`globalThis.__ov` 経由にしたソースにします。TypeScript の ES モジュールは、先に sucrase で型を除去します。結果は inode・mtime・
サイズをキーにキャッシュします（4000 エントリーを超えるとキャッシュをクリアします）。登録された `/__ov/mw/` のソースは、そのプロセスが終了すると破棄します。

### `/__ov/net`

ランタイムからネットワークへ出る唯一の経路です。呼び出し元は、移植版ランタイムの `fetch` と旧ランタイムのネットワーク層（プロセスの
Worker から）、カーネルの npm クライアントと `curl`・`wget`、そしてカーネルの外向き TCP ブリッジ（ソケットに
書き込まれた HTTP/1.1 をこのリクエストに変換する。`src/kernel/outbound.ts`）です。カーネル自身のクライアントは、ループバックの URL を
ここには送らず、仮想ポートに送ります（[ネットワークポリシー](network-policy.ja.md#localhost-と仮想ポート)）。

リクエスト:

| 部分 | 内容 |
|---|---|
| URL | `<ランタイムのベース>/__ov/net?url=<encodeURIComponent(接続先)>` |
| メソッド | `GET` と `HEAD` はそのまま。それ以外はすべてボディ付きの `POST` で送る |
| `x-ov-method` | 実際のメソッド（既定はリクエストのメソッド） |
| `x-ov-h` | `encodeURIComponent(JSON.stringify([[name, value], …]))`: 送信するヘッダー |
| `x-ov-by` | `encodeURIComponent(initiator)`。プロセスは `<pid> <コマンドライン>` を送る。カーネルはそこから pid だけを取り出し、プロセステーブルからプロセス名を決める（[ネットワークポリシー](network-policy.ja.md#許可リクエスト)） |
| `x-ov-k` | カーネルの秘密トークン。カーネル自身のクライアント（`npm` とその他のパッケージマネージャー・`curl`・`wget`）だけが送る。これがあれば `x-ov-by` のラベルをそのまま表示する |
| `x-ov-redirect` | `error` ならリダイレクトを失敗にする。それ以外（または指定なし）はリダイレクトをたどる |

Service Worker はカーネルに確認し（`{ k: 'net', url, initiator, token }`）、ブラウザが管理するヘッダー（`host`・`connection`・
`content-length`・`keep-alive`・`transfer-encoding`・`upgrade`・`te`・`trailer`・`expect`・`cookie`・`cookie2`・`origin`・
`referer`・`accept-encoding`・`access-control-request-headers`・`access-control-request-method`・`date`・`dnt`・`via`・
`proxy-connection`・`sec-*`・`proxy-*`）を取り除いて、`credentials: 'omit'`・`mode: 'cors'`・`cache: 'no-store'` で接続先を
`fetch` します。レスポンスがリダイレクトされていた場合は、最終的な URL についてもう一度カーネルに確認し、拒否されたら後述のとおり応答します。

リクエストを送信できた場合のレスポンス（ステータスは常に `200`）:

| ヘッダー | 内容 |
|---|---|
| `x-ov-status` | 実際のステータス |
| `x-ov-status-text` | URI エンコードしたステータステキスト |
| `x-ov-url` | URI エンコードした最終的な URL（リダイレクト後） |
| `x-ov-redirected` | `1` か `0` |
| `x-ov-rh` | ブラウザが公開するレスポンスヘッダーの JSON を URI エンコードしたもの（CORS のルールが適用されるため、safelist に含まれるものと `Access-Control-Expose-Headers` に含まれるものだけ） |
| `content-type` | 実際の Content-Type。無ければ `application/octet-stream` |
| `cache-control` | `no-store` |

ボディはストリーミングで返します。`204`・`205`・`304`・`HEAD` ではボディは空です。失敗した場合は次のようになります。

| ステータス | `x-ov-error` | `x-ov-message`（URI エンコード。プレーンテキストのボディも同じ内容） |
|---|---|---|
| `403` | `denied` | `OpenVessel: network access to <host> was denied by the network policy`（最初の URL と最終的な URL のどちらの場合も） |
| `504` | `timeout` | `OpenVessel: network access to <host> was not answered in time`（許可リクエストがタイムアウトした） |
| `502` | `network` | `request to <host> failed: <message>. The server may not allow cross-origin requests (CORS) from the browser.` |
| `502` | `network` | カーネルとのチャネルを取得できなかった（`OpenVessel kernel is not connected`） |

移植版ランタイムの `fetch` はこれらを `TypeError('fetch failed')` に変換し、その `cause` の `code` を `EACCES`（`denied`）・
`ETIMEDOUT`（`timeout`）・`ECONNREFUSED`（それ以外）にします。旧ランタイムとカーネルの npm クライアントも同様です。外向き TCP ブリッジは、HTTP の `403` か `502` をソケットに書き戻します。

### Service Worker ↔ ランタイムのフレームとカーネル

| メッセージ | 方向 | フィールド |
|---|---|---|
| `kernel-port` | `runtime.html` → SW | `port: MessagePort`・`kid`（8〜32 桁の 16 進数）。URL のパスが `/runtime.html` で終わる window クライアントからのものだけを受け付ける。同じ `kid` の新しいチャネルは古いチャネルを置き換え、古いほうは保留中の応答がそろった時点で閉じる |
| `ping` | `runtime.html` → SW | 無視する（`clients.claim()` で `controllerchange` が発生するように送るもの） |
| `need-kernel-port` | SW → パスが `/runtime.html` で終わるすべての window クライアント | `kid`（どのカーネルでもよい場合は `null`）。SW がそのカーネルとのチャネルを持っていない。その `kid` のフレームが、新しい `sw-port`／`kernel-port` を送って応答する |
| `{ id, k: 'esm', pathname, search }` | SW → カーネル | モジュールを読み込む |
| `{ id, status, body, type }` | カーネル → SW | そのモジュール |
| `{ id, k: 'net', url, initiator, token }` | SW → カーネル | `url` についてのポリシーの判断（`source` は `runtime`）。`initiator` と `token` は `x-ov-by` と `x-ov-k` ヘッダーから取る |
| `{ id, allow, timeout }` | カーネル → SW | 判断の結果。`timeout` は許可リクエストに応答が無かった場合 |

Service Worker はチャネルを最大 15 秒待ちます。カーネルからの応答にはタイムアウトはありません。

## カーネルとプロセスのメッセージ

各プロセス（と `worker_threads` の各スレッド）は、カーネルが作成する Web Worker です。以下のメッセージはその Worker との
`postMessage` で、システムコールには [同期のチャネル](#同期のシステムコールのチャネル) を使います。

### `init`

新しい Worker に最初に送るメッセージです。

| フィールド | 内容 |
|---|---|
| `t` | `'init'` |
| `kind` | `'main'` か `'thread'` |
| `pid`・`ppid`・`tid` | 各 ID |
| `argv`・`env`・`cwd` | プロセスのコマンドライン・環境変数・カレントディレクトリ |
| `sab` | システムコールのチャネルの `SharedArrayBuffer`（4 MiB） |
| `ttys` | `{ 0, 1, 2 }` → TTY であるディスクリプターなら `{ cols, rows }`、それ以外は `null` |
| `hostname` | カーネルのホスト名 |
| スレッドのみ | `file`・`eval`・`evalType`・`execArgv`・`workerData`・`envData`・`port`（transfer した `MessagePort`）・`name`・`threadId`・`resourceLimits`・`envRings`・`trackUnmanagedFds`・`sharedEnv` |

### プロセス → カーネル

| `t` | フィールド | 意味 |
|---|---|---|
| `sys` | — | 「共有バッファにシステムコールのリクエストがある」 |
| `pong` | `id` | `ping` への応答 |
| `readStart` | `fd` | `fd` のデータを `fd-data` で送り始める |
| `readStop` | `fd` | 送るのをやめる |
| `readOnce` | `fd`・`len?`（既定 65536）・`id` | 1 回だけ読む。`id` 付きの `fd-data` で応答する |
| `writeWait` | `fd` | パイプ／ソケットのバッファが空いたら `fd-writable` を送る |
| `threadSpawn` | `tid`・`file`・`eval`・`argv`・`port` など | `worker_threads` のスレッドを起動する |
| `threadKill` | `tid` | スレッドを終了させる |
| `loop-req`・`loop-body`・`loop-body-end`・`loop-abort` | `crid`・`port`・`method`・`url`・`headers`・`data` | 旧ランタイム: 仮想ポートへの HTTP リクエスト |
| `http-res`・`http-res-data`・`http-res-end`・`http-res-error` | `rid`・`status`・`statusText`・`headers`・`data`・`msg` | 旧ランタイム: `http-req` へのレスポンス |
| `ws-open`・`ws-send`・`ws-close` | `rid`・`protocol`・`headers`・`data`・`binary`・`code`・`reason` | 旧ランタイム: WebSocket のサーバー側 |

### カーネル → プロセス

| `t` | フィールド | 意味 |
|---|---|---|
| `ping` | `id` | 「それまでに送ったメッセージをすべて処理したら応答してほしい」（読み取り中の相手がいるプロセスが終了するときに使う） |
| `fd-data` | `fd` か `id`・`data: Uint8Array \| null`（`null` は EOF）・`err?`・`handle?` | 読んだデータ。`handle` は IPC で受け取ったディスクリプターの情報 |
| `fd-writable` | `fd` | バッファが空いた |
| `signal` | `sig` | プロセスがハンドルするシグナル（と `SIGWINCH`） |
| `child-exit` | `pid`・`code`・`signal` | `spawn` システムコールで起動した子プロセスが終了した |
| `watch` | `id`・`type`・`path` | `watch` システムコールに対するファイルシステムの変更 |
| `thread-exit` | `tid`・`code`・`initFailed?`・`terminated?` | スレッドが終了した |
| `thread-gone` | `tid` | 監視していたスレッドが無くなった |
| `tcp-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | 移植版ランタイム: 待ち受けポートへの新しい接続 |
| `pipe-accept` | `port`・`fd`・`remoteAddress`・`remotePort` | 移植版ランタイム: Unix ソケットへの新しい接続 |
| `tls-peer` | `fd`・`certs` | 相手の証明書（2 つのプロセスの間の TLS） |
| `udp-msg` | `port`・`data`・`from: { address, port }` | データグラム |
| `http-req` | `rid`・`port`・`method`・`url`・`headers`・`hasBody`・`upgrade?` | 旧ランタイム: そのプロセスのサーバーへの HTTP リクエスト |
| `http-body`・`http-body-end`・`http-abort` | `rid`・`data` | 旧ランタイム: リクエストボディ／中断 |
| `ws-msg`・`ws-close` | `rid`・`data`・`binary`・`code`・`reason` | 旧ランタイム: クライアントからの WebSocket |
| `loop-res`・`loop-res-data`・`loop-res-end`・`loop-res-error` | `crid` など | 旧ランタイム: `loop-req` へのレスポンス |

## 同期のシステムコールのチャネル

プロセスの各スレッドは、それぞれ専用の `SharedArrayBuffer` を持ちます。Worker はリクエストを書き込み、カーネルに `{ t: 'sys' }` を
送り、カーネルが応答を書き込むまで `Atomics.wait` でブロックします（`src/shared/syncchan.ts`）。

### 配置

- 0〜63 バイト目はヘッダーです。`Int32` のスロットが 16 個（`HEADER_BYTES = 64`）あり、そのうち 5 個を使います。
- 64 バイト目から最後まではデータ領域です。1 回あたり 4 MiB − 64 バイト = 4194240 バイトです
  （`DEFAULT_CHANNEL_BYTES = 4 * 1024 * 1024`）。

ヘッダーのスロットは次のとおりです。

| スロット | 名前 | 値 |
|---|---|---|
| `[0]` | 状態 | `0` 空き、`1` リクエストを書き込み済み、`2` レスポンスを書き込み済み |
| `[1]` | JSON の長さ | メッセージ全体の UTF-8 の JSON のバイト数 |
| `[2]` | バイナリの長さ | メッセージ全体のバイナリペイロードのバイト数 |
| `[3]` | 今回のバイト数 | 現在データ領域にある、メッセージのバイト数 |
| `[4]` | フラグ | `1` = 後続のチャンクがある |

メッセージは、UTF-8 の JSON の直後にバイナリペイロードを続けたものです。

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

- リクエスト: Worker はメッセージを最大 4194240 バイトずつに分けて送り、最後以外のチャンクにはフラグ `1` を付けます。カーネルはチャンクを集め
  （全体のサイズは `[1]` と `[2]` でわかります）、途中のチャンクには状態 `2`・`[3] = 0` で受領を返し、最後のチャンクを受け取ってからリクエストを処理します。
- レスポンス: カーネルは最初のチャンクをフラグ `1` 付きで書き込みます。Worker はそれをコピーし、空の「続き」のラウンド（`[1..4] = 0`、状態 `1`、
  もう一度 `sys` メッセージ）を送ります。カーネルが次のチャンクを書き込み、フラグの無いチャンクが来るまでこれを繰り返します。

### 要求と答えの中身

| 方向 | JSON | バイナリ |
|---|---|---|
| リクエスト | `{ op: string, …引数 }` | 任意（`write`・`writeFile` などのデータ） |
| 成功 | `{ ok: 値 }`（`undefined` は `null` になる） | — |
| バイト列付きの成功 | 結果が `Uint8Array` なら `{ ok: null, bin: true }`、`__bin` フィールドを持つオブジェクトなら `{ ok: 残り, bin: true }` | そのバイト列 |
| エラー | `{ err: code, msg: message }`（`code` の既定は `EIO`） | — |
| 未知の `op` | `{ err: 'ENOSYS', msg: 'unknown syscall <op>' }` | — |

Worker 側の `sys(op, args, bin)`（`src/node/sys.ts`。両方のランタイムが使う）は、`ok`（またはバイト列、または `bin`
フィールド付きの `ok`）を返し、`err` の場合は `code` 付きの `SysError` を投げます。

### 操作

| 分類 | `op` |
|---|---|
| ファイル | `stat`・`fstat`・`fdKind`・`access`・`open`・`close`・`read`・`write`・`lseek`・`readFile`・`writeFile`・`readdir`・`mkdir`・`mkdtemp`・`rmdir`・`rm`・`unlink`・`rename`・`link`・`symlink`・`readlink`・`realpath`・`chmod`・`fchmod`・`utimes`・`futimes`・`truncate`・`ftruncate`・`copyFile`・`cp`・`watch`・`unwatch` |
| モジュール | `resolve`・`moduleFormat`・`esmRegister` |
| プロセス | `getcwd`・`umask`・`chdir`・`exit`・`execve`・`kill`・`sigaction`・`spawn`・`spawnSync`・`isatty`・`ttySize`・`setRawMode` |
| スレッド | `threadReserve`・`watchThread`・`threadExit` |
| UDP | `udpBind`・`udpJoin`・`udpRecv`・`udpClose`・`udpSend` |
| ネットワーク | `listen`・`unlisten`・`listenShare`・`tlsHello`・`tcpConnect`・`tcpConnectOut`・`tcpSetTls`・`shutdown`・`unixListen`・`unixUnlisten`・`unixConnect`・`portInfo` |

引数と動作の詳細は [カーネル](kernel.ja.md) にあります（実装は `src/kernel/syscalls.ts`）。
