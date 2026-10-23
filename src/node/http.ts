// node:http / node:https — servers on virtual ports, clients via loopback or the network proxy.

import { Buffer } from 'buffer';
import { EventEmitter } from './events.ts';
import { Handle, nextTick } from './loop.ts';
import { Server as NetServer, Socket } from './net.ts';
import { type HttpReqMsg, onReqBody, onWs, registerListener, sendResponseData, sendResponseEnd, sendResponseHead, unregisterListener, wsAccept, wsClose, wsSend } from './netbridge.ts';
import { isLoopbackHost, loopbackFetch, proxyFetch, virtualPortExists } from './netfetch.ts';
import { Readable, Writable } from './stream.ts';
import { FrameParser, encodeClientFrame } from './wscodec.ts';

export const METHODS = ['ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'];
export const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required',
};
export const maxHeaderSize = 16384;

export function validateHeaderName(name: string) {
  if (typeof name !== 'string' || !/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(name)) {
    throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: 'ERR_INVALID_HTTP_TOKEN' });
  }
}
export function validateHeaderValue(name: string, value: unknown) {
  if (value === undefined) throw Object.assign(new TypeError(`Invalid value "${value}" for header "${name}"`), { code: 'ERR_HTTP_INVALID_HEADER_VALUE' });
  if (/[^\t\x20-\x7e\x80-\xff]/.test(String(value))) throw Object.assign(new TypeError(`Invalid character in header content ["${name}"]`), { code: 'ERR_INVALID_CHAR' });
}

function headersToObject(pairs: [string, string][]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [k0, v] of pairs) {
    const k = k0.toLowerCase();
    if (k === 'set-cookie') {
      ((out[k] as string[]) ??= []).push(v);
    } else if (out[k] !== undefined) {
      if (k === 'cookie') out[k] += '; ' + v;
      else if (['content-type', 'content-length', 'user-agent', 'referer', 'host', 'authorization', 'proxy-authorization', 'if-modified-since', 'if-unmodified-since', 'from', 'location', 'max-forwards', 'retry-after', 'etag', 'last-modified', 'server', 'age', 'expires'].includes(k)) continue;
      else out[k] += ', ' + v;
    } else out[k] = v;
  }
  return out;
}

// -----------------------------------------------------------------------------
// IncomingMessage

export class IncomingMessage extends Readable {
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  method?: string;
  url?: string;
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  headersDistinct: Record<string, string[]> = {};
  trailersDistinct: Record<string, string[]> = {};
  complete = false;
  aborted = false;
  socket: Socket;
  connection: Socket;
  constructor(socket?: Socket) {
    super();
    this.socket = socket ?? new Socket();
    this.connection = this.socket;
  }
  _setHeaders(pairs: [string, string][]) {
    this.headers = headersToObject(pairs);
    this.rawHeaders = pairs.flat();
    const d: Record<string, string[]> = {};
    for (const [k, v] of pairs) (d[k.toLowerCase()] ??= []).push(v);
    this.headersDistinct = d;
  }
  _read() {}
  setTimeout(_ms: number, cb?: () => void) {
    if (cb) this.once('timeout', cb);
    return this;
  }
}

// -----------------------------------------------------------------------------
// OutgoingMessage / ServerResponse

