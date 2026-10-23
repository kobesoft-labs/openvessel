// node:assert

import { deepEqual, inspect } from './util.ts';

export class AssertionError extends Error {
  actual: unknown;
  expected: unknown;
  operator: string;
  generatedMessage: boolean;
  code = 'ERR_ASSERTION';
  constructor(opts: { message?: string | Error; actual?: unknown; expected?: unknown; operator?: string; stackStartFn?: Function }) {
    const generated = !opts.message;
    super(typeof opts.message === 'string' ? opts.message : generated ? `${inspect(opts.actual)} ${opts.operator} ${inspect(opts.expected)}` : String(opts.message));
    this.name = 'AssertionError';
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.operator = opts.operator ?? 'fail';
    this.generatedMessage = generated;
    if (opts.stackStartFn) Error.captureStackTrace?.(this, opts.stackStartFn as any);
  }
}

function fail_(actual: unknown, expected: unknown, message: string | Error | undefined, operator: string, fn: Function): never {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, actual, expected, operator, stackStartFn: fn });
}

export function ok(value: unknown, message?: string | Error): asserts value {
  if (!value) fail_(value, true, message ?? 'The expression evaluated to a falsy value', '==', ok);
}

export function equal(a: unknown, b: unknown, message?: string | Error) {
  if (!(a == b || (Number.isNaN(a) && Number.isNaN(b)))) fail_(a, b, message, '==', equal);
}
export function notEqual(a: unknown, b: unknown, message?: string | Error) {
  if (a == b || (Number.isNaN(a) && Number.isNaN(b))) fail_(a, b, message, '!=', notEqual);
}
export function strictEqual(a: unknown, b: unknown, message?: string | Error) {
  if (!Object.is(a, b)) fail_(a, b, message ?? `Expected values to be strictly equal:\n\n${inspect(a)} !== ${inspect(b)}\n`, 'strictEqual', strictEqual);
}
export function notStrictEqual(a: unknown, b: unknown, message?: string | Error) {
  if (Object.is(a, b)) fail_(a, b, message, 'notStrictEqual', notStrictEqual);
}
export function deepEqual_(a: unknown, b: unknown, message?: string | Error) {
  if (!deepEqual(a, b, false, new Map())) fail_(a, b, message, 'deepEqual', deepEqual_);
}
export function notDeepEqual(a: unknown, b: unknown, message?: string | Error) {
  if (deepEqual(a, b, false, new Map())) fail_(a, b, message, 'notDeepEqual', notDeepEqual);
}
export function deepStrictEqual(a: unknown, b: unknown, message?: string | Error) {
  if (!deepEqual(a, b, true, new Map())) fail_(a, b, message ?? `Expected values to be strictly deep-equal:\n${inspect(a)}\n\nshould equal\n\n${inspect(b)}`, 'deepStrictEqual', deepStrictEqual);
}
export function notDeepStrictEqual(a: unknown, b: unknown, message?: string | Error) {
  if (deepEqual(a, b, true, new Map())) fail_(a, b, message, 'notDeepStrictEqual', notDeepStrictEqual);
}
export function partialDeepStrictEqual(a: any, b: any, message?: string | Error) {
  const check = (x: any, y: any): boolean => {
    if (typeof y !== 'object' || y === null) return Object.is(x, y);
    if (typeof x !== 'object' || x === null) return false;
    return Object.keys(y).every((k) => check(x[k], y[k]));
  };
  if (!check(a, b)) fail_(a, b, message, 'partialDeepStrictEqual', partialDeepStrictEqual);
}

function matchesExpected(err: any, expected: any): boolean {
  if (expected === undefined) return true;
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && err instanceof expected) return true;
    if (Error.isPrototypeOf(expected)) return false;
    return expected.call({}, err) === true;
  }
  if (expected instanceof RegExp) return expected.test(String(err));
  if (typeof expected === 'object') {
    return Object.keys(expected).every((k) => {
      const v = expected[k];
      if (v instanceof RegExp && typeof err[k] === 'string') return v.test(err[k]);
      return deepEqual(err[k], v, true, new Map());
    });
  }
  return false;
}

