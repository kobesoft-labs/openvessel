# ネットワークポリシー

[English](network-policy.md)

OpenVessel の中からタブの外のホストへ出ていく通信は、すべて 1 つのネットワークポリシーで判定します。何を許可するかは
埋め込む側のページが決めます。このページでは、ポリシーの構造（`src/shared/policy.ts`）、リクエストを判定する順序、
利用者への確認の方法（`src/kernel/index.ts`）、ポリシーを適用する場所（`src/runtime/sw.ts`・`src/preview/sw.ts`）、
リクエストが拒否されたときに各クライアントから何が見えるかを説明します。

## ポリシーの対象

| 通信 | ポリシーの判定までの経路 | `source` / `initiator` |
|---|---|---|
| `node` のプロセスの `fetch()`（両方のランタイム） | プロセスがランタイムの Service Worker の `/__ov/net` を呼ぶ | `runtime` / pid とコマンドライン（例: `7 node server.js`） |
| ローカルでないアドレスへの `http`・`https` のクライアント、`net.connect`・`tls.connect`（移植版ランタイム） | カーネルがソケットから HTTP/1.1 を読み取り（`src/kernel/outbound.ts`）、リクエストごとに `/__ov/net` を呼ぶ | `runtime` / pid とコマンドライン |
| `http`・`https` のクライアント（旧ランタイム） | プロセスが `/__ov/net` を呼ぶ | `runtime` / pid とコマンドライン |
| `npm`・`pnpm`・`yarn`・`bun` のレジストリのメタデータと tarball | カーネルが `/__ov/net` を呼ぶ | `runtime` / `npm` |
| `curl`・`wget` | カーネルが `/__ov/net` を呼ぶ | `runtime` / pid とコマンドライン（例: `12 curl -s https://example.com/`） |
| プレビューのページから別のオリジンへのリクエスト（スクリプト、スタイル、画像、フォント、`fetch`、XHR、`EventSource`） | プレビューの Service Worker がカーネルに確認する | `preview` / `preview` |
| プレビューのページから外部ホストへの WebSocket | 接続の前に `__ov/inject.js` がプレビューの Service Worker に確認する | `preview` / `preview` |
| リダイレクトの最終的な行き先（ランタイムとプレビュー） | ブラウザがリダイレクトをたどった後、Service Worker が最終 URL をもう一度確認する | 最初の URL と同じ |

判定は常にカーネルが行います。ポリシーとセッション中の判断は、ランタイムとプレビューで 1 つを共有します。

次のものはポリシーで判定しません。

