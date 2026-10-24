// internalBinding('messaging') — node_messaging.cc. A MessagePort here is a JS object wrapping a
// browser MessagePort (or a process-wide BroadcastChannel group); Node's lib reshapes its
// prototype chain onto NodeEventTarget, so delivery goes through the per-context emitMessage like
// the C++ does.
//
// Messages are cloned by the browser's structured clone, with Node's Message::Serialize around
// it: the transfer list is checked in Node's order and with Node's errors, and host objects (other
// MessagePorts, lib's JS transferables such as Blob/FileHandle/DOMException, and binding objects
// registered with registerHostObject) are replaced by references into a side list that the
// receiving side turns back into objects.

import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { fromShape } from './shape.ts';
import { emitAsyncInit } from './process.ts';
import { cloneKeyObject, deserializeKeyObject, isKeyObjectClone } from './crypto/keys.ts';
import { NativeBlob, NativeBroadcastChannel, NativeMessageChannel, NativeMessagePort, nativeStructuredClone } from '../web.ts';

// Natives captured up front, and no for-of/spread over user-reachable iterators: user code may
// replace Array.prototype[Symbol.iterator], Object.keys… and serialization must not call it.
const objectKeys = Object.keys;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
const copyArray = <T>(a: readonly T[]): T[] => {
  const out: T[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i];
  return out;
};

const kToken = Symbol('construct');
const CLOSE = '__ovMessagePortClosed';
/** Envelope key: every message between our ports carries a sequence number (0 = not mirrored). */
const ENV = '__ovMsg';
/** A reference to entry i of the envelope's host list. */
const REF = '__ovRef';

// Node's TransferMode (base_object.h)
const kDisallowCloneAndTransfer = 0;
const kTransferable = 1;
const kCloneable = 2;

const E = {
  untransferable: 'Found invalid value in transferList.',
  transferUnsupported: 'Cannot transfer object of unsupported type.',
  cloneUnsupported: 'Cannot clone object of unsupported type.',
  transferNeeded: 'Object that needs transfer was found in message but not listed in transferList',
};

function dataCloneError(message: string): Error {
  return new S.perContextExports.DOMException(message, 'DataCloneError');
}

