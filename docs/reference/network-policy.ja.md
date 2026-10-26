# 通信の方針

[English](network-policy.md)

OpenVessel の中からタブの外のホストへ届くものは、すべて 1 つの関所を通ります。その関所が何を通すかは、埋め込む側の
ページが決めます。このページでは、方針の形（`src/shared/policy.ts`）、要求を判定する順番、利用者への尋ね方
（`src/kernel/index.ts`）、方針を効かせる場所（`src/runtime/sw.ts`・`src/preview/sw.ts`）、断られたときにそれぞれの
クライアントから何が見えるかを説明します。

## 関所を通るもの

| 通信 | 関所までの道 | `source` / `initiator` |
|---|---|---|
| `node` のプロセスの `fetch()`（両方の層） | プロセスがランタイムの Service Worker の `/__ov/net` を呼ぶ | `runtime` / pid とコマンド行（例: `7 node`） |
| ローカルでないアドレスへの `http`・`https` のクライアント、`net.connect`・`tls.connect`（移植した層） | カーネルがソケットから HTTP/1.1 を読み（`src/kernel/outbound.ts`）、要求ごとに `/__ov/net` を呼ぶ | `runtime` / pid とコマンド行 |
| `http`・`https` のクライアント（旧来の層） | プロセスが `/__ov/net` を呼ぶ | `runtime` / pid とコマンド行 |
| `npm`・`pnpm`・`yarn`・`bun` のレジストリの情報と tarball | カーネルが `/__ov/net` を呼ぶ | `runtime` / `npm` |
| `curl`・`wget` | カーネルが `/__ov/net` を呼ぶ | `runtime` / `npm` |
| プレビューのページから別のオリジンへの要求（スクリプト・スタイル・画像・フォント・`fetch`・XHR・`EventSource`） | プレビューの Service Worker がカーネルに尋ねる | `preview` / `preview` |

判定はいつもカーネルがします。方針も、セッション中の判断も、ランタイムとプレビューで 1 つを共有します。

方針で判定しないもの:

