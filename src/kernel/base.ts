// Where the runtime is served from: the directory of the kernel's script (e.g. https://rt.example.com
// or https://example.github.io/demo/runtime), without the trailing slash. The runtime's service worker
// answers /__ov/… under it.

export const RUNTIME_BASE = typeof location !== 'undefined' ? new URL('.', location.href).href.replace(/\/$/, '') : '';
