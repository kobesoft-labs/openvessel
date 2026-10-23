// Process worker: boots the Node.js-compatible runtime for one process (or worker thread).

import './buffer-patch.ts';
import * as bufferMod from 'buffer';
import pathMod from '../shared/path.ts';
import * as testRunner from './test-runner.ts';
import { setCwdProvider } from '../shared/path.ts';
import { fileURLToPathLoose, pathToFileURLString } from '../shared/resolve.ts';
import assertMod, { strict as assertStrict } from './assert.ts';
import childProcess, { onChildExit } from './child_process.ts';
import cryptoMod from './crypto.ts';
import EventEmitter from './events.ts';
import fsMod, { onKernelData, onWatchEvent, setCwd } from './fs.ts';
import httpMod, { https as httpsMod } from './http.ts';
import * as loop from './loop.ts';
import * as misc from './misc.ts';
import M, { dimport, installStackMapping, lexerInit, loadFile, metaFor, preloadSucrase, setBuiltinGetter, setConditions, setRuntimeOrigin } from './module.ts';
import netMod from './net.ts';
import { onNetMessage } from './netbridge.ts';
import { ovFetch, setNetInfo } from './netfetch.ts';
import osMod, { setOsInfo } from './os.ts';
import { NODE_VERSION, createProcess } from './process.ts';
import querystringMod from './querystring.ts';
import readlineMod from './readline.ts';
import streamMod, { consumers, streamPromises } from './stream.ts';
import stringDecoderMod from './string_decoder.ts';
import { initSys, post, sys } from './sys.ts';
import urlMod from './url.ts';
import utilMod from './util.ts';
import * as wt from './worker_threads.ts';
import { wasiModule } from './wasi.ts';
import { hideBrowserGlobals } from './globals.ts';
import zlibMod from './zlib.ts';

declare const self: DedicatedWorkerGlobalScope;

// private references taken before the Node-like globals hide them
const scope = self;
const scopePost = self.postMessage.bind(self);
const scopeListen = self.addEventListener.bind(self);
const runtimeOrigin = self.location.origin;

interface InitMsg {
  t: 'init';
  kind: 'main' | 'thread';
  pid: number;
  ppid: number;
  tid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  sab: SharedArrayBuffer;
  ttys: Record<number, { cols: number; rows: number } | null>;
  hostname: string;
  // thread only
  file?: string;
  eval?: boolean;
  evalType?: string;
  execArgv?: string[];
  workerData?: unknown;
  envData?: [unknown, unknown][];
  port?: MessagePort;
}

const enc = new TextEncoder();
let proc: any;
let exiting = false;
let isThread = false;
let threadPort: MessagePort | null = null;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.t === 'init') {
    boot(msg as InitMsg).catch((e) => fatal(e));
    return;
  }
  dispatch(msg);
};

function dispatch(msg: any) {
  switch (msg?.t) {
    case 'fd-data':
      onKernelData(msg);
      return;
    case 'child-exit':
      onChildExit(msg);
      return;
    case 'watch':
      onWatchEvent(msg);
      return;
    case 'signal':
      deliverSignal(msg.sig);
      return;
    case 'thread-exit':
      return;
  }
  if (onNetMessage(msg)) return;
}

function deliverSignal(sig: string) {
  if (!proc) return;
  if (sig === 'SIGWINCH') {
    for (const fd of [1, 2]) {
      try {
        const s = sys<{ cols: number; rows: number } | null>('ttySize', { fd });
        if (s) (fd === 1 ? proc.stdout : proc.stderr)._refreshSize(s.cols, s.rows);
      } catch {}
    }
  }
  if (proc.listenerCount(sig) > 0) proc.emit(sig, sig);
  else if (sig !== 'SIGWINCH') exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 } as Record<string, number>)[sig]!);
}

// -----------------------------------------------------------------------------
// builtin registry

const builtins: Record<string, () => any> = {};
const cache = new Map<string, any>();

