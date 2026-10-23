// globalThis.__ovAmaro: what Node's internal/deps/amaro expects (transformSync), served by sucrase.
// The transform lives in ts-strip.js, fetched synchronously the first time TypeScript is loaded.

import { S } from './state.ts';

let transform: ((source: string, options: object) => { code: string; map?: string }) | null = null;

function load() {
  if (transform) return transform;
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `${S.runtimeOrigin}/ts-strip.js`, false);
  xhr.send();
  if (xhr.status !== 200) throw new Error(`could not load the TypeScript transform (${xhr.status})`);
  (0, eval)(`${xhr.responseText}\n//# sourceURL=${S.runtimeOrigin}/ts-strip.js`);
  transform = (globalThis as any).__ovSucraseTransform;
  return transform!;
}

Object.defineProperty(globalThis, '__ovAmaro', {
  value: {
    transformSync(source: string, options: { mode?: string; sourceMap?: boolean; filename?: string } = {}) {
      try {
        return load()(source, options);
      } catch (e: any) {
        if (e instanceof SyntaxError || /Unexpected token|Expected/.test(String(e?.message))) {
          // the shape amaro throws for invalid syntax
          throw { code: 'InvalidSyntax', message: e.message, filename: options.filename ?? '', startLine: e.loc?.line ?? 0, snippet: '' };
        }
        throw e;
      }
    },
  },
  configurable: true,
  enumerable: false,
});
