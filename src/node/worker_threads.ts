// node:worker_threads

import { EventEmitter } from './events.ts';
import { Handle, nextTick } from './loop.ts';
import { post, sys } from './sys.ts';

// -----------------------------------------------------------------------------
// A shared ring buffer that mirrors messages so `receiveMessageOnPort` can read
// them synchronously. Values are encoded with a small structured serializer;
// messages it cannot encode are only delivered asynchronously.

const RING_BYTES = 8 * 1024 * 1024;

class Ring {
  ctl: Int32Array; // [0]=write offset, [1]=read offset, [2]=wrap marker
  data: Uint8Array;
  constructor(public sab: SharedArrayBuffer) {
    this.ctl = new Int32Array(sab, 0, 4);
    this.data = new Uint8Array(sab, 16);
  }
  static create() {
    return new Ring(new SharedArrayBuffer(RING_BYTES + 16));
  }
  /** Appends [len][seq][payload]; returns false if it does not fit. */
  push(seq: number, payload: Uint8Array): boolean {
    const need = 8 + payload.length;
    const cap = this.data.length;
    let w = Atomics.load(this.ctl, 0);
    const r = Atomics.load(this.ctl, 1);
    const used = w >= r ? w - r : cap - r + w;
    if (used + need + 8 >= cap) return false;
    if (w + need > cap) {
      // wrap: write a zero-length marker
      if (r > 0 && r <= need) return false;
      new DataView(this.data.buffer, this.data.byteOffset).setUint32(w, 0xffffffff, true);
      w = 0;
    }
    const dv = new DataView(this.data.buffer, this.data.byteOffset);
    dv.setUint32(w, payload.length, true);
    dv.setUint32(w + 4, seq, true);
    this.data.set(payload, w + 8);
    Atomics.store(this.ctl, 0, w + need);
    return true;
  }
  peekSeq(): number | null {
    let r = Atomics.load(this.ctl, 1);
    const w = Atomics.load(this.ctl, 0);
    if (r === w) return null;
    const dv = new DataView(this.data.buffer, this.data.byteOffset);
    if (dv.getUint32(r, true) === 0xffffffff) {
      r = 0;
      if (r === w) return null;
    }
    return dv.getUint32(r + 4, true);
  }
  shift(): { seq: number; payload: Uint8Array } | null {
    let r = Atomics.load(this.ctl, 1);
    const w = Atomics.load(this.ctl, 0);
    if (r === w) return null;
    const dv = new DataView(this.data.buffer, this.data.byteOffset);
    let len = dv.getUint32(r, true);
    if (len === 0xffffffff) {
      r = 0;
      if (r === w) {
        Atomics.store(this.ctl, 1, 0);
        return null;
      }
      len = dv.getUint32(r, true);
    }
    const seq = dv.getUint32(r + 4, true);
    const payload = this.data.slice(r + 8, r + 8 + len);
    Atomics.store(this.ctl, 1, r + 8 + len);
    return { seq, payload };
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encodes plain data (objects, arrays, primitives, typed arrays, ArrayBuffer, Date, Map, Set). */
function serialize(value: unknown): Uint8Array | null {
  const bins: Uint8Array[] = [];
  let ok = true;
  const walk = (v: any, depth: number): any => {
    if (!ok || depth > 64) {
      ok = false;
      return null;
    }
    if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      if (typeof v === 'number' && !Number.isFinite(v)) return { $n: String(v) };
      return v;
    }
    if (v === undefined) return { $u: 1 };
    if (typeof v === 'bigint') return { $bi: v.toString() };
    if (v instanceof Uint8Array && !(v.buffer instanceof SharedArrayBuffer)) {
      bins.push(v);
      return { $b: bins.length - 1, t: v.constructor.name };
    }
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof SharedArrayBuffer) {
        ok = false;
        return null;
      }
      bins.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      return { $b: bins.length - 1, t: v.constructor.name };
    }
    if (v instanceof ArrayBuffer) {
      bins.push(new Uint8Array(v));
      return { $b: bins.length - 1, t: 'ArrayBuffer' };
    }
    if (v instanceof Date) return { $d: v.getTime() };
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Map) return { $m: [...v].map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]) };
    if (v instanceof Set) return { $s: [...v].map((x) => walk(x, depth + 1)) };
    if (v instanceof Error) return { $e: { name: v.name, message: v.message, stack: v.stack } };
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        ok = false;
        return null;
      }
      const o: any = {};
      for (const k of Object.keys(v)) {
        const x = walk(v[k], depth + 1);
        o[k.startsWith('$') ? '$$' + k : k] = x;
      }
      return o;
    }
    ok = false;
    return null;
  };
  const tree = walk(value, 0);
  if (!ok) return null;
  const json = enc.encode(JSON.stringify(tree));
  let total = 4 + json.length + 4;
  for (const b of bins) total += 4 + b.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, json.length, true);
  out.set(json, 4);
  let off = 4 + json.length;
  dv.setUint32(off, bins.length, true);
  off += 4;
  for (const b of bins) {
    dv.setUint32(off, b.length, true);
    out.set(b, off + 4);
    off += 4 + b.length;
  }
  return out;
}