- 仮想ポートへのリクエスト。ループバックの名前へのリクエスト（プロセス、`curl`・`wget`、パッケージマネージャ、
  プレビューから）と、プレビューの同一オリジンへのリクエストです（[localhost と仮想ポート](#localhost-と仮想ポート)）。
  ループバックへの通信が利用者のマシンに届くことはありません。
- OpenVessel 自身の互換パッケージの tarball。ランタイムのオリジンの `<ランタイムの基準>/compat/` からダウンロードします。
- ランタイムのオリジンの Cache Storage（`openvessel-npm-v1`）にすでにある npm の tarball。使う前に `integrity` で
  検証します。
- リダイレクトの途中にあるホスト。Service Worker の中では、ブラウザが途中の経過を見せずにリダイレクトをたどるため、
  途中のホストにはリクエストが届きます。確認するのは最終 URL だけで、拒否された最終ホストからのデータは返しません
  （[リダイレクト](#リダイレクト)）。
- プロセスがブラウザのグローバルの `WebSocket` で開く接続（[WebSocket](#websocket)）。

## ポリシーの形

```ts
interface NetworkPolicy {
  mode: 'ask' | 'allowlist' | 'allow-all';
  presets: ('npm' | 'fonts' | 'icons' | 'cdn' | 'github')[];
  allow: string[];   // パターン
  deny: string[];    // パターン
}
```

| 項目 | デフォルト | 意味 |
|---|---|---|
| `mode` | `'ask'` | 他のどの設定でも決まらないホストの扱い |
| `presets` | `['npm', 'fonts', 'icons', 'cdn']` | 許可する組み込みのホスト一覧。`github` はデフォルトでは含まれません |
| `allow` | `[]` | 追加で許可するホスト（[パターン](#パターン)） |
| `deny` | `[]` | 拒否するホスト。`allow-all` を含め、他のすべての設定より優先されます |

`boot({ network })` や `vessel.network.setPolicy()` に渡すポリシーは `Partial<NetworkPolicy>` で、`normalizePolicy()` が
正規化します。指定のない項目は上のデフォルト値になります（現在の値ではありません）。存在しないプリセット名は捨てます。
`PRESETS` 自身のキーだけが対象なので、`toString` のような継承した名前も捨てます。`allow`・`deny` のうち文字列でない
項目も捨てます。`vessel.network.getPolicy()` は正規化後のポリシーを返します。`network` オプションがなければ、
カーネルはデフォルト値で起動します。

## モード

| モード | プリセットか `allow` に一致するホスト | それ以外のホスト |
|---|---|---|
| `ask` | 許可 | ホストページに確認する（[許可リクエスト](#許可リクエスト)） |
| `allowlist` | 許可 | 拒否 |
| `allow-all` | 許可 | 許可 |

どのモードでも、`deny` のパターン、「このセッション中は拒否」の判断、HTTP 以外の URL は拒否します。

## プリセット

`PRESETS` は `openvessel` からエクスポートしています。各項目は完全なホスト名です（ワイルドカードなし、ポートは問わない）。

| プリセット | ホスト |
|---|---|
| `npm` | `registry.npmjs.org`・`registry.npmjs.com`・`registry.yarnpkg.com`・`registry.npmmirror.com` |
| `fonts` | `fonts.googleapis.com`・`fonts.gstatic.com`・`fonts.bunny.net`・`api.fontshare.com`・`cdn.fontshare.com`・`api.fontsource.org`・`use.typekit.net`・`p.typekit.net`・`rsms.me` |
| `icons` | `api.iconify.design`・`api.simplesvg.com`・`api.unisvg.com`・`code.iconify.design`・`kit.fontawesome.com`・`ka-f.fontawesome.com` |
| `cdn` | `cdn.jsdelivr.net`・`fastly.jsdelivr.net`・`unpkg.com`・`cdnjs.cloudflare.com`・`esm.sh`・`cdn.skypack.dev`・`ga.jspm.io` |
| `github` | `github.com`・`codeload.github.com`・`raw.githubusercontent.com`・`objects.githubusercontent.com`・`api.github.com`・`gist.githubusercontent.com` |

`.npmrc` で指定したレジストリ（`registry=` や `@scope:registry=`）が `npm` プリセットに含まれていない場合は、`allow` に
追加する必要があります。GitHub からダウンロードする git の依存には、`github` プリセット（または `allow`）が必要です。

## パターン

`allow` と `deny` の項目は、リクエスト URL のホスト名とポートに対して照合するパターンです。スキームとパスはパターンに
含みません。

| パターン | 一致するもの |
|---|---|
| `example.com` | `example.com` のみ。ポートは問わない |
| `*.example.com` | `example.com` と、任意の深さのサブドメイン（`a.example.com`・`a.b.example.com`） |
| `example.com:8080` | ポート 8080 の `example.com` のみ |
| `*.example.com:8443` | ポート 8443 の `example.com` とそのサブドメインのみ |
| `*` | すべてのホスト |
| `[::1]:8080`・`[2001:db8::1]` | IPv6 アドレス。ポートは付けても付けなくてもよい |
| `::1`・`2001:db8::1` | 角かっこなしの IPv6 アドレス（ポートは付けられない） |

照合のルール（`src/shared/policy.ts` の `matches()`）:

- パターンは前後の空白を取り除き、小文字にして比較します。ホスト名は URL パーサーが小文字にします。空のパターンは
  何にも一致しません。
- `*` がワイルドカードになるのは、パターン全体が `*` のときと、先頭の `*.` のときだけです。それ以外の位置では
  ただの文字として扱います。
- パターンのポートは URL のポートと比較します。ポートのない URL は、`https:` なら `443`、`http:` なら `80` として
  扱います（`example.com:443` は `https://example.com/` に一致します）。
- IP アドレスは URL パーサーが出力する形で比較します。`127.1` や `0x7f.0.0.1` は `127.0.0.1` を意味し、IPv6 アドレスは
  省略形の小文字になります（`[2001:DB8:0:0::1]` は `2001:db8::1` に一致します）。ホストとして解析できないパターンは
  何にも一致しません。

## 判定の順序

`decide()` は URL に対して `allow`・`deny`・`ask` のいずれかを返します。次の順序で確認します。

1. URL を解析できない → deny
2. スキームが `http:` でも `https:` でもない → deny
3. ホストがループバックの名前（`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0`、`::`、IPv4 射影の
   ループバック）→ どのモードでも deny。クライアントはここに来る前にループバックを仮想ポートへ振り分けるので、
   ポリシーの判定からこうしたリクエストが利用者のマシンへ送られることはありません。
4. `deny` のパターンに一致する → deny
5. ホストがセッション中の拒否リストにある → deny
6. `mode` が `allow-all` → allow
7. ホストがセッション中の許可リストにある → allow
8. 有効なプリセットのホストに一致する → allow
9. `allow` のパターンに一致する → allow
10. `mode` が `ask` なら ask、それ以外（`allowlist`）なら deny

したがって、「このセッション中は拒否」は `allow-all` よりも優先されます。一方、セッション中の許可が `deny` の
パターンより優先されることはありません。

## セッション中の判断

カーネルは、セッション中の許可と拒否の 2 つのリストを持っています。キーはホスト名だけ（小文字、ポートなし、IPv6 は
角かっこなし）なので、あるホストをセッション中許可すると、そのホストのすべてのポートが許可されます。

| 応答 | 待機中のリクエスト | そのホストへの以降のリクエスト |
|---|---|---|
| `once` | 許可 | 再度確認する |
| `session` | 許可 | 許可（セッション中の許可リストに追加） |
| `deny` | 拒否 | 再度確認する |
| `deny-session` | 拒否 | 拒否（セッション中の拒否リストに追加） |

2 つのリストはカーネルが動いている間保持されます。`setPolicy()` では変わらず、`vessel.network.clearSession()` で
両方とも空になります。どちらを呼んだ場合も、プレビューの Service Worker がキャッシュしている許可が消えるため
（[プレビュー](#プレビュー)）、許可されなくなったホストは改めて判定されます。

## 許可リクエスト

`decide()` が `ask` を返すと、カーネルの `checkNetwork()` は次のように処理します。

1. ホストページが接続されていなければ、すぐに拒否します。
2. ホスト名ごとにまとめます。同じホストへのリクエストがすでに待機中なら、新しいリクエストはその応答を待ち、新たに
   何も送りません。ポートやパスだけが異なるリクエストは、1 つの確認を共有します。
3. それ以外の場合は、新しい `id`、完全な `url`、`host`、`initiator`、`source` を付けた `permission-request` を
   ホストページに送り、5 分のタイマーを開始します。
4. ホストページが応答したとき（`permission.respond`）か、タイマーが切れたとき（拒否）に確定します。待機中の
   リクエストはすべて同じ結果を受け取り、カーネルは `permission-settled` `{ id, host, allowed, decision }` を送ります。
   `decision` は応答（`once`・`session`・`deny`・`deny-session`）か `timeout` です。タイムアウトのときも送るので、
   ホストはダイアログを閉じることができます。すでに確定したリクエストへの応答は無視します。

ホストページでは、許可リクエストは `onPermissionRequest` か組み込みのダイアログに渡されます。その前に
`permission-request` イベントのリスナーが受け取ります。ハンドラーが例外を投げた場合は `deny` として扱います。
ハンドラー、ダイアログ、2 つのイベントの仕様は [ホスト API](host-api.ja.md#許可リクエスト) にあります。

`initiator` はカーネルが設定します。カーネル自身のクライアントからのリクエストには、カーネルだけが知っている秘密の
トークンが付くので、その表示名をそのまま使います。パッケージマネージャは `npm`、`curl` と `wget` は pid と
コマンドラインです。それ以外のリクエスト（プロセスからのもの）では、`x-ov-by` ヘッダーから pid を取り出し、
プロセステーブルにあるそのプロセスのコマンドラインを表示します。その pid のプロセスが動いていなければ `process` です。
プロセスが他の実行中のプロセスの pid を名乗ることはできますが、`npm` のような表示名を偽ることはできません。

## ポリシーの設定

```ts
const vessel = await OpenVessel.boot({
  runtimeUrl, previewUrl,
  network: { mode: 'allowlist', presets: ['npm', 'fonts', 'cdn'] },
});

await vessel.network.setPolicy({ mode: 'ask', presets: ['npm'], allow: ['api.example.com'] });
const current = await vessel.network.getPolicy();
await vessel.network.clearSession();
```

ポリシーはいつでも変更でき、変更後に判定するリクエストから適用されます。すでに応答を待っているリクエストは判定し直し
ません。ポリシーを変更できるのはホストページだけです。ランタイムの Service Worker はランタイムのウィンドウからしか
カーネルとのチャネルを受け付けず、プレビューからカーネルへのチャネルで扱えるのは HTTP、WebSocket、通信の判定だけ
だからです。

## ポリシーの適用

### ランタイム: `/__ov/net`

ランタイムの Service Worker（`src/runtime/sw.ts`）が `<ランタイムの基準>/__ov/net?url=<宛先>` に応答します。ランタイムの
中で別のオリジンに fetch するのはこのコードだけです。カーネルの基準パスはランタイムのディレクトリの下の
`/__ov/k/<カーネルの id>/` なので、リクエストはそれを送ったフレームのカーネルに届きます（[デプロイ](deployment.ja.md)）。
リクエストごとに次の処理を行います。

1. そのカーネルに `{ k: 'net', url, initiator, token }` を問い合わせます。カーネルと接続しておらず、15 秒以内に
   接続できなければ、`x-ov-error: network` 付きの `502` を返します（`OpenVessel kernel is not connected`）。
2. 拒否の場合は、`x-ov-error: denied` 付きの `403` とメッセージ
   `OpenVessel: network access to <host[:port]> was denied by the network policy` を返します。許可リクエストに
   5 分以内に応答がなければ、`x-ov-error: timeout` 付きの `504` と
   `OpenVessel: network access to <host[:port]> was not answered in time` を返します。
3. 許可された場合は、`x-ov-h` からリクエストヘッダーをコピーします。ただし `host`・`connection`・`content-length`・
   `keep-alive`・`transfer-encoding`・`upgrade`・`te`・`trailer`・`expect`・`cookie`・`cookie2`・`origin`・`referer`・
   `accept-encoding`・`access-control-request-headers`・`access-control-request-method`・`date`・`dnt`・`via`・
   `proxy-connection` と、`sec-*`・`proxy-*` のヘッダーはすべて除きます。
4. 宛先に fetch します。メソッドは `x-ov-method`、ボディは送られたもの（`GET`・`HEAD` ではなし）、`mode: 'cors'`、
   `credentials: 'omit'`、`cache: 'no-store'` で、`x-ov-redirect` が `error` なら `redirect: 'error'`、それ以外は
   `'follow'` です。
5. fetch が例外を投げた場合は、`x-ov-error: network` 付きの `502` と
   `request to <host> failed: <理由>. The server may not allow cross-origin requests (CORS) from the browser.` を返します。
6. レスポンスがリダイレクトを経ていれば、最終 URL についてカーネルにもう一度問い合わせます。拒否やタイムアウトなら
   手順 2 と同じように応答し（メッセージには最終ホストが入ります）、ボディは捨てます。
7. それ以外の場合は `200` を返します。実際のステータス、ステータステキスト、最終 URL、リダイレクトの有無、
   レスポンスヘッダーを `x-ov-status`・`x-ov-status-text`・`x-ov-url`・`x-ov-redirected`・`x-ov-rh` に入れ、ボディを
   付けます（204・205・304・`HEAD` はボディなし）。

メッセージの形式は [通信プロトコル](protocol.ja.md) にあります。

### 断られたとき・失敗したときの見え方

| クライアント | ポリシーで拒否された | 許可されたが fetch が失敗した |
|---|---|---|
| プロセスの `fetch()`（両方のランタイム） | `TypeError: fetch failed`。`cause.code === 'EACCES'`（確認がタイムアウトした場合は `ETIMEDOUT`）、`cause.message` は拒否のメッセージ | `TypeError: fetch failed`。`cause.code === 'ECONNREFUSED'` と CORS についての説明 |
| `http`・`https`・`net`・`tls` のクライアント（移植版ランタイム） | `X-OpenVessel-Error: 1`・`Connection: close` 付きの HTTP レスポンス `403 Forbidden`。ボディはメッセージ。その後、接続を閉じる | `502 Bad Gateway`。形式は同じ |
| `http`・`https` のクライアント（旧ランタイム） | `'error'` イベント。メッセージと `code: 'EACCES'` を持つ `Error` | `'error'` イベント。`code: 'ECONNREFUSED'` |
| 外部ホストへの `net.connect`（旧ランタイム） | ポリシーの判定には回らず、常に `ECONNREFUSED` | — |
| `npm` などのパッケージマネージャ | `code: 'EACCES'` のエラー（確認がタイムアウトした場合は `ETIMEDOUT`）。tarball のダウンロードはリトライしない | `code: 'ECONNREFUSED'` のエラー。tarball のダウンロードは 3 回まで試す |
| `curl`・`wget` | `curl: (7) <メッセージ>`、終了ステータス 7 | `curl: (7) <メッセージ>`、終了ステータス 7 |
| プレビューのページ | ボディが空で、ステータステキストが `Blocked by OpenVessel network policy` の `403`（タイムアウトの場合は `… (not answered in time)`） | ブラウザ自身のネットワークエラー |

移植版ランタイムのソケットのクライアントから外部に送れるのは HTTP/1.1 だけです。最初のバイト列がリクエスト行でない
接続は閉じ、WebSocket への upgrade には `501 Not Implemented` を返します（[カーネル](kernel.ja.md)）。

### プレビュー

プレビューの Service Worker（`src/preview/sw.ts`）は、自分のスコープにあるページ（プレビューの iframe と中継用の
ページ）が送るすべてのリクエストを受け取ります。

- プレビューと同一オリジン: 仮想ポートへ転送します。判定はしません。
- ループバックのホスト（`localhost`・`127.0.0.1`・`[::1]` など）: URL のポート（なければページのポート）の仮想ポートへ
  転送します。判定はせず、利用者のマシンに送ることもありません。
- 別のオリジンで `http:` か `https:`: カーネルで判定します（`source: 'preview'`）。許可された場合は、元のリクエストを
  そのまま fetch します（モードと資格情報はページが指定したとおり）。そのため、ページ自身の CORS のルールは通常どおり
  適用されます。`no-cors` のリクエスト（`<img>`、classic な `<script>` など）は CORS に対応していないサーバーからでも
  読み込めますが、レスポンスが opaque でリダイレクトの行き先が分からないため、最初の URL だけを確認します。この種の
  リクエストでは、許可したホストから拒否するホストへのリダイレクトは検出できません。それ以外のリダイレクトされた
  レスポンスは、最終的な URL でもう一度確認します。
- その他のスキーム（`data:`・`blob:` など）: 介入しません。

ランタイム側との違いは次のとおりです。

- ポリシーまたは「このセッション中は許可」の応答による許可は、Service Worker がオリジンごとにキャッシュします。
  `once` はその 1 回のリクエストだけを許可するものなので、キャッシュしません。ホストが `setPolicy()` か
  `clearSession()` を呼んだとき、または Service Worker がカーネルとの新しいチャネルを受け取ったときに、キャッシュを
  空にします。拒否はキャッシュしません。
- Service Worker が 15 秒以内にカーネルに接続できない場合、リクエストは拒否されます（`403`）。次のリクエストで再び
  接続を試みます。

### リダイレクト

Service Worker の `fetch()` では、ブラウザが途中の経過を見せずにリダイレクトをたどります（別のオリジンへの
`redirect: 'manual'` の fetch は、`Location` を含まない opaque なレスポンスになります）。そのため、どちらの Service Worker
も、リダイレクトされたレスポンスの最終的な行き先を確認します。最終 URL も最初の URL と同じようにポリシーで判定し、
拒否された場合はレスポンスを捨てて、拒否として応答します。この時点で途中のホストにはすでにリクエストが届いていますが、
そこから返ったデータがプロセスやページに渡ることはありません。`curl`・`wget`・パッケージマネージャがループバックの
URL にアクセスした場合は、リダイレクトを自分でたどります。ループバックへのリダイレクトは仮想ポートのまま扱い、
それ以外はポリシーの判定を通します。

### WebSocket

Service Worker からは WebSocket の接続が見えません。

- プレビューでは、`__ov/inject.js` が `WebSocket` を差し替えます。ページ自身のホストやループバックの名前への接続は、
  仮想サーバーへトンネルします（HMR はこの仕組みで動きます）。それ以外の URL では、まずプレビューの Service Worker に
  確認し（`ws-check`。同じホストへの `http:`・`https:` のリクエストと同じように判定します）、許可された場合だけ
  ブラウザの WebSocket を開きます。拒否された場合は `error` を発生させ、コード `1006`、理由
  `blocked by OpenVessel network policy` で `close` します。なお、ページがこの差し替えを回避することは可能です
  （たとえばページ自身が起動した Worker の `WebSocket` はブラウザのものです）。
- プロセスでは、移植版ランタイムのグローバルの `WebSocket` はブラウザのものです。ランタイムのオリジンでは後述の
  Content-Security-Policy の `connect-src` で制限されるため、接続できるのはランタイムのオリジン自身だけで、外部ホストにも
  仮想ポートにも接続できません。`net`・`tls` のソケットでは、外部ホストへの upgrade に `501` を返します。

### Content Security Policy

ポリシーが意味を持つのは、ランタイムから外へ出る経路が他にない場合だけです。`scripts/serve.mjs` は、`sw.js` 以外の
ランタイムのすべてのファイルを、`connect-src` が `'self' data: blob:` の CSP 付きで配信します。そのため、プロセスが
別のオリジンへ直接送る `fetch`・`XMLHttpRequest`・`WebSocket`・`EventSource` はブラウザがブロックし、届くのは
`/__ov/net`（同一オリジン）だけです。`sw.js` はこの CSP を付けずに配信する必要があります。本番のデプロイにも同じ
ヘッダーが必要です（[デプロイ](deployment.ja.md)）。プレビューのオリジンにはこの CSP はありません。プレビューで表示する
サイトは、前述のとおりプレビューの Service Worker が制限します。

## localhost と仮想ポート

OpenVessel の中のサーバーは仮想ポートで待ち受けます。実際のマシン上では何も待ち受けていません。`localhost`、
`127.0.0.1`、`::1`/`[::1]`、`0.0.0.0`、`*.localhost` へのリクエストは、クライアントごとに次のように扱います。

- プロセスの `fetch()`: 仮想ポートへ送ります（移植版ランタイムは Node の `http` モジュール経由、旧ランタイムは直接）。
  ポリシーでは判定しません。待ち受けがなければ `ECONNREFUSED` になります。旧ランタイムは、空のホスト名も
  ループバックとして扱います。
- プロセスの `http`・`net` のクライアント: 仮想ポートに接続します。判定はしません。待ち受けがなければ
  `ECONNREFUSED` になります。
- `curl`・`wget`・パッケージマネージャ（カーネル）: カーネルが仮想ポートへ送ります（`curl http://localhost:4321/` で
  OpenVessel の中の開発サーバーにアクセスできます）。判定はしません。待ち受けがなければ `ECONNREFUSED` になります。
  リダイレクトはたどり、ループバックへのものは仮想ポートへ、それ以外はポリシーの判定を通します。
- プレビューのページ: 自分のオリジンと `http://localhost:<port>/`（どのループバックの名前でも可）は仮想サーバーに
  届きます。ポートのないループバックの URL はページのポートを使います。判定はしません。ループバックの名前への
  WebSocket は、URL のポート、なければページのポートへトンネルします（前述）。
- それでもポリシーの判定まで来たリクエストは、どのモードでも拒否します（[判定の順序](#判定の順序)）。

## ほかのスキーム

- ポリシーは、スキームが `http:` でも `https:` でもない URL（`ws:`・`wss:`・`ftp:`・`file:` など）をすべて拒否します。
- 移植版ランタイムの `fetch()` は、`data:` と `blob:` の URL をポリシーの判定なしにブラウザの `fetch` で読み込みます。
  その他の HTTP 以外のスキームは `TypeError: fetch failed`（`cause.code === 'ERR_INVALID_URL'`、
  `unsupported URL scheme <scheme>`）で失敗させます。
- プレビューの Service Worker が判定するのは、別のオリジンへの `http:` と `https:` のリクエストだけです。

## CORS

外部へのリクエストは、ランタイムの Service Worker の中でブラウザの `fetch` が `mode: 'cors'`・`credentials: 'omit'` で
送ります。そのため、ポリシーで許可したリクエストでも、ブラウザが課すルールによって失敗したり、一部の情報が欠けた
状態で返ったりします。

- 相手のサーバーがランタイムのオリジンを許可している必要があります（`Access-Control-Allow-Origin: *` またはランタイムの
  オリジン）。プリフライトが必要なリクエスト（`GET`・`HEAD`・`POST` 以外のメソッドや、`Authorization` や独自ヘッダーの
  ような CORS セーフリストにないヘッダーを使うもの）では、サーバーが `OPTIONS` のプリフライトにも応答する必要が
  あります。そうでなければ、CORS についての説明付きで失敗します（`ECONNREFUSED`）。Google Fonts のメタデータや
  多くの RSS フィードがこれに当たります（[互換性](../compatibility.ja.md#通信)）。
- クッキーは送信も保存もしません。上に挙げた禁止ヘッダーは除きます。
- プロセスから見えるレスポンスヘッダーは、ブラウザが公開するもの（CORS セーフリストのヘッダーと
  `Access-Control-Expose-Headers` にあるもの）だけです。`Set-Cookie` は届きません。
- ボディはブラウザが展開した状態で届くため、`Content-Length` ヘッダーが見えていても、ボディの長さと一致しない
  ことがあります。
- TLS の処理と検証はブラウザが行います。

## 例

npm だけを許可し、それ以外には接続せず、確認もしない場合:

```ts
network: { mode: 'allowlist', presets: ['npm'] }
```

デフォルトのプリセットに API を 1 つ追加し、それ以外は利用者に確認する場合:

```ts
network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'], allow: ['api.example.com', '*.example.org'] }
```

一部のホスト以外はすべて許可する場合:

```ts
network: { mode: 'allow-all', deny: ['*.doubleclick.net', 'analytics.example.com'] }
```

標準でないポートで動く社内のレジストリと、git の依存のための GitHub を許可する場合:

```ts
network: { mode: 'allowlist', presets: ['npm', 'github'], allow: ['npm.internal.example.com:8443'] }
```

リストにないものはダイアログを出さずに拒否し、拒否したものをログに残す場合:

```ts
const vessel = await OpenVessel.boot({
  runtimeUrl, previewUrl,
  network: { mode: 'ask', presets: ['npm', 'fonts', 'cdn'] },
  onPermissionRequest: (req) => { console.log('blocked', req.host, req.initiator); return 'deny-session'; },
});
```

`mode: 'allowlist'` では確認が発生しないので、ハンドラーは呼ばれません。`'deny-session'` ならホストごとに 1 回、
`'deny'` なら拒否したリクエストごとにログを残します（1 件が待機中の間は、ホストごとにまとめられます）。

アプリ独自の確認ダイアログを使う場合:

```ts
onPermissionRequest: async (req) => {
  const ok = await myConfirm(`${req.source === 'preview' ? 'The preview' : req.initiator} wants ${req.host}`);
  return ok ? 'session' : 'deny-session';
},
```
