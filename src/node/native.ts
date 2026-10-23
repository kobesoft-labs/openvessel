// The browser's own crypto and clock, captured before any user code runs.
// Libraries (e.g. Go's wasm_exec.js in esbuild-wasm) may replace globalThis.crypto or
// performance with shims built on node:crypto / process.hrtime, which would recurse.

const webcrypto = globalThis.crypto;
const perf = globalThis.performance;

export const nativeCrypto = webcrypto;
export const getRandomValues = webcrypto.getRandomValues.bind(webcrypto) as <T extends ArrayBufferView | null>(a: T) => T;
export const randomUUID = webcrypto.randomUUID.bind(webcrypto);
export const perfNow = perf.now.bind(perf);
export const timeOrigin = perf.timeOrigin;
