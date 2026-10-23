// node:child_process

import { Buffer } from 'buffer';
import { EventEmitter } from './events.ts';
import { startReading } from './fs.ts';
import { Handle, macrotask, nextTick } from './loop.ts';
import { Readable, Writable } from './stream.ts';
import { SysError, sys } from './sys.ts';

type StdioSpec = 'pipe' | 'inherit' | 'ignore' | 'overlapped' | 'ipc' | number | null | undefined | { fd?: number };

const children = new Map<number, ChildProcess>();

/** Called by the worker when the kernel reports a child's exit. */
export function onChildExit(msg: { pid: number; code: number | null; signal: string | null }) {
  const c = children.get(msg.pid);
  if (!c) return;
  c._onExit(msg.code, msg.signal);
}

function normStdio(stdio: any): StdioSpec[] {
  if (stdio === undefined || stdio === null) return ['pipe', 'pipe', 'pipe'];
  if (typeof stdio === 'string') return [stdio, stdio, stdio] as StdioSpec[];
  const arr = [...stdio];
  while (arr.length < 3) arr.push('pipe');
  return arr.map((s: any) => {
    if (s && typeof s === 'object' && typeof s.fd === 'number') return s.fd;
    if (s && typeof s === 'object' && s._isStdio) return s.fd;
    if (s === undefined || s === null) return 'pipe';
    return s;
  });
}

function toEnv(env: any): Record<string, string> {
  const out: Record<string, string> = {};
  const src = env ?? (globalThis as any).process.env;
  for (const k of Object.keys(src)) if (src[k] !== undefined) out[k] = String(src[k]);
  return out;
}

function shellArgv(command: string, args: string[], shell: boolean | string | undefined): string[] {
  if (!shell) return [command, ...args];
  const sh = typeof shell === 'string' ? shell : '/bin/sh';
  const line = [command, ...args].join(' ');
  return [sh, '-c', line];
}

class PipeWritable extends Writable {
  constructor(public fd: number) {
    super({ decodeStrings: true, autoDestroy: true, emitClose: true });
  }
  _write(chunk: any, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      sys('write', { fd: this.fd, pos: null }, typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk);
      cb();
    } catch (e) {
      const err = e instanceof SysError ? Object.assign(new Error(`write ${e.code}`), { code: e.code, errno: e.code === 'EPIPE' ? -32 : -5, syscall: 'write' }) : (e as Error);
      cb(err);
    }
  }
  _final(cb: (e?: Error | null) => void) {
    this._closeFd();
    cb();
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this._closeFd();
    cb(err);
  }
  private _closeFd() {
    if (this.fd < 0) return;
    try {
      sys('close', { fd: this.fd });
    } catch {}
    this.fd = -1;
  }
}

class PipeReadable extends Readable {
  private stop?: () => void;
  constructor(public fd: number) {
    super({ highWaterMark: 64 * 1024 });
  }
  _read() {
    if (this.stop || this.fd < 0) return;
    this.stop = startReading(this.fd, (d) => {
      if (d === null) {
        this.stop = undefined;
        this._closeFd();
        this.push(null);
        return;
      }
      if (!this.push(Buffer.from(d))) {
        this.stop?.();
        this.stop = undefined;
      }
    });
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.stop?.();
    this.stop = undefined;
    this._closeFd();
    cb(err);
  }
  private _closeFd() {
    if (this.fd < 0) return;
    try {
      sys('close', { fd: this.fd });
    } catch {}
    this.fd = -1;
  }
}

