// Runtime-origin service worker:
//  /__ov/esm/*, /__ov/builtin/*, /__ov/mw/*, /__ov/esm-error  → ES modules served by the kernel from the VFS
//  /__ov/net?url=…                                           → the only way out to the network (policy-checked by the kernel)
//
// Several runtime frames (tabs, or more than one boot() in a page) can share this worker, each with its own
// kernel. A runtime frame starts its kernel under /__ov/k/<kernel id>/kernel.js, so the kernel, its process
// workers and everything they load relative to themselves have URLs under that prefix; requests are routed
// to the kernel the prefix names, and static files under it are the runtime's own files.

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

interface Conn {
  port: MessagePort;
  pending: Map<number, (v: any) => void>;
  retired: boolean;
}

let nextId = 1;
/** kernel id → channel to that kernel */
const kernels = new Map<string, Conn>();
/** the kernel id that connected last (for requests that name no kernel) */
let lastKid: string | null = null;
let portWaiters: { kid: string | null; resolve: (c: Conn) => void }[] = [];
/** module URL outside any /__ov/k/ prefix → the kernel that served it (the legacy runtime's root /__ov/esm/ URLs) */
const servedBy = new Map<string, string>();
const SERVED_MAX = 20000;
const KID = /^[0-9a-f]{8,32}$/;

sw.addEventListener('install', () => {
  sw.skipWaiting();
});
sw.addEventListener('activate', (ev) => {
  ev.waitUntil(sw.clients.claim());
});

const isRuntimeWindow = (c: Client | null) => !!c && (c as WindowClient).type === 'window' && new URL(c.url).pathname.endsWith('/runtime.html');

sw.addEventListener('message', (ev) => {
  const src = ev.source as Client | null;
  // only a runtime frame (a window) may hand us a kernel channel
  if (!isRuntimeWindow(src)) return;
  const d = ev.data;
  if (d?.t === 'kernel-port' && d.port instanceof MessagePort && typeof d.kid === 'string' && KID.test(d.kid)) setPort(d.kid, d.port);
});

function setPort(kid: string, p: MessagePort) {
  const old = kernels.get(kid);
  if (old && old.port !== p) {
    // answers to requests already sent still arrive on the old channel; close it once they have
    old.retired = true;
    if (!old.pending.size) old.port.close();
  }
  const conn: Conn = { port: p, pending: new Map(), retired: false };
  kernels.set(kid, conn);
  lastKid = kid;
  p.onmessage = (e) => {
    const m = e.data;
    const r = conn.pending.get(m?.id);
    if (r) {
      conn.pending.delete(m.id);
      r(m);
      if (conn.retired && !conn.pending.size) conn.port.close();
    }
  };
  const w = portWaiters;
  portWaiters = [];
  for (const x of w) {
    if (x.kid === null || x.kid === kid) x.resolve(conn);
    else portWaiters.push(x);
  }
}

/** The channel to kernel `kid` (any kernel for null); asks the runtime frames for one when there is none. */
async function getConn(kid: string | null): Promise<Conn> {
  const c = kid ? kernels.get(kid) : lastKid ? kernels.get(lastKid) : undefined;
  if (c) return c;
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const cl of clients) if (isRuntimeWindow(cl)) cl.postMessage({ t: 'need-kernel-port', kid });
  return new Promise<Conn>((resolve, reject) => {
    const entry = { kid, resolve };
    portWaiters.push(entry);
    setTimeout(() => {
      portWaiters = portWaiters.filter((x) => x !== entry);
      reject(new Error('OpenVessel kernel is not connected'));
    }, 15000);
  });
}

async function ask(kid: string | null, msg: Record<string, unknown>): Promise<any> {
  const conn = await getConn(kid);
  const id = nextId++;
  return new Promise((resolve) => {
    conn.pending.set(id, resolve);
    conn.port.postMessage({ ...msg, id });
  });
}

