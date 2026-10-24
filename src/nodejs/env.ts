// process.env (node_env_var.cc). Each thread has its own copy, except with worker_threads'
// SHARE_ENV: then the threads that share it keep the variables in shared memory (a KVStore the
// threads hold together), and every access first picks up what another thread changed.

const enc = new TextEncoder();
const dec = new TextDecoder();

// [0] lock, [1] version, [2] byte length of the JSON that follows the header
const HDR = 12;

class SharedStore {
  readonly i32: Int32Array;
  #seen = -1;
  constructor(readonly sab: SharedArrayBuffer) {
    this.i32 = new Int32Array(sab, 0, 3);
  }
  static create(): SharedStore {
    let sab: SharedArrayBuffer;
    try {
      sab = new (SharedArrayBuffer as any)(HDR + (1 << 16), { maxByteLength: HDR + (1 << 24) });
    } catch {
      sab = new SharedArrayBuffer(HDR + (1 << 20));
    }
    return new SharedStore(sab);
  }
  #lock() {
    while (Atomics.compareExchange(this.i32, 0, 0, 1) !== 0) Atomics.wait(this.i32, 0, 1, 1);
  }
  #unlock() {
    Atomics.store(this.i32, 0, 0);
    Atomics.notify(this.i32, 0);
  }
  #readLocked(): Record<string, string> {
    const len = this.i32[2];
    const bytes = new Uint8Array(len);
    bytes.set(new Uint8Array(this.sab, HDR, len));
    this.#seen = this.i32[1];
    return len ? JSON.parse(dec.decode(bytes)) : {};
  }
  #writeLocked(store: Record<string, string>) {
    const bytes = enc.encode(JSON.stringify(store));
    if (HDR + bytes.length > this.sab.byteLength) {
      const grow = (this.sab as any).grow;
      if (typeof grow !== 'function') throw new RangeError('process.env is too large to share');
      grow.call(this.sab, HDR + Math.max(bytes.length, this.sab.byteLength * 2 - HDR));
    }
    new Uint8Array(this.sab, HDR, bytes.length).set(bytes);
    this.i32[2] = bytes.length;
    this.#seen = Atomics.add(this.i32, 1, 1) + 1;
  }
  /** What another thread wrote since we last looked, or null. */
  changes(): Record<string, string> | null {
    if (Atomics.load(this.i32, 1) === this.#seen) return null;
    this.#lock();
    try {
      return this.#readLocked();
    } finally {
      this.#unlock();
    }
  }
  /** Applies a change on the latest contents and publishes them. */
  update(fn: (store: Record<string, string>) => void): Record<string, string> {
    this.#lock();
    try {
      const store = this.#readLocked();
      fn(store);
      this.#writeLocked(store);
      return store;
    } finally {
      this.#unlock();
    }
  }
  publish(store: Record<string, string>) {
    this.update((s) => {
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, store);
    });
  }
}

let shared: SharedStore | null = null;
let local: Record<string, string> | null = null;

function invalidDescriptor(): TypeError {
  const e = new TypeError(`'process.env' only accepts a configurable, writable, and enumerable data descriptor`) as TypeError & { code: string };
  e.code = 'ERR_INVALID_OBJECT_DEFINE_PROPERTY';
  return e;
}

/** The process.env object; `sharedSab` when the thread was started with SHARE_ENV. */
export function createEnvProxy(initial: Record<string, string>, sharedSab?: SharedArrayBuffer) {
  const store: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(initial)) store[k] = String(v);
  local = store;
  if (sharedSab) shared = new SharedStore(sharedSab);
  const sync = () => {
    const next = shared?.changes();
    if (!next) return;
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, next);
  };
  const write = (fn: (s: Record<string, string>) => void) => {
    if (!shared) return fn(store);
    const next = shared.update(fn);
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, next);
  };
  return new Proxy(store, {
    get(t, k, r) {
      sync();
      return Reflect.get(t, k, r);
    },
    has(t, k) {
      sync();
      return Reflect.has(t, k);
    },
    ownKeys(t) {
      sync();
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, k) {
      sync();
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    set(_t, k, v) {
      if (typeof k === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
      const s = String(v);
      write((st) => {
        st[k] = s;
      });
      return true;
    },
    defineProperty(_t, k, d) {
      if (typeof k === 'symbol') return false;
      if ('get' in d || 'set' in d || d.configurable !== true || d.writable !== true || d.enumerable !== true) throw invalidDescriptor();
      const s = String(d.value);
      write((st) => {
        st[k] = s;
      });
      return true;
    },
    deleteProperty(_t, k) {
      if (typeof k === 'string') {
        write((st) => {
          delete st[k];
        });
      }
      return true;
    },
  });
}

/** SHARE_ENV: from now on this thread's process.env lives in shared memory, handed to the new thread. */
export function shareEnv(): SharedArrayBuffer {
  if (!shared) {
    shared = SharedStore.create();
    shared.publish({ ...(local ?? {}) });
  }
  return shared.sab;
}