export class OutgoingMessage extends Writable {
  protected _headers = new Map<string, [string, string | number | string[]]>();
  headersSent = false;
  sendDate = true;
  finished = false;
  chunkedEncoding = false;
  useChunkedEncodingByDefault = true;
  shouldKeepAlive = false;
  socket: Socket | null = null;
  connection: Socket | null = null;
  constructor() {
    super();
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    validateHeaderName(name);
    this._headers.set(name.toLowerCase(), [name, value as any]);
    return this;
  }
  appendHeader(name: string, value: string | readonly string[]) {
    const cur = this.getHeader(name);
    const add = Array.isArray(value) ? value : [value];
    if (cur === undefined) this.setHeader(name, add.length === 1 ? add[0] : add);
    else this.setHeader(name, [...(Array.isArray(cur) ? cur : [String(cur)]), ...add]);
    return this;
  }
  setHeaders(h: Headers | Map<string, any>) {
    for (const [k, v] of h as any) this.setHeader(k, v);
    return this;
  }
  getHeader(name: string) {
    return this._headers.get(name.toLowerCase())?.[1];
  }
  getHeaders(): Record<string, any> {
    const o: Record<string, any> = Object.create(null);
    for (const [k, [, v]] of this._headers) o[k] = v;
    return o;
  }
  getHeaderNames() {
    return [...this._headers.keys()];
  }
  getRawHeaderNames() {
    return [...this._headers.values()].map(([n]) => n);
  }
  hasHeader(name: string) {
    return this._headers.has(name.toLowerCase());
  }
  removeHeader(name: string) {
    if (this.headersSent) throw Object.assign(new Error('Cannot remove headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    this._headers.delete(name.toLowerCase());
  }
  flushHeaders() {}
  setTimeout(_ms: number, cb?: () => void) {
    if (cb) this.once('timeout', cb);
    return this;
  }
  addTrailers(_h: unknown) {}
  protected _headerPairs(): [string, string][] {
    const out: [string, string][] = [];
    for (const [, [name, v]] of this._headers) {
      if (Array.isArray(v)) for (const x of v) out.push([name, String(x)]);
      else out.push([name, String(v)]);
    }
    return out;
  }
}

export class ServerResponse extends OutgoingMessage {
  statusCode = 200;
  statusMessage = '';
  req: IncomingMessage;
  private rid: number;
  private isHead: boolean;
  strictContentLength = false;

  constructor(req: IncomingMessage, rid = 0) {
    super();
    this.req = req;
    this.rid = rid;
    this.isHead = req.method === 'HEAD';
    this.socket = req.socket;
    this.connection = req.socket;
    this.once('finish', () => {
      this.finished = true;
      nextTick(() => this.emit('close'));
    });
  }

  writeHead(status: number, msg?: any, headers?: any) {
    if (this.headersSent) throw Object.assign(new Error('Cannot write headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    if (typeof msg !== 'string') {
      headers = msg;
      msg = undefined;
    }
    this.statusCode = status;
    if (msg) this.statusMessage = msg;
    if (Array.isArray(headers)) {
      if (headers.length && Array.isArray(headers[0])) for (const [k, v] of headers) this.appendHeader(k, v);
      else for (let i = 0; i < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]);
    } else if (headers) {
      for (const k of Object.keys(headers)) if (headers[k] !== undefined) this.setHeader(k, headers[k]);
    }
    this._sendHead();
    return this;
  }

  writeContinue() {}
  writeProcessing() {}
  writeEarlyHints(_h: unknown, cb?: () => void) {
    cb?.();
  }

  private _sendHead() {
    if (this.headersSent) return;
    this.headersSent = true;
    if (this.sendDate && !this.hasHeader('date')) this._headers.set('date', ['Date', new Date().toUTCString()]);
    sendResponseHead(this.rid, this.statusCode, this.statusMessage || STATUS_CODES[this.statusCode] || '', this._headerPairs());
  }

  _write(chunk: any, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    this._sendHead();
    if (!this.isHead) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
      sendResponseData(this.rid, new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice());
    }
    cb();
  }

  _final(cb: (e?: Error | null) => void) {
    this._sendHead();
    sendResponseEnd(this.rid);
    cb();
  }

  end(chunk?: any, enc?: any, cb?: any) {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    } else if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (!this.headersSent && chunk !== undefined && chunk !== null && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
      const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, enc) : chunk.byteLength;
      this.setHeader('Content-Length', len);
    }
    return super.end(chunk, enc, cb);
  }

  assignSocket(s: Socket) {
    this.socket = s;
  }
  detachSocket() {}
}

// -----------------------------------------------------------------------------
// Server

