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

/** Response as Node exposes it: accepts a body that is one of lib's ReadableStreams. */
const NodeResponse = class Response extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(browserBody(body), init);
  }
} as typeof Response;

/** Request as Node exposes it: accepts Node's AbortSignal and streamed bodies. */
const NodeRequest = class Request extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, browserInit(init));
  }
} as typeof Request;

function fetchFailed(message: string, code: string): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

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
  const r = new NativeResponse(nullBody ? null : countedBody(res.body), { status: status || 200, statusText: decodeURIComponent(res.headers.get('x-ov-status-text') ?? ''), headers: outHeaders });
  Object.defineProperty(r, 'url', { value: decodeURIComponent(res.headers.get('x-ov-url') ?? url) });
  Object.defineProperty(r, 'redirected', { value: res.headers.get('x-ov-redirected') === '1' });
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

/** A request to a virtual port, made with Node's http module (so it is a real TCP connection). */
function loopbackFetch(url: URL, req: Request, body: Uint8Array | null): Promise<Response> {
  const http = lib('http');
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: Number(url.port || 80), path: url.pathname + url.search, method: req.method, headers: Object.fromEntries(req.headers) },
      (res: any) => {
        const stream = new NativeReadableStream<Uint8Array>({
          start(c) {
            res.on('data', (d: Uint8Array) => c.enqueue(new Uint8Array(d)));
            res.on('end', () => c.close());
            res.on('error', (e: Error) => c.error(e));
          },
          cancel() {
            res.destroy();
          },
        });
        const headers: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        const nullBody = res.statusCode === 204 || res.statusCode === 304 || req.method === 'HEAD';
        const response = new NativeResponse(nullBody ? null : stream, { status: res.statusCode, statusText: res.statusMessage, headers });
        Object.defineProperty(response, 'url', { value: url.href });
        resolve(response);
      },
    );
    r.on('error', (e: Error & { code?: string }) => reject(fetchFailed(e.message, e.code ?? 'ECONNREFUSED')));
    req.signal?.addEventListener('abort', () => {
      r.destroy();
      reject(req.signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
    if (body?.length) r.write(body);
    r.end();
  });
}

function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return loop.track(
    (async () => {
      const req = input instanceof NativeRequest && !init ? input : new NodeRequest(input as any, init);
      const url = new NativeURL(req.url);
      if (url.protocol === 'data:' || url.protocol === 'blob:') return nativeFetch(req);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fetchFailed(`unsupported URL scheme ${url.protocol}`, 'ERR_INVALID_URL');
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
      if (isLoopback(url.hostname)) return loopbackFetch(url, req, body);
      return proxyFetch(url.href, req, body ? (body.buffer as ArrayBuffer) : null);
    })(),
  );
}

let MessageEventClass: any = null;
function messageEventClass() {
  if (MessageEventClass) return MessageEventClass;
  const { Event } = lib('internal/event_target');
  MessageEventClass = class MessageEvent extends Event {
    #data: unknown;
    #origin: string;
    #lastEventId: string;
    #source: unknown;
    #ports: readonly unknown[];
    constructor(type: string, init: { data?: unknown; origin?: string; lastEventId?: string; source?: unknown; ports?: unknown[] } = {}) {
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
    createFastMessageEvent: (type: string, init: object) => new (messageEventClass())(type, init),
  },
  configurable: true,
  enumerable: false,
});
