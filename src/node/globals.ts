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
  Object.defineProperty(g, 'navigator', { value: nav, writable: true, configurable: true, enumerable: false });
}
