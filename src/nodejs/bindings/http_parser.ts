// internalBinding('http_parser') — node_http_parser.cc in JS, over a port of llhttp (./http/llhttp.ts).

import { fromShape } from './shape.ts';
import { asBuffer, latin1 } from './buffer.ts';
import { S as State } from '../state.ts';
import { LLHTTP, Span, Err, ERRNO_NAMES, TYPE_REQUEST, TYPE_RESPONSE, type Settings } from './http/llhttp.ts';

// Captured before Node's bootstrap replaces the web globals with lib implementations.
const nativePerformance = globalThis.performance;
const perfNow = nativePerformance.now.bind(nativePerformance);
const timeOrigin = nativePerformance.timeOrigin;
const NativeError = Error;

const kOnMessageBegin = 0;
const kOnHeaders = 1;
const kOnHeadersComplete = 2;
const kOnBody = 3;
const kOnMessageComplete = 4;
const kOnExecute = 5;
const kOnTimeout = 6;
const kMaxHeaderFieldsCount = 32;
const kMaxChunkExtensionsSize = 16384;

/** uv_hrtime() stand-in (milliseconds, never 0, large like the real thing). */
function hrtime(): number {
  return timeOrigin + perfNow();
}

function defaultMaxHeaderSize(): number {
  try {
    const v = State.requireBuiltin?.('internal/options').getOptionValue('--max-http-header-size');
    if (typeof v === 'number' && v > 0) return v;
  } catch {}
  return 16384;
}

/** IntegerValue() + static_cast<int>, as on_headers_complete reads the JS return value. */
function toInt(v: unknown): number {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  if (!Number.isFinite(n)) return -1;
  return Math.trunc(n) | 0;
}

const IS_OWS = (c: number) => c === 32 || c === 9;

/** A header string being assembled from llhttp spans (StringPtr). Bytes are kept as latin1 text. */
function trimOWS(s: string): string {
  let e = s.length;
  while (e > 0 && IS_OWS(s.charCodeAt(e - 1))) e--;
  return e === s.length ? s : s.slice(0, e);
}

let nextAsyncId = 1;

class ParserImpl implements Settings {
  readonly owner: any;
  llhttp = new LLHTTP(TYPE_REQUEST, this);
  fields: string[] = [];
  values: string[] = [];
  url = '';
  statusMessage = '';
  numFields = 0;
  numValues = 0;
  haveFlushed = false;
  gotException = false;
  exception: unknown = undefined;
  hasException = false;
  currentBuffer: Uint8Array | null = null;
  headersCompleted = false;
  headerNread = 0;
  chunkExtensionsNread = 0;
  maxHeaderSize = 16384;
  lastMessageStart = 0;
  connections: ConnectionsListImpl | null = null;
  closed = false;
  asyncId = 0;
  providerType = 0;

  constructor(owner: any) {
    this.owner = owner;
  }

  /** Calls parser[index](...args) if it is a function; records an exception like V8 would. */
  private call(index: number, args: unknown[]): { ok: boolean; value?: unknown; called: boolean } {
    const cb = this.owner[index];
    if (typeof cb !== 'function') return { ok: true, called: false };
    try {
      const value = cb.apply(this.owner, args);
      // A JS call that completes clears an exception left pending by an earlier callback (V8
      // behaviour observable in Node: a throwing kOnHeaders is swallowed once parsing goes on).
      this.hasException = false;
      this.exception = undefined;
      return { ok: true, value, called: true };
    } catch (e) {
      this.hasException = true;
      this.exception = e;
      return { ok: false, called: true };
    }
  }

  private trackHeader(len: number): number {
    this.headerNread += len;
    if (this.headerNread >= this.maxHeaderSize) {
      this.llhttp.reason = 'HPE_HEADER_OVERFLOW:Header overflow';
      return Err.USER;
    }
    return 0;
  }

  private createHeaders(): string[] {
    const out: string[] = new Array(this.numValues * 2);
    for (let i = 0; i < this.numValues; i++) {
      out[i * 2] = this.fields[i];
      out[i * 2 + 1] = trimOWS(this.values[i]);
    }
    return out;
  }

  /** Spills headers and the url to JS (kOnHeaders). */
  private flush() {
    if (typeof this.owner[kOnHeaders] !== 'function') return;
    const r = this.call(kOnHeaders, [this.createHeaders(), this.url]);
    if (!r.ok) this.gotException = true;
    this.url = '';
    this.haveFlushed = true;
  }

  // --- llhttp settings -------------------------------------------------------

