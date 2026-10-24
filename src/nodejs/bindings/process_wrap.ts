// process_wrap (child processes), spawn_sync and signal_wrap over the kernel's spawn/kill/sigaction.

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { asBuffer } from './buffer.ts';
import { fromShape } from './shape.ts';
import { HandleWrap, type Pipe } from './stream.ts';

function errno(code: string): number {
  return S.internalBinding('uv')[`UV_${code}`] ?? -1;
}

function signalNumber(name: string | null): number {
  if (!name) return 0;
  return S.internalBinding('constants').os.signals[name] ?? 0;
}

function envObject(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs) return undefined;
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) env[p.slice(0, i)] = p.slice(i + 1);
  }
  return env;
}

interface StdioOption {
  type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
  handle?: Pipe & { fd?: number };
  fd?: number;
  ipc?: boolean;
  input?: ArrayBufferView;
}

function kernelSpecs(stdio: StdioOption[]): (string | number)[] {
  return stdio.map((s, i) => {
    switch (s.type) {
      case 'pipe':
      case 'overlapped':
        return s.ipc ? 'ipc' : 'pipe';
      case 'inherit':
        return 'inherit';
      case 'fd':
        return s.fd ?? i;
      case 'wrap':
        return s.handle?.fd ?? 'ignore';
      default:
        return 'ignore';
    }
  });
}

// pid → running child, for the kernel's 'child-exit' messages
const children = new Map<number, ProcessWrap>();
let exitHandlerInstalled = false;
function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  S.kernelHandlers.set('child-exit', (msg: { pid: number; code: number | null; signal: string | null }) => {
    const c = children.get(msg.pid);
    if (!c) return;
    children.delete(msg.pid);
    c._exited(msg.code ?? 0, msg.signal);
  });
}

/** setuid(2)/setgid(2) in the child (libuv's UV_PROCESS_SETUID): an unprivileged user keeps its own ids. */
function credentialError(options: { uid?: number; gid?: number }): number {
  const c = S.internalBinding('credentials');
  if (typeof options.gid === 'number' && options.gid !== c.getgid() && options.gid !== c.getegid()) return errno('EPERM');
  if (typeof options.uid === 'number' && options.uid !== c.getuid() && options.uid !== c.geteuid()) return errno('EPERM');
  return 0;
}

class ProcessWrap extends HandleWrap {
  /** set once spawned (like the C++ wrap, which only defines it on success) */
  pid: number | undefined = undefined;
  onexit: ((exitCode: number, signalCode: string | null) => void) | null = null;

  constructor() {
    super('ProcessWrap');
  }

  spawn(options: { file: string; args?: string[]; cwd?: string; envPairs?: string[]; stdio?: StdioOption[]; detached?: boolean; uid?: number; gid?: number }) {
    installExitHandler();
    const credErr = credentialError(options);
    if (credErr) return credErr;
    const args = (options.args ?? [options.file]).map(String); // the C++ side reads each with ToString
    const stdio = options.stdio ?? [];
    let res: { pid: number; fds: (number | null)[]; error?: string };
    try {
      res = sys('spawn', {
        argv: [options.file, ...args.slice(1)],
        argv0: args[0],
        env: envObject(options.envPairs),
        cwd: options.cwd || undefined,
        stdio: kernelSpecs(stdio),
        keepStdioOnError: true,
      });
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('EIO');
    }
    stdio.forEach((s, i) => {
      const fd = res.fds[i];
      if ((s.type === 'pipe' || s.type === 'overlapped') && s.handle && typeof fd === 'number') s.handle._setFd(fd);
    });
    if (res.error) return errno(res.error);
    this.pid = res.pid;
    children.set(res.pid, this);
    this.setActive(true);
    return 0;
  }

  kill(sig: number) {
    if (!this.pid) return errno('ESRCH');
    try {
      sys('kill', { pid: this.pid, sig });
      return 0;
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('ESRCH');
    }
  }

  /** @internal */
  _exited(code: number, signal: string | null) {
    this.setActive(false);
    if (typeof this.onexit === 'function') loop.scope(this.onexit, this, code, signal);
  }
}

