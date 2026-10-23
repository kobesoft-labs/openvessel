// `process` for bundled libraries: forwards to the runtime's process once it exists.
const fallback: any = {
  env: {},
  nextTick: (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args)),
  version: 'v22.20.0',
  versions: { node: '22.20.0' },
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
