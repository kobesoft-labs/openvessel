# Network policy

[日本語](network-policy.ja.md)

Every request from inside OpenVessel to a host outside the tab is checked against a single network
policy, and the embedding page decides what that policy allows. This page describes the policy model
(`src/shared/policy.ts`), the order in which a request is decided, how the user is asked
(`src/kernel/index.ts`), where the policy is enforced (`src/runtime/sw.ts`, `src/preview/sw.ts`), and
what each kind of client sees when a request is refused.

## What the policy covers

| Traffic | Path to the policy check | `source` / `initiator` |
|---|---|---|
| `fetch()` in a `node` process (both runtimes) | The process calls the runtime service worker's `/__ov/net` | `runtime` / pid and command line, e.g. `7 node server.js` |
| `http`/`https` clients, `net.connect`/`tls.connect` to a non-local address (ported runtime) | The kernel reads HTTP/1.1 from the socket (`src/kernel/outbound.ts`) and calls `/__ov/net` per request | `runtime` / pid and command line |
| `http`/`https` clients (legacy runtime) | The process calls `/__ov/net` | `runtime` / pid and command line |
| `npm`, `pnpm`, `yarn`, `bun`: registry metadata and tarballs | The kernel calls `/__ov/net` | `runtime` / `npm` |
| `curl`, `wget` | The kernel calls `/__ov/net` | `runtime` / pid and command line, e.g. `12 curl -s https://example.com/` |
| Requests of a previewed page to other origins (scripts, styles, images, fonts, `fetch`, XHR, `EventSource`) | The preview service worker asks the kernel | `preview` / `preview` |
| WebSockets of a previewed page to outside hosts | `__ov/inject.js` asks the preview service worker before connecting | `preview` / `preview` |
| Where a redirect ends (runtime and preview) | The service worker checks the final URL again after the browser followed the redirects | as for the first URL |

The decision is always made in the kernel. The runtime and the preview share one policy and one set of
session decisions.

The policy does not check the following:

