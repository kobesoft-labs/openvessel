// The kernel: owns the VFS, the process table, pipes, TTYs and virtual ports.

import { KernelError, kerr } from '../shared/errno.ts';
import * as path from '../shared/path.ts';
import { createChannelBuffer, SyncServer } from '../shared/syncchan.ts';
import { O_RDONLY, O_RDWR, O_WRONLY, OpenFile, Tty, createPipe } from './io.ts';
import { type ExitStatus, type NodeThread, Proc, exitCodeOf, signalName, signalNumber } from './proc.ts';
import { S_IFMT, S_IFREG, VFS, isDir } from './vfs.ts';

export type Program = (ctx: ProgramContext) => Promise<number>;

export interface SpawnOptions {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** fds for the child: index = fd number. Files are ref'd by spawn. */
  stdio?: (OpenFile | null)[];
  ppid?: number;
  pgid?: number; // 0 = new group with pgid = pid
  tty?: Tty;
  /** Resolve argv[0] through PATH (default true). */
  searchPath?: boolean;
}

export interface KernelHooks {
  /** Creates a process worker (node runtime). */
  createWorker(name: string): Worker;
  /** Called when a process starts listening on a virtual port. */
  onListen?(port: number, pid: number): void;
  onUnlisten?(port: number, pid: number): void;
  onProcessExit?(pid: number, status: ExitStatus): void;
  log?(msg: string): void;
}

export interface ListenRecord {
  port: number;
  pid: number;
  tid: number;
  host: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const BUILTIN_SHEBANG = '/ov/builtin';

export class Kernel {
  vfs = new VFS();
  procs = new Map<number, Proc>();
  programs = new Map<string, Program>();
  ports = new Map<number, ListenRecord>();
  /** Unix domain socket listeners, by the socket inode (the name can be renamed or unlinked) */
  unixSockets = new Map<number, ListenRecord & { path: string }>();
  private nextPid = 1;
  private nextTid = 1;
  private nextTtyId = 1;
  /** Handler for synchronous syscalls from node threads (set by syscalls.ts). */
  syscall!: (proc: Proc, thread: NodeThread, op: string, args: any, bin: Uint8Array | undefined) => unknown | Promise<unknown>;
  /** Handler for async messages from node threads. */
  asyncMessage!: (proc: Proc, thread: NodeThread, msg: any) => void;
  readonly hostname = 'openvessel';

  constructor(public hooks: KernelHooks) {
    this.setupFs();
  }

  // ---------------------------------------------------------------------------
  // file system layout

  private setupFs() {
    const v = this.vfs;
    for (const d of ['/bin', '/usr/bin', '/usr/local/bin', '/usr/lib/node_modules', '/usr/local/lib', '/home/user', '/tmp', '/etc', '/dev', '/proc', '/var/tmp', '/root', '/opt']) {
      v.mkdir(d, 0o755, true);
    }
    v.chmod('/tmp', 0o1777);
    v.writeFile('/etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home/user:/bin/sh\n');
    v.writeFile('/etc/group', 'root:x:0:\nuser:x:1000:\n');
    v.writeFile('/etc/hostname', `${this.hostname}\n`);
    v.writeFile('/etc/hosts', '127.0.0.1 localhost\n::1 localhost\n');
    v.writeFile('/etc/os-release', 'NAME="OpenVessel"\nID=openvessel\nPRETTY_NAME="OpenVessel"\n');
    v.writeFile('/etc/shells', '/bin/sh\n/bin/bash\n');
    const nullDev = { read: () => new Uint8Array(0), write: (d: Uint8Array) => d.length };
    const zeroDev = { read: (n: number) => new Uint8Array(Math.min(n, 65536)), write: (d: Uint8Array) => d.length };
    const randDev = {
      read: (n: number) => crypto.getRandomValues(new Uint8Array(Math.min(n, 65536))),
      write: (d: Uint8Array) => d.length,
    };
    v.mknodChar('/dev/null', nullDev, 0x103);
    v.mknodChar('/dev/zero', zeroDev, 0x105);
    v.mknodChar('/dev/random', randDev, 0x108);
    v.mknodChar('/dev/urandom', randDev, 0x109);
    v.mkdir('/dev/fd', 0o755);
    v.symlink('/proc/self/fd/0', '/dev/stdin');
    v.symlink('/proc/self/fd/1', '/dev/stdout');
    v.symlink('/proc/self/fd/2', '/dev/stderr');
    v.writeFile('/proc/cpuinfo', 'processor\t: 0\nmodel name\t: OpenVessel virtual CPU\n');
    v.writeFile('/proc/meminfo', 'MemTotal:        4194304 kB\nMemFree:         2097152 kB\n');
    v.writeFile('/proc/version', 'Linux version 6.1.0-openvessel\n');
  }

