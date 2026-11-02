// Bindings that Node 24–26 added or moved from JS into C++:
//   diagnostics_channel  native channel slots (node_diagnostics_channel.cc)
//   cjs_lexer            CommonJS export names for ESM imports (merve in C++; cjs-module-lexer here)
//   ipc_serdes           the 'advanced' child_process IPC codec (was JS over node:v8 until Node 24)
//   locks                the Web Locks API (node_locks.cc), per thread
//   webstorage           Storage for localStorage/sessionStorage (node_webstorage.cc, SQLite there)
//   url_pattern          URLPattern (ada there; the browser's own here)
//   async_context_frame  continuation-preserved embedder data (see the note on createAsyncContextFrame)

// @ts-ignore - pure JS build, synchronous (no wasm init)
import { parse as parseCjs } from 'cjs-module-lexer/lexer.js';
import { lib } from '../state.ts';
import { fromShape } from './shape.ts';

// ---------------------------------------------------------------------------
// diagnostics_channel

export function createDiagnosticsChannel() {
  const b = fromShape('diagnostics_channel');
  let link: ((name: string, index: number) => unknown) | null = null;
  // channels C++ publishes to (none in OpenVessel); the subscriber counts live in `subscribers`
  return Object.assign(b, {
    linkNativeChannel(fn: (name: string, index: number) => unknown) {
      link = fn;
    },
    notifyChannelActive: () => {},
    notifyChannelInactive: () => {},
    /** not part of Node's binding: lets a binding create a native channel (unused so far) */
    get _link() {
      return link;
    },
  });
}

// ---------------------------------------------------------------------------
// cjs_lexer

export function createCjsLexer() {
  return {
    /** → [Set of export names, array of reexport specifiers], as node_cjs_lexer.cc */
    parse(source: string) {
      let r: { exports: string[]; reexports: string[] };
      try {
        r = parseCjs(`${source ?? ''}`);
      } catch {
        // merve, like the lexer Node used before, gives up quietly: no named exports
        r = { exports: [], reexports: [] };
      }
      return [new Set(r.exports), r.reexports];
    },
  };
}

// ---------------------------------------------------------------------------
// ipc_serdes: a 4-byte big-endian length, then V8's serialization; ArrayBufferViews as host objects
// (copied as their type), any other host object as a plain object, as Node 22's JS codec did.

const kArrayBufferViewTag = 0;
const kNotArrayBufferViewTag = 1;
let ipcCodec: { Ser: any; De: any } | null = null;
function codec() {
  if (ipcCodec) return ipcCodec;
  const v8 = lib('v8');
  const { isArrayBufferView } = lib('internal/util/types');
  class Ser extends v8.DefaultSerializer {
    _writeHostObject(object: any) {
      if (isArrayBufferView(object)) {
        this.writeUint32(kArrayBufferViewTag);
        return super._writeHostObject(object);
      }
      this.writeUint32(kNotArrayBufferViewTag);
      this.writeValue({ ...object });
    }
  }
  class De extends v8.DefaultDeserializer {
    _readHostObject() {
      const tag = this.readUint32();
      if (tag === kArrayBufferViewTag) return super._readHostObject();
      return this.readValue();
    }
  }
  return (ipcCodec = { Ser, De });
}

export function createIpcSerdes() {
  return {
    serialize(message: unknown) {
      const { Ser } = codec();
      const ser = new Ser();
      ser.writeRawBytes(new Uint8Array(4));
      ser.writeHeader();
      ser.writeValue(message);
      const out: Uint8Array = ser.releaseBuffer();
      const n = out.length - 4;
      out[0] = (n >>> 24) & 0xff;
      out[1] = (n >>> 16) & 0xff;
      out[2] = (n >>> 8) & 0xff;
      out[3] = n & 0xff;
      return out;
    },
    deserialize(bytes: Uint8Array) {
      const { De } = codec();
      const de = new De(bytes);
      de.readHeader();
      return de.readValue();
    },
  };
}

// ---------------------------------------------------------------------------
// locks (https://w3c.github.io/web-locks/), one lock manager per thread