const FORBIDDEN_REQ = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'cookie', 'cookie2', 'origin', 'referer', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'date', 'dnt', 'via', 'proxy-connection']);

async function handleNet(req: Request, url: URL, kid: string | null): Promise<Response> {
  const target = url.searchParams.get('url') ?? '';
  // the kernel decides what to show as the initiator: it only believes the label of its own requests
  const by = decodeURIComponent(req.headers.get('x-ov-by') ?? 'process');
  const token = req.headers.get('x-ov-k') ?? '';
  const method = req.headers.get('x-ov-method') ?? req.method;
  const check = async (u: string): Promise<Response | null> => {
    let decision: { allow: boolean; timeout?: boolean };
    try {
      decision = await ask(kid, { k: 'net', url: u, initiator: by, token });
    } catch (e) {
      return errorResponse('network', String((e as Error).message));
    }
    if (decision.timeout) return errorResponse('timeout', `OpenVessel: network access to ${safeHost(u)} was not answered in time`);
    if (!decision.allow) return errorResponse('denied', `OpenVessel: network access to ${safeHost(u)} was denied by the network policy`);
    return null;
  };
  const refused = await check(target);
  if (refused) return refused;
  let headers: [string, string][] = [];
  try {
    headers = JSON.parse(decodeURIComponent(req.headers.get('x-ov-h') ?? '[]'));
  } catch {}
  const h = new Headers();
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (FORBIDDEN_REQ.has(lk) || lk.startsWith('sec-') || lk.startsWith('proxy-')) continue;
    try {
      h.append(k, v);
    } catch {}
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await req.arrayBuffer();
  let res: Response;
  try {
    res = await fetch(target, { method, headers: h, body, redirect: (req.headers.get('x-ov-redirect') as RequestRedirect) === 'error' ? 'error' : 'follow', credentials: 'omit', mode: 'cors', cache: 'no-store' });
  } catch (e) {
    return errorResponse('network', `request to ${safeHost(target)} failed: ${(e as Error).message}. The server may not allow cross-origin requests (CORS) from the browser.`);
  }
  // The browser follows redirects without showing the hops to a service worker (a manual redirect of a
  // CORS request is an opaque response without its Location). The host it ended at is checked too, and
  // nothing from a host the policy refuses is handed back.
  if (res.redirected && res.url && res.url !== target) {
    const refusedFinal = await check(res.url);
    if (refusedFinal) {
      void res.body?.cancel();
      return refusedFinal;
    }
  }
  const rh: [string, string][] = [...res.headers];
  const out = new Headers({
    'x-ov-status': String(res.status),
    'x-ov-status-text': encodeURIComponent(res.statusText),
    'x-ov-url': encodeURIComponent(res.url || target),
    'x-ov-redirected': res.redirected ? '1' : '0',
    'x-ov-rh': encodeURIComponent(JSON.stringify(rh)),
    'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304 || method === 'HEAD';
  return new Response(nullBody ? null : res.body, { status: 200, headers: out });
}

function safeHost(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function errorResponse(kind: 'denied' | 'timeout' | 'network', message: string) {
  return new Response(message, { status: kind === 'denied' ? 403 : kind === 'timeout' ? 504 : 502, headers: { 'x-ov-error': kind, 'x-ov-message': encodeURIComponent(message), 'content-type': 'text/plain' } });
}

// The runtime may be served under a path (e.g. /demo/runtime/): its /__ov/… URLs are relative to the scope.
const SCOPE = new URL(sw.registration.scope).pathname;
const NS = `${SCOPE}__ov/k/`;

/** `/__ov/k/<kid>/<rest>` → kid and `/<rest>`; null outside a kernel's prefix. */
function splitKernel(pathname: string): { kid: string; rest: string } | null {
  if (!pathname.startsWith(NS)) return null;
  const s = pathname.slice(NS.length);
  const i = s.indexOf('/');
  const kid = i < 0 ? s : s.slice(0, i);
  return KID.test(kid) ? { kid, rest: i < 0 ? '/' : s.slice(i) } : null;
}

/**
 * Which kernel a request without a prefix belongs to (the legacy runtime asks for root /__ov/… URLs): the
 * one named by the referrer — a file under a kernel's prefix, or a module a kernel served — else the last
 * kernel that connected.
 */
function kernelOf(ev: FetchEvent): string | null {
  const ref = ev.request.referrer;
  if (ref) {
    try {
      const r = new URL(ref);
      if (r.origin === sw.location.origin) {
        const k = splitKernel(r.pathname);
        if (k) return k.kid;
        const s = servedBy.get(r.href);
        if (s) return s;
      }
    } catch {}
  }
  return lastKid;
}

/**
 * Static hosts that can't set headers (GitHub Pages): the runtime's own files get the cross-origin
 * isolation headers here, which the kernel's SharedArrayBuffer needs. Headers already set are kept.
 */
const ISOLATION: Record<string, string> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'cross-origin',
};
async function withIsolation(req: Request, from?: string): Promise<Response> {
  const res = await fetch(from ? new Request(from, { method: req.method, headers: req.headers, credentials: req.credentials, cache: req.cache, redirect: 'follow' }) : req);
  if (res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0) return res;
  const missing = Object.keys(ISOLATION).filter((k) => !res.headers.has(k));
  // a file fetched from another path is answered as a new response, so the script keeps the URL it was
  // requested with (a worker's location and a module's import.meta.url are its response's URL)
  if (!missing.length && !from) return res;
  const headers = new Headers(res.headers);
  for (const k of missing) headers.set(k, ISOLATION[k]);
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304 || req.method === 'HEAD';
  return new Response(nullBody ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}

function remember(url: string, kid: string) {
  if (servedBy.size >= SERVED_MAX) servedBy.delete(servedBy.keys().next().value!);
  servedBy.delete(url);
  servedBy.set(url, kid);
}

function moduleResponse(kid: string | null, path: string, search: string): Promise<Response> {
  return ask(kid, { k: 'esm', pathname: path, search }).then(
    (r) => new Response(r.body, { status: r.status, headers: { 'content-type': `${r.type}; charset=utf-8`, 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' } }),
    (e) => new Response(`throw new Error(${JSON.stringify(String(e?.message ?? e))});`, { status: 200, headers: { 'content-type': 'text/javascript' } }),
  );
}

const isModulePath = (path: string) => path.startsWith('/__ov/esm/') || path.startsWith('/__ov/builtin/') || path.startsWith('/__ov/mw/') || path === '/__ov/esm-error';

sw.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin !== sw.location.origin || !url.pathname.startsWith(SCOPE)) return;
  const ns = splitKernel(url.pathname);
  // /__ov/… relative to where the runtime is served (or to a kernel's prefix)
  const path = ns ? ns.rest : '/' + url.pathname.slice(SCOPE.length);
  if (isModulePath(path) || path === '/__ov/net') {
    ev.respondWith(
      (async () => {
        const kid = ns ? ns.kid : kernelOf(ev);
        if (path === '/__ov/net') return handleNet(ev.request, url, kid);
        if (!ns && kid) remember(url.href, kid);
        return moduleResponse(kid, path, url.search);
      })(),
    );
    return;
  }
  if (path === '/__ov/ping') {
    ev.respondWith(new Response('pong', { headers: { 'content-type': 'text/plain' } }));
    return;
  }
  // the runtime's own files, also when asked for under a kernel's prefix
  if (ns) {
    const real = new URL(SCOPE + ns.rest.slice(1) + url.search, url).href;
    ev.respondWith(ev.request.method === 'GET' || ev.request.method === 'HEAD' ? withIsolation(ev.request, real) : fetch(new Request(real, ev.request)));
    return;
  }
  if (ev.request.method === 'GET') ev.respondWith(withIsolation(ev.request));
});

export {};
