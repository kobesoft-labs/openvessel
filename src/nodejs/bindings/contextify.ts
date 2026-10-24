// internalBinding('contextify') — compiling CommonJS modules, vm.Script and vm.compileFunction.
// Code is compiled with an indirect eval (global scope, with a sourceURL so stacks name the file);
// dynamic import() inside it is routed to Node's importModuleDynamically callback.
//
// vm contexts: a Worker can't make a new realm, so a context is emulated. Its global is a Proxy
// (the "global proxy") that reads and writes the contextified object (the sandbox) and falls
// back to the ECMAScript builtins, which are shared with the main context. Code runs inside
// `with (scope)` where the scope proxy resolves free names the same way and hides the worker's
// own globals (process, require, …). Top-level `var`/function declarations are put on the sandbox
// as V8 would. What can't be emulated: separate builtins (Array from a context is our Array),
// `this` of sloppy functions called plainly (the worker's global), timeouts, microtaskMode.

import { parse as parseEsm } from 'es-module-lexer/js';
import { NativeProxy } from '../proxies.ts';
import { S, lib } from '../state.ts';
import { importFromScript } from './module_wrap.ts';
import { fromShape } from './shape.ts';

const indirectEval = eval;
const realGlobal = globalThis as any;
// captured before Node's bootstrap replaces them with lib implementations
const nativeConsole = realGlobal.console;
const nativePerformance = realGlobal.performance;

let nextScript = 1;
const referrers = new Map<number, { symbol: unknown; name: string }>();

Object.defineProperty(globalThis, '__ov$scriptImport', {
  value: (id: number, specifier: unknown, options?: any) => {
    const r = referrers.get(id);
    return importFromScript(r?.symbol, r?.name ?? '', specifier, options);
  },
  configurable: true,
  enumerable: false,
});

// ---------------------------------------------------------------------------
// private symbols

const privateStores = new Map<symbol, WeakMap<object, unknown>>();

/**
 * V8's private symbols are invisible to reflection; ours are ordinary symbols. The value lives in
 * a WeakMap behind an accessor on Object.prototype, so Reflect.ownKeys(sandbox) etc. don't show
 * it (whether a binding or lib — `obj[transfer_mode_private_symbol] = …` — sets it).
 */
export function hidePrivateSymbol(sym: symbol): WeakMap<object, unknown> {
  let store = privateStores.get(sym);
  if (store) return store;
  const s = (store = new WeakMap());
  privateStores.set(sym, s);
  Object.defineProperty(Object.prototype, sym, {
    get(this: unknown) {
      return (typeof this === 'object' && this !== null) || typeof this === 'function' ? s.get(this as object) : undefined;
    },
    set(this: object, v: unknown) {
      s.set(this, v);
    },
    enumerable: false,
    configurable: true,
  });
  return s;
}

export function setPrivate(obj: object, sym: symbol, value: unknown) {
  const store = hidePrivateSymbol(sym);
  if (Object.prototype.isPrototypeOf(obj)) store.set(obj, value);
  else Object.defineProperty(obj, sym, { value, enumerable: false, configurable: true, writable: true });
}

const isPrivate = (k: PropertyKey) => typeof k === 'symbol' && privateStores.has(k);

// ---------------------------------------------------------------------------
// cached data: V8's code cache can't be produced in the browser; this records which source it
// was made for so vm can accept or reject it the way V8 does.

function hashes(code: string): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return [h1 >>> 0, h2 >>> 0];
}

export function makeCachedData(code: string): Uint8Array {
  const u8 = new Uint8Array(16);
  const dv = new DataView(u8.buffer);
  u8.set([0x4f, 0x56, 0x43, 0x31]); // OVC1
  const [h1, h2] = hashes(code);
  dv.setUint32(4, code.length, true);
  dv.setUint32(8, h1, true);
  dv.setUint32(12, h2, true);
  return lib('buffer').Buffer.from(u8.buffer);
}

export function cachedDataMatches(data: ArrayBufferView, code: string): boolean {
  if (data.byteLength !== 16) return false;
  const dv = new DataView(data.buffer, data.byteOffset, 16);
  if (dv.getUint32(0, false) !== 0x4f564331) return false;
  const [h1, h2] = hashes(code);
  return dv.getUint32(4, true) === code.length && dv.getUint32(8, true) === h1 && dv.getUint32(12, true) === h2;
}

// ---------------------------------------------------------------------------
// contexts

