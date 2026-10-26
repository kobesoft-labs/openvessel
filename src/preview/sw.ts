// Preview-origin service worker: serves the preview iframe from the virtual ports
// inside the kernel, tunnels WebSockets, and applies the network policy to
// third-party loads. The channel to the kernel only carries HTTP/WebSocket.

import { isLoopbackHost } from '../shared/policy.ts';

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

// The preview may be served under a path (e.g. /demo/preview/): its own files are under the scope.
const SCOPE = new URL(sw.registration.scope).pathname;
const RELAY = `${SCOPE}__ov/relay.html`;
const OWN = new Set([...['relay.html', 'relay.js', 'inject.js'].map((f) => `${SCOPE}__ov/${f}`), `${SCOPE}__ov-sw.js`]);

let kernel: MessagePort | null = null;
let defaultPort = 0;
let nextId = 1;
let waiters: ((p: MessagePort) => void)[] = [];
const streams = new Map<number, { head?: (h: any) => void; ctrl?: ReadableStreamDefaultController<Uint8Array>; fail?: (msg: string) => void; ended?: boolean }>();
const netChecks = new Map<number, (v: NetVerdict) => void>();
const sockets = new Map<number, MessagePort>();
/** Origins the kernel allowed with a lasting answer (policy or "for this session"); cleared on `net-flush`. */
const allowCache = new Set<string>();

interface NetVerdict {
  allow: boolean;
  cache?: boolean;
  timeout?: boolean;
}

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (ev) => ev.waitUntil(sw.clients.claim()));

/** The relay frame: exactly `<scope>__ov/relay.html`, in a frame (the host embeds it). */
function isRelay(src: Client | null): boolean {
  if (!src || (src as WindowClient).type !== 'window' || new URL(src.url).pathname !== RELAY) return false;
  const frameType = (src as WindowClient).frameType;
  return !frameType || frameType === 'nested';
}

sw.addEventListener('message', (ev) => {
  const d = ev.data;
  const src = ev.source as Client | null;
  if (d?.t === 'kernel-port' && d.port instanceof MessagePort && isRelay(src)) {
    attach(d.port);
    if (typeof d.defaultPort === 'number' && d.defaultPort) setDefaultPort(d.defaultPort);
  } else if (d?.t === 'default-port' && typeof d.port === 'number' && isRelay(src)) {
    setDefaultPort(d.port);
  } else if (d?.t === 'ws-connect' && d.port instanceof MessagePort) {
    ev.waitUntil(openSocket(d, src));
  } else if (d?.t === 'ws-check' && d.port instanceof MessagePort && typeof d.url === 'string') {
    // a WebSocket to an outside host: the page's WebSocket asks before it connects
    const reply: MessagePort = d.port;
    ev.waitUntil(netCheck(d.url).then((v) => reply.postMessage({ allow: v.allow })));
  }
});

function attach(p: MessagePort) {
  // the old channel's requests end with it (the kernel aborts them when it sees the port close)
  if (kernel && kernel !== p) kernel.close();
  kernel = p;
  // decisions cached from the old channel may be stale (the policy can change while we were away)
  allowCache.clear();
  p.onmessage = (e) => onKernel(e.data);
  const w = waiters;
  waiters = [];
  for (const fn of w) fn(p);
}

async function getKernel(): Promise<MessagePort> {
  if (kernel) return kernel;
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) if (isRelay(c)) c.postMessage({ t: 'need-kernel-port' });
  return new Promise((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => {
      waiters = waiters.filter((w) => w !== resolve);
      reject(new Error('preview is not connected to OpenVessel'));
    }, 15000);
  });
}

function onKernel(m: any) {
  switch (m.k) {
    case 'head': {
      const s = streams.get(m.id);
      s?.head?.(m);
      return;
    }
    case 'data':
      streams.get(m.id)?.ctrl?.enqueue(m.data);
      return;
    case 'end': {
      const s = streams.get(m.id);
      streams.delete(m.id);
      try {
        s?.ctrl?.close();
      } catch {}
      return;
    }
    case 'error': {
      const s = streams.get(m.id);
      streams.delete(m.id);
      s?.fail?.(m.msg);
      try {
        s?.ctrl?.error(new Error(m.msg));
      } catch {}
      return;
    }
    case 'net-result': {
      const r = netChecks.get(m.id);
      netChecks.delete(m.id);
      r?.({ allow: !!m.allow, cache: !!m.cache, timeout: !!m.timeout });
      return;
    }
    case 'net-flush':
      allowCache.clear();
      return;
    case 'ws-opened':
      sockets.get(m.id)?.postMessage({ t: 'open', protocol: m.protocol });
      return;
    case 'ws-msg':
      sockets.get(m.id)?.postMessage({ t: 'msg', data: m.data, binary: m.binary });
      return;
    case 'ws-closed': {
      const p = sockets.get(m.id);
      sockets.delete(m.id);
      p?.postMessage({ t: 'close', code: m.code, reason: m.reason });
      return;
    }
  }
}