function nodeError(Ctor: ErrorConstructor | TypeErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** The browser's DataCloneError, as lib's DOMException with the V8 part of the message. */
function fromNativeError(e: any): unknown {
  if (e?.name !== 'DataCloneError') return e;
  const msg = String(e.message).replace(/^Failed to execute '[^']*' on '[^']*': /, '');
  return dataCloneError(msg);
}

// -----------------------------------------------------------------------------
// Host objects of the bindings (BaseObjects in C++): a FileHandle, a blob handle… A class registers
// how to turn an instance into cloneable data and back; instances are found by the prototype.

export interface HostObjectSpec {
  /** Unique name, '<binding>:<Class>'; the receiving thread creates the binding to find it. */
  name: string;
  mode: number;
  transfer?(obj: any): unknown;
  clone?(obj: any): unknown;
  revive(data: any): object;
}
const kHostSpec = Symbol('ov.hostObject');
const hostSpecs = new Map<string, HostObjectSpec>();

export function registerHostObject(proto: object, spec: HostObjectSpec) {
  Object.defineProperty(proto, kHostSpec, { value: spec, configurable: true });
  hostSpecs.set(spec.name, spec);
}

function hostSpec(name: string): HostObjectSpec {
  let spec = hostSpecs.get(name);
  if (!spec) {
    S.internalBinding(name.split(':')[0]);
    spec = hostSpecs.get(name);
  }
  if (!spec) throw dataCloneError(E.cloneUnsupported);
  return spec;
}

let utilSyms: { mode: symbol; untransferable: symbol } | null = null;
function syms() {
  return (utilSyms ??= { mode: S.privateSymbols.transfer_mode_private_symbol, untransferable: S.privateSymbols.untransferable_object_private_symbol });
}

/** The transfer mode of a host object, or undefined for anything V8 clones itself. */
function modeOf(o: object): number | undefined {
  if (o instanceof NodeMessagePort) return kTransferable;
  const spec = (o as any)[kHostSpec] as HostObjectSpec | undefined;
  if (spec) return spec.mode;
  // a private symbol (see emulatePrivateSymbols in util.ts): not inherited
  const m = (o as any)[syms().mode];
  if (m === undefined) return undefined;
  return typeof m === 'number' && m >>> 0 === m ? m : kDisallowCloneAndTransfer;
}

const isUntransferable = (o: object) => (o as any)[syms().untransferable] !== undefined;

// Brand checks (internal slots), not instanceof: lib's Safe* classes have a null-prototype chain.
const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
const brand = (fn: (this: unknown) => unknown) => (v: object) => {
  try {
    fn.call(v);
    return true;
  } catch {
    return false;
  }
};
const isArrayBuffer = brand(getter(ArrayBuffer.prototype, 'byteLength'));
const isSharedArrayBuffer = typeof SharedArrayBuffer === 'undefined' ? () => false : brand(getter(SharedArrayBuffer.prototype, 'byteLength'));
const isMap = brand(function (this: unknown) {
  Map.prototype.has.call(this as Map<unknown, unknown>, 0);
});
const isSet = brand(function (this: unknown) {
  Set.prototype.has.call(this as Set<unknown>, 0);
});
const isDate = brand(Date.prototype.getTime as () => number);
const isRegExp = brand(getter(RegExp.prototype, 'source'));
const isBoxed = [Boolean, Number, String, ...(typeof BigInt === 'undefined' ? [] : [BigInt]), Symbol].map((C) => brand(C.prototype.valueOf as () => unknown));
const isError = (v: object) => Object.prototype.toString.call(v) === '[object Error]' || v instanceof Error;

/** Objects the browser's structured clone handles the way V8's serializer does. */
function isNativeCloneable(v: object): boolean {
  return (
    ArrayBuffer.isView(v) ||
    isArrayBuffer(v) ||
    isSharedArrayBuffer(v) ||
    v instanceof NativeBlob ||
    v instanceof NativeMessagePort ||
    v instanceof WebAssembly.Module ||
    v instanceof WebAssembly.Memory ||
    isDate(v) ||
    isRegExp(v) ||
    isBoxed.some((f) => f(v))
  );
}

type HostRec = { k: 'port'; p: MessagePort } | { k: 'js'; info: string; data: unknown } | { k: 'b'; name: string; data: unknown };
interface Envelope {
  [ENV]: number;
  d: unknown;
  /** host objects referenced by { [REF]: i } */
  h?: HostRec[];
  /** rings of moved ports: [host index, send, recv] */
  r?: [number, SharedArrayBuffer, SharedArrayBuffer][];
}

/** Reads a transfer list the way GetTransferList/ReadIterable do. */
function readTransferList(arg: unknown): unknown[] {
  if (arg === null || arg === undefined) return [];
  if (typeof arg !== 'object' && typeof arg !== 'function') throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'Optional transferList argument must be an iterable');
  const iter = readIterable(arg);
  if (iter) return iter;
  const t = (arg as any).transfer;
  if (t === undefined) return [];
  const list = t !== null && typeof t === 'object' ? readIterable(t) : null;
  if (!list) throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'Optional options.transfer argument must be an iterable');
  return list;
}