export class ChildProcess extends EventEmitter {
  pid?: number;
  stdin: any = null;
  stdout: any = null;
  stderr: any = null;
  stdio: any[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected = false;
  spawnfile = '';
  spawnargs: string[] = [];
  private handle = new Handle();
  private exited = false;
  private openStreams = 0;
  private closed = false;

  constructor() {
    super();
  }

  _spawn(argv: string[], opts: any) {
    this.spawnfile = argv[0];
    this.spawnargs = argv;
    const stdio = normStdio(opts.stdio);
    const specs = stdio.map((s) => (s === 'overlapped' ? 'pipe' : s === 'ipc' ? 'ignore' : s));
    let res: { pid: number; fds: (number | null)[] };
    try {
      res = sys('spawn', { argv, env: toEnv(opts.env), cwd: opts.cwd ? String(opts.cwd) : undefined, stdio: specs, argv0: opts.argv0 });
    } catch (e) {
      const code = e instanceof SysError ? e.code : 'ENOENT';
      const err = Object.assign(new Error(`spawn ${argv[0]} ${code}`), { errno: code === 'ENOENT' ? -2 : -13, code, syscall: `spawn ${argv[0]}`, path: argv[0], spawnargs: argv.slice(1) });
      this.handle.activate();
      nextTick(() => {
        this.handle.deactivate();
        this.emit('error', err);
        this.emit('close', -2, null);
      });
      return;
    }
    this.pid = res.pid;
    children.set(res.pid, this);
    this.handle.activate();
    res.fds.forEach((fd, i) => {
      if (fd === null || fd === undefined) {
        this.stdio[i] = null;
        return;
      }
      if (i === 0) {
        const w = new PipeWritable(fd);
        this.stdio[i] = w;
      } else {
        const r = new PipeReadable(fd);
        this.openStreams++;
        r.on('close', () => this._streamClosed());
        r.on('end', () => {});
        this.stdio[i] = r;
      }
    });
    this.stdin = this.stdio[0] ?? null;
    this.stdout = this.stdio[1] ?? null;
    this.stderr = this.stdio[2] ?? null;
    nextTick(() => this.emit('spawn'));
    if (opts.signal) {
      const onAbort = () => {
        this.kill(opts.killSignal ?? 'SIGTERM');
        this.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: opts.signal.reason }));
      };
      if (opts.signal.aborted) nextTick(onAbort);
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (opts.timeout > 0) {
      const t = setTimeout(() => this.kill(opts.killSignal ?? 'SIGTERM'), opts.timeout);
      this.once('exit', () => clearTimeout(t));
    }
  }

  private _streamClosed() {
    this.openStreams--;
    this._maybeClose();
  }

  private _maybeClose() {
    if (this.closed || !this.exited || this.openStreams > 0) return;
    this.closed = true;
    this.handle.deactivate();
    if (this.pid) children.delete(this.pid);
    this.emit('close', this.exitCode, this.signalCode);
  }

  _onExit(code: number | null, signal: string | null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    if (this.stdin && !this.stdin.destroyed) this.stdin.destroy();
    this.emit('exit', code, signal);
    // like Node's flushStdio: drain stdio nobody is reading so the pipes can close
    for (const s of this.stdio.slice(1)) {
      if (s && s.readable && !s.readableFlowing && !s._readableState?.readListening) s.resume();
    }
    // let pending stdio data drain before 'close'
    macrotask(() => this._maybeClose());
  }

  kill(sig: string | number = 'SIGTERM') {
    if (!this.pid || this.exited) return false;
    try {
      sys('kill', { pid: this.pid, sig });
      this.killed = true;
      return true;
    } catch {
      return false;
    }
  }

  ref() {
    this.handle.ref();
    this.stdout?.ref?.();
  }
  unref() {
    this.handle.unref();
  }
  send(_msg: unknown, ..._args: unknown[]) {
    const cb = _args.find((a) => typeof a === 'function') as ((e: Error) => void) | undefined;
    const err = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
    if (cb) nextTick(cb, err);
    return false;
  }
  disconnect() {}
  [Symbol.dispose ?? Symbol.for('dispose')]() {
    this.kill();
  }
}