// -----------------------------------------------------------------------------
// which port a page belongs to: kept in Cache Storage too, so open pages keep their port when the
// browser restarts this worker

const clientPorts = new Map<string, number>();
const PORTS_CACHE = 'openvessel-preview-ports';
const portKey = (id: string) => new URL(`${SCOPE}__ov/port/${encodeURIComponent(id)}`, sw.location.origin).href;
const DEFAULT_KEY = new URL(`${SCOPE}__ov/default-port`, sw.location.origin).href;

const loaded: Promise<void> = (async () => {
  try {
    const cache = await caches.open(PORTS_CACHE);
    const d = await cache.match(DEFAULT_KEY);
    if (d && !defaultPort) defaultPort = Number(await d.text()) || 0;
    const prefix = portKey('');
    // matchAll, not clients.get(): get() waits for a page that is still loading, and that page's
    // navigation may be waiting for this
    const live = new Set((await sw.clients.matchAll({ includeUncontrolled: true })).map((c) => c.id));
    for (const req of await cache.keys()) {
      if (!req.url.startsWith(prefix)) continue;
      const id = decodeURIComponent(req.url.slice(prefix.length));
      if (clientPorts.has(id)) continue;
      // records of pages that are gone are dropped
      if (!live.has(id)) {
        void cache.delete(req);
        continue;
      }
      const r = await cache.match(req);
      const port = Number(await r?.text());
      if (port && !clientPorts.has(id)) clientPorts.set(id, port);
    }
  } catch {}
})();

function persist(key: string, value: number) {
  void caches
    .open(PORTS_CACHE)
    .then((c) => c.put(key, new Response(String(value))))
    .catch(() => {});
}

function setClientPort(id: string, port: number) {
  if (clientPorts.get(id) === port) return;
  clientPorts.set(id, port);
  persist(portKey(id), port);
}

function setDefaultPort(port: number) {
  defaultPort = port;
  persist(DEFAULT_KEY, port);
}

async function portFor(clientId: string | null | undefined): Promise<number> {
  await loaded;
  if (clientId && clientPorts.has(clientId)) return clientPorts.get(clientId)!;
  return defaultPort;
}

// -----------------------------------------------------------------------------
// HTTP to virtual ports

const INJECT_SCRIPT = `<script src="${SCOPE}__ov/inject.js"></script>`;

/**
 * Served under a path (SCOPE isn't "/"): the site still runs at "/" on its server, so the scope comes
 * off request paths here and goes onto the root paths the site's pages use — HTML attributes, an
 * import map for module specifiers (/@vite/client, /src/…), redirects; inject.js does fetch().
 */