export function createProcessWrap() {
  return Object.assign(fromShape('process_wrap'), { Process: ProcessWrap });
}

export function createSpawnSync() {
  const b = fromShape('spawn_sync');
  return Object.assign(b, {
    spawn(options: { file: string; args?: string[]; cwd?: string; envPairs?: string[]; stdio?: StdioOption[]; timeout?: number; killSignal?: number | string; maxBuffer?: number; uid?: number; gid?: number }) {
      const credErr = credentialError(options);
      if (credErr) return { error: credErr, status: null, signal: null, output: null, pid: 0 };
      const args = (options.args ?? [options.file]).map(String); // the C++ side reads each with ToString
      const stdio = options.stdio ?? [];
      const input = stdio[0]?.input;
      try {
        const r = sys<{ pid: number; status: number | null; signal: string | null; outLen: number; error?: string; bin: Uint8Array }>(
          'spawnSync',
          {
            argv: [options.file, ...args.slice(1)],
            argv0: args[0],
            env: envObject(options.envPairs),
            cwd: options.cwd || undefined,
            stdio: kernelSpecs(stdio),
            timeout: options.timeout,
            killSignal: options.killSignal,
          },
          input ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : undefined,
        );
        let out = r.bin.slice(0, r.outLen);
        let err = r.bin.slice(r.outLen);
        const result: Record<string, unknown> = { pid: r.pid, status: r.status, signal: r.signal };
        const max = options.maxBuffer;
        if (typeof max === 'number' && Number.isFinite(max) && out.length + err.length > max) {
          // libuv reads 64 KiB at a time and keeps the read that crossed the limit
          const keep = (Math.floor(max / 65536) + 1) * 65536;
          out = out.slice(0, keep);
          err = err.slice(0, Math.max(0, keep - out.length));
          result.error = errno('ENOBUFS');
          result.status = null;
          result.signal = typeof options.killSignal === 'string' ? options.killSignal : 'SIGTERM';
        }
        if (r.error) result.error = errno(r.error);
        result.output = stdio.map((s, i) => (i === 1 && s.type === 'pipe' ? asBuffer(out) : i === 2 && s.type === 'pipe' ? asBuffer(err) : null));
        return result;
      } catch (e) {
        return { error: e instanceof SysError ? errno(e.code) : errno('EIO'), status: null, signal: null, output: null, pid: 0 };
      }
    },
  });
}

// -----------------------------------------------------------------------------
// signals

const signalHandlers = new Map<string, Set<SignalWrap>>();
let signalHandlerInstalled = false;

class SignalWrap extends HandleWrap {
  onsignal: ((signum: number) => void) | null = null;
  #name: string | null = null;
  constructor() {
    super('SignalWrap');
  }
  start(signum: number) {
    const names = S.internalBinding('constants').os.signals as Record<string, number>;
    const name = Object.keys(names).find((k) => names[k] === signum);
    if (!name) return errno('EINVAL');
    this.#name = name;
    if (!signalHandlerInstalled) {
      signalHandlerInstalled = true;
      S.kernelHandlers.set('signal', (msg: { sig: string }) => {
        for (const h of signalHandlers.get(msg.sig) ?? []) if (typeof h.onsignal === 'function') loop.scope(h.onsignal, h, signalNumber(msg.sig));
      });
    }
    let set = signalHandlers.get(name);
    if (!set) signalHandlers.set(name, (set = new Set()));
    set.add(this);
    try {
      sys('sigaction', { sig: name, on: true });
    } catch {}
    this.setActive(true);
    return 0;
  }
  stop() {
    if (!this.#name) return 0;
    const set = signalHandlers.get(this.#name);
    set?.delete(this);
    if (!set?.size) {
      try {
        sys('sigaction', { sig: this.#name, on: false });
      } catch {}
    }
    this.setActive(false);
    return 0;
  }
  protected override _onClose() {
    this.stop();
  }
}

export function createSignalWrap() {
  return Object.assign(fromShape('signal_wrap'), { Signal: SignalWrap });
}
