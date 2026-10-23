// Process worker entry for the ported Node.js: does what node::CreateEnvironment and
// node::StartExecution do in C++ — per-context scripts, the process object, the realm and
// node bootstraps, then the main script — and runs the event loop until the process exits.

// @ts-ignore generated at build time by scripts/gen-nodelib.mjs
import { ids, params, sources } from './nodelib.js';
import nodeData from '../node/data/process.json';
import { initSys, post, sys } from '../node/sys.ts';
import { getInternalBinding, getLinkedBinding } from './bindings/index.ts';
import { lineOneOffset } from './bindings/contextify.ts';
import { moduleUrlForServed } from './bindings/module_wrap.ts';
import { fromShape } from './bindings/shape.ts';
import * as loop from './loop.ts';
import { parseCommandLine } from './options.ts';
import { S, type InitMsg } from './state.ts';
import './typescript.ts';
import './fetch.ts';

declare const self: DedicatedWorkerGlobalScope;

// taken before Node's bootstrap reshapes the global scope
const scopePost = self.postMessage.bind(self);
const scopeListen = self.addEventListener.bind(self);
const enc = new TextEncoder();
const NODE_VERSION = `v${nodeData.versions.node}`;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.t === 'init') {
    try {
      boot(msg as InitMsg);
    } catch (e) {
      bootFailure(e);
    }
    return;
  }
  const h = S.kernelHandlers.get(msg?.t);
  if (h) h(msg);
};

function writeFd(fd: number, s: string) {
  try {
    sys('write', { fd, pos: null }, enc.encode(s));
  } catch {}
}

function bootFailure(e: unknown): never {
  writeFd(2, `[openvessel] node bootstrap failed: ${(e as Error)?.stack ?? e}\n`);
  return loop.reallyExit(10); // kBootstrapFailure
}

loop.setExitHook((code: number): never => {
  S.exiting = true;
  if (!S.isMainThread) {
    try {
      sys('threadExit', { code });
    } catch {}
  } else {
    try {
      sys('exit', { code });
    } catch {}
  }
  // the kernel terminates this worker; never run anything else
  const block = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(block, 0, 0);
});

// -----------------------------------------------------------------------------
// fatal errors (PrintUncaughtException)