// what a fresh V8 context of Node 22 has (test/common/globals.js `intrinsics`)
const BUILTIN_NAMES = [
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String', 'Symbol', 'Date', 'Promise', 'RegExp',
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'JSON', 'Math', 'Intl',
  'ArrayBuffer', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray',
  'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval', 'isFinite', 'isNaN', 'SharedArrayBuffer', 'Atomics',
  'WebAssembly', 'Iterator', 'console',
];
const builtins = new Map<string, unknown>();
for (const k of BUILTIN_NAMES) if (k in realGlobal) builtins.set(k, k === 'console' ? nativeConsole : realGlobal[k]);

interface Context {
  sandbox: any;
  global: any;
  target: object;
  /** var/function names declared by scripts: like V8's, they can't be deleted */
  declared: Set<string>;
  overrides: Map<string, unknown>;
  /** a running script's function declarations, before they are copied onto the sandbox */
  pending: { names: string[]; read: () => unknown[] | null } | null;
}

/** A function declaration of the running script, read through the context's global (`this.f`). */
function pendingFn(ctx: Context, k: PropertyKey): { value: unknown } | null {
  const p = ctx.pending;
  if (!p || typeof k !== 'string') return null;
  const i = p.names.indexOf(k);
  if (i < 0) return null;
  const vals = p.read();
  return vals ? { value: vals[i] } : null;
}

const contexts = new WeakMap<object, Context>();
const liveContexts: WeakRef<object>[] = [];

/** Like Node's interceptors: the sandbox read from inside the context is the context's global. */
function outward(ctx: Context, v: unknown) {
  return v === ctx.sandbox ? ctx.global : v;
}

function isBuiltin(k: string) {
  return k === 'globalThis' || builtins.has(k);
}

function builtinValue(ctx: Context, k: string) {
  if (k === 'globalThis') return ctx.global;
  if (ctx.overrides.has(k)) return ctx.overrides.get(k);
  return builtins.get(k);
}

function hasIn(obj: object, k: PropertyKey) {
  try {
    return k in obj;
  } catch {
    return false;
  }
}

function codegenOverrides(strings: boolean, wasm: boolean) {
  const o = new Map<string, unknown>();
  if (!strings) {
    const msg = 'Code generation from strings disallowed for this context';
    o.set('eval', function evalDisallowed() {
      throw new EvalError(msg);
    });
    o.set('Function', new NativeProxy(Function, {
      apply() {
        throw new EvalError(msg);
      },
      construct() {
        throw new EvalError(msg);
      },
    }));
  }
  if (!wasm && typeof WebAssembly === 'object') {
    const W = WebAssembly as any;
    const msg = (f: string) => new W.CompileError(`WebAssembly.${f}(): Wasm code generation disallowed by embedder`);
    const w = Object.defineProperties({}, Object.getOwnPropertyDescriptors(W));
    Object.assign(w, {
      Module: function Module() {
        throw msg('Module');
      },
      compile: () => Promise.reject(msg('compile')),
      compileStreaming: () => Promise.reject(msg('compileStreaming')),
      instantiate: (src: unknown, imports?: object) => (src instanceof W.Module ? W.instantiate(src, imports) : Promise.reject(msg('instantiate'))),
      instantiateStreaming: () => Promise.reject(msg('instantiateStreaming')),
    });
    o.set('WebAssembly', w);
  }
  return o;
}

