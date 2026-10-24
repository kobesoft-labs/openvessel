// Bindings for the process and the event loop: process_methods, credentials, task_queue, timers,
// errors, symbols, async_wrap, trace_events, performance, mksnapshot, config, constants, uv, os.

import { sys } from '../../node/sys.ts';
import { NativeProxy } from '../proxies.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { fromShape, shapeOf } from './shape.ts';
import { perfNow, timeOrigin } from '../../node/native.ts';
import { hardwareConcurrency, nativeQueueMicrotask } from '../web.ts';
import { Histogram, createELDHistogram } from './performance.ts';
import { uvError } from './fs.ts';

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
      try {
        sys('chdir', { p: dir });
      } catch (e) {
        let cwd: string | undefined;
        try {
          cwd = sys<string>('getcwd');
        } catch {}
        throw uvError(e, 'chdir', cwd, dir);
      }
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
    _getActiveRequests: () => loop.activeRequestOwners(),
    _getActiveHandles: () => loop.activeHandleOwners().map((h: any) => h[S.perIsolateSymbols?.owner_symbol] ?? h),
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
    dlopen(_module: unknown, filename: string) {
      // what glibc's dlopen says about a file that isn't a shared object; a real one can't load here
      let message = 'Native addons (.node files) cannot run in OpenVessel. Use the WebAssembly build of the package.';
      try {
        const head = sys<Uint8Array>('readFile', { p: String(filename) });
        if (head.length < 64) message = `${filename}: file too short`;
        else if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) message = `${filename}: invalid ELF header`;
      } catch {
        message = `${filename}: cannot open shared object file: No such file or directory`;
      }
      const e = new Error(message) as Error & { code: string };
      e.code = 'ERR_DLOPEN_FAILED';
      throw e;
    },
    reallyExit(code: number) {
      // Environment::Exit with --trace-exit
      if (S.optionValues['--trace-exit']) {
        const who = S.isMainThread ? `node:${S.init.pid}` : `node:${S.init.pid}, thread:${S.init.threadId ?? S.init.tid}`;
        const frames = String(new Error().stack ?? '')
          .split('\n')
          .filter((l) => /^\s+at /.test(l) && !/\/runtime\/|node-process\.js/.test(l));
        writeFd(2, `(${who}) WARNING: Exited the environment with code ${code}\n${frames.join('\n')}\n`);
      }
      loop.reallyExit(code);
    },
    execve(file: string, args: string[], envPairs: string[]) {
      const env: Record<string, string> = {};
      for (const p of envPairs ?? []) {
        const i = p.indexOf('=');
        if (i > 0) env[p.slice(0, i)] = p.slice(i + 1);
      }
      const argv = (args ?? []).map(String);
      try {
        sys('execve', { argv: [file, ...argv.slice(1)], argv0: argv[0] ?? file, env });
      } catch (e: any) {
        // node_process_methods.cc: a failed execve() leaves nothing to return to
        const code = e?.code ?? 'EIO';
        const err = new Error(`process.execve failed with error code ${code}`);
        writeFd(2, `${err.stack}\n`);
        try {
          sys('kill', { pid: S.init.pid, sig: 6 });
        } catch {}
        return loop.reallyExit(134);
      }
      return loop.reallyExit(0);
    },
    patchProcessObject(process: any) {
      const init = S.init;
      // process-wide state: --title sets it; a worker thread can't change it (or debugPort)
      let title = (S.optionValues['--title'] as string) || (init.argv[0] ?? 'node').split('/').pop() || 'node';
      Object.defineProperty(process, 'title', {
        __proto__: null,
        get: () => title,
        set: (v: unknown) => {
          if (S.isMainThread) title = String(v);
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
          if (S.isMainThread) debugPort = v;
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

/** Entries of /etc/passwd or /etc/group: name → [id, primary gid (passwd)]. */
function readIdDb(file: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  try {
    const text = new TextDecoder().decode(sys<Uint8Array>('readFile', { p: file }));
    for (const line of text.split('\n')) {
      const f = line.split(':');
      if (f.length >= 3 && f[0]) out.set(f[0], [Number(f[2]), Number(f[3])]);
    }
  } catch {}
  return out;
}

/**
 * node_credentials.cc for an unprivileged user: ids are looked up in /etc/passwd and /etc/group
 * (getpwnam/getgrnam), and changing to another id fails with EPERM like setuid(2) does.
 */
export function createCredentials() {
  const b = fromShape('credentials');
  const ids = { uid: 1000, euid: 1000, gid: 1000, egid: 1000 };
  const notFound = -1;
  const byName = (v: unknown, file: string): number => {
    if (typeof v === 'number') return v >>> 0;
    const e = readIdDb(file).get(String(v));
    return e ? e[0] : notFound;
  };
  const uidOf = (v: unknown) => byName(v, '/etc/passwd');
  const gidOf = (v: unknown) => byName(v, '/etc/group');
  const eperm = (syscall: string) => {
    const e = new Error('EPERM, Operation not permitted') as Error & { errno: number; code: string; syscall: string };
    e.errno = 1;
    e.code = 'EPERM';
    e.syscall = syscall;
    return e;
  };
  // setuid(2) without CAP_SETUID: only to the real or effective id
  const setter = (lookup: (v: unknown) => number, allowed: () => number[], set: (id: number) => void, syscall: string) => (v: unknown) => {
    const id = lookup(v);
    if (id === notFound) return 1;
    if (!allowed().includes(id)) throw eperm(syscall);
    set(id);
    return 0;
  };
  return Object.assign(b, {
    safeGetenv: (k: string) => S.process?.env?.[k] ?? S.init.env[k],
    // uv_os_tmpdir
    getTempDir() {
      const env = S.process?.env ?? S.init.env;
      for (const k of ['TMPDIR', 'TMP', 'TEMP', 'TEMPDIR']) {
        const v = env[k];
        if (v) return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v;
      }
      return '/tmp';
    },
    implementsPosixCredentials: true,
    getuid: () => ids.uid,
    geteuid: () => ids.euid,
    getgid: () => ids.gid,
    getegid: () => ids.egid,
    getgroups: () => [ids.gid],
    setuid: setter(uidOf, () => [ids.uid, ids.euid], (id) => (ids.uid = ids.euid = id), 'setuid'),
    seteuid: setter(uidOf, () => [ids.uid, ids.euid], (id) => (ids.euid = id), 'seteuid'),
    setgid: setter(gidOf, () => [ids.gid, ids.egid], (id) => (ids.gid = ids.egid = id), 'setgid'),
    setegid: setter(gidOf, () => [ids.gid, ids.egid], (id) => (ids.egid = id), 'setegid'),
    setgroups(groups: unknown[]) {
      for (let i = 0; i < groups.length; i++) if (gidOf(groups[i]) === notFound) return i + 1;
      throw eperm('setgroups');
    },
    initgroups(user: unknown, extraGroup: unknown) {
      if (gidOf(extraGroup) === notFound) return 2;
      if (uidOf(user) === notFound) return 1;
      throw eperm('initgroups');
    },
  });
}

export function createTaskQueue() {
  const b = fromShape('task_queue');
  const raw = b.tickInfo as Uint8Array;
  // Writes to tickInfo come from process.nextTick(); when that happens outside a callback scope
  // (inside a promise job), schedule the tick callback the way V8's microtask hooks would.
  const tickInfo = new NativeProxy(raw, {
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
    loop.holdRejection(promise, reason, (p, r) => rejectHandler?.(0 /* kPromiseRejectWithNoHandler */, p, r));
  };
  S.onRejectionHandled = (promise) => {
    if (loop.dropHeldRejection(promise)) return;
    rejectHandler?.(1 /* kPromiseHandlerAddedAfterReject */, promise);
    loop.onTickScheduled();
  };
  return b;
}

export function createTimers() {
  const b = fromShape('timers');
  loop.setImmediateInfo(b.immediateInfo);
  if (b.timeoutInfo) loop.setTimeoutInfo(b.timeoutInfo);
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

/** The hooks lib registered with setupHooks (init/before/after/destroy/promise_resolve). */
let nativeHooks: { init?: (asyncId: number, type: string, triggerAsyncId: number, resource: object) => void } | null = null;
let asyncWrap: any = null;

/** AsyncWrap::AsyncWrap → EmitAsyncInit for a resource created on the native side (a handle). Returns its async id. */
export function emitAsyncInit(resource: object, type: string): number {
  const b = asyncWrap;
  if (!b) return -1;
  const C = b.constants;
  const ids = b.async_id_fields as Float64Array;
  const id = ++ids[C.kAsyncIdCounter];
  const def = ids[C.kDefaultTriggerAsyncId];
  const trigger = def >= 0 ? def : ids[C.kExecutionAsyncId];
  if ((b.async_hook_fields as Uint32Array)[C.kInit] > 0 && typeof nativeHooks?.init === 'function') {
    nativeHooks.init(id, type, trigger, resource);
  }
  return id;
}

export function createAsyncWrap() {
  const b = fromShape('async_wrap');
  asyncWrap = b;
  // like Environment::AsyncHooks: lib keeps the JS array itself (and fills it before calling
  // pushAsyncContext), the native side has its own list for resources pushed from C++
  const resources: unknown[] = [];
  const native: unknown[] = [];
  // the dump was taken inside a callback: start from AsyncHooks' initial state instead
  const C = b.constants;
  (b.async_hook_fields as Uint32Array).fill(0);
  (b.async_hook_fields as Uint32Array)[C.kCheck] = 1;
  (b.async_ids_stack as Float64Array).fill(0);
  const ids = b.async_id_fields as Float64Array;
  ids[C.kExecutionAsyncId] = 1;
  ids[C.kTriggerAsyncId] = 0;
  ids[C.kAsyncIdCounter] = 1;
  ids[C.kDefaultTriggerAsyncId] = -1;
  // AsyncWrap::EmitDestroy: ids collect in a list that a native immediate drains
  let destroyHook: ((id: number) => void) | null = null;
  let destroyIds: number[] = [];
  const drainDestroyIds = () => {
    while (destroyIds.length) {
      const list = destroyIds;
      destroyIds = [];
      for (const id of list) destroyHook?.(id);
    }
  };
  return Object.assign(b, {
    setupHooks: (hooks: typeof nativeHooks & { destroy?: (id: number) => void }) => {
      nativeHooks = hooks;
      destroyHook = hooks?.destroy ?? null;
    },
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
      native[offset] = resource;
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
      if (native.length > offset) native.length = offset;
      if (resources.length > offset) resources.length = offset;
      return offset > 0;
    },
    executionAsyncResource: (i: number) => native[i],
    clearAsyncIdStack() {
      const f = b.async_hook_fields as Uint32Array;
      const ids = b.async_id_fields as Float64Array;
      ids[0] = 0;
      ids[1] = 0;
      f[b.constants.kStackLength] = 0;
      native.length = 0;
      resources.length = 0;
    },
    queueDestroyAsyncId(id: number) {
      if ((b.async_hook_fields as Uint32Array)[C.kDestroy] === 0 || !destroyHook) return;
      if (destroyIds.length === 0) loop.macrotask(() => loop.scope(drainDestroyIds));
      destroyIds.push(id);
    },
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
  return Object.assign(b, { hasInspector: true, isDebugBuild: false, noBrowserGlobals: false, getDefaultLocale: () => 'en-US' });
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
  // the nice value set through os.setPriority() on this process (an unprivileged user can only
  // lower the priority, like setpriority(2) without CAP_SYS_NICE)
  let ownPriority = 0;
  const own = (pid: number) => pid === 0 || pid === S.init.pid;
  const fail = (ctx: Record<string, unknown>, syscall: string, code: string) => {
    const uv = S.internalBinding('uv');
    ctx.errno = uv[`UV_${code}`];
    ctx.code = code;
    ctx.message = uv.getErrorMessage(ctx.errno);
    ctx.syscall = syscall;
  };
  const exists = (pid: number) => {
    try {
      sys('kill', { pid, sig: 0 });
      return true;
    } catch {
      return false;
    }
  };
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
    getUserInfo(options: { encoding?: string } | null) {
      // the options' getter runs (and may throw) like in node_os.cc
      const encoding = options ? options.encoding : undefined;
      const env = S.process?.env ?? S.init.env;
      const name = [...readIdDb('/etc/passwd')].find(([, v]) => v[0] === 1000)?.[0] ?? 'user';
      const info = { uid: 1000, gid: 1000, username: name, homedir: env.HOME ?? '/home/user', shell: '/bin/sh' };
      if (encoding !== 'buffer') return info;
      const B = S.requireBuiltin('buffer').Buffer;
      return { ...info, username: B.from(info.username), homedir: B.from(info.homedir), shell: B.from(info.shell) };
    },
    setPriority(pid: number, priority: number, ctx: Record<string, unknown>) {
      if (!own(pid)) {
        fail(ctx, 'uv_os_setpriority', pid < 0 || !exists(pid) ? 'ESRCH' : 'EACCES');
        return -1;
      }
      if (priority < ownPriority) {
        fail(ctx, 'uv_os_setpriority', 'EACCES');
        return -1;
      }
      ownPriority = priority;
      return 0;
    },
    getPriority(pid: number, ctx: Record<string, unknown>) {
      if (own(pid)) return ownPriority;
      if (pid < 0 || !exists(pid)) {
        fail(ctx, 'uv_os_getpriority', 'ESRCH');
        return undefined;
      }
      return 0;
    },
    getAvailableParallelism: () => hardwareConcurrency,
    getOSInformation: () => ['Linux', '6.8.0-openvessel', '#1 SMP OpenVessel', 'x86_64'],
    isBigEndian: false,
  });
}

/** Bindings whose recorded shape (constants only) is enough. */
export function createFromShapeOnly(name: string) {
  return fromShape(name);
}
