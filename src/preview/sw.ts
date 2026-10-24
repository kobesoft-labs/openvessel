// Preview-origin service worker: serves the preview iframe from the virtual ports
// inside the kernel, tunnels WebSockets, and applies the network policy to
// third-party loads. The channel to the kernel only carries HTTP/WebSocket.

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

// The preview may be served under a path (e.g. /demo/preview/): its own files are under the scope.
const SCOPE = new URL(sw.registration.scope).pathname;
const OWN = new Set(['relay.html', 'relay.js', 'sw.js', 'inject.js'].map((f) => `${SCOPE}__ov/${f}`));

let kernel: MessagePort | null = null;
let defaultPort = 0;
let nextId = 1;
const waiters: ((p: MessagePort) => void)[] = [];
const streams = new Map<number, { head?: (h: any) => void; ctrl?: ReadableStreamDefaultController<Uint8Array>; fail?: (msg: string) => void; ended?: boolean }>();
const netChecks = new Map<number, (ok: boolean) => void>();
const sockets = new Map<number, MessagePort>();
const clientPorts = new Map<string, number>();
const netDecisionCache = new Map<string, boolean>();

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (ev) => ev.waitUntil(sw.clients.claim()));

sw.addEventListener('message', (ev) => {
  const d = ev.data;
  const src = ev.source as Client | null;
  const fromRelay = !!src && new URL(src.url).pathname.endsWith('/relay.html');
  if (d?.t === 'kernel-port' && d.port instanceof MessagePort && fromRelay) {
    attach(d.port);
    if (typeof d.defaultPort === 'number' && d.defaultPort) defaultPort = d.defaultPort;
  } else if (d?.t === 'default-port' && fromRelay) {
    defaultPort = d.port;
  } else if (d?.t === 'ws-connect' && d.port instanceof MessagePort) {
    openSocket(d, src);
  }
});

function attach(p: MessagePort) {
  kernel = p;
  p.onmessage = (e) => onKernel(e.data);
  for (const w of waiters.splice(0)) w(p);
}

async function getKernel(): Promise<MessagePort> {
  if (kernel) return kernel;
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) if (new URL(c.url).pathname.endsWith('/relay.html')) c.postMessage({ t: 'need-kernel-port' });
  return new Promise((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => reject(new Error('preview is not connected to OpenVessel')), 15000);
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
      r?.(!!m.allow);
      return;
    }
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

function portFor(clientId: string | null | undefined): number {
  if (clientId && clientPorts.has(clientId)) return clientPorts.get(clientId)!;
  return defaultPort;
}

const INJECT = `<script src="${SCOPE}__ov/inject.js"></script>`;

function injectHtml(html: string): string {
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + INJECT + html.slice(m.index + m[0].length);
  const d = /<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d.index + d[0].length) + INJECT + html.slice(d.index + d[0].length);
  return INJECT + html;
}

async function forward(req: Request, port: number, isNavigation: boolean): Promise<Response> {
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
  k.postMessage({ k: 'req', id, port, method: req.method, url: url.pathname + url.search, headers, hasBody });
  if (hasBody) {
    const reqBody = new Uint8Array(await req.arrayBuffer());
    if (reqBody.length) k.postMessage({ k: 'body', id, data: reqBody }, [reqBody.buffer]);
    k.postMessage({ k: 'body-end', id });
  }
  let h: any;
  try {
    h = await head;
  } catch (e) {
    return new Response(errorPage(port, String((e as Error).message)), { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', ...isolationHeaders() } });
  }
  const out = new Headers();
  for (const [n, v] of h.headers as [string, string][]) {
    const ln = n.toLowerCase();
    if (ln === 'content-length' || ln === 'transfer-encoding' || ln === 'connection' || ln === 'keep-alive' || ln === 'content-encoding') continue;
    try {
      out.append(n, v);
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

async function netAllowed(url: string): Promise<boolean> {
  const host = new URL(url).host;
  if (netDecisionCache.has(host)) return netDecisionCache.get(host)!;
  const k = await getKernel();
  const id = nextId++;
  const ok = await new Promise<boolean>((resolve) => {
    netChecks.set(id, resolve);
    k.postMessage({ k: 'net', id, url });
  });
  // remember allows for this SW lifetime; re-ask denials later (the user may change their mind)
  if (ok) netDecisionCache.set(host, ok);
  return ok;
}

function openSocket(d: any, src: Client | null) {
  const port: MessagePort = d.port;
  const id = nextId++;
  sockets.set(id, port);
  const target = portFor(src?.id) || Number(d.vport) || defaultPort;
  getKernel().then((k) => {
    k.postMessage({ k: 'ws-open', id, port: target, url: d.path, headers: [['sec-websocket-protocol', (d.protocols ?? []).join(', ')], ['host', `localhost:${target}`], ['origin', d.origin ?? '']].filter(([, v]) => v) });
    port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'send') k.postMessage({ k: 'ws-msg', id, data: m.data, binary: m.binary });
      else if (m.t === 'close') {
        k.postMessage({ k: 'ws-close', id, code: m.code ?? 1000, reason: m.reason ?? '' });
        sockets.delete(id);
      }
    };
  }, () => port.postMessage({ t: 'close', code: 1006, reason: 'not connected' }));
}

sw.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) {
    if (!/^https?:$/.test(url.protocol)) return;
    ev.respondWith(
      netAllowed(req.url).then(
        (ok) => (ok ? fetch(req) : new Response('', { status: 403, statusText: 'Blocked by OpenVessel network policy' })),
        () => fetch(req),
      ),
    );
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
    if (ev.resultingClientId) clientPorts.set(ev.resultingClientId, port);
    // a redirect with isolation headers (COEP host pages refuse the plain Response.redirect)
    ev.respondWith(new Response(null, { status: 302, headers: { location: new URL(p, sw.location.origin).href, ...isolationHeaders() } }));
    return;
  }
  const isNav = req.mode === 'navigate';
  let port: number;
  if (isNav) {
    port = (ev.resultingClientId && clientPorts.get(ev.resultingClientId)) || portFor(ev.clientId);
    if (ev.resultingClientId) clientPorts.set(ev.resultingClientId, port);
  } else port = portFor(ev.clientId);
  ev.respondWith(forward(req, port, isNav));
});

export {};