function globalHandler(ctx: Context): ProxyHandler<object> {
  const sb = () => ctx.sandbox;
  /** V8 requires a non-configurable property to exist on the proxy target too. */
  const mirror = (t: object, k: PropertyKey, d: PropertyDescriptor | undefined) => {
    if (d && !d.configurable) {
      const td = Reflect.getOwnPropertyDescriptor(t, k);
      if (!td || td.configurable) Reflect.defineProperty(t, k, d);
    }
    return d;
  };
  return {
    get(t, k, r) {
      if (isPrivate(k)) return Reflect.get(t, k, r);
      const fn = pendingFn(ctx, k);
      if (fn) return fn.value;
      if (hasIn(sb(), k)) return outward(ctx, Reflect.get(sb(), k));
      if (typeof k === 'string' && isBuiltin(k)) return builtinValue(ctx, k);
      return Reflect.get(t, k, r);
    },
    set(t, k, v, r) {
      if (isPrivate(k)) return Reflect.set(t, k, v, r);
      if (Reflect.set(sb(), k, v)) return true;
      // what Node's interceptor reports for a read-only property of the sandbox
      if (Reflect.getOwnPropertyDescriptor(sb(), k)?.writable === false) throw new TypeError(`Cannot redefine property: ${String(k)}`);
      return false;
    },
    has(t, k) {
      if (isPrivate(k)) return Reflect.has(t, k);
      return hasIn(sb(), k) || (typeof k === 'string' && isBuiltin(k)) || Reflect.has(t, k);
    },
    defineProperty(t, k, d) {
      if (isPrivate(k)) return Reflect.defineProperty(t, k, d);
      // throws V8's own message ("Cannot redefine property: x") rather than the proxy's
      Object.defineProperty(sb(), k, d);
      mirror(t, k, Reflect.getOwnPropertyDescriptor(sb(), k));
      return true;
    },
    getOwnPropertyDescriptor(t, k) {
      if (isPrivate(k)) return Reflect.getOwnPropertyDescriptor(t, k);
      const d = Reflect.getOwnPropertyDescriptor(sb(), k);
      if (d) return mirror(t, k, d);
      const td = Reflect.getOwnPropertyDescriptor(t, k);
      if (td) return td;
      if (typeof k === 'string' && isBuiltin(k)) return { value: builtinValue(ctx, k), writable: true, enumerable: false, configurable: true };
      return undefined;
    },
    ownKeys(t) {
      if (!Reflect.isExtensible(t)) return Reflect.ownKeys(t);
      const keys = new Set<PropertyKey>(['globalThis', ...builtins.keys()]);
      for (const k of Reflect.ownKeys(sb())) keys.add(k);
      for (const k of Reflect.ownKeys(t)) keys.add(k);
      const all = [...keys];
      return [...all.filter((k) => typeof k === 'string'), ...all.filter((k) => typeof k === 'symbol')];
    },
    deleteProperty(t, k) {
      if (typeof k === 'string' && ctx.declared.has(k)) return false;
      const ok = Reflect.deleteProperty(sb(), k);
      const td = Reflect.getOwnPropertyDescriptor(t, k);
      if (td?.configurable) Reflect.deleteProperty(t, k);
      return ok;
    },
    preventExtensions(t) {
      // a non-extensible proxy must report exactly its target's keys: copy them over first
      for (const k of this.ownKeys!(t) as PropertyKey[]) {
        const d = this.getOwnPropertyDescriptor!(t, k as string | symbol)!;
        if (!Reflect.getOwnPropertyDescriptor(t, k)) Reflect.defineProperty(t, k, d);
        // and the builtins onto the sandbox, so they can still be redefined (Object.freeze)
        if (!Reflect.getOwnPropertyDescriptor(sb(), k)) Reflect.defineProperty(sb(), k, d);
      }
      Object.preventExtensions(sb());
      return Reflect.preventExtensions(t);
    },
  };
}

function makeContextRecord(sandbox: object, strings: boolean, wasm: boolean): Context {
  const target = {};
  const ctx: Context = { sandbox, global: null, target, declared: new Set(), overrides: codegenOverrides(strings, wasm), pending: null };
  ctx.global = new NativeProxy(target, globalHandler(ctx));
  contexts.set(sandbox, ctx);
  contexts.set(ctx.global, ctx);
  liveContexts.push(new WeakRef(ctx.global));
  if (liveContexts.length % 256 === 0) {
    const alive = liveContexts.filter((r) => r.deref() !== undefined);
    liveContexts.splice(0, liveContexts.length, ...alive);
  }
  return ctx;
}

interface ScopeState {
  /** while the runner itself resolves `eval` */
  internal: boolean;
  /** this run's function declarations, read from the runner's scope until copied to the sandbox */
  hiddenFns: Set<string> | null;
}

/**
 * The object a context's code runs `with`. Free names resolve to the sandbox, then to the
 * builtins; the worker's own globals are hidden (they read as undefined). `assigned` lists the
 * names the code assigns to: they resolve here even when missing, so the write lands on the
 * sandbox and not on the worker's global (null: every name).
 */
