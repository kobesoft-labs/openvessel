// Outgoing HTTP from a process: loopback to virtual ports, or the runtime's
// policy-checked network proxy (the service worker's /__ov/net endpoint).

import { track } from './loop.ts';
import { loopbackRequest } from './netbridge.ts';
import { sys } from './sys.ts';

export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let runtimeOrigin = '';
let pidLabel = '';
export function setNetInfo(origin: string, pid: number, cmd: string) {
  runtimeOrigin = origin;
  pidLabel = `${pid} ${cmd}`.slice(0, 200);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '']);

export function isLoopbackHost(h: string) {
  return LOOPBACK.has(h) || h.endsWith('.localhost');
}

export function virtualPortExists(port: number): boolean {
  try {
    return sys<boolean>('portInfo', { port });
  } catch {
    return false;
  }
}

function fetchFailed(message: string, code: string, cause?: unknown): TypeError {
  const c = Object.assign(new Error(message), { code, cause });
  return Object.assign(new TypeError('fetch failed'), { cause: c });
}

/** Performs a request through the runtime proxy. */
export async function proxyFetch(url: string, init: { method?: string; headers?: [string, string][]; body?: BodyInit | null; signal?: AbortSignal | null; redirect?: RequestRedirect }): Promise<Response> {
  const headers = new Headers();
  headers.set('x-ov-h', encodeURIComponent(JSON.stringify(init.headers ?? [])));
  headers.set('x-ov-by', encodeURIComponent(pidLabel));
  if (init.redirect) headers.set('x-ov-redirect', init.redirect);
  const res = await nativeFetch(`${runtimeOrigin}/__ov/net?url=${encodeURIComponent(url)}`, {
    method: init.method === 'GET' || init.method === 'HEAD' ? init.method : 'POST',
    headers: { ...Object.fromEntries(headers), 'x-ov-method': init.method ?? 'GET' },
    body: init.method === 'GET' || init.method === 'HEAD' ? undefined : (init.body as BodyInit | null | undefined),
    signal: init.signal ?? undefined,
    // @ts-ignore duplex is required by Chrome for streaming bodies
    duplex: init.body instanceof ReadableStream ? 'half' : undefined,
  });
  const err = res.headers.get('x-ov-error');
  if (err) {
    const msg = decodeURIComponent(res.headers.get('x-ov-message') ?? err);
    throw fetchFailed(msg, err === 'denied' ? 'EACCES' : err === 'timeout' ? 'ETIMEDOUT' : 'ECONNREFUSED');
  }
  const status = Number(res.headers.get('x-ov-status') ?? res.status);
  const statusText = decodeURIComponent(res.headers.get('x-ov-status-text') ?? res.statusText);
  const finalUrl = decodeURIComponent(res.headers.get('x-ov-url') ?? url);
  let outHeaders: [string, string][] = [];
  try {
    outHeaders = JSON.parse(decodeURIComponent(res.headers.get('x-ov-rh') ?? '[]'));
  } catch {}
  const nullBody = status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
  const r = new Response(nullBody ? null : res.body, { status: status === 0 ? 200 : status, statusText, headers: outHeaders });
  Object.defineProperty(r, 'url', { value: finalUrl });
  Object.defineProperty(r, 'redirected', { value: res.headers.get('x-ov-redirected') === '1' });
  return r;
}

/** Loopback request to a virtual server, as a fetch Response. */
export function loopbackFetch(url: URL, method: string, headers: [string, string][], body: Uint8Array | null, signal?: AbortSignal | null): Promise<Response> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise<Response>((resolve, reject) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
      cancel() {
        handle.abort();
      },
    });
    const handle = loopbackRequest(port, method, url.pathname + url.search, headers, {
      onHead(status, statusText, h) {
        const nullBody = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        const r = new Response(nullBody ? null : stream, { status, statusText, headers: h.filter(([k]) => k.toLowerCase() !== 'set-cookie' || true) });
        Object.defineProperty(r, 'url', { value: url.href });
        resolve(r);
      },
      onData(d) {
        ctrl.enqueue(d);
      },
      onEnd() {
        try {
          ctrl.close();
        } catch {}
      },
      onError(msg) {
        reject(fetchFailed(msg, 'ECONNRESET'));
        try {
          ctrl.error(new Error(msg));
        } catch {}
      },
    });
    if (body && body.length) handle.write(body);
    handle.end();
    signal?.addEventListener('abort', () => {
      handle.abort();
      reject(signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
  });
}

/** The global fetch inside processes. */
export function ovFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return track(
    (async () => {
      let req: Request;
      try {
        req = input instanceof Request && !init ? input : new Request(input as any, init);
      } catch (e) {
        throw e;
      }
      const url = new URL(req.url);
      if (url.protocol === 'data:' || url.protocol === 'blob:') return nativeFetch(req);
      if (url.protocol === 'file:') {
        const e = new TypeError('fetch failed');
        (e as any).cause = new Error('not implemented... yet...');
        throw e;
      }
      const headers: [string, string][] = [...req.headers];
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
      if (isLoopbackHost(url.hostname)) {
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        if (!virtualPortExists(port)) throw fetchFailed(`connect ECONNREFUSED 127.0.0.1:${port}`, 'ECONNREFUSED');
        return loopbackFetch(url, req.method, headers, body, req.signal);
      }
      return proxyFetch(url.href, { method: req.method, headers, body, signal: req.signal, redirect: req.redirect });
    })(),
  );
}
