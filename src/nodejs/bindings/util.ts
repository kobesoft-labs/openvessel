// internalBinding('util') and internalBinding('types'): V8 introspection done with brand checks.

import { sys } from '../../node/sys.ts';
import { getProxyDetails, isProxy } from '../proxies.ts';
import { isMapIterator, isSetIterator, previewIterator } from '../iterators.ts';
import { S } from '../state.ts';
import { hidePrivateSymbol } from './contextify.ts';
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
const AsyncFunction = (async () => {}).constructor;
const GeneratorFunction = function* () {}.constructor;
const AsyncGeneratorFunction = async function* () {}.constructor;
const generatorProto = Object.getPrototypeOf(function* () {}).prototype;
const asyncGeneratorProto = Object.getPrototypeOf(async function* () {}).prototype;
const fnToString = Function.prototype.toString;

/**
 * Promise.prototype.then is the promise brand check, but on a promise it adds a reaction (which
 * marks a rejection handled and is visible to async stack traces). Here it stops right after the
 * check: looking up the species constructor throws while `constructor` and @@species are traps.
 */
const promiseThen = Promise.prototype.then;
/** A property descriptor that ignores what Object.prototype may have gained (a `get`, say). */
export const bare = (d: PropertyDescriptor): PropertyDescriptor => Object.assign(Object.create(null), d);
function isPromise(v: unknown): boolean {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false;
  const stop = {};
  const trap = bare({
    get() {
      throw stop;
    },
    configurable: true,
  });
  const ctor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
  const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  let result = false;
  try {
    Object.defineProperty(Promise.prototype, 'constructor', trap);
    Object.defineProperty(Promise, Symbol.species, trap);
    promiseThen.call(v);
    result = true;
  } catch (e) {
    // only the receiver check throws a TypeError before the constructor is looked up
    result = e === stop || !(e instanceof TypeError && /incompatible receiver/.test(e.message));
  } finally {
    if (ctor) Object.defineProperty(Promise.prototype, 'constructor', bare(ctor));
    if (species) Object.defineProperty(Promise, Symbol.species, bare(species));
  }
  return result;
}

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
  isPromise,
  isMap: brand(getter(Map.prototype, 'size')),
  isSet: brand(getter(Set.prototype, 'size')),
  isMapIterator,
  isSetIterator,
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
  isProxy,
  isModuleNamespaceObject: (v: unknown) => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === null && (v as any)[Symbol.toStringTag] === 'Module' && isSealedNamespace(v),
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isTypedArray: (v: unknown) => typedArrayTag.call(v) !== undefined,
  isUint8Array: (v: unknown) => typedArrayTag.call(v) === 'Uint8Array',
};
/** A namespace is sealed; reading one of its bindings before the module ran throws (TDZ). */
function isSealedNamespace(v: object): boolean {
  try {
    return Object.isSealed(v);
  } catch (e) {
    return e instanceof ReferenceError;
  }
}
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

/**
 * v8::Object::GetConstructorName. V8 also knows the function that created an object whose
 * prototype is gone (Object.setPrototypeOf(new Foo(), null) is still a "Foo"); JS sees that only as
 * CallSite.getTypeName() of a frame with the object as its receiver.
 */
function getConstructorName(obj: object): string {
  const E = Error as any;
  const prep = Object.getOwnPropertyDescriptor(E, 'prepareStackTrace');
  const limit = E.stackTraceLimit;
  const holder: { stack?: any } = {};
  try {
    E.stackTraceLimit = 1;
    Object.defineProperty(E, 'prepareStackTrace', bare({ value: (_e: Error, t: any[]) => t, writable: true, configurable: true }));
    receiverProbe.call(obj, holder);
    const name = holder.stack?.[0]?.getTypeName?.();
    if (typeof name === 'string' && name) return name;
  } catch {
    // fall back to the prototype chain
  } finally {
    E.stackTraceLimit = limit;
    if (prep) Object.defineProperty(E, 'prepareStackTrace', bare(prep));
    else delete E.prepareStackTrace;
  }
  for (let p: any = obj; p !== null; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'constructor');
    if (d && typeof d.value === 'function' && d.value.name) return d.value.name;
  }
  return 'Object';
}
function receiverProbe(this: unknown, holder: object) {
  'use strict';
  (Error as any).captureStackTrace(holder);
}

/** node_util.cc GetCallSites: the caller's frames, without the node:util frame that asked. */
function getCallSites(frames: number) {
  const sites = S.callSites?.(frames + 1) ?? [];
  return sites.slice(1).map((cs: any) => {
    const scriptName = String(cs.getScriptNameOrSourceURL?.() || cs.getFileName?.() || '');
    const column = cs.getColumnNumber?.() ?? 0;
    return {
      // the top-level code of an eval-compiled module or script: anonymous under Node
      functionName: cs.isEval?.() && cs.getFunctionName?.() === 'eval' ? '' : (cs.getFunctionName?.() ?? ''),
      scriptId: String(cs.getScriptId?.() ?? 0),
      scriptName,
      lineNumber: cs.getLineNumber?.() ?? 0,
      columnNumber: column,
      column,
    };
  });
}

const trimSpaces = (s: string) => s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');

