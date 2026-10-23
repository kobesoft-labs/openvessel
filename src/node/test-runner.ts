// node:test — test/describe/it with hooks, subtests, skip/todo/only, and mock.fn/method.
// Runs in-process and reports TAP on stdout (Node's non-TTY default); failures set process.exitCode = 1.

import * as loop from './loop.ts';

type Fn = (...a: any[]) => any;
interface Options {
  skip?: boolean | string;
  todo?: boolean | string;
  only?: boolean;
  timeout?: number;
  concurrency?: number | boolean;
  signal?: AbortSignal;
  plan?: number;
}
interface Hooks {
  before: Fn[];
  after: Fn[];
  beforeEach: Fn[];
  afterEach: Fn[];
}

const proc = () => (globalThis as any).process;
const out = (s: string) => proc().stdout.write(s);

function parseArgs(args: any[]): { name: string; opts: Options; fn: Fn | undefined } {
  let name = '<anonymous>';
  let opts: Options = {};
  let fn: Fn | undefined;
  for (const a of args) {
    if (typeof a === 'string') name = a;
    else if (typeof a === 'function') fn = a;
    else if (a && typeof a === 'object') opts = a;
  }
  if (name === '<anonymous>' && fn?.name) name = fn.name;
  return { name, opts, fn };
}

class Node_ {
  children: Node_[] = [];
  hooks: Hooks = { before: [], after: [], beforeEach: [], afterEach: [] };
  passed = true;
  error: unknown = null;
  skipped: string | boolean = false;
  todo: string | boolean = false;
  done = false;
  duration = 0;
  constructor(
    public name: string,
    public opts: Options,
    public fn: Fn | undefined,
    public parent: Node_ | null,
    public isSuite: boolean,
  ) {
    this.skipped = opts.skip ?? false;
    this.todo = opts.todo ?? false;
  }
  get depth(): number {
    return this.parent ? this.parent.depth + (this.parent.isRoot ? 0 : 1) : 0;
  }
  get isRoot() {
    return this.parent === null;
  }
  ancestorsEach(kind: 'beforeEach' | 'afterEach'): Fn[] {
    const chain: Node_[] = [];
    for (let n: Node_ | null = this.parent; n; n = n.parent) chain.unshift(n);
    const fns = chain.flatMap((n) => n.hooks[kind]);
    return kind === 'afterEach' ? fns.reverse() : fns;
  }
}

const root = new Node_('<root>', {}, undefined, null, true);
let currentSuite: Node_ = root;
let currentTest: Node_ | null = null;
let scheduled = false;
let running: Promise<void> | null = null;
let counts = { tests: 0, suites: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
const hasOnly = () => false;

function callWithDone(fn: Fn, self: unknown, arg: unknown): Promise<unknown> {
  if (fn.length >= 2) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve(undefined);
      };
      try {
        const r = fn.call(self, arg, done);
        if (r && typeof r.then === 'function') r.then(() => {}, done);
      } catch (e) {
        done(e);
      }
    });
  }
  try {
    return Promise.resolve(fn.call(self, arg));
  } catch (e) {
    return Promise.reject(e);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms || !isFinite(ms)) return p;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`test timed out after ${ms}ms`), { code: 'ERR_TEST_FAILURE', failureType: 'testTimeoutFailure' })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

