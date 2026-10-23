// Bindings for the process and the event loop: process_methods, credentials, task_queue, timers,
// errors, symbols, async_wrap, trace_events, performance, mksnapshot, config, constants, uv, os.

import { sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { fromShape, shapeOf } from './shape.ts';
import { perfNow, timeOrigin } from '../../node/native.ts';
import { hardwareConcurrency, nativeQueueMicrotask } from '../web.ts';
import { Histogram, createELDHistogram } from './performance.ts';

const enc = new TextEncoder();
const t0 = perfNow();

function writeFd(fd: number, s: string) {
  try {
    sys('write', { fd, pos: null }, enc.encode(s));
  } catch {}
}

export function createProcessMethods() {
  const b = fromShape('process_methods');
  const hr = b.hrtimeBuffer as Uint32Array;
  const hr64 = new BigUint64Array(hr.buffer, 0, 1);
  let emitWarningSync: ((msg: string, type?: string, code?: string) => void) | null = null;
  Object.assign(b, {
    hrtime() {
      const ns = BigInt(Math.round((timeOrigin + perfNow()) * 1e6));
      const sec = ns / 1_000_000_000n;
      hr[0] = Number(sec >> 32n);
      hr[1] = Number(sec & 0xffffffffn);
      hr[2] = Number(ns % 1_000_000_000n);
    },
    hrtimeBigInt() {
      hr64[0] = BigInt(Math.round((timeOrigin + perfNow()) * 1e6));
    },
    uptime: () => (perfNow() - t0) / 1000,
    cwd: () => {
      S.cwd = sys<string>('getcwd');
      return S.cwd;
    },
    chdir(dir: string) {
      sys('chdir', { p: dir });
      S.cwd = sys<string>('getcwd');
    },
    umask(mask?: number) {
      return sys<number>('umask', mask === undefined ? {} : { mask });
    },
    memoryUsage(out: Float64Array) {
      const m = (performance as any).memory;
      const used = m?.usedJSHeapSize ?? 50e6;
      out[0] = used * 1.5;
      out[1] = m?.totalJSHeapSize ?? used;
      out[2] = used;
      out[3] = 0;
      out[4] = 0;
    },
    rss: () => ((performance as any).memory?.usedJSHeapSize ?? 50e6) * 1.5,
    constrainedMemory: () => 0,
    availableMemory: () => 4 * 1024 ** 3,
    cpuUsage(out: Float64Array) {
      out[0] = Math.round((perfNow() - t0) * 1000);
      out[1] = 0;
    },
    threadCpuUsage(out: Float64Array) {
      out[0] = Math.round((perfNow() - t0) * 1000);
      out[1] = 0;
    },
    resourceUsage(out: Float64Array) {
      out.fill(0);
      out[0] = Math.round((perfNow() - t0) * 1000);
      out[2] = 100000;
    },
    _getActiveRequests: () => [],
    _getActiveHandles: () => [],
    getActiveResourcesInfo: () => loop.activeResources(),
    _kill(pid: number, sig: number) {
      try {
        sys('kill', { pid, sig });
        return 0;
      } catch (e: any) {
        return -({ ESRCH: 3, EPERM: 1, EINVAL: 22 } as Record<string, number>)[e?.code] || -3;
      }
    },
    _rawDebug: (s: string) => writeFd(2, s + '\n'),
    _debugProcess: () => {},
    _debugEnd: () => {},
    abort: () => loop.reallyExit(134),
    causeSegfault: () => loop.reallyExit(139),
    dlopen() {
      const e = new Error('Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.') as Error & { code: string };
      e.code = 'ERR_DLOPEN_FAILED';
      throw e;
    },
    reallyExit: (code: number) => loop.reallyExit(code),
    execve() {
      const e = new Error('process.execve is not supported in OpenVessel') as Error & { code: string };
      e.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
      throw e;
    },
    patchProcessObject(process: any) {
      const init = S.init;
      let title = (init.argv[0] ?? 'node').split('/').pop() || 'node';
      Object.defineProperty(process, 'title', {
        __proto__: null,
        get: () => title,
        set: (v: unknown) => {
          title = String(v);
        },
        enumerable: true,
        configurable: true,
      } as PropertyDescriptor);
      process.argv = [...S.argv];
      process.execArgv = [...S.execArgv];
      process.pid = init.pid;
      process.ppid = init.ppid;
      process.execPath = '/usr/bin/node';
      let debugPort = 9229;
      Object.defineProperty(process, 'debugPort', {
        __proto__: null,
        get: () => debugPort,
        set: (v: number) => {
          debugPort = v;
        },
        enumerable: true,
        configurable: true,
      } as PropertyDescriptor);
    },
    loadEnvFile(path?: string) {
      const text = new TextDecoder().decode(sys<Uint8Array>('readFile', { p: path ?? '.env' }));
      const parsed = S.internalBinding('util').parseEnv(text);
      for (const [k, v] of Object.entries(parsed)) if (S.process.env[k] === undefined) S.process.env[k] = v;
    },
    setEmitWarningSync(fn: typeof emitWarningSync) {
      emitWarningSync = fn;
    },
    resetStdioForTesting: () => {},
  });
  return b;
}

export function createCredentials() {
  const b = fromShape('credentials');
  return Object.assign(b, {
    safeGetenv: (k: string) => S.process?.env?.[k] ?? S.init.env[k],
    getTempDir: () => S.init.env.TMPDIR || '/tmp',
    implementsPosixCredentials: true,
    getuid: () => 1000,
    geteuid: () => 1000,
    getgid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    initgroups: () => {},
    setegid: () => {},
    seteuid: () => {},
    setgid: () => {},
    setuid: () => {},
    setgroups: () => {},
  });
}

export function createTaskQueue() {
  const b = fromShape('task_queue');
  const raw = b.tickInfo as Uint8Array;
  // Writes to tickInfo come from process.nextTick(); when that happens outside a callback scope
  // (inside a promise job), schedule the tick callback the way V8's microtask hooks would.
  const tickInfo = new Proxy(raw, {
    get: (t, k) => (t as any)[k],
    set(t, k, v) {
      (t as any)[k] = v;
      if (v === 1 || v === true) loop.onTickScheduled();
      return true;
    },
  });
  let rejectHandler: ((type: number, promise: Promise<unknown>, reason?: unknown) => void) | null = null;
  Object.assign(b, {
    tickInfo,
    enqueueMicrotask: (fn: () => void) => nativeQueueMicrotask(fn),
    runMicrotasks: () => {},
    setTickCallback(fn: () => void) {
      loop.setTickCallback(fn, raw);
    },
    setPromiseRejectCallback(fn: typeof rejectHandler) {
      rejectHandler = fn;
    },
  });
  S.onUnhandledRejection = (promise, reason) => {
    rejectHandler?.(0 /* kPromiseRejectWithNoHandler */, promise, reason);
    loop.onTickScheduled();
  };
  S.onRejectionHandled = (promise) => {
    rejectHandler?.(1 /* kPromiseHandlerAddedAfterReject */, promise);
    loop.onTickScheduled();
  };
  return b;
}

export function createTimers() {
  const b = fromShape('timers');
  loop.setImmediateInfo(b.immediateInfo);
  return Object.assign(b, {
    setupTimers: (immediate: () => void, timers: (now: number) => number) => loop.setupTimers(immediate, timers),
    getLibuvNow: () => loop.now(),
    scheduleTimer: (ms: number) => loop.scheduleTimer(ms),
    toggleTimerRef: (v: boolean) => loop.toggleTimerRef(v),
    toggleImmediateRef: (v: boolean) => loop.toggleImmediateRef(v),
  });
}

export function createErrors() {
  const b = fromShape('errors');
  return Object.assign(b, {
    setPrepareStackTraceCallback(fn: (global: unknown, error: Error, trace: unknown[]) => string) {
      S.prepareStackTrace = fn;
    },
    setGetSourceMapErrorSource: () => {},
    setSourceMapsEnabled: () => {},
    setMaybeCacheGeneratedSourceMap: () => {},
    setEnhanceStackForFatalException(before: (e: Error) => string, after: (e: Error) => string) {
      S.enhanceStack = { before, after };
    },
    noSideEffectsToString: (v: unknown) => {
      try {
        return String(v);
      } catch {
        return '[object]';
      }
    },
    triggerUncaughtException: (err: unknown, fromPromise: boolean) => loop.triggerUncaughtException(err, fromPromise),
    /** Where an error was thrown (V8's Message), from the first frame of its stack. */
    getErrorSourcePositions(error: Error) {
      const top = String(error?.stack ?? '')
        .split('\n')
        .find((l) => /^\s+at /.test(l));
      const m = top && /\(?((?:file:\/\/|node:|\/)[^():]+|\[eval\][^():]*):(\d+):(\d+)\)?\s*$/.exec(top);
      if (!m) return { sourceLine: '', scriptResourceName: '', lineNumber: 0, startColumn: 0 };
      const file = m[1];
      const lineNumber = Number(m[2]);
      return { sourceLine: S.sourceLine?.(file, lineNumber) ?? '', scriptResourceName: file, lineNumber, startColumn: Number(m[3]) - 1 };
    },
  });
}

export function createSymbols() {
  const b = fromShape('symbols');
  S.perIsolateSymbols = b;
  return b;
}

export function createAsyncWrap() {
  const b = fromShape('async_wrap');
  const resources: unknown[] = [];
  return Object.assign(b, {
    setupHooks: () => {},
    setCallbackTrampoline: () => {},
    pushAsyncContext(asyncId: number, triggerId: number, resource: unknown) {
      const f = b.async_hook_fields as Uint32Array;
      const ids = b.async_id_fields as Float64Array;
      const stack = b.async_ids_stack as Float64Array;
      const offset = f[b.constants.kStackLength];
      if (offset * 2 + 1 < stack.length) {
        stack[2 * offset] = ids[0];
        stack[2 * offset + 1] = ids[1];
      }
      f[b.constants.kStackLength]++;
      ids[0] = asyncId;
      ids[1] = triggerId;
      resources[offset] = resource;
    },
    popAsyncContext(asyncId: number) {
      const f = b.async_hook_fields as Uint32Array;
      const ids = b.async_id_fields as Float64Array;
      const stack = b.async_ids_stack as Float64Array;
      const len = f[b.constants.kStackLength];
      if (len === 0) return false;
      if (ids[0] !== asyncId) {
        // mismatched pop: clear like C++ does after reporting
      }
      const offset = len - 1;
      ids[0] = stack[2 * offset];
      ids[1] = stack[2 * offset + 1];
      f[b.constants.kStackLength] = offset;
      resources.length = offset;
      return offset > 0;
    },
    executionAsyncResource: (i: number) => resources[i],
    clearAsyncIdStack() {
      const f = b.async_hook_fields as Uint32Array;
      const ids = b.async_id_fields as Float64Array;
      ids[0] = 0;
      ids[1] = 0;
      f[b.constants.kStackLength] = 0;
      resources.length = 0;
    },
    queueDestroyAsyncId: () => {},
    setPromiseHooks: () => {},
    getPromiseHooks: () => [undefined, undefined, undefined, undefined],
    registerDestroyHook: () => {},
    execution_async_resources: resources,
  });
}

export function createTraceEvents() {
  const b = fromShape('trace_events');
  return Object.assign(b, {
    getEnabledCategories: () => undefined,
    setTraceCategoryStateUpdateHandler: () => {},
    getCategoryEnabledBuffer: () => new Uint8Array(1),
    isTraceCategoryEnabled: () => false,
    trace: () => {},
    CategorySet: class CategorySet {
      enable() {}
      disable() {}
    },
  });
}

export function createPerformance() {
  const b = fromShape('performance');
  const ms = b.milestones as Float64Array;
  ms.fill(0);
  ms[b.constants.NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN] = 0;
  ms[b.constants.NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP] = timeOrigin * 1000;
  return Object.assign(b, {
    now: () => perfNow(),
    markBootstrapComplete: () => {
      ms[b.constants.NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE] = perfNow() * 1e6;
    },
    loopIdleTime: () => 0,
    uvMetricsInfo: () => [0, 0, 0],
    setupObservers: () => {},
    installGarbageCollectionTracking: () => {},
    removeGarbageCollectionTracking: () => {},
    notify: () => {},
    Histogram,
    createELDHistogram,
  });
}

export function createMksnapshot() {
  const b = fromShape('mksnapshot');
  return Object.assign(b, {
    runEmbedderPreload: () => {},
    setSerializeCallback: () => {},
    setDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
  });
}

export function createConfig() {
  const b = fromShape('config');
  return Object.assign(b, { hasInspector: false, isDebugBuild: false, noBrowserGlobals: false, getDefaultLocale: () => 'en-US' });
}

export function createUv() {
  const b = fromShape('uv');
  const map = new Map<number, [string, string]>((shapeOf('uv').__errmap as [number, [string, string]][]).map(([k, v]) => [k, v]));
  delete b.__errmap;
  return Object.assign(b, {
    errname: (err: number) => map.get(err)?.[0] ?? `Unknown system error ${err}`,
    getErrorMap: () => map,
    getErrorMessage: (err: number) => map.get(err)?.[1] ?? `Unknown system error ${err}`,
  });
}

export function createOs() {
  const b = fromShape('os');
  return Object.assign(b, {
    getHostname: () => S.init.hostname || 'openvessel',
    getLoadAvg: (out: Float64Array) => out.fill(0),
    getUptime: () => Math.floor(perfNow() / 1000) + 1000,
    getTotalMem: () => 8 * 1024 ** 3,
    getFreeMem: () => 4 * 1024 ** 3,
    getCPUs() {
      const n = hardwareConcurrency;
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push('OpenVessel Virtual CPU', 2400, 1000, 0, 500, 10000, 0);
      return out;
    },
    getInterfaceAddresses: () => ['lo', '127.0.0.1', '255.0.0.0', 'IPv4', '00:00:00:00:00:00', true, -1],
    getHomeDirectory: () => S.process?.env?.HOME ?? S.init.env.HOME ?? '/home/user',
    getUserInfo: () => ({ uid: 1000, gid: 1000, username: 'user', homedir: S.init.env.HOME ?? '/home/user', shell: '/bin/sh' }),
    setPriority: () => 0,
    getPriority: () => 0,
    getAvailableParallelism: () => hardwareConcurrency,
    getOSInformation: () => ['Linux', '6.8.0-openvessel', '#1 SMP OpenVessel', 'x86_64'],
    isBigEndian: false,
  });
}

/** Bindings whose recorded shape (constants only) is enough. */
export function createFromShapeOnly(name: string) {
  return fromShape(name);
}