export class Server extends NetServer {
  timeout = 0;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  maxHeadersCount: number | null = null;
  maxRequestsPerSocket = 0;
  constructor(opts?: any, listener?: (req: IncomingMessage, res: ServerResponse) => void) {
    super();
    if (typeof opts === 'function') listener = opts;
    if (listener) this.on('request', listener);
  }
  protected override _kind() {
    return 'http';
  }
  protected override _onListen(port: number) {
    registerListener(port, { onRequest: (msg) => this._handle(msg) });
  }
  protected override _onClose(port: number) {
    unregisterListener(port);
  }
  setTimeout(ms: number, cb?: () => void) {
    this.timeout = ms;
    if (cb) this.on('timeout', cb);
    return this;
  }
  closeAllConnections() {}
  closeIdleConnections() {}

  private _handle(msg: HttpReqMsg) {
    const socket = new Socket();
    socket.localPort = this._port;
    const req = new IncomingMessage(socket);
    req.method = msg.method;
    req.url = msg.url;
    req._setHeaders(msg.headers);
    if (msg.upgrade) {
      this._handleUpgrade(msg, req);
      return;
    }
    const res = new ServerResponse(req, msg.rid);
    if (msg.hasBody) {
      onReqBody(msg.rid, {
        onData: (d) => req.push(Buffer.from(d)),
        onEnd: () => {
          req.complete = true;
          req.push(null);
        },
        onAbort: () => {
          req.aborted = true;
          req.destroy();
          res.destroy();
        },
      });
    } else {
      req.complete = true;
      req.push(null);
    }
    try {
      if (req.headers.expect === '100-continue' && this.listenerCount('checkContinue')) this.emit('checkContinue', req, res);
      else this.emit('request', req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String((e as Error)?.stack ?? e));
      }
      throw e;
    }
  }

  /** WebSocket upgrade: hand the listener a socket that speaks the wire protocol. */
  private _handleUpgrade(msg: HttpReqMsg, req: IncomingMessage) {
    if (this.listenerCount('upgrade') === 0) {
      wsClose(msg.rid, 1011, 'no upgrade handler');
      return;
    }
    let handshakeDone = false;
    let headBuf = '';
    const parser = new FrameParser((opcode, payload) => {
      if (opcode === 1) wsSend(msg.rid, new TextDecoder().decode(payload), false);
      else if (opcode === 2) wsSend(msg.rid, payload, true);
      else if (opcode === 8) {
        const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
        const reason = new TextDecoder().decode(payload.subarray(2));
        wsClose(msg.rid, code, reason);
        socket.destroy();
      }
      // ping/pong are handled locally
      else if (opcode === 9) socket._feed(encodeClientFrame(payload, 10));
    });
    const socket: Socket = new Socket({
      _sink: (d: Uint8Array) => {
        if (handshakeDone) {
          parser.push(d);
          return;
        }
        headBuf += new TextDecoder('latin1').decode(d);
        const end = headBuf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = headBuf.slice(0, end);
        const rest = headBuf.slice(end + 4);
        handshakeDone = true;
        const lines = head.split('\r\n');
        const status = Number(lines[0].split(' ')[1]);
        const hdrs: [string, string][] = lines.slice(1).map((l) => {
          const i = l.indexOf(':');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        });
        if (status !== 101) {
          wsClose(msg.rid, 1002, `handshake rejected (${status})`);
          socket.destroy();
          return;
        }
        const proto = hdrs.find(([k]) => k.toLowerCase() === 'sec-websocket-protocol')?.[1] ?? null;
        wsAccept(msg.rid, proto, hdrs);
        if (rest) parser.push(Uint8Array.from(rest, (c) => c.charCodeAt(0)));
      },
      _onEnd: () => {
        wsClose(msg.rid, 1000, '');
      },
    });
    socket.localPort = this._port;
    req.socket = socket;
    req.connection = socket;
    onWs(msg.rid, {
      onMessage: (data, binary) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        socket._feed(encodeClientFrame(bytes, binary ? 2 : 1));
      },
      onClose: (code) => {
        const p = new Uint8Array([code >> 8, code & 0xff]);
        socket._feed(encodeClientFrame(p, 8));
        setTimeout(() => socket.destroy(), 100);
      },
    });
    // ensure the handshake headers the ws library expects are present
    if (!req.headers['sec-websocket-key']) {
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      req.headers['sec-websocket-key'] = key;
      req.rawHeaders.push('Sec-WebSocket-Key', key);
    }
    if (!req.headers['sec-websocket-version']) {
      req.headers['sec-websocket-version'] = '13';
      req.rawHeaders.push('Sec-WebSocket-Version', '13');
    }
    req.headers.upgrade ??= 'websocket';
    req.headers.connection ??= 'Upgrade';
    this.emit('upgrade', req, socket, Buffer.alloc(0));
  }
}