function makeScope(ctx: Context, assigned: Set<string> | null, state: ScopeState, strict = false): object {
  const known = (k: string) => hasIn(ctx.sandbox, k) || isBuiltin(k);
  return new NativeProxy(Object.create(null), {
    has(_t, k) {
      if (typeof k !== 'string' || k.startsWith('__ov$')) return false;
      if (state.internal && k === 'eval') return false;
      if (state.hiddenFns?.has(k)) return false;
      if (known(k)) return true;
      if (assigned === null || assigned.has(k) || k === 'arguments') return true;
      return k in realGlobal;
    },
    get(_t, k) {
      if (typeof k !== 'string') return undefined;
      if (hasIn(ctx.sandbox, k)) return outward(ctx, Reflect.get(ctx.sandbox, k));
      if (isBuiltin(k)) return builtinValue(ctx, k);
      if (k in realGlobal && !(assigned?.has(k) ?? false)) return undefined;
      throw new ReferenceError(`${k} is not defined`);
    },
    set(_t, k, v) {
      if (Reflect.set(ctx.sandbox, k, v)) return true;
      // the proxy's own TypeError would name the trap; V8's names the property
      if (strict) throw new TypeError(`Cannot assign to read only property '${String(k)}' of object '#<Object>'`);
      return true;
    },
    deleteProperty(_t, k) {
      if (typeof k === 'string' && ctx.declared.has(k)) return false;
      return Reflect.deleteProperty(ctx.sandbox, k);
    },
  });
}

/** The `with` object for a SourceTextModule evaluated in a context (strict code: no implicit globals). */
export function contextScope(contextified: unknown): object | null {
  const ctx = contextified ? contexts.get(contextified as object) : undefined;
  if (!ctx) return null;
  return makeScope(ctx, new Set(), { internal: false, hiddenFns: null }, true);
}

// ---------------------------------------------------------------------------
// scripts

interface Analysis {
  strict: boolean;
  /** top-level var names (not in functions) */
  vars: string[];
  /** top-level function declarations */
  fns: string[];
  /** names assigned anywhere (null: couldn't parse; treat every name as assigned) */
  assigned: Set<string> | null;
  /** `this` inside sloppy functions: called plainly, V8 gives them the context's global */
  sloppyThis: { start: number; end: number }[];
}

function patternNames(p: any, out: Set<string>) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      out.add(p.name);
      break;
    case 'ObjectPattern':
      for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      break;
    case 'ArrayPattern':
      for (const el of p.elements) patternNames(el, out);
      break;
    case 'RestElement':
      patternNames(p.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      break;
  }
}

