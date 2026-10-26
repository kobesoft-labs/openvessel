// Process records.

import { kerr } from '../shared/errno.ts';
import type { SyncServer } from '../shared/syncchan.ts';
import type { OpenFile, Tty } from './io.ts';

/** Linux's signal numbers (x86-64, arm64). */
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
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};
/** Other names of the same signals */
const ALIASES: Record<string, string> = { SIGIOT: 'SIGABRT', SIGPOLL: 'SIGIO', SIGCLD: 'SIGCHLD', SIGUNUSED: 'SIGSYS' };
/** Real-time signals: SIGRTMIN is 34 (glibc keeps 32 and 33 for itself), SIGRTMAX is 64 */
export const SIGRTMIN = 34;
export const SIGRTMAX = 64;
const NAMES = new Map(Object.entries(SIGNALS).map(([k, v]) => [v, k]));

/** What a signal does to a process that has no handler for it (signal(7)). */
export type SignalAction = 'term' | 'core' | 'ign' | 'stop' | 'cont';
const ACTIONS: Record<string, SignalAction> = {
  SIGQUIT: 'core',
  SIGILL: 'core',
  SIGTRAP: 'core',
  SIGABRT: 'core',
  SIGBUS: 'core',
  SIGFPE: 'core',
  SIGSEGV: 'core',
  SIGXCPU: 'core',
  SIGXFSZ: 'core',
  SIGSYS: 'core',
  SIGCHLD: 'ign',
  SIGURG: 'ign',
  SIGWINCH: 'ign',
  SIGCONT: 'cont',
  SIGSTOP: 'stop',
  SIGTSTP: 'stop',
  SIGTTIN: 'stop',
  SIGTTOU: 'stop',
};

export function defaultAction(sig: string): SignalAction {
  return ACTIONS[sig] ?? 'term';
}

/**
 * The name of a signal given by number or by name ('TERM', 'SIGTERM', 'SIGIOT', 'SIGRTMIN+2', 'SIG40'),
 * as `kill -l` shows it: SIGRTMIN+n / SIGRTMAX-n for the real-time signals, SIG32 and SIG33. Something
 * that is no signal keeps its name (`SIG` + it), which signalNumber() rejects.
 */
export function signalName(n: number | string): string {
  return canonicalSignal(n) ?? (typeof n === 'number' ? `SIG${n}` : n.startsWith('SIG') ? n : 'SIG' + n);
}

function canonicalSignal(n: number | string): string | null {
  if (typeof n === 'string') {
    if (/^\d+$/.test(n)) return canonicalSignal(Number(n));
    const s = n.startsWith('SIG') ? n : 'SIG' + n;
    if (SIGNALS[s]) return s;
    if (ALIASES[s]) return ALIASES[s];
    const rt = /^SIGRT(MIN|MAX)(?:([+-])(\d+))?$/.exec(s);
    if (rt) return canonicalSignal((rt[1] === 'MIN' ? SIGRTMIN : SIGRTMAX) + (rt[2] === '-' ? -1 : 1) * Number(rt[3] ?? 0));
    const num = /^SIG(\d+)$/.exec(s);
    return num ? canonicalSignal(Number(num[1])) : null;
  }
  if (!Number.isInteger(n) || n < 1 || n > SIGRTMAX) return null;
  if (n < 32) return NAMES.get(n)!;
  if (n < SIGRTMIN) return `SIG${n}`;
  if (n === SIGRTMIN) return 'SIGRTMIN';
  if (n === SIGRTMAX) return 'SIGRTMAX';
  // bash's names: SIGRTMIN+1 … SIGRTMIN+15, then SIGRTMAX-14 … SIGRTMAX-1
  return n - SIGRTMIN <= 15 ? `SIGRTMIN+${n - SIGRTMIN}` : `SIGRTMAX-${SIGRTMAX - n}`;
}

/** The number of a signal; 0 stays 0 (kill(2)'s existence check), -1 when there is no such signal. */
export function signalNumber(s: string | number): number {
  if (s === 0 || s === '0' || s === 'SIG0') return 0;
  const name = canonicalSignal(s);
  if (!name) return -1;
  if (SIGNALS[name]) return SIGNALS[name];
  if (name.startsWith('SIGRTMIN')) return SIGRTMIN + Number(name.slice(8) || 0);
  if (name.startsWith('SIGRTMAX')) return SIGRTMAX + Number(name.slice(8) || 0);
  return Number(name.slice(3));
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
  /** file mode creation mask, inherited by children */
  umask = 0o022;
  /** the Node.js runtime (script URL) the process started with; its worker threads get the same */
  runtime?: string;
  /** RLIMIT_NOFILE (ulimit -n), inherited by children */
  nofile = 1024;
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

  /**
   * Allocates the lowest free fd >= min. The fd takes over the caller's reference to `file`; when
   * every number below RLIMIT_NOFILE is taken, the reference is dropped and it fails with EMFILE.
   */
  allocFd(file: OpenFile, min = 0): number {
    let fd: number;
    try {
      fd = this.freeFd(min);
    } catch (e) {
      file.unref();
      throw e;
    }
    this.fds.set(fd, file);
    return fd;
  }

  /** The lowest free fd >= min; EMFILE when it would reach RLIMIT_NOFILE. */
  freeFd(min = 0): number {
    let fd = min;
    while (this.fds.has(fd)) fd++;
    if (fd >= this.nofile) throw kerr('EMFILE');
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
  const n = signalNumber(s.signal ?? 'SIGTERM');
  return 128 + (n > 0 ? n : 15);
}