function readIterable(o: any): unknown[] | null {
  if (Array.isArray(o)) return copyArray(o);
  const m = o[Symbol.iterator];
  if (typeof m !== 'function') return null;
  const it = m.call(o);
  if (it === null || typeof it !== 'object') return null;
  const next = it.next;
  if (typeof next !== 'function') return null;
  const out: unknown[] = [];
  for (;;) {
    const r = next.call(it);
    if (r === null || typeof r !== 'object') return null;
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

// -----------------------------------------------------------------------------
// receiveMessageOnPort: every message on a MessageChannel's ports is also written, serialized with
// v8.serialize, to a shared-memory ring for its direction, so the receiving side can take it
// synchronously. A message that can't be serialized (ports, host objects…) leaves a gap record
// and is only delivered the normal way.

// A ring starts small and grows (a growable SharedArrayBuffer) while it is empty, so the many
// channels a program makes don't each hold a megabyte. Sizes are powers of two.
const RING_INIT = 1 << 14;
const RING_MAX = 1 << 26;
const RING_FIXED = 1 << 20; // without growable SharedArrayBuffers
const GAP = 0xffffffff;
const HDR = 16;

class Ring {
  readonly head: Int32Array; // [0] write position, [1] read position (wrapping int32), [2] size
  readonly data: Uint8Array; // tracks the buffer's length as it grows
  constructor(readonly sab: SharedArrayBuffer) {
    this.head = new Int32Array(sab, 0, 3);
    this.data = new Uint8Array(sab, HDR);
  }
  static create() {
    let sab: SharedArrayBuffer;
    try {
      sab = new (SharedArrayBuffer as any)(HDR + RING_INIT, { maxByteLength: HDR + RING_MAX });
    } catch {
      sab = new SharedArrayBuffer(HDR + RING_FIXED);
    }
    const r = new Ring(sab);
    r.head[2] = (sab as any).growable ? RING_INIT : RING_FIXED;
    return r;
  }
  #copyIn(size: number, pos: number, bytes: Uint8Array) {
    const at = pos & (size - 1);
    const first = Math.min(bytes.length, size - at);
    this.data.set(bytes.subarray(0, first), at);
    if (first < bytes.length) this.data.set(bytes.subarray(first), 0);
  }
  #copyOut(size: number, pos: number, len: number) {
    const out = new Uint8Array(len);
    const at = pos & (size - 1);
    const first = Math.min(len, size - at);
    out.set(this.data.subarray(at, at + first));
    if (first < len) out.set(this.data.subarray(0, len - first), first);
    return out;
  }
  /** Appends a record; payload null writes a gap. */
  push(seq: number, payload: Uint8Array | null) {
    const len = payload ? payload.length : 0;
    const head = Atomics.load(this.head, 0);
    const tail = Atomics.load(this.head, 1);
    let size = Atomics.load(this.head, 2);
    const used = (head - tail) | 0;
    const need = 8 + len;
    if (size - used < need + 8 && used === 0 && (this.sab as any).growable) {
      // the reader has nothing to read, so the size may change under the same positions
      let want = size;
      while (want < need + 8 && want < RING_MAX) want *= 2;
      if (want > size) {
        try {
          (this.sab as any).grow(HDR + want);
          size = want;
          Atomics.store(this.head, 2, size);
        } catch {}
      }
    }
    if (size - used < need + 8) {
      // full: record only the gap, if even that fits
      if (size - used < 8) return;
      payload = null;
    }
    const hdr = new Uint8Array(8);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, payload ? payload.length : GAP, true);
    dv.setUint32(4, seq, true);
    this.#copyIn(size, head, hdr);
    if (payload) this.#copyIn(size, (head + 8) | 0, payload);
    Atomics.store(this.head, 0, (head + 8 + (payload ? payload.length : 0)) | 0);
  }
  /** The next record without consuming it. */
  peek(): { seq: number; payload: Uint8Array | null; size: number } | null {
    const head = Atomics.load(this.head, 0);
    const tail = Atomics.load(this.head, 1);
    if (head === tail) return null;
    const size = Atomics.load(this.head, 2);
    const dv = new DataView(this.#copyOut(size, tail, 8).buffer);
    const len = dv.getUint32(0, true);
    const seq = dv.getUint32(4, true);
    if (len === GAP) return { seq, payload: null, size: 8 };
    return { seq, payload: this.#copyOut(size, (tail + 8) | 0, len), size: 8 + len };
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

// -----------------------------------------------------------------------------
// Message::Serialize

interface Prepared {
  env: Envelope;
  transfer: Transferable[];
  /** ports in the transfer list (detached once the message is posted) */
  ports: NodeMessagePort[];
  arrayBuffers: ArrayBuffer[];
}

let createObject: ((info: string) => object) | null = null;

function serialize(value: unknown, list: unknown[], source: NodeMessagePort | null): Prepared {
  const S_ = S.perIsolateSymbols;
  const arrayBuffers: ArrayBuffer[] = [];
  const hosts: object[] = [];
  for (let li = 0; li < list.length; li++) {
    const entry = list[li];
    if (entry === null || (typeof entry !== 'object' && typeof entry !== 'function')) throw dataCloneError(E.untransferable);
    if (isUntransferable(entry)) throw dataCloneError(E.transferUnsupported);
    if (isArrayBuffer(entry)) {
      if ((entry as any).detached) throw dataCloneError(E.transferUnsupported);
      if (arrayBuffers.includes(entry as ArrayBuffer)) throw dataCloneError('Transfer list contains duplicate ArrayBuffer');
      arrayBuffers.push(entry as ArrayBuffer);
      continue;
    }
    if (source && entry === source) throw dataCloneError('Transfer list contains source port');
    const mode = modeOf(entry);
    if (mode === undefined) throw dataCloneError(E.untransferable);
    if (entry instanceof NodeMessagePort && NodeMessagePort.isDetached(entry)) throw dataCloneError('MessagePort in transfer list is already detached');
    if (hosts.includes(entry)) throw dataCloneError(`Transfer list contains duplicate ${(entry as any).constructor?.name ?? 'Object'}`);
    if (!(mode & kTransferable)) throw dataCloneError(E.untransferable);
    hosts.push(entry);
  }
  // AddNestedHostObjects: e.g. a FileHandle registers its binding handle
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i] as any;
    if (h instanceof NodeMessagePort || h[kHostSpec]) continue;
    const fn = h[S_.messaging_transfer_list_symbol];
    if (typeof fn !== 'function') continue;
    const nested = fn.call(h);
    if (!Array.isArray(nested)) continue;
    for (let ni = 0; ni < nested.length; ni++) {
      const n = nested[ni];
      if (n === null || typeof n !== 'object' || hosts.includes(n)) continue;
      if (modeOf(n) !== undefined) hosts.push(n);
    }
  }
  const transferred = hosts.length;

  const memo = new Map<object, unknown>();
  let hasKeys = false;
  const ref = (o: object, mode: number) => {
    if (mode === kDisallowCloneAndTransfer) throw dataCloneError(E.cloneUnsupported);
    const i = hosts.indexOf(o);
    if (mode & kTransferable) {
      if (i < 0 || i >= transferred) throw dataCloneError(E.transferNeeded);
      return { [REF]: i };
    }
    if (i >= 0) return { [REF]: i };
    hosts.push(o);
    return { [REF]: hosts.length - 1 };
  };
  const enc = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v; // functions and symbols: the browser throws
    const seen = memo.get(v);
    if (seen !== undefined) return seen;
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length);
      memo.set(v, out);
      for (let i = 0; i < v.length; i++) if (i in v) out[i] = enc(v[i]);
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    const plain = proto === Object.prototype || proto === null;
    if (!plain && isNativeCloneable(v)) return v;
    if (!plain) {
      // a KeyObject (NativeKeyObject, a cloneable BaseObject in C++)
      const key = cloneKeyObject(v);
      if (key) {
        hasKeys = true;
        memo.set(v, key);
        return key;
      }
    }
    const mode = modeOf(v);
    if (mode !== undefined) {
      const r = ref(v, mode);
      memo.set(v, r);
      return r;
    }
    if (!plain) {
      if (isError(v)) return v;
      if (isMap(v)) {
        const out = new Map();
        memo.set(v, out);
        Map.prototype.forEach.call(v as Map<unknown, unknown>, (x, k) => out.set(enc(k), enc(x)));
        return out;
      }
      if (isSet(v)) {
        const out = new Set();
        memo.set(v, out);
        Set.prototype.forEach.call(v as Set<unknown>, (x) => out.add(enc(x)));
        return out;
      }
    }
    // any other object is written as a plain object of its own enumerable properties
    const out: Record<string, unknown> = {};
    memo.set(v, out);
    const keys = objectKeys(v);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = enc((v as any)[keys[i]]);
    return out;
  };
  const d = enc(value);

  // Finish: transferred objects give up their contents, cloned ones are copied
  const transfer: Transferable[] = copyArray(arrayBuffers);
  const ports: NodeMessagePort[] = [];
  let h: HostRec[] | undefined;
  let rings: Envelope['r'];
  if (hosts.length) {
    h = [];
    for (let i = 0; i < hosts.length; i++) {
      const o = hosts[i] as any;
      if (o instanceof NodeMessagePort) {
        const native = NodeMessagePort.nativePort(o);
        h.push({ k: 'port', p: native });
        transfer.push(native);
        ports.push(o);
        const r = NodeMessagePort.ringsOf(o);
        if (r) (rings ??= []).push([i, r[0].sab, r[1].sab]);
        continue;
      }
      const spec = o[kHostSpec] as HostObjectSpec | undefined;
      if (spec) {
        const fn = i < transferred ? spec.transfer : spec.clone;
        if (!fn) throw dataCloneError(E.cloneUnsupported);
        h.push({ k: 'b', name: spec.name, data: fn(o) });
        continue;
      }
      const method = o[i < transferred ? S_.messaging_transfer_symbol : S_.messaging_clone_symbol];
      if (typeof method !== 'function') throw dataCloneError(E.cloneUnsupported);
      const res = method.call(o);
      if (res === null || typeof res !== 'object') throw dataCloneError(E.cloneUnsupported);
      h.push({ k: 'js', info: `${res.deserializeInfo}`, data: enc(res.data) });
    }
  }
  const env: Envelope = { [ENV]: 0, d };
  if (h || hasKeys) env.h = h ?? [];
  if (rings) env.r = rings;
  return { env, transfer, ports, arrayBuffers };
}