/** Dotenv::ParseContent (node_dotenv.cc), step for step; keys come out sorted (a std::map). */
export function parseEnv(input: string): Record<string, string> {
  const store = new Map<string, string>();
  let content = trimSpaces(input.replace(/\r/g, ''));
  const afterLine = (from: number) => {
    const nl = content.indexOf('\n', from);
    content = nl >= 0 ? content.slice(nl + 1) : '';
  };
  while (content.length) {
    // empty lines and comments
    if (content[0] === '\n' || content[0] === '#') {
      afterLine(0);
      continue;
    }
    const eq = content.search(/[=\n]/);
    // no '=' before the end of the line: not a variable
    if (eq < 0 || content[eq] === '\n') {
      const nl = content.indexOf('\n');
      if (nl < 0) break;
      content = trimSpaces(content.slice(nl + 1));
      continue;
    }
    let key = trimSpaces(content.slice(0, eq));
    content = content.slice(eq + 1);
    if (!content.length || content[0] === '\n') {
      store.set(key, '');
      continue;
    }
    content = trimSpaces(content);
    if (!key.length) continue;
    if (key.startsWith('export ')) key = trimSpaces(key.slice(7));
    const q = content[0];
    if (q === '"') {
      const close = content.indexOf('"', 1);
      if (close >= 0) {
        store.set(key, content.slice(1, close).replace(/\\n/g, '\n'));
        afterLine(close + 1);
        continue;
      }
    }
    if (q === "'" || q === '"' || q === '`') {
      const close = content.indexOf(q, 1);
      if (close >= 0) {
        store.set(key, content.slice(1, close));
        afterLine(close + 1);
      } else {
        // an unclosed quote: the rest of the line, quote included
        const nl = content.indexOf('\n');
        if (nl < 0) {
          store.set(key, content);
          break;
        }
        store.set(key, content.slice(0, nl));
        content = content.slice(nl);
      }
    } else {
      const nl = content.indexOf('\n');
      let value = nl >= 0 ? content.slice(0, nl) : content;
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash);
      store.set(key, trimSpaces(value));
      content = nl >= 0 ? content.slice(nl + 1) : '';
    }
    content = trimSpaces(content);
  }
  const out: Record<string, string> = {};
  for (const k of [...store.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) out[k] = store.get(k)!;
  return out;
}

/**
 * Promises whose state the runtime knows because a binding settled them itself (V8 can read any
 * promise's state; the browser can't). util.inspect shows these as fulfilled/rejected.
 */
const settledPromises = new WeakMap<Promise<unknown>, [number, unknown]>();

/** A promise already fulfilled with value, whose state util.inspect can show. */
export function fulfilledPromise<T>(value: T): Promise<T> {
  const p = Promise.resolve(value);
  settledPromises.set(p, [1 /* kFulfilled */, value]);
  return p;
}

/** A promise already rejected with reason, whose state util.inspect can show. */
export function rejectedPromise(reason: unknown): Promise<never> {
  const p = Promise.reject(reason);
  settledPromises.set(p, [2 /* kRejected */, reason]);
  return p;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const handleTypes = { tty: 1, pipe: 4, socket: 4, file: 3, null: 3, dir: 3 } as Record<string, number>;

/**
 * V8's private symbols are per object: not inherited, invisible to reflection and to
 * util.inspect/deepStrictEqual. Ordinary symbols are none of that, which shows for the marks lib
 * puts on objects for postMessage (markAsUntransferable(Foo.prototype) must not mark `new Foo()`,
 * and a marked ArrayBuffer must still deep-equal its clone). For those, an accessor on
 * Object.prototype keeps the value in a WeakMap keyed by the receiver.
 */
function emulatePrivateSymbols(syms: (symbol | undefined)[]) {
  for (const sym of syms) {
    if (typeof sym !== 'symbol' || Object.prototype.hasOwnProperty.call(Object.prototype, sym)) continue;
    const values = new WeakMap<object, unknown>();
    Object.defineProperty(Object.prototype, sym, {
      get(this: object) {
        return values.get(this);
      },
      set(this: object, v: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') values.set(this, v);
      },
      enumerable: false,
      configurable: false,
    });
  }
}

export function createUtil() {
  const b = fromShape('util');
  S.privateSymbols = b.privateSymbols;
  emulatePrivateSymbols([b.privateSymbols.transfer_mode_private_symbol, b.privateSymbols.untransferable_object_private_symbol]);
  // and every other private symbol hidden the same way (contextify.ts)
  for (const k of Object.keys(b.privateSymbols)) {
    const sym = b.privateSymbols[k];
    if (typeof sym === 'symbol' && !Object.prototype.hasOwnProperty.call(Object.prototype, sym)) hidePrivateSymbol(sym);
  }
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
    getPromiseDetails: (p: Promise<unknown>) => settledPromises.get(p) ?? [0 /* kPending */],
    getProxyDetails,
    getCallerLocation: () => undefined,
    previewEntries(v: unknown, isIterator?: boolean) {
      // Map and Set iterators; the entries of a WeakMap or WeakSet can't be listed from JS
      if (isMapIterator(v) || isSetIterator(v)) {
        const r = previewIterator(v as object);
        return isIterator ? r : r[0];
      }
      return isIterator ? [[], false] : [];
    },
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