- Requests to virtual ports: loopback names (from processes, `curl`/`wget`/package managers and the
  preview) and same-origin requests of the preview
  ([Localhost and virtual ports](#localhost-and-virtual-ports)). Loopback never reaches the user's machine.
- OpenVessel's own compat package tarballs, downloaded from `<runtime base>/compat/` on the runtime
  origin.
- npm tarballs already in the runtime origin's Cache Storage (`openvessel-npm-v1`); they are verified
  against their `integrity` before use.
- The hosts between the first URL and the final one of a redirect chain. The browser follows
  redirects inside the service worker without showing the hops, so those hosts are contacted. Only the
  final URL is checked, and nothing from a refused final host is handed back ([Redirects](#redirects)).
- WebSockets that processes open with the browser's `WebSocket` global ([WebSockets](#websockets)).

## The policy object

```ts
interface NetworkPolicy {
  mode: 'ask' | 'allowlist' | 'allow-all';
  presets: ('npm' | 'fonts' | 'icons' | 'cdn' | 'github')[];
  allow: string[];   // patterns
  deny: string[];    // patterns
}
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `'ask'` | What happens to a host that nothing else decides. |
| `presets` | `['npm', 'fonts', 'icons', 'cdn']` | Built-in host lists to allow. `github` is not on by default. |
| `allow` | `[]` | Extra hosts to allow ([Patterns](#patterns)). |
| `deny` | `[]` | Hosts to refuse; wins over everything, including `allow-all`. |

The policy passed to `boot({ network })` or `vessel.network.setPolicy()` is a `Partial<NetworkPolicy>`
and is normalised by `normalizePolicy()`. Each missing field takes the default above (the default, not
the current value). Preset names that don't exist are dropped; only `PRESETS`' own keys count, so
`toString` and other inherited names are dropped too. `allow`/`deny` entries that aren't strings are
also dropped. `vessel.network.getPolicy()` returns the normalised policy. Without a `network` option the
kernel starts with the defaults.

## Modes

| Mode | Host matched by a preset or `allow` | Any other host |
|---|---|---|
| `ask` | allowed | the host page is asked ([Permission requests](#permission-requests)) |
| `allowlist` | allowed | denied |
| `allow-all` | allowed | allowed |

In every mode, `deny` patterns, "deny for this session" decisions and non-HTTP URLs are refused.

## Presets

`PRESETS` is exported from `openvessel`. Each entry is an exact host name (no wildcards, any port).

| Preset | Hosts |
|---|---|
| `npm` | `registry.npmjs.org`, `registry.npmjs.com`, `registry.yarnpkg.com`, `registry.npmmirror.com` |
| `fonts` | `fonts.googleapis.com`, `fonts.gstatic.com`, `fonts.bunny.net`, `api.fontshare.com`, `cdn.fontshare.com`, `api.fontsource.org`, `use.typekit.net`, `p.typekit.net`, `rsms.me` |
| `icons` | `api.iconify.design`, `api.simplesvg.com`, `api.unisvg.com`, `code.iconify.design`, `kit.fontawesome.com`, `ka-f.fontawesome.com` |
| `cdn` | `cdn.jsdelivr.net`, `fastly.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `esm.sh`, `cdn.skypack.dev`, `ga.jspm.io` |
| `github` | `github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `api.github.com`, `gist.githubusercontent.com` |

A registry set in `.npmrc` (`registry=` or `@scope:registry=`) that isn't in the `npm` preset has to be
added to `allow`. Git dependencies downloaded from GitHub need the `github` preset (or `allow`).

## Patterns

`allow` and `deny` entries are patterns matched against the request URL's host name and port. The
scheme and path are not part of a pattern.

| Pattern | Matches |
|---|---|
| `example.com` | exactly `example.com`, any port |
| `*.example.com` | `example.com` and every subdomain at any depth (`a.example.com`, `a.b.example.com`) |
| `example.com:8080` | `example.com` on port 8080 only |
| `*.example.com:8443` | `example.com` and its subdomains on port 8443 only |
| `*` | every host |
| `[::1]:8080`, `[2001:db8::1]` | an IPv6 address, with or without a port |
| `::1`, `2001:db8::1` | an IPv6 address without brackets (it can't carry a port) |

Rules (`matches()` in `src/shared/policy.ts`):

- Patterns are trimmed and compared in lower case. Host names are lower-cased by the URL parser. An
  empty pattern matches nothing.
- `*` is a wildcard only as the whole pattern or as a leading `*.`. Anywhere else it is a literal
  character.
- A port in a pattern is compared with the URL's port, where a URL without a port has `443` for
  `https:` and `80` for `http:` (`example.com:443` matches `https://example.com/`).
- IP addresses are compared as the URL parser writes them: `127.1` and `0x7f.0.0.1` mean `127.0.0.1`,
  and IPv6 addresses are compressed and lower case (`[2001:DB8:0:0::1]` matches `2001:db8::1`). A
  pattern that doesn't parse as a host matches nothing.

## The decision order

`decide()` returns `allow`, `deny` or `ask` for a URL. It checks the following in order:

1. The URL doesn't parse → deny.
2. The scheme is not `http:` or `https:` → deny.
3. The host is a loopback name (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `::`,
   IPv4-mapped loopback) → deny, in every mode. Clients route loopback to virtual ports before they
   get here, and the policy check never sends such a request to the user's machine.
4. A `deny` pattern matches → deny.
5. The host is in the session deny set → deny.
6. `mode` is `allow-all` → allow.
7. The host is in the session allow set → allow.
8. A host of an enabled preset matches → allow.
9. An `allow` pattern matches → allow.
10. `mode` is `ask` → ask; otherwise (`allowlist`) → deny.

This means a "deny for this session" answer also overrides `allow-all`, but a session allow never
overrides a `deny` pattern.

## Session decisions

The kernel keeps two sets, session allow and session deny. Their keys are host names only (lower
case, without the port, and without brackets for IPv6), so allowing a host for the session allows every
port of it.

| Answer | Waiting requests | Later requests to the host |
|---|---|---|
| `once` | allowed | asked again |
| `session` | allowed | allowed (added to session allow) |
| `deny` | denied | asked again |
| `deny-session` | denied | denied (added to session deny) |

The sets live as long as the kernel. `setPolicy()` doesn't touch them, and `vessel.network.clearSession()`
empties both. Both calls also make the preview service worker forget the allows it cached
([The preview](#the-preview)), so a host that is no longer allowed is decided again.

## Permission requests

When `decide()` returns `ask`, `checkNetwork()` in the kernel handles the request as follows:

1. If no host page is connected, it denies at once.
2. It coalesces requests by host name. If a request for the same host is already waiting, the new one
   waits for the same answer and nothing new is sent, so requests that differ only in port or path share
   one prompt.
3. Otherwise it sends `permission-request` to the host page with a new `id`, the full `url`, the `host`,
   the `initiator` and the `source`, and starts a 5-minute timer.
4. The request settles when the host page answers (`permission.respond`) or when the timer fires (deny).
   All waiting requests get the same result. The kernel then sends
   `permission-settled` `{ id, host, allowed, decision }`, where `decision` is the answer (`once`,
   `session`, `deny`, `deny-session`) or `timeout`. This is sent on a timeout too, so the host can close
   its dialog. An answer for a request that has already settled is ignored.

On the host page the request goes to `onPermissionRequest` or to the built-in dialog. Listeners of the
`permission-request` event see it first. A handler that throws counts as `deny`. The handler, the dialog
and both events are specified in [Host API](host-api.md#permission-requests).

`initiator` is set by the kernel. Requests from the kernel's own clients carry a secret token that only
the kernel knows, so their label is trusted: `npm` for the package managers, and the pid and command line
for `curl` and `wget`. For any other request (a process) the kernel takes the pid from the `x-ov-by`
header and shows that process's command line from its process table, or `process` if no running
process has that pid. A process can still name another running process's pid, but it can't make up a
label such as `npm`.

## Setting the policy

```ts
const vessel = await OpenVessel.boot({
  runtimeUrl, previewUrl,
  network: { mode: 'allowlist', presets: ['npm', 'fonts', 'cdn'] },
});

await vessel.network.setPolicy({ mode: 'ask', presets: ['npm'], allow: ['api.example.com'] });
const current = await vessel.network.getPolicy();
await vessel.network.clearSession();
```

The policy can be changed at any time, and the change applies to requests decided after it. Requests
already waiting for an answer are not decided again. Only the host page can change the policy, because
the runtime's service worker accepts its kernel channel only from the runtime window, and the preview's
channel to the kernel carries only HTTP, WebSocket and network checks.

## Enforcement

### The runtime: `/__ov/net`

The runtime service worker (`src/runtime/sw.ts`) answers `<runtime base>/__ov/net?url=<target>`. It is
the only code in the runtime that fetches other origins. The kernel's base is `/__ov/k/<kernel id>/`
under the runtime's directory, so the request reaches the kernel of the frame that made it
([Deployment](deployment.md)). For each request the service worker does the following:

1. Asks that kernel `{ k: 'net', url, initiator, token }`. If it has no kernel connection and gets none
   within 15 s, it answers `502` with `x-ov-error: network` (`OpenVessel kernel is not connected`).
2. On deny, answers `403` with `x-ov-error: denied` and the message
   `OpenVessel: network access to <host[:port]> was denied by the network policy`. If the permission
   request was not answered within 5 minutes, it answers `504` with `x-ov-error: timeout` and
   `OpenVessel: network access to <host[:port]> was not answered in time`.
3. Otherwise copies the request headers from `x-ov-h`, dropping `host`, `connection`,
   `content-length`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `trailer`, `expect`, `cookie`,
   `cookie2`, `origin`, `referer`, `accept-encoding`, `access-control-request-headers`,
   `access-control-request-method`, `date`, `dnt`, `via`, `proxy-connection`, and every `sec-*` and
   `proxy-*` header.
4. Fetches the target with the method from `x-ov-method`, the body (except for `GET`/`HEAD`),
   `mode: 'cors'`, `credentials: 'omit'`, `cache: 'no-store'`, and `redirect: 'error'` if `x-ov-redirect`
   is `error`, else `'follow'`.
5. If the fetch throws, answers `502` with `x-ov-error: network` and
   `request to <host> failed: <reason>. The server may not allow cross-origin requests (CORS) from the browser.`
6. If the response was redirected, asks the kernel again about the final URL. A deny or timeout is
   answered as in step 2 (with the final host in the message) and the body is dropped.
7. Otherwise answers `200` with the real status, status text, final URL, redirect flag and response
   headers in `x-ov-status`, `x-ov-status-text`, `x-ov-url`, `x-ov-redirected` and `x-ov-rh`, and the
   body (none for 204, 205, 304 and `HEAD`).

The message format is in [Protocol](protocol.md).

### What a refused or failed request looks like

| Client | Denied by the policy | Allowed, but the fetch failed |
|---|---|---|
| `fetch()` in a process (both runtimes) | `TypeError: fetch failed` with `cause.code === 'EACCES'` and `cause.message` the denial message (`ETIMEDOUT` when the prompt was not answered) | `TypeError: fetch failed` with `cause.code === 'ECONNREFUSED'` and the CORS hint |
| `http`/`https`/`net`/`tls` client (ported runtime) | An HTTP response `403 Forbidden` with `X-OpenVessel-Error: 1`, `Connection: close` and the message as the body; then the connection closes | `502 Bad Gateway`, same form |
| `http`/`https` client (legacy runtime) | `'error'` event: `Error` with the message and `code: 'EACCES'` | `'error'` event with `code: 'ECONNREFUSED'` |
| `net.connect` to an outside host (legacy runtime) | Not routed to the policy check: always `ECONNREFUSED` | — |
| `npm` and the other package managers | Error with `code: 'EACCES'` (`ETIMEDOUT` when the prompt was not answered); a tarball download is not retried | Error with `code: 'ECONNREFUSED'`; a tarball download is tried 3 times |
| `curl`, `wget` | `curl: (7) <message>`, exit status 7 | `curl: (7) <message>`, exit status 7 |
| The preview page | `403` with an empty body and status text `Blocked by OpenVessel network policy` (`… (not answered in time)` after a timeout) | The browser's own network error |

For the ported runtime's socket clients only HTTP/1.1 goes out. A connection whose first bytes aren't
a request line is closed, and a WebSocket upgrade is answered `501 Not Implemented`
([Kernel](kernel.md)).

### The preview

The preview service worker (`src/preview/sw.ts`) sees every request made by pages in its scope (the
preview iframes and the relay):

- Same origin as the preview: forwarded to the virtual port and never checked.
- A loopback host (`localhost`, `127.0.0.1`, `[::1]`…): forwarded to the virtual port in the URL (the
  page's port if the URL has none). Never checked, and never sent to the user's machine.
- Another origin, `http:` or `https:`: checked with the kernel (`source: 'preview'`). If allowed, the
  service worker fetches the original request unchanged (same mode and credentials as the page asked
  for), so the page's own CORS rules apply as usual. A `no-cors` request (`<img>`, a classic
  `<script>`…) works from any server, CORS or not, but its response is opaque and doesn't show where a
  redirect led. For these requests only the first URL is checked, and a redirect from an allowed host to
  a denied one is not caught. Every other redirected response is checked again at the URL it ended at.
- Other schemes (`data:`, `blob:`, …): not intercepted.

Differences from the runtime side:

- An allow that follows from the policy or from a "for this session" answer is cached in the service
  worker per origin. `once` is not cached, since it allows only that one request. The cache is emptied when the
  host calls `setPolicy()` or `clearSession()` and when the service worker gets a new kernel channel.
  Denials are not cached.
- If the service worker can't reach the kernel within 15 s, the request is refused (`403`), and the next
  request tries again.

### Redirects

The browser follows redirects inside a service worker's `fetch()` without showing the hops (a
`redirect: 'manual'` fetch of another origin gives an opaque response without its `Location`). Both
service workers therefore check where a redirected response ended. The final URL goes through the
policy in the same way as the first one, and if it is refused, the response is dropped and the request
is answered as denied. The hosts in between have been contacted by then, but nothing they sent reaches
the process or the page. When `curl`, `wget` or a package manager requests a loopback URL, it follows the
redirects itself. A hop to a loopback URL stays on the virtual ports, and any other hop goes through the
policy check.

### WebSockets

Service workers don't see WebSocket connections:

- In the preview, `__ov/inject.js` replaces `WebSocket`. Connections to the page's own host or a
  loopback name are tunnelled to the virtual server (this is how HMR works). For any other URL the
  socket first asks the preview service worker (`ws-check`, decided like an `http:`/`https:` request
  to the same host). It opens the browser's WebSocket only if allowed. Otherwise it fails with `error`
  and `close` `1006`, reason `blocked by OpenVessel network policy`. A page can still bypass the wrapper
  (for example from a worker of its own, whose `WebSocket` is the browser's).
- In processes, the ported runtime's `WebSocket` global is the browser's. On the runtime origin it is
  limited by the `connect-src` of the Content-Security-Policy below, so it can only connect to the
  runtime origin itself, and not to outside hosts or virtual ports. Through `net`/`tls` sockets,
  an upgrade to an outside host is answered `501`.

### Content Security Policy

The policy only works if nothing else can leave the runtime. `scripts/serve.mjs` serves every runtime
file except `sw.js` with a CSP whose `connect-src` is `'self' data: blob:`, so a process's direct
`fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource` to another origin is refused by the browser and
only `/__ov/net` (same origin) is reachable. `sw.js` must be served without that CSP. Deployments need
the same headers ([Deployment](deployment.md)). The preview origin has no such CSP; the previewed
site is limited by the preview service worker as described above.

## Localhost and virtual ports

Servers inside OpenVessel listen on virtual ports; nothing listens on the real machine. Requests to
`localhost`, `127.0.0.1`, `::1`/`[::1]`, `0.0.0.0` and `*.localhost` are handled as follows for each
client:

- `fetch()` in a process: sent to the virtual port through Node's `http` module (ported) or directly
  (legacy). Not checked by the policy. `ECONNREFUSED` if nothing listens. The legacy runtime also treats
  an empty host name as loopback.
- `http`/`net` clients in a process: connected to the virtual port. Not checked. `ECONNREFUSED` if
  nothing listens.
- `curl`, `wget` and the package managers (kernel): sent to the virtual port by the kernel
  (`curl http://localhost:4321/` reaches a dev server inside OpenVessel). Not checked. `ECONNREFUSED` if
  nothing listens. Redirects are followed, to the virtual ports for loopback and through the policy check
  otherwise.
- The preview page: its own origin and `http://localhost:<port>/` (any loopback name) reach the virtual
  server, and a loopback URL without a port uses the page's port. Not checked. WebSockets to loopback
  names are tunnelled to the port in the URL, or else to the page's port (see above).
- Anything that reaches the policy check anyway is denied by the policy in every mode
  ([The decision order](#the-decision-order)).

## Other schemes

- The policy denies every URL whose scheme isn't `http:` or `https:` (`ws:`, `wss:`, `ftp:`, `file:`, …).
- `fetch()` in the ported runtime reads `data:` and `blob:` URLs with the browser's `fetch`, without the
  policy check, and rejects other non-HTTP schemes with `TypeError: fetch failed`
  (`cause.code === 'ERR_INVALID_URL'`, `unsupported URL scheme <scheme>`).
- The preview service worker only checks `http:` and `https:` requests to other origins.

## CORS

Outgoing requests are made by the browser's `fetch` in the runtime service worker with
`mode: 'cors'` and `credentials: 'omit'`. Even when the policy allows a request, it can still fail or
come back with less information because of the rules the browser enforces:

- The server must allow the runtime origin with `Access-Control-Allow-Origin: *` or the runtime origin.
  Requests that need a preflight (methods other than `GET`, `HEAD`, `POST`, or headers that aren't
  CORS-safelisted, such as `Authorization` or custom headers) also need the server to answer the
  `OPTIONS` preflight. Otherwise the request fails with the CORS hint (`ECONNREFUSED`). Google Fonts
  metadata and many RSS feeds are in this group ([Compatibility](../compatibility.md#network)).
- No cookies are sent or stored, and the forbidden headers listed above are dropped.
- The process sees only the response headers the browser exposes, which are the CORS-safelisted ones
  and those in `Access-Control-Expose-Headers`. `Set-Cookie` never arrives.
- Bodies arrive already decoded by the browser, so a `Content-Length` header, when exposed, may not
  match the body.
- TLS is done and verified by the browser.

## Examples

Only npm, nothing else, and no prompts:

```ts
network: { mode: 'allowlist', presets: ['npm'] }
```

The defaults plus an API, asking the user about anything else:

```ts
network: { mode: 'ask', presets: ['npm', 'fonts', 'icons', 'cdn'], allow: ['api.example.com', '*.example.org'] }
```

Everything except some hosts:

```ts
network: { mode: 'allow-all', deny: ['*.doubleclick.net', 'analytics.example.com'] }
```

A private registry on a non-standard port, and GitHub for git dependencies:

```ts
network: { mode: 'allowlist', presets: ['npm', 'github'], allow: ['npm.internal.example.com:8443'] }
```

Refuse everything outside the lists without a dialog, but log what was refused:

```ts
const vessel = await OpenVessel.boot({
  runtimeUrl, previewUrl,
  network: { mode: 'ask', presets: ['npm', 'fonts', 'cdn'] },
  onPermissionRequest: (req) => { console.log('blocked', req.host, req.initiator); return 'deny-session'; },
});
```

With `mode: 'allowlist'` the handler would never be called, because nothing is ever asked. With
`'deny-session'` each host is logged once, and with `'deny'` every refused request is logged (coalesced
per host while one is waiting).

An app-specific prompt:

```ts
onPermissionRequest: async (req) => {
  const ok = await myConfirm(`${req.source === 'preview' ? 'The preview' : req.initiator} wants ${req.host}`);
  return ok ? 'session' : 'deny-session';
},
```
