// internalBinding('inspector'): there is no V8 inspector to attach to in a browser worker, but code
// that loads node:inspector (playwright, test runners, profilers) must still load. Sessions connect
// and every protocol method answers "not supported"; url() is undefined and nothing waits.

import { nativeQueueMicrotask } from '../web.ts';
import { fromShape } from './shape.ts';

type Callback = (message: string) => void;

class Connection {
  #cb: Callback | null;
  constructor(callback: Callback) {
    this.#cb = callback;
  }
  dispatch(message: string) {
    let id: unknown;
    try {
      id = JSON.parse(message).id;
    } catch {}
    const cb = this.#cb;
    const reply = JSON.stringify({ id, error: { code: -32601, message: 'The inspector is not available in OpenVessel' } });
    // the backend answers on a later turn
    if (cb) nativeQueueMicrotask(() => cb(reply));
  }
  disconnect() {
    this.#cb = null;
  }
}

export function createInspector() {
  return Object.assign(fromShape('inspector'), {
    Connection,
    MainThreadConnection: Connection,
    // console methods go to Node's console only (V8's inspector console has nothing to add)
    console: {},
    consoleCall(_inspectorMethod: unknown, nodeMethod: (...a: unknown[]) => unknown, ...args: unknown[]) {
      return nodeMethod.apply(this, args);
    },
    setConsoleExtensionInstaller() {},
    callAndPauseOnStart(fn: (...a: unknown[]) => unknown, thisArg: unknown, ...args: unknown[]) {
      return fn.apply(thisArg, args);
    },
    open() {},
    url: () => undefined,
    waitForDebugger: () => false,
    isEnabled: () => false,
    registerAsyncHook() {},
    asyncTaskScheduled() {},
    asyncTaskCanceled() {},
    asyncTaskStarted() {},
    asyncTaskFinished() {},
    emitProtocolEvent() {},
    setupNetworkTracking() {},
    putNetworkResource() {},
  });
}

// internalBinding('profiler'): V8 coverage (NODE_V8_COVERAGE) needs the inspector's profiler,
// which a browser worker doesn't expose; the directory is accepted and nothing is written.
export function createProfiler() {
  const b = fromShape('profiler');
  return Object.assign(b, {
    setCoverageDirectory: (_dir: string) => {},
    setSourceMapCacheGetter: (_fn: unknown) => {},
    takeCoverage: () => {},
    stopCoverage: () => {},
    endCoverage: () => {},
  });
}