/** Message::Deserialize: host objects first, then the value, then [kDeserialize] in order. */
function deserialize(env: Envelope): { data: unknown; ports: NodeMessagePort[] | undefined } {
  const h = env.h;
  if (!h) return { data: env.d, ports: undefined };
  const S_ = S.perIsolateSymbols;
  const objs: object[] = [];
  const ports: NodeMessagePort[] = [];
  for (let i = 0; i < h.length; i++) {
    const rec = h[i];
    if (rec.k === 'port') {
      const p = NodeMessagePort.wrap(rec.p);
      const r = env.r?.find((x) => x[0] === i);
      if (r) NodeMessagePort.adoptRings(p, r[1], r[2]);
      objs.push(p);
      ports.push(p);
    } else if (rec.k === 'b') {
      objs.push(hostSpec(rec.name).revive(rec.data));
    } else {
      if (!createObject) throw dataCloneError(E.cloneUnsupported);
      const o = createObject(rec.info);
      if (o === null || typeof o !== 'object') throw dataCloneError(E.cloneUnsupported);
      objs.push(o);
    }
  }
  const seen = new Set<object>();
  const fix = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return v;
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype && typeof (v as any)[REF] === 'number' && objectKeys(v).length === 1) return objs[(v as any)[REF]];
    if (isKeyObjectClone(v)) return deserializeKeyObject(v);
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (i in v) v[i] = fix(v[i]);
    } else if (isMap(v)) {
      const m = v as Map<unknown, unknown>;
      const entries: [unknown, unknown][] = [];
      mapForEach.call(m, (x, k) => entries.push([k, x]));
      m.clear();
      for (let i = 0; i < entries.length; i++) m.set(fix(entries[i][0]), fix(entries[i][1]));
    } else if (isSet(v)) {
      const st = v as Set<unknown>;
      const items: unknown[] = [];
      setForEach.call(st, (x) => items.push(x));
      st.clear();
      for (let i = 0; i < items.length; i++) st.add(fix(items[i]));
    } else if (proto === Object.prototype || proto === null) {
      const keys = objectKeys(v);
      for (let i = 0; i < keys.length; i++) (v as any)[keys[i]] = fix((v as any)[keys[i]]);
    }
    return v;
  };
  const data = fix(env.d);
  for (let i = 0; i < h.length; i++) {
    const rec = h[i];
    if (rec.k !== 'js') continue;
    const fn = (objs[i] as any)[S_.messaging_deserialize_symbol];
    if (typeof fn === 'function') fn.call(objs[i], fix(rec.data));
  }
  return { data, ports };
}