class TestContext {
  mock = new MockTracker();
  private ac = new AbortController();
  private planned: number | null = null;
  private asserted = 0;
  constructor(private node: Node_) {
    if (node.opts.plan !== undefined) this.planned = node.opts.plan;
  }
  get name() {
    return this.node.name;
  }
  get fullName() {
    const parts: string[] = [];
    for (let n: Node_ | null = this.node; n && !n.isRoot; n = n.parent) parts.unshift(n.name);
    return parts.join(' > ');
  }
  get signal() {
    return this.ac.signal;
  }
  get filePath() {
    return proc().argv[1];
  }
  get assert() {
    const assert = (globalThis as any).__ov.builtin('assert');
    const self = this;
    return new Proxy(assert, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return (...a: unknown[]) => {
          self.asserted++;
          return v.apply(t, a);
        };
      },
    });
  }
  plan(n: number) {
    this.planned = n;
  }
  diagnostic(msg: string) {
    out(`${'    '.repeat(this.node.depth + 1)}# ${msg}\n`);
  }
  skip(msg?: string) {
    this.node.skipped = msg ?? true;
  }
  todo(msg?: string) {
    this.node.todo = msg ?? true;
  }
  runOnly(_v: boolean) {}
  before(fn: Fn) {
    this.node.hooks.before.push(fn);
  }
  after(fn: Fn) {
    this.node.hooks.after.push(fn);
  }
  beforeEach(fn: Fn) {
    this.node.hooks.beforeEach.push(fn);
  }
  afterEach(fn: Fn) {
    this.node.hooks.afterEach.push(fn);
  }
  test(...args: any[]): Promise<void> {
    const { name, opts, fn } = parseArgs(args);
    const child = new Node_(name, opts, fn, this.node, false);
    this.node.children.push(child);
    const p = runNode(child);
    this.pending.push(p);
    return p;
  }
  pending: Promise<void>[] = [];
  /** @internal */
  _abort() {
    this.ac.abort();
  }
  /** @internal */
  _checkPlan() {
    if (this.planned !== null) {
      const got = this.asserted + this.node.children.length;
      if (got !== this.planned) throw Object.assign(new Error(`plan expected ${this.planned} assertions but received ${got}`), { code: 'ERR_TEST_FAILURE' });
    }
  }
}

class SuiteContext {
  constructor(private node: Node_) {}
  get name() {
    return this.node.name;
  }
  get signal() {
    return new AbortController().signal;
  }
  get filePath() {
    return proc().argv[1];
  }
}

function indent(n: Node_) {
  return '    '.repeat(n.depth);
}

function yamlError(e: unknown, ind: string): string {
  const err = e as any;
  const lines = [`${ind}  ---`, `${ind}  duration_ms: 0`, `${ind}  failureType: 'testCodeFailure'`];
  const msg = String(err?.message ?? err).split('\n');
  lines.push(`${ind}  error: |-`, ...msg.map((l) => `${ind}    ${l}`));
  if (err?.code) lines.push(`${ind}  code: '${err.code}'`);
  const stack = String(err?.stack ?? '').split('\n').slice(1, 6);
  if (stack.length) lines.push(`${ind}  stack: |-`, ...stack.map((l) => `${ind}    ${l.trim()}`));
  lines.push(`${ind}  ...`);
  return lines.join('\n') + '\n';
}

function report(n: Node_, index: number) {
  const ind = indent(n);
  if (n.children.length) out(`${ind}1..${n.children.length}\n`);
  let directive = '';
  if (n.skipped) directive = ` # SKIP${typeof n.skipped === 'string' ? ' ' + n.skipped : ''}`;
  else if (n.todo) directive = ` # TODO${typeof n.todo === 'string' ? ' ' + n.todo : ''}`;
  out(`${ind}${n.passed ? 'ok' : 'not ok'} ${index} - ${n.name}${directive}\n`);
  if (!n.passed) out(yamlError(n.error, ind));
  else out(`${ind}  ---\n${ind}  duration_ms: ${n.duration.toFixed(3)}\n${n.isSuite ? `${ind}  type: 'suite'\n` : ''}${ind}  ...\n`);
}

async function runHooks(fns: Fn[], arg: unknown) {
  for (const h of fns) await callWithDone(h, undefined, arg);
}

