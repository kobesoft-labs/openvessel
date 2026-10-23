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
    if (!this.#started || this.#stopped) {
      this.#queue.push(e);
      return;
    }
    this.#deliver(e.data, e.ports, 'message');
  }

  #deliver(data: unknown, ports: readonly MessagePort[], type: string) {
    const wrapped = ports.map((p) => NodeMessagePort.wrap(p));
    loop.scope(S.perContextExports.emitMessage, this, rewrap(data), wrapped, type);
  }

  postMessage(value: unknown, transfer?: unknown) {
    if (this.#closed) return;
    const list = transferList(transfer);
    try {
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
    }
  }
  return Object.assign(b, {
    MessagePort: NodeMessagePort,
    MessageChannel,
    DOMException: S.perContextExports.DOMException,
    broadcastChannel: (name: string) => NodeMessagePort.wrap(new NativeBroadcastChannel(name)),
    stopMessagePort: (port: NodeMessagePort) => port.stop(),
    drainMessagePort: (port: NodeMessagePort) => port.drain(),
    // a synchronous receive needs the shared-memory mirror the worker binding sets up
    receiveMessageOnPort: (port: NodeMessagePort) => (port as any).receiveSync?.(),
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
