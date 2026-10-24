// sucrase, for require(esm)'s ESM → CommonJS rewrite (see module_wrap.ts). Built as its own script
// and loaded on first use by typescript.ts. (TypeScript itself is stripped by Node's amaro.)
import { transform } from 'sucrase';

// non-enumerable: Node's tests check that nothing leaks onto the global
Object.defineProperty(globalThis, '__ovSucrase', { value: { transform }, configurable: true, writable: true });
