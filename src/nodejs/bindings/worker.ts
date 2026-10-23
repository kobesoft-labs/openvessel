// internalBinding('worker') — node_worker.cc. A worker thread is another Web Worker of the same
// process, started by the kernel; the parent and the thread talk over a MessageChannel whose
// thread side becomes the thread's getEnvMessagePort(). Node's lib speaks its own protocol on it.

import { post, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { NativeMessageChannel } from '../web.ts';
import { NodeMessagePort } from './messaging.ts';
import { fromShape } from './shape.ts';
import { HandleWrap } from './stream.ts';

const workers = new Map<number, WorkerImpl>();
let exitHandlerInstalled = false;
function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  S.kernelHandlers.set('thread-exit', (msg: { tid: number; code: number }) => {
    workers.get(msg.tid)?._exited(msg.code);
  });
}

let nextReq = 1;

class WorkerImpl extends HandleWrap {
  threadId: number;
  threadName: string;
  messagePort: NodeMessagePort;
  onexit: ((code: number, customErr?: string, customErrReason?: string) => void) | null = null;
  invalidExecArgv?: string[];
  invalidNodeOptions?: string[];
  #childPort: MessagePort;
  #url: string | null;
  #env: Record<string, string> | null;
  #execArgv: string[] | undefined;
  #limits: Float64Array;
  #started = 0;
  #exited = false;

  constructor(url: string | null, env: Record<string, string> | null, execArgv: string[] | undefined, resourceLimits: Float64Array, _trackFds: boolean, _isInternal: boolean, name?: string) {
    super('WorkerThread');
    this.#url = url;
    this.#env = env;
    this.#execArgv = execArgv;
    this.#limits = resourceLimits ?? new Float64Array(4);
    this.threadName = name || 'WorkerThread';
    this.threadId = sys<number>('threadReserve', {});
    const ch = new NativeMessageChannel();
    this.messagePort = NodeMessagePort.wrap(ch.port1);
    this.#childPort = ch.port2;
    workers.set(this.threadId, this);
    installExitHandler();
  }

  startThread() {
    this.#started = Date.now();
    this.setActive(true);
    const env = this.#env ?? { ...S.process.env };
    post(
      {
        t: 'threadSpawn',
        reqId: nextReq++,
        tid: this.threadId,
        file: this.#url ?? '',
        eval: false,
        argv: [],
        execArgv: this.#execArgv ?? S.execArgv,
        env,
        port: this.#childPort,
        name: this.threadName,
      },
      [this.#childPort],
    );
  }

  stopThread() {
    post({ t: 'threadKill', tid: this.threadId });
  }

  /** @internal */
  _exited(code: number) {
    if (this.#exited) return;
    this.#exited = true;
    workers.delete(this.threadId);
    this.setActive(false);
    if (typeof this.onexit === 'function') loop.scope(this.onexit, this, code);
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
    return undefined;
  }
  cpuUsage() {
    return undefined;
  }
  startCpuProfile() {
    return undefined;
  }
  stopCpuProfile() {
    return undefined;
  }
}

export function createWorkerBinding() {
  const b = fromShape('worker');
  const main = S.isMainThread;
  let envPort: NodeMessagePort | undefined;
  return Object.assign(b, {
    Worker: WorkerImpl,
    getEnvMessagePort() {
      if (main || !S.init.port) return undefined;
      envPort ??= NodeMessagePort.wrap(S.init.port);
      return envPort;
    },
    isMainThread: main,
    isInternalThread: false,
    ownsProcessState: main,
    threadId: main ? 0 : S.init.tid,
    threadName: main ? 'main' : S.init.name || 'WorkerThread',
    resourceLimits: new Float64Array(4),
  });
}