function analyzeScript(code: string): Analysis {
  try {
    const acorn = lib('internal/deps/acorn/acorn/dist/acorn');
    const walk = lib('internal/deps/acorn/acorn-walk/dist/walk');
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    let strict = false;
    for (const st of ast.body) {
      if (typeof st.directive !== 'string') break;
      if (st.directive === 'use strict') strict = true;
    }
    const vars = new Set<string>();
    const fns: string[] = [];
    const assigned = new Set<string>();
    for (const st of ast.body) if (st.type === 'FunctionDeclaration' && st.id) fns.push(st.id.name);
    walk.recursive(ast, null, {
      Function() {},
      Class() {},
      VariableDeclaration(node: any, st: unknown, c: (n: unknown, s: unknown) => void) {
        for (const d of node.declarations) {
          if (node.kind === 'var') patternNames(d.id, vars);
          if (d.init) c(d.init, st);
        }
      },
    });
    walk.full(ast, (node: any) => {
      if (node.type === 'AssignmentExpression') patternNames(node.left, assigned);
      else if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') assigned.add(node.argument.name);
      else if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type !== 'VariableDeclaration') patternNames(node.left, assigned);
    });
    const sloppyThis: { start: number; end: number }[] = [];
    if (!strict && code.includes('this')) {
      walk.ancestor(ast, {
        ThisExpression(node: any, ancestors: any[]) {
          // the innermost non-arrow function decides what `this` is; top-level `this` is already the context's global
          let fn: any = null;
          for (let i = ancestors.length - 2; i >= 0 && !fn; i--) {
            const a = ancestors[i];
            if (a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression') fn = a;
            else if (a.type === 'ClassBody') return;
          }
          if (!fn) return;
          // strict code (a 'use strict' function, or one inside it) gets undefined, as in V8
          for (const a of ancestors) {
            if ((a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') && a.body?.type === 'BlockStatement') {
              for (const st of a.body.body) {
                if (typeof st.directive !== 'string') break;
                if (st.directive === 'use strict') return;
              }
            }
          }
          sloppyThis.push({ start: node.start, end: node.end });
        },
      });
    }
    return { strict, vars: [...vars], fns, assigned, sloppyThis };
  } catch {
    return { strict: false, vars: [], fns: [], assigned: null, sloppyThis: [] };
  }
}

/** Code for a context: `this` of sloppy functions mapped from the worker's global to the context's. */
function withContextThis(code: string, a: Analysis): string {
  if (!a.sloppyThis.length) return code;
  let out = '';
  let last = 0;
  for (const r of a.sloppyThis) {
    out += code.slice(last, r.start) + '__ov$this(this)';
    last = r.end;
  }
  return out + code.slice(last);
}

const runners = new Map<string, Function>();

/** `with (scope) eval(code)` with `this` as the context's global; returns this run's function declarations. */
function runner(fns: string[]): Function {
  const key = fns.join(',');
  let r = runners.get(key);
  if (!r) {
    // the reader sees the declarations once the eval has hoisted them
    const body = fns.length
      ? `const __ov$read = function () { try { return [${key}]; } catch (__ov$e) { return null; } }; __ov$fn(__ov$read, true); try { return eval(__ov$go(__ov$c)); } finally { __ov$fn(__ov$read, false); }`
      : `return eval(__ov$go(__ov$c));`;
    r = indirectEval(`(function (__ov$s, __ov$c, __ov$go, __ov$fn, __ov$this) { with (__ov$s) { ${body} } })`) as Function;
    if (runners.size > 512) runners.clear();
    runners.set(key, r);
  }
  return r;
}

function runInContextRecord(ctx: Context, code: string, a: Analysis) {
  const sloppy = !a.strict;
  const vars = sloppy ? a.vars : [];
  const fns = sloppy ? a.fns : [];
  for (const v of vars) if (!hasIn(ctx.sandbox, v)) Reflect.set(ctx.sandbox, v, undefined);
  for (const n of vars) ctx.declared.add(n);
  for (const n of fns) ctx.declared.add(n);
  const state: ScopeState = { internal: true, hiddenFns: fns.length ? new Set(fns) : null };
  const scope = makeScope(ctx, a.assigned, state, a.strict);
  const go = (c: string) => {
    state.internal = false;
    return c;
  };
  const prevPending = ctx.pending;
  const copyFns = (read: () => unknown[] | null, starting: boolean) => {
    if (starting) {
      ctx.pending = { names: fns, read };
      return;
    }
    ctx.pending = prevPending;
    const vals = read();
    state.hiddenFns = null;
    if (vals) fns.forEach((n, i) => Reflect.set(ctx.sandbox, n, vals[i]));
  };
  const mapThis = (t: unknown) => (t === realGlobal ? ctx.global : t);
  return runner(fns).call(ctx.global, scope, code, go, copyFns, mapThis);
}

/**
 * A Script's top-level var/function declarations are non-configurable globals; an indirect
 * eval's are deletable. Declaring them first keeps `delete x` false as in Node.
 */
function declareGlobals(a: Analysis) {
  if (a.strict) return;
  for (const n of [...a.vars, ...a.fns]) {
    if (!Object.prototype.hasOwnProperty.call(realGlobal, n)) {
      Object.defineProperty(realGlobal, n, { value: undefined, writable: true, enumerable: true, configurable: false });
    }
  }
}

/** Rewrites `import(` to the dynamic-import router; leaves code alone when the lexer can't parse it. */
function routeDynamicImport(code: string, symbol: unknown, name: string): string {
  if (!code.includes('import')) return code;
  let imports: any[];
  try {
    [imports] = parseEsm(code) as any;
  } catch {
    return code;
  }
  const dyn = imports.filter((i) => i.type === 'dynamic' && i.dynamicStart >= 0);
  if (!dyn.length) return code;
  const id = nextScript++;
  referrers.set(id, { symbol, name });
  let out = '';
  let last = 0;
  for (const d of dyn) {
    out += code.slice(last, d.importStart) + `__ov$scriptImport(${id},`;
    // skip "import(" (and whitespace) up to the opening paren
    last = d.dynamicStart + 1;
  }
  return out + code.slice(last);
}

/** Whether code that failed to compile as CommonJS is ES module syntax. */
function looksLikeModule(code: string): boolean {
  try {
    const r = parseEsm(code) as any;
    return !!r[3];
  } catch {
    return false;
  }
}

const ESM_SYNTAX_ERRORS = [/Cannot use import statement outside a module/, /Unexpected token 'export'/, /Cannot use 'import\.meta' outside a module/, /await is only valid in async functions/, /Unexpected reserved word/, /Unexpected identifier 'await'/];

function isEsmSyntaxError(e: unknown): boolean {
  return e instanceof SyntaxError && ESM_SYNTAX_ERRORS.some((re) => re.test(e.message));
}

function sourceMapInfo(code: string) {
  const tail = code.slice(-1024);
  const sm = /\/\/[#@] sourceMappingURL=(\S+)\s*$/m.exec(tail);
  const su = /\/\/[#@] sourceURL=(\S+)\s*$/m.exec(tail);
  return { sourceMapURL: sm?.[1], sourceURL: su?.[1] };
}

/** How many columns the wrapper adds to line 1 of a compiled file (stack traces subtract it). */
export const lineOneOffset = new Map<string, number>();

function compileWrapper(code: string, filename: string, params: string[], symbol: unknown, scopes: object[] = []): Function {
  // V8 accepts a hashbang only at the very start of a script, not inside the wrapper
  if (code.startsWith('#!')) code = '//' + code.slice(2);
  const body = routeDynamicImport(code, symbol, filename);
  // keep the code on the wrapper's first line so line numbers match the file
  const fn = `function (${params.join(', ')}) {`;
  if (!scopes.length) {
    const head = `(${fn}`;
    lineOneOffset.set(filename, head.length);
    return indirectEval(`${head}${body}\n})\n//# sourceURL=${filename}`);
  }
  // compiled inside the context's scope and the extension objects (innermost last)
  const names = scopes.map((_, i) => `__ov$x${i}`);
  const head = `(function (${names.join(', ')}) { ${names.map((n) => `with (${n}) `).join('')}return ${fn}`;
  lineOneOffset.set(filename, head.length);
  return indirectEval(`${head}${body}\n} })\n//# sourceURL=${filename}`)(...scopes);
}

/**
 * vm.compileFunction code is compiled as V8 shows it, `function (a, b) {\n<body>\n}` (that is
 * its toString), under a sourceURL of its own; stack traces map it back to the filename and to
 * positions in the body (plus lineOffset/columnOffset).
 */
export const compiledPositions = new Map<string, { file: string; line: number; column: number }>();
const positionKeys = new Map<string, string>();

function compileVmFunction(code: string, filename: string, params: string[], symbol: unknown, scopes: object[], lineOffset: number, columnOffset: number): Function {
  const key = `${lineOffset}:${columnOffset}:${filename}`;
  let url = positionKeys.get(key);
  if (!url) {
    url = `ov-vm-function:${positionKeys.size + 1}`;
    positionKeys.set(key, url);
    // body line 1 is line 2 of the compiled source
    compiledPositions.set(url, { file: filename, line: lineOffset - 1, column: columnOffset });
  }
  const fn = `function (${params.join(', ')}) {\n${routeDynamicImport(code, symbol, filename)}\n}`;
  if (!scopes.length) return indirectEval(`(${fn})\n//# sourceURL=${url}`);
  // compiled inside the context's scope and the extension objects (innermost last)
  const names = scopes.map((_, i) => `__ov$x${i}`);
  return indirectEval(`(function (${names.join(', ')}) { ${names.map((n) => `with (${n}) `).join('')}return ${fn} })\n//# sourceURL=${url}`)(...scopes);
}

/**
 * A body that would close the function early: newer V8 (the browser's) says "Single function
 * literal required"; V8 under Node parses the body by itself and names the token that ends it.
 */
function checkFunctionBody(params: string[], code: string) {
  try {
    new Function(...params, code);
  } catch (e) {
    if (!(e instanceof SyntaxError) || !/Single function literal required/.test(e.message)) throw e;
    let message = e.message;
    try {
      lib('internal/deps/acorn/acorn/dist/acorn').parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
    } catch (pe: any) {
      if (typeof pe?.pos === 'number' && code[pe.pos]) message = `Unexpected token '${code[pe.pos]}'`;
    }
    throw new SyntaxError(message);
  }
}

const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

/**
 * The browser's SyntaxError from eval doesn't say where; V8 under Node shows the line with an
 * arrow when the error is fatal. acorn finds the position.
 */
function syntaxErrorArrow(err: SyntaxError, code: string, filename: string) {
  const arrowSym = S.privateSymbols.arrow_message_private_symbol;
  if (!arrowSym) return;
  try {
    const acorn = lib('internal/deps/acorn/acorn/dist/acorn');
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  } catch (e: any) {
    const loc = e?.loc;
    if (!loc) return;
    const src = code.split('\n')[loc.line - 1] ?? '';
    const tok = /^[\w$-]+|^./.exec(src.slice(loc.column))?.[0] ?? '';
    setPrivate(err, arrowSym, `${filename}:${loc.line}\n${src}\n${' '.repeat(loc.column)}${'^'.repeat(Math.max(1, tok.length))}\n`);
  }
}

/**
 * Like node::DecorateErrorStack for scripts run with displayErrors: the stack starts with the
 * script's line that threw and an arrow under it ("file:line\nsource\n  ^\n\n" + stack).
 */
function decorateErrorStack(err: unknown, filename: string, source: string, lineOffset: number, columnOffset: number) {
  // a user's Error.prepareStackTrace is called by the browser directly: reading the stack here
  // would run it (and fix its result) earlier than under Node
  const prep = (Error as any).prepareStackTrace;
  if (typeof prep === 'function' && prep.name !== 'prepareStackTrace') return;
  try {
    decorate(err, filename, source, lineOffset, columnOffset);
  } catch {}
}

function decorate(err: unknown, filename: string, source: string, lineOffset: number, columnOffset: number) {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return;
  const decorated = S.privateSymbols.decorated_private_symbol;
  const arrowSym = S.privateSymbols.arrow_message_private_symbol;
  if (!decorated || !arrowSym || (err as any)[decorated]) return;
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}:(\\d+):(\\d+)`).exec(err.stack);
  if (!m) return;
  const line = Number(m[1]);
  const srcLine = source.split('\n')[line - 1 - lineOffset];
  if (srcLine === undefined) return;
  let col = Number(m[2]) - 1 - (line - 1 === lineOffset ? columnOffset : 0);
  // V8 points at the statement for a throw
  const t = srcLine.lastIndexOf('throw', col);
  if (t >= 0) col = t;
  const arrow = `${filename}:${line}\n${srcLine}\n${' '.repeat(Math.max(0, col))}^\n`;
  setPrivate(err, arrowSym, arrow);
  try {
    err.stack = `${arrow}\n${err.stack}`;
  } catch {}
  setPrivate(err, decorated, true);
}

function cacheResult(code: string, cachedData: ArrayBufferView | undefined, produce: boolean) {
  const out: { cachedDataRejected?: boolean; cachedDataProduced?: boolean; cachedData?: Uint8Array } = {};
  if (cachedData !== undefined) out.cachedDataRejected = !cachedDataMatches(cachedData, code);
  if (produce) {
    out.cachedDataProduced = true;
    out.cachedData = makeCachedData(code);
  }
  return out;
}

export function createContextify() {
  const b = fromShape('contextify');
  const hostSymbol = () => S.privateSymbols.host_defined_option_symbol;

  class ContextifyScript {
    sourceMapURL: string | undefined;
    #source: string;
    #code: string;
    #filename: string;
    #analysis: Analysis | null = null;
    #lineOffset: number;
    #columnOffset: number;
    constructor(code: string, filename: string, lineOffset = 0, columnOffset = 0, cachedData?: ArrayBufferView, produce?: boolean, _parsingContext?: unknown, hostDefinedOptionId?: unknown) {
      this.#source = code;
      this.#filename = filename;
      this.sourceMapURL = sourceMapInfo(code).sourceMapURL;
      setPrivate(this, hostSymbol(), hostDefinedOptionId);
      this.#lineOffset = Math.max(0, lineOffset | 0);
      this.#columnOffset = Math.max(0, columnOffset | 0);
      let routed = routeDynamicImport(code, hostDefinedOptionId, filename);
      // positions in stack traces honour lineOffset/columnOffset: pad the code by as much
      if (this.#lineOffset || this.#columnOffset) {
        if (routed.startsWith('#!')) routed = '//' + routed.slice(2);
        routed = '\n'.repeat(this.#lineOffset) + ' '.repeat(this.#columnOffset) + routed;
      }
      this.#code = routed;
      // V8 compiles on construction, so syntax errors surface here
      try {
        new Function(this.#code);
      } catch (e) {
        if (e instanceof SyntaxError && !/Illegal return statement/.test(e.message)) throw e;
      }
      Object.assign(this, cacheResult(code, cachedData, !!produce));
    }
    #analyze(): Analysis {
      return (this.#analysis ??= analyzeScript(this.#code));
    }
    runInContext(contextified: unknown, _timeout?: number, displayErrors?: boolean, _breakOnSigint?: boolean, _breakOnFirstLine?: boolean) {
      const code = `${this.#code}\n//# sourceURL=${this.#filename}`;
      try {
        if (contextified === null || contextified === undefined) {
          if (/\b(var|function)\b/.test(this.#code)) declareGlobals(this.#analyze());
          return indirectEval(code);
        }
        const ctx = contexts.get(contextified as object) ?? makeContextRecord(contextified as object, true, true);
        const a = this.#analyze();
        return runInContextRecord(ctx, `${withContextThis(this.#code, a)}\n//# sourceURL=${this.#filename}`, a);
      } catch (e) {
        if (displayErrors) decorateErrorStack(e, this.#filename, this.#source, this.#lineOffset, this.#columnOffset);
        throw e;
      }
    }
    createCachedData() {
      return makeCachedData(this.#source);
    }
  }

  return Object.assign(b, {
    ContextifyScript,
    compileFunctionForCJSLoader(content: string, filename: string, _isSeaMain: boolean, shouldDetectModule: boolean) {
      const info = sourceMapInfo(content);
      try {
        const fn = compileWrapper(content, filename, CJS_PARAMS, S.perIsolateSymbols.vm_dynamic_import_default_internal);
        return { cachedDataRejected: false, sourceMapURL: info.sourceMapURL, sourceURL: info.sourceURL, function: fn, canParseAsESM: false };
      } catch (e) {
        if (shouldDetectModule && isEsmSyntaxError(e) && looksLikeModule(content)) {
          return { cachedDataRejected: false, sourceMapURL: info.sourceMapURL, sourceURL: info.sourceURL, function: undefined, canParseAsESM: true };
        }
        if (e instanceof SyntaxError) syntaxErrorArrow(e, content, filename);
        throw e;
      }
    },
    compileFunction(code: string, filename: string, lineOffset: number, columnOffset: number, cachedData: ArrayBufferView | undefined, produce: boolean, parsingContext: unknown, contextExtensions: unknown[], params: string[] | undefined, hostDefinedOptionId: unknown) {
      const scopes: object[] = [];
      const ctx = parsingContext ? contexts.get(parsingContext as object) : undefined;
      if (ctx) scopes.push(makeScope(ctx, null, { internal: false, hiddenFns: null }));
      for (const ext of contextExtensions ?? []) if (ext && typeof ext === 'object') scopes.push(ext);
      // V8 parses the body on its own: code like `});(function () {` mustn't close the wrapper
      checkFunctionBody(params ?? [], code);
      const fn = compileVmFunction(code, filename, params ?? [], hostDefinedOptionId, scopes, lineOffset | 0, columnOffset | 0);
      setPrivate(fn, hostSymbol(), hostDefinedOptionId);
      return { function: fn, ...cacheResult(code, cachedData, produce), ...sourceMapInfo(code) };
    },
    containsModuleSyntax(code: string, _filename: string) {
      try {
        new Function(...CJS_PARAMS, code);
        return false;
      } catch (e) {
        return isEsmSyntaxError(e) && looksLikeModule(code);
      }
    },
    makeContext(contextObject: object | symbol, _name?: string, _origin?: string, strings = true, wasm = true, _microtaskQueue?: boolean, hostDefinedOptionId?: unknown) {
      // vm.constants.DONT_CONTEXTIFY: an ordinary global, returned itself
      const vanilla = typeof contextObject === 'symbol';
      const sandbox = vanilla ? {} : contextObject;
      const ctx = makeContextRecord(sandbox, strings !== false, wasm !== false);
      const result = vanilla ? ctx.global : sandbox;
      const sym = S.privateSymbols.contextify_context_private_symbol;
      setPrivate(sandbox, sym, ctx.global);
      setPrivate(ctx.global, sym, ctx.global);
      setPrivate(result, hostSymbol(), hostDefinedOptionId);
      return result;
    },
    startSigintWatchdog: () => {},
    stopSigintWatchdog: () => false,
    watchdogHasPendingSigint: () => false,
    measureMemory(mode: number) {
      const used = Number(nativePerformance?.memory?.usedJSHeapSize ?? 0);
      const est = () => ({ jsMemoryEstimate: used, jsMemoryRange: [used, used] });
      if (mode !== b.constants?.measureMemory?.mode?.DETAILED) return Promise.resolve({ total: est() });
      const other = liveContexts.filter((r) => r.deref() !== undefined).map(() => ({ jsMemoryEstimate: 0, jsMemoryRange: [0, used] }));
      return Promise.resolve({ total: est(), current: est(), other });
    },
  });
}