function deserialize(data: Uint8Array): unknown {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const jl = dv.getUint32(0, true);
  const tree = JSON.parse(dec.decode(data.subarray(4, 4 + jl)));
  let off = 4 + jl;
  const n = dv.getUint32(off, true);
  off += 4;
  const bins: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const l = dv.getUint32(off, true);
    bins.push(data.slice(off + 4, off + 4 + l));
    off += 4 + l;
  }
  const ctors: Record<string, any> = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray, BigInt64Array, BigUint64Array, DataView };
  const back = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(back);
    if ('$u' in v) return undefined;
    if ('$n' in v) return Number(v.$n);
    if ('$bi' in v) return BigInt(v.$bi);
    if ('$d' in v) return new Date(v.$d);
    if ('$m' in v) return new Map(v.$m.map(([k, x]: any) => [back(k), back(x)]));
    if ('$s' in v) return new Set(v.$s.map(back));
    if ('$e' in v) return Object.assign(new Error(v.$e.message), v.$e);
    if ('$b' in v) {
      const b = bins[v.$b];
      if (v.t === 'ArrayBuffer') return b.buffer;
      if (v.t === 'Buffer') return (globalThis as any).Buffer.from(b);
      const C = ctors[v.t] ?? Uint8Array;
      return C === DataView ? new DataView(b.buffer) : new C(b.buffer, 0, b.byteLength / (C.BYTES_PER_ELEMENT ?? 1));
    }
    const o: any = {};
    for (const k of Object.keys(v)) o[k.startsWith('$$') ? k.slice(2) : k] = back(v[k]);
    return o;
  };
  return back(tree);
}

// -----------------------------------------------------------------------------
// MessagePort wrapper with Node semantics (EventEmitter, value instead of event).

const kNative = Symbol('native');
const nativeToWrapper = new WeakMap<globalThis.MessagePort, NodeMessagePort>();

interface Envelope {
  k: 'm' | 'online' | 'error' | 'exit' | 'ring';
  d?: unknown;
  s?: number;
  code?: number;
  ring?: SharedArrayBuffer;
}

export class NodeMessagePort extends EventEmitter {
  [kNative]: globalThis.MessagePort;
  private handle = new Handle();
  private started = false;
  /** Ring we write into (mirror for the peer's receiveMessageOnPort). */
  sendRing: Ring | null = null;
  /** Ring the peer writes into. */
  recvRing: Ring | null = null;
  private seq = 1;
  private consumed = new Set<number>();
  private queued: Envelope[] = [];
  onControl?: (env: Envelope) => void;
  closed = false;

  constructor(native: globalThis.MessagePort) {
    super();
    this[kNative] = native;
    nativeToWrapper.set(native, this);
    native.onmessage = (ev) => this._receive(ev.data as Envelope);
    native.onmessageerror = (ev) => this.emit('messageerror', ev.data);
    this.on('newListener', (ev: string) => {
      if (ev === 'message' && !this.started) this.start();
    });
    this.on('removeListener', (ev: string) => {
      if (ev === 'message' && this.listenerCount('message') === 0) this.handle.deactivate();
    });
  }

  private _receive(env: Envelope) {
    if (!env || typeof env !== 'object' || !('k' in env)) {
      // raw message from a non-wrapped sender
      this._dispatch({ k: 'm', d: env });
      return;
    }
    if (env.k === 'ring') {
      this.recvRing = new Ring(env.ring!);
      return;
    }
    if (env.k !== 'm') {
      this.onControl?.(env);
      return;
    }
    if (env.s !== undefined && this.consumed.has(env.s)) {
      this.consumed.delete(env.s);
      return;
    }
    if (env.s !== undefined && this.recvRing) {
      // drop the mirrored copy
      this.dropMirrored(env.s);
    }
    this._dispatch(env);
  }

  private dropMirrored(seq: number) {
    // the ring is FIFO and in the same order as async delivery
    const ring = this.recvRing!;
    for (;;) {
      const head = ring.peekSeq();
      if (head === null || head > seq) break;
      ring.shift();
    }
  }

  private _dispatch(env: Envelope) {
    if (!this.started) {
      this.queued.push(env);
      return;
    }
    this.emit('message', rewrap(env.d));
  }

  start() {
    this.started = true;
    this[kNative].start();
    if (this.listenerCount('message') > 0) this.handle.activate();
    const q = this.queued;
    this.queued = [];
    for (const e of q) this.emit('message', rewrap(e.d));
  }