function parseArgs(file: string, args?: any, opts?: any): [string, string[], any] {
  if (!Array.isArray(args)) {
    opts = args;
    args = [];
  }
  return [file, (args as string[]).map(String), { ...(opts ?? {}) }];
}

export function spawn(command: string, args?: any, opts?: any): ChildProcess {
  const [cmd, argv, o] = parseArgs(command, args, opts);
  const cp = new ChildProcess();
  cp._spawn(shellArgv(cmd, argv, o.shell), o);
  return cp;
}

export function fork(modulePath: string | URL, args?: any, opts?: any): ChildProcess {
  const [mp, argv, o] = parseArgs(String(modulePath instanceof URL ? modulePath.pathname : modulePath), args, opts);
  const execArgv = o.execArgv ?? (globalThis as any).process.execArgv;
  const stdio = o.silent ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'];
  const cp = new ChildProcess();
  cp._spawn([o.execPath ?? 'node', ...execArgv, mp, ...argv], { ...o, stdio: o.stdio ? o.stdio.filter((s: any) => s !== 'ipc') : stdio });
  return cp;
}

function collect(cp: ChildProcess, opts: any, cb: ((err: any, stdout: any, stderr: any) => void) | undefined, cmdLabel: string) {
  const enc = opts.encoding === 'buffer' || opts.encoding === null ? null : (opts.encoding ?? 'utf8');
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024 * 1024;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outLen = 0;
  let errLen = 0;
  let killedForBuffer = false;
  cp.stdout?.on('data', (d: Buffer) => {
    outLen += d.length;
    if (outLen > maxBuffer) {
      killedForBuffer = true;
      cp.kill();
    } else out.push(d);
  });
  cp.stderr?.on('data', (d: Buffer) => {
    errLen += d.length;
    if (errLen <= maxBuffer) err.push(d);
  });
  const finish = (code: number | null, signal: string | null, spawnErr?: Error) => {
    const so = Buffer.concat(out);
    const se = Buffer.concat(err);
    const stdout = enc ? so.toString(enc) : so;
    const stderr = enc ? se.toString(enc) : se;
    if (!cb) return;
    if (spawnErr) return cb(Object.assign(spawnErr, { stdout, stderr }), stdout, stderr);
    if (code !== 0 || signal || killedForBuffer) {
      const e: any = new Error(`Command failed: ${cmdLabel}\n${se.toString()}`);
      e.code = killedForBuffer ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code;
      e.killed = cp.killed;
      e.signal = signal;
      e.cmd = cmdLabel;
      e.stdout = stdout;
      e.stderr = stderr;
      return cb(e, stdout, stderr);
    }
    cb(null, stdout, stderr);
  };
  let spawnError: Error | undefined;
  cp.on('error', (e) => {
    spawnError = e;
  });
  cp.on('close', (code: number | null, signal: string | null) => finish(code, signal, spawnError));
}

export function exec(command: string, opts?: any, cb?: any): ChildProcess {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  opts = { ...(opts ?? {}) };
  const cp = new ChildProcess();
  cp._spawn([typeof opts.shell === 'string' ? opts.shell : '/bin/sh', '-c', command], opts);
  collect(cp, opts, cb, command);
  return cp;
}

export function execFile(file: string, args?: any, opts?: any, cb?: any): ChildProcess {
  if (typeof args === 'function') {
    cb = args;
    args = [];
    opts = {};
  } else if (typeof opts === 'function') {
    cb = opts;
    if (!Array.isArray(args)) {
      opts = args;
      args = [];
    } else opts = {};
  }
  const [f, argv, o] = parseArgs(file, args, opts);
  const cp = new ChildProcess();
  cp._spawn(shellArgv(f, argv, o.shell), o);
  collect(cp, o, cb, [f, ...argv].join(' '));
  return cp;
}

