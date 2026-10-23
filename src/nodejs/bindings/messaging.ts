// internalBinding('messaging') — node_messaging.cc. A MessagePort here is a JS object wrapping a
// browser MessagePort (or BroadcastChannel); Node's lib reshapes its prototype chain onto
// NodeEventTarget, so delivery goes through the per-context emitMessage like the C++ does.

import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { fromShape } from './shape.ts';
import { NativeBlob, NativeBroadcastChannel, NativeMessageChannel, NativeMessagePort, nativeStructuredClone } from '../web.ts';

const kNative = Symbol('native');
const kToken = Symbol('construct');
const CLOSE = '__ovMessagePortClosed';
/** Envelope key: messages between our ports carry a sequence number and the rings of moved ports. */
const ENV = '__ovMsg';

// -----------------------------------------------------------------------------
// receiveMessageOnPort: every message on a MessageChannel's ports is also written, serialized with
// v8.serialize, to a shared-memory ring for its direction, so the receiving side can take it
// synchronously. A message that can't be serialized (ports, functions…) leaves a gap record and
// is only delivered the normal way.

const RING_SIZE = 1 << 20; // power of two
const GAP = 0xffffffff;

class Ring {
  readonly head: Int32Array; // [0] write position, [1] read position (wrapping int32)
  readonly data: Uint8Array;
  constructor(readonly sab: SharedArrayBuffer) {
    this.head = new Int32Array(sab, 0, 2);
    this.data = new Uint8Array(sab, 8);
  }
  static create() {
    return new Ring(new SharedArrayBuffer(8 + RING_SIZE));
  }
  #copyIn(pos: number, bytes: Uint8Array) {
    const at = pos & (RING_SIZE - 1);
    const first = Math.min(bytes.length, RING_SIZE - at);
    this.data.set(bytes.subarray(0, first), at);
    if (first < bytes.length) this.data.set(bytes.subarray(first), 0);
  }
  #copyOut(pos: number, len: number) {
    const out = new Uint8Array(len);
    const at = pos & (RING_SIZE - 1);
    const first = Math.min(len, RING_SIZE - at);
    out.set(this.data.subarray(at, at + first));
    if (first < len) out.set(this.data.subarray(0, len - first), first);
    return out;
  }
  /** Appends a record; payload null writes a gap. */
  push(seq: number, payload: Uint8Array | null) {
    const len = payload ? payload.length : 0;
    const head = Atomics.load(this.head, 0);
    const tail = Atomics.load(this.head, 1);
    const need = 8 + len;
    if (RING_SIZE - ((head - tail) | 0) < need + 8) {
      // full: record only the gap, if even that fits
      if (RING_SIZE - ((head - tail) | 0) < 8) return;
      payload = null;
    }
    const hdr = new Uint8Array(8);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, payload ? payload.length : GAP, true);
    dv.setUint32(4, seq, true);
    this.#copyIn(head, hdr);
    if (payload) this.#copyIn((head + 8) | 0, payload);
    Atomics.store(this.head, 0, (head + 8 + (payload ? payload.length : 0)) | 0);
  }
  /** The next record without consuming it. */
  peek(): { seq: number; payload: Uint8Array | null; size: number } | null {
    const head = Atomics.load(this.head, 0);
    const tail = Atomics.load(this.head, 1);
    if (head === tail) return null;
    const dv = new DataView(this.#copyOut(tail, 8).buffer);
    const len = dv.getUint32(0, true);
    const seq = dv.getUint32(4, true);
    if (len === GAP) return { seq, payload: null, size: 8 };
    return { seq, payload: this.#copyOut((tail + 8) | 0, len), size: 8 + len };
  }
  skip(size: number) {
    Atomics.store(this.head, 1, (Atomics.load(this.head, 1) + size) | 0);
  }
}

function serializeForRing(value: unknown): Uint8Array | null {
  try {
    const b: Uint8Array = S.requireBuiltin('v8').serialize(value);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } catch {
    return null;
  }
}

type NativeEnd = MessagePort | BroadcastChannel;

const wrappers = new WeakMap<object, NodeMessagePort>();

/** Replaces our wrappers with the native ports they hold (for postMessage/structuredClone). */
function unwrap(v: unknown, depth = 0): unknown {
  if (depth > 32 || v === null || typeof v !== 'object') return v;
  if (v instanceof NodeMessagePort) return v[kNative];
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date || v instanceof RegExp || v instanceof NativeBlob) return v;
  if (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer) return v;
  if (v instanceof WebAssembly.Module || v instanceof WebAssembly.Memory || v instanceof NativeMessagePort) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = unwrap(x, depth + 1);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (v instanceof Map || v instanceof Set) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const x = (v as any)[k];
    const y = unwrap(x, depth + 1);
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

/** Replaces received native ports with wrappers. */
function rewrap(v: unknown, depth = 0): unknown {
  if (depth > 32 || v === null || typeof v !== 'object') return v;
  if (v instanceof NativeMessagePort) return NodeMessagePort.wrap(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = rewrap(v[i], depth + 1);
    return v;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  for (const k of Object.keys(v)) (v as any)[k] = rewrap((v as any)[k], depth + 1);
  return v;
}

function transferList(arg: unknown): Transferable[] {
  const list = Array.isArray(arg) ? arg : arg && typeof arg === 'object' && Array.isArray((arg as any).transfer) ? (arg as any).transfer : [];
  return list.map((t: unknown) => (t instanceof NodeMessagePort ? t[kNative] : t)) as Transferable[];
}

export class NodeMessagePort {
  [kNative]: NativeEnd;
  #handle: loop.LoopHandle = { active: true, refed: true, resourceName: 'MessagePort' };
  #started = false;
  #stopped = false;
  #closed = false;
  #queue: MessageEvent[] = [];
  /** rings for receiveMessageOnPort (only on MessageChannel ports) */
  sendRing: Ring | null = null;
  recvRing: Ring | null = null;
  #seq = 1;
  #consumed = new Set<number>();

  constructor(token?: symbol, native?: NativeEnd) {
    if (token !== kToken || !native) {
      const e = new TypeError('Illegal constructor') as TypeError & { code: string };
      e.code = 'ERR_CONSTRUCT_CALL_INVALID';
      throw e;
    }
    this[kNative] = native;
    wrappers.set(native, this);
    native.onmessage = (e: MessageEvent) => this.#receive(e);
    (native as MessagePort).onmessageerror = (e: MessageEvent) => this.#deliver(e.data, [], 'messageerror');
    loop.addHandle(this.#handle);
    const oninit = (this as any)[S.perIsolateSymbols.oninit];
    if (typeof oninit === 'function') oninit.call(this);
  }

  static wrap(native: NativeEnd): NodeMessagePort {
    return wrappers.get(native) ?? new NodeMessagePort(kToken, native);
  }

  #receive(e: MessageEvent) {
    if (e.data && typeof e.data === 'object' && (e.data as any)[CLOSE] === true) {
      this.#closeLocal();
      return;
    }
    const env = e.data && typeof e.data === 'object' ? (e.data as any)[ENV] : undefined;
    if (env !== undefined) {
      const seq = env as number;
      if (seq && this.#consumed.delete(seq)) return; // already taken by receiveMessageOnPort
      if (seq) this.#dropMirror(seq);
      const msg = e.data as { d: unknown; r?: [number, SharedArrayBuffer, SharedArrayBuffer][] };
      this.#adoptRings(e.ports, msg.r);
      e = { data: msg.d, ports: e.ports } as MessageEvent;
    }
    if (!this.#started || this.#stopped) {
      this.#queue.push(e);
      return;
    }
    this.#deliver(e.data, e.ports, 'message');
  }

  /** Discards ring records up to seq (they were delivered asynchronously). */
  #dropMirror(seq: number) {
    const ring = this.recvRing;
    if (!ring) return;
    for (;;) {
      const r = ring.peek();
      if (!r || r.seq > seq) return;
      ring.skip(r.size);
    }
  }

  /** Ports moved here keep their rings. */
  #adoptRings(ports: readonly MessagePort[], rings?: [number, SharedArrayBuffer, SharedArrayBuffer][]) {
    for (const [i, send, recv] of rings ?? []) {
      const p = NodeMessagePort.wrap(ports[i]);
      p.sendRing = new Ring(send);
      p.recvRing = new Ring(recv);
    }
  }

  /** receiveMessageOnPort */
  receiveSync(): { message: unknown } | undefined {
    if (this.#queue.length) {
      const e = this.#queue.shift()!;
      return { message: rewrap(e.data) };
    }
    const ring = this.recvRing;
    if (!ring) return undefined;
    const r = ring.peek();
    if (!r || !r.payload) return undefined; // nothing, or a message only the normal path can carry
    ring.skip(r.size);
    this.#consumed.add(r.seq);
    return { message: S.requireBuiltin('v8').deserialize(r.payload) };
  }

  #deliver(data: unknown, ports: readonly MessagePort[], type: string) {
    const wrapped = ports.map((p) => NodeMessagePort.wrap(p));
    loop.scope(S.perContextExports.emitMessage, this, rewrap(data), wrapped, type);
  }

  postMessage(value: unknown, transfer?: unknown) {
    if (this.#closed) return;
    const list = transferList(transfer);
    try {
      const moved = (Array.isArray(transfer) ? transfer : ((transfer as any)?.transfer ?? [])).filter((t: unknown) => t instanceof NodeMessagePort) as NodeMessagePort[];
      const rings = moved.flatMap((p, i) => (p.sendRing && p.recvRing ? [[i, p.sendRing.sab, p.recvRing.sab]] : []));
      if (this.sendRing || rings.length) {
        // seq 0 = not mirrored on this port's own ring
        const seq = this.sendRing ? this.#seq++ : 0;
        this.sendRing?.push(seq, moved.length ? null : serializeForRing(value));
        (this[kNative] as MessagePort).postMessage({ [ENV]: seq, d: unwrap(value), r: rings.length ? rings : undefined }, list);
        return;
      }
      (this[kNative] as MessagePort).postMessage(unwrap(value), list);
    } catch (e: any) {
      if (e?.name === 'DataCloneError') throw new S.perContextExports.DOMException(e.message, 'DataCloneError');
      throw e;
    }
  }

  start() {
    this.#started = true;
    this.#stopped = false;
    (this[kNative] as MessagePort).start?.();
    const q = this.#queue;
    this.#queue = [];
    for (const e of q) this.#deliver(e.data, e.ports, 'message');
  }

  /** stopMessagePort: hold messages until start() again. */
  stop() {
    this.#stopped = true;
  }

  drain() {
    const q = this.#queue;
    this.#queue = [];
    for (const e of q) this.#deliver(e.data, e.ports, 'message');
  }

  close() {
    if (this.#closed) return;
    try {
      (this[kNative] as MessagePort).postMessage({ [CLOSE]: true });
    } catch {}
    this.#closeLocal();
  }

  #closeLocal() {
    if (this.#closed) return;
    this.#closed = true;
    this.#handle.active = false;
    loop.removeHandle(this.#handle);
    try {
      this[kNative].close();
    } catch {}
    const onclose = (this as any)[S.perIsolateSymbols.handle_onclose];
    if (typeof onclose === 'function') loop.macrotask(() => loop.scope(onclose, this));
  }

  ref() {
    this.#handle.refed = true;
    loop.scheduleAliveCheck();
  }

  unref() {
    this.#handle.refed = false;
    loop.scheduleAliveCheck();
  }

  hasRef() {
    return !this.#closed && this.#handle.refed;
  }
}

export function createMessaging() {
  const b = fromShape('messaging');
  let createObject: unknown = null;
  class MessageChannel {
    port1: NodeMessagePort;
    port2: NodeMessagePort;
    constructor() {
      const ch = new NativeMessageChannel();
      this.port1 = NodeMessagePort.wrap(ch.port1);
      this.port2 = NodeMessagePort.wrap(ch.port2);
      const a = Ring.create();
      const b2 = Ring.create();
      this.port1.sendRing = a;
      this.port2.recvRing = a;
      this.port2.sendRing = b2;
      this.port1.recvRing = b2;
    }
  }
  return Object.assign(b, {
    MessagePort: NodeMessagePort,
    MessageChannel,
    DOMException: S.perContextExports.DOMException,
    broadcastChannel: (name: string) => NodeMessagePort.wrap(new NativeBroadcastChannel(name)),
    stopMessagePort: (port: NodeMessagePort) => port.stop(),
    drainMessagePort: (port: NodeMessagePort) => port.drain(),
    // the lib wraps the result in { message }; "nothing" is no_message_symbol
    receiveMessageOnPort(port: NodeMessagePort) {
      const r = port.receiveSync();
      return r ? r.message : S.perIsolateSymbols.no_message_symbol;
    },
    moveMessagePortToContext: (port: NodeMessagePort) => port,
    setDeserializerCreateObjectFunction(fn: unknown) {
      createObject = fn;
    },
    exposeLazyDOMExceptionProperty(target: object) {
      Object.defineProperty(target, 'DOMException', {
        __proto__: null,
        configurable: true,
        enumerable: false,
        get: () => S.perContextExports.DOMException,
        set(v) {
          Object.defineProperty(target, 'DOMException', { value: v, writable: true, configurable: true, enumerable: false });
        },
      } as PropertyDescriptor);
    },
    structuredClone(value: unknown, options?: { transfer?: unknown[] }) {
      const list = transferList(options);
      try {
        return rewrap(nativeStructuredClone(unwrap(value), { transfer: list }));
      } catch (e: any) {
        if (e?.name === 'DataCloneError') throw new S.perContextExports.DOMException(e.message, 'DataCloneError');
        throw e;
      }
    },
  }, { _createObject: () => createObject });
}
