// internalBinding('util') and internalBinding('types'): V8 introspection done with brand checks.

import { sys } from '../../node/sys.ts';
import { S } from '../state.ts';
import { fromShape } from './shape.ts';

// Brand checks: calling an intrinsic getter/method on the wrong receiver throws.
const brand = (fn: Function) => (v: unknown) => {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false;
  try {
    fn.call(v);
    return true;
  } catch {
    return false;
  }
};
const getter = (proto: object, key: string | symbol) => Object.getOwnPropertyDescriptor(proto, key)!.get!;
const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = getter(TypedArrayProto, Symbol.toStringTag);
const mapIterProto = Object.getPrototypeOf(new Map().entries());
const setIterProto = Object.getPrototypeOf(new Set().entries());
const AsyncFunction = (async () => {}).constructor;
const GeneratorFunction = function* () {}.constructor;
const AsyncGeneratorFunction = async function* () {}.constructor;
const generatorProto = Object.getPrototypeOf(function* () {}).prototype;
const asyncGeneratorProto = Object.getPrototypeOf(async function* () {}).prototype;
const fnToString = Function.prototype.toString;

export const types = {
  isExternal: (_v: unknown) => false,
  isDate: brand(Date.prototype.getTime),
  isArgumentsObject: (v: unknown) => Object.prototype.toString.call(v) === '[object Arguments]',
  isBigIntObject: brand(BigInt.prototype.valueOf),
  isBooleanObject: brand(Boolean.prototype.valueOf),
  isNumberObject: brand(Number.prototype.valueOf),
  isStringObject: brand(String.prototype.valueOf),
  isSymbolObject: brand(Symbol.prototype.valueOf),
  isBoxedPrimitive: (v: unknown) => types.isNumberObject(v) || types.isStringObject(v) || types.isBooleanObject(v) || types.isBigIntObject(v) || types.isSymbolObject(v),
  isNativeError: (v: unknown) => (typeof (Error as any).isError === 'function' ? (Error as any).isError(v) : v instanceof Error),
  isRegExp: (v: unknown): boolean => {
    // the `source` getter throws on non-RegExp receivers (RegExp.prototype itself is special-cased)
    if (v === null || typeof v !== 'object' || v === RegExp.prototype) return false;
    try {
      getter(RegExp.prototype, 'source').call(v);
      return true;
    } catch {
      return false;
    }
  },
  isAsyncFunction: (v: unknown) => typeof v === 'function' && (v instanceof AsyncFunction || v instanceof AsyncGeneratorFunction || /^async[\s(*]/.test(safeSrc(v))),
  isGeneratorFunction: (v: unknown) => typeof v === 'function' && (v instanceof GeneratorFunction || v instanceof AsyncGeneratorFunction),
  isGeneratorObject: (v: unknown) => !!v && typeof v === 'object' && (generatorProto.isPrototypeOf(v) || asyncGeneratorProto.isPrototypeOf(v)),
  isPromise: brand(function (this: Promise<unknown>) {
    Promise.prototype.then.call(this, undefined, () => {});
  }),
  isMap: brand(getter(Map.prototype, 'size')),
  isSet: brand(getter(Set.prototype, 'size')),
  isMapIterator: brand(mapIterProto.next),
  isSetIterator: brand(setIterProto.next),
  isWeakMap: brand(function (this: WeakMap<object, unknown>) {
    WeakMap.prototype.has.call(this, {});
  }),
  isWeakSet: brand(function (this: WeakSet<object>) {
    WeakSet.prototype.has.call(this, {});
  }),
  isArrayBuffer: brand(getter(ArrayBuffer.prototype, 'byteLength')),
  isSharedArrayBuffer: typeof SharedArrayBuffer === 'function' ? brand(getter(SharedArrayBuffer.prototype, 'byteLength')) : () => false,
  isAnyArrayBuffer: (v: unknown) => types.isArrayBuffer(v) || types.isSharedArrayBuffer(v),
  isDataView: brand(getter(DataView.prototype, 'byteLength')),
  isProxy: (_v: unknown) => false,
  isModuleNamespaceObject: (v: unknown) => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === null && (v as any)[Symbol.toStringTag] === 'Module' && Object.isSealed(v),
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isTypedArray: (v: unknown) => typedArrayTag.call(v) !== undefined,
  isUint8Array: (v: unknown) => typedArrayTag.call(v) === 'Uint8Array',
};
function safeSrc(f: unknown): string {
  try {
    return fnToString.call(f as Function);
  } catch {
    return '';
  }
}

// -----------------------------------------------------------------------------

const ONLY_ENUMERABLE = 2;
const SKIP_SYMBOLS = 16;
const SKIP_STRINGS = 8;
const isIndex = (k: string | symbol) => typeof k === 'string' && /^(0|[1-9]\d*)$/.test(k) && Number(k) < 4294967295;

function getConstructorName(obj: object): string {
  for (let p: any = obj; p !== null; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'constructor');
    if (d && typeof d.value === 'function' && d.value.name) return d.value.name;
  }
  return 'Object';
}

