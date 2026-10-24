// globalThis.__ovAmaro: Node's internal/deps/amaro. The runtime serves Node's own amaro (amaro.js, the
// version Node bundles: swc compiled to WebAssembly), fetched synchronously the first time TypeScript
// is stripped. sucrase (ts-strip.js) is kept for require(esm)'s ESM → CommonJS rewrite.

import { S } from './state.ts';
import { NativeXMLHttpRequest } from './web.ts';

function runtimeFile(name: string): string {
  const xhr = new NativeXMLHttpRequest();
  xhr.open('GET', `${S.runtimeBase}/${name}`, false);
  xhr.send();
  if (xhr.status !== 200) throw new Error(`could not load ${name} (${xhr.status})`);
  return xhr.responseText;
}

let sucraseLoaded = false;

/** sucrase's transform (loaded on first use). */
export function sucrase(): { transform: (source: string, options: object) => { code: string } } {
  if (!sucraseLoaded) {
    (0, eval)(`${runtimeFile('ts-strip.js')}\n//# sourceURL=${S.runtimeBase}/ts-strip.js`);
    sucraseLoaded = true;
  }
  return (globalThis as any).__ovSucrase;
}

type Amaro = { transformSync(source: string, options?: object): { code: string; map?: string } };
let amaro: Amaro | null = null;

/** Called by the amaro override with Node's internal require (for buffer and util). */
function amaroModule(require: (id: string) => unknown): Amaro {
  return {
    transformSync(source, options) {
      if (!amaro) {
        const module = { exports: {} as Amaro };
        const fn = (0, eval)(`(function (exports, require, module) {${runtimeFile('amaro.js')}\n})\n//# sourceURL=${S.runtimeBase}/amaro.js`);
        fn(module.exports, (id: string) => require(id.replace(/^node:/, '')), module);
        amaro = module.exports;
      }
      return amaro.transformSync(source, options);
    },
  };
}

Object.defineProperty(globalThis, '__ovAmaro', { value: amaroModule, configurable: true, enumerable: false });
