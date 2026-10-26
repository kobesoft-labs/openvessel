# Preview

[日本語](preview.ja.md)

How a server running inside OpenVessel is shown in an iframe: the relay frame and the preview service
worker, the `__ov/open` URL, how HTTP requests, responses and WebSockets are carried to a virtual port and
back, what the injected script does, and what the preview can and cannot do. The message formats are in
[Protocol](protocol.md); headers and hosting are in [Deployment](deployment.md).

## Overview

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

| Piece | Source | Role |
|---|---|---|
| Relay iframe | `src/preview/relay.html`, `src/preview/relay.ts` | Hidden, on the preview origin. Registers the preview service worker and hands it the kernel channel the host created |
| Preview service worker | `src/preview/sw.ts` (`dist/preview/__ov-sw.js`) | Answers every request of the preview pages from a virtual port, tunnels WebSockets, injects `inject.js` into HTML, applies the network policy to other origins |
| Injected script | `src/preview/inject.ts` (`dist/preview/__ov/inject.js`) | Replaces `window.WebSocket` for local URLs; fixes root-relative `fetch`/XHR URLs when served under a path |
| Kernel side | `src/kernel/index.ts` (`attachPreview`), `src/kernel/net.ts`, `src/kernel/tcp.ts` | Routes requests to the process listening on the port |
| Host side | `src/host/index.ts` (`previewUrl`, `createPreview`) | Creates the relay and the preview iframes, connects the relay to the kernel |

Nothing is opened on the machine: ports are entries in the kernel's table, and the only way to reach them
from a browser page is through this service worker.

## Starting the preview

`vessel.previewUrl(port, path?)` and `vessel.createPreview(port, opts?)` need `previewUrl` in
`OpenVessel.boot()`; without it they reject with `OpenVessel: previewUrl was not configured`.

The first call creates the relay (later calls reuse it):

1. The host appends a hidden iframe `<previewUrl>__ov/relay.html` (`aria-hidden`, `tabIndex = -1`, zero size,
   `visibility:hidden`).
2. `relay.js` registers `../__ov-sw.js` with scope `../`, waits for `navigator.serviceWorker.ready` and
   posts `openvessel-preview-loaded` to its parent.
3. The host creates a `MessageChannel`, sends one end to the kernel (`{ t: 'preview-port', port }` on its
   kernel channel) and the other to the relay (`openvessel-preview-connect` with `defaultPort`).
4. The relay passes the port to the active service worker (`kernel-port`) and posts
   `openvessel-preview-ready`. The host's promise resolves. The relay only takes these messages from its
   parent, and only when the parent is of another origin (the host), not a preview page that framed it.
   A new channel replaces the old one, which the service worker closes; the kernel then aborts the
   requests and sockets that were still open on it.

If the relay isn't ready within 20000 ms the call rejects with `OpenVessel: preview relay did not start`.
Each later `previewUrl()` / `createPreview()` sends `openvessel-preview-default-port` with its port, which
makes that port the default.

## The `__ov/open` URL

```text
<previewUrl>__ov/open?port=<port>&path=<url-encoded path>
```

| Parameter | Meaning | Default |
|---|---|---|
| `port` | The virtual port this page belongs to | the default port (when missing, `0` or not a number) |
| `path` | Path and query to open on the server | `/` |