  onMessageBegin(): number {
    if (this.connections) {
      this.connections.all.delete(this);
      this.connections.active.delete(this);
    }
    this.numFields = this.numValues = 0;
    this.headersCompleted = false;
    this.chunkExtensionsNread = 0;
    this.lastMessageStart = hrtime();
    this.url = '';
    this.statusMessage = '';
    if (this.connections) {
      this.connections.all.add(this);
      this.connections.active.add(this);
    }
    // An exception here is reported once execute() returns; parsing goes on (as in C++).
    this.call(kOnMessageBegin, []);
    return 0;
  }

  onSpan(kind: Span, data: Uint8Array, start: number, end: number): number {
    const len = end - start;
    switch (kind) {
      case Span.URL: {
        const rv = this.trackHeader(len);
        if (rv !== 0) return rv;
        this.url += latin1(data, start, end);
        return 0;
      }
      case Span.STATUS: {
        const rv = this.trackHeader(len);
        if (rv !== 0) return rv;
        this.statusMessage += latin1(data, start, end);
        return 0;
      }
      case Span.HEADER_FIELD: {
        const rv = this.trackHeader(len);
        if (rv !== 0) return rv;
        if (this.numFields === this.numValues) {
          // start of a new field name
          this.numFields++;
          if (this.numFields === kMaxHeaderFieldsCount) {
            // out of space: flush to JS land
            this.flush();
            this.numFields = 1;
            this.numValues = 0;
          }
          this.fields[this.numFields - 1] = '';
        }
        this.fields[this.numFields - 1] += latin1(data, start, end);
        return 0;
      }
      case Span.HEADER_VALUE: {
        const rv = this.trackHeader(len);
        if (rv !== 0) return rv;
        if (this.numValues !== this.numFields) {
          // start of a new header value
          this.numValues++;
          this.values[this.numValues - 1] = '';
        }
        this.values[this.numValues - 1] += latin1(data, start, end);
        return 0;
      }
      case Span.CHUNK_EXT_NAME:
      case Span.CHUNK_EXT_VALUE:
        this.chunkExtensionsNread += len;
        if (this.chunkExtensionsNread > kMaxChunkExtensionsSize) {
          this.llhttp.reason = 'HPE_CHUNK_EXTENSIONS_OVERFLOW:Chunk extensions overflow';
          return Err.USER;
        }
        return 0;
      case Span.BODY: {
        if (len === 0) return 0;
        if (typeof this.owner[kOnBody] !== 'function') return 0;
        const r = this.call(kOnBody, [asBuffer(data.slice(start, end))]);
        if (!r.ok) {
          this.gotException = true;
          this.llhttp.reason = 'HPE_JS_EXCEPTION:JS Exception';
          return Err.USER;
        }
        return 0;
      }
    }
    return 0;
  }

  onHeadersComplete(): number {
    this.headersCompleted = true;
    this.headerNread = 0;
    if (typeof this.owner[kOnHeadersComplete] !== 'function') return 0;

    const p = this.llhttp;
    let headers: string[] | undefined;
    let url: string | undefined;
    if (this.haveFlushed) {
      // slow case: flush the remaining headers
      this.flush();
    } else {
      // fast case: pass headers and url to JS land
      headers = this.createHeaders();
      if (p.type === TYPE_REQUEST) url = this.url;
    }
    this.numFields = 0;
    this.numValues = 0;

    const method = p.type === TYPE_REQUEST ? p.method : undefined;
    const statusCode = p.type === TYPE_RESPONSE ? p.status_code : undefined;
    const statusMessage = p.type === TYPE_RESPONSE ? this.statusMessage : undefined;
    const r = this.call(kOnHeadersComplete, [p.http_major, p.http_minor, headers, method, url, statusCode, statusMessage, p.upgrade !== 0, p.shouldKeepAlive()]);
    if (!r.ok) {
      this.gotException = true;
      return -1;
    }
    try {
      return toInt(r.value);
    } catch (e) {
      // e.g. a Symbol: IntegerValue() throws
      if (!this.hasException) {
        this.hasException = true;
        this.exception = e;
      }
      this.gotException = true;
      return -1;
    }
  }

  onMessageComplete(): number {
    if (this.connections) {
      this.connections.all.delete(this);
      this.connections.active.delete(this);
    }
    this.lastMessageStart = 0;
    if (this.connections) this.connections.all.add(this);

    if (this.numFields) this.flush(); // trailing headers

    if (typeof this.owner[kOnMessageComplete] !== 'function') return 0;
    const r = this.call(kOnMessageComplete, []);
    if (!r.ok) {
      this.gotException = true;
      return -1;
    }
    return 0;
  }

  onChunkHeader(): number {
    this.headerNread = 0;
    this.chunkExtensionsNread = 0;
    return 0;
  }

  onChunkComplete(): number {
    this.headerNread = 0;
    return 0;
  }

  // --- execute ---------------------------------------------------------------