type LockMode = 'shared' | 'exclusive';
interface LockRequest {
  name: string;
  clientId: string;
  mode: LockMode;
  callback: (lock: { name: string; mode: LockMode } | null) => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  released?: boolean;
}

export function createLocks() {
  const held = new Map<string, LockRequest[]>();
  const queues = new Map<string, LockRequest[]>();
  const STOLEN = 'LOCK_STOLEN';

  const grantable = (r: LockRequest) => {
    const h = held.get(r.name) ?? [];
    const q = queues.get(r.name) ?? [];
    if (q[0] !== r) return false;
    if (!h.length) return true;
    return r.mode === 'shared' && h.every((x) => x.mode === 'shared');
  };
  const process = (name: string) => {
    const q = queues.get(name) ?? [];
    while (q.length && grantable(q[0])) grant(q.shift()!);
    if (!q.length) queues.delete(name);
  };
  const release = (r: LockRequest) => {
    if (r.released) return;
    r.released = true;
    const h = held.get(r.name);
    if (h) {
      const i = h.indexOf(r);
      if (i >= 0) h.splice(i, 1);
      if (!h.length) held.delete(r.name);
    }
    process(r.name);
  };
  const grant = (r: LockRequest) => {
    let h = held.get(r.name);
    if (!h) held.set(r.name, (h = []));
    h.push(r);
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(r.callback({ name: r.name, mode: r.mode }));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (v) => {
        if (!r.released) {
          release(r);
          r.resolve(v);
        }
      },
      (e) => {
        if (!r.released) {
          release(r);
          r.reject(e);
        }
      },
    );
  };

  return Object.assign(fromShape('locks'), {
    request(name: string, clientId: string, mode: LockMode, steal: boolean, ifAvailable: boolean, callback: LockRequest['callback']) {
      return new Promise((resolve, reject) => {
        const r: LockRequest = { name, clientId, mode, callback, resolve, reject };
        if (steal) {
          for (const old of held.get(name) ?? []) {
            old.released = true;
            old.reject(new Error(STOLEN));
          }
          held.delete(name);
          let q = queues.get(name);
          if (!q) queues.set(name, (q = []));
          q.unshift(r);
          return process(name);
        }
        let q = queues.get(name);
        const free = !(held.get(name)?.length) && !q?.length;
        const sharedOk = mode === 'shared' && !q?.length && (held.get(name) ?? []).every((x) => x.mode === 'shared');
        if (ifAvailable && !free && !sharedOk) {
          // granted nothing: the callback runs with null
          Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject);
          return;
        }
        if (!q) queues.set(name, (q = []));
        q.push(r);
        process(name);
      });
    },
    query() {
      const info = (r: LockRequest) => ({ name: r.name, mode: r.mode, clientId: r.clientId });
      return Promise.resolve({ held: [...held.values()].flat().map(info), pending: [...queues.values()].flat().map(info) });
    },
  });
}

// ---------------------------------------------------------------------------
// webstorage: an in-memory Storage; a localStorage file (--localstorage-file) is kept as JSON