  /** Installs a builtin program as an executable file in /bin (or another dir). */
  registerProgram(name: string, fn: Program, dirs = ['/bin']) {
    this.programs.set(name, fn);
    for (const d of dirs) {
      const p = `${d}/${name}`;
      if (!this.vfs.exists(p)) this.vfs.writeFile(p, `#!${BUILTIN_SHEBANG} ${name}\n`, 0o755);
      this.vfs.chmod(p, 0o755);
    }
  }

  defaultEnv(): Record<string, string> {
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/user',
      USER: 'user',
      LOGNAME: 'user',
      SHELL: '/bin/sh',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      HOSTNAME: this.hostname,
      NAPI_RS_FORCE_WASI: '1',
    };
  }

  createTty(output: (d: Uint8Array) => void): Tty {
    const tty: Tty = new Tty(this.nextTtyId++, {
      output,
      signal: (sig) => {
        if (sig === 'SIGWINCH') {
          for (const p of this.procs.values()) if (p.tty === tty && p.state === 'running') this.kill(p.pid, 'SIGWINCH', true);
          return;
        }
        this.killGroup(tty.foregroundPgid, sig);
      },
    });
    return tty;
  }

  // ---------------------------------------------------------------------------
  // paths

  resolvePath(cwd: string, p: string): string {
    if (!p) throw kerr('ENOENT');
    return path.resolve(cwd, p);
  }

