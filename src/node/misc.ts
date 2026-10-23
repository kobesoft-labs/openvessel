// Smaller builtins: console, tty, timers, vm, async_hooks, perf_hooks, dns, v8,
// diagnostics_channel, punycode, inspector and stubs.

import { Buffer } from 'buffer';
import { EventEmitter } from './events.ts';
import * as loop from './loop.ts';
import { StdReadStream, StdWriteStream } from './process.ts';
import { sys } from './sys.ts';
import { format, formatWithOptions, inspect } from './util.ts';
import { perfNow } from './native.ts';

// -----------------------------------------------------------------------------
// console

export function makeConsole(stdout: any, stderr?: any, opts: { colorMode?: boolean | 'auto'; groupIndentation?: number } = {}) {
  const out = stdout;
  const err = stderr ?? stdout;
  let indent = '';
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const colors = () => (opts.colorMode === 'auto' || opts.colorMode === undefined ? !!out?.isTTY && out?.getColorDepth?.() > 2 : !!opts.colorMode);
  const write = (stream: any, s: string) => {
    const text = indent ? s.replace(/^/gm, indent) : s;
    stream.write(text + '\n');
  };
  const fmt = (args: unknown[]) => formatWithOptions({ colors: colors() }, ...(args as [unknown, ...unknown[]]));
  const c: any = {
    log: (...a: unknown[]) => write(out, fmt(a)),
    info: (...a: unknown[]) => write(out, fmt(a)),
    debug: (...a: unknown[]) => write(out, fmt(a)),
    warn: (...a: unknown[]) => write(err, fmt(a)),
    error: (...a: unknown[]) => write(err, fmt(a)),
    trace: (...a: unknown[]) => {
      const e = new Error(format(...(a as [unknown])));
      e.name = 'Trace';
      write(err, (e.stack ?? '').replace(/\n\s+at [^\n]*makeConsole[^\n]*/, ''));
    },
    dir: (o: unknown, o2?: any) => write(out, inspect(o, { colors: colors(), ...(o2 ?? {}) })),
    dirxml: (...a: unknown[]) => write(out, fmt(a)),
    assert: (v: unknown, ...a: unknown[]) => {
      if (!v) write(err, 'Assertion failed' + (a.length ? ': ' + fmt(a) : ''));
    },
    count: (label = 'default') => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      write(out, `${label}: ${n}`);
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => timers.set(label, perfNow()),
    timeEnd: (label = 'default') => {
      const t = timers.get(label);
      if (t === undefined) return;
      timers.delete(label);
      write(out, `${label}: ${fmtMs(perfNow() - t)}`);
    },
    timeLog: (label = 'default', ...a: unknown[]) => {
      const t = timers.get(label);
      if (t === undefined) return;
      write(out, `${label}: ${fmtMs(perfNow() - t)}${a.length ? ' ' + fmt(a) : ''}`);
    },
    group: (...a: unknown[]) => {
      if (a.length) write(out, fmt(a));
      indent += ' '.repeat(opts.groupIndentation ?? 2);
    },
    groupCollapsed: (...a: unknown[]) => c.group(...a),
    groupEnd: () => {
      indent = indent.slice(opts.groupIndentation ?? 2);
    },
    table: (data: any, cols?: string[]) => write(out, table(data, cols)),
    clear: () => {
      if (out.isTTY) out.write('\x1b[1;1H\x1b[0J');
    },
    profile: () => {},
    profileEnd: () => {},
    timeStamp: () => {},
    context: () => c,
    createTask: () => ({ run: (fn: () => unknown) => fn() }),
  };
  return c;
}

