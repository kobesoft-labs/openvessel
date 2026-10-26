# プレビュー

[English](preview.md)

OpenVessel の中で動くサーバーを iframe に表示するしくみです。中継の iframe とプレビューの Service Worker、
`__ov/open` の URL、HTTP の要求・応答と WebSocket を仮想ポートまで運んで戻す方法、差し込むスクリプトの役目、
プレビューにできることとできないことをまとめます。メッセージの形は [通信の形式](protocol.ja.md) に、ヘッダーと
配信は [配信](deployment.ja.md) にあります。

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

| 部品 | ソース | 役目 |
|---|---|---|
| 中継の iframe | `src/preview/relay.html`・`src/preview/relay.ts` | 見えない。プレビューのオリジンにある。プレビューの Service Worker を登録し、ホストが作ったカーネルへの通り道を渡す |
| プレビューの Service Worker | `src/preview/sw.ts`（`dist/preview/__ov-sw.js`） | プレビューのページのすべての要求に仮想ポートから答える。WebSocket をトンネルする。HTML に `inject.js` を差し込む。ほかのオリジンへの要求に通信の方針を当てる |
| 差し込むスクリプト | `src/preview/inject.ts`（`dist/preview/__ov/inject.js`） | ローカルの URL への `window.WebSocket` を置き換える。パスの下で配信するときは、ルートからの `fetch`/XHR の URL を補正する |
| カーネルの側 | `src/kernel/index.ts`（`attachPreview`）・`src/kernel/net.ts`・`src/kernel/tcp.ts` | ポートで待ち受けているプロセスへ要求を回す |
| ホストの側 | `src/host/index.ts`（`previewUrl`・`createPreview`） | 中継とプレビューの iframe を作り、中継をカーネルにつなぐ |

手元のマシンには何も開きません。ポートはカーネルの表の項目で、ブラウザのページからそこへ届く道は、この Service Worker
だけです。

## プレビューの始まり

`vessel.previewUrl(port, path?)` と `vessel.createPreview(port, opts?)` には、`OpenVessel.boot()` の `previewUrl` が要ります。
無いときは `OpenVessel: previewUrl was not configured` で reject します。

最初の呼び出しで中継を作ります（2 回目からは使い回します）。

1. ホストが見えない iframe `<previewUrl>__ov/relay.html` を足す（`aria-hidden`・`tabIndex = -1`・大きさ 0・`visibility:hidden`）。
2. `relay.js` が `../__ov-sw.js` をスコープ `../` で登録し、`navigator.serviceWorker.ready` を待って、親に
   `openvessel-preview-loaded` を送る。
3. ホストが `MessageChannel` を作り、片方をカーネルに（カーネルへの通り道で `{ t: 'preview-port', port }`）、もう片方を
   中継に（`defaultPort` 付きの `openvessel-preview-connect`）送る。
4. 中継がそのポートを動いている Service Worker に渡し（`kernel-port`）、`openvessel-preview-ready` を送る。ホストの
   promise が解決する。中継がこれらのメッセージを受けるのは親からだけで、それも親が別のオリジン（ホスト）のときだけ
   （中継を自分の iframe に入れたプレビューのページからは受けない）。新しい通り道は古いものに代わり、Service Worker は
   古いほうを閉じる。カーネルはそこでまだ開いていた要求とソケットを打ち切る。

20000 ms のうちに中継の準備ができなければ、`OpenVessel: preview relay did not start` で reject します。2 回目からの
`previewUrl()`・`createPreview()` は、そのポートを `openvessel-preview-default-port` で送り、既定のポートにします。

## `__ov/open` の URL

```text
<previewUrl>__ov/open?port=<port>&path=<url-encoded path>
```

| パラメーター | 意味 | 既定 |
|---|---|---|
| `port` | このページが属する仮想ポート | 既定のポート（無い・`0`・数でないとき） |
| `path` | サーバーで開くパスとクエリ | `/` |

