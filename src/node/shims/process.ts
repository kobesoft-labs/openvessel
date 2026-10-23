// `process` for bundled libraries: forwards to the runtime's process once it exists.
import { NODE_VERSION } from '../version.ts';

const fallback: any = {
  env: {},
  nextTick: (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args)),
  version: 'v' + NODE_VERSION,
  versions: { node: NODE_VERSION },
  platform: 'linux',
  argv: [],
  cwd: () => '/',
  emitWarning: () => {},
  stderr: { write: () => true },
};
const proc: any = new Proxy(fallback, {
  get(t, k) {
    const real = (globalThis as any).process;
    if (real && real !== proc) return real[k];
    return t[k];
  },
});
export default proc;
