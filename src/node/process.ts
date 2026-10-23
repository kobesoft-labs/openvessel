// The `process` object.

import { Buffer } from 'buffer';
import { EventEmitter } from './events.ts';
import { startReading } from './fs.ts';
import { Handle, nextTick, ref, unref } from './loop.ts';
import { Readable, Writable } from './stream.ts';
import { SysError, sys } from './sys.ts';
import { perfNow, timeOrigin } from './native.ts';

export { NODE_VERSION } from './version.ts';
import { NODE_VERSION } from './version.ts';

export interface ProcessInit {
  pid: number;
  ppid: number;
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  cwd: string;
  ttys: Record<number, { cols: number; rows: number } | null>;
  isThread: boolean;
}

const textEncoder = new TextEncoder();

/** A writable for fd 1/2 (sync writes, like Node for TTYs and files). */
export class StdWriteStream extends Writable {
  fd: number;
  isTTY: boolean;
  columns?: number;
  rows?: number;
  _type: string;
  _isStdio = true;
  constructor(fd: number, tty: { cols: number; rows: number } | null) {
    super({ decodeStrings: false, emitClose: false, autoDestroy: false });
    this.fd = fd;
    this.isTTY = !!tty;
    this._type = tty ? 'tty' : 'pipe';
    if (tty) {
      this.columns = tty.cols;
      this.rows = tty.rows;
    }
  }
  _write(chunk: any, encoding: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      const bytes = typeof chunk === 'string' ? (encoding && encoding !== 'utf8' && encoding !== ('buffer' as any) ? Buffer.from(chunk, encoding) : textEncoder.encode(chunk)) : chunk;
      sys('write', { fd: this.fd, pos: null }, bytes);
      cb();
    } catch (e) {
      if (e instanceof SysError && e.code === 'EPIPE') {
        cb();
        return;
      }
      cb(e as Error);
    }
  }
  _writev(chunks: { chunk: any; encoding: BufferEncoding }[], cb: (e?: Error | null) => void) {
    const parts = chunks.map(({ chunk, encoding }) => (typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk));
    this._write(Buffer.concat(parts), 'buffer' as any, cb);
  }
  /** Writes synchronously (bypasses stream buffering), as stdout/stderr do in Node for TTYs/files. */
  write(chunk: any, encoding?: any, cb?: any): boolean {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (this.destroyed || this.writableEnded) return super.write(chunk, encoding, cb);
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      this._write(chunk, encoding ?? 'utf8', (e) => {
        if (e) this.destroy(e);
        if (cb) nextTick(cb, e ?? null);
      });
      return true;
    }
    return super.write(chunk, encoding, cb);
  }
  getColorDepth(env: Record<string, string | undefined> = (globalThis as any).process.env): number {
    if (env.FORCE_COLOR !== undefined) {
      const v = env.FORCE_COLOR;
      if (v === '' || v === '1' || v === 'true') return 4;
      if (v === '2') return 8;
      if (v === '3') return 24;
      return 1;
    }
    if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined || env.TERM === 'dumb') return 1;
    if (!this.isTTY) return 1;
    if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 24;
    return 8;
  }
  hasColors(count: any = 16, env?: any): boolean {
    if (typeof count === 'object') {
      env = count;
      count = 16;
    }
    return count <= 2 ** this.getColorDepth(env);
  }
  getWindowSize(): [number, number] {
    return [this.columns ?? 80, this.rows ?? 24];
  }
  cursorTo(x: number, y?: any, cb?: any) {
    if (typeof y === 'function') {
      cb = y;
      y = undefined;
    }
    return this.write(typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`, cb);
  }
  moveCursor(dx: number, dy: number, cb?: any) {
    let s = '';
    if (dx < 0) s += `\x1b[${-dx}D`;
    else if (dx > 0) s += `\x1b[${dx}C`;
    if (dy < 0) s += `\x1b[${-dy}A`;
    else if (dy > 0) s += `\x1b[${dy}B`;
    return this.write(s, cb);
  }
  clearLine(dir: number, cb?: any) {
    return this.write(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K', cb);
  }
  clearScreenDown(cb?: any) {
    return this.write('\x1b[0J', cb);
  }
  _refreshSize(cols: number, rows: number) {
    if (cols === this.columns && rows === this.rows) return;
    this.columns = cols;
    this.rows = rows;
    this.emit('resize');
  }
  destroy(err?: Error) {
    // stdio streams are never really closed
    if (err) this.emit('error', err);
    return this;
  }
  end(...args: any[]) {
    const cb = args.find((a) => typeof a === 'function');
    const data = args.find((a) => typeof a === 'string' || a instanceof Uint8Array);
    if (data) this.write(data);
    if (cb) nextTick(cb);
    return this;
  }
}

/** stdin (fd 0): reads are pushed by the kernel while flowing. */
export class StdReadStream extends Readable {
  fd = 0;
  isTTY: boolean;
  isRaw = false;
  private stop?: () => void;
  private handle = new Handle();
  constructor(tty: boolean) {
    super({ highWaterMark: 64 * 1024, autoDestroy: false });
    this.isTTY = tty;
  }
  _read() {
    if (this.stop) return;
    this.handle.activate();
    this.stop = startReading(0, (d) => {
      if (d === null) {
        this.stop = undefined;
        this.handle.deactivate();
        this.push(null);
        return;
      }
      if (!this.push(Buffer.from(d))) {
        this.stop?.();
        this.stop = undefined;
        this.handle.deactivate();
      }
    });
  }
  pause() {
    super.pause();
    this.stop?.();
    this.stop = undefined;
    this.handle.deactivate();
    return this;
  }
  setRawMode(mode: boolean) {
    this.isRaw = !!mode;
    try {
      sys('setRawMode', { fd: 0, raw: !!mode });
    } catch {}
    return this;
  }
  ref() {
    this.handle.ref();
    return this;
  }
  unref() {
    this.handle.unref();
    return this;
  }
  destroy(err?: Error) {
    this.stop?.();
    this.stop = undefined;
    this.handle.deactivate();
    return super.destroy(err);
  }
}

export function createProcess(init: ProcessInit) {
  const proc: any = new EventEmitter();
  let cwd = init.cwd;
  const envTarget: Record<string, string> = { ...init.env };
  proc.env = new Proxy(envTarget, {
    set(t, k, v) {
      if (typeof k === 'string') t[k] = String(v);
      return true;
    },
    defineProperty(t, k, d) {
      if (typeof k === 'string') t[k] = String(d.value);
      return true;
    },
    deleteProperty(t, k) {
      if (typeof k === 'string') delete t[k];
      return true;
    },
  });
  proc.title = 'node';
  proc.argv = init.argv;
  proc.argv0 = 'node';
  proc.execArgv = init.execArgv;
  proc.execPath = '/usr/bin/node';
  proc.pid = init.pid;
  proc.ppid = init.ppid;
  proc.platform = 'linux';
  proc.arch = 'x64';
  proc.version = 'v' + NODE_VERSION;
  proc.versions = {
    node: NODE_VERSION,
    acorn: '8.14.0',
    ada: '2.9.2',
    ares: '1.34.5',
    brotli: '1.1.0',
    cjs_module_lexer: '2.1.0',
    icu: '76.1',
    llhttp: '9.2.1',
    modules: '127',
    napi: '10',
    nghttp2: '1.64.0',
    openssl: '3.0.15+quic',
    simdjson: '3.10.1',
    simdutf: '6.0.3',
    tz: '2025a',
    undici: '6.21.1',
    unicode: '16.0',
    uv: '1.49.2',
    uvwasi: '0.0.21',
    v8: '12.4.254.21-node.33',
    zlib: '1.3.0.1-motley',
    openvessel: '0.1.0',
  };
  proc.release = { name: 'node', lts: 'Jod', sourceUrl: '', headersUrl: '' };
  proc.config = { variables: { napi_build_version: '10', node_shared: false } };
  proc.features = { inspector: false, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: true, tls: true, cached_builtins: true, typescript: 'strip', require_module: true };
  proc.allowedNodeEnvironmentFlags = new Set<string>();
  proc.exitCode = undefined;
  proc.connected = false;
  proc.channel = undefined;
  proc.noDeprecation = false;
  proc.throwDeprecation = false;
  proc.traceDeprecation = false;
  proc.sourceMapsEnabled = false;
  proc.cwd = () => cwd;
  proc.chdir = (dir: string) => {
    const target = dir.startsWith('/') ? dir : `${cwd}/${dir}`;
    try {
      cwd = sys<string>('chdir', { p: target });
    } catch (e) {
      const err = new Error(`ENOENT: no such file or directory, chdir ${cwd} -> '${dir}'`) as NodeJS.ErrnoException;
      err.code = (e as SysError).code ?? 'ENOENT';
      err.syscall = 'chdir';
      err.path = dir;
      throw err;
    }
  };
  let umask = 0o022;
  proc.umask = (m?: number | string) => {
    const old = umask;
    if (m !== undefined) umask = typeof m === 'string' ? parseInt(m, 8) : m;
    return old;
  };
  proc.getuid = () => 1000;
  proc.geteuid = () => 1000;
  proc.getgid = () => 1000;
  proc.getegid = () => 1000;
  proc.getgroups = () => [1000];
  proc.setuid = proc.setgid = proc.seteuid = proc.setegid = proc.setgroups = () => {};
  proc.nextTick = nextTick;
  const t0 = perfNow();
  proc.hrtime = (prev?: [number, number]) => {
    const now = perfNow();
    const sec = Math.floor((timeOrigin + now) / 1000);
    const ns = Math.floor(((timeOrigin + now) % 1000) * 1e6);
    if (prev) {
      let ds = sec - prev[0];
      let dn = ns - prev[1];
      if (dn < 0) {
        ds--;
        dn += 1e9;
      }
      return [ds, dn];
    }
    return [sec, ns];
  };
  proc.hrtime.bigint = () => BigInt(Math.floor((timeOrigin + perfNow()) * 1e6));
  proc.uptime = () => (perfNow() - t0) / 1000;
  proc.memoryUsage = () => {
    const m = (performance as any).memory;
    const used = m?.usedJSHeapSize ?? 50e6;
    return { rss: used * 1.5, heapTotal: m?.totalJSHeapSize ?? used, heapUsed: used, external: 0, arrayBuffers: 0 };
  };
  proc.memoryUsage.rss = () => proc.memoryUsage().rss;
  proc.cpuUsage = (prev?: { user: number; system: number }) => {
    const user = Math.floor((perfNow() - t0) * 1000);
    return prev ? { user: user - prev.user, system: 0 } : { user, system: 0 };
  };
  proc.resourceUsage = () => ({ userCPUTime: Math.floor((perfNow() - t0) * 1000), systemCPUTime: 0, maxRSS: 100000, fsRead: 0, fsWrite: 0 });
  proc.constrainedMemory = () => 0;
  proc.availableMemory = () => 4 * 1024 ** 3;
  proc.kill = (pid: number, sig: string | number = 'SIGTERM') => {
    if (sig === 0) {
      try {
        sys('kill', { pid, sig: 0 });
      } catch (e) {
        const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        err.syscall = 'kill';
        throw err;
      }
      return true;
    }
    sys('kill', { pid, sig });
    return true;
  };
  proc.abort = () => proc.reallyExit(134);
  proc.binding = (name: string) => {
    if (name === 'natives') return {};
    if (name === 'constants') return { os: {}, fs: {} };
    throw new Error(`No such module: ${name}`);
  };
  proc._linkedBinding = proc.binding;
  proc.dlopen = () => {
    throw new Error('process.dlopen is not supported in OpenVessel (native addons cannot run in the browser)');
  };
  proc.emitWarning = (warning: string | Error, type?: any, code?: string) => {
    let name = 'Warning';
    let msg = warning;
    if (typeof type === 'object' && type) {
      code = type.code;
      name = type.type ?? name;
    } else if (typeof type === 'string') name = type;
    const w: any = typeof msg === 'string' ? Object.assign(new Error(msg), { name }) : msg;
    if (code) w.code = code;
    if (name === 'DeprecationWarning' && proc.noDeprecation) return;
    nextTick(() => {
      proc.emit('warning', w);
      if (proc.listenerCount('warning') <= 1 && !proc.execArgv.includes('--no-warnings') && !String(proc.env.NODE_NO_WARNINGS) .startsWith('1')) {
        try {
          sys('write', { fd: 2, pos: null }, textEncoder.encode(`(node:${proc.pid}) ${code ? `[${code}] ` : ''}${w.name}: ${w.message}\n`));
        } catch {}
      }
    });
  };
  proc.on('warning', () => {});
  let captureCb: ((e: unknown) => void) | null = null;
  proc.setUncaughtExceptionCaptureCallback = (fn: ((e: unknown) => void) | null) => {
    captureCb = fn;
  };
  proc.hasUncaughtExceptionCaptureCallback = () => captureCb !== null;
  proc._captureCb = () => captureCb;
  proc.setSourceMapsEnabled = (v: boolean) => {
    proc.sourceMapsEnabled = v;
  };
  proc.loadEnvFile = (p = '.env') => {
    const text = (globalThis as any).__ov.builtin('fs').readFileSync(p, 'utf8') as string;
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
      if (!m) continue;
      let v = (m[2] ?? '').trim();
      if (/^(['"`]).*\1$/.test(v)) v = v.slice(1, -1);
      if (proc.env[m[1]] === undefined) proc.env[m[1]] = v;
    }
  };
  proc.getBuiltinModule = (id: string) => {
    try {
      return (globalThis as any).__ov.builtin(id.replace(/^node:/, ''));
    } catch {
      return undefined;
    }
  };
  proc.report = { getReport: () => ({ header: { glibcVersionRuntime: '2.36' }, sharedObjects: [] }), directory: '', filename: '', compact: false, reportOnFatalError: false, reportOnSignal: false, reportOnUncaughtException: false, signal: 'SIGUSR2', writeReport: () => '' };
  proc.stdout = new StdWriteStream(1, init.ttys[1] ?? null);
  proc.stderr = new StdWriteStream(2, init.ttys[2] ?? null);
  let stdin: StdReadStream | null = null;
  Object.defineProperty(proc, 'stdin', {
    configurable: true,
    enumerable: true,
    get() {
      stdin ??= new StdReadStream(!!init.ttys[0]);
      return stdin;
    },
  });
  proc.openStdin = () => {
    proc.stdin.resume();
    return proc.stdin;
  };
  // signal handlers are registered with the kernel so it can deliver them
  const SIGS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH', 'SIGBREAK', 'SIGPIPE', 'SIGCONT', 'SIGTSTP']);
  proc.on('newListener', (ev: string) => {
    if (SIGS.has(ev) && proc.listenerCount(ev) === 0) {
      try {
        sys('sigaction', { sig: ev, on: true });
      } catch {}
    }
  });
  proc.on('removeListener', (ev: string) => {
    if (SIGS.has(ev) && proc.listenerCount(ev) === 0) {
      try {
        sys('sigaction', { sig: ev, on: false });
      } catch {}
    }
  });
  proc.ref = (h: any) => h?.ref?.();
  proc.unref = (h: any) => h?.unref?.();
  proc._getActiveHandles = () => [];
  proc._getActiveRequests = () => [];
  proc.getActiveResourcesInfo = () => [];
  void ref;
  void unref;
  return proc;
}