export function createServer(opts?: any, listener?: any) {
  return new Server(opts, listener);
}

// -----------------------------------------------------------------------------
// Client

export class Agent extends EventEmitter {
  maxSockets: number;
  maxFreeSockets: number;
  keepAlive: boolean;
  options: any;
  sockets = {};
  freeSockets = {};
  requests = {};
  defaultPort = 80;
  protocol = 'http:';
  constructor(opts: any = {}) {
    super();
    this.options = opts;
    this.maxSockets = opts.maxSockets ?? Infinity;
    this.maxFreeSockets = opts.maxFreeSockets ?? 256;
    this.keepAlive = !!opts.keepAlive;
  }
  destroy() {}
  getName(o: any = {}) {
    return `${o.host ?? 'localhost'}:${o.port ?? ''}:${o.localAddress ?? ''}`;
  }
  createConnection() {
    return new Socket();
  }
}
export const globalAgent = new Agent();

export class ClientRequest extends OutgoingMessage {
  method: string;
  path: string;
  host: string;
  protocol: string;
  aborted = false;
  reusedSocket = false;
  maxHeadersCount: number | null = null;
  private chunks: Buffer[] = [];
  private url: URL;
  private ctrl = new AbortController();
  private handle = new Handle();
  res: IncomingMessage | null = null;

  constructor(url: URL, opts: any, cb?: (res: IncomingMessage) => void) {
    super();
    this.url = url;
    this.method = String(opts.method ?? 'GET').toUpperCase();
    this.path = url.pathname + url.search;
    this.host = url.hostname;
    this.protocol = url.protocol;
    if (cb) this.once('response', cb);
    const headers = opts.headers;
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]);
    } else if (headers) for (const k of Object.keys(headers)) if (headers[k] !== undefined) this.setHeader(k, headers[k]);
    if (opts.auth && !this.hasHeader('authorization')) this.setHeader('Authorization', 'Basic ' + btoa(opts.auth));
    if (opts.signal) opts.signal.addEventListener('abort', () => this.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })));
    if (opts.timeout) this.setTimeout(opts.timeout);
    this.socket = new Socket();
    this.connection = this.socket;
    this.handle.activate();
    nextTick(() => this.emit('socket', this.socket));
  }

  _write(chunk: any, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : Buffer.from(chunk));
    cb();
  }

  _final(cb: (e?: Error | null) => void) {
    this.headersSent = true;
    cb();
    this._send();
  }

  private async _send() {
    const body = this.chunks.length ? Buffer.concat(this.chunks) : null;
    const headers = this._headerPairs();
    try {
      let res: Response;
      if (isLoopbackHost(this.url.hostname)) {
        const port = Number(this.url.port || (this.url.protocol === 'https:' ? 443 : 80));
        if (!virtualPortExists(port)) throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '127.0.0.1', port });
        res = await loopbackFetch(this.url, this.method, headers, body, this.ctrl.signal);
      } else {
        res = await proxyFetch(this.url.href, { method: this.method, headers, body, signal: this.ctrl.signal, redirect: 'follow' });
      }
      const msg = new IncomingMessage(this.socket!);
      msg.statusCode = res.status;
      msg.statusMessage = res.statusText || STATUS_CODES[res.status] || '';
      msg.url = '';
      msg._setHeaders([...res.headers]);
      this.res = msg;
      this.emit('response', msg);
      if (!res.body) {
        msg.complete = true;
        msg.push(null);
        this.handle.deactivate();
        this.emit('close');
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        msg.push(Buffer.from(value));
      }
      msg.complete = true;
      msg.push(null);
      this.handle.deactivate();
      msg.once('end', () => this.emit('close'));
    } catch (e: any) {
      this.handle.deactivate();
      if (this.aborted) return;
      const err = e?.cause && e.message === 'fetch failed' ? Object.assign(new Error(e.cause.message), { code: e.cause.code ?? 'ECONNREFUSED' }) : e;
      this.emit('error', err);
      this.emit('close');
    }
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.ctrl.abort();
    this.handle.deactivate();
    nextTick(() => {
      this.emit('abort');
      this.emit('close');
    });
  }

  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.ctrl.abort();
    this.handle.deactivate();
    cb(err);
  }

  setNoDelay() {}
  setSocketKeepAlive() {}
  setTimeout(ms: number, cb?: () => void) {
    if (cb) this.once('timeout', cb);
    if (ms > 0) {
      const t = setTimeout(() => this.emit('timeout'), ms);
      this.once('response', () => clearTimeout(t));
      this.once('error', () => clearTimeout(t));
    }
    return this;
  }
}