function fmtMs(ms: number) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)}s`;
  return `${ms.toFixed(3)}ms`;
}

function table(data: any, cols?: string[]): string {
  if (data === null || typeof data !== 'object') return String(data);
  const rows = Object.keys(data);
  const keys = new Set<string>();
  let hasValues = false;
  for (const r of rows) {
    const v = data[r];
    if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) keys.add(k);
    else hasValues = true;
  }
  const header = ['(index)', ...(cols ?? [...keys]), ...(hasValues ? ['Values'] : [])];
  const body = rows.map((r) => {
    const v = data[r];
    const cells = (cols ?? [...keys]).map((k) => (v !== null && typeof v === 'object' && k in v ? inspect(v[k]) : ''));
    return [r, ...cells, ...(hasValues ? [v !== null && typeof v === 'object' ? '' : inspect(v)] : [])];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)) + 2);
  const line = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w)).join(m) + r;
  const row = (cells: string[]) => '│' + cells.map((c, i) => c.padStart(Math.floor((widths[i] + c.length) / 2)).padEnd(widths[i])).join('│') + '│';
  return [line('┌', '┬', '┐'), row(header), line('├', '┼', '┤'), ...body.map(row), line('└', '┴', '┘')].join('\n');
}

export class ConsoleCtor {
  constructor(stdout: any, stderr?: any, ignoreErrors?: boolean) {
    let opts: any = { stdout, stderr };
    if (stdout && !stdout.write && stdout.stdout) opts = stdout;
    void ignoreErrors;
    return makeConsole(opts.stdout, opts.stderr, opts);
  }
}

// -----------------------------------------------------------------------------
// tty

export function isatty(fd: number): boolean {
  try {
    return !!sys('isatty', { fd });
  } catch {
    return false;
  }
}
export const tty = { isatty, ReadStream: StdReadStream, WriteStream: StdWriteStream };

// -----------------------------------------------------------------------------
// timers

const timersPromises = {
  setTimeout(ms?: number, value?: unknown, opts: { signal?: AbortSignal; ref?: boolean } = {}) {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortErr(opts.signal));
      const t = loop.setTimeout(() => resolve(value), ms);
      if (opts.ref === false) t.unref();
      opts.signal?.addEventListener('abort', () => {
        loop.clearTimeout(t);
        reject(abortErr(opts.signal!));
      });
    });
  },
  setImmediate(value?: unknown, opts: { signal?: AbortSignal; ref?: boolean } = {}) {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortErr(opts.signal));
      const i = loop.setImmediate(() => resolve(value));
      if (opts.ref === false) i.unref();
    });
  },
  async *setInterval(ms?: number, value?: unknown, opts: { signal?: AbortSignal; ref?: boolean } = {}) {
    let pending = 0;
    let wake: (() => void) | null = null;
    const t = loop.setInterval(() => {
      pending++;
      wake?.();
    }, ms);
    if (opts.ref === false) t.unref();
    try {
      for (;;) {
        if (opts.signal?.aborted) throw abortErr(opts.signal);
        if (!pending) await new Promise<void>((r) => (wake = r));
        wake = null;
        pending--;
        yield value;
      }
    } finally {
      loop.clearInterval(t);
    }
  },
  scheduler: {
    wait: (ms: number, opts?: { signal?: AbortSignal }) => timersPromises.setTimeout(ms, undefined, opts),
    yield: () => timersPromises.setImmediate(),
  },
};

function abortErr(signal: AbortSignal) {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal.reason });
}

export const timers = {
  setTimeout: loop.setTimeout,
  clearTimeout: loop.clearTimeout,
  setInterval: loop.setInterval,
  clearInterval: loop.clearInterval,
  setImmediate: loop.setImmediate,
  clearImmediate: loop.clearImmediate,
  promises: timersPromises,
  active: (t: any) => t?.refresh?.(),
  unenroll: (t: any) => loop.clearTimeout(t),
  enroll: () => {},
};
export { timersPromises };

// -----------------------------------------------------------------------------
// vm

const kContext = Symbol('vm.context');

export class Script {
  constructor(public code: string, public opts: any = {}) {
    if (typeof opts === 'string') this.opts = { filename: opts };
  }
  runInThisContext(_o?: unknown) {
    return runInThisContext(this.code, this.opts);
  }
  runInContext(ctx: object, _o?: unknown) {
    return runInContext(this.code, ctx, this.opts);
  }
  runInNewContext(ctx?: object, _o?: unknown) {
    return runInNewContext(this.code, ctx, this.opts);
  }
  createCachedData() {
    return Buffer.alloc(0);
  }
  cachedDataRejected = false;
}

export function runInThisContext(code: string, opts?: any) {
  const filename = typeof opts === 'string' ? opts : opts?.filename;
  return (0, eval)(filename ? `${code}\n//# sourceURL=${filename}` : code);
}