  init(type: number, maxHeaderSize: number, lenientFlags: number) {
    this.llhttp.init(type);
    this.llhttp.lenient_flags = lenientFlags & 0x3ff;
    this.headerNread = 0;
    this.url = '';
    this.statusMessage = '';
    this.numFields = 0;
    this.numValues = 0;
    this.haveFlushed = false;
    this.gotException = false;
    this.headersCompleted = false;
    this.maxHeaderSize = maxHeaderSize;
  }

  execute(data: Uint8Array | null): unknown {
    const p = this.llhttp;
    const len = data ? data.length : 0;
    this.currentBuffer = data;
    this.gotException = false;
    this.hasException = false;
    this.exception = undefined;

    const lingering = p.error !== 0;
    let err: number;
    if (data === null) err = p.finishInput();
    else err = p.execute(data, 0, len);

    let nread = len;
    if (err !== Err.OK) {
      // A lingering error (or one from finish()) has no position in this buffer.
      nread = data === null || lingering ? 0 : p.error_pos;
      // Not a real pause, just a way to stop parsing early.
      if (err === Err.PAUSED_UPGRADE) {
        err = Err.OK;
        p.resumeAfterUpgrade();
      }
    }
    this.currentBuffer = null;

    if (this.hasException) {
      const e = this.exception;
      this.exception = undefined;
      this.hasException = false;
      throw e;
    }
    if (this.gotException) return undefined;

    if (!p.upgrade && err !== Err.OK) {
      const e = new NativeError('Parse Error') as Error & Record<string, unknown>;
      e.bytesParsed = nread;
      let code: string;
      let reason: string;
      const errnoReason = p.reason;
      if (err === Err.USER) {
        const colon = errnoReason.indexOf(':');
        code = errnoReason.slice(0, colon);
        reason = errnoReason.slice(colon + 1);
      } else {
        code = ERRNO_NAMES[err] ?? 'HPE_INTERNAL';
        reason = errnoReason;
      }
      e.code = code;
      e.reason = reason;
      return e;
    }
    if (data === null) return undefined;
    return nread;
  }
}

const impls = new WeakMap<object, ParserImpl>();

function implOf(self: object): ParserImpl | undefined {
  const impl = impls.get(self);
  return impl && !impl.closed ? impl : undefined;
}

function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('The "buffer" argument must be an ArrayBufferView');
}

/** AsyncWrap.prototype (HTTPParser inherits it in C++). */
class AsyncWrap {
  getAsyncId() {
    return implOf(this)?.asyncId ?? -1;
  }

  getProviderType() {
    return implOf(this)?.providerType ?? 0;
  }

  asyncReset() {
    const impl = implOf(this);
    if (impl) impl.asyncId = nextAsyncId++;
  }
}

class HTTPParser extends AsyncWrap {
  static REQUEST = TYPE_REQUEST;
  static RESPONSE = TYPE_RESPONSE;
  static kOnMessageBegin = kOnMessageBegin;
  static kOnHeaders = kOnHeaders;
  static kOnHeadersComplete = kOnHeadersComplete;
  static kOnBody = kOnBody;
  static kOnMessageComplete = kOnMessageComplete;
  static kOnExecute = kOnExecute;
  static kOnTimeout = kOnTimeout;
  static kLenientNone = 0;
  static kLenientHeaders = 1 << 0;
  static kLenientChunkedLength = 1 << 1;
  static kLenientKeepAlive = 1 << 2;
  static kLenientTransferEncoding = 1 << 3;
  static kLenientVersion = 1 << 4;
  static kLenientDataAfterClose = 1 << 5;
  static kLenientOptionalLFAfterCR = 1 << 6;
  static kLenientOptionalCRLFAfterChunk = 1 << 7;
  static kLenientOptionalCRBeforeLF = 1 << 8;
  static kLenientSpacesAfterChunkSize = 1 << 9;
  static kLenientAll = 1023;

  constructor() {
    super();
    impls.set(this, new ParserImpl(this));
  }

  close() {
    const impl = implOf(this);
    if (!impl) return;
    if (impl.connections) {
      impl.connections.all.delete(impl);
      impl.connections.active.delete(impl);
    }
    impl.closed = true;
  }

  free() {
    // C++ emits the async_hooks destroy event here; nothing to release in JS.
  }

  remove() {
    const impl = implOf(this);
    if (impl?.connections) {
      impl.connections.all.delete(impl);
      impl.connections.active.delete(impl);
    }
  }

  execute(buffer: ArrayBufferView) {
    const impl = implOf(this);
    if (!impl) return undefined;
    return impl.execute(bytesOf(buffer));
  }

  finish() {
    const impl = implOf(this);
    if (!impl) return undefined;
    return impl.execute(null);
  }