/** Like Node: a class that doesn't match rethrows the error; any other mismatch is an AssertionError. */
function checkThrown(e: any, expected: any, message: string | Error | undefined, operator: string, fn: Function) {
  if (matchesExpected(e, expected)) return;
  if (typeof expected === 'function' && expected.prototype !== undefined && (expected === Error || Error.isPrototypeOf(expected))) throw e;
  if (expected && typeof expected === 'object' && !(expected instanceof RegExp)) {
    for (const k of Object.keys(expected)) {
      const v = expected[k];
      const ok = v instanceof RegExp && typeof e?.[k] === 'string' ? v.test(e[k]) : deepEqual(e?.[k], v, true, new Map());
      if (!ok) fail_(e?.[k], v, message ?? `Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   ${k}: ${inspect(e?.[k])}\n-   ${k}: ${inspect(v)}\n  }`, operator, fn);
    }
  }
  fail_(e, expected, message ?? `The ${typeof expected === 'function' ? `"validate" validation function` : 'error'} is expected to match the expected value.\n\nActual message: "${e?.message}"`, operator, fn);
}

export function throws(fn: () => unknown, expected?: any, message?: string | Error) {
  if (typeof expected === 'string') {
    message = expected;
    expected = undefined;
  }
  try {
    fn();
  } catch (e) {
    checkThrown(e, expected, message, 'throws', throws);
    return;
  }
  fail_(undefined, expected, message ?? 'Missing expected exception.', 'throws', throws);
}

export function doesNotThrow(fn: () => unknown, _expected?: any, message?: string | Error) {
  try {
    fn();
  } catch (e) {
    fail_(e, undefined, message ?? `Got unwanted exception.\nActual message: "${(e as Error)?.message}"`, 'doesNotThrow', doesNotThrow);
  }
}

export async function rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: any, message?: string | Error) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    checkThrown(e, expected, message, 'rejects', rejects);
    return;
  }
  fail_(undefined, expected, message ?? 'Missing expected rejection.', 'rejects', rejects);
}

export async function doesNotReject(p: Promise<unknown> | (() => Promise<unknown>), _expected?: any, message?: string | Error) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    fail_(e, undefined, message ?? 'Got unwanted rejection.', 'doesNotReject', doesNotReject);
  }
}

export function match(s: string, re: RegExp, message?: string | Error) {
  if (!re.test(s)) fail_(s, re, message ?? `The input did not match the regular expression ${re}. Input:\n\n${inspect(s)}\n`, 'match', match);
}
export function doesNotMatch(s: string, re: RegExp, message?: string | Error) {
  if (re.test(s)) fail_(s, re, message, 'doesNotMatch', doesNotMatch);
}

export function fail(message?: string | Error): never {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message: message ?? 'Failed', operator: 'fail', stackStartFn: fail });
}

export function ifError(v: unknown) {
  if (v !== null && v !== undefined) {
    if (v instanceof Error) throw v;
    throw new AssertionError({ message: `ifError got unwanted exception: ${inspect(v)}`, actual: v, operator: 'ifError' });
  }
}

const assert: any = function assert(value: unknown, message?: string | Error) {
  ok(value, message);
};
Object.assign(assert, {
  AssertionError, ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual: deepEqual_, notDeepEqual, deepStrictEqual, notDeepStrictEqual, partialDeepStrictEqual,
  throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, fail, ifError,
});
const strict: any = function strict(value: unknown, message?: string | Error) {
  ok(value, message);
};
Object.assign(strict, assert, { equal: strictEqual, notEqual: notStrictEqual, deepEqual: deepStrictEqual, notDeepEqual: notDeepStrictEqual });
strict.strict = strict;
assert.strict = strict;
assert.Assert = class Assert {};
export { strict };
export default assert;
