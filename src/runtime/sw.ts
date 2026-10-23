// Runtime-origin service worker:
//  /__ov/esm/*, /__ov/builtin/*  → ES modules served by the kernel from the VFS
//  /__ov/net?url=…               → the only way out to the network (policy-checked by the kernel)

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

let kernelPort: MessagePort | null = null;
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
let portWaiters: ((p: MessagePort) => void)[] = [];

sw.addEventListener('install', () => {
  sw.skipWaiting();
});
sw.addEventListener('activate', (ev) => {
  ev.waitUntil(sw.clients.claim());
});

sw.addEventListener('message', (ev) => {
  const src = ev.source as Client | null;
  // only the runtime frame (a window) may hand us the kernel channel
  if (!src || (src as WindowClient).type !== 'window' || !new URL(src.url).pathname.endsWith('/runtime.html')) return;
  if (ev.data?.t === 'kernel-port' && ev.data.port instanceof MessagePort) {
    setPort(ev.data.port);
  }
});

function setPort(p: MessagePort) {
  kernelPort = p;
  p.onmessage = (e) => {
    const m = e.data;
    const r = pending.get(m?.id);
    if (r) {
      pending.delete(m.id);
      r(m);
    }
  };
  const w = portWaiters;
  portWaiters = [];
  for (const fn of w) fn(p);
}

async function getPort(): Promise<MessagePort> {
  if (kernelPort) return kernelPort;
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) if (new URL(c.url).pathname.endsWith('/runtime.html')) c.postMessage({ t: 'need-kernel-port' });
  return new Promise<MessagePort>((resolve, reject) => {
    portWaiters.push(resolve);
    setTimeout(() => reject(new Error('OpenVessel kernel is not connected')), 15000);
  });
}

async function ask(msg: Record<string, unknown>): Promise<any> {
  const port = await getPort();
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    port.postMessage({ ...msg, id });
  });
}

const FORBIDDEN_REQ = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'cookie', 'cookie2', 'origin', 'referer', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'date', 'dnt', 'via', 'proxy-connection']);

async function handleNet(req: Request, url: URL): Promise<Response> {
  const target = url.searchParams.get('url') ?? '';
  const by = decodeURIComponent(req.headers.get('x-ov-by') ?? 'process');
  const method = req.headers.get('x-ov-method') ?? req.method;
  let decision: { allow: boolean };
  try {
    decision = await ask({ k: 'net', url: target, initiator: by });
  } catch (e) {
    return errorResponse('network', String((e as Error).message));
  }
  if (!decision.allow) return errorResponse('denied', `OpenVessel: network access to ${safeHost(target)} was denied by the network policy`);
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

function errorResponse(kind: string, message: string) {
  return new Response(message, { status: kind === 'denied' ? 403 : 502, headers: { 'x-ov-error': kind, 'x-ov-message': encodeURIComponent(message), 'content-type': 'text/plain' } });
}

sw.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/__ov/esm/') || url.pathname.startsWith('/__ov/builtin/')) {
    ev.respondWith(
      ask({ k: 'esm', pathname: url.pathname, search: url.search }).then(
        (r) => new Response(r.body, { status: r.status, headers: { 'content-type': `${r.type}; charset=utf-8`, 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' } }),
        (e) => new Response(`throw new Error(${JSON.stringify(String(e?.message ?? e))});`, { status: 200, headers: { 'content-type': 'text/javascript' } }),
      ),
    );
    return;
  }
  if (url.pathname === '/__ov/net') {
    ev.respondWith(handleNet(ev.request, url));
    return;
  }
  if (url.pathname === '/__ov/ping') {
    ev.respondWith(new Response('pong', { headers: { 'content-type': 'text/plain' } }));
  }
});

export {};