export function createContext(sandbox: any = {}) {
  Object.defineProperty(sandbox, kContext, { value: true, enumerable: false });
  return sandbox;
}

export function isContext(o: any) {
  return !!o?.[kContext];
}

export function runInContext(code: string, ctx: any, opts?: any) {
  const filename = typeof opts === 'string' ? opts : opts?.filename;
  // best effort: evaluate with the context's properties in scope
  const fn = new Function('__ov_ctx', `with (__ov_ctx) { return eval(${JSON.stringify(code + (filename ? `\n//# sourceURL=${filename}` : ''))}); }`);
  return fn(new Proxy(ctx, { has: (t, k) => k !== '__ov_ctx' && (k in t || !(k in globalThis)) }));
}

export function runInNewContext(code: string, ctx: any = {}, opts?: any) {
  return runInContext(code, createContext(ctx), opts);
}

export function compileFunction(code: string, params: string[] = [], opts: any = {}) {
  const fn = new Function(...params, `${code}\n//# sourceURL=${opts.filename ?? 'vm.compileFunction'}`);
  return fn;
}

export const vm = {
  Script,
  runInThisContext,
  runInContext,
  runInNewContext,
  createContext,
  isContext,
  compileFunction,
  measureMemory: () => Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
  constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'), DONT_CONTEXTIFY: Symbol('vm_context_no_contextify') },
  SourceTextModule: undefined,
  SyntheticModule: undefined,
};

// -----------------------------------------------------------------------------
// async_hooks

let currentStores = new Map<AsyncLocalStorage<unknown>, unknown>();

export class AsyncLocalStorage<T> {
  private enabled = true;
  static bind<F extends (...a: any[]) => any>(fn: F): F {
    const snap = new Map(currentStores);
    return function (this: unknown, ...args: any[]) {
      const prev = currentStores;
      currentStores = snap;
      try {
        return fn.apply(this, args);
      } finally {
        currentStores = prev;
      }
    } as F;
  }
  static snapshot() {
    const snap = new Map(currentStores);
    return (fn: (...a: any[]) => any, ...args: any[]) => {
      const prev = currentStores;
      currentStores = snap;
      try {
        return fn(...args);
      } finally {
        currentStores = prev;
      }
    };
  }
  getStore(): T | undefined {
    return this.enabled ? (currentStores.get(this) as T | undefined) : undefined;
  }
  run<R>(store: T, fn: (...a: any[]) => R, ...args: any[]): R {
    const prev = currentStores;
    const next = new Map(currentStores);
    next.set(this, store);
    currentStores = next;
    let r: R;
    try {
      r = fn(...args);
    } catch (e) {
      currentStores = prev;
      throw e;
    }
    if (r && typeof (r as any).then === 'function') {
      // no native async context in browsers: keep the store until the promise settles
      (r as any).then(
        () => {
          if (currentStores === next) currentStores = prev;
        },
        () => {
          if (currentStores === next) currentStores = prev;
        },
      );
    } else currentStores = prev;
    return r;
  }
  exit<R>(fn: (...a: any[]) => R, ...args: any[]): R {
    const prev = currentStores;
    const next = new Map(currentStores);
    next.delete(this);
    currentStores = next;
    try {
      return fn(...args);
    } finally {
      currentStores = prev;
    }
  }
  enterWith(store: T) {
    const next = new Map(currentStores);
    next.set(this, store);
    currentStores = next;
  }
  disable() {
    this.enabled = false;
  }
}

export class AsyncResource {
  type: string;
  private snap = new Map(currentStores);
  constructor(type: string, _opts?: unknown) {
    this.type = type;
  }
  runInAsyncScope<R>(fn: (...a: any[]) => R, thisArg?: unknown, ...args: any[]): R {
    const prev = currentStores;
    currentStores = this.snap;
    try {
      return fn.apply(thisArg, args);
    } finally {
      currentStores = prev;
    }
  }
  bind<F extends (...a: any[]) => any>(fn: F): F {
    return ((...args: any[]) => this.runInAsyncScope(fn, undefined, ...args)) as F;
  }
  static bind<F extends (...a: any[]) => any>(fn: F, type = 'bound-anonymous-fn'): F {
    return new AsyncResource(type).bind(fn);
  }
  emitDestroy() {
    return this;
  }
  asyncId() {
    return 1;
  }
  triggerAsyncId() {
    return 0;
  }
}

export const asyncHooks = {
  AsyncLocalStorage,
  AsyncResource,
  createHook: () => ({ enable() {
    return this;
  }, disable() {
    return this;
  } }),
  executionAsyncId: () => 1,
  triggerAsyncId: () => 0,
  executionAsyncResource: () => ({}),
  asyncWrapProviders: {},
};

// -----------------------------------------------------------------------------
// perf_hooks

export const perfHooks = {
  performance: Object.assign(Object.create(null), {
    now: () => perfNow(),
    timeOrigin: performance.timeOrigin,
    mark: (...a: any[]) => (performance.mark as any)(...a),
    measure: (...a: any[]) => (performance.measure as any)(...a),
    getEntries: () => performance.getEntries(),
    getEntriesByName: (n: string, t?: string) => performance.getEntriesByName(n, t),
    getEntriesByType: (t: string) => performance.getEntriesByType(t),
    clearMarks: (n?: string) => performance.clearMarks(n),
    clearMeasures: (n?: string) => performance.clearMeasures(n),
    timerify: <F extends (...a: any[]) => any>(fn: F) => fn,
    eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    nodeTiming: { name: 'node', entryType: 'node', startTime: 0, duration: perfNow(), nodeStart: 0, v8Start: 0, environment: 0, bootstrapComplete: 0, loopStart: 0, loopExit: -1, idleTime: 0 },
    toJSON: () => ({ timeOrigin: performance.timeOrigin }),
  }),
  PerformanceObserver: (globalThis as any).PerformanceObserver ?? class {
    observe() {}
    disconnect() {}
    static supportedEntryTypes = [];
  },
  PerformanceEntry: (globalThis as any).PerformanceEntry,
  PerformanceMark: (globalThis as any).PerformanceMark,
  PerformanceMeasure: (globalThis as any).PerformanceMeasure,
  monitorEventLoopDelay: () => histogram(),
  createHistogram: () => histogram(),
  constants: { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 },
};

function histogram() {
  return { enable() {}, disable() {}, reset() {}, percentile: () => 0, percentiles: new Map(), min: 0, max: 0, mean: 0, stddev: 0, count: 0, exceeds: 0, record() {}, recordDelta() {} };
}

// -----------------------------------------------------------------------------
// dns (no real DNS: names resolve to stand-in addresses; real traffic goes through the proxy by hostname)

function fakeAddress(host: string, family = 4) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) return family === 6 ? '::1' : '127.0.0.1';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  return family === 6 ? '64:ff9b::1' : '198.18.0.1';
}