  /** Finds an executable for `cmd` (PATH lookup when no slash). */
  which(cmd: string, env: Record<string, string>, cwd: string): string | null {
    if (cmd.includes('/')) {
      const p = this.resolvePath(cwd, cmd);
      const n = this.vfs.tryLookup(p);
      return n && !isDir(n) ? p : null;
    }
    for (const dir of (env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const p = path.join(this.resolvePath(cwd, dir), cmd);
      const n = this.vfs.tryLookup(p);
      if (n && !isDir(n) && (n.mode & S_IFMT) === S_IFREG && n.mode & 0o111) return p;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // processes

  get(pid: number): Proc {
    const p = this.procs.get(pid);
    if (!p) throw kerr('ESRCH');
    return p;
  }

  /**
   * Spawns a process. Resolves the executable (builtin, shebang script, node)
   * synchronously and returns the running process. Throws ENOENT/EACCES.
   */
  spawn(opts: SpawnOptions): Proc {
    const parent = opts.ppid ? this.procs.get(opts.ppid) : undefined;
    const env = opts.env ?? (parent ? { ...parent.env } : this.defaultEnv());
    const cwd = opts.cwd ?? parent?.cwd ?? '/home/user';
    const argv = [...opts.argv];
    if (argv.length === 0) throw kerr('EINVAL');
    const plan = this.planExec(argv, env, cwd, opts.searchPath !== false);

    const pid = this.nextPid++;
    const pgid = opts.pgid === 0 ? pid : (opts.pgid ?? parent?.pgid ?? pid);
    const proc = new Proc({ pid, ppid: opts.ppid ?? 0, pgid, argv: plan.argv, env, cwd });
    proc.tty = opts.tty ?? parent?.tty;
    const stdio = opts.stdio ?? [];
    for (let i = 0; i < stdio.length; i++) {
      const f = stdio[i];
      if (f) proc.fds.set(i, f.ref());
    }
    this.procs.set(pid, proc);
    parent?.children.add(pid);
    proc.onExit.add((status) => {
      this.hooks.onProcessExit?.(pid, status);
      for (const [port, rec] of this.ports) {
        if (rec.pid === pid) {
          this.ports.delete(port);
          this.hooks.onUnlisten?.(port, pid);
        }
      }
      for (const [ino, rec] of this.unixSockets) if (rec.pid === pid) this.unixSockets.delete(ino);
      // reparent children to init (pid 0)
      for (const c of proc.children) {
        const cp = this.procs.get(c);
        if (cp) cp.ppid = 0;
      }
      // reap after a while if nobody waits (keep status for waitpid)
      const t = setTimeout(() => {
        if (!this.procs.get(pid)?.children.size) this.procs.delete(pid);
        this.procs.get(proc.ppid)?.children.delete(pid);
      }, 60_000) as any;
      t?.unref?.();
    });

    if (plan.kind === 'builtin') {
      proc.kind = 'builtin';
      proc.title = plan.name;
      this.runBuiltin(proc, this.programs.get(plan.name)!);
    } else {
      proc.kind = 'node';
      proc.title = 'node';
      this.startNode(proc);
    }
    return proc;
  }

  /** Determines how to run argv: builtin program or node, following shebangs. */
  planExec(argv: string[], env: Record<string, string>, cwd: string, searchPath = true): { kind: 'builtin'; name: string; argv: string[] } | { kind: 'node'; argv: string[] } {
    let depth = 0;
    for (;;) {
      if (depth++ > 8) throw kerr('ELOOP');
      const cmd = argv[0];
      const file = searchPath || cmd.includes('/') ? this.which(cmd, env, cwd) : null;
      if (!file) {
        // bare program names that exist as builtins even without a /bin entry
        if (!cmd.includes('/') && this.programs.has(cmd)) return { kind: 'builtin', name: cmd, argv };
        throw new KernelError('ENOENT', `${cmd}: command not found`);
      }
      const node = this.vfs.lookup(file);
      if (!(node.mode & 0o111)) throw new KernelError('EACCES', `${cmd}: Permission denied`);
      const head = dec.decode(node.data!.subarray(0, Math.min(node.size, 256)));
      if (head.startsWith('#!')) {
        const line = head.slice(2).split('\n')[0].trim();
        const parts = line.split(/\s+/);
        let interp = parts[0];
        let iargs = parts.slice(1);
        if (interp === BUILTIN_SHEBANG) {
          const name = iargs[0];
          if (name === 'node') return { kind: 'node', argv: ['node', ...argv.slice(1)] };
          if (!this.programs.has(name)) throw new KernelError('ENOENT', `${name}: builtin missing`);
          return { kind: 'builtin', name, argv };
        }
        if (interp === '/usr/bin/env' || interp === '/bin/env') {
          if (iargs[0] === '-S') iargs = iargs.slice(1).join(' ').split(/\s+/);
          while (iargs[0]?.includes('=')) iargs.shift();
          interp = iargs[0];
          iargs = iargs.slice(1);
        }
        const base = path.basename(interp ?? '');
        if (base === 'node' || base === 'nodejs' || base === 'bun' || base === 'deno') {
          return { kind: 'node', argv: ['node', ...iargs, file, ...argv.slice(1)] };
        }
        argv = [interp, ...iargs, file, ...argv.slice(1)];
        continue;
      }
      // JS files executed directly (e.g. bins without a shebang)
      if (/\.(c|m)?js$/.test(file)) return { kind: 'node', argv: ['node', file, ...argv.slice(1)] };
      // ENOEXEC: run as a shell script, like POSIX shells do
      return { kind: 'builtin', name: 'sh', argv: ['sh', file, ...argv.slice(1)] };
    }
  }

  private runBuiltin(proc: Proc, fn: Program) {
    const ctx = new ProgramContext(this, proc);
    queueMicrotask(async () => {
      let code = 0;
      try {
        code = await fn(ctx);
      } catch (e: any) {
        if (e instanceof ExitSignal) code = e.code;
        else {
          try {
            ctx.err(`${proc.title}: ${e?.message ?? e}\n`);
          } catch {}
          code = 1;
        }
      }
      if (proc.state === 'running') proc.finish({ code, signal: null });
    });
  }

  // ---------------------------------------------------------------------------
  // node processes

  startNode(proc: Proc, extra: Record<string, unknown> = {}) {
    this.startThread(proc, {
      kind: 'main',
      ...extra,
    });
  }

  /** Starts a node thread (main or worker_threads) for `proc`. */
  startThread(proc: Proc, init: Record<string, unknown>, transfer: Transferable[] = [], parentTid?: number, explicitTid?: number): NodeThread {
    const tid = explicitTid ?? this.nextTid++;
    const worker = this.hooks.createWorker(`node:${proc.pid}:${tid}`);
    const sab = createChannelBuffer();
    const thread: NodeThread = { tid, worker, server: new SyncServer(sab), busy: false, parentTid };
    proc.threads.set(tid, thread);
    worker.onmessage = (ev) => this.onThreadMessage(proc, thread, ev.data);
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      this.hooks.log?.(`worker error pid=${proc.pid}: ${ev.message}`);
      if (init.kind === 'main') this.exitProcess(proc, { code: 1, signal: null });
    };
    const ttyInfo: Record<number, { cols: number; rows: number } | null> = {};
    for (const fd of [0, 1, 2]) {
      const f = proc.fds.get(fd);
      ttyInfo[fd] = f?.kind === 'tty' && f.opts.tty ? { cols: f.opts.tty.cols, rows: f.opts.tty.rows } : null;
    }
    worker.postMessage(
      {
        t: 'init',
        pid: proc.pid,
        ppid: proc.ppid,
        tid,
        argv: proc.argv,
        env: proc.env,
        cwd: proc.cwd,
        sab,
        ttys: ttyInfo,
        hostname: this.hostname,
        ...init,
      },
      transfer,
    );
    return thread;
  }

  private onThreadMessage(proc: Proc, thread: NodeThread, msg: any) {
    if (msg?.t === 'sys') {
      const req = thread.server.receive();
      if (!req) return;
      const { op, ...args } = req.json as any;
      let result: unknown;
      try {
        result = this.syscall(proc, thread, op, args, req.bin);
      } catch (e) {
        thread.server.respond(errorResponse(e));
        return;
      }
      if (result instanceof Promise) {
        result.then(
          (r) => thread.server.respond(okResponse(r)),
          (e) => thread.server.respond(errorResponse(e)),
        );
      } else {
        thread.server.respond(okResponse(result));
      }
      return;
    }
    this.asyncMessage(proc, thread, msg);
  }

  exitProcess(proc: Proc, status: ExitStatus) {
    if (proc.state === 'exited') return;
    for (const t of proc.threads.values()) {
      try {
        t.worker.terminate();
      } catch {}
    }
    proc.threads.clear();
    proc.abort.abort();
    proc.finish(status);
  }

  /** Posts an async message to the main thread of a node process. */
  post(proc: Proc, msg: unknown, transfer: Transferable[] = []) {
    const main = proc.threads.values().next().value as NodeThread | undefined;
    main?.worker.postMessage(msg, transfer);
  }

  // ---------------------------------------------------------------------------
  // signals

  kill(pid: number, sig: string | number = 'SIGTERM', soft = false) {
    const proc = this.get(pid);
    const name = signalName(sig);
    if (proc.state !== 'running') return;
    if (signalNumber(name) === 0) return;
    if (proc.kind === 'node') {
      if (proc.handledSignals.has(name) && name !== 'SIGKILL') {
        this.post(proc, { t: 'signal', sig: name });
        return;
      }
      if (name === 'SIGWINCH' || name === 'SIGCHLD' || name === 'SIGCONT') {
        if (name === 'SIGWINCH') this.post(proc, { t: 'signal', sig: name });
        return;
      }
      this.exitProcess(proc, { code: null, signal: name });
      return;
    }
    // builtin program
    if (proc.onSignal?.(name)) return;
    if (name === 'SIGWINCH' || name === 'SIGCHLD' || name === 'SIGCONT') return;
    if (soft) return;
    proc.abort.abort(name);
    proc.finish({ code: null, signal: name });
  }

  killGroup(pgid: number, sig: string) {
    if (!pgid) return;
    for (const p of [...this.procs.values()]) if (p.pgid === pgid && p.state === 'running') this.kill(p.pid, sig);
  }

  // ---------------------------------------------------------------------------
  // file helpers used by programs and syscalls

  openFile(proc: { cwd: string; umask?: number }, p: string, flags: number, mode = 0o666): OpenFile {
    const abs = this.resolvePath(proc.cwd, p);
    if (abs.startsWith('/proc/self/fd/') || abs.startsWith('/dev/fd/')) {
      const fd = Number(abs.split('/').pop());
      const owner = proc as Proc;
      if (owner.fds?.has(fd)) return owner.fds.get(fd)!.ref();
      throw kerr('ENOENT');
    }
    if (abs === '/dev/tty') {
      const tty = (proc as Proc).tty;
      if (!tty) throw kerr('ENXIO');
      return new OpenFile('tty', O_RDWR, { tty });
    }
    const O_CREAT = 0o100;
    const O_EXCL = 0o200;
    const O_TRUNC = 0o1000;
    const O_DIRECTORY = 0o200000;
    const O_NOFOLLOW = 0o400000;
    let node = this.vfs.tryLookup(abs, !(flags & O_NOFOLLOW));
    if (node && flags & O_EXCL && flags & O_CREAT) throw kerr('EEXIST');
    if (!node) {
      if (!(flags & O_CREAT)) {
        this.vfs.lookup(abs); // throws the precise error (ENOENT/ENOTDIR)
      }
      node = this.vfs.createFile(abs, mode & ~(proc.umask ?? 0o022), { excl: !!(flags & O_EXCL) });
    } else {
      if (flags & O_DIRECTORY && !isDir(node)) throw kerr('ENOTDIR');
      if (isDir(node) && (flags & 3) !== O_RDONLY) throw kerr('EISDIR');
      if (flags & O_TRUNC && (flags & 3) !== O_RDONLY && !node.device) this.vfs.truncateNode(node, 0, abs);
    }
    if (node.device) return new OpenFile('file', flags, { vfs: this.vfs, node, path: abs });
    return new OpenFile(isDir(node) ? 'dir' : 'file', flags, { vfs: this.vfs, node, path: abs });
  }
}

export class ExitSignal {
  constructor(public code: number) {}
}

export function okResponse(r: unknown): { json: unknown; bin?: Uint8Array } {
  if (r instanceof Uint8Array) return { json: { ok: null, bin: true }, bin: r };
  if (r && typeof r === 'object' && (r as any).__bin instanceof Uint8Array) {
    const { __bin, ...rest } = r as any;
    return { json: { ok: rest, bin: true }, bin: __bin };
  }
  return { json: { ok: r === undefined ? null : r } };
}

export function errorResponse(e: unknown): { json: unknown } {
  if (e instanceof KernelError) return { json: { err: e.code, msg: e.message } };
  const err = e as any;
  return { json: { err: err?.code ?? 'EIO', msg: String(err?.message ?? err) } };
}

/** API for builtin programs running inside the kernel. */
export class ProgramContext {
  constructor(public kernel: Kernel, public proc: Proc) {}

  get argv() {
    return this.proc.argv;
  }
  get env() {
    return this.proc.env;
  }
  get cwd() {
    return this.proc.cwd;
  }
  set cwd(v: string) {
    this.proc.cwd = v;
  }
  get vfs() {
    return this.kernel.vfs;
  }
  get signal() {
    return this.proc.abort.signal;
  }

  resolve(p: string) {
    return this.kernel.resolvePath(this.proc.cwd, p);
  }

  /** Writes bytes/string to an fd (ignores EPIPE). */
  write(fd: number, data: string | Uint8Array) {
    const f = this.proc.fds.get(fd);
    if (!f) return;
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    try {
      f.write(bytes);
    } catch (e: any) {
      if (e?.code === 'EPIPE') throw new ExitSignal(141);
      throw e;
    }
  }
  out(s: string | Uint8Array) {
    this.write(1, s);
  }
  err(s: string | Uint8Array) {
    this.write(2, s);
  }

  async read(fd = 0, max = 65536): Promise<Uint8Array | null> {
    const f = this.proc.fds.get(fd);
    if (!f) return null;
    const abort = this.signal;
    if (abort.aborted) throw new ExitSignal(130);
    const d = await f.read(max);
    if (d.length === 0) return null;
    return d;
  }

  async readAll(fd = 0): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const d = await this.read(fd);
      if (!d) break;
      chunks.push(d);
      total += d.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  async readAllText(fd = 0): Promise<string> {
    return dec.decode(await this.readAll(fd));
  }

  isatty(fd: number) {
    return this.proc.fds.get(fd)?.kind === 'tty';
  }

  spawn(argv: string[], opts: Partial<SpawnOptions> = {}): Proc {
    const stdio = opts.stdio ?? [0, 1, 2].map((fd) => this.proc.fds.get(fd) ?? null);
    return this.kernel.spawn({
      argv,
      env: opts.env ?? { ...this.proc.env },
      cwd: opts.cwd ?? this.proc.cwd,
      stdio,
      ppid: this.proc.pid,
      pgid: opts.pgid,
      searchPath: opts.searchPath,
    });
  }

  /** Spawns and waits; returns the exit code. */
  async run(argv: string[], opts: Partial<SpawnOptions> = {}): Promise<number> {
    const p = this.spawn(argv, opts);
    return exitCodeOf(await p.exited);
  }

  /** Spawns and captures stdout (stderr passes through). */
  async capture(argv: string[], opts: Partial<SpawnOptions> = {}): Promise<{ code: number; stdout: string }> {
    const { r, w } = createPipe();
    const p = this.spawn(argv, { ...opts, stdio: [this.proc.fds.get(0) ?? null, w, this.proc.fds.get(2) ?? null] });
    w.unref();
    const reader = new ProgramContext(this.kernel, { fds: new Map([[0, r]]), abort: new AbortController() } as any);
    const out = await reader.readAllText(0);
    r.unref();
    const st = await p.exited;
    return { code: exitCodeOf(st), stdout: out };
  }

  exit(code: number): never {
    throw new ExitSignal(code);
  }
}

export { O_RDONLY, O_WRONLY, O_RDWR };