- 仮想ポートへの要求。プロセスからのループバックの名前と、プレビューの同じオリジンへの要求です
  （[localhost と仮想ポート](#localhost-と仮想ポート)）。
- OpenVessel 自身の互換パッケージの tarball。ランタイムのオリジンの `<ランタイムの基準>/compat/` から取ります。
- ランタイムのオリジンの Cache Storage（`openvessel-npm-v1`）に入っている npm の tarball。使う前に `integrity` で
  確かめます。
- リダイレクトの先のホスト。最初の URL が許されたあと、リダイレクトは Service Worker の中でブラウザがたどります。
- WebSocket の接続。Service Worker からは見えません（[WebSocket](#websocket)）。

## ポリシーの形

```ts
interface NetworkPolicy {
  mode: 'ask' | 'allowlist' | 'allow-all';
  presets: ('npm' | 'fonts' | 'icons' | 'cdn' | 'github')[];
  allow: string[];   // パターン
  deny: string[];    // パターン
}
```

| 項目 | 既定 | 意味 |
|---|---|---|
| `mode` | `'ask'` | ほかのどれでも決まらないホストをどうするか。 |
| `presets` | `['npm', 'fonts', 'icons', 'cdn']` | 許す、用意したホストの一覧。`github` は既定では入っていません。 |
| `allow` | `[]` | ほかに許すホスト（[パターン](#パターン)）。 |
| `deny` | `[]` | 断るホスト。`allow-all` も含めて、何よりも勝ちます。 |

`boot({ network })` や `vessel.network.setPolicy()` に渡す方針は `Partial<NetworkPolicy>` で、`normalizePolicy()` が
整えます。無い項目は上の既定の値になり（いまの値ではありません）、無いセットの名前は捨てます。
`vessel.network.getPolicy()` は整えた方針を返します。`network` のオプションが無ければ、カーネルは既定の値で
始まります。

## モード

| モード | 用意したセットか `allow` に合うホスト | ほかのホスト |
|---|---|---|
| `ask` | 許す | ホストのページに尋ねる（[許可の問い合わせ](#許可の問い合わせ)） |
| `allowlist` | 許す | 断る |
| `allow-all` | 許す | 許す |

どのモードでも、`deny` のパターン、「このセッション中は拒否」の判断、HTTP でない URL は断ります。

## 用意したセット

`PRESETS` は `openvessel` からエクスポートしています。どの項目もホスト名そのもので（ワイルドカードなし、ポートは
問わない）、次のとおりです。

| セット | ホスト |
|---|---|
| `npm` | `registry.npmjs.org`・`registry.npmjs.com`・`registry.yarnpkg.com`・`registry.npmmirror.com` |
| `fonts` | `fonts.googleapis.com`・`fonts.gstatic.com`・`fonts.bunny.net`・`api.fontshare.com`・`cdn.fontshare.com`・`api.fontsource.org`・`use.typekit.net`・`p.typekit.net`・`rsms.me` |
| `icons` | `api.iconify.design`・`api.simplesvg.com`・`api.unisvg.com`・`code.iconify.design`・`kit.fontawesome.com`・`ka-f.fontawesome.com` |
| `cdn` | `cdn.jsdelivr.net`・`fastly.jsdelivr.net`・`unpkg.com`・`cdnjs.cloudflare.com`・`esm.sh`・`cdn.skypack.dev`・`ga.jspm.io` |
| `github` | `github.com`・`codeload.github.com`・`raw.githubusercontent.com`・`objects.githubusercontent.com`・`api.github.com`・`gist.githubusercontent.com` |

`.npmrc` に書いたレジストリ（`registry=` や `@scope:registry=`）が `npm` のセットに無ければ、`allow` に足す必要が
あります。GitHub から取る git の依存には `github` のセット（か `allow`）が要ります。

## パターン

`allow` と `deny` の項目は、要求の URL のホスト名とポートに当てるパターンです。スキームとパスはパターンに含みません。

| パターン | 合うもの |
|---|---|
| `example.com` | `example.com` そのもの。ポートは問わない |
| `*.example.com` | `example.com` と、どの深さのサブドメインも（`a.example.com`・`a.b.example.com`） |
| `example.com:8080` | ポート 8080 の `example.com` だけ |
| `*.example.com:8443` | ポート 8443 の `example.com` とサブドメインだけ |
| `*` | すべてのホスト |

決まり（`src/shared/policy.ts` の `matches()`）:

- パターンは前後の空白を除き、小文字にして比べます。ホスト名は URL の解析で小文字になります。空のパターンは何にも
  合いません。
- `*` がワイルドカードになるのは、パターン全体のときと、先頭の `*.` のときだけです。ほかの位置ではただの文字です。
- パターンのポートは URL のポートと比べます。ポートの無い URL は、`https:` なら `443`、`http:` なら `80` として扱い
  ます（`example.com:443` は `https://example.com/` に合います）。
- IP アドレスは書いたとおりに比べます（`192.168.0.10`）。IPv6 のアドレスには合わせられません。ホストは角かっこを
  外して比べ、`[` で始まるパターンは何にも合いません。

## 決める順番

`decide()` は URL について `allow`・`deny`・`ask` のどれかを返します。調べる順番は次のとおりです。

1. URL を解析できない → **deny**
2. スキームが `http:` でも `https:` でもない → **deny**
3. `deny` のパターンに合う → **deny**
4. ホストがセッション中の拒否の集まりにある → **deny**
5. `mode` が `allow-all` → **allow**
6. ホストがセッション中の許可の集まりにある → **allow**
7. 有効なセットのホストに合う → **allow**
8. `allow` のパターンに合う → **allow**
9. `mode` が `ask` なら **ask**、そうでなければ（`allowlist`）**deny**

なので「このセッション中は拒否」は `allow-all` にも勝ちます。一方、セッション中の許可が `deny` のパターンに勝つことは
ありません。

## セッション中の判断

カーネルは、セッション中の許可と拒否の 2 つの集まりを持ちます。キーは**ホスト名だけ**で、小文字、ポートなし、IPv6 は
角かっこなしです。`localhost` をセッション中は許可すると、そのすべてのポートを許します。

| 答え | 待っている要求 | そのホストへのあとの要求 |
|---|---|---|
| `once` | 許す | また尋ねる |
| `session` | 許す | 許す（セッション中の許可に入る） |
| `deny` | 断る | また尋ねる |
| `deny-session` | 断る | 断る（セッション中の拒否に入る） |

2 つの集まりはカーネルが動いている間ずっと残ります。`setPolicy()` では変わらず、`vessel.network.clearSession()` で
両方とも空になります。

## 許可の問い合わせ

`decide()` が `ask` を返すと、カーネルの `checkNetwork()` は次のようにします。

1. ホストのページがつながっていなければ、すぐに断ります。
2. ホスト名ごとにまとめます。同じホストの問い合わせがもう待っていれば、新しい要求はその答えを待ち、何も送りません。
   ポートやパスだけが違う要求は、1 つの問い合わせを分け合います。
3. そうでなければ、新しい `id`・完全な `url`・`host`・`initiator`・`source` を付けた `permission-request` をホストの
   ページに送り、5 分のタイマーを始めます。
4. ホストのページが答えたとき（`permission.respond`）か、タイマーが切れたとき（拒否）に決まります。待っている要求は
   すべて同じ結果を受け取り、カーネルは `permission-settled` `{ id, host, allowed }` を送ります。もう決まった
   問い合わせへの答えは無視します。

ホストのページでは、問い合わせは `onPermissionRequest` か組み込みのダイアログへ行きます。その前に
`permission-request` のイベントのリスナーが見ます。処理が例外を投げたら `deny` です。処理・ダイアログ・2 つの
イベントの仕様は [ホスト API](host-api.ja.md#許可の問い合わせ) にあります。

`initiator` は求めた側が書くもの（`/__ov/net` の `x-ov-by` ヘッダー）なので、利用者への手がかりであって、身元の証明では
ありません。カーネル自身のクライアントは `npm` と名乗ります。`curl` と `wget` も同じです。

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

方針はいつでも変えられ、変えたあとに判定する要求から効きます。答えを待っている要求は判定し直しません。方針を
変えられるのはホストのページだけです。ランタイムの Service Worker はカーネルへの通り道をランタイムのウィンドウから
しか受け取らず、プレビューからカーネルへの通り道で運べるのは HTTP・WebSocket・通信の判定だけです。

## 効かせる場所

### ランタイム: `/__ov/net`

ランタイムの Service Worker（`src/runtime/sw.ts`）が `<ランタイムの基準>/__ov/net?url=<相手>` に答えます。ランタイムの
中で別のオリジンを fetch するのは、ここだけです。要求ごとに次のようにします。

1. カーネルに `{ k: 'net', url, initiator }` を尋ねます。カーネルへの接続が無く、15 秒たってもつながらなければ、
   `x-ov-error: network` 付きの `502` を返します（`OpenVessel kernel is not connected`）。
2. 拒否なら、`x-ov-error: denied` 付きの `403` と、メッセージ
   `OpenVessel: network access to <host[:port]> was denied by the network policy` を返します。
3. そうでなければ、`x-ov-h` から要求のヘッダーを写します。ただし `host`・`connection`・`content-length`・
   `keep-alive`・`transfer-encoding`・`upgrade`・`te`・`trailer`・`expect`・`cookie`・`cookie2`・`origin`・`referer`・
   `accept-encoding`・`access-control-request-headers`・`access-control-request-method`・`date`・`dnt`・`via`・
   `proxy-connection` と、`sec-*`・`proxy-*` のすべては捨てます。
4. 相手を fetch します。メソッドは `x-ov-method`、本体は送られたもの（`GET`・`HEAD` は無し）、`mode: 'cors'`・
   `credentials: 'omit'`・`cache: 'no-store'`、`x-ov-redirect` が `error` なら `redirect: 'error'`、ほかは `'follow'` です。
5. fetch が例外を投げたら、`x-ov-error: network` 付きの `502` と
   `request to <host> failed: <理由>. The server may not allow cross-origin requests (CORS) from the browser.` を返します。
6. うまくいけば `200` を返し、本当の状態コード・状態の文・最後の URL・リダイレクトしたかどうか・応答のヘッダーを
   `x-ov-status`・`x-ov-status-text`・`x-ov-url`・`x-ov-redirected`・`x-ov-rh` に入れ、本体を付けます（204・205・304・
   `HEAD` は本体なし）。

メッセージの形は [通信の形式](protocol.ja.md) にあります。

### 断られたとき・失敗したときの見え方

| クライアント | 方針が断った | 許されたが fetch が失敗した |
|---|---|---|
| プロセスの `fetch()`（両方の層） | `TypeError: fetch failed`。`cause.code === 'EACCES'`、`cause.message` は拒否のメッセージ | `TypeError: fetch failed`。`cause.code === 'ECONNREFUSED'` と CORS の説明 |
| `http`・`https`・`net`・`tls` のクライアント（移植した層） | `X-OpenVessel-Error: 1`・`Connection: close` 付きの HTTP の応答 `403 Forbidden`。本体はメッセージ。そのあと接続は閉じる | `502 Bad Gateway`。形は同じ |
| `http`・`https` のクライアント（旧来の層） | `'error'` イベント。メッセージと `code: 'EACCES'` の `Error` | `'error'` イベント。`code: 'ECONNREFUSED'` |
| 外のホストへの `net.connect`（旧来の層） | 関所へ行かず、いつも `ECONNREFUSED` | — |
| `npm` とほかのパッケージマネージャ | `code: 'EACCES'` のエラー。tarball の取得はやり直さない | `code: 'ECONNREFUSED'` のエラー。tarball の取得は 3 回まで試す |
| `curl`・`wget` | `curl: (7) <メッセージ>`、終了ステータス 7 | `curl: (7) <メッセージ>`、終了ステータス 7 |
| プレビューのページ | 本体が空で、状態の文が `Blocked by OpenVessel network policy` の `403` | ブラウザ自身の通信のエラー |

移植した層のソケットのクライアントで外へ出せるのは HTTP/1.1 だけです。最初のバイト列が要求の行でない接続は閉じ、
WebSocket への upgrade には `501 Not Implemented` を返します（[カーネル](kernel.ja.md)）。

### プレビュー

プレビューの Service Worker（`src/preview/sw.ts`）は、自分のスコープのページ（プレビューの iframe と中継）が出す
すべての要求を見ます。

- プレビューと同じオリジン: 仮想ポートへ送ります。判定はしません。
- 別のオリジンで `http:` か `https:`: カーネルで判定します（`source: 'preview'`）。許されれば、元の要求をそのまま
  fetch します（モードも資格情報もページが頼んだとおり）。なので、ページ自身の CORS の決まりはふだんどおりに
  効きます。
- ほかのスキーム（`data:`・`blob:` など）: 横取りしません。

ランタイムの側との違い:

- **許可**は、Service Worker が動いている間、URL のホスト（ポート**込み**）ごとに覚えます。なのでプレビューへの `once`
  の答えは、プレビューの Service Worker が起動し直すまで続きます。`setPolicy()` も `clearSession()` も、覚えた許可を
  取り消しません。拒否は覚えません。
- Service Worker が 15 秒以内にカーネルへつながらないと、要求は判定せずに通します。

### WebSocket

Service Worker からは WebSocket の接続が見えないので、方針がそれを判定することはありません。

- プレビューでは、`__ov/inject.js` が `WebSocket` を差し替えます。ページ自身のホスト・`localhost`・`127.0.0.1`・
  `[::1]` への接続は仮想サーバーへ通します（HMR はこれで動きます）。ほかの URL は、ブラウザの WebSocket をそのまま
  使います。
- プロセスでは、移植した層の `WebSocket` のグローバルはブラウザのものです。ランタイムのオリジンでは、下の
  Content-Security-Policy の `connect-src` に縛られます。`net`・`tls` のソケットでは、外のホストへの upgrade に
  `501` を返します。

### Content Security Policy

関所が効くのは、ほかに出口が無いときだけです。`scripts/serve.mjs` は、`sw.js` 以外のランタイムのすべてのファイルを、
`connect-src` が `'self' data: blob:` の CSP 付きで配ります。そのため、プロセスが直接別のオリジンへ出す `fetch`・
`XMLHttpRequest`・`WebSocket`・`EventSource` はブラウザが止め、届くのは `/__ov/net`（同じオリジン）だけです。`sw.js`
にはこの CSP を付けずに配ります。本番の配信にも同じヘッダーが要ります（[配信](deployment.ja.md)）。プレビューの
オリジンにはこの CSP がありません。プレビューのサイトは、上で説明したプレビューの Service Worker が絞ります。

## localhost と仮想ポート

OpenVessel の中のサーバーは仮想ポートで待ち受けます。手元のマシンでは何も待ち受けていません。

| クライアント | `localhost`・`127.0.0.1`・`::1`/`[::1]`・`0.0.0.0`・`*.localhost` |
|---|---|
| プロセスの `fetch()` | 仮想ポートへ送ります（移植した層は Node の `http` モジュールで、旧来の層は直接）。方針では判定しません。待ち受けが無ければ `ECONNREFUSED`。旧来の層は、空のホスト名もループバックとして扱います。 |
| プロセスの `http`・`net` のクライアント | 仮想ポートにつなぎます。判定はしません。待ち受けが無ければ `ECONNREFUSED`。 |
| `curl`・`wget`・パッケージマネージャ（カーネル） | 仮想ポートへは**行きません**。URL はほかと同じく関所へ行きます。`localhost` はどのセットにも無いので、尋ねるか断ります。許すと、ランタイムの Service Worker が利用者の本当の `localhost` を fetch します。 |
| プレビューのページ | 仮想サーバーに届くのは自分のオリジンだけです。絶対 URL の `http://localhost:<port>/` は別のオリジンなので、方針で判定し、許せば手元のマシンから取ります。`localhost` への WebSocket は仮想サーバーへ通します（上を参照）。 |

## ほかのスキーム

- 方針は、スキームが `http:` でも `https:` でもない URL（`ws:`・`wss:`・`ftp:`・`file:` など）をすべて断ります。
- 移植した層の `fetch()` は、`data:` と `blob:` の URL をブラウザの `fetch` で関所を通さずに読み、ほかの HTTP でない
  スキームは `TypeError: fetch failed`（`cause.code === 'ERR_INVALID_URL'`、`unsupported URL scheme <scheme>`）で
  失敗させます。
- プレビューの Service Worker が判定するのは、別のオリジンへの `http:` と `https:` の要求だけです。

## CORS

外への要求は、ランタイムの Service Worker の中で、ブラウザの `fetch` が `mode: 'cors'`・`credentials: 'omit'` で
出します。方針が許した要求でも、ブラウザの決まりのために失敗したり、減って戻ったりします。

- 相手のサーバーがランタイムのオリジンを許す必要があります。`Access-Control-Allow-Origin: *` か、ランタイムの
  オリジンです。プリフライトが要る要求（`GET`・`HEAD`・`POST` 以外のメソッドや、`Authorization` や独自のヘッダーの
  ような CORS で安全とされていないヘッダー）は、`OPTIONS` のプリフライトにも答えてもらう必要があります。そうで
  なければ CORS の説明付きで失敗します（`ECONNREFUSED`）。Google Fonts の情報や多くの RSS がこれに当たります
  （[互換性](../compatibility.ja.md#通信)）。
- クッキーは送らず、受け取っても残しません。上に挙げたヘッダーは捨てます。
- プロセスに見える応答のヘッダーは、ブラウザが見せるものだけです。CORS で安全とされたものと、
  `Access-Control-Expose-Headers` にあるものです。`Set-Cookie` は届きません。
- 本体はブラウザが伸長したあとで届くので、`Content-Length` のヘッダーが見えていても、本体と合わないことがあります。
- TLS はブラウザが行い、確かめます。

## 例

npm だけ。ほかは出さず、尋ねもしない:

```ts
network: { mode: 'allowlist', presets: ['npm'] }
```

既定のセットに API を 1 つ足し、ほかは利用者に尋ねる:

```ts
network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'], allow: ['api.example.com', '*.example.org'] }
```

いくつかのホスト以外は全部許す:

```ts
network: { mode: 'allow-all', deny: ['*.doubleclick.net', 'analytics.example.com'] }
```

標準でないポートの社内のレジストリと、git の依存のための GitHub:

```ts
network: { mode: 'allowlist', presets: ['npm', 'github'], allow: ['npm.internal.example.com:8443'] }
```

一覧の外はダイアログを出さずに断り、断ったものを記録する:

```ts
const vessel = await OpenVessel.boot({
  runtimeUrl, previewUrl,
  network: { mode: 'ask', presets: ['npm', 'fonts', 'cdn'] },
  onPermissionRequest: (req) => { console.log('blocked', req.host, req.initiator); return 'deny-session'; },
});
```

`mode: 'allowlist'` だと、何も尋ねないので処理は呼ばれません。`'deny-session'` ならホストごとに 1 回、`'deny'` なら
断った要求ごとに記録します（1 つが待っている間は、ホストごとにまとまります）。

アプリ独自の確認:

```ts
onPermissionRequest: async (req) => {
  const ok = await myConfirm(`${req.source === 'preview' ? 'The preview' : req.initiator} wants ${req.host}`);
  return ok ? 'session' : 'deny-session';
},
```