async function runNode(n: Node_): Promise<void> {
  const parent = n.parent!;
  const t0 = performance.now();
  const prevTest = currentTest;
  if (n.isSuite) counts.suites++;
  else counts.tests++;
  if (n.skipped || (n.todo && !n.fn)) {
    n.done = true;
    if (n.skipped) counts.skipped++;
    else counts.todo++;
    report(n, parent.children.indexOf(n) + 1);
    return;
  }
  const ctx = n.isSuite ? new SuiteContext(n) : new TestContext(n);
  try {
    if (n.isSuite) {
      // children were collected when describe() ran
      await runHooks(n.hooks.before, ctx);
      for (const c of n.children) await runNode(c);
      await runHooks(n.hooks.after, ctx);
      if (n.children.some((c) => !c.passed && !c.todo)) {
        n.passed = false;
        n.error = new Error(`${n.children.filter((c) => !c.passed).length} subtests failed`);
      }
    } else {
      const tc = ctx as TestContext;
      await runHooks(n.ancestorsEach('beforeEach'), tc);
      currentTest = n;
      try {
        if (n.fn) await withTimeout(callWithDone(n.fn, tc, tc), n.opts.timeout);
        await Promise.all(tc.pending);
        tc._checkPlan();
      } finally {
        currentTest = prevTest;
        tc._abort();
        tc.mock.reset();
      }
      await runHooks(n.hooks.after, tc);
      await runHooks(n.ancestorsEach('afterEach'), tc);
      if (n.children.some((c) => !c.passed && !c.todo)) {
        n.passed = false;
        n.error = new Error(`${n.children.filter((c) => !c.passed).length} subtests failed`);
      }
    }
  } catch (e) {
    n.passed = false;
    n.error = e;
  }
  n.duration = performance.now() - t0;
  n.done = true;
  if (n.isSuite) {
    if (n.error && !n.children.length) counts.fail++;
  } else if (n.todo) counts.todo++;
  else if (n.skipped) counts.skipped++;
  else if (n.passed) counts.pass++;
  else counts.fail++;
  report(n, parent.children.indexOf(n) + 1);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  loop.ref();
  setImmediate(() => {
    running = (async () => {
      out('TAP version 13\n');
      const t0 = performance.now();
      for (let i = 0; i < root.children.length; i++) {
        const c = root.children[i];
        if (!c.done) await runNode(c);
      }
      out(`1..${root.children.length}\n`);
      out(`# tests ${counts.tests}\n# suites ${counts.suites}\n# pass ${counts.pass}\n# fail ${counts.fail}\n# cancelled 0\n# skipped ${counts.skipped}\n# todo ${counts.todo}\n# duration_ms ${(performance.now() - t0).toFixed(3)}\n`);
      if (counts.fail > 0) proc().exitCode = 1;
      loop.unref();
    })();
  });
}

function register(isSuite: boolean, args: any[], extra: Options = {}): Promise<void> | undefined {
  const { name, opts, fn } = parseArgs(args);
  Object.assign(opts, extra);
  if (currentTest && !isSuite) {
    // test() called inside a running test without t.test: treat as a subtest of it
    const child = new Node_(name, opts, fn, currentTest, false);
    currentTest.children.push(child);
    return runNode(child);
  }
  const n = new Node_(name, opts, fn, currentSuite, isSuite);
  currentSuite.children.push(n);
  if (isSuite) {
    const prev = currentSuite;
    currentSuite = n;
    try {
      if (fn && !n.skipped) {
        const r = fn.call(new SuiteContext(n), new SuiteContext(n));
        if (r && typeof r.then === 'function') r.catch((e: unknown) => {
          n.passed = false;
          n.error = e;
        });
      }
    } catch (e) {
      n.passed = false;
      n.error = e;
    } finally {
      currentSuite = prev;
    }
  }
  schedule();
  if (n.parent === root) {
    return new Promise<void>((resolve) => {
      const check = () => (n.done ? resolve() : setTimeout(check, 1));
      setImmediate(check);
    });
  }
  return undefined;
}

function variants<T extends Fn>(isSuite: boolean): T {
  const f = ((...a: any[]) => register(isSuite, a)) as any;
  f.skip = (...a: any[]) => register(isSuite, a, { skip: true });
  f.todo = (...a: any[]) => register(isSuite, a, { todo: true });
  f.only = (...a: any[]) => register(isSuite, a, { only: true });
  return f;
}

export const test = variants(false);
export const it = variants(false);
export const describe = variants(true);
export const suite = describe;
const hook = (kind: keyof Hooks) => (fn: Fn) => {
  if (currentTest) currentTest.hooks[kind].push(fn);
  else currentSuite.hooks[kind].push(fn);
};
export const before = hook('before');
export const after = hook('after');
export const beforeEach = hook('beforeEach');
export const afterEach = hook('afterEach');