Service Worker は、プレビューのオリジンの `path` への `302` で答えます（パスの下で配信するときはスコープを前に付けます。
[配信](deployment.ja.md#パスの下での配信) を参照）。このリダイレクトには分離のヘッダーが付いています。ただの
`Response.redirect()` は、COEP のホストのページの中では拒まれるためです。Service Worker はさらに、この移動で生まれる
ページ（`resultingClientId`）に `port` を記録します。そのページの要求は、すべてそのポートへ行きます。

```ts
const url = await vessel.previewUrl(4321, '/blog/?draft=1');
// https://preview.example.com/__ov/open?port=4321&path=%2Fblog%2F%3Fdraft%3D1
```

`server-ready` のイベントは、`/` を開く同じ形の URL を `url` に持ちます（`previewUrl` が無ければ `null`）。この URL は
中継を待たずに作るので、中継がつながっていることを確かめたいときは `previewUrl()` か `createPreview()` を使ってください。

### `createPreview()`

`createPreview(port, { path, container })` は `previewUrl(port, path)` を待ってから、新しい iframe を返します。

| 属性 | 値 |
|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock`（`allow-top-navigation` は無い。プレビューはホストのページを移動させられない） |
| `allow` | `clipboard-write; fullscreen` |
| `referrerPolicy` | `no-referrer` |
| `style` | `width:100%;height:100%;border:0;background:#fff` |

`container` を渡せば、その中に足します。`allow-same-origin` は、iframe を本物のプレビューのオリジンに置くためのものです。
Service Worker がその iframe を制御するのに必要です。

### 要求がどのポートへ行くか

| 要求 | ポート |
|---|---|
| `__ov/open` への移動 | URL の `port`（生まれるページに記録する） |
| プレビューの iframe の中のほかの移動（リンク・フォーム・`location` の変更・読み直し） | 移動を始めたページのポート。無ければ既定のポート |
| サブリソース（`fetch`・XHR・スクリプト・画像など） | 要求したページに記録したポート。無ければ既定のポート |
| `http://localhost:<port>/…`（ほかのループバックの名前も）への要求 | URL の `port`。無ければ要求したページのポート。それも無ければ既定のポート |
| ローカルの URL への WebSocket | ホストがループバックの名前でポートを明示した URL なら、そのポート。そうでなければ要求したページのポート。それも無ければ既定のポート |

ポート 4000 で開いた iframe の中で移動しても、ポート 4000 のままです。別々のポートのプレビューを同時に開いておけます。
既定のポートは、いちばん最近の `previewUrl()`・`createPreview()` の `port` です。

ポートの記録と既定のポートは、メモリのほか、プレビューのオリジンの Cache Storage（キャッシュ `openvessel-preview-ports`）
にも置きます。なので、ブラウザが暇な Service Worker を起動し直しても、開いたままのページはポートを保ちます。もう無い
ページの記録は、Service Worker が起動するときに捨てます。許可したホストの控えはメモリだけです。

## HTTP の要求

制御しているページの同じオリジンへの要求は、すべて Service Worker が扱います。例外は自分のファイル（`__ov/relay.html`・
`__ov/relay.js`・`__ov/inject.js`・`__ov-sw.js`。サーバーから取り、分離のヘッダーを足す）と `__ov/open` です。

### 要求

| 部分 | 仮想ポートへ送るもの |
|---|---|
| メソッド | そのまま |
| URL | パスとクエリ（フラグメントは送らない）。パスの下で配信するときはスコープを取り除く |
| ヘッダー | 要求のヘッダーから `sec-*`・`cookie`・`accept-encoding` を除き、`host: localhost:<port>` を足したもの。`Referer` は渡らない |
| 本文 | `GET` と `HEAD` 以外のすべてのメソッド。全部を読んで（`req.arrayBuffer()`）1 つのメッセージで送り、終わりの印を送る。要求の本文はストリームしない |

`accept-encoding` を除くので、サーバーは圧縮せずに答えます。

### カーネルの側

カーネルは待ち受けの表でポートを引きます（`src/kernel/net.ts` の `NetRouter.request`）。

| 待ち受け | 作るもの | 届け方 | `server-ready`・`ports()` に出るか |
|---|---|---|---|
| `raw` | 移植版ランタイム: すべての TCP サーバー（`net.Server`・`http.Server` など） | `TcpBridge`: 要求ごとに socketpair の新しい接続を作り、HTTP/1.1 のバイト列で | 出る |
| `http`（記録のホストは待ち受けのアドレスか空） | 旧ランタイムの `http.Server` | プロセスへの `http-req`／`http-res` のメッセージ（[通信の形式](protocol.ja.md#カーネルとプロセスのメッセージ)） | 出る |
| `tcp-only` | 旧ランタイムの `net.Server` | 届かない: `connect ECONNREFUSED 127.0.0.1:<port>` | 出ない |
| 無い、またはプロセスが動いていない | — | `connect ECONNREFUSED 127.0.0.1:<port>` | — |

`listen(0)` は 49152〜65151 の空いたポートを選びます。表にすでにあるポートは `EADDRINUSE` になります。待ち受けは、
そのプロセスが終わるか、`exec` でほかのプログラムになるか、サーバーを閉じると消え、ホストに `port-closed` が届きます。
プロセスのあいだで共有した待ち受けのソケット（`cluster` のように IPC で渡したもの）は、接続を順番に（ラウンドロビンで）
受け取ります。

#### 移植版ランタイム: ソケットの上の HTTP/1.1（`src/kernel/tcp.ts`）

待ち受けているプロセスに新しい接続（`tcp-accept`）が届きます。相手のアドレスは `127.0.0.1`、相手のポートは 40000 から
60000 まで数え上げて一周します。カーネルが要求の頭を書きます。

- 要求の行 `<METHOD> <url> HTTP/1.1`
- 上のヘッダーから `connection`・`keep-alive`・`transfer-encoding`・`upgrade`・`sec-websocket-key`・`sec-websocket-version`
  を除いたもの。`Host` が無ければ `Host: localhost:<port>` を先頭に
- `Connection: close`（要求ごとに 1 接続）。本文があって `content-length` が無いときは `Transfer-Encoding: chunked`
  （本文を chunk で送り、`0\r\n\r\n` で終える）

応答は HTTP/1.1 として読みます。`101` 以外の `1xx` は読み飛ばします。本文は `content-length`、`chunked`（trailer は捨てる）、
または接続が閉じるまで読みます。長さの無い `204` と `304` には本文がありません。先へ渡すヘッダーからは
`transfer-encoding`・`connection`・`keep-alive` を除きます。エラーは、頭が揃う前に接続が閉じれば `socket hang up`、
長さや chunk で区切った本文の途中で閉じれば `incomplete response` です。

#### 旧ランタイム

カーネルは待ち受けているスレッドに `http-req`、続いて `http-body`・`http-body-end` を送り、`http-res`・`http-res-data`・
`http-res-end`・`http-res-error` を送り返します。もう扱っていないポートへの要求を受けたプロセスは、本文 `no server` の
`503 Service Unavailable` で答えます。要求の途中でプロセスが終わると、要求は `server process exited` で失敗します。

### 応答

| 部分 | ページが受け取るもの |
|---|---|
| ステータス | 送られたまま。ただし `101` は `200` にする。ステータスの文もそのまま |
| ヘッダー | 送られたまま。ただし `content-length`・`transfer-encoding`・`connection`・`keep-alive`・`content-encoding` を除く。パスの下で配信するときは `location` をスコープの下に書き換える。`cross-origin-embedder-policy: credentialless`・`cross-origin-resource-policy: cross-origin`・`cross-origin-opener-policy: same-origin` を、無ければ足す。ブラウザが受け付けない値のヘッダーは黙って落とす。`Set-Cookie` はページに届かない（Service Worker はこれを持つ応答を作れない） |
| 本文 | ストリームする。サーバーからの塊を、届いたそばから渡す。`204`・`205`・`304`・`HEAD` には本文が無い |
| HTML への移動 | 要求が移動で、`content-type` に `text/html` を含み、本文があるときは、本文全体を文字列として（UTF-8 で）読み、スクリプトを差し込み、ひとまとめで返す |

ページが本文を取り消すと（たとえば iframe がほかへ移動すると）、Service Worker は `abort` を送ります。カーネルは接続を
閉じる（移植版ランタイム）か、`http-abort` を送ります（旧ランタイム）。

ブラウザのメモリのほかに、要求と応答の大きさの上限はありません。HTML への移動と要求の本文を除き、応答は溜めません。

### リダイレクト

サーバーの `3xx` は、そのままページに返します。Service Worker がリダイレクトをたどることはありません。ブラウザがいつも
どおりたどります（`redirect: 'manual'` の `fetch()` には `opaqueredirect` が見えます）。ルートからの相対の `Location` は
プレビューのオリジンに留まります。`http://localhost:4321/x` のような絶対の `Location` はループバックの URL なので、
その仮想ポートへ行きます。そうした URL への要求の応答の `Location` は、そのまま渡します。

### エラー

| 場面 | 結果 |
|---|---|
| ポートで誰も待ち受けていない、本文の無い要求 | 200 ms ごとに最大 15 回（約 3 秒）やり直してから、エラーのページ。Vite のような開発サーバーは、ポートを確かめるために一瞬だけ待ち受け、少しあとで本当に待ち受けるため |
| 誰も待ち受けていない、本文のある要求 | すぐにエラーのページ |
| 応答の頭より前のエラー（移植版ランタイムの `socket hang up`、旧ランタイムの `server process exited`） | すぐにエラーのページ |
| 頭のあとのエラー | 応答の本文のストリームが失敗する |
| Service Worker にカーネルへの通り道が無く、15 秒のうちに得られない | 要求はネットワークのエラーで失敗する（`preview is not connected to OpenVessel`） |

エラーのページは、`content-type: text/html; charset=utf-8` と分離のヘッダーを持つ `502` です。要求の種類によらず返します。

```text
Nothing is listening on port 4999
connect ECONNREFUSED 127.0.0.1:4999
Start a dev server (for example npm run dev) and reload.
```

## WebSocket

Service Worker は WebSocket を横取りできません。そこで `inject.js` が、プレビューが配信するすべての HTML で
`window.WebSocket` を置き換えます。URL（`ws:`・`wss:`。`http:`・`https:` はブラウザと同じく `ws:`・`wss:` に直す）の
ホストがページ自身のホストか、ループバックの名前（`localhost`・`*.localhost`・`127.0.0.0/8`・`[::1]` など。ポートは問わない）
ならトンネルします。それ以外の URL では、まずそのホストが通信の方針で許されるかを Service Worker に尋ね（`ws-check`。
[下](#外への要求と通信の方針) を参照）、そのあとブラウザ自身の `WebSocket` を開いて、イベントとメンバーを中継します。
ブラウザの `WebSocket` が受け付けない URL（ほかのスキームやフラグメント付き）は、そのまま渡すので、いつもの
`SyntaxError` になります。

1. ページは、新しい `MessagePort` と一緒に `{ t: 'ws-connect', port, path, protocols, vport, origin }` を、自分を制御する
   Service Worker に送る（`vport` は、ホストがページと違うときの URL のポート。同じなら 0）。
2. Service Worker はポートを選び（`vport`、無ければページのポート、無ければ既定のポート）、カーネルに開くよう頼む
   （`ws-open`）。ヘッダーは `sec-websocket-protocol`（求めたプロトコルを `, ` でつないだもの）・`host: localhost:<port>`・
   `origin`（プレビューのオリジン）で、空のものは省く。
3. 移植版ランタイム: カーネルは `Connection: Upgrade`・`Upgrade: websocket`・`Sec-WebSocket-Version: 13` と乱数の
   `Sec-WebSocket-Key` を付けた HTTP/1.1 の upgrade の要求を送る。`101` の応答で、サーバーが選んだ
   `Sec-WebSocket-Protocol` のソケットが開く。旧ランタイム: `upgrade: true` の `http-req` を送り、`ws-open` で答えが来る。
4. フレームはメッセージで運ぶ。テキストは文字列、バイナリは `Uint8Array`。移植版ランタイムでは、カーネルは自分が送る
   フレームをマスクし、ping には pong で答え、close のフレームから閉じるコードを読む（無ければ `1005`）。

なので、HMR のソケットを別のポートで待ち受ける開発サーバー（`ws://localhost:24678/`）にはそのポートで届き、
`new WebSocket('/socket')` やページ自身のホストの URL はページのポートへ行きます。`vport` があるときはパスをそのまま送り、
無いときは HTTP の要求と同じくスコープを取り除きます。

### トンネルする `WebSocket` のオブジェクト

| メンバー | ふるまい |
|---|---|
| `url` | 絶対の URL |
| `readyState` | 開くまで `0`、開いたら `1`、`close()` のあと `2`、閉じたら `3` |
| `protocol` | サーバーが選んだプロトコル。開く前は `''` |
| `extensions` | いつも `''`（方針で確かめた外へのソケットでは、ブラウザのソケットのもの） |
| `bufferedAmount` | いつも `0`（外へのソケットでは、ブラウザのソケットのもの） |
| `binaryType` | `'blob'`（既定）か `'arraybuffer'`。バイナリのメッセージは `Blob` か `ArrayBuffer` で届く |
| `send(data)` | 文字列はテキストのフレーム、`ArrayBuffer`・ビュー・`Blob` はバイナリ（`Blob` は読み終えてから送る）。開いていなければ `InvalidStateError`（`WebSocket is not open`）を投げる |
| `close(code = 1000, reason = '')` | close を送り、サーバーを待たずにすぐ `close` を知らせる |
| イベント | `open`・`message`（`origin` は URL のオリジン）・`error`・`close`。`on…` のプロパティと `addEventListener` の両方 |
| `error` | 開かないまま閉じたとき、またはコードが `1006` のとき、`close` の前に出る |
| `close` のイベント | `code`・`reason`・`wasClean`（`1000` のときだけ `true`） |
| 静的な定数 | `CONNECTING`・`OPEN`・`CLOSING`・`CLOSED` |

制御する Service Worker が無ければ、ソケットはコード `1006`、理由 `no service worker` で閉じます。カーネルがつなげない
（待ち受けが無い）ときは、`1006` とエラーのメッセージを理由にして閉じます。サーバーとの接続が close のフレーム無しに
終わったときも `1006` です。サーバーが upgrade に `101` ではなくふつうの HTTP の応答を返すと、ソケットは失敗します。
`error` のあと、`1006`・理由 `Unexpected server response: <状態コード>` で `close` します。

`window.WebSocket.prototype` はブラウザのままで、`instanceof WebSocket` はトンネルしたソケットでもブラウザ自身のものでも
true です。

## 差し込むスクリプト

Service Worker は、HTML への移動のすべての応答に次を差し込みます。

- `<script src="<scope>__ov/inject.js"></script>`。パスの下で配信するときは、その前に import map
- 場所は最初の `<head …>` のすぐあと。無ければ `<!doctype …>` のすぐあと。それも無ければ先頭

`inject.js`（ページごとに 1 回だけ動くよう守っています）がすること:

| すること | いつ |
|---|---|
| `window.WebSocket` を、ローカルの URL をトンネルし、ほかの URL を通信の方針で確かめるコンストラクタに置き換える（上） | いつも |
| `window.fetch` と `XMLHttpRequest.prototype.open` を包み、`/` 1 つで始まり、まだスコープの下にない文字列の URL の前にスコープを付ける | パスの下で配信するときだけ |

それ以外のことはしません。エラーの表示も、ホストへのメッセージも、ランタイムへの手出しもありません。

## 外への要求と通信の方針

プレビューのページからほかのオリジンへの要求（`http:` と `https:` だけ。ほかのスキームはブラウザに任せる）は、
Service Worker が送る前に、ホストの通信の方針（[通信の方針](network-policy.ja.md)）と照らし合わせます。ループバックの
URL は外への要求ではなく、仮想ポートへ行きます（[要求がどのポートへ行くか](#要求がどのポートへ行くか)）。

1. そのオリジンを長く続く答え（方針、または「このセッション中は許可」）で許したことがあれば、すぐに送る。この控えは、
   ホストが `network.setPolicy()` か `network.clearSession()` を呼んだとき（カーネルが `net-flush` を送る）と、Service Worker
   がカーネルへの新しい通り道を受け取ったときに捨てる。拒否と「今回だけ許可」は覚えない。「今回だけ」はその 1 回の要求だけを
   許す。
2. そうでなければ、Service Worker がカーネルに尋ねる（`net`）。カーネルは方針で決め、`ask` のモードなら
   `initiator: 'preview'`・`source: 'preview'` の `permission-request` を出す（組み込みのダイアログは「プレビューのページ
   が次のサイトへ接続しようとしています。」と表示する）。同じホスト名への問い合わせはまとめる。答えの無い問い合わせは
   5 分で拒否になる。
3. 許されたら、Service Worker が元の要求を `fetch` する。`no-cors` の要求（`<img>`・ふつうの `<script>`・CSS の `url()`
   など）は、リダイレクトのあとの最後の URL が見えるように、資格情報なしの `cors` の要求として出す。CORS を許さない
   サーバーからのこうした読み込みは失敗する（`403`、ステータスの文
   `Blocked by OpenVessel: the server does not allow CORS, so its redirects cannot be checked`）。
4. 応答がリダイレクトを経ていれば、最後の URL も同じように確かめる。断られたら応答を捨てる。
5. 拒まれたら、ステータスの文 `Blocked by OpenVessel network policy`（時間切れなら後ろに ` (not answered in time)`）と
   空の本文の `403`。

Service Worker がカーネルへの通り道を得られないとき（15 秒のうちに無いとき）は、要求を断ります。次の要求で、また中継に
通り道を頼みます。

外のホストへの WebSocket も、つなぐ前に同じように確かめます。ページの `WebSocket` が `{ t: 'ws-check', url, port }` を
Service Worker に送り、Service Worker はそのポートに `{ allow }` で答えます。断られたソケットは `error` と `close`
（`1006`・`blocked by OpenVessel network policy`）で失敗します。

気をつける点:

- 最後の URL より前のリダイレクトの飛び先には、ブラウザが要求を送ります。断られたときに渡さないのは、最後のホストから
  来たものだけです。
- 確かめるのは Service Worker と差し替えた `WebSocket` です。ほかの方法でブラウザ自身の `WebSocket` を手に入れたコード
  （たとえばページが起こした Worker）は確かめません。

## クッキーとストレージ

- ひとつの配置のプレビューは、ポートによらずプレビューのオリジンを共有します。あるサイトが書いたクッキー・
  `localStorage`・IndexedDB・キャッシュは、ほかのプレビューからも見え、ふつうのサイトと同じようにブラウザに残ります。
  利用者を分けるには、セッションごとのプレビューのオリジンを使ってください（[配信](deployment.ja.md#セッションごとのプレビューのオリジン)）。
- 要求の `Cookie` のヘッダーはサーバーへ渡らず、サーバーの `Set-Cookie` もブラウザに届きません。`document.cookie` は
  プレビューのオリジンで使えますが、そのクッキーはサーバーには見えません。

## プレビューがランタイムに頼めること・頼めないこと

カーネルのプレビュー用の通り道が受け付けるメッセージは、`req`・`body`・`body-end`・`abort`・`ws-open`・`ws-msg`・
`ws-close`・`net` だけです（[通信の形式](protocol.ja.md#プレビューの通り道)）。これでプレビューにできるのは、仮想ポートへの
HTTP の要求と WebSocket の接続、それに外の URL が許されるかを尋ねること（ホストに許可の確認が出ることがある）です。
ファイルの読み書き、プロセスの起動やシグナル、通信の方針の変更、許可の確認への回答はできません。これらのメソッドは
ホストの通り道にしかありません。中継の iframe もプレビューのオリジンで動くので、それを乗っ取っても同じ通り道しか
得られません。

プレビューの Service Worker が `kernel-port` と `default-port` を受け付けるのは、中継からだけです。つまり、URL のパスが
ちょうど `<スコープ>__ov/relay.html` の、iframe の中のウィンドウです。`ws-connect` と `ws-check` は、制御しているどの
ページからでも受け付けます。

## 関係するソースファイル

| ファイル | 中身 |
|---|---|
| `src/preview/relay.ts`・`src/preview/relay.html` | 中継のフレーム |
| `src/preview/sw.ts` | プレビューの Service Worker |
| `src/preview/inject.ts` | 差し込むスクリプト |
| `src/kernel/index.ts` | `attachPreview`・`checkNetwork` |
| `src/kernel/net.ts` | `NetRouter`: ポート → プロセス、旧ランタイムのメッセージの橋渡し |
| `src/kernel/tcp.ts` | `TcpBridge`: HTTP のメッセージ ⇄ HTTP/1.1 のバイト列、WebSocket のフレーム |
| `src/host/index.ts` | `previewUrl`・`createPreview`・中継の準備 |
| `test/e2e/preview-port.mjs` | エンドツーエンドのテスト: 移植版ランタイムのサーバーにプレビューから届く |
