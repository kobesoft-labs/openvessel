// The browser's own crypto and clock, captured before any user code runs.
// Libraries (e.g. Go's wasm_exec.js in esbuild-wasm) may replace globalThis.crypto or
// performance with shims built on node:crypto / process.hrtime, which would recurse.

const webcrypto = globalThis.crypto;
const perf = globalThis.performance;

export const nativeCrypto = webcrypto;
const rawRandom = webcrypto.getRandomValues.bind(webcrypto);
/** Like crypto.getRandomValues, but also fills views on a SharedArrayBuffer (Node allows it, browsers don't). */
export const getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
  if (a && typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer) {
    const tmp = new Uint8Array(a.byteLength);
    rawRandom(tmp);
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(tmp);
    return a;
  }
  return rawRandom(a as any) as T;
};
export const randomUUID = webcrypto.randomUUID.bind(webcrypto);
export const perfNow = perf.now.bind(perf);
export const timeOrigin = perf.timeOrigin;