The service worker answers it with a `302` to `path` on the preview origin (with the scope prepended when
the preview is served under a path, see [Deployment](deployment.md#serving-under-a-path)). The redirect
carries the isolation headers; a plain `Response.redirect()` would be refused inside a COEP host page. The
service worker also records `port` for the page the navigation creates (its `resultingClientId`), so every
request that page makes goes to that port.

```ts
const url = await vessel.previewUrl(4321, '/blog/?draft=1');
// https://preview.example.com/__ov/open?port=4321&path=%2Fblog%2F%3Fdraft%3D1
```

The `server-ready` event carries the same URL for `/` as `url` (or `null` without `previewUrl`); that
URL is built without waiting for the relay, so use `previewUrl()` or `createPreview()` to be sure the relay
is connected.

### `createPreview()`

`createPreview(port, { path, container })` awaits `previewUrl(port, path)` and returns a new iframe:

| Attribute | Value |
|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock` (no `allow-top-navigation`: the preview can't navigate the host page) |
| `allow` | `clipboard-write; fullscreen` |
| `referrerPolicy` | `no-referrer` |
| `style` | `width:100%;height:100%;border:0;background:#fff` |

It is appended to `container` when one is given. `allow-same-origin` keeps the iframe on the real preview
origin, which the service worker needs in order to control it.

### Which port a request goes to

| Request | Port |
|---|---|
| Navigation to `__ov/open` | `port` from the URL (recorded for the resulting page) |
| Other navigation in a preview iframe (link, form, `location` change, reload) | the port of the page that started the navigation, else the default port |
| Subresource (`fetch`, XHR, script, image…) | the port recorded for the requesting page, else the default port |
| Request to `http://localhost:<port>/…` (or another loopback name) | `port` from the URL; without one, the requesting page's port, else the default port |
| WebSocket to a local URL | the port in the URL when its host is a loopback name with an explicit port, else the requesting page's port, else the default port |

Navigating inside an iframe opened at port 4000 stays on port 4000, and two previews of different ports
can be open at the same time. The default port is the `port` of the most recent `previewUrl()` /
`createPreview()` call.

The port records and the default port are kept in memory and also in the preview origin's Cache Storage
(cache `openvessel-preview-ports`), so when the browser restarts an idle service worker, open pages keep
their port. Records of pages that are gone are dropped when the service worker starts. The cache of
allowed hosts is only in memory.

## HTTP requests

Every same-origin request of a controlled page is handled by the service worker except its own files
(`__ov/relay.html`, `__ov/relay.js`, `__ov/inject.js`, `__ov-sw.js`, fetched from the server with the
isolation headers added) and `__ov/open`.

### Request

| Part | What is sent to the virtual port |
|---|---|
| Method | as is |
| URL | path and query (the fragment is not sent); the scope is removed when served under a path |
| Headers | the request's headers without `sec-*`, `cookie` and `accept-encoding`, plus `host: localhost:<port>`. `Referer` is not forwarded |
| Body | for every method except `GET` and `HEAD`: read completely (`req.arrayBuffer()`) and sent as one message, then an end marker. Request bodies are not streamed |

Because `accept-encoding` is removed, servers answer uncompressed.

### Kernel side

The kernel looks the port up in its table of listeners (`NetRouter.request` in `src/kernel/net.ts`):

| Listener | Created by | Reached how | `server-ready` / in `ports()` |
|---|---|---|---|
| `raw` | the ported runtime: any TCP server (`net.Server`, `http.Server`, …) | `TcpBridge`: a new socketpair connection per request, HTTP/1.1 bytes | yes |
| `http` (record host = the listen address or empty) | the legacy runtime's `http.Server` | `http-req` / `http-res` messages to the process ([Protocol](protocol.md#kernel--process-messages)) | yes |
| `tcp-only` | the legacy runtime's `net.Server` | not reachable: `connect ECONNREFUSED 127.0.0.1:<port>` | no |
| none, or the process isn't running | — | `connect ECONNREFUSED 127.0.0.1:<port>` | — |

`listen(0)` picks a free port in 49152–65151. A port already in the table gives `EADDRINUSE`. A listener
goes away when its process exits, `exec`s another program or closes the server; the host then gets
`port-closed`. A listening socket shared between processes (handed over IPC, as in `cluster`) gets
connections in turn (round-robin).

#### Ported runtime: HTTP/1.1 over a socket (`src/kernel/tcp.ts`)

The listening process receives a new connection (`tcp-accept`) with remote address `127.0.0.1` and a remote
port that counts up from 40000 to 60000 and wraps around. The kernel writes the request head:

- request line `<METHOD> <url> HTTP/1.1`;
- the headers above, without `connection`, `keep-alive`, `transfer-encoding`, `upgrade`,
  `sec-websocket-key`, `sec-websocket-version`; `Host: localhost:<port>` first if there is none;
- `Connection: close` (one connection per request), and `Transfer-Encoding: chunked` when there is a body
  but no `content-length` (the body is then sent in chunks and ended with `0\r\n\r\n`).

The response is parsed as HTTP/1.1: `1xx` responses other than `101` are skipped; the body is read by
`content-length`, by `chunked` encoding (trailers are discarded), or until the connection closes; `204`
and `304` without a length have no body. `transfer-encoding`, `connection` and `keep-alive` are removed from
the headers passed on. Errors: `socket hang up` if the connection closes before a complete head,
`incomplete response` if it closes inside a length-delimited or chunked body.

#### Legacy runtime

The kernel posts `http-req` to the thread that listens, then `http-body` / `http-body-end`, and relays
`http-res`, `http-res-data`, `http-res-end` and `http-res-error` back. If the process gets a request for a
port it no longer serves, it answers `503 Service Unavailable` with the body `no server`. If the process
exits while a request is open, the request fails with `server process exited`.

### Response

| Part | What the page gets |
|---|---|
| Status | as sent, except `101`, which becomes `200`; the status text as sent |
| Headers | as sent, without `content-length`, `transfer-encoding`, `connection`, `keep-alive` and `content-encoding`; `location` rewritten under the scope when served under a path; `cross-origin-embedder-policy: credentialless`, `cross-origin-resource-policy: cross-origin` and `cross-origin-opener-policy: same-origin` added unless present. Header values the browser rejects are dropped silently, and `Set-Cookie` never reaches the page (a service worker can't create a response with it) |
| Body | streamed: each chunk from the server is passed on as it arrives. No body for `204`, `205`, `304` and `HEAD` |
| HTML navigations | when the request is a navigation, the `content-type` contains `text/html` and there is a body, the whole body is read as text (decoded as UTF-8), the script is injected, and the page is returned in one piece |

If the page cancels the body (for example the iframe navigates away), the service worker sends `abort`: the
kernel closes the connection (ported runtime) or posts `http-abort` (legacy runtime).

No size limits are applied to requests or responses beyond the browser's memory; responses are not
buffered except for HTML navigations and request bodies.

### Redirects

A `3xx` from the server is returned to the page as it is; the service worker never follows redirects. The
browser follows them as usual (a `fetch()` with `redirect: 'manual'` sees an `opaqueredirect`). A
root-relative `Location` stays on the preview origin. An absolute `Location` such as
`http://localhost:4321/x` is a loopback URL and goes to that virtual port; a `Location` in a response to
a request for such a URL is passed on unchanged.

### Errors

| Situation | Result |
|---|---|
| Nothing listens on the port, request without a body | retried every 200 ms, up to 15 times (about 3 s; dev servers such as Vite listen briefly to probe a port and again a moment later), then the error page |
| Nothing listens, request with a body | the error page at once |
| Error before the response head (`socket hang up` in the ported runtime, `server process exited` in the legacy runtime) | the error page at once |
| Error after the head | the response body stream fails |
| The service worker has no kernel channel and gets none within 15 s | the request fails as a network error (`preview is not connected to OpenVessel`) |

The error page is a `502` with `content-type: text/html; charset=utf-8` and the isolation headers, for any
kind of request:

```text
Nothing is listening on port 4999
connect ECONNREFUSED 127.0.0.1:4999
Start a dev server (for example npm run dev) and reload.
```

## WebSockets

Service workers can't intercept WebSockets, so `inject.js` replaces `window.WebSocket` in every HTML page
the preview serves. A URL (`ws:`, `wss:`, or `http:`/`https:` turned into `ws:`/`wss:` as the browser
does) is tunnelled when its host is the page's own host or a loopback name (`localhost`, `*.localhost`,
`127.0.0.0/8`, `[::1]`…, any port). For other URLs the socket first asks the service worker whether the
network policy allows the host (`ws-check`, see
[below](#outbound-requests-and-the-network-policy)) and then opens the browser's own `WebSocket`, whose
events and members it passes through. URLs the browser's `WebSocket` would reject (other schemes, a
fragment) are handed to it as they are, so they throw its usual `SyntaxError`.

1. The page posts `{ t: 'ws-connect', port, path, protocols, vport, origin }` to its controlling service
   worker with a new `MessagePort` (`vport` is the URL's port when its host differs from the page's,
   else 0).
2. The service worker picks the port (`vport`, else the page's port, else the default port) and asks the
   kernel to open it (`ws-open`) with the headers `sec-websocket-protocol` (the requested protocols joined
   with `, `), `host: localhost:<port>` and `origin` (the preview origin); empty ones are left out.
3. Ported runtime: the kernel sends an HTTP/1.1 upgrade request with `Connection: Upgrade`,
   `Upgrade: websocket`, `Sec-WebSocket-Version: 13` and a random `Sec-WebSocket-Key`; a `101` response
   opens the socket with the `Sec-WebSocket-Protocol` the server chose. Legacy runtime: `http-req` with
   `upgrade: true`, answered by `ws-open`.
4. Frames are carried as messages: text as strings, binary as `Uint8Array`. In the ported runtime the
   kernel masks frames it sends, answers pings with pongs, and reads the close code from a close frame
   (`1005` if it has none).

So a dev server whose HMR socket listens on its own port (`ws://localhost:24678/`) is reached on that
port, while `new WebSocket('/socket')` or a URL on the page's own host goes to the page's port. With a
`vport`, the path is sent as it is; otherwise the scope is removed as for HTTP requests.

### The tunnelled `WebSocket` object

| Member | Behaviour |
|---|---|
| `url` | the absolute URL |
| `readyState` | `0` until open, `1` open, `2` after `close()`, `3` closed |
| `protocol` | the protocol the server chose, `''` before open |
| `extensions` | always `''` (for an outside socket, the browser socket's) |
| `bufferedAmount` | always `0` (for a policy-checked outside socket, the browser socket's) |
| `binaryType` | `'blob'` (default) or `'arraybuffer'`; binary messages arrive as `Blob` or `ArrayBuffer` |
| `send(data)` | strings as text frames; `ArrayBuffer`, views and `Blob` as binary (a `Blob` is sent after it has been read). Throws `InvalidStateError` (`WebSocket is not open`) unless open |
| `close(code = 1000, reason = '')` | sends the close and reports `close` right away, without waiting for the server |
| events | `open`, `message` (`origin` is the URL's origin), `error`, `close`; both `on…` properties and `addEventListener` |
| `error` | fired before `close` when the socket closes without having opened, or with code `1006` |
| `close` event | `code`, `reason`, `wasClean` (`true` only for `1000`) |
| static constants | `CONNECTING`, `OPEN`, `CLOSING`, `CLOSED` |

Without a controlling service worker the socket closes with `1006` and reason `no service worker`. If the
kernel can't connect (no listener), it closes with `1006` and the error message as reason; when the
connection to the server ends without a close frame, the code is `1006`. If the server answers the upgrade
with an ordinary HTTP response instead of `101`, the socket fails: `error`, then `close` with `1006` and
the reason `Unexpected server response: <status>`.

`window.WebSocket.prototype` stays the browser's, and `instanceof WebSocket` is true for tunnelled
sockets as well as for the browser's own.

## The injected script

The service worker inserts, into every HTML navigation response:

- `<script src="<scope>__ov/inject.js"></script>`, preceded by an import map when the preview is served
  under a path;
- right after the first `<head …>` tag, or else right after `<!doctype …>`, or else at the very start.

`inject.js` (guarded so that it runs once per page):

| Does | When |
|---|---|
| Replaces `window.WebSocket` with a constructor that tunnels local URLs and checks other URLs with the network policy (above) | always |
| Wraps `window.fetch` and `XMLHttpRequest.prototype.open` so that string URLs starting with a single `/` and not already under the scope get the scope prepended | only when the preview is served under a path |

It does nothing else: no error overlay, no messages to the host, no access to the runtime.

## Outbound requests and the network policy

Requests from preview pages to other origins (`http:` and `https:` only; other schemes are left to the
browser) are checked against the host's network policy ([Network policy](network-policy.md)) before the
service worker makes them. Loopback URLs are not outside requests: they go to virtual ports (see
[Which port a request goes to](#which-port-a-request-goes-to)).

1. If the origin was allowed before with a lasting answer (by the policy, or "for this session"), the
   request goes out at once. That cache is emptied when the host calls `network.setPolicy()` or
   `network.clearSession()` (the kernel sends `net-flush`) and when the service worker gets a new kernel
   channel. Denials and "allow once" answers are not cached: "once" allows that one request.
2. Otherwise the service worker asks the kernel (`net`). The kernel decides from the policy and, in `ask`
   mode, emits `permission-request` with `initiator: 'preview'` and `source: 'preview'` (the built-in
   dialog says "The preview page wants to connect to:"). Questions about the same host name are merged;
   unanswered questions are denied after 5 minutes.
3. Allowed: the service worker `fetch`es the original request; a `no-cors` request (`<img>`, a classic
   `<script>`, CSS `url()`…) is made as a `cors` request without credentials instead, so that the final URL
   after redirects is visible. A server that doesn't allow CORS fails such a load (`403`, status text
   `Blocked by OpenVessel: the server does not allow CORS, so its redirects cannot be checked`).
4. If the response was redirected, the final URL is checked the same way; if it is refused, the response
   is dropped.
5. Denied: `403` with status text `Blocked by OpenVessel network policy` (with ` (not answered in time)`
   after a timeout) and an empty body.

If the service worker can't get a kernel channel (none within 15 s), the request is refused; the next
request asks the relay for a channel again.

A WebSocket to an outside host is checked the same way before it connects: the page's `WebSocket` posts
`{ t: 'ws-check', url, port }` to the service worker, which answers `{ allow }` on the port. A refused
socket fails with `error` and `close` (`1006`, `blocked by OpenVessel network policy`).

Points to be aware of:

- The redirect hops before the final URL are contacted by the browser; only what the final host sends
  is withheld when it is refused.
- The checks are made by the service worker and by the replaced `WebSocket`. Code that gets the browser's
  own `WebSocket` some other way (a worker the page starts, for instance) is not checked.

## Cookies and storage

- All previews of a deployment share the preview origin, whatever the port: cookies, `localStorage`,
  IndexedDB and caches set by one previewed site are visible to the others, and they persist in the browser
  like any site's storage. Use per-session preview origins to separate users
  ([Deployment](deployment.md#per-session-preview-origins)).
- The `Cookie` request header is not forwarded to the server, and `Set-Cookie` from the server doesn't
  reach the browser. `document.cookie` works on the preview origin, but the server doesn't see those
  cookies.

## What the preview can and cannot ask of the runtime

The kernel's preview channel accepts only these message kinds: `req`, `body`, `body-end`, `abort`,
`ws-open`, `ws-msg`, `ws-close` and `net` ([Protocol](protocol.md#preview-channel)). Through it a preview
can make HTTP requests and WebSocket connections to virtual ports, and ask whether an outside URL is
allowed (which may show a permission prompt in the host). It cannot read or write files, start or signal
processes, change the network policy or answer permission requests; those methods exist only on the
host's channel. The relay iframe runs on the preview origin too, so taking it over gives no more than
the same channel.

The preview service worker only accepts `kernel-port` and `default-port` from the relay: a window in a
frame whose URL path is exactly `<scope>__ov/relay.html`. `ws-connect` and `ws-check` are accepted from
any page it controls.

## Related source files

| File | Contents |
|---|---|
| `src/preview/relay.ts`, `src/preview/relay.html` | relay frame |
| `src/preview/sw.ts` | preview service worker |
| `src/preview/inject.ts` | injected script |
| `src/kernel/index.ts` | `attachPreview`, `checkNetwork` |
| `src/kernel/net.ts` | `NetRouter`: ports → processes, legacy message bridge |
| `src/kernel/tcp.ts` | `TcpBridge`: HTTP messages ⇄ HTTP/1.1 bytes, WebSocket frames |
| `src/host/index.ts` | `previewUrl`, `createPreview`, relay set-up |
| `test/e2e/preview-port.mjs` | end-to-end test: a ported-runtime server reached from the preview |
