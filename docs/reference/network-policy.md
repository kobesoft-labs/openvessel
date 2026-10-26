# Network policy

[日本語](network-policy.ja.md)

Everything inside OpenVessel that reaches a host outside the tab goes through one gate, and the
embedding page decides what that gate lets through. This page specifies the policy model
(`src/shared/policy.ts`), the order in which a request is decided, how the user is asked
(`src/kernel/index.ts`), where the policy is enforced (`src/runtime/sw.ts`, `src/preview/sw.ts`) and
what each kind of client sees when a request is refused.

## What goes through the gate

| Traffic | Path to the gate | `source` / `initiator` |
|---|---|---|
| `fetch()` in a `node` process (both runtimes) | The process calls the runtime service worker's `/__ov/net` | `runtime` / pid and command line, e.g. `7 node` |
| `http`/`https` clients, `net.connect`/`tls.connect` to a non-local address (ported runtime) | The kernel reads HTTP/1.1 from the socket (`src/kernel/outbound.ts`) and calls `/__ov/net` per request | `runtime` / pid and command line |
| `http`/`https` clients (legacy runtime) | The process calls `/__ov/net` | `runtime` / pid and command line |
| `npm`, `pnpm`, `yarn`, `bun`: registry metadata and tarballs | The kernel calls `/__ov/net` | `runtime` / `npm` |
| `curl`, `wget` | The kernel calls `/__ov/net` | `runtime` / `npm` |
| Requests of a previewed page to other origins (scripts, styles, images, fonts, `fetch`, XHR, `EventSource`) | The preview service worker asks the kernel | `preview` / `preview` |

The decision is always made in the kernel, with one policy and one set of session decisions for both
the runtime and the preview.

Not checked by the policy:

