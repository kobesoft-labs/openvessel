// globalThis.__ovUndici: what Node's lib takes from internal/deps/undici (fetch, Headers, Request,
// Response, FormData, MessageEvent, WebSocket, EventSource). undici speaks HTTP over TCP sockets;
// here fetch goes to virtual ports through Node's own http module, and everywhere else through the
// runtime's policy-checked proxy (the service worker's /__ov/net endpoint).

import * as loop from './loop.ts';
import { S, lib } from './state.ts';
import { nativeFetch } from './web.ts';

const g = globalThis as any;
const NativeRequest: typeof Request = g.Request;
const NativeResponse: typeof Response = g.Response;
const NativeHeaders: typeof Headers = g.Headers;
const NativeFormData: typeof FormData = g.FormData;
const NativeReadableStream: typeof ReadableStream = g.ReadableStream;
const NativeWebSocket: typeof WebSocket = g.WebSocket;
const NativeEventSource: typeof EventSource = g.EventSource;
const NativeURL: typeof URL = g.URL;
const NativeAbortController: typeof AbortController = g.AbortController;
const NativeAbortSignal: typeof AbortSignal = g.AbortSignal;

/** Node's AbortSignal (lib's EventTarget) as a browser AbortSignal, which the native Request requires. */
function browserSignal(signal: any): AbortSignal | null | undefined {
  if (!signal || signal instanceof NativeAbortSignal) return signal;
  const c = new NativeAbortController();
  if (signal.aborted) c.abort(signal.reason);
  else signal.addEventListener?.('abort', () => c.abort(signal.reason), { once: true });
  return c.signal;
}

/**
 * Bodies the browser's Request/Response don't take but Node's (undici) do: lib's ReadableStream (Node's
 * bootstrap replaces the global) and async iterables. They became the text "[object Object]"; they're
 * read into a browser stream instead.
 */
function browserBody(body: any): any {
  if (!body || typeof body !== 'object' || body instanceof NativeReadableStream) return body;
  // undici also takes an async iterable of chunks (Astro's dev server streams pages that way)
  if (typeof body.getReader !== 'function' && typeof body[Symbol.asyncIterator] === 'function') {
    const it = body[Symbol.asyncIterator]();
    return new NativeReadableStream({
      async pull(c) {
        const { done, value } = await it.next();
        if (done) c.close();
        else c.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value);
      },
      cancel(reason) {
        return it.return?.(reason);
      },
    });
  }
  if (typeof body.getReader !== 'function') return body;
  const reader = body.getReader();
  return new NativeReadableStream({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function browserInit(init?: RequestInit): RequestInit | undefined {
  if (!init) return init;
  const out: any = { ...init };
  if (init.signal) out.signal = browserSignal(init.signal);
  if (init.body) out.body = browserBody(init.body);
  // a streamed body needs duplex: 'half' in browsers (Node's undici implies it)
  if (init.body && typeof (init.body as any).getReader === 'function' && !out.duplex) out.duplex = 'half';
  return out;
}

// The browser's clone() and the static factories make objects of the browser's class, not the
// subclass, so `instanceof Response` (Astro's endpoint check) failed for them.
const asNode = <T extends object>(o: T, proto: object): T => Object.setPrototypeOf(o, proto);

/** Response as Node exposes it: accepts a body that is one of lib's ReadableStreams. */
const NodeResponse = class Response extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(browserBody(body), init);
  }
  static error() {
    return asNode(NativeResponse.error(), NodeResponse.prototype);
  }
  static json(data: unknown, init?: ResponseInit) {
    return asNode(NativeResponse.json(data, init), NodeResponse.prototype);
  }
  static redirect(url: string | URL, status?: number) {
    return asNode(NativeResponse.redirect(url, status), NodeResponse.prototype);
  }
  clone() {
    return asNode(super.clone(), NodeResponse.prototype);
  }
} as typeof Response;

/** Request as Node exposes it: accepts Node's AbortSignal and streamed bodies. */
const NodeRequest = class Request extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, browserInit(init));
  }
  clone() {
    return asNode(super.clone(), NodeRequest.prototype);
  }
} as typeof Request;