function makeRequest(defaultProtocol: string) {
  return function request(urlOrOpts: any, optsOrCb?: any, cb?: any): ClientRequest {
    let url: URL;
    let opts: any;
    if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
      url = new URL(String(urlOrOpts));
      if (typeof optsOrCb === 'function') {
        cb = optsOrCb;
        opts = {};
      } else opts = optsOrCb ?? {};
    } else {
      opts = urlOrOpts ?? {};
      cb = optsOrCb;
      const protocol = opts.protocol ?? defaultProtocol;
      const host = opts.hostname ?? (opts.host ? String(opts.host).replace(/:\d+$/, '') : 'localhost');
      const port = opts.port ?? (opts.host && /:\d+$/.test(opts.host) ? opts.host.split(':').pop() : '');
      url = new URL(`${protocol}//${host.includes(':') ? `[${host}]` : host}${port ? `:${port}` : ''}${opts.path ?? '/'}`);
    }
    if (opts.method === undefined && typeof urlOrOpts === 'object' && !(urlOrOpts instanceof URL)) opts.method = urlOrOpts.method;
    return new ClientRequest(url, opts, cb);
  };
}

export const request = makeRequest('http:');
export function get(...args: any[]) {
  const req = (request as any)(...args);
  req.end();
  return req;
}

export function setMaxIdleHTTPParsers() {}
export const WebSocket = globalThis.WebSocket;
export const CloseEvent = (globalThis as any).CloseEvent;
export const MessageEvent = globalThis.MessageEvent;

const httpModule = { METHODS, STATUS_CODES, maxHeaderSize, validateHeaderName, validateHeaderValue, IncomingMessage, OutgoingMessage, ServerResponse, Server, createServer, Agent, globalAgent, ClientRequest, request, get, setMaxIdleHTTPParsers, WebSocket, CloseEvent, MessageEvent };
export default httpModule;

// https shares everything except the default protocol and agent
const httpsRequest = makeRequest('https:');
class HttpsAgent extends Agent {
  defaultPort = 443;
  protocol = 'https:';
}
export const https = {
  ...httpModule,
  Agent: HttpsAgent,
  globalAgent: new HttpsAgent(),
  request: httpsRequest,
  get(...args: any[]) {
    const req = (httpsRequest as any)(...args);
    req.end();
    return req;
  },
  createServer: (opts?: any, listener?: any) => new Server(opts, listener),
  Server,
};
