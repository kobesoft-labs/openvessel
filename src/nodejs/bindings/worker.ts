// internalBinding('worker') — node_worker.cc. A worker thread is another Web Worker of the same
// process, started by the kernel; the parent and the thread talk over a MessageChannel whose
// thread side becomes the thread's getEnvMessagePort(). Node's lib speaks its own protocol on it.

import { post, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { shareEnv } from '../env.ts';
import { workerOptionErrors } from '../options.ts';
import { S } from '../state.ts';
import { NodeMessagePort } from './messaging.ts';
import { emitAsyncInit } from './process.ts';
import { fromShape } from './shape.ts';
import { HandleWrap } from './stream.ts';

const workers = new Map<number, WorkerImpl>();
let exitHandlerInstalled = false;
function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  S.kernelHandlers.set('thread-exit', (msg: { tid: number; code: number; initFailed?: string }) => {
    workers.get(msg.tid)?._exited(msg.code, msg.initFailed);
  });
}

let nextReq = 1;

function nodeError(Ctor: ErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** The taker objects (WorkerHeapStatisticsTaker…): lib sets ondone, the answer comes on a later turn. */
function taker(answer: () => unknown[]) {
  const t: { ondone?: (...a: unknown[]) => void } = {};
  const done = loop.startReq('WorkerTaker');
  loop.macrotask(() => {
    done();
    if (typeof t.ondone === 'function') loop.scope(t.ondone, t, ...answer());
  });
  return t;
}

class WorkerImpl extends HandleWrap {
  threadId: number;
  threadName: string;
  messagePort: NodeMessagePort;
  onexit: ((code: number, customErr?: string, customErrReason?: string) => void) | null = null;
  invalidExecArgv?: string[];
  invalidNodeOptions?: string[];
  /** the kernel's thread id (Node's threadId is per process) */
  #tid: number;
  #child: { port: MessagePort; rings: [SharedArrayBuffer, SharedArrayBuffer] };
  #url: string | null;
  /** null: a copy of process.env; undefined: SHARE_ENV */
  #env: Record<string, string> | null | undefined;
  #execArgv: string[] | undefined;
  #limits: Float64Array;
  #trackFds: boolean;
  #started = 0;
  #running = false;
  #exited = false;
  /** closed after 'exit': hasRef() answers undefined */
  #gone = false;
  #refAtClose = false;
  #profiles = new Set<string>();

  constructor(url: string | null, env: Record<string, string> | null, execArgv: string[] | undefined, resourceLimits: Float64Array, trackFds: boolean, _isInternal: boolean, name?: string) {
    super('WorkerThread');
    // AsyncWrap first, then the parent port (MessagePort::New inside the Worker constructor)
    emitAsyncInit(this, 'WORKER');
    this.#url = url;
    this.#env = env;
    this.#execArgv = execArgv;
    this.#limits = resourceLimits ?? new Float64Array(4);
    this.#trackFds = trackFds;
    this.threadName = name || 'WorkerThread';
    const ids = sys<{ tid: number; threadId: number }>('threadReserve', { nodeId: true });
    this.#tid = ids.tid;
    this.threadId = ids.threadId;
    const pair = NodeMessagePort.pairForThread();
    this.messagePort = pair.port;
    this.#child = { port: pair.child, rings: pair.rings };
    workers.set(this.#tid, this);
    installExitHandler();
    this.#checkOptions(env, execArgv);
  }

  /** Worker::New: options the thread couldn't start with are reported to the constructor. */
  #checkOptions(env: Record<string, string> | null, execArgv: string[] | undefined) {
    if (env && env.NODE_OPTIONS !== undefined && env.NODE_OPTIONS !== S.process?.env?.NODE_OPTIONS) {
      const errs = workerOptionErrors(env.NODE_OPTIONS, true);
      if (errs) {
        this.invalidNodeOptions = errs;
        return;
      }
    }
    if (Array.isArray(execArgv)) {
      const errs = workerOptionErrors(execArgv.map(String), false);
      if (errs) this.invalidExecArgv = errs;
    }
  }

  startThread() {
    this.#started = Date.now();
    this.#running = true;
    this.setActive(true);
    const env = this.#env ?? { ...S.process.env };
    const sharedEnv = this.#env === undefined ? shareEnv() : undefined;
    post(
      {
        t: 'threadSpawn',
        reqId: nextReq++,
        tid: this.#tid,
        threadId: this.threadId,
        file: this.#url ?? '',
        eval: false,
        argv: [],
        execArgv: this.#execArgv ?? S.execArgv,
        env,
        port: this.#child.port,
        envRings: this.#child.rings,
        name: this.threadName,
        resourceLimits: [...this.#limits],
        trackUnmanagedFds: this.#trackFds,
        sharedEnv,
      },
      [this.#child.port],
    );
  }

  stopThread() {
    post({ t: 'threadKill', tid: this.#tid });
  }

  /** @internal */
  _exited(code: number, initFailed?: string) {
    if (this.#exited) return;
    this.#exited = true;
    this.#running = false;
    workers.delete(this.#tid);
    this.setActive(false);
    // Worker::Run: a thread that couldn't start reports ERR_WORKER_INIT_FAILED with the reason
    if (typeof this.onexit === 'function') loop.scope(this.onexit, this, code, ...(initFailed ? ['ERR_WORKER_INIT_FAILED', initFailed] : []));
    // the handle closes after the 'exit' event (Worker::OnThreadStopped → Close)
    this.#refAtClose = super.hasRef();
    this.close(() => {
      this.#gone = true;
    });
  }

  override hasRef(): boolean {
    if (this.#gone) return undefined as unknown as boolean; // like an unwrapped BaseObject
    // a closing handle still answers uv_has_ref
    return this._closed ? this.#refAtClose : super.hasRef();
  }

  getResourceLimits() {
    return this.#limits;
  }
  loopIdleTime() {
    return 0;
  }
  loopStartTime() {
    return this.#started ? this.#started - performance.timeOrigin : -1;
  }
  takeHeapSnapshot() {
    return undefined;
  }
  getHeapStatistics() {
    if (!this.#running) return undefined;
    const m = (performance as any).memory;
    const used = m?.usedJSHeapSize ?? 8e6;
    const total = m?.totalJSHeapSize ?? used;
    const limit = m?.jsHeapSizeLimit ?? 4 * 1024 ** 3;
    return taker(() => [
      {
        total_heap_size: total,
        total_heap_size_executable: 0,
        total_physical_size: total,
        total_available_size: Math.max(0, limit - used),
        used_heap_size: used,
        heap_size_limit: limit,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: false,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 0,
      },
    ]);
  }
  cpuUsage() {
    if (!this.#running) return undefined;
    // the thread's own CPU time isn't visible from here: wall time since it started
    return taker(() => [null, { user: Math.max(0, Date.now() - this.#started) * 1000, system: 0 }]);
  }
  startCpuProfile(name: string) {
    if (!this.#running) return undefined;
    const already = this.#profiles.has(name);
    this.#profiles.add(name);
    return taker(() => [already ? nodeError(Error, 'ERR_CPU_PROFILE_ALREADY_STARTED', 'CPU profile already started') : null]);
  }
  stopCpuProfile(name: string) {
    if (!this.#running) return undefined;
    const found = this.#profiles.delete(name);
    // no sampling profiler in the browser: an empty profile in V8's format
    const profile = JSON.stringify({ nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [] }], startTime: 0, endTime: 0, samples: [], timeDeltas: [] });
    return taker(() => (found ? [null, profile] : [nodeError(Error, 'ERR_CPU_PROFILE_NOT_STARTED', 'CPU profile not started'), undefined]));
  }
}

export function createWorkerBinding() {
  const b = fromShape('worker');
  const main = S.isMainThread;
  let envPort: NodeMessagePort | undefined;
  const limits = new Float64Array(4);
  if (!main && Array.isArray(S.init.resourceLimits)) limits.set(S.init.resourceLimits.slice(0, 4));
  return Object.assign(b, {
    Worker: WorkerImpl,
    getEnvMessagePort() {
      if (main || !S.init.port) return undefined;
      if (!envPort) {
        envPort = NodeMessagePort.wrap(S.init.port);
        const r = S.init.envRings;
        if (r) NodeMessagePort.adoptRings(envPort, r[0], r[1]);
      }
      return envPort;
    },
    isMainThread: main,
    isInternalThread: false,
    ownsProcessState: main,
    threadId: main ? 0 : (S.init.threadId ?? S.init.tid),
    threadName: main ? 'main' : S.init.name || 'WorkerThread',
    resourceLimits: limits,
  });
}
