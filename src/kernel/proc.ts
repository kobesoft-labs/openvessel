// Process records.

import { kerr } from '../shared/errno.ts';
import type { SyncServer } from '../shared/syncchan.ts';
import type { OpenFile, Tty } from './io.ts';

export const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGWINCH: 28,
};

export function signalName(n: number | string): string {
  if (typeof n === 'string') return n.startsWith('SIG') ? n : 'SIG' + n;
  for (const [k, v] of Object.entries(SIGNALS)) if (v === n) return k;
  return 'SIGTERM';
}

export function signalNumber(s: string | number): number {
  if (typeof s === 'number') return s;
  return SIGNALS[signalName(s)] ?? 15;
}

export interface ExitStatus {
  code: number | null;
  signal: string | null;
}

/** A thread of a node process (main thread or a worker_threads Worker). */
export interface NodeThread {
  tid: number;
  worker: Worker;
  server: SyncServer;
  /** Pending syscall (we never handle two at once per thread). */
  busy: boolean;
  parentTid?: number;
}

export class Proc {
  pid: number;
  ppid: number;
  pgid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  umask = 0o022;
  fds = new Map<number, OpenFile>();
  tty?: Tty;
  title: string;
  kind: 'node' | 'builtin' = 'builtin';
  state: 'running' | 'exited' = 'running';
  status: ExitStatus | null = null;
  children = new Set<number>();
  /** Signals the process installed handlers for (node processes). */
  handledSignals = new Set<string>();
  /** Builtin programs: return true to swallow a signal. */
  onSignal?: (sig: string) => boolean;
  threads = new Map<number, NodeThread>();
  abort = new AbortController();
  private exitWaiters: ((s: ExitStatus) => void)[] = [];
  startedAt = Date.now();
  /** Notified once the process exits (after fds are closed). */
  onExit = new Set<(s: ExitStatus) => void>();

  constructor(init: { pid: number; ppid: number; pgid: number; argv: string[]; env: Record<string, string>; cwd: string }) {
    this.pid = init.pid;
    this.ppid = init.ppid;
    this.pgid = init.pgid;
    this.argv = init.argv;
    this.env = init.env;
    this.cwd = init.cwd;
    this.title = init.argv[0] ?? '?';
  }

  get exited(): Promise<ExitStatus> {
    if (this.status) return Promise.resolve(this.status);
    return new Promise((r) => this.exitWaiters.push(r));
  }

  /** Allocates the lowest free fd >= min. */
  allocFd(file: OpenFile, min = 0): number {
    let fd = min;
    while (this.fds.has(fd)) fd++;
    this.fds.set(fd, file);
    return fd;
  }

  getFd(fd: number): OpenFile {
    const f = this.fds.get(fd);
    if (!f) throw kerr('EBADF');
    return f;
  }

  closeFd(fd: number) {
    const f = this.fds.get(fd);
    if (!f) throw kerr('EBADF');
    this.fds.delete(fd);
    f.unref();
  }

  dupTo(oldFd: number, newFd: number) {
    const f = this.getFd(oldFd);
    if (oldFd === newFd) return;
    const prev = this.fds.get(newFd);
    this.fds.set(newFd, f.ref());
    prev?.unref();
  }

  closeAll() {
    for (const f of this.fds.values()) f.unref();
    this.fds.clear();
  }

  finish(status: ExitStatus) {
    if (this.state === 'exited') return;
    this.state = 'exited';
    this.status = status;
    this.closeAll();
    const ws = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of ws) w(status);
    for (const fn of this.onExit) fn(status);
  }
}

export function exitCodeOf(s: ExitStatus): number {
  if (s.code !== null) return s.code;
  return 128 + signalNumber(s.signal ?? 'SIGTERM');
}