export const dns = {
  lookup(host: string, opts: any, cb?: any) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (typeof opts === 'number') opts = { family: opts };
    const family = opts?.family === 6 ? 6 : 4;
    const address = fakeAddress(host, family);
    loop.nextTick(() => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)));
  },
  lookupService(addr: string, port: number, cb: any) {
    loop.nextTick(() => cb(null, addr === '127.0.0.1' ? 'localhost' : addr, String(port)));
  },
  resolve: (_h: string, ...a: any[]) => {
    const cb = a.pop();
    loop.nextTick(() => cb(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })));
  },
  getDefaultResultOrder: () => 'ipv4first',
  setDefaultResultOrder: () => {},
  getServers: () => ['127.0.0.53'],
  setServers: () => {},
  ADDRCONFIG: 1024,
  V4MAPPED: 2048,
  ALL: 256,
  NOTFOUND: 'ENOTFOUND',
  promises: {
    lookup: async (host: string, opts: any = {}) => {
      if (typeof opts === 'number') opts = { family: opts };
      const family = opts?.family === 6 ? 6 : 4;
      const address = fakeAddress(host, family);
      return opts?.all ? [{ address, family }] : { address, family };
    },
    resolve: async () => {
      throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    resolve4: async () => {
      throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    resolve6: async () => {
      throw Object.assign(new Error('queryAAAA ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    getDefaultResultOrder: () => 'ipv4first',
    setDefaultResultOrder: () => {},
    Resolver: class {
      resolve4() {
        return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      }
      setServers() {}
    },
  },
  Resolver: class {
    resolve4(_h: string, cb: any) {
      loop.nextTick(() => cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })));
    }
    setServers() {}
    cancel() {}
  },
};

// -----------------------------------------------------------------------------
// v8

export const v8 = {
  getHeapStatistics: () => ({ total_heap_size: 50e6, total_heap_size_executable: 1e6, total_physical_size: 50e6, total_available_size: 4e9, used_heap_size: 40e6, heap_size_limit: 4e9, malloced_memory: 1e5, peak_malloced_memory: 1e6, does_zap_garbage: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0, total_global_handles_size: 8192, used_global_handles_size: 2000, external_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
  setFlagsFromString: () => {},
  cachedDataVersionTag: () => 0,
  serialize: (v: unknown) => Buffer.from(new TextEncoder().encode(JSON.stringify(v))),
  deserialize: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)),
  writeHeapSnapshot: () => '',
  getHeapSnapshot: () => {
    throw new Error('not supported');
  },
  takeCoverage: () => {},
  stopCoverage: () => {},
  isStringOneByteRepresentation: (s: string) => /^[\x00-\xff]*$/.test(s),
  startupSnapshot: { isBuildingSnapshot: () => false, addSerializeCallback() {}, addDeserializeCallback() {}, setDeserializeMainFunction() {} },
  promiseHooks: { onInit: () => () => {}, onSettled: () => () => {}, onBefore: () => () => {}, onAfter: () => () => {}, createHook: () => () => {} },
  Serializer: class {},
  Deserializer: class {},
  DefaultSerializer: class {},
  DefaultDeserializer: class {},
  GCProfiler: class {
    start() {}
    stop() {
      return {};
    }
  },
};

// -----------------------------------------------------------------------------
// diagnostics_channel

const channels = new Map<string | symbol, Channel>();
class Channel {
  private subs = new Set<(msg: unknown, name: string | symbol) => void>();
  private stores = new Map<any, (m: unknown) => unknown>();
  constructor(public name: string | symbol) {}
  get hasSubscribers() {
    return this.subs.size > 0 || this.stores.size > 0;
  }
  publish(msg: unknown) {
    for (const s of this.subs) {
      try {
        s(msg, this.name);
      } catch (e) {
        loop.nextTick(() => {
          throw e;
        });
      }
    }
  }
  subscribe(fn: (msg: unknown, name: string | symbol) => void) {
    this.subs.add(fn);
  }
  unsubscribe(fn: (msg: unknown, name: string | symbol) => void) {
    return this.subs.delete(fn);
  }
  bindStore(store: any, transform?: (m: unknown) => unknown) {
    this.stores.set(store, transform ?? ((m) => m));
  }
  unbindStore(store: any) {
    return this.stores.delete(store);
  }
  runStores<R>(data: unknown, fn: (...a: any[]) => R, thisArg?: unknown, ...args: any[]): R {
    this.publish(data);
    return fn.apply(thisArg, args);
  }
}
function channel(name: string | symbol) {
  let c = channels.get(name);
  if (!c) {
    c = new Channel(name);
    channels.set(name, c);
  }
  return c;
}
function tracingChannel(nameOrChannels: any) {
  const mk = (n: string) => (typeof nameOrChannels === 'string' ? channel(`tracing:${nameOrChannels}:${n}`) : nameOrChannels[n]);
  const t: any = { start: mk('start'), end: mk('end'), asyncStart: mk('asyncStart'), asyncEnd: mk('asyncEnd'), error: mk('error') };
  Object.defineProperty(t, 'hasSubscribers', { get: () => Object.values(t).some((c: any) => c?.hasSubscribers) });
  t.subscribe = (h: any) => {
    for (const k of Object.keys(h)) t[k]?.subscribe(h[k]);
  };
  t.unsubscribe = (h: any) => {
    for (const k of Object.keys(h)) t[k]?.unsubscribe(h[k]);
  };
  t.traceSync = (fn: any, ctx: any = {}, thisArg?: unknown, ...args: any[]) => fn.apply(thisArg, args);
  t.tracePromise = (fn: any, ctx: any = {}, thisArg?: unknown, ...args: any[]) => fn.apply(thisArg, args);
  t.traceCallback = (fn: any, _pos: number, ctx: any = {}, thisArg?: unknown, ...args: any[]) => fn.apply(thisArg, args);
  return t;
}
export const diagnosticsChannel = {
  channel,
  hasSubscribers: (n: string | symbol) => channels.get(n)?.hasSubscribers ?? false,
  subscribe: (n: string | symbol, fn: any) => channel(n).subscribe(fn),
  unsubscribe: (n: string | symbol, fn: any) => channel(n).unsubscribe(fn),
  tracingChannel,
  Channel,
};

// -----------------------------------------------------------------------------
// punycode (encode/decode per RFC 3492)

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
function adapt(delta: number, num: number, first: boolean) {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / num);
  let k = 0;
  while (delta > ((BASE - TMIN) * TMAX) >> 1) {
    delta = Math.floor(delta / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + SKEW));
}
const digit = (d: number) => String.fromCharCode(d + 22 + 75 * +(d < 26));
function pEncode(input: string): string {
  const cps = [...input].map((c) => c.codePointAt(0)!);
  let n = 128;
  let delta = 0;
  let bias = 72;
  let out = cps.filter((c) => c < 128).map((c) => String.fromCharCode(c)).join('');
  const b = out.length;
  let h = b;
  if (b) out += '-';
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
          if (q < t) break;
          out += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        out += digit(q);
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}
function pDecode(input: string): string {
  const out: number[] = [];
  let n = 128;
  let i = 0;
  let bias = 72;
  let basic = input.lastIndexOf('-');
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) out.push(input.charCodeAt(j));
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      const cp = input.charCodeAt(idx++);
      const d = cp - 48 < 10 ? cp - 22 : cp - 65 < 26 ? cp - 65 : cp - 97 < 26 ? cp - 97 : BASE;
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
export const punycode = {
  version: '2.1.0',
  encode: pEncode,
  decode: pDecode,
  toASCII: (d: string) => d.split('.').map((l) => (/[^\0-\x7f]/.test(l) ? 'xn--' + pEncode(l) : l)).join('.'),
  toUnicode: (d: string) => d.split('.').map((l) => (l.startsWith('xn--') ? pDecode(l.slice(4).toLowerCase()) : l)).join('.'),
  ucs2: { decode: (s: string) => [...s].map((c) => c.codePointAt(0)!), encode: (a: number[]) => String.fromCodePoint(...a) },
};