  /** Enables the shared-ring mirror for this direction. */
  enableSync() {
    if (this.sendRing) return;
    this.sendRing = Ring.create();
    this[kNative].postMessage({ k: 'ring', ring: this.sendRing.sab } satisfies Envelope);
  }

  postMessage(value: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }) {
    if (this.closed) return;
    const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
    const natives = list.map((t: any) => (t instanceof NodeMessagePort ? t[kNative] : t));
    const s = this.seq++;
    if (this.sendRing) {
      const bytes = natives.length ? null : serialize(value);
      if (bytes) this.sendRing.push(s, bytes);
    }
    this[kNative].postMessage({ k: 'm', d: unwrap(value), s } satisfies Envelope, natives);
  }

  _postControl(env: Envelope) {
    this[kNative].postMessage(env);
  }

  /** Synchronous receive for receiveMessageOnPort. */
  _receiveSync(): { message: unknown } | undefined {
    if (this.queued.length) {
      const e = this.queued.shift()!;
      return { message: rewrap(e.d) };
    }
    const ring = this.recvRing;
    if (!ring) return undefined;
    const item = ring.shift();
    if (!item) return undefined;
    this.consumed.add(item.seq);
    return { message: deserialize(item.payload) };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.handle.deactivate();
    this[kNative].close();
    nextTick(() => this.emit('close'));
  }
  ref() {
    this.handle.ref();
    return this;
  }
  unref() {
    this.handle.unref();
    return this;
  }
  hasRef() {
    return this.handle.hasRef();
  }
  // DOM-style compatibility
  addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
    this.on(type, (data: unknown) => fn({ data }));
  }
  removeEventListener() {}
  set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
    this.removeAllListeners('message');
    if (fn) this.on('message', (data: unknown) => fn({ data }));
  }
}

function unwrap(v: any, depth = 0): any {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (v instanceof NodeMessagePort) return v[kNative];
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) return v;
  if (v instanceof WebAssembly.Memory || v instanceof WebAssembly.Module) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = unwrap(x, depth + 1);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  let changed = false;
  const out: any = {};
  for (const k of Object.keys(v)) {
    const y = unwrap(v[k], depth + 1);
    if (y !== v[k]) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

export function rewrap(v: any, depth = 0): any {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (typeof MessagePort !== 'undefined' && v instanceof globalThis.MessagePort) return nativeToWrapper.get(v as any) ?? new NodeMessagePort(v as any);
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) return v;
  if (v instanceof WebAssembly.Memory || v instanceof WebAssembly.Module) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = rewrap(v[i], depth + 1);
    return v;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  for (const k of Object.keys(v)) v[k] = rewrap(v[k], depth + 1);
  return v;
}

export class MessageChannel {
  port1: NodeMessagePort;
  port2: NodeMessagePort;
  constructor() {
    const ch = new globalThis.MessageChannel();
    this.port1 = new NodeMessagePort(ch.port1);
    this.port2 = new NodeMessagePort(ch.port2);
    // explicit channels mirror messages so receiveMessageOnPort works on either side
    this.port1.enableSync();
    this.port2.enableSync();
  }
}

export const MessagePort = NodeMessagePort;