// -----------------------------------------------------------------------------
// BroadcastChannel: one native BroadcastChannel per name and thread (named per process, so other
// processes of the same origin don't hear it); instances in the same thread get the message
// directly, synchronously queued like Node's SiblingGroup.

interface BcGroup {
  native: BroadcastChannel;
  members: Set<NodeMessagePort>;
}
const bcGroups = new Map<string, BcGroup>();
/** live BroadcastChannel handles in creation order: Node flushes them in that order */
const bcAll: NodeMessagePort[] = [];
let bcFlushPending = false;

// -----------------------------------------------------------------------------

const wrappers = new WeakMap<object, NodeMessagePort>();

export class NodeMessagePort {
  #port: MessagePort | null = null;
  #bc: string | null = null;
  #handle: loop.LoopHandle = { active: true, refed: true, resourceName: 'MessagePort' };
  #started = false;
  #stopped = false;
  /** close() was called, the port was transferred, or the other side closed (IsDetached) */
  #closing = false;
  /** waiting for messages already sent to be delivered before closing */
  #closeWhenDrained = false;
  #shut = false;
  /** the handle is fully closed: hasRef() answers undefined, like an unwrapped BaseObject */
  #gone = false;
  #queue: Envelope[] = [];
  #flushPending = false;
  #sendRing: Ring | null = null;
  #recvRing: Ring | null = null;
  #seq = 1;
  #consumed = new Set<number>();
  /** the other end, while it lives in this thread */
  #sibling: NodeMessagePort | null = null;
  /** messages the local sibling posted that haven't arrived yet */
  #inflight = 0;
  #asyncId = -1;
  #ready = false;
  /** moved to a vm context (moveMessagePortToContext) */
  #foreign = false;