function defineBuiltins() {
  const bufferExtras = {
    ...bufferMod,
    Blob: globalThis.Blob,
    File: globalThis.File,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    isUtf8: (b: Uint8Array) => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(b);
        return true;
      } catch {
        return false;
      }
    },
    isAscii: (b: Uint8Array) => b.every((x) => x < 128),
    transcode: (b: Uint8Array, from: string, to: string) => bufferMod.Buffer.from(bufferMod.Buffer.from(b).toString(from as BufferEncoding), to as BufferEncoding),
    resolveObjectURL: () => undefined,
  };
  const webStreams = {
    ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy, TextEncoderStream, TextDecoderStream, CompressionStream, DecompressionStream,
    ReadableStreamDefaultReader, ReadableStreamBYOBReader: (globalThis as any).ReadableStreamBYOBReader, ReadableStreamDefaultController, ReadableByteStreamController: (globalThis as any).ReadableByteStreamController, WritableStreamDefaultWriter, WritableStreamDefaultController, TransformStreamDefaultController,
  };
  const consoleMod = Object.assign(Object.create(null), globalThis.console, { Console: misc.ConsoleCtor });
  const constantsMod = { ...osMod.constants.errno, ...osMod.constants.signals, ...fsMod.constants, ...cryptoMod.constants };
  const wtMod = wt.default as any;
  Object.defineProperties(wtMod, {
    isMainThread: { get: () => wt.isMainThread, enumerable: true },
    parentPort: { get: () => wt.parentPort, enumerable: true },
    workerData: { get: () => wt.workerData, enumerable: true },
    threadId: { get: () => wt.threadId, enumerable: true },
  });
  Object.assign(builtins, {
    fs: () => fsMod,
    'fs/promises': () => fsMod.promises,
    path: () => pathMod,
    'path/posix': () => pathMod,
    'path/win32': () => (pathMod as any).win32,
    events: () => EventEmitter,
    stream: () => streamMod,
    'stream/promises': () => streamPromises,
    'stream/web': () => webStreams,
    'stream/consumers': () => consumers,
    buffer: () => bufferExtras,
    util: () => utilMod,
    'util/types': () => utilMod.types,
    sys: () => utilMod,
    os: () => osMod,
    url: () => urlMod,
    querystring: () => querystringMod,
    string_decoder: () => stringDecoderMod,
    crypto: () => cryptoMod,
    zlib: () => zlibMod,
    assert: () => assertMod,
    'assert/strict': () => assertStrict,
    child_process: () => childProcess,
    worker_threads: () => wtMod,
    net: () => netMod,
    http: () => httpMod,
    https: () => httpsMod,
    tty: () => misc.tty,
    readline: () => readlineMod,
    'readline/promises': () => readlineMod.promises,
    timers: () => misc.timers,
    'timers/promises': () => misc.timersPromises,
    vm: () => misc.vm,
    async_hooks: () => misc.asyncHooks,
    perf_hooks: () => misc.perfHooks,
    dns: () => misc.dns,
    'dns/promises': () => misc.dns.promises,
    v8: () => misc.v8,
    diagnostics_channel: () => misc.diagnosticsChannel,
    punycode: () => misc.punycode,
    inspector: () => misc.inspector,
    'inspector/promises': () => misc.inspector,
    cluster: () => misc.cluster,
    dgram: () => misc.dgram,
    http2: () => misc.http2,
    tls: () => misc.tls,
    trace_events: () => misc.traceEvents,
    domain: () => misc.domain,
    repl: () => misc.repl,
    test: () => testRunner.default,
    'test/reporters': () => ({}),
    sea: () => misc.sea,
    sqlite: () => misc.sqlite,
    console: () => consoleMod,
    constants: () => constantsMod,
    module: () => M,
    process: () => proc,
    wasi: () => wasiModule,
    _stream_readable: () => streamMod.Readable,
    _stream_writable: () => streamMod.Writable,
    _stream_duplex: () => streamMod.Duplex,
    _stream_transform: () => streamMod.Transform,
    _stream_passthrough: () => streamMod.PassThrough,
    _http_agent: () => ({ Agent: httpMod.Agent, globalAgent: httpMod.globalAgent }),
    _http_client: () => ({ ClientRequest: httpMod.ClientRequest }),
    _http_common: () => ({ methods: httpMod.METHODS }),
    _http_incoming: () => ({ IncomingMessage: httpMod.IncomingMessage }),
    _http_outgoing: () => ({ OutgoingMessage: httpMod.OutgoingMessage }),
    _http_server: () => ({ Server: httpMod.Server, ServerResponse: httpMod.ServerResponse, STATUS_CODES: httpMod.STATUS_CODES }),
    _stream_wrap: () => streamMod.Duplex,
    _tls_common: () => ({}),
    _tls_wrap: () => ({}),
  });
}