export function run() {
  throw Object.assign(new Error('node:test run() is not supported in OpenVessel'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
}

// -----------------------------------------------------------------------------
// mocks

interface Call {
  arguments: unknown[];
  result?: unknown;
  error?: unknown;
  this: unknown;
  target?: unknown;
  stack: Error;
}

class MockFunctionContext {
  calls: Call[] = [];
  private onceImpls = new Map<number, Fn>();
  constructor(
    public impl: Fn | undefined,
    private original: Fn | undefined,
    private restoreFn: () => void,
    private times: number,
  ) {}
  callCount() {
    return this.calls.length;
  }
  mockImplementation(fn: Fn) {
    this.impl = fn;
  }
  mockImplementationOnce(fn: Fn, onCall?: number) {
    this.onceImpls.set(onCall ?? this.calls.length, fn);
  }
  resetCalls() {
    this.calls = [];
  }
  restore() {
    this.restoreFn();
  }
  /** @internal */
  _pick(): Fn | undefined {
    const once = this.onceImpls.get(this.calls.length);
    if (once) {
      this.onceImpls.delete(this.calls.length);
      return once;
    }
    if (this.calls.length >= this.times) return this.original;
    return this.impl;
  }
}

function makeMock(original: Fn | undefined, impl: Fn | undefined, restore: () => void, times = Infinity) {
  const ctx = new MockFunctionContext(impl ?? original, original, restore, times);
  const mocked = function (this: unknown, ...args: unknown[]) {
    const fn = ctx._pick() ?? (() => undefined);
    const call: Call = { arguments: args, this: this, target: new.target, stack: new Error() };
    try {
      const result = new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
      call.result = result;
      ctx.calls.push(call);
      return result;
    } catch (e) {
      call.error = e;
      ctx.calls.push(call);
      throw e;
    }
  };
  Object.defineProperty(mocked, 'mock', { value: ctx, enumerable: false });
  if (original) {
    Object.defineProperty(mocked, 'name', { value: original.name });
    Object.defineProperty(mocked, 'length', { value: original.length });
  }
  return mocked as Fn & { mock: MockFunctionContext };
}

export class MockTracker {
  private restorers: (() => void)[] = [];
  fn(original?: Fn | object, impl?: Fn | object, opts?: { times?: number }) {
    if (original && typeof original === 'object') {
      opts = original as any;
      original = undefined;
    }
    if (impl && typeof impl === 'object') {
      opts = impl as any;
      impl = undefined;
    }
    const m = makeMock(original as Fn | undefined, impl as Fn | undefined, () => {}, opts?.times);
    return m;
  }
  method(obj: any, name: string | symbol, impl?: Fn | object, opts: { getter?: boolean; setter?: boolean; times?: number } = {}) {
    if (impl && typeof impl === 'object') {
      opts = impl as any;
      impl = undefined;
    }
    let owner = obj;
    let desc: PropertyDescriptor | undefined;
    while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, name))) owner = Object.getPrototypeOf(owner);
    if (!desc) throw Object.assign(new TypeError(`The argument 'methodName' must be a method. Received ${String(name)}`), { code: 'ERR_INVALID_ARG_VALUE' });
    const ownDesc = Object.getOwnPropertyDescriptor(obj, name);
    const restore = () => {
      if (ownDesc) Object.defineProperty(obj, name, ownDesc);
      else delete obj[name];
    };
    const key = opts.getter ? 'get' : opts.setter ? 'set' : 'value';
    const original = desc[key] as Fn;
    const m = makeMock(original, impl as Fn | undefined, restore, opts.times);
    Object.defineProperty(obj, name, { ...desc, [key]: m });
    this.restorers.push(restore);
    return m;
  }
  getter(obj: any, name: string, impl?: Fn, opts: object = {}) {
    return this.method(obj, name, impl, { ...opts, getter: true });
  }
  setter(obj: any, name: string, impl?: Fn, opts: object = {}) {
    return this.method(obj, name, impl, { ...opts, setter: true });
  }
  reset() {
    this.restoreAll();
    this.restorers = [];
  }
  restoreAll() {
    for (const r of this.restorers.reverse()) r();
  }
  get timers(): never {
    throw Object.assign(new Error('mock.timers is not supported in OpenVessel'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  }
}

export const mock = new MockTracker();

const testModule: any = test;
Object.assign(testModule, { test, it, describe, suite, before, after, beforeEach, afterEach, run, mock, MockTracker });
void hasOnly;
export default testModule;
