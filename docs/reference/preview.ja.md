# プレビュー

[English](preview.md)

OpenVessel の中で動くサーバーを iframe に表示する仕組みを説明します。中継用の iframe とプレビューの Service Worker、
`__ov/open` の URL、HTTP のリクエスト・レスポンスと WebSocket を仮想ポートとの間でやり取りする方法、挿入するスクリプトの
役割、プレビューにできることとできないことを扱います。メッセージの形式は [通信プロトコル](protocol.ja.md) に、ヘッダーと
ホスティングについては [デプロイ](deployment.ja.md) にあります。

## 全体像

```text
host page                      preview origin                                   runtime origin
─────────                      ──────────────                                   ──────────────
OpenVessel ─ creates ─▶ relay iframe (__ov/relay.html)
   │                     registers __ov-sw.js, gives it a MessagePort ──────▶ kernel worker
   │                                                                          NetRouter
   └ creates ─▶ preview iframe ──fetch──▶ __ov-sw.js ──{k:'req'…}──────────▶  ├ ported runtime: TcpBridge
                (sandboxed)                (service worker)                    │   HTTP/1.1 bytes on a socketpair
                 inject.js ──ws-connect──▶                                     └ legacy runtime: http-req messages
```

| 部品 | ソース | 役割 |
|---|---|---|
| 中継用の iframe | `src/preview/relay.html`・`src/preview/relay.ts` | 非表示で、プレビューのオリジンに置く。プレビューの Service Worker を登録し、ホストが作ったカーネルとのチャネルを渡す |
| プレビューの Service Worker | `src/preview/sw.ts`（`dist/preview/__ov-sw.js`） | プレビューのページのすべてのリクエストに仮想ポートから応答する。WebSocket をトンネルする。HTML に `inject.js` を挿入する。他のオリジンへのリクエストにネットワークポリシーを適用する |
| 挿入するスクリプト | `src/preview/inject.ts`（`dist/preview/__ov/inject.js`） | ローカルの URL 向けに `window.WebSocket` を置き換える。パスの下で配信するときは、ルート相対の `fetch`/XHR の URL を補正する |
| カーネル側 | `src/kernel/index.ts`（`attachPreview`）・`src/kernel/net.ts`・`src/kernel/tcp.ts` | ポートで待ち受けているプロセスへリクエストを振り分ける |
| ホスト側 | `src/host/index.ts`（`previewUrl`・`createPreview`） | 中継用とプレビューの iframe を作り、中継をカーネルに接続する |

実際のマシン上では何もポートを開きません。ポートはカーネルのテーブルの項目にすぎず、ブラウザのページからそこへ
アクセスする方法は、この Service Worker を経由するものだけです。

## プレビューの始まり

`vessel.previewUrl(port, path?)` と `vessel.createPreview(port, opts?)` を使うには、`OpenVessel.boot()` に `previewUrl` を
指定する必要があります。指定がない場合は `OpenVessel: previewUrl was not configured` で reject します。

最初の呼び出しで中継を作り、2 回目以降はそれを再利用します。

1. ホストが非表示の iframe `<previewUrl>__ov/relay.html` を追加します（`aria-hidden`、`tabIndex = -1`、サイズ 0、
   `visibility:hidden`）。
2. `relay.js` が `../__ov-sw.js` をスコープ `../` で登録し、`navigator.serviceWorker.ready` を待ってから、親に
   `openvessel-preview-loaded` を送ります。
3. ホストが `MessageChannel` を作り、一方をカーネルに（カーネルとのチャネルで `{ t: 'preview-port', port }`）、もう一方を
   中継に（`defaultPort` 付きの `openvessel-preview-connect`）送ります。
4. 中継がそのポートをアクティブな Service Worker に渡し（`kernel-port`）、`openvessel-preview-ready` を送ると、ホストの
   promise が解決します。中継がこれらのメッセージを受け付けるのは親からだけで、しかも親が別のオリジン（ホスト）の
   場合だけです（中継を iframe に埋め込んだプレビューのページからは受け付けません）。新しいチャネルは古いチャネルを
   置き換え、Service Worker は古いほうを閉じます。カーネルは、そのチャネルでまだ開いていたリクエストとソケットを中断します。