- Requests to virtual ports: loopback names in processes and same-origin requests of the preview
  ([Localhost and virtual ports](#localhost-and-virtual-ports)).
- OpenVessel's own compat package tarballs, downloaded from `<runtime base>/compat/` on the runtime
  origin.
- npm tarballs already in the runtime origin's Cache Storage (`openvessel-npm-v1`); they are verified
  against their `integrity` before use.
- The hosts a redirect leads to: the browser follows redirects inside the service worker, after the
  first URL was allowed.
- WebSocket connections: service workers don't see them ([WebSockets](#websockets)).

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
and is normalised by `normalizePolicy()`: each missing field takes the default above (not the current
value), and preset names that don't exist are dropped. `vessel.network.getPolicy()` returns the
normalised policy. Without a `network` option the kernel starts with the defaults.

## Modes

| Mode | Host matched by a preset or `allow` | Any other host |
|---|---|---|
| `ask` | allowed | the host page is asked ([Permission requests](#permission-requests)) |
| `allowlist` | allowed | denied |
| `allow-all` | allowed | allowed |

In every mode `deny` patterns, "deny for this session" decisions and non-HTTP URLs are refused.

## Presets

`PRESETS` is exported from `openvessel`. Each entry is an exact host name (no wildcards, any port):

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

Rules (`matches()` in `src/shared/policy.ts`):

- Patterns are trimmed and compared in lower case; host names are lower-cased by the URL parser. An
  empty pattern matches nothing.
- `*` is a wildcard only as the whole pattern or as a leading `*.`; anywhere else it is a literal
  character.
- A port in a pattern is compared with the URL's port, where a URL without a port has `443` for
  `https:` and `80` for `http:` (`example.com:443` matches `https://example.com/`).
- IP addresses are matched as written (`192.168.0.10`). IPv6 literals can't be matched: the host is
  compared without brackets, and a pattern starting with `[` never matches.

## The decision order

`decide()` returns `allow`, `deny` or `ask` for a URL, checking in this order:

1. The URL doesn't parse → **deny**.
2. The scheme is not `http:` or `https:` → **deny**.
3. A `deny` pattern matches → **deny**.
4. The host is in the session deny set → **deny**.
5. `mode` is `allow-all` → **allow**.
6. The host is in the session allow set → **allow**.
7. A host of an enabled preset matches → **allow**.
8. An `allow` pattern matches → **allow**.
9. `mode` is `ask` → **ask**; otherwise (`allowlist`) → **deny**.

So a "deny for this session" answer also overrides `allow-all`, while a session allow never overrides
a `deny` pattern.

## Session decisions

The kernel keeps two sets, session allow and session deny. Their keys are **host names only**: lower
case, without the port, and without brackets for IPv6. Allowing `localhost` for the session allows
every port of it.

| Answer | Waiting requests | Later requests to the host |
|---|---|---|
| `once` | allowed | asked again |
| `session` | allowed | allowed (added to session allow) |
| `deny` | denied | asked again |
| `deny-session` | denied | denied (added to session deny) |

The sets live as long as the kernel. `setPolicy()` doesn't touch them; `vessel.network.clearSession()`
empties both.

## Permission requests

When `decide()` returns `ask`, `checkNetwork()` in the kernel:

1. Denies at once if no host page is connected.
2. Coalesces by host name: if a request for the same host is already waiting, the new one waits for the
   same answer and nothing new is sent. Requests that differ only in port or path share one prompt.
3. Otherwise sends `permission-request` to the host page with a new `id`, the full `url`, the `host`,
   the `initiator` and the `source`, and starts a 5-minute timer.
4. Settles when the host page answers (`permission.respond`) or when the timer fires (deny). All
   waiting requests get the same result; the kernel then sends
   `permission-settled` `{ id, host, allowed }`. An answer for a request that already settled is
   ignored.

On the host page the request goes to `onPermissionRequest` or to the built-in dialog; listeners of the
`permission-request` event see it first. A handler that throws counts as `deny`. The handler, the dialog
and both events are specified in [Host API](host-api.md#permission-requests).

`initiator` is supplied by the requesting side (the `x-ov-by` header of `/__ov/net`), so it is a hint
for the user, not an identity. The kernel's own clients report `npm` — including `curl` and `wget`.

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

The policy can be changed at any time; it applies to requests decided after the change. Requests
already waiting for an answer are not re-decided. Only the host page can change the policy: the
runtime's service worker accepts its kernel channel only from the runtime window, and the preview's
channel to the kernel carries only HTTP, WebSocket and network checks.

## Enforcement

### The runtime: `/__ov/net`

The runtime service worker (`src/runtime/sw.ts`) answers `<runtime base>/__ov/net?url=<target>` and is
the only code in the runtime that fetches other origins. For each request it:

1. Asks the kernel `{ k: 'net', url, initiator }`. If it has no kernel connection and gets none within
   15 s, it answers `502` with `x-ov-error: network` (`OpenVessel kernel is not connected`).
2. On deny, answers `403` with `x-ov-error: denied` and the message
   `OpenVessel: network access to <host[:port]> was denied by the network policy`.
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
6. Otherwise answers `200` with the real status, status text, final URL, redirect flag and response
   headers in `x-ov-status`, `x-ov-status-text`, `x-ov-url`, `x-ov-redirected` and `x-ov-rh`, and the
   body (none for 204, 205, 304 and `HEAD`).

The message format is in [Protocol](protocol.md).

### What a refused or failed request looks like

| Client | Denied by the policy | Allowed, but the fetch failed |
|---|---|---|
| `fetch()` in a process (both runtimes) | `TypeError: fetch failed` with `cause.code === 'EACCES'` and `cause.message` the denial message | `TypeError: fetch failed` with `cause.code === 'ECONNREFUSED'` and the CORS hint |
| `http`/`https`/`net`/`tls` client (ported runtime) | An HTTP response `403 Forbidden` with `X-OpenVessel-Error: 1`, `Connection: close` and the message as the body; then the connection closes | `502 Bad Gateway`, same form |
| `http`/`https` client (legacy runtime) | `'error'` event: `Error` with the message and `code: 'EACCES'` | `'error'` event with `code: 'ECONNREFUSED'` |
| `net.connect` to an outside host (legacy runtime) | Not routed to the gate: always `ECONNREFUSED` | — |
| `npm` and the other package managers | Error with `code: 'EACCES'`; a tarball download is not retried | Error with `code: 'ECONNREFUSED'`; a tarball download is tried 3 times |
| `curl`, `wget` | `curl: (7) <message>`, exit status 7 | `curl: (7) <message>`, exit status 7 |
| The preview page | `403` with an empty body and status text `Blocked by OpenVessel network policy` | The browser's own network error |

For the ported runtime's socket clients only HTTP/1.1 goes out: a connection whose first bytes aren't
a request line is closed, and a WebSocket upgrade is answered `501 Not Implemented`
([Kernel](kernel.md)).

### The preview

The preview service worker (`src/preview/sw.ts`) sees every request made by pages in its scope (the
preview iframes and the relay):

- Same origin as the preview: forwarded to the virtual port — never checked.
- Another origin, `http:` or `https:`: checked with the kernel (`source: 'preview'`); if allowed, the
  service worker fetches the original request unchanged (same mode and credentials as the page asked
  for), so the page's own CORS rules apply as usual.
- Other schemes (`data:`, `blob:`, …): not intercepted.

Differences from the runtime side:

- An **allow** is cached in the service worker per URL host *with* port for as long as the worker
  runs, so a `once` answer for the preview lasts until the preview service worker restarts, and neither
  `setPolicy()` nor `clearSession()` revokes a cached allow. Denials are not cached.
- If the service worker can't reach the kernel within 15 s, the request is let through unchecked.

### WebSockets

Service workers don't see WebSocket connections, so the policy never decides them:

- In the preview, `__ov/inject.js` replaces `WebSocket`. Connections to the page's own host,
  `localhost`, `127.0.0.1` or `[::1]` are tunnelled to the virtual server (this is how HMR works); any
  other URL uses the browser's WebSocket directly.
- In processes, the ported runtime's `WebSocket` global is the browser's. On the runtime origin it is
  limited by the `connect-src` of the Content-Security-Policy below. Through `net`/`tls` sockets, an
  upgrade to an outside host is answered `501`.

### Content Security Policy

The gate only works if nothing else can leave the runtime. `scripts/serve.mjs` serves every runtime
file except `sw.js` with a CSP whose `connect-src` is `'self' data: blob:`, so a process's direct
`fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource` to another origin is refused by the browser and
only `/__ov/net` (same origin) is reachable. `sw.js` must be served without that CSP. Deployments need
the same headers ([Deployment](deployment.md)). The preview origin has no such CSP: the previewed
site is limited by the preview service worker as described above.

## Localhost and virtual ports

Servers inside OpenVessel listen on virtual ports; nothing listens on the real machine.

| Client | `localhost`, `127.0.0.1`, `::1`/`[::1]`, `0.0.0.0`, `*.localhost` |
|---|---|
| `fetch()` in a process | Sent to the virtual port through Node's `http` module (ported) or directly (legacy). Not checked by the policy. `ECONNREFUSED` if nothing listens. The legacy runtime also treats an empty host name as loopback. |
| `http`/`net` clients in a process | Connected to the virtual port. Not checked. `ECONNREFUSED` if nothing listens. |
| `curl`, `wget`, package managers (kernel) | **Not** routed to virtual ports: the URL goes to the gate like any other. `localhost` is in no preset, so it is asked or denied; if allowed, the runtime service worker fetches the user's real `localhost`. |
| Preview page | Only its own origin reaches the virtual server. An absolute `http://localhost:<port>/` URL is another origin: it is checked by the policy and, if allowed, fetched from the real machine. WebSockets to `localhost` are tunnelled to the virtual server (see above). |

## Other schemes

- The policy denies every URL whose scheme isn't `http:` or `https:` (`ws:`, `wss:`, `ftp:`, `file:`, …).
- `fetch()` in the ported runtime reads `data:` and `blob:` URLs with the browser's `fetch`, without the
  gate, and rejects other non-HTTP schemes with `TypeError: fetch failed`
  (`cause.code === 'ERR_INVALID_URL'`, `unsupported URL scheme <scheme>`).
- The preview service worker only checks `http:` and `https:` requests to other origins.

## CORS

Outgoing requests are made by the browser's `fetch` in the runtime service worker with
`mode: 'cors'` and `credentials: 'omit'`. A request the policy allows can still fail or come back
reduced because of what the browser enforces:

- The server must allow the runtime origin: `Access-Control-Allow-Origin: *` or the runtime origin.
  Requests that need a preflight (methods other than `GET`, `HEAD`, `POST`, or headers that aren't
  CORS-safelisted, such as `Authorization` or custom headers) also need the server to answer the
  `OPTIONS` preflight. Otherwise the request fails with the CORS hint (`ECONNREFUSED`). Google Fonts
  metadata and many RSS feeds are in this group ([Compatibility](../compatibility.md#network)).
- No cookies are sent or stored, and the forbidden headers listed above are dropped.
- The process sees only the response headers the browser exposes: the CORS-safelisted ones and those
  in `Access-Control-Expose-Headers`. `Set-Cookie` never arrives.
- Bodies arrive already decoded by the browser, so a `Content-Length` header, when exposed, may not
  match the body.
- TLS is done and verified by the browser.

## Examples

Only npm, nothing else, no prompts:

```ts
network: { mode: 'allowlist', presets: ['npm'] }
```

The defaults, plus an API, with the user asked about anything else:

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

With `mode: 'allowlist'` the handler would never be called, because nothing is ever asked. `'deny-session'`
logs each host once; `'deny'` logs every refused request (coalesced per host while one is waiting).

An app-specific prompt:

```ts
onPermissionRequest: async (req) => {
  const ok = await myConfirm(`${req.source === 'preview' ? 'The preview' : req.initiator} wants ${req.host}`);
  return ok ? 'session' : 'deny-session';
},
```