export function receiveMessageOnPort(port: NodeMessagePort): { message: unknown } | undefined {
  if (!(port instanceof NodeMessagePort)) {
    const e = new TypeError('The "port" argument must be a MessagePort instance') as TypeError & { code: string };
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  return port._receiveSync();
}

// -----------------------------------------------------------------------------
// thread state

export let isMainThread = true;
export let parentPort: NodeMessagePort | null = null;
export let workerData: unknown = null;
export let threadId = 0;
export let resourceLimits = {};
export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
const envData = new Map<unknown, unknown>();

export function initThread(info: { isMain: boolean; tid: number; parentPort?: globalThis.MessagePort; workerData?: unknown; envData?: [unknown, unknown][] }) {
  isMainThread = info.isMain;
  threadId = info.isMain ? 0 : info.tid;
  if (info.parentPort) {
    parentPort = new NodeMessagePort(info.parentPort);
    // parentPort does not keep the thread alive by itself unless listened to
  }
  workerData = rewrap(info.workerData ?? null);
  for (const [k, v] of info.envData ?? []) envData.set(k, v);
}

export function getEnvironmentData(k: unknown) {
  return envData.get(k);
}
export function setEnvironmentData(k: unknown, v: unknown) {
  if (v === undefined) envData.delete(k);
  else envData.set(k, v);
}
export function markAsUntransferable(_o: unknown) {}
export function isMarkedAsUntransferable(_o: unknown) {
  return false;
}
export function markAsUncloneable(_o: unknown) {}
export function moveMessagePortToContext(p: unknown) {
  return p;
}
export const BroadcastChannel = globalThis.BroadcastChannel;

let nextReq = 1;

export class Worker extends EventEmitter {
  threadId = -1;
  private port: NodeMessagePort;
  private handle = new Handle();
  private exited = false;
  private exitWaiters: ((c: number) => void)[] = [];
  resourceLimits = {};
  stdin: any = null;
  stdout: any;
  stderr: any;
  performance = { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };

  constructor(filename: string | URL, opts: any = {}) {
    super();
    const ch = new globalThis.MessageChannel();
    this.port = new NodeMessagePort(ch.port1);
    this.port.onControl = (env) => this._control(env);
    this.port.on('message', (m: unknown) => this.emit('message', m));
    let file: string;
    let isEval = !!opts.eval;
    if (filename instanceof URL || (typeof filename === 'string' && filename.startsWith('file:'))) {
      file = decodeURIComponent(new URL(String(filename)).pathname);
    } else if (typeof filename === 'string' && filename.startsWith('data:')) {
      isEval = true;
      const comma = filename.indexOf(',');
      const meta = filename.slice(5, comma);
      const body = filename.slice(comma + 1);
      file = meta.includes('base64') ? atob(body) : decodeURIComponent(body);
      opts = { ...opts, type: 'module' };
    } else {
      file = String(filename);
      if (!isEval && !file.startsWith('/')) {
        if (!file.startsWith('./') && !file.startsWith('../')) {
          const e = new TypeError(`The worker script or module filename must be an absolute path or a relative path starting with './' or '../'. Received "${file}"`) as TypeError & { code: string };
          e.code = 'ERR_WORKER_PATH';
          throw e;
        }
        file = (globalThis as any).process.cwd() + '/' + file;
      }
    }
    const transfer: Transferable[] = [ch.port2, ...((opts.transferList ?? []) as any[]).map((t: any) => (t instanceof NodeMessagePort ? (t as any)[kNative] : t))];
    const env = opts.env === SHARE_ENV || opts.env === undefined ? { ...(globalThis as any).process.env } : Object.fromEntries(Object.entries(opts.env).map(([k, v]) => [k, String(v)]));
    const reqId = nextReq++;
    this.threadId = sys<number>('threadReserve', {});
    post(
      {
        t: 'threadSpawn',
        reqId,
        tid: this.threadId,
        file,
        eval: isEval,
        evalType: opts.type,
        argv: (opts.argv ?? []).map(String),
        execArgv: opts.execArgv ?? (globalThis as any).process.execArgv,
        env,
        workerData: unwrap(opts.workerData),
        envData: [...envData],
        port: ch.port2,
        name: opts.name,
      },
      transfer,
    );
    this.handle.activate();
    // Node pipes worker stdout/stderr into the parent's by default
    this.stdout = { on() {}, pipe() {}, setEncoding() {}, resume() {} };
    this.stderr = this.stdout;
    this.port.start();
  }

  private _control(env: Envelope) {
    switch (env.k) {
      case 'online':
        this.emit('online');
        break;
      case 'error': {
        const e = env.d as any;
        const err = e && typeof e === 'object' && 'message' in e ? Object.assign(new Error(e.message), e) : e;
        this.emit('error', err);
        break;
      }
      case 'exit':
        this._exit(env.code ?? 0);
        break;
    }
  }

  _exit(code: number) {
    if (this.exited) return;
    this.exited = true;
    this.handle.deactivate();
    this.port.close();
    this.emit('exit', code);
    for (const w of this.exitWaiters) w(code);
  }

  postMessage(value: unknown, transfer?: any) {
    this.port.postMessage(value, transfer);
  }

  terminate(cb?: (e: Error | null, code: number) => void): Promise<number> {
    if (this.exited) {
      cb?.(null, 1);
      return Promise.resolve(1);
    }
    const p = new Promise<number>((r) => this.exitWaiters.push(r));
    post({ t: 'threadKill', tid: this.threadId });
    setTimeout(() => this._exit(1), 50);
    if (cb) p.then((c) => cb(null, c));
    return p;
  }

  ref() {
    this.handle.ref();
  }
  unref() {
    this.handle.unref();
  }
  getHeapSnapshot() {
    return Promise.reject(new Error('not supported'));
  }
}

export function postMessageToThread() {
  return Promise.reject(new Error('postMessageToThread is not supported'));
}

export default {
  isMainThread: undefined as unknown,
  parentPort: undefined as unknown,
  workerData: undefined as unknown,
  threadId: undefined as unknown,
  resourceLimits,
  SHARE_ENV,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  receiveMessageOnPort,
  getEnvironmentData,
  setEnvironmentData,
  markAsUntransferable,
  isMarkedAsUntransferable,
  markAsUncloneable,
  moveMessagePortToContext,
  postMessageToThread,
};
