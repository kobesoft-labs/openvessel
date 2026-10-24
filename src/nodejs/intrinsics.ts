// Node's own code uses primordials, so a program that deletes Array.prototype[Symbol.iterator]
// (or %ArrayIteratorPrototype%.next) still loads modules. The runtime's TypeScript uses for…of,
// spread and destructuring freely; its entry points that such programs reach run with the
// originals put back for the duration of the call.

const ArrayProto = Array.prototype;
const ArrayIteratorProto = Object.getPrototypeOf([][Symbol.iterator]());
const nativeValues = ArrayProto[Symbol.iterator];
const nativeNext = ArrayIteratorProto.next;
const valuesKey = Symbol.iterator;
const { getOwnPropertyDescriptor, defineProperty } = Object;

function intact(): boolean {
  return getOwnPropertyDescriptor(ArrayProto, valuesKey)?.value === nativeValues && getOwnPropertyDescriptor(ArrayIteratorProto, 'next')?.value === nativeNext;
}

/** Runs fn with array iteration working, then puts back whatever the program had there. */
export function withArrayIteration<T>(fn: () => T): T {
  if (intact()) return fn();
  const values = getOwnPropertyDescriptor(ArrayProto, valuesKey);
  const next = getOwnPropertyDescriptor(ArrayIteratorProto, 'next');
  defineProperty(ArrayProto, valuesKey, { __proto__: null, value: nativeValues, writable: true, enumerable: false, configurable: true } as PropertyDescriptor);
  defineProperty(ArrayIteratorProto, 'next', { __proto__: null, value: nativeNext, writable: true, enumerable: false, configurable: true } as PropertyDescriptor);
  try {
    return fn();
  } finally {
    if (values) defineProperty(ArrayProto, valuesKey, { __proto__: null, ...values } as PropertyDescriptor);
    else delete (ArrayProto as any)[valuesKey];
    if (next) defineProperty(ArrayIteratorProto, 'next', { __proto__: null, ...next } as PropertyDescriptor);
    else delete ArrayIteratorProto.next;
  }
}

/** Wraps an object's function properties with withArrayIteration. */
export function guardFunctions<T extends object>(obj: T): T {
  const o = obj as Record<string, unknown>;
  for (const name of Object.keys(o)) {
    const fn = o[name];
    if (typeof fn !== 'function' || /^[A-Z]/.test(name)) continue;
    o[name] = {
      [name](this: unknown, ...args: unknown[]) {
        return withArrayIteration(() => (fn as Function).apply(this, args));
      },
    }[name];
  }
  return obj;
}

/** Wraps a class's prototype methods with withArrayIteration (the class itself is unchanged). */
export function guardMethods(C: { prototype: object }) {
  const proto = C.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const d = getOwnPropertyDescriptor(proto, name)!;
    if (typeof d.value !== 'function') continue;
    const fn = d.value as Function;
    defineProperty(proto, name, {
      ...d,
      value: {
        [name](this: unknown, ...args: unknown[]) {
          return withArrayIteration(() => fn.apply(this, args));
        },
      }[name],
    });
  }
}