// -----------------------------------------------------------------------------
// stubs

export const inspector = {
  open() {},
  close() {},
  url: () => undefined,
  waitForDebugger() {},
  console: globalThis.console,
  Session: class extends EventEmitter {
    connect() {}
    connectToMainThread() {}
    disconnect() {}
    post(_m: string, _p?: unknown, cb?: (e: Error | null) => void) {
      cb?.(new Error('inspector is not available'));
    }
  },
  Network: { requestWillBeSent() {}, responseReceived() {}, loadingFinished() {}, loadingFailed() {} },
};

function unsupportedModule(name: string) {
  return new Proxy(
    {},
    {
      get(_t, k) {
        if (k === '__esModule' || typeof k === 'symbol' || k === 'then') return undefined;
        return function unsupported() {
          throw Object.assign(new Error(`${name}.${String(k)} is not supported in OpenVessel`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
        };
      },
    },
  );
}

export const cluster = Object.assign(new EventEmitter(), { isMaster: true, isPrimary: true, isWorker: false, workers: {}, settings: {}, setupMaster() {}, setupPrimary() {}, fork: () => {
  throw new Error('cluster.fork is not supported');
}, SCHED_NONE: 1, SCHED_RR: 2, schedulingPolicy: 2 });
export const dgram = { createSocket: () => {
  throw Object.assign(new Error('UDP sockets are not supported in OpenVessel'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
}, Socket: class {} };
const H2_HEADERS = ['STATUS', 'METHOD', 'AUTHORITY', 'SCHEME', 'PATH', 'PROTOCOL', 'ACCEPT', 'ACCEPT_ENCODING', 'ACCEPT_LANGUAGE', 'AUTHORIZATION', 'CACHE_CONTROL', 'CONNECTION', 'CONTENT_ENCODING', 'CONTENT_LENGTH', 'CONTENT_TYPE', 'COOKIE', 'DATE', 'ETAG', 'HOST', 'IF_MODIFIED_SINCE', 'IF_NONE_MATCH', 'LAST_MODIFIED', 'LOCATION', 'RANGE', 'REFERER', 'SET_COOKIE', 'TRANSFER_ENCODING', 'UPGRADE', 'USER_AGENT', 'VARY', 'X_FORWARDED_FOR'];
const h2Unsupported = function () {
  throw Object.assign(new Error('HTTP/2 is not supported in OpenVessel'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
};
export const http2: any = {
  constants: Object.fromEntries([
    ...H2_HEADERS.map((h) => [`HTTP2_HEADER_${h}`, h === 'STATUS' || h === 'METHOD' || h === 'AUTHORITY' || h === 'SCHEME' || h === 'PATH' || h === 'PROTOCOL' ? ':' + h.toLowerCase() : h.toLowerCase().replace(/_/g, '-')]),
    ...['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT'].map((m) => [`HTTP2_METHOD_${m}`, m]),
    ['HTTP_STATUS_OK', 200], ['HTTP_STATUS_NOT_FOUND', 404], ['HTTP_STATUS_INTERNAL_SERVER_ERROR', 500], ['NGHTTP2_CANCEL', 8], ['NGHTTP2_NO_ERROR', 0],
  ]),
  Http2ServerRequest: class Http2ServerRequest {},
  Http2ServerResponse: class Http2ServerResponse {},
  Http2Session: class Http2Session extends EventEmitter {},
  ClientHttp2Session: class ClientHttp2Session extends EventEmitter {},
  ServerHttp2Session: class ServerHttp2Session extends EventEmitter {},
  Http2Stream: class Http2Stream extends EventEmitter {},
  createServer: h2Unsupported,
  createSecureServer: h2Unsupported,
  connect: h2Unsupported,
  getDefaultSettings: () => ({}),
  getPackedSettings: () => new Uint8Array(0),
  getUnpackedSettings: () => ({}),
  sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
};
export const tls = {
  connect: () => {
    throw Object.assign(new Error('TLS sockets are not supported in OpenVessel'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  },
  createServer: () => {
    throw new Error('tls.createServer is not supported');
  },
  createSecureContext: () => ({}),
  checkServerIdentity: () => undefined,
  rootCertificates: [] as string[],
  DEFAULT_ECDH_CURVE: 'auto',
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
  getCiphers: () => ['tls_aes_256_gcm_sha384'],
  TLSSocket: class extends EventEmitter {},
  Server: class extends EventEmitter {},
  SecureContext: class {},
};
export const traceEvents = { createTracing: () => ({ enable() {}, disable() {}, enabled: false, categories: '' }), getEnabledCategories: () => undefined };
export const domain = {
  create: () => {
    const d: any = new EventEmitter();
    d.run = (fn: () => unknown) => fn();
    d.add = () => {};
    d.remove = () => {};
    d.bind = (fn: any) => fn;
    d.intercept = (fn: any) => fn;
    d.enter = () => {};
    d.exit = () => {};
    d.dispose = () => {};
    return d;
  },
  active: null,
};
export const repl = {
  start: () => {
    throw new Error('repl is not supported yet');
  },
  builtinModules: [] as string[],
};
export const testModule = new Proxy(
  {},
  {
    get(_t, k) {
      if (k === 'then' || typeof k === 'symbol') return undefined;
      return () => {
        throw new Error('node:test is not supported in OpenVessel');
      };
    },
  },
);
export const sea = { isSea: () => false, getAsset: () => {
  throw new Error('not a SEA');
} };
export const sqlite = unsupportedModule('sqlite');

void format;