  constructor(token?: symbol, native?: MessagePort | null, bcName?: string) {
    if (token !== kToken) throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_INVALID', 'Constructor cannot be called');
    if (native) {
      this.#port = native;
      wrappers.set(native, this);
      native.onmessage = (e: MessageEvent) => this.#onNative(e);
      native.onmessageerror = () => this.#emitError(dataCloneError('Message could not be deserialized'));
    } else if (bcName !== undefined) {
      this.#bc = bcName;
      let g = bcGroups.get(bcName);
      if (!g) {
        const ng: BcGroup = { native: new NativeBroadcastChannel(`ov:${S.init?.pid ?? 0}:${bcName}`), members: new Set() };
        ng.native.onmessage = (e: MessageEvent) => {
          let first = true;
          for (const m of [...ng.members]) {
            m.#enqueue(first ? e.data : nativeStructuredClone(e.data), false);
            first = false;
          }
        };
        bcGroups.set(bcName, ng);
        g = ng;
      }
      g.members.add(this);
      bcAll.push(this);
    }
    loop.addHandle(this.#handle);
    // AsyncWrap's init hook runs before the port is done initializing (hasRef() is false then)
    this.#asyncId = emitAsyncInit(this, 'MESSAGEPORT');
    const oninit = (this as any)[S.perIsolateSymbols.oninit];
    if (typeof oninit === 'function') oninit.call(this);
    this.#ready = true;
  }

  static wrap(native: MessagePort): NodeMessagePort {
    return wrappers.get(native) ?? new NodeMessagePort(kToken, native);
  }

  static broadcast(name: string): NodeMessagePort {
    return new NodeMessagePort(kToken, null, name);
  }

  /** MessageChannel: two entangled ports, with rings for receiveMessageOnPort. */
  static pair(): [NodeMessagePort, NodeMessagePort] {
    const ch = new NativeMessageChannel();
    const a = NodeMessagePort.wrap(ch.port1);
    const b = NodeMessagePort.wrap(ch.port2);
    a.#sibling = b;
    b.#sibling = a;
    const r1 = Ring.create();
    const r2 = Ring.create();
    a.#sendRing = r1;
    b.#recvRing = r1;
    b.#sendRing = r2;
    a.#recvRing = r2;
    return [a, b];
  }

  static moveToContext(p: NodeMessagePort) {
    p.#foreign = true;
  }

  /** The parent side of a worker thread's env port, the native end for the thread and the rings it adopts. */
  static pairForThread(): { port: NodeMessagePort; child: MessagePort; rings: [SharedArrayBuffer, SharedArrayBuffer] } {
    const ch = new NativeMessageChannel();
    const port = NodeMessagePort.wrap(ch.port1);
    const toChild = Ring.create();
    const toParent = Ring.create();
    port.#sendRing = toChild;
    port.#recvRing = toParent;
    return { port, child: ch.port2, rings: [toParent.sab, toChild.sab] };
  }

  static isDetached(p: NodeMessagePort) {
    return p.#closing;
  }
  static nativePort(p: NodeMessagePort): MessagePort {
    if (!p.#port) throw dataCloneError(E.transferUnsupported);
    return p.#port;
  }
  static ringsOf(p: NodeMessagePort): [Ring, Ring] | null {
    return p.#sendRing && p.#recvRing ? [p.#sendRing, p.#recvRing] : null;
  }
  static adoptRings(p: NodeMessagePort, send: SharedArrayBuffer, recv: SharedArrayBuffer) {
    p.#sendRing = new Ring(send);
    p.#recvRing = new Ring(recv);
  }

  #onNative(e: MessageEvent) {
    const d = e.data;
    if (d && typeof d === 'object' && d[CLOSE] === true) {
      this.#peerClosed();
      return;
    }
    if (this.#inflight > 0) this.#inflight--;
    const env: Envelope = d && typeof d === 'object' && d[ENV] !== undefined ? d : { [ENV]: 0, d };
    const seq = env[ENV];
    if (seq && this.#consumed.delete(seq)) {
      this.#checkDrained();
      return; // already taken by receiveMessageOnPort
    }
    if (seq) this.#dropMirror(seq);
    this.#enqueue(env, true);
  }

  #enqueue(env: Envelope, direct: boolean) {
    if (this.#shut) return;
    if (direct && this.#started && !this.#stopped && !this.#queue.length) {
      this.#emit(env);
      this.#checkDrained();
      return;
    }
    this.#queue.push(env);
    if (this.#started && !this.#stopped) this.#scheduleFlush();
  }

  /** Delivers what was queued on a later turn, like MessagePort::Start's uv_async: lib calls
   *  start() from 'newListener', before the listener is attached. */
  #scheduleFlush() {
    if (this.#bc !== null) {
      NodeMessagePort.#scheduleBcFlush();
      return;
    }
    if (this.#flushPending || !this.#queue.length) return;
    this.#flushPending = true;
    loop.macrotask(() => {
      this.#flushPending = false;
      while (this.#queue.length && this.#started && !this.#stopped && !this.#shut) this.#emit(this.#queue.shift()!);
      this.#checkDrained();
    });
  }

  /** One uv_async per BroadcastChannel handle; libuv runs them in creation order, each draining its queue. */
  static #scheduleBcFlush() {
    if (bcFlushPending) return;
    bcFlushPending = true;
    loop.macrotask(() => {
      bcFlushPending = false;
      const all = copyArray(bcAll);
      for (let i = 0; i < all.length; i++) {
        const p = all[i];
        while (p.#queue.length && p.#started && !p.#stopped && !p.#shut) p.#emit(p.#queue.shift()!);
        p.#checkDrained();
      }
    });
  }

  #emit(env: Envelope) {
    let msg: { data: unknown; ports: NodeMessagePort[] | undefined };
    if (this.#foreign && env.h?.some((r) => r.k === 'js')) {
      // JSTransferable::Data::Deserialize only works in the main context
      this.#emitError(nodeError(Error, 'ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE', 'A message object could not be deserialized successfully in the target vm.Context'));
      return;
    }
    try {
      msg = deserialize(env);
    } catch (e) {
      this.#emitError(e);
      return;
    }
    loop.scope(S.perContextExports.emitMessage, this, msg.data, msg.ports, 'message');
  }

  #emitError(err: unknown) {
    loop.scope(S.perContextExports.emitMessage, this, err, undefined, 'messageerror');
  }

  /** Discards ring records up to seq (they were delivered asynchronously). */
  #dropMirror(seq: number) {
    const ring = this.#recvRing;
    if (!ring) return;
    for (;;) {
      const r = ring.peek();
      if (!r || r.seq > seq) return;
      ring.skip(r.size);
    }
  }

  /** receiveMessageOnPort */
  static receive(p: NodeMessagePort): unknown {
    if (p.#queue.length) {
      const env = p.#queue.shift()!;
      p.#checkDrained();
      return deserialize(env).data;
    }
    const ring = p.#recvRing;
    if (!ring || p.#shut) return S.perIsolateSymbols.no_message_symbol;
    const r = ring.peek();
    if (!r || !r.payload) return S.perIsolateSymbols.no_message_symbol; // nothing, or a message only the normal path can carry
    ring.skip(r.size);
    p.#consumed.add(r.seq);
    return S.requireBuiltin('v8').deserialize(r.payload);
  }

  postMessage(value: unknown, transfer?: unknown) {
    if (arguments.length === 0) throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'Not enough arguments to MessagePort.postMessage');
    const list = readTransferList(transfer);
    // the message is serialized (and may throw) even when the port is closed
    const msg = serialize(value, list, this);
    if (this.#closing) return undefined;
    if (this.#bc !== null) return this.#broadcast(msg);
    const sib = this.#sibling;
    if (sib && msg.ports.includes(sib)) {
      // SiblingGroup::Dispatch: the message carrying the target port is dropped, and with it the channel
      if (msg.arrayBuffers.length) nativeStructuredClone(undefined, { transfer: msg.arrayBuffers });
      for (let i = 0; i < msg.ports.length; i++) msg.ports[i].#detach();
      this.#peerClosed();
      S.process.emitWarning('The target port was posted to itself, and the communication channel was lost');
      return true;
    }
    if (this.#sendRing) {
      msg.env[ENV] = this.#seq++;
      this.#sendRing.push(msg.env[ENV], msg.env.h ? null : serializeForRing(value));
    }
    try {
      this.#port!.postMessage(msg.env, msg.transfer);
    } catch (e) {
      throw fromNativeError(e);
    }
    if (sib) sib.#inflight++;
    for (let i = 0; i < msg.ports.length; i++) msg.ports[i].#detach();
    return true;
  }

  #broadcast(msg: Prepared) {
    if (msg.transfer.length) throw dataCloneError(E.transferUnsupported);
    const g = bcGroups.get(this.#bc!);
    if (!g) return undefined;
    let copy: Envelope;
    try {
      copy = nativeStructuredClone(msg.env);
    } catch (e) {
      throw fromNativeError(e);
    }
    try {
      g.native.postMessage(msg.env);
    } catch {
      // e.g. a SharedArrayBuffer can't leave the thread this way; the handles here still get it
    }
    let first = true;
    for (const m of [...g.members]) {
      if (m === this) continue;
      m.#enqueue(first ? copy : nativeStructuredClone(copy), false);
      first = false;
    }
    return true;
  }

  start() {
    if (this.#shut) return;
    this.#started = true;
    this.#stopped = false;
    this.#port?.start();
    this.#scheduleFlush();
  }

  /** stopMessagePort: hold messages until start() again. */
  static stop(p: NodeMessagePort) {
    p.#stopped = true;
  }

  /** drainMessagePort (OnMessage with kForceReadMessages): everything sent so far, synchronously —
   *  what already arrived, then what is still on its way (from the ring). */
  static drain(p: NodeMessagePort) {
    const q = p.#queue;
    p.#queue = [];
    for (let i = 0; i < q.length; i++) p.#emit(q[i]);
    const ring = p.#recvRing;
    if (!ring || p.#shut) return;
    for (let r = ring.peek(); r && r.payload; r = ring.peek()) {
      ring.skip(r.size);
      p.#consumed.add(r.seq);
      let data: unknown;
      try {
        data = S.requireBuiltin('v8').deserialize(r.payload);
      } catch (e) {
        p.#emitError(e);
        continue;
      }
      loop.scope(S.perContextExports.emitMessage, p, data, undefined, 'message');
    }
  }

  close() {
    if (this.#closing) return;
    if (this.#port) {
      try {
        this.#port.postMessage({ [CLOSE]: true });
      } catch {}
    }
    const sib = this.#sibling;
    this.#sibling = null;
    if (sib) {
      sib.#sibling = null;
      sib.#peerClosed();
    }
    this.#closing = true;
    this.#finishClose();
  }

  /** The other side is gone: deliver what it sent, then close. */
  #peerClosed() {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#sibling) this.#sibling.#sibling = null;
    this.#sibling = null;
    this.#finishClose();
  }

  #finishClose() {
    if (this.#started && !this.#stopped && (this.#queue.length || this.#inflight > 0)) {
      this.#closeWhenDrained = true;
      return;
    }
    this.#shutdown();
  }

  #checkDrained() {
    if (this.#closeWhenDrained && !this.#queue.length && this.#inflight <= 0) this.#shutdown();
  }

  /** Moved to another port's message: this object stays behind, detached and closed. */
  #detach() {
    if (this.#sibling) this.#sibling.#sibling = null;
    this.#sibling = null;
    this.#closing = true;
    this.#port = null;
    this.#shutdown();
  }

  #shutdown() {
    if (this.#shut) return;
    this.#shut = true;
    this.#closeWhenDrained = false;
    this.#queue = [];
    this.#handle.active = false;
    loop.removeHandle(this.#handle);
    if (this.#port) {
      try {
        this.#port.close();
      } catch {}
    }
    if (this.#bc !== null) {
      const i = bcAll.indexOf(this);
      if (i >= 0) bcAll.splice(i, 1);
      const g = bcGroups.get(this.#bc);
      if (g) {
        g.members.delete(this);
        if (!g.members.size) {
          g.native.close();
          bcGroups.delete(this.#bc);
        }
      }
    }
    // uv_close callbacks run on a later loop turn
    const done = loop.startReq('HandleClose');
    loop.macrotask(() => {
      done();
      const onclose = (this as any)[S.perIsolateSymbols.handle_onclose];
      if (typeof onclose === 'function') loop.scope(onclose, this);
      this.#gone = true;
    });
  }

  ref() {
    if (this.#shut) return;
    this.#handle.refed = true;
    loop.scheduleAliveCheck();
  }

  unref() {
    if (this.#shut) return;
    this.#handle.refed = false;
    loop.scheduleAliveCheck();
  }

  hasRef() {
    if (this.#gone) return undefined;
    return this.#ready && this.#handle.refed;
  }

  static detach(p: NodeMessagePort) {
    p.#detach();
  }

  static asyncId(p: NodeMessagePort) {
    return p.#asyncId;
  }
}

/** The public constructor: like a C++ FunctionTemplate, it can't be called from JS at all. */
const MessagePort = function MessagePort() {
  throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_INVALID', 'Constructor cannot be called');
} as unknown as typeof NodeMessagePort;
(MessagePort as any).prototype = NodeMessagePort.prototype;
Object.defineProperty(MessagePort, 'name', { value: 'MessagePort' });
Object.defineProperty(NodeMessagePort.prototype, 'constructor', { value: MessagePort, writable: true, configurable: true, enumerable: false });

export function createMessaging() {
  const b = fromShape('messaging');
  function MessageChannel(this: any) {
    if (!new.target) throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_REQUIRED', 'Cannot call constructor without `new`');
    const [a, c] = NodeMessagePort.pair();
    this.port1 = a;
    this.port2 = c;
  }
  return Object.assign(
    b,
    {
      MessagePort,
      MessageChannel,
      DOMException: S.perContextExports.DOMException,
      broadcastChannel: (name: string) => NodeMessagePort.broadcast(name),
      stopMessagePort: (port: NodeMessagePort) => port instanceof NodeMessagePort && NodeMessagePort.stop(port),
      drainMessagePort: (port: NodeMessagePort) => port instanceof NodeMessagePort && NodeMessagePort.drain(port),
      // the lib wraps the result in { message }; "nothing" is no_message_symbol
      receiveMessageOnPort(port: NodeMessagePort) {
        if (!(port instanceof NodeMessagePort)) throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "port" argument must be a MessagePort instance');
        return NodeMessagePort.receive(port);
      },
      moveMessagePortToContext(port: NodeMessagePort) {
        if (!(port instanceof NodeMessagePort)) throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "port" argument must be a MessagePort instance');
        if (NodeMessagePort.isDetached(port)) throw nodeError(Error, 'ERR_CLOSED_MESSAGE_PORT', 'Cannot send data on closed MessagePort');
        NodeMessagePort.moveToContext(port);
        return port;
      },
      setDeserializerCreateObjectFunction(fn: (info: string) => object) {
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
        const msg = serialize(value, options?.transfer ?? [], null);
        let cloned: Envelope;
        try {
          cloned = nativeStructuredClone(msg.env, { transfer: msg.transfer });
        } catch (e) {
          throw fromNativeError(e);
        }
        for (let i = 0; i < msg.ports.length; i++) NodeMessagePort.detach(msg.ports[i]);
        return deserialize(cloned).data;
      },
    },
    { _createObject: () => createObject },
  );
}