function fetchFailed(message: string, code?: string): TypeError {
  return new TypeError('fetch failed', { cause: code === undefined ? new Error(message) : Object.assign(new Error(message), { code }) });
}

/** undici's badPorts (the Fetch Standard's list): requests to them fail before connecting. */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const isLoopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');

async function proxyFetch(url: string, req: Request, body: ArrayBuffer | null): Promise<Response> {
  const headers: Record<string, string> = {
    'x-ov-h': encodeURIComponent(JSON.stringify([...req.headers])),
    'x-ov-by': encodeURIComponent(`${S.init.pid} ${S.argv.slice(0, 3).join(' ')}`.slice(0, 200)),
    'x-ov-method': req.method,
  };
  if (req.redirect) headers['x-ov-redirect'] = req.redirect;
  // the browser's fetch is no libuv handle: count it as a request so the loop doesn't think it's idle
  const done = loop.startReq('FetchRequest');
  let res: Response;
  try {
    res = await nativeFetch(`${S.runtimeBase}/__ov/net?url=${encodeURIComponent(url)}`, {
      method: req.method === 'GET' || req.method === 'HEAD' ? req.method : 'POST',
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      signal: req.signal,
    });
  } finally {
    done();
  }
  const err = res.headers.get('x-ov-error');
  if (err) {
    const msg = decodeURIComponent(res.headers.get('x-ov-message') ?? err);
    throw fetchFailed(msg, err === 'denied' ? 'EACCES' : err === 'timeout' ? 'ETIMEDOUT' : 'ECONNREFUSED');
  }
  const status = Number(res.headers.get('x-ov-status') ?? res.status);
  let outHeaders: [string, string][] = [];
  try {
    outHeaders = JSON.parse(decodeURIComponent(res.headers.get('x-ov-rh') ?? '[]'));
  } catch {}
  const nullBody = status === 204 || status === 205 || status === 304 || req.method === 'HEAD';
  const r = new NodeResponse(nullBody ? null : countedBody(res.body), { status: status || 200, statusText: decodeURIComponent(res.headers.get('x-ov-status-text') ?? ''), headers: outHeaders });
  Object.defineProperty(r, 'url', { value: decodeURIComponent(res.headers.get('x-ov-url') ?? url), configurable: true });
  Object.defineProperty(r, 'redirected', { value: res.headers.get('x-ov-redirected') === '1', configurable: true });
  return r;
}