  initialize(type: number, resource: object, maxHeaderSize?: number, lenientFlags?: number, connectionsList?: unknown) {
    const impl = implOf(this);
    if (!impl) return;
    if (!Number.isInteger(type) || (type !== TYPE_REQUEST && type !== TYPE_RESPONSE)) throw new TypeError('HTTPParser.initialize: invalid parser type');
    if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) throw new TypeError('HTTPParser.initialize: resource must be an object');
    let max = 0;
    if (arguments.length > 2) {
      if (typeof maxHeaderSize !== 'number') throw new TypeError('HTTPParser.initialize: maxHeaderSize must be a number');
      max = maxHeaderSize > 0 ? Math.trunc(maxHeaderSize) : 0;
    }
    if (max === 0) max = defaultMaxHeaderSize();
    let lenient = 0;
    if (arguments.length > 3) {
      if (!Number.isInteger(lenientFlags)) throw new TypeError('HTTPParser.initialize: lenientFlags must be an int32');
      lenient = lenientFlags as number;
    }
    let list: ConnectionsListImpl | null = null;
    if (arguments.length > 4 && connectionsList !== null && connectionsList !== undefined) {
      list = listImpls.get(connectionsList as object) ?? null;
      if (!list) return; // ASSIGN_OR_RETURN_UNWRAP
    }

    impl.providerType = type === TYPE_REQUEST ? 1 : 2;
    impl.asyncId = nextAsyncId++;
    impl.init(type, max, lenient);

    if (list) {
      impl.connections = list;
      // Counts as a request in progress until the first message arrives (slowloris protection).
      impl.lastMessageStart = hrtime();
      list.all.add(impl);
      list.active.add(impl);
    } else {
      impl.connections = null;
    }
  }

  pause() {
    implOf(this)?.llhttp.pause();
  }

  resume() {
    implOf(this)?.llhttp.resume();
  }

  /**
   * C++ attaches the parser as the stream's listener so that reads bypass JS. Here reads keep
   * flowing through the socket's 'data' events into execute(), which gives the same results.
   */
  consume(_stream: object) {}

  unconsume() {}

  getCurrentBuffer() {
    const impl = implOf(this);
    const cur = impl?.currentBuffer;
    return asBuffer(cur ? cur.slice() : new Uint8Array(0));
  }
}

class ConnectionsListImpl {
  all = new Set<ParserImpl>();
  active = new Set<ParserImpl>();
}

const listImpls = new WeakMap<object, ConnectionsListImpl>();

/** std::set<Parser*, ParserComparator> order: idle parsers first, then by message start. */
function ordered(set: Set<ParserImpl>): ParserImpl[] {
  const idle: ParserImpl[] = [];
  const busy: ParserImpl[] = [];
  for (const p of set) (p.lastMessageStart === 0 ? idle : busy).push(p);
  busy.sort((a, b) => a.lastMessageStart - b.lastMessageStart);
  return idle.concat(busy);
}

function listOf(self: object): ConnectionsListImpl {
  const l = listImpls.get(self);
  if (!l) throw new TypeError('Illegal invocation');
  return l;
}

class ConnectionsList {
  constructor() {
    listImpls.set(this, new ConnectionsListImpl());
  }

  all() {
    return ordered(listOf(this).all).map((p) => p.owner);
  }

  idle() {
    return ordered(listOf(this).all)
      .filter((p) => p.lastMessageStart === 0)
      .map((p) => p.owner);
  }

  active() {
    return ordered(listOf(this).active).map((p) => p.owner);
  }

  expired(headersTimeout: number, requestTimeout: number) {
    const list = listOf(this);
    if (typeof headersTimeout !== 'number' || typeof requestTimeout !== 'number') throw new TypeError('ConnectionsList.expired: timeouts must be numbers');
    // Uint32 milliseconds (the C++ code converts them to nanoseconds; hrtime() here is in ms)
    let ht = headersTimeout >>> 0;
    let rt = requestTimeout >>> 0;
    if (ht === 0 && rt === 0) return [];
    if (rt > 0 && ht > rt) [ht, rt] = [rt, ht];

    const now = hrtime();
    const headersDeadline = ht > 0 && now > ht ? now - ht : 0;
    const requestDeadline = rt > 0 && now > rt ? now - rt : 0;
    if (headersDeadline === 0 && requestDeadline === 0) return [];

    const result: unknown[] = [];
    for (const p of ordered(list.active)) {
      if ((!p.headersCompleted && headersDeadline > 0 && p.lastMessageStart < headersDeadline) || (requestDeadline > 0 && p.lastMessageStart < requestDeadline)) {
        result.push(p.owner);
        list.active.delete(p);
      }
    }
    return result;
  }
}

export function createHttpParser() {
  const b = fromShape('http_parser');
  return Object.assign(b, { HTTPParser, ConnectionsList });
}