export function builtin(name: string): any {
  const n = name.startsWith('node:') ? name.slice(5) : name;
  if (cache.has(n)) return cache.get(n);
  const f = builtins[n];
  if (!f) {
    const e = new Error(`No such built-in module: node:${n}`) as Error & { code: string };
    e.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw e;
  }
  const m = f();
  cache.set(n, m);
  return m;
}

// -----------------------------------------------------------------------------
// globals

function installGlobals() {
  const g = globalThis as any;
  g.global = g;
  g.process = proc;
  g.Buffer = bufferMod.Buffer;
  g.setTimeout = loop.setTimeout;
  g.clearTimeout = loop.clearTimeout;
  g.setInterval = loop.setInterval;
  g.clearInterval = loop.clearInterval;
  g.setImmediate = loop.setImmediate;
  g.clearImmediate = loop.clearImmediate;
  g.fetch = ovFetch;
  g.console = misc.makeConsole(proc.stdout, proc.stderr);
  // timers in Node are objects with ref/unref; promisified setTimeout via util.promisify
  (loop.setTimeout as any)[Symbol.for('nodejs.util.promisify.custom')] = misc.timersPromises.setTimeout;
  (loop.setImmediate as any)[Symbol.for('nodejs.util.promisify.custom')] = misc.timersPromises.setImmediate;
  g.gc = () => {};
  // keep the loop alive while WebAssembly compiles (Node does)
  const W = WebAssembly as any;
  for (const k of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
    const orig = W[k];
    if (typeof orig === 'function') W[k] = (...a: any[]) => loop.track(orig.apply(W, a));
  }
  const subtle = crypto.subtle as any;
  if (subtle) {
    for (const k of ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'importKey', 'exportKey', 'generateKey', 'deriveBits', 'deriveKey']) {
      const orig = subtle[k];
      if (typeof orig === 'function') {
        try {
          subtle[k] = (...a: any[]) => loop.track(orig.apply(subtle, a));
        } catch {}
      }
    }
  }
  // fallback for rewritten code that runs detached from its module (fn.toString() → new Function)
  Object.defineProperty(g, '__ov_di', {
    value: (s: unknown, o?: unknown) => dimport(s, o, pathToFileURLString(proc.cwd() + '/[eval]')),
    configurable: true,
    writable: true,
  });
  g.__ov = {
    builtin,
    requireForImport: (file: string) => loadFile(file, null, false),
    meta: metaFor,
    dimport,
  };
}

// -----------------------------------------------------------------------------
// exit & errors

function writeErr(s: string) {
  try {
    sys('write', { fd: 2, pos: null }, enc.encode(s));
  } catch {}
}

function exit(code: number): never {
  if (!exiting) {
    exiting = true;
    proc.exitCode = code;
    if (!isThread) {
      try {
        proc.emit('exit', code);
      } catch (e) {
        writeErr(String((e as Error)?.stack ?? e) + '\n');
      }
    }
  }
  const c = proc.exitCode ?? code;
  if (isThread) {
    try {
      threadPort?.postMessage({ k: 'exit', code: c });
    } catch {}
    sys('threadExit', { code: c });
  } else {
    sys('exit', { code: typeof c === 'number' ? c : Number(c) || 0 });
  }
  // the kernel terminates this worker; never continue
  const block = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(block, 0, 0);
}

function fatal(e: unknown) {
  writeErr(`[openvessel] runtime failure: ${(e as Error)?.stack ?? e}\n`);
  try {
    exit(1);
  } catch {}
}