const kCustomExec = Symbol.for('nodejs.util.promisify.custom');
(exec as any)[kCustomExec] = (command: string, opts?: any) => {
  let child!: ChildProcess;
  const p: any = new Promise((resolve, reject) => {
    child = exec(command, opts, (err: any, stdout: any, stderr: any) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
  p.child = child;
  return p;
};
(execFile as any)[kCustomExec] = (file: string, args?: any, opts?: any) => {
  let child!: ChildProcess;
  const p: any = new Promise((resolve, reject) => {
    child = execFile(file, args, opts, (err: any, stdout: any, stderr: any) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
  p.child = child;
  return p;
};

export function spawnSync(command: string, args?: any, opts?: any) {
  const [cmd, argv, o] = parseArgs(command, args, opts);
  const full = shellArgv(cmd, argv, o.shell);
  const stdio = normStdio(o.stdio).map((s) => (s === 'overlapped' ? 'pipe' : s === 'ipc' ? 'ignore' : s));
  let input: Uint8Array | undefined;
  if (o.input !== undefined) input = typeof o.input === 'string' ? Buffer.from(o.input, o.encoding && o.encoding !== 'buffer' ? o.encoding : 'utf8') : o.input;
  try {
    const r = sys<{ pid: number; status: number | null; signal: string | null; outLen: number; bin: Uint8Array; error?: string }>(
      'spawnSync',
      { argv: full, env: toEnv(o.env), cwd: o.cwd ? String(o.cwd) : undefined, stdio, timeout: o.timeout ?? 0, killSignal: o.killSignal },
      input,
    );
    const outBuf = Buffer.from(r.bin.subarray(0, r.outLen));
    const errBuf = Buffer.from(r.bin.subarray(r.outLen));
    const enc = o.encoding && o.encoding !== 'buffer' ? o.encoding : null;
    const stdout = stdio[1] === 'pipe' ? (enc ? outBuf.toString(enc) : outBuf) : null;
    const stderr = stdio[2] === 'pipe' ? (enc ? errBuf.toString(enc) : errBuf) : null;
    const result: any = { pid: r.pid, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: r.signal };
    if (r.error) result.error = Object.assign(new Error(`spawnSync ${cmd} ${r.error}`), { code: r.error, errno: -110, syscall: `spawnSync ${cmd}`, path: cmd, spawnargs: argv });
    return result;
  } catch (e) {
    const code = e instanceof SysError ? e.code : 'ENOENT';
    const err = Object.assign(new Error(`spawnSync ${cmd} ${code}`), { code, errno: code === 'ENOENT' ? -2 : -13, syscall: `spawnSync ${cmd}`, path: cmd, spawnargs: argv });
    return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error: err };
  }
}

function checkSync(r: any, label: string, opts: any) {
  if (r.error) throw r.error;
  if (r.status !== 0 || r.signal) {
    const stderr = r.stderr ? r.stderr.toString() : '';
    const e: any = new Error(`Command failed: ${label}${stderr ? '\n' + stderr : ''}`);
    e.status = r.status;
    e.signal = r.signal;
    e.output = r.output;
    e.stdout = r.stdout;
    e.stderr = r.stderr;
    e.pid = r.pid;
    throw e;
  }
  void opts;
  return r.stdout;
}

export function execSync(command: string, opts: any = {}) {
  const o = { ...opts, stdio: opts.stdio ?? ['pipe', 'pipe', 'inherit'] };
  const r = spawnSync(typeof o.shell === 'string' ? o.shell : '/bin/sh', ['-c', command], { ...o, shell: false });
  return checkSync(r, command, o);
}

export function execFileSync(file: string, args?: any, opts?: any) {
  const [f, argv, o] = parseArgs(file, args, opts);
  o.stdio = o.stdio ?? ['pipe', 'pipe', 'inherit'];
  const r = spawnSync(f, argv, o);
  return checkSync(r, [f, ...argv].join(' '), o);
}

export default { ChildProcess, spawn, fork, exec, execFile, spawnSync, execSync, execFileSync };