const MOUNTED = SCOPE !== '/';
const toServerPath = (p: string) => (MOUNTED && p.startsWith(SCOPE) ? '/' + p.slice(SCOPE.length) : p);
const toPreviewPath = (p: string) => (MOUNTED && p.startsWith('/') && !p.startsWith('//') && !p.startsWith(SCOPE) ? SCOPE + p.slice(1) : p);
const IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: { '/': SCOPE, [SCOPE]: SCOPE } })}</script>`;

function mountHtml(html: string): string {
  if (!MOUNTED) return html;
  return html
    .replace(/(\s(?:src|href|action|poster|formaction)\s*=\s*)(["'])(\/[^"']*)\2/gi, (_m, a, q, v) => `${a}${q}${toPreviewPath(v)}${q}`)
    .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, a, q, v: string) => `${a}${q}${v.replace(/(^|,\s*)(\/[^\s,]*)/g, (_x, sep, u) => sep + toPreviewPath(u))}${q}`);
}

function injectHtml(html: string): string {
  html = mountHtml(html);
  const INJECT = MOUNTED ? IMPORT_MAP + INJECT_SCRIPT : INJECT_SCRIPT;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + INJECT + html.slice(m.index + m[0].length);
  const d = /<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d.index + d[0].length) + INJECT + html.slice(d.index + d[0].length);
  return INJECT + html;
}

/**
 * Sends a request to a virtual port. `loopback`: the page asked for http://localhost:<port>/… (another
 * origin to the browser): the path is the server's own, and Location headers are left alone.
 */
async function forward(req: Request, port: number, isNavigation: boolean, loopback = false, attempt = 0): Promise<Response> {
  const k = await getKernel();
  const url = new URL(req.url);
  const id = nextId++;
  const headers: [string, string][] = [...req.headers].filter(([n]) => !/^(sec-|cookie$|accept-encoding$)/.test(n));
  headers.push(['host', `localhost:${port}`]);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let resolveHead!: (h: any) => void;
  let rejectHead!: (e: Error) => void;
  const head = new Promise<any>((res, rej) => {
    resolveHead = res;
    rejectHead = rej;
  });
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      streams.delete(id);
      k.postMessage({ k: 'abort', id });
    },
  });
  streams.set(id, { head: resolveHead, ctrl, fail: (msg) => rejectHead(new Error(msg)) });
  k.postMessage({ k: 'req', id, port, method: req.method, url: (loopback ? url.pathname : toServerPath(url.pathname)) + url.search, headers, hasBody });
  if (hasBody) {
    const reqBody = new Uint8Array(await req.arrayBuffer());
    if (reqBody.length) k.postMessage({ k: 'body', id, data: reqBody }, [reqBody.buffer]);
    k.postMessage({ k: 'body-end', id });
  }
  let h: any;
  try {
    h = await head;
  } catch (e) {
    // a dev server may listen briefly to probe the port, then for real a moment later (Vite does)
    if (!hasBody && attempt < 15 && /ECONNREFUSED/.test(String((e as Error).message))) {
      await new Promise((r) => setTimeout(r, 200));
      return forward(req, port, isNavigation, loopback, attempt + 1);
    }
    return new Response(errorPage(port, String((e as Error).message)), { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', ...isolationHeaders() } });
  }
  const out = new Headers();
  for (const [n, v] of h.headers as [string, string][]) {
    const ln = n.toLowerCase();
    if (ln === 'content-length' || ln === 'transfer-encoding' || ln === 'connection' || ln === 'keep-alive' || ln === 'content-encoding') continue;
    try {
      out.append(n, ln === 'location' && !loopback ? toPreviewPath(v) : v);
    } catch {}
  }
  for (const [n, v] of Object.entries(isolationHeaders())) if (!out.has(n)) out.set(n, v);
  const status = h.status === 101 ? 200 : h.status;
  const nullBody = status === 204 || status === 205 || status === 304 || req.method === 'HEAD';
  const ct = out.get('content-type') ?? '';
  if (isNavigation && ct.includes('text/html') && !nullBody) {
    const text = await new Response(body).text();
    return new Response(injectHtml(text), { status, statusText: h.statusText, headers: out });
  }
  // redirects must not be followed by fetch here; Location headers are relative to the preview origin
  return new Response(nullBody ? null : body, { status, statusText: h.statusText, headers: out });
}

async function withIsolation(req: Request): Promise<Response> {
  const res = await fetch(req);
  if (res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  for (const [n, v] of Object.entries(isolationHeaders())) if (!headers.has(n)) headers.set(n, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function isolationHeaders(): Record<string, string> {
  return { 'cross-origin-embedder-policy': 'credentialless', 'cross-origin-resource-policy': 'cross-origin', 'cross-origin-opener-policy': 'same-origin' };
}

function errorPage(port: number, msg: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>Preview unavailable</title><body style="font:14px system-ui;padding:24px;color:#444"><h3>Nothing is listening on port ${port}</h3><p>${esc(msg)}</p><p>Start a dev server (for example <code>npm run dev</code>) and reload.</p></body>`;
}

// -----------------------------------------------------------------------------
// the network policy for outside requests

