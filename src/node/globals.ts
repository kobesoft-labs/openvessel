// Makes the worker global scope look like Node: hides browser/worker-only globals
// that libraries use to detect "running in a browser or web worker".

const HIDE = [
  'self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'WorkerLocation', 'WorkerNavigator', 'importScripts', 'postMessage', 'close',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'onmessage', 'onmessageerror', 'onerror', 'onunhandledrejection', 'onrejectionhandled', 'onlanguagechange', 'onoffline', 'ononline',
  'location', 'name', 'origin', 'isSecureContext', 'crossOriginIsolated', 'caches', 'indexedDB', 'IDBFactory',
  'XMLHttpRequest', 'XMLHttpRequestUpload', 'XMLHttpRequestEventTarget', 'FileReaderSync', 'Worker', 'SharedWorker',
  'requestAnimationFrame', 'cancelAnimationFrame', 'OffscreenCanvas', 'OffscreenCanvasRenderingContext2D', 'ImageBitmap', 'createImageBitmap',
  'Notification', 'trustedTypes', 'TrustedTypePolicy', 'TrustedTypePolicyFactory', 'reportError', 'webkitRequestFileSystem', 'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL', 'FontFace', 'FontFaceSet', 'fonts', 'scheduler', 'Scheduler', 'TaskController', 'TaskSignal',
  'GPU', 'gpu', 'serviceWorker', 'ServiceWorkerContainer', 'StorageManager', 'LockManager', 'Serial', 'HID', 'USB', 'MediaCapabilities',
];

export function hideBrowserGlobals() {
  const g = globalThis as any;
  for (const name of HIDE) {
    let obj: any = g;
    while (obj) {
      const d = Object.getOwnPropertyDescriptor(obj, name);
      if (d) {
        if (d.configurable) {
          try {
            delete obj[name];
          } catch {}
        } else {
          try {
            Object.defineProperty(g, name, { value: undefined, writable: true, configurable: true, enumerable: false });
          } catch {}
          break;
        }
      }
      obj = Object.getPrototypeOf(obj);
    }
  }
  const hc = (navigator as any)?.hardwareConcurrency ?? 4;
  const nav = { hardwareConcurrency: hc, language: 'en-US', languages: ['en-US'], platform: 'linux', userAgent: 'Node.js/22' };
  let obj: any = g;
  while (obj) {
    const d = Object.getOwnPropertyDescriptor(obj, 'navigator');
    if (d?.configurable) delete obj.navigator;
    obj = Object.getPrototypeOf(obj);
  }
  Object.defineProperty(g, 'navigator', { value: nav, writable: true, configurable: true, enumerable: true });
  matchNodeEnumerability();
}

/** Globals that `for (k in globalThis)` lists in Node; everything else we define or inherit from the Worker is hidden from enumeration. */
const NODE_ENUMERABLE = new Set(['global', 'clearImmediate', 'setImmediate', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout', 'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'performance', 'fetch', 'navigator', 'crypto']);

function matchNodeEnumerability() {
  const g = globalThis as any;
  for (const name in g) {
    if (NODE_ENUMERABLE.has(name)) continue;
    const own = Object.getOwnPropertyDescriptor(g, name);
    try {
      if (own) {
        if (own.configurable) Object.defineProperty(g, name, { enumerable: false });
      } else {
        // inherited from WorkerGlobalScope: shadow it with a non-enumerable own property that forwards
        let proto = Object.getPrototypeOf(g);
        let d: PropertyDescriptor | undefined;
        while (proto && !(d = Object.getOwnPropertyDescriptor(proto, name))) proto = Object.getPrototypeOf(proto);
        if (d && (d.get || d.set)) Object.defineProperty(g, name, { get: d.get && (() => d!.get!.call(g)), set: d.set && ((v: unknown) => d!.set!.call(g, v)), configurable: true, enumerable: false });
        else Object.defineProperty(g, name, { value: g[name], writable: true, configurable: true, enumerable: false });
      }
    } catch {}
  }
}