let handlingError = false;
function uncaught(err: unknown, origin: 'uncaughtException' | 'unhandledRejection') {
  if (exiting) return;
  const capture = proc._captureCb?.();
  if (capture) {
    capture(err);
    return;
  }
  if (origin === 'unhandledRejection' && proc.listenerCount('unhandledRejection') > 0) {
    proc.emit('unhandledRejection', err, Promise.reject(err).catch(() => {}));
    return;
  }
  if (proc.listenerCount('uncaughtException') > 0 && !handlingError) {
    handlingError = true;
    try {
      proc.emit('uncaughtExceptionMonitor', err, origin);
      proc.emit('uncaughtException', err, origin);
    } finally {
      handlingError = false;
    }
    return;
  }
  if (isThread && threadPort) {
    const e = err as any;
    try {
      threadPort.postMessage({ k: 'error', d: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack, code: (e as any).code } : e });
    } catch {}
    exit(1);
  }
  let text: string;
  if (err instanceof Error) text = utilMod.inspect(err);
  else if (origin === 'unhandledRejection') text = `node:internal/process/promises:394\n    triggerUncaughtException(err, true /* fromPromise */);\n    ^\n\n[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${utilMod.inspect(err)}".] {\n  code: 'ERR_UNHANDLED_REJECTION'\n}`;
  else text = `Uncaught ${utilMod.inspect(err)}`;
  writeErr(`${text}\n\nNode.js v${NODE_VERSION}\n`);
  exit(proc.exitCode && proc.exitCode !== 0 ? proc.exitCode : 1);
}

function installErrorHandlers() {
  scopeListen('error', (ev) => {
    ev.preventDefault();
    uncaught(ev.error ?? new Error(ev.message), 'uncaughtException');
  });
  scopeListen('unhandledrejection', (ev: PromiseRejectionEvent) => {
    ev.preventDefault();
    uncaught(ev.reason, 'unhandledRejection');
  });
  loop.setTickErrorHandler((e) => uncaught(e, 'uncaughtException'));
}

// -----------------------------------------------------------------------------
// node CLI

interface CliOptions {
  evalCode?: string;
  print?: boolean;
  inputType?: string;
  requires: string[];
  imports: string[];
  conditions: string[];
  script?: string;
  args: string[];
  execArgv: string[];
  version?: boolean;
  help?: boolean;
  envFiles: string[];
  check?: boolean;
  interactive?: boolean;
}