/** The body, counted as a request while a read is waiting for data (like a reading socket). */
function countedBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new NativeReadableStream<Uint8Array>({
    async pull(c) {
      const done = loop.startReq('FetchBody');
      try {
        const { done: end, value } = await reader.read();
        if (end) c.close();
        else c.enqueue(value);
      } catch (e) {
        c.error(e);
      } finally {
        done();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The headers undici adds to every request that doesn't set them, in its order. */
const DEFAULT_HEADERS: [string, string][] = [
  ['accept', '*/*'],
  ['accept-language', '*'],
  ['sec-fetch-mode', 'cors'],
  ['user-agent', 'node'],
  ['accept-encoding', 'gzip, deflate'],
];

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * A request to a virtual port, made with Node's http or https module (so it is a real TCP connection,
 * and https goes through the same TLS handling as any tls/https client). The port is the URL's, else
 * the scheme's default; the Host header is the URL's host, as undici sends it.
 */
function loopbackRequest(url: URL, req: Request, body: Uint8Array | null, willFollow: (status: number, location: string | null) => boolean): Promise<Response> {
  const https = url.protocol === 'https:';
  const mod = lib(https ? 'https' : 'http');
  const headers: [string, string][] = [['host', url.host], ['connection', 'keep-alive'], ...req.headers];
  for (const [k, v] of DEFAULT_HEADERS) if (!req.headers.has(k)) headers.push([k, v]);
  // the body is complete, so its length is known (an empty one is announced only by methods that expect one)
  if (body && (body.length || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) headers.push(['content-length', String(body.length)]);
  return new Promise((resolve, reject) => {
    const r = mod.request(
      {
        host: '127.0.0.1',
        port: Number(url.port || (https ? 443 : 80)),
        path: url.pathname + url.search,
        method: req.method,
        headers: headers.flat(),
        // SNI and the certificate check use the URL's host name (undici connects to it by that name)
        ...(https && { servername: lib('net').isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '' : url.hostname }),
      },
      (res: any) => {
        const location = res.headers.location ?? null;
        // undici decodes the content codings it asked for, unless the response is followed or has no body
        let source = res;
        if (req.method !== 'HEAD' && req.method !== 'CONNECT' && !NULL_BODY_STATUS.has(res.statusCode) && !willFollow(res.statusCode, location)) {
          const codings = String(res.headers['content-encoding'] ?? '').toLowerCase().split(',').map((c) => c.trim()).filter(Boolean).reverse();
          const zlib = lib('zlib');
          const make: Record<string, () => any> = { gzip: () => zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }), 'x-gzip': () => make.gzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };
          if (codings.length && codings.every((c) => make[c])) for (const c of codings) source = source.pipe(make[c]());
          if (source !== res) res.on('error', (e: Error) => source.destroy(e));
        }
        const stream = new NativeReadableStream<Uint8Array>({
          start(c) {
            source.on('data', (d: Uint8Array) => c.enqueue(new Uint8Array(d)));
            source.on('end', () => c.close());
            source.on('error', (e: Error) => c.error(new TypeError('terminated', { cause: e })));
          },
          cancel() {
            res.destroy();
          },
        });
        const outHeaders: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) outHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        const nullBody = NULL_BODY_STATUS.has(res.statusCode) || req.method === 'HEAD';
        const response = new NodeResponse(nullBody ? null : stream, { status: res.statusCode, statusText: res.statusMessage, headers: outHeaders });
        Object.defineProperty(response, 'url', { value: url.href, configurable: true });
        resolve(response);
      },
    );
    // undici's cause is the socket's own error (code, errno, syscall, address, port)
    r.on('error', (e: Error) => reject(new TypeError('fetch failed', { cause: e })));
    req.signal?.addEventListener('abort', () => {
      r.destroy();
      reject(req.signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
    if (body?.length) r.write(body);
    r.end();
  });
}

/** The request body headers dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

/** undici's main fetch and HTTP-redirect fetch, for one request (and the redirects it follows). */
async function route(req: Request, redirects: number): Promise<Response> {
  const url = new NativeURL(req.url);
  // a Response of the global class (lib's Response is NodeResponse), as instanceof checks expect
  if (url.protocol === 'data:' || url.protocol === 'blob:') return asNode(await nativeFetch(req), NodeResponse.prototype);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fetchFailed(`unsupported URL scheme ${url.protocol}`, 'ERR_INVALID_URL');
  if (BAD_PORTS.has(Number(url.port))) throw fetchFailed('bad port');
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
  // outside requests: the browser's fetch follows redirects (the proxy reports where it ended)
  if (!isLoopback(url.hostname)) return proxyFetch(url.href, req, body ? (body.buffer as ArrayBuffer) : null);
  const follows = (status: number, location: string | null) => REDIRECT_STATUS.has(status) && location !== null && req.redirect === 'follow';
  const res = await loopbackRequest(url, req, body, follows);
  const location = res.headers.get('location');
  if (!REDIRECT_STATUS.has(res.status) || location === null || req.redirect === 'manual') return res;
  void res.body?.cancel();
  if (req.redirect === 'error') throw fetchFailed('unexpected redirect');
  let next: URL;
  try {
    next = new NativeURL(location, url);
  } catch {
    throw fetchFailed('Invalid URL');
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') throw fetchFailed('URL scheme must be a HTTP(S) scheme');
  if (redirects >= 20) throw fetchFailed('redirect count exceeded');
  let method = req.method;
  let nextBody: Uint8Array | null = body;
  const headers = new NativeHeaders(req.headers);
  if (((res.status === 301 || res.status === 302) && method === 'POST') || (res.status === 303 && method !== 'GET' && method !== 'HEAD')) {
    method = 'GET';
    nextBody = null;
    for (const h of BODY_HEADERS) headers.delete(h);
  }
  // credentials don't follow a request to another origin
  if (next.origin !== url.origin) for (const h of ['authorization', 'proxy-authorization', 'cookie', 'host']) headers.delete(h);
  const r = await route(new NativeRequest(next.href, { method, headers, body: nextBody as BodyInit | null, redirect: req.redirect, signal: req.signal }), redirects + 1);
  Object.defineProperty(r, 'redirected', { value: true, configurable: true });
  return r;
}

function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return loop.track(
    (async () => {
      const req = input instanceof NativeRequest && !init ? input : new NodeRequest(input as any, init);
      return route(req, 0);
    })(),
  );
}

let MessageEventClass: any = null;
let fastInit = false;
function messageEventClass() {
  if (MessageEventClass) return MessageEventClass;
  const { Event } = lib('internal/event_target');
  const { inspect } = lib('internal/util/inspect');
  const MessagePort = S.internalBinding('messaging').MessagePort;
  const str = (v: unknown) => (v !== null && typeof v === 'object' ? inspect(v) : String(v));
  const prefix = 'MessageEvent constructor: ';
  const isPort = (v: unknown) => v instanceof MessagePort;
  MessageEventClass = class MessageEvent extends Event {
    #data: unknown;
    #origin: string;
    #lastEventId: string;
    #source: unknown;
    #ports: readonly unknown[];
    constructor(type: string, init: { data?: unknown; origin?: string; lastEventId?: string; source?: unknown; ports?: unknown[] } | null = {}) {
      if (!fastInit) {
        // undici's webidl conversion of MessageEventInit
        if (arguments.length === 0) throw new TypeError(`${prefix}1 argument required, but only 0 present.`);
        init ??= {};
        const source = init.source ?? null;
        if (source !== null && !isPort(source)) throw new TypeError(`${prefix}Expected eventInitDict.source ("${str(source)}") to be an instance of MessagePort.`);
        let ports: unknown[] = [];
        if (init.ports !== undefined) {
          const p = init.ports as any;
          if (p === null || typeof p[Symbol.iterator] !== 'function') throw new TypeError(`${prefix}eventInitDict.ports (${str(p)}) is not iterable.`);
          ports = [...p];
          ports.forEach((x, i) => {
            if (!isPort(x)) throw new TypeError(`${prefix}Expected eventInitDict.ports[${i}] ("${str(x)}") to be an instance of MessagePort.`);
          });
        }
        const origin = init.origin === undefined ? '' : `${init.origin}`;
        const lastEventId = init.lastEventId === undefined ? '' : `${init.lastEventId}`;
        init = { ...init, origin, lastEventId, source, ports };
      }
      init ??= {};
      super(type, init);
      this.#data = init.data ?? null;
      this.#origin = init.origin ?? '';
      this.#lastEventId = init.lastEventId ?? '';
      this.#source = init.source ?? null;
      this.#ports = Object.freeze([...(init.ports ?? [])]);
    }
    get data() {
      return this.#data;
    }
    get origin() {
      return this.#origin;
    }
    get lastEventId() {
      return this.#lastEventId;
    }
    get source() {
      return this.#source;
    }
    get ports() {
      return this.#ports;
    }
  };
  return MessageEventClass;
}

/** For lib's own events: skips the webidl conversion. */
function createFastMessageEvent(type: string, init: object) {
  const C = messageEventClass();
  fastInit = true;
  try {
    return new C(type, init);
  } finally {
    fastInit = false;
  }
}

Object.defineProperty(g, '__ovUndici', {
  value: {
    fetch,
    Headers: NativeHeaders,
    Request: NodeRequest,
    Response: NodeResponse,
    FormData: NativeFormData,
    WebSocket: NativeWebSocket,
    EventSource: NativeEventSource,
    get MessageEvent() {
      return messageEventClass();
    },
    createFastMessageEvent,
  },
  configurable: true,
  enumerable: false,
});