20000 ms 以内に中継の準備ができなければ、`OpenVessel: preview relay did not start` で reject します。2 回目以降の
`previewUrl()`・`createPreview()` は、そのポートを `openvessel-preview-default-port` で送り、デフォルトのポートにします。

## `__ov/open` の URL

```text
<previewUrl>__ov/open?port=<port>&path=<url-encoded path>
```

この URL は次の 2 つのパラメーターを取ります。

- `port`: このページが属する仮想ポート。指定がない、`0`、または数値でない場合は、デフォルトのポートを使います。
- `path`: サーバーで開くパスとクエリ。デフォルトは `/` です。

Service Worker は、プレビューのオリジンの `path` への `302` で応答します（パスの下で配信するときはスコープを前に付けます。
[デプロイ](deployment.ja.md#パスの下での配信) を参照）。このリダイレクトには分離用のヘッダーを付けています。単純な
`Response.redirect()` は、COEP を設定したホストページの中では拒否されるためです。また Service Worker は、このナビゲーションで
作られるページ（`resultingClientId`）に `port` を記録します。そのページのリクエストは、すべてそのポートに送られます。

```ts
const url = await vessel.previewUrl(4321, '/blog/?draft=1');
// https://preview.example.com/__ov/open?port=4321&path=%2Fblog%2F%3Fdraft%3D1
```

`server-ready` イベントの `url` には、`/` を開く同じ形式の URL が入ります（`previewUrl` がなければ `null`）。この URL は
中継を待たずに作るので、中継が接続済みであることを確実にしたい場合は `previewUrl()` か `createPreview()` を使ってください。

### `createPreview()`

`createPreview(port, { path, container })` は `previewUrl(port, path)` の完了を待ってから、新しい iframe を返します。

| 属性 | 値 |
|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock`（`allow-top-navigation` はないので、プレビューからホストのページを遷移させることはできない） |
| `allow` | `clipboard-write; fullscreen` |
| `referrerPolicy` | `no-referrer` |
| `style` | `width:100%;height:100%;border:0;background:#fff` |

`container` を渡すと、その中に追加します。`allow-same-origin` は iframe を実際のプレビューのオリジンに置くためのもので、
Service Worker がその iframe を制御するために必要です。

### 要求がどのポートへ行くか

| リクエスト | ポート |
|---|---|
| `__ov/open` へのナビゲーション | URL の `port`（作られるページに記録する） |
| プレビューの iframe 内のその他のナビゲーション（リンク、フォーム、`location` の変更、再読み込み） | ナビゲーションを始めたページのポート。なければデフォルトのポート |
| サブリソース（`fetch`、XHR、スクリプト、画像など） | リクエストしたページに記録したポート。なければデフォルトのポート |
| `http://localhost:<port>/…`（他のループバックの名前も含む）へのリクエスト | URL の `port`。なければリクエストしたページのポート。それもなければデフォルトのポート |
| ローカルの URL への WebSocket | ホストがループバックの名前でポートを明示した URL ならそのポート。そうでなければリクエストしたページのポート。それもなければデフォルトのポート |

ポート 4000 で開いた iframe の中で遷移しても、ポート 4000 のままです。異なるポートのプレビューを同時に開いておくことも
できます。デフォルトのポートは、最後に呼んだ `previewUrl()`・`createPreview()` の `port` です。

ポートの記録とデフォルトのポートは、メモリに加えて、プレビューのオリジンの Cache Storage（キャッシュ
`openvessel-preview-ports`）にも保存します。そのため、ブラウザがアイドル状態の Service Worker を再起動しても、開いている
ページはポートを維持します。なくなったページの記録は、Service Worker の起動時に削除します。許可したホストのキャッシュは
メモリにだけ持ちます。

## HTTP の要求

Service Worker は、制御しているページからの同一オリジンへのリクエストをすべて処理します。例外は `__ov/open` と
Service Worker 自身のファイル（`__ov/relay.html`・`__ov/relay.js`・`__ov/inject.js`・`__ov-sw.js`）で、これらはサーバーから
取得して分離用のヘッダーを追加します。

### 要求

| 部分 | 仮想ポートへ送るもの |
|---|---|
| メソッド | そのまま |
| URL | パスとクエリ（フラグメントは送らない）。パスの下で配信するときはスコープを取り除く |
| ヘッダー | リクエストのヘッダーから `sec-*`・`cookie`・`accept-encoding` を除き、`host: localhost:<port>` を加えたもの。`Referer` は渡さない |
| ボディ | `GET` と `HEAD` 以外のすべてのメソッド。全体を読み込み（`req.arrayBuffer()`）、1 つのメッセージで送ってから終端を送る。リクエストのボディはストリーミングしない |

`accept-encoding` を除くので、サーバーは圧縮せずに応答します。

### カーネルの側

カーネルは待ち受けのテーブルでポートを探します（`src/kernel/net.ts` の `NetRouter.request`）。

| 待ち受け | 作成元 | 届け方 | `server-ready`・`ports()` に出るか |
|---|---|---|---|
| `raw` | 移植版ランタイムのすべての TCP サーバー（`net.Server`、`http.Server` など） | `TcpBridge`: リクエストごとに socketpair の新しい接続を作り、HTTP/1.1 のバイト列で送る | 出る |
| `http`（記録するホストは待ち受けアドレスか空） | 旧ランタイムの `http.Server` | プロセスへの `http-req`／`http-res` メッセージ（[通信プロトコル](protocol.ja.md#カーネルとプロセスのメッセージ)） | 出る |
| `tcp-only` | 旧ランタイムの `net.Server` | 届かない: `connect ECONNREFUSED 127.0.0.1:<port>` | 出ない |
| なし、またはプロセスが動いていない | — | `connect ECONNREFUSED 127.0.0.1:<port>` | — |

`listen(0)` は 49152〜65151 から空いているポートを選びます。テーブルにすでにあるポートは `EADDRINUSE` になります。
待ち受けは、プロセスが終了したとき、`exec` で別のプログラムに置き換わったとき、またはサーバーを閉じたときに消え、
ホストに `port-closed` が届きます。プロセス間で共有した待ち受けソケット（`cluster` のように IPC で渡したもの）は、
接続を順番に（ラウンドロビンで）受け取ります。

#### 移植版ランタイム: ソケットの上の HTTP/1.1（`src/kernel/tcp.ts`）

待ち受けているプロセスに新しい接続（`tcp-accept`）が届きます。リモートアドレスは `127.0.0.1` で、リモートポートは 40000
から 60000 まで順に増え、上限に達すると最初に戻ります。カーネルは次の内容のリクエストヘッドを書き込みます。

- リクエスト行 `<METHOD> <url> HTTP/1.1`
- 上記のヘッダーから `connection`・`keep-alive`・`transfer-encoding`・`upgrade`・`sec-websocket-key`・
  `sec-websocket-version` を除いたもの。`Host` がなければ先頭に `Host: localhost:<port>` を付ける
- `Connection: close`（リクエストごとに 1 接続）。ボディがあって `content-length` がない場合は
  `Transfer-Encoding: chunked`（ボディを chunk で送り、`0\r\n\r\n` で終える）

レスポンスは HTTP/1.1 として解析します。`101` 以外の `1xx` は読み飛ばします。ボディは `content-length`、`chunked`
エンコーディング（trailer は捨てる）、または接続が閉じるまでのいずれかで読み、長さのない `204` と `304` にはボディが
ありません。後段に渡すヘッダーからは `transfer-encoding`・`connection`・`keep-alive` を除きます。ヘッドを受け取り終える前に
接続が閉じた場合は `socket hang up`、長さや chunk で区切られたボディの途中で閉じた場合は `incomplete response` の
エラーになります。

#### 旧ランタイム

カーネルは待ち受けているスレッドに `http-req` を送り、続けて `http-body`・`http-body-end` を送ります。プロセスから返る
`http-res`・`http-res-data`・`http-res-end`・`http-res-error` は中継して返します。プロセスがもう扱っていないポートへの
リクエストを受けた場合は、ボディ `no server` の `503 Service Unavailable` で応答します。リクエストの途中でプロセスが
終了すると、そのリクエストは `server process exited` で失敗します。

### 応答

ページは次のようにレスポンスを受け取ります。

- ステータス: 送られたとおり。ただし `101` は `200` にします。ステータステキストもそのまま渡します。
- ヘッダー: 送られたとおり。ただし `content-length`・`transfer-encoding`・`connection`・`keep-alive`・`content-encoding` は
  除きます。パスの下で配信するときは `location` をスコープの下に書き換えます。
  `cross-origin-embedder-policy: credentialless`・`cross-origin-resource-policy: cross-origin`・
  `cross-origin-opener-policy: same-origin` は、なければ追加します。ブラウザが受け付けないヘッダー値は何も通知せずに
  捨てます。`Set-Cookie` はページに届きません（Service Worker はこのヘッダーを持つレスポンスを作れないため）。
- ボディ: ストリーミングで、サーバーからのチャンクを届いた順にそのまま渡します。`204`・`205`・`304`・`HEAD` には
  ボディがありません。
- HTML へのナビゲーション: リクエストがナビゲーションで、`content-type` に `text/html` を含み、ボディがある場合は、
  ボディ全体をテキストとして（UTF-8 でデコードして）読み込み、スクリプトを挿入してから、まとめて返します。

ページがボディを取り消すと（たとえば iframe が別のページに遷移したとき）、Service Worker は `abort` を送ります。
カーネルは接続を閉じる（移植版ランタイム）か、`http-abort` を送ります（旧ランタイム）。

リクエストとレスポンスのサイズには、ブラウザのメモリ以外の上限はありません。HTML へのナビゲーションとリクエストの
ボディを除き、レスポンスはバッファリングしません。

### リダイレクト

サーバーが返した `3xx` はそのままページに返し、Service Worker がリダイレクトをたどることはありません。リダイレクトは
ブラウザが通常どおりたどります（`redirect: 'manual'` の `fetch()` には `opaqueredirect` として見えます）。ルート相対の
`Location` はプレビューのオリジンにとどまります。`http://localhost:4321/x` のような絶対 URL の `Location` はループバックの
URL なので、その仮想ポートへ送られます。こうした URL へのリクエストに対するレスポンスの `Location` は、そのまま渡します。

### エラー

| 状況 | 結果 |
|---|---|
| ポートで何も待ち受けておらず、ボディのないリクエスト | 200 ms ごとに最大 15 回（約 3 秒）再試行してから、エラーページを返す（Vite などの開発サーバーは、ポートを確認するために一瞬だけ待ち受け、少し後に改めて待ち受けるため） |
| 何も待ち受けておらず、ボディのあるリクエスト | すぐにエラーページを返す |
| レスポンスヘッドより前のエラー（移植版ランタイムの `socket hang up`、旧ランタイムの `server process exited`） | すぐにエラーページを返す |
| ヘッドの後のエラー | レスポンスボディのストリームが失敗する |
| Service Worker がカーネルとのチャネルを持っておらず、15 秒以内に得られない | リクエストはネットワークエラーで失敗する（`preview is not connected to OpenVessel`） |

エラーページは、`content-type: text/html; charset=utf-8` と分離用のヘッダーを持つ `502` です。リクエストの種類にかかわらず
これを返します。

```text
Nothing is listening on port 4999
connect ECONNREFUSED 127.0.0.1:4999
Start a dev server (for example npm run dev) and reload.
```

## WebSocket

Service Worker は WebSocket に介入できません。そこで `inject.js` が、プレビューが配信するすべての HTML ページで
`window.WebSocket` を置き換えます。URL（`ws:`・`wss:`。`http:`・`https:` はブラウザと同様に `ws:`・`wss:` に変換）の
ホストがページ自身のホストか、ループバックの名前（`localhost`、`*.localhost`、`127.0.0.0/8`、`[::1]` など。ポートは問わない）
であれば、トンネルします。それ以外の URL では、まずそのホストがネットワークポリシーで許可されているかを Service Worker に
確認し（`ws-check`。[後述](#外部へのリクエストとネットワークポリシー)）、その後ブラウザ自身の `WebSocket` を開いて、イベントと
メンバーを中継します。ブラウザの `WebSocket` が受け付けない URL（他のスキームやフラグメント付きのもの）は、そのまま渡すので、
通常どおり `SyntaxError` が投げられます。

1. ページは、自分を制御する Service Worker に、新しい `MessagePort` とあわせて
   `{ t: 'ws-connect', port, path, protocols, vport, origin }` を送ります（`vport` は、URL のホストがページと異なる場合の
   URL のポートで、同じなら 0）。
2. Service Worker はポートを選び（`vport`、なければページのポート、それもなければデフォルトのポート）、カーネルに接続を
   依頼します（`ws-open`）。ヘッダーは `sec-websocket-protocol`（要求されたプロトコルを `, ` で連結したもの）、
   `host: localhost:<port>`、`origin`（プレビューのオリジン）で、空のものは省きます。
3. 移植版ランタイムでは、カーネルが `Connection: Upgrade`・`Upgrade: websocket`・`Sec-WebSocket-Version: 13` とランダムな
   `Sec-WebSocket-Key` を付けた HTTP/1.1 の upgrade リクエストを送ります。`101` のレスポンスを受けると、サーバーが選んだ
   `Sec-WebSocket-Protocol` でソケットが開きます。旧ランタイムでは、`upgrade: true` の `http-req` を送り、`ws-open` で
   応答を受けます。
4. フレームはメッセージとして運び、テキストは文字列、バイナリは `Uint8Array` にします。移植版ランタイムでは、カーネルは
   送信するフレームをマスクし、ping には pong で応答し、close フレームからクローズコードを読み取ります（なければ `1005`）。

したがって、HMR のソケットを別のポートで待ち受ける開発サーバー（`ws://localhost:24678/`）にはそのポートで接続し、
`new WebSocket('/socket')` やページ自身のホストの URL はページのポートに接続します。`vport` がある場合はパスをそのまま送り、
ない場合は HTTP のリクエストと同様にスコープを取り除きます。

### トンネルする `WebSocket` のオブジェクト

| メンバー | 動作 |
|---|---|
| `url` | 絶対 URL |
| `readyState` | 開くまで `0`、開いたら `1`、`close()` の後は `2`、閉じたら `3` |
| `protocol` | サーバーが選んだプロトコル。開く前は `''` |
| `extensions` | 常に `''`（外部へのソケットでは、ブラウザのソケットの値） |
| `bufferedAmount` | 常に `0`（ポリシーで確認した外部へのソケットでは、ブラウザのソケットの値） |
| `binaryType` | `'blob'`（デフォルト）か `'arraybuffer'`。バイナリのメッセージは `Blob` か `ArrayBuffer` で届く |
| `send(data)` | 文字列はテキストフレーム、`ArrayBuffer`・ビュー・`Blob` はバイナリとして送る（`Blob` は読み込みが終わってから送る）。開いていなければ `InvalidStateError`（`WebSocket is not open`）を投げる |
| `close(code = 1000, reason = '')` | close を送り、サーバーの応答を待たずにすぐ `close` を通知する |
| イベント | `open`・`message`（`origin` は URL のオリジン）・`error`・`close`。`on…` プロパティと `addEventListener` のどちらでも使える |
| `error` | 一度も開かずに閉じたとき、またはコードが `1006` のとき、`close` の前に発生する |
| `close` イベント | `code`・`reason`・`wasClean`（`1000` のときだけ `true`） |
| 静的な定数 | `CONNECTING`・`OPEN`・`CLOSING`・`CLOSED` |

制御する Service Worker がなければ、ソケットはコード `1006`、理由 `no service worker` で閉じます。カーネルが接続できない
（待ち受けがない）場合は、`1006` とエラーメッセージを理由として閉じます。サーバーとの接続が close フレームなしで終わった
場合もコードは `1006` です。サーバーが upgrade に `101` ではなく通常の HTTP レスポンスを返した場合、ソケットは失敗し、
`error` の後に `1006`、理由 `Unexpected server response: <ステータスコード>` で `close` が発生します。

`window.WebSocket.prototype` はブラウザのものをそのまま使うので、`instanceof WebSocket` はトンネルしたソケットでも
ブラウザ自身のソケットでも true になります。

## 差し込むスクリプト

Service Worker は、HTML へのナビゲーションのすべてのレスポンスに `<script src="<scope>__ov/inject.js"></script>` を
挿入します。パスの下で配信する場合は、その前に import map も挿入します。挿入する位置は最初の `<head …>` タグの直後で、
なければ `<!doctype …>` の直後、それもなければ先頭です。

`inject.js` は、ページごとに 1 回だけ実行されるようにしてあります。常に行うのは、`window.WebSocket` を、ローカルの URL を
トンネルし、それ以外の URL をネットワークポリシーで確認するコンストラクタに置き換えることです（前述）。パスの下で
配信する場合に限り、`window.fetch` と `XMLHttpRequest.prototype.open` もラップし、`/` 1 つで始まり、まだスコープの下に
ない文字列の URL の前にスコープを付けます。

それ以外のことはしません。エラーのオーバーレイを表示したり、ホストにメッセージを送ったり、ランタイムにアクセスしたりする
ことはありません。

## 外部へのリクエストとネットワークポリシー

プレビューのページから別のオリジンへのリクエスト（`http:` と `https:` のみ。その他のスキームはブラウザに任せる）は、
Service Worker が送信する前に、ホストのネットワークポリシー（[ネットワークポリシー](network-policy.ja.md)）で判定します。
ループバックの URL は外部へのリクエストとしては扱わず、仮想ポートへ送ります（[要求がどのポートへ行くか](#要求がどのポートへ行くか)）。

1. そのオリジンが以前に継続的な応答（ポリシー、または「このセッション中は許可」）で許可されていれば、すぐに送信します。
   このキャッシュは、ホストが `network.setPolicy()` か `network.clearSession()` を呼んだとき（カーネルが `net-flush` を
   送ります）と、Service Worker がカーネルとの新しいチャネルを受け取ったときに空になります。拒否と「今回だけ許可」は
   キャッシュしません。「今回だけ」はその 1 回のリクエストだけを許可するものだからです。
2. それ以外の場合は、Service Worker がカーネルに問い合わせます（`net`）。カーネルはポリシーに従って判定し、`ask` モードで
   あれば `initiator: 'preview'`・`source: 'preview'` の `permission-request` を発行します（組み込みのダイアログには
   「プレビューのページが次のサイトへ接続しようとしています。」と表示されます）。同じホスト名への確認はまとめ、5 分以内に
   応答がなければ拒否になります。
3. 許可された場合は、Service Worker が元のリクエストを `fetch` します。`no-cors` のリクエスト（`<img>`、classic な
   `<script>`、CSS の `url()` など）は、リダイレクト後の最終 URL が分かるように、資格情報なしの `cors` リクエストとして
   送ります。CORS を許可していないサーバーからのこうした読み込みは失敗します（`403`、ステータステキスト
   `Blocked by OpenVessel: the server does not allow CORS, so its redirects cannot be checked`）。
4. レスポンスがリダイレクトを経ていれば、最終 URL も同じように判定します。拒否された場合はレスポンスを捨てます。
5. 拒否された場合は、ステータステキスト `Blocked by OpenVessel network policy`（タイムアウトの場合は末尾に
   ` (not answered in time)`）と空のボディを持つ `403` を返します。

Service Worker がカーネルとのチャネルを得られない場合（15 秒以内に得られない場合）は、リクエストを拒否します。次の
リクエストで、改めて中継にチャネルを要求します。

外部ホストへの WebSocket も、接続の前に同じように判定します。ページの `WebSocket` が `{ t: 'ws-check', url, port }` を
Service Worker に送り、Service Worker はそのポートに `{ allow }` で応答します。拒否されたソケットは `error` と `close`
（`1006`、`blocked by OpenVessel network policy`）で失敗します。

次の点に注意してください。

- 最終 URL より前のリダイレクト先には、ブラウザがリクエストを送ります。最終ホストが拒否された場合に渡さないのは、
  そのホストから返ったデータだけです。
- 判定を行うのは Service Worker と置き換えた `WebSocket` です。別の方法でブラウザ自身の `WebSocket` を取得したコード
  （たとえばページが起動した Worker）は判定の対象になりません。

## クッキーとストレージ

- 同じデプロイのプレビューは、ポートにかかわらずプレビューのオリジンを共有します。あるサイトが保存したクッキー、
  `localStorage`、IndexedDB、キャッシュは他のプレビューからも見え、通常のサイトと同じようにブラウザに残ります。
  利用者ごとに分けるには、セッションごとのプレビューのオリジンを使ってください（[デプロイ](deployment.ja.md#セッションごとのプレビューのオリジン)）。
- リクエストの `Cookie` ヘッダーはサーバーに渡さず、サーバーからの `Set-Cookie` もブラウザに届きません。
  `document.cookie` はプレビューのオリジンで使えますが、そのクッキーはサーバーからは見えません。

## プレビューがランタイムに頼めること・頼めないこと

カーネルのプレビュー用チャネルが受け付けるメッセージは、`req`・`body`・`body-end`・`abort`・`ws-open`・`ws-msg`・
`ws-close`・`net` だけです（[通信プロトコル](protocol.ja.md#プレビューのチャネル)）。プレビューがこのチャネルでできるのは、
仮想ポートへの HTTP リクエストと WebSocket 接続、そして外部の URL が許可されているかの確認（ホストに許可の確認ダイアログが
出ることがあります）です。ファイルの読み書き、プロセスの起動やシグナルの送信、ネットワークポリシーの変更、許可リクエスト
への応答はできません。これらのメソッドはホストのチャネルにしかないためです。中継用の iframe もプレビューのオリジンで
動いているので、それを乗っ取っても同じチャネルしか得られません。

プレビューの Service Worker が `kernel-port` と `default-port` を受け付けるのは中継からだけです。つまり、URL のパスが
`<スコープ>__ov/relay.html` に完全に一致するフレーム内のウィンドウです。`ws-connect` と `ws-check` は、制御しているどの
ページからでも受け付けます。

## 関係するソースファイル

| ファイル | 内容 |
|---|---|
| `src/preview/relay.ts`・`src/preview/relay.html` | 中継用のフレーム |
| `src/preview/sw.ts` | プレビューの Service Worker |
| `src/preview/inject.ts` | 挿入するスクリプト |
| `src/kernel/index.ts` | `attachPreview`・`checkNetwork` |
| `src/kernel/net.ts` | `NetRouter`: ポート → プロセス、旧ランタイムのメッセージの中継 |
| `src/kernel/tcp.ts` | `TcpBridge`: HTTP のメッセージ ⇄ HTTP/1.1 のバイト列、WebSocket のフレーム |
| `src/host/index.ts` | `previewUrl`・`createPreview`・中継の準備 |
| `test/e2e/preview-port.mjs` | E2E テスト: 移植版ランタイムのサーバーにプレビューからアクセスする |