function splitOptions(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function parseCli(argv: string[], nodeOptions: string): CliOptions {
  const o: CliOptions = { requires: [], imports: [], conditions: [], args: [], execArgv: [], envFiles: [] };
  const all = [...splitOptions(nodeOptions), ...argv];
  const valued = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--input-type', '-C', '--conditions', '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists', '--stack-trace-limit', '--title', '--max-old-space-size', '--inspect-port', '--watch-path']);
  const nodeOptCount = splitOptions(nodeOptions).length;
  let i = 0;
  for (; i < all.length; i++) {
    let a = all[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    let val: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) {
      val = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (valued.has(a) && !(a === '-p' || a === '--print') ) {
      val = all[++i];
    } else if ((a === '-p' || a === '--print') && all[i + 1] !== undefined && !all[i + 1].startsWith('-')) {
      val = all[++i];
    }
    if (i >= nodeOptCount || true) o.execArgv.push(val !== undefined ? `${a}=${val}` : a);
    switch (a) {
      case '-e':
      case '--eval':
        o.evalCode = val;
        break;
      case '-p':
      case '--print':
        o.print = true;
        o.evalCode = val ?? o.evalCode;
        break;
      case '-r':
      case '--require':
        o.requires.push(val!);
        break;
      case '--import':
        o.imports.push(val!);
        break;
      case '--input-type':
        o.inputType = val;
        break;
      case '-C':
      case '--conditions':
        o.conditions.push(val!);
        break;
      case '-v':
      case '--version':
        o.version = true;
        break;
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '--env-file':
      case '--env-file-if-exists':
        o.envFiles.push(val!);
        break;
      case '-c':
      case '--check':
        o.check = true;
        break;
      case '-i':
      case '--interactive':
        o.interactive = true;
        break;
      case '--stack-trace-limit':
        Error.stackTraceLimit = Number(val);
        break;
      case '--title':
        proc.title = val;
        break;
      case '--loader':
      case '--experimental-loader':
        writeErr(`(node:${proc.pid}) Warning: custom ESM loaders are not supported in OpenVessel; ignoring --loader ${val}\n`);
        break;
      default:
      // other flags are accepted and ignored (--no-warnings, --enable-source-maps, --max-old-space-size, ...)
    }
  }
  const rest = all.slice(i);
  if (o.evalCode === undefined && rest.length) {
    o.script = rest[0];
    o.args = rest.slice(1);
  } else o.args = rest;
  o.execArgv = o.execArgv.slice(0);
  return o;
}

async function runMain(o: CliOptions) {
  for (const f of o.envFiles) {
    try {
      proc.loadEnvFile(f);
    } catch {}
  }
  for (const r of o.requires) M._load(r, { filename: proc.cwd() + '/[preload]', paths: M._nodeModulePaths(proc.cwd()) } as any, false);
  for (const imp of o.imports) await dimport(imp, undefined, pathToFileURLString(proc.cwd() + '/'));
  if (o.version) {
    proc.stdout.write(`v${NODE_VERSION}\n`);
    return;
  }
  if (o.help) {
    proc.stdout.write('Usage: node [options] [ script.js ] [arguments]\n       node -e "script" [arguments]\n');
    return;
  }
  if (o.evalCode !== undefined) {
    proc.argv = ['/usr/bin/node', ...o.args];
    const isModule = o.inputType === 'module';
    if (isModule) {
      await evalModule(o.evalCode);
      return;
    }
    const mod = new M('[eval]', null);
    mod.filename = proc.cwd() + '/[eval]';
    mod.paths = M._nodeModulePaths(proc.cwd());
    const req = M.createRequire(proc.cwd() + '/[eval]');
    const g = globalThis as any;
    g.require = req;
    g.module = mod;
    g.exports = mod.exports;
    g.__filename = '[eval]';
    g.__dirname = '.';
    let result: unknown;
    try {
      result = (0, eval)(o.evalCode.replace(/(^|[^.\w$])import\s*\(/g, '$1__ov.dimport.__evalImport('));
    } catch (e) {
      if (e instanceof SyntaxError && /import|export|await/.test(String(e.message))) {
        await evalModule(o.evalCode);
        return;
      }
      throw e;
    }
    if (o.print) {
      const v = result instanceof Promise ? await result : result;
      proc.stdout.write((typeof v === 'string' ? v : utilMod.inspect(v, { colors: proc.stdout.isTTY })) + '\n');
    }
    return;
  }
  if (!o.script) {
    await repl();
    return;
  }
  const file = pathMod.resolve(proc.cwd(), o.script);
  proc.argv = ['/usr/bin/node', file, ...o.args];
  let st: any;
  try {
    st = sys('stat', { p: file });
  } catch {}
  if (!st) {
    // node also tries the path as a module id (e.g. `node somepackage`)
    const e = new Error(`Cannot find module '${file}'`) as Error & { code: string; requireStack: string[] };
    e.code = 'MODULE_NOT_FOUND';
    e.requireStack = [];
    throw e;
  }
  const real = sys<string>('realpath', { p: file });
  if (o.check) return;
  const fmt = sys<string | null>('moduleFormat', { p: real });
  const ext = pathMod.extname(real);
  let esm = fmt === 'module' || fmt === 'module-typescript' || ext === '.mjs' || ext === '.mts';
  if (fmt === null && ext !== '.cjs') {
    const src = new TextDecoder().decode(sys<Uint8Array>('readFile', { p: real }));
    esm = looksEsm(src);
  }
  if (esm) await dimport(pathToFileURLString(real), undefined, pathToFileURLString(proc.cwd() + '/'));
  else loadFile(real, null, true);
}

/** Runs ESM source from -e: written next to cwd so bare specifiers resolve like Node's [eval1]. */
async function evalModule(code: string) {
  const file = `${proc.cwd()}/.ov-eval-${proc.pid}-${Date.now()}.mjs`;
  sys('writeFile', { p: file, flags: 0o1101, mode: 0o644 }, enc.encode(code));
  try {
    await dimport(pathToFileURLString(file), undefined, pathToFileURLString(file));
  } finally {
    try {
      sys('unlink', { p: file });
    } catch {}
  }
}

function looksEsm(src: string): boolean {
  return /(^|\n)\s*(import\s*[\w{*'"]|export\s+(default|const|let|var|function|class|async|\{|\*))/.test(src) || /\bimport\.meta\b/.test(src);
}

async function repl() {
  const rl = readlineMod.createInterface({ input: proc.stdin, output: proc.stdout, prompt: '> ', terminal: !!proc.stdin.isTTY });
  proc.stdout.write(`Welcome to Node.js v${NODE_VERSION} (OpenVessel).\nType ".exit" to quit.\n`);
  const req = M.createRequire(proc.cwd() + '/[repl]');
  (globalThis as any).require = req;
  rl.prompt();
  await new Promise<void>((resolve) => {
    rl.on('line', async (line: string) => {
      if (line.trim() === '.exit') {
        rl.close();
        return;
      }
      if (line.trim()) {
        try {
          let v = (0, eval)(line);
          if (v instanceof Promise) v = await v;
          (globalThis as any)._ = v;
          proc.stdout.write(utilMod.inspect(v, { colors: true }) + '\n');
        } catch (e) {
          proc.stdout.write('Uncaught ' + utilMod.inspect(e) + '\n');
        }
      }
      rl.prompt();
    });
    rl.on('close', () => resolve());
  });
}

// -----------------------------------------------------------------------------
// boot

async function boot(init: InitMsg) {
  isThread = init.kind === 'thread';
  initSys(init.sab, (m, t) => scopePost(m, t ?? []));
  setRuntimeOrigin(runtimeOrigin);
  const execArgvInit = init.execArgv ?? [];
  proc = createProcess({ pid: init.pid, ppid: init.ppid, argv: init.argv, execArgv: execArgvInit, env: init.env, cwd: init.cwd, ttys: init.ttys, isThread });
  setCwd(() => proc.cwd());
  setCwdProvider(() => proc.cwd());
  setOsInfo({ hostname: init.hostname, home: init.env.HOME });
  setNetInfo(runtimeOrigin, init.pid, init.argv.slice(0, 3).join(' '));
  defineBuiltins();
  setBuiltinGetter(builtin);
  installGlobals();
  installErrorHandlers();
  installStackMapping();
  hideBrowserGlobals();
  (dimport as any).__evalImport = (s: string, o?: unknown) => dimport(s, o, pathToFileURLString(proc.cwd() + '/[eval]'));
  await Promise.all([lexerInit, preloadSucrase()]);
  proc.reallyExit = (code: number) => exit(code);
  proc.exit = (code?: number | string) => {
    if (code !== undefined && code !== null) proc.exitCode = Number(code) || 0;
    exit(proc.exitCode ?? 0);
  };
  loop.setIdleHandler(() => {
    if (exiting) return;
    if (proc.listenerCount('beforeExit') > 0 && !isThread) {
      proc.emit('beforeExit', proc.exitCode ?? 0);
      if (loop.activeRefs() > 0) return;
      // beforeExit may schedule more work in microtasks
      loop.macrotask(() => {
        if (loop.activeRefs() === 0) exit(proc.exitCode ?? 0);
        else loop.scheduleIdleCheck();
      });
      return;
    }
    exit(proc.exitCode ?? 0);
  });

  if (isThread) {
    threadPort = init.port ?? null;
    wt.initThread({ isMain: false, tid: init.tid, parentPort: init.port, workerData: init.workerData, envData: init.envData });
    proc.argv = ['/usr/bin/node', init.file ?? '[worker eval]', ...init.argv.slice(1)];
    threadPort?.postMessage({ k: 'online' });
    try {
      if (init.eval) {
        if (init.evalType === 'module') await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(init.file ?? '')}`);
        else {
          const req = M.createRequire(proc.cwd() + '/[worker eval]');
          new Function('require', '__filename', '__dirname', 'module', 'exports', init.file ?? '')(req, '[worker eval]', '.', { exports: {} }, {});
        }
      } else {
        const file = init.file!.startsWith('file:') ? fileURLToPathLoose(init.file!) : init.file!;
        const fmt = sys<string | null>('moduleFormat', { p: file });
        if (fmt === 'module' || file.endsWith('.mjs') || (fmt === null && !file.endsWith('.cjs') && looksEsm(new TextDecoder().decode(sys<Uint8Array>('readFile', { p: file }))))) {
          await dimport(pathToFileURLString(file), undefined, pathToFileURLString(file));
        } else loadFile(file, null, true);
      }
    } catch (e) {
      uncaught(e, 'uncaughtException');
      return;
    }
    loop.scheduleIdleCheck();
    return;
  }

  wt.initThread({ isMain: true, tid: 0 });
  const opts = parseCli(init.argv.slice(1), init.env.NODE_OPTIONS ?? '');
  proc.execArgv = opts.execArgv;
  const conds = [...opts.conditions];
  setConditions(conds);
  try {
    await runMain(opts);
  } catch (e) {
    uncaught(e, 'uncaughtException');
    return;
  }
  loop.scheduleIdleCheck();
}

void post;
void scope;