export function createWebstorage() {
  const b = fromShape('webstorage');
  const kConstructorKey: symbol = b.kConstructorKey;
  const items = new WeakMap<object, Map<string, string>>();
  const files = new WeakMap<object, string>();
  const QUOTA = 10 * 1024 * 1024;
  const map = (s: object) => {
    const m = items.get(s);
    if (!m) throw new (lib('internal/errors').codes.ERR_INVALID_THIS)('Storage');
    return m;
  };
  const save = (s: object) => {
    const f = files.get(s);
    if (!f) return;
    try {
      lib('fs').writeFileSync(f, JSON.stringify([...map(s)]));
    } catch {}
  };
  function Storage(this: object, key: symbol, location: string) {
    if (key !== kConstructorKey) throw new (lib('internal/errors').codes.ERR_ILLEGAL_CONSTRUCTOR)();
    const m = new Map<string, string>();
    items.set(this, m);
    if (location && `${location}` !== ':memory:') {
      const file = `${location}`;
      files.set(this, file);
      try {
        for (const [k, v] of JSON.parse(lib('fs').readFileSync(file, 'utf8'))) m.set(k, v);
      } catch {}
    }
    // named properties: storage.foo reads and writes items, as the [LegacyOverrideBuiltIns] interface does
    return new Proxy(this, {
      get(t, p) {
        if (typeof p === 'string' && !(p in t) && m.has(p)) return m.get(p);
        return Reflect.get(t, p, t);
      },
      set(t, p, v) {
        if (typeof p === 'string' && !(p in Storage.prototype)) {
          (Storage.prototype as any).setItem.call(t, p, v);
          return true;
        }
        return Reflect.set(t, p, v, t);
      },
      has(t, p) {
        return (typeof p === 'string' && m.has(p)) || Reflect.has(t, p);
      },
      deleteProperty(t, p) {
        if (typeof p === 'string' && m.has(p)) {
          m.delete(p);
          save(t);
          return true;
        }
        return Reflect.deleteProperty(t, p);
      },
      ownKeys(t) {
        return [...new Set([...m.keys(), ...Reflect.ownKeys(t)])];
      },
      getOwnPropertyDescriptor(t, p) {
        if (typeof p === 'string' && m.has(p)) return { value: m.get(p), writable: true, enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
    });
  }
  const proto = {
    get length() {
      return map(this).size;
    },
    clear(this: object) {
      map(this).clear();
      save(this);
    },
    getItem(this: object, k: unknown) {
      const v = map(this).get(`${k}`);
      return v === undefined ? null : v;
    },
    key(this: object, i: number) {
      const keys = [...map(this).keys()];
      const n = Number(i) >>> 0;
      return n < keys.length ? keys[n] : null;
    },
    removeItem(this: object, k: unknown) {
      map(this).delete(`${k}`);
      save(this);
    },
    setItem(this: object, k: unknown, v: unknown) {
      const m = map(this);
      const key = `${k}`;
      const value = `${v}`;
      let size = key.length + value.length;
      for (const [a, b] of m) if (a !== key) size += a.length + b.length;
      if (size * 2 > QUOTA) {
        const { lazyDOMException } = lib('internal/util');
        throw lazyDOMException('Setting the value exceeded the quota', 'QuotaExceededError');
      }
      m.set(key, value);
      save(this);
    },
  };
  Object.defineProperties(Storage.prototype, Object.getOwnPropertyDescriptors(proto));
  return Object.assign(b, { Storage });
}

// ---------------------------------------------------------------------------
// url_pattern: the browser implements URLPattern (Chrome, Firefox 142+); the stub otherwise

export function createUrlPattern() {
  const b = fromShape('url_pattern');
  const Native = (globalThis as any).URLPattern;
  if (typeof Native === 'function') b.URLPattern = Native;
  return b;
}

// ---------------------------------------------------------------------------
// async_context_frame
//
// V8 keeps the "continuation preserved embedder data" across promise jobs and await; JS can't. The
// slot is kept here so the API works, but Node 24+'s default (AsyncLocalStorage on AsyncContextFrame)
// would lose the store across await. OpenVessel therefore defaults to --no-async-context-frame
// (options.ts), where AsyncLocalStorage runs on async_hooks as in Node 22.

export function createAsyncContextFrame() {
  let data: unknown;
  return {
    getContinuationPreservedEmbedderData: () => data,
    setContinuationPreservedEmbedderData: (v: unknown) => {
      data = v;
    },
  };
}

// ---------------------------------------------------------------------------
// ffi (node:ffi, --experimental-ffi): no native libraries in a browser. The module still loads
// (process.getBuiltinModule walks every builtin); lib asserts that `functions` is an accessor.

export function createFfi() {
  const b = fromShape('ffi');
  const proto = b.DynamicLibrary?.prototype;
  if (proto) {
    Object.defineProperty(proto, 'functions', {
      get() {
        const e = new Error('internalBinding (\'ffi\').DynamicLibrary.prototype.functions is not implemented in OpenVessel') as Error & { code: string };
        e.code = 'ERR_NOT_IMPLEMENTED';
        throw e;
      },
      configurable: true,
      enumerable: false,
    });
  }
  return b;
}
