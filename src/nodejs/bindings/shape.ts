// Builds a binding object from the shape dumped out of real Node (src/node/data/bindings.json):
// constants, typed arrays and symbols are materialized; functions and classes become stubs that
// throw ERR_NOT_IMPLEMENTED until a real implementation is layered on top.

import shapes from '../../node/data/bindings.json';

type Shape = any;

function notImplemented(name: string): never {
  const e = new Error(`internalBinding ${name} is not implemented in OpenVessel`) as Error & { code: string };
  e.code = 'ERR_NOT_IMPLEMENTED';
  throw e;
}

function materialize(s: Shape, path: string): any {
  if (s === null || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map((x, i) => materialize(x, `${path}[${i}]`));
  if ('__num' in s) return Number(s.__num);
  if ('__bigint' in s) return BigInt(s.__bigint);
  if ('__symbol' in s) return Symbol(s.__symbol);
  if ('__typed' in s) {
    const C = (globalThis as any)[s.__typed];
    const a = new C(s.length);
    if (s.values) a.set(s.__typed.startsWith('Big') ? s.values.map(BigInt) : s.values);
    return a;
  }
  if ('__map' in s) return new Map(Array.isArray(s.__map) ? s.__map.map(([k, v]: any) => [materialize(k, path), materialize(v, path)]) : []);
  if ('__set' in s) return new Set(s.__set.map((x: any) => materialize(x, path)));
  if ('__fn' in s) {
    if (s.proto?.length) {
      const C = function (this: unknown) {
        notImplemented(path);
      } as any;
      for (const m of s.proto) C.prototype[m] = () => notImplemented(`${path}.prototype.${m}`);
      for (const [k, v] of Object.entries(s.statics ?? {})) C[k] = materialize(v, `${path}.${k}`);
      Object.defineProperty(C, 'name', { value: typeof s.__fn === 'string' ? s.__fn : path });
      return C;
    }
    const f = () => notImplemented(path);
    for (const [k, v] of Object.entries(s.statics ?? {})) (f as any)[k] = materialize(v, `${path}.${k}`);
    return f;
  }
  if ('__ref' in s || '__object' in s || '__array' in s || '__throws' in s || '__missing' in s) return undefined;
  const o: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k.startsWith('@@')) continue;
    o[k] = materialize(v, `${path}.${k}`);
  }
  return o;
}

/** A fresh binding object for `name` from the recorded shape. */
export function fromShape(name: string): any {
  const s = (shapes as Record<string, Shape>)[name];
  if (!s || s.__missing) return {};
  return materialize(s, `('${name}')`);
}

/** The recorded shape of a binding member, for checks and tooling. */
export function shapeOf(name: string): Shape {
  return (shapes as Record<string, Shape>)[name];
}