function getCallSites(frames: number) {
  const out: any[] = [];
  const stack = String(new Error().stack ?? '').split('\n').slice(3, 3 + frames);
  for (const l of stack) {
    const m = /at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/.exec(l.trim());
    if (m) out.push({ functionName: m[1] ?? '', scriptId: '0', scriptName: m[2], lineNumber: Number(m[3]), column: Number(m[4]), columnNumber: Number(m[4]) });
  }
  return out;
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.replace(/\r\n?/g, '\n');
  const re = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\n]*)?\s*(?:#.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lines))) {
    let v = (m[2] ?? '').trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v.endsWith(q)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n');
    }
    out[m[1]] = v;
  }
  return out;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const handleTypes = { tty: 1, pipe: 4, socket: 4, file: 3, null: 3, dir: 3 } as Record<string, number>;

export function createUtil() {
  const b = fromShape('util');
  S.privateSymbols = b.privateSymbols;
  Object.assign(b, types, {
    isInsideNodeModules: (_frameLimit?: number, def?: boolean) => {
      const st = String(new Error().stack ?? '');
      for (const l of st.split('\n').slice(2)) {
        if (/node:internal|\(node:/.test(l)) continue;
        if (/[\\/]node_modules[\\/]/.test(l)) return true;
        if (/\.(m|c)?js:\d+/.test(l)) return false;
      }
      return def ?? false;
    },
    defineLazyProperties(target: any, id: string, keys: string[], enumerable = true) {
      for (const key of keys) {
        let value: unknown;
        let loaded = false;
        Object.defineProperty(target, key, {
          __proto__: null,
          enumerable,
          configurable: true,
          get() {
            if (!loaded) {
              value = S.requireBuiltin(id)[key];
              loaded = true;
            }
            return value;
          },
          set(v) {
            Object.defineProperty(target, key, { __proto__: null, value: v, writable: true, enumerable, configurable: true } as PropertyDescriptor);
          },
        } as PropertyDescriptor);
        // V8 reports these accessors with the property's name
        Object.defineProperty(Object.getOwnPropertyDescriptor(target, key)!.get!, 'name', { value: `get ${key}` });
      }
    },
    getPromiseDetails: (_p: Promise<unknown>) => [0 /* kPending */],
    getProxyDetails: (_p: unknown, _full?: boolean) => undefined,
    getCallerLocation: () => undefined,
    previewEntries: (_v: unknown, isIterator?: boolean) => (isIterator ? [[], false] : []),
    getOwnNonIndexProperties(obj: object, filter: number) {
      return Reflect.ownKeys(obj).filter((k) => {
        if (isIndex(k)) return false;
        if (filter & SKIP_SYMBOLS && typeof k === 'symbol') return false;
        if (filter & SKIP_STRINGS && typeof k === 'string') return false;
        if (filter & ONLY_ENUMERABLE && !Object.prototype.propertyIsEnumerable.call(obj, k)) return false;
        return true;
      });
    },
    getConstructorName,
    getExternalValue: () => 0n,
    getCallSites,
    sleep: (ms: number) => void Atomics.wait(sleepCell, 0, 0, ms),
    parseEnv,
    arrayBufferViewHasBuffer: () => true,
    guessHandleType(fd: number) {
      try {
        const kind = sys<string | null>('fdKind', { fd });
        return kind === null ? 5 : (handleTypes[kind] ?? 5);
      } catch {
        return 5;
      }
    },
  });
  return b;
}

export function createTypes() {
  return Object.assign(fromShape('types'), types);
}
