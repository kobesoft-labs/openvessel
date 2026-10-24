// The browser's own web APIs, captured when the worker script loads — before Node's bootstrap
// replaces the globals with lib implementations that call back into the bindings (using the
// globals from a binding would recurse).

const g = globalThis as any;

export const NativeURL: typeof URL = g.URL;
export const NativeURLSearchParams: typeof URLSearchParams = g.URLSearchParams;
export const NativeTextEncoder: typeof TextEncoder = g.TextEncoder;
export const NativeTextDecoder: typeof TextDecoder = g.TextDecoder;
export const NativeMessageChannel: typeof MessageChannel = g.MessageChannel;
export const NativeMessagePort: typeof MessagePort = g.MessagePort;
export const NativeBroadcastChannel: typeof BroadcastChannel = g.BroadcastChannel;
export const NativeBlob: typeof Blob = g.Blob;
export const nativeStructuredClone: typeof structuredClone = g.structuredClone.bind(g);
export const nativeQueueMicrotask: typeof queueMicrotask = g.queueMicrotask.bind(g);
export const nativeFetch: typeof fetch = g.fetch.bind(g);
export const NativeXMLHttpRequest: typeof XMLHttpRequest = g.XMLHttpRequest;
export const NativePerformanceObserver: typeof PerformanceObserver | undefined = g.PerformanceObserver;
export const nativePerformance: Performance = g.performance;
export const hardwareConcurrency: number = g.navigator?.hardwareConcurrency || 4;