/** Asks the kernel whether `url` may be fetched. Without a kernel channel the answer is no. */
async function netCheck(url: string): Promise<NetVerdict> {
  let origin: string;
  try {
    const u = new URL(url);
    // the policy decides http(s); a WebSocket is checked as the same URL over http(s)
    if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol === 'wss:') u.protocol = 'https:';
    url = u.href;
    origin = u.origin;
  } catch {
    return { allow: false };
  }
  if (allowCache.has(origin)) return { allow: true };
  let k: MessagePort;
  try {
    k = await getKernel();
  } catch {
    return { allow: false };
  }
  const id = nextId++;
  const v = await new Promise<NetVerdict>((resolve) => {
    netChecks.set(id, resolve);
    k.postMessage({ k: 'net', id, url });
  });
  // "allow once" (cache false) is good for this one request only
  if (v.allow && v.cache && k === kernel) allowCache.add(origin);
  return v;
}

function blocked(v: NetVerdict | null, why = 'Blocked by OpenVessel network policy') {
  return new Response('', { status: 403, statusText: v?.timeout ? 'Blocked by OpenVessel network policy (not answered in time)' : why });
}

/**
 * An outside request of a preview page. The browser follows redirects inside fetch() without showing
 * the hops, so every response that was redirected is checked again at the URL it ended at, and nothing
 * from a host the policy refuses is handed to the page. A no-cors load (<img>, classic <script>…) is
 * passed through as it is, so pages show images from servers that don't send CORS headers: its response
 * is opaque and doesn't show where a redirect ended, so for these only the first URL is checked.
 */
async function outside(req: Request): Promise<Response> {
  const first = await netCheck(req.url);
  if (!first.allow) return blocked(first);
  const res = await fetch(req);
  if (res.redirected && res.url && res.url !== req.url) {
    const final = await netCheck(res.url);
    if (!final.allow) {
      void res.body?.cancel();
      return blocked(final);
    }
  }
  return res;
}

// -----------------------------------------------------------------------------
// WebSockets tunnelled to virtual ports

async function openSocket(d: any, src: Client | null) {
  const port: MessagePort = d.port;
  const id = nextId++;
  sockets.set(id, port);
  // an explicit port in a loopback URL (a dev server's separate HMR port) wins over the page's port
  const target = Number(d.vport) || (await portFor(src?.id)) || defaultPort;
  let k: MessagePort;
  try {
    k = await getKernel();
  } catch {
    sockets.delete(id);
    port.postMessage({ t: 'close', code: 1006, reason: 'not connected' });
    return;
  }
  k.postMessage({ k: 'ws-open', id, port: target, url: d.vport ? String(d.path) : toServerPath(String(d.path)), headers: [['sec-websocket-protocol', (d.protocols ?? []).join(', ')], ['host', `localhost:${target}`], ['origin', d.origin ?? '']].filter(([, v]) => v) });
  port.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'send') k.postMessage({ k: 'ws-msg', id, data: m.data, binary: m.binary });
    else if (m.t === 'close') {
      k.postMessage({ k: 'ws-close', id, code: m.code ?? 1000, reason: m.reason ?? '' });
      sockets.delete(id);
    }
  };
}

sw.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) {
    if (!/^https?:$/.test(url.protocol)) return;
    // localhost & co. are the virtual ports, never the user's machine; without a port in the URL, the page's
    if (isLoopbackHost(url.hostname)) {
      ev.respondWith(portFor(ev.clientId).then((p) => forward(req, Number(url.port) || p, false, true)));
      return;
    }
    ev.respondWith(outside(req));
    return;
  }
  // own files, with the isolation headers a static host may not set (GitHub Pages)
  if (OWN.has(url.pathname)) {
    ev.respondWith(withIsolation(req));
    return;
  }
  if (url.pathname === `${SCOPE}__ov/open`) {
    const port = Number(url.searchParams.get('port')) || defaultPort;
    const p = url.searchParams.get('path') || '/';
    if (ev.resultingClientId) setClientPort(ev.resultingClientId, port);
    // a redirect with isolation headers (COEP host pages refuse the plain Response.redirect)
    ev.respondWith(new Response(null, { status: 302, headers: { location: new URL(toPreviewPath(p), sw.location.origin).href, ...isolationHeaders() } }));
    return;
  }
  const isNav = req.mode === 'navigate';
  ev.respondWith(
    (async () => {
      let port: number;
      if (isNav) {
        await loaded;
        port = (ev.resultingClientId && clientPorts.get(ev.resultingClientId)) || (await portFor(ev.clientId));
        if (ev.resultingClientId) setClientPort(ev.resultingClientId, port);
      } else port = await portFor(ev.clientId);
      return forward(req, port, isNav);
    })(),
  );
});

export {};