function sourceArrow(err: any): string {
  const arrowSym = S.privateSymbols.arrow_message_private_symbol;
  if (err && typeof err === 'object' && arrowSym && typeof err[arrowSym] === 'string') return err[arrowSym];
  const stack = typeof err?.stack === 'string' ? err.stack : '';
  const m = /\(?((?:\/|file:\/\/|node:)[^():]+):(\d+):(\d+)\)?/.exec(stack.split('\n').find((l: string) => /^\s+at /.test(l)) ?? '');
  if (!m) return '';
  try {
    const file = m[1].replace(/^file:\/\//, '');
    const text = file.startsWith('node:') ? sources[file.slice(5)] : new TextDecoder().decode(sys<Uint8Array>('readFile', { p: file }));
    const line = text?.split('\n')[Number(m[2]) - 1];
    if (line === undefined) return '';
    return `${file}:${m[2]}\n${line}\n${' '.repeat(Math.max(0, Number(m[3]) - 1))}^\n\n`;
  } catch {
    return '';
  }
}

S.sourceLine = (file: string, line: number) => {
  try {
    const text = file.startsWith('node:') ? sources[file.slice(5)] : new TextDecoder().decode(sys<Uint8Array>('readFile', { p: file.replace(/^file:\/\//, '') }));
    return text?.split('\n')[line - 1];
  } catch {
    return undefined;
  }
};

loop.setFatalPrinter((err: unknown) => {
  let text: string;
  try {
    if (err instanceof Error || (err && typeof err === 'object' && 'stack' in (err as object))) {
      let stack = String((err as Error).stack);
      if (S.enhanceStack) {
        try {
          S.enhanceStack.before(err as Error);
          stack = S.enhanceStack.after(err as Error);
        } catch {}
      }
      text = `${sourceArrow(err)}${stack}`;
    } else {
      let shown: string;
      try {
        shown = S.requireBuiltin('internal/util/inspect').inspect(err);
      } catch {
        shown = String(err);
      }
      text = `${sourceArrow(err)}Uncaught ${shown}\n(Use \`node --trace-uncaught ...\` to show where the exception was thrown)`;
    }
  } catch {
    text = String(err);
  }
  writeFd(2, `${text}\n\nNode.js ${NODE_VERSION}\n`);
});

// -----------------------------------------------------------------------------
// process object (node_process_object.cc)

function createEnvProxy(initial: Record<string, string>) {
  const store: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(initial)) store[k] = String(v);
  return new Proxy(store, {
    set(t, k, v) {
      if (typeof k === 'symbol') {
        const e = new TypeError('Cannot convert a Symbol value to a string');
        throw e;
      }
      t[k] = String(v);
      return true;
    },
    defineProperty(t, k, d) {
      if (typeof k === 'symbol') return false;
      if ('get' in d || 'set' in d || d.configurable === false || d.writable === false || d.enumerable === false) {
        const e = new TypeError(`'process.env' only accepts a configurable, writable, and enumerable data descriptor`) as TypeError & { code: string };
        e.code = 'ERR_INVALID_OBJECT_DEFINE_PROPERTY';
        throw e;
      }
      t[k] = String(d.value);
      return true;
    },
    deleteProperty(t, k) {
      if (typeof k === 'string') delete t[k];
      return true;
    },
  });
}

function createProcessObject(init: InitMsg) {
  function process() {}
  const proc: any = Object.create(process.prototype);
  proc.version = NODE_VERSION;
  proc.versions = { ...nodeData.versions };
  proc.arch = 'x64';
  proc.platform = 'linux';
  proc.release = { ...nodeData.release };
  proc._rawDebug = (...a: unknown[]) => writeFd(2, a.join(' ') + '\n');
  proc.env = createEnvProxy(init.env);
  proc[S.privateSymbols.exit_info_private_symbol] = new Int32Array(3);
  return proc;
}

// -----------------------------------------------------------------------------
// bootstrap

/**
 * V8 calls the C++ PrepareStackTraceCallback in Node, which runs Node's JS callback (it honours
 * Error.prepareStackTrace and Node's internal overrides). A browser's V8 calls
 * Error.prepareStackTrace directly, so that slot gets a function doing what the C++ does; frames of
 * the runtime itself (the "C++" side) are left out.
 */
/**
 * Code compiled with eval reports its top-level frame as "eval (file:line:col)"; under Node, V8
 * compiles builtins, modules and scripts directly, so those read "file:line:col" (a CommonJS
 * module's wrapper: "Object.<anonymous> (file:line:col)"). Line 1 of a CommonJS file also carries
 * the wrapper's columns, which are taken off again.
 */
const kMapped = Symbol('ov.mappedFrame');
function asCompiledFrame(cs: any) {
  if (!cs?.isEval?.() || cs[kMapped]) return cs;
  const file = cs.getScriptNameOrSourceURL?.() || cs.getFileName?.();
  if (!file) return cs;
  const line = cs.getLineNumber();
  let col = cs.getColumnNumber();
  const shift = line === 1 ? (lineOneOffset.get(file) ?? 0) : 0;
  col -= shift;
  const name = cs.getFunctionName?.();
  let text: string;
  if (!name || name === 'eval') text = cs.getTypeName?.() === 'Object' ? `Object.<anonymous> (${file}:${line}:${col})` : `${file}:${line}:${col}`;
  else if (shift) text = String(cs).replace(`:${line}:${col + shift}`, `:${line}:${col}`);
  else return cs;
  return new Proxy(cs, {
    get(target, k) {
      if (k === kMapped) return true;
      if (k === 'toString') return () => text;
      if (k === 'getColumnNumber') return () => col;
      if (k === 'getFileName') return () => file;
      const v = target[k];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * CallSite.getFileName as V8 reports it under Node: ES modules are served to the browser from
 * /__ov/mw/… but are file:// URLs to Node, and code compiled with eval (CommonJS modules, builtins)
 * is named by its sourceURL. Patched on the shared CallSite prototype so callers that install their
 * own Error.prepareStackTrace (callsites, depd, …) see the same names.
 */
function patchCallSites() {
  const prev = (Error as any).prepareStackTrace;
  (Error as any).prepareStackTrace = (_e: Error, s: unknown[]) => s;
  const sample = (new Error().stack as unknown as object[])[0];
  (Error as any).prepareStackTrace = prev;
  const proto = sample && Object.getPrototypeOf(sample);
  if (!proto || typeof proto.getFileName !== 'function') return;
  const getFileName = proto.getFileName;
  const getScriptName = proto.getScriptNameOrSourceURL;
  const fix = (f: unknown, cs: any) => {
    if (typeof f === 'string' && f) return moduleUrlForServed(f) ?? f;
    return cs.isEval?.() ? getScriptName.call(cs) || f : f;
  };
  const define = (name: string, fn: Function) => {
    try {
      Object.defineProperty(proto, name, { value: fn, writable: false, enumerable: false, configurable: true });
    } catch {}
  };
  define('getFileName', function (this: any) {
    return fix(getFileName.call(this), this);
  });
  define('getScriptNameOrSourceURL', function (this: any) {
    const f = getScriptName.call(this);
    return typeof f === 'string' ? (moduleUrlForServed(f) ?? f) : f;
  });
}

function installStackTraceHook() {
  patchCallSites();
  const nodePrepare = (Error as any).prepareStackTrace as (e: Error, t: any[]) => unknown;
  const runtimeFile = new URL(import.meta.url).pathname;
  let inCallback = false;
  function prepareStackTrace(error: Error, trace: any[]) {
    const frames = trace.filter((cs) => {
      const f = cs?.getFileName?.();
      if (typeof f === 'string' && f.endsWith(runtimeFile)) return false;
      // the boundary of an indirect eval that compiled a module or script
      if (!f && !cs?.getScriptNameOrSourceURL?.() && cs?.getFunctionName?.() === 'eval') return false;
      return true;
    }).map(asCompiledFrame);
    if (inCallback || !S.prepareStackTrace) return nodePrepare(error, frames);
    inCallback = true;
    try {
      return S.prepareStackTrace(globalThis, error, frames);
    } finally {
      inCallback = false;
    }
  }
  Object.defineProperty(Error, 'prepareStackTrace', { value: prepareStackTrace, writable: true, enumerable: false, configurable: true });
}

/**
 * Makes the global object look like Node's: names a Worker has but Node doesn't (postMessage,
 * location, indexedDB, onmessage, addEventListener…) are hidden, and enumerability follows Node.
 * Prototypes are left alone (EventTarget.prototype is shared with AbortSignal, MessagePort…);
 * inherited names are shadowed on the global itself.
 */
function shapeGlobal() {
  const nodeGlobals = nodeData.globals as Record<string, boolean>;
  const g = globalThis as any;
  const seen = new Set<string>();
  for (let obj = g; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // the runtime's own entry points (non-enumerable already)
      if (name.startsWith('__ov')) continue;
      const own = obj === g;
      const d = Object.getOwnPropertyDescriptor(obj, name)!;
      try {
        if (name in nodeGlobals) {
          if (own && d.configurable && d.enumerable !== nodeGlobals[name]) Object.defineProperty(g, name, { enumerable: nodeGlobals[name] });
          continue;
        }
        if (own && d.configurable) delete g[name];
        else if (!own) Object.defineProperty(g, name, { value: undefined, writable: true, configurable: true, enumerable: false });
      } catch {}
    }
  }
}

function selectMain(values: Record<string, unknown>, argv: string[], hasEval: boolean): string {
  if (!S.isMainThread) return 'internal/main/worker_thread';
  if (values['--help']) return 'internal/main/print_help';
  if (hasEval && !values['--interactive']) return 'internal/main/eval_string';
  if (values['--check']) return 'internal/main/check_syntax';
  if (values['--test']) return 'internal/main/test_runner';
  if (argv[1] && argv[1] !== '-') return 'internal/main/run_main_module';
  let stdinIsTty = false;
  try {
    stdinIsTty = sys<string | null>('fdKind', { fd: 0 }) === 'tty';
  } catch {}
  if (values['--interactive'] || stdinIsTty) return 'internal/main/repl';
  return 'internal/main/eval_stdin';
}

// OV_TIMING=1 prints how long each bootstrap stage took
const marks: [string, number][] = [];
const mark = (name: string) => marks.push([name, performance.now()]);
mark('script loaded');

const indirectEval = eval;
const compiled = new Map<string, Function>();
/** Compiles a builtin the way node_builtins.cc does: a function of its parameters, named node:<id>. */
function compileBuiltin(id: string): Function | undefined {
  let fn = compiled.get(id);
  if (!fn) {
    const src: string | undefined = sources[id];
    if (src === undefined) return undefined;
    fn = indirectEval(`(function (${params[id]}) {${src}\n})\n//# sourceURL=node:${id}`) as Function;
    compiled.set(id, fn);
  }
  return fn;
}

function run(id: string, ...args: unknown[]) {
  const fn = compileBuiltin(id);
  if (!fn) throw new Error(`missing builtin ${id}`);
  return fn.apply(undefined, args);
}

function boot(init: InitMsg) {
  mark('init received');
  S.init = init;
  S.isMainThread = init.kind === 'main';
  S.runtimeOrigin = self.location.origin;
  S.cwd = init.cwd;
  initSys(init.sab, (m, t) => scopePost(m, t ?? []));

  // command line (node_options.cc)
  if (S.isMainThread) {
    const cl = parseCommandLine(init.argv, init.env.NODE_OPTIONS ?? '');
    if (cl.error) {
      writeFd(2, `${init.argv[0] ?? 'node'}: ${cl.error}\n`);
      loop.reallyExit(9);
    }
    if (cl.values['--version']) {
      writeFd(1, `${NODE_VERSION}\n`);
      loop.reallyExit(0);
    }
    S.optionValues = cl.values;
    S.execArgv = cl.execArgv;
    S.argv = cl.argv;
    S.hasEval = cl.execArgv.some((a) => /^(-e|-p|-pe|--eval|--print)(=|$)/.test(a));
  } else {
    const cl = parseCommandLine(['node', ...(init.execArgv ?? [])], '');
    S.optionValues = cl.values;
    S.execArgv = init.execArgv ?? [];
    S.argv = init.argv;
  }

  // unhandled rejections and stray errors from browser callbacks
  scopeListen('unhandledrejection', (e: PromiseRejectionEvent) => {
    e.preventDefault();
    S.onUnhandledRejection?.(e.promise, e.reason);
  });
  scopeListen('rejectionhandled', (e: PromiseRejectionEvent) => {
    S.onRejectionHandled?.(e.promise);
  });
  scopeListen('error', (e: ErrorEvent) => {
    e.preventDefault();
    loop.triggerUncaughtException(e.error ?? new Error(e.message), false);
  });

  // per-context scripts (node_realm / node_context_data)
  const util = getInternalBinding('util');
  const symbols = getInternalBinding('symbols');
  const primordials: Record<string, unknown> = Object.create(null);
  const perContext: Record<string, any> = Object.create(null);
  for (const id of ['internal/per_context/primordials', 'internal/per_context/domexception', 'internal/per_context/messageport']) {
    run(id, perContext, primordials, util.privateSymbols, symbols);
  }
  S.primordials = primordials;
  S.perContextExports = perContext;
  mark('per_context');

  // builtins binding (node_builtins.cc)
  S.builtinsBinding = Object.assign(fromShape('builtins'), {
    builtinIds: ids,
    compileFunction(id: string) {
      const fn = compileBuiltin(id);
      if (!fn) {
        const e = new Error(`No such built-in module: ${id}`) as Error & { code: string };
        e.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw e;
      }
      return fn;
    },
    setInternalLoaders(internalBinding: (n: string) => any, requireBuiltin: (id: string) => any) {
      S.internalBinding = internalBinding;
      S.requireBuiltin = requireBuiltin;
    },
    hasCachedBuiltins: () => true,
    getCacheUsage: () => ({ compiledWithCache: [], compiledWithoutCache: [], compiledInSnapshot: [] }),
    natives: new Proxy(Object.create(null), {
      get: (_t, k) => (typeof k === 'string' ? sources[k] : undefined),
      has: (_t, k) => typeof k === 'string' && k in sources,
      ownKeys: () => ids,
      getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && k in sources ? { value: sources[k], enumerable: true, configurable: true } : undefined),
    }),
  });

  const process = createProcessObject(init);
  S.process = process;

  run('internal/bootstrap/realm', process, getLinkedBinding, getInternalBinding, primordials);
  installStackTraceHook();
  mark('realm');
  const require = S.requireBuiltin;
  const internalBinding = S.internalBinding;
  run('internal/bootstrap/node', process, require, internalBinding, primordials);
  mark('bootstrap/node');
  if (!getInternalBinding('config').noBrowserGlobals) {
    run('internal/bootstrap/web/exposed-wildcard', process, require, internalBinding, primordials);
    run('internal/bootstrap/web/exposed-window-or-worker', process, require, internalBinding, primordials);
  }
  if (S.isMainThread) {
    run('internal/bootstrap/switches/is_main_thread', process, require, internalBinding, primordials);
    run('internal/bootstrap/switches/does_own_process_state', process, require, internalBinding, primordials);
  } else {
    run('internal/bootstrap/switches/is_not_main_thread', process, require, internalBinding, primordials);
    run('internal/bootstrap/switches/does_not_own_process_state', process, require, internalBinding, primordials);
  }

  shapeGlobal();
  mark('web + switches');
  const main = selectMain(S.optionValues, S.argv, S.hasEval);
  loop.scope(() => {
    const r = run(main, process, require, internalBinding, primordials);
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((e) => loop.triggerUncaughtException(e, false));
  });
  mark(main);
  if (init.env.OV_TIMING) {
    const t0 = performance.timeOrigin;
    writeFd(2, `[timing] worker start→script ${Math.round(marks[0][1])}ms\n` + marks.slice(1).map(([n, t], i) => `[timing] ${n}: ${(t - marks[i][1]).toFixed(1)}ms`).join('\n') + `\n[timing] total ${Math.round(marks[marks.length - 1][1])}ms since worker start (${new Date(t0).toISOString().slice(11, 23)})\n`);
  }
  loop.startLoop();
}

void post;
