// Shell interpreter.

import * as path from '../../shared/path.ts';
import { O_APPEND, O_CREAT, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY, type OpenFile, createPipe } from '../io.ts';
import { ExitSignal, type Kernel, ProgramContext } from '../kernel.ts';
import { type Proc, SIGNALS, exitCodeOf } from '../proc.ts';
import { isDir } from '../vfs.ts';
import { evalArith } from './arith.ts';
import { applySymbolicMode, symbolicUmask } from './mode.ts';
import { type Node, Parser, type Redir, type Word, type WordPart, ShellSyntaxError, isName, parse } from './parse.ts';
import { eregToRegexSource, hasGlobChars, matchPattern, patternToRegexSource, removeMatch, replaceMatch, unescapePattern } from './pattern.ts';
import { BINARY_OPS, UNARY_OPS, builtinTest } from './test.ts';
import { formatPrintf } from './printf.ts';

class BreakSig {
  constructor(public n: number) {}
}
class ContinueSig {
  constructor(public n: number) {}
}
class ReturnSig {
  constructor(public code: number) {}
}
/** ^C in an interactive shell: abandons the command line being run. */
class InterruptSig {}

/** Background jobs waiting for their process to start: the process runs the job in a copy of the shell. */
const pendingJobs = new WeakMap<Proc, (ctx: ProgramContext) => Promise<number>>();

/** Signals that end a shell by default (the rest are ignored or handled by the kernel). */
const FATAL_SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'SIGALRM', 'SIGPIPE', 'SIGABRT']);

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Field {
  value: string;
  pat: string;
  glob: boolean;
}

type Seg = { s: string; quoted: boolean; split: boolean } | { brk: true };

export interface ShellOptions {
  errexit: boolean;
  xtrace: boolean;
  nounset: boolean;
  pipefail: boolean;
  noglob: boolean;
  interactive: boolean;
}

type ShellBuiltin = (sh: Shell, args: string[]) => Promise<number> | number;

export class Shell {
  vars = new Map<string, string>();
  exported = new Set<string>();
  readonlyVars = new Set<string>();
  funcs = new Map<string, Node>();
  aliases = new Map<string, string>();
  positional: string[] = [];
  arg0 = 'sh';
  status = 0;
  /** $!: pid of the last background job. */
  lastBg = 0;
  /** Background jobs by pid: their exit status, kept until `wait` collects it. */
  bgJobs = new Map<number, Promise<number>>();
  opts: ShellOptions = { errexit: false, xtrace: false, nounset: false, pipefail: false, noglob: false, interactive: false };
  fds = new Map<number, OpenFile>();
  locals: Map<string, string | undefined>[] = [];
  /** trap actions by condition (EXIT, ERR, INT, TERM…); '' ignores the signal. */
  traps = new Map<string, string>();
  /** Signals received for which a trap is set, run at the next command boundary. */
  private pendingTraps: string[] = [];
  private trapWaiters: (() => void)[] = [];
  private inTrap = false;
  /** Indexed arrays (only BASH_REMATCH is one). */
  arrays = new Map<string, string[]>();
  /** This shell is its process (not an in-process subshell): exec and signal traps act on the process. */
  ownsProc = false;
  /** $$: the pid of the shell, also in subshells and background jobs. */
  shellPid: number;
  /** The file mode creation mask; an in-process subshell has its own copy. */
  umask: number;
  /** Run the next external simple command in this process (exec), as the last command of a job. */
  execLast = false;
  cwd: string;
  depth = 0;
  /** errexit suppressed (inside conditions). */
  private noErrexit = 0;
  history: string[] = [];

  /** `init` false: an empty shell that clone() fills in. */
  constructor(
    public ctx: ProgramContext,
    init = true,
  ) {
    this.cwd = ctx.cwd;
    this.shellPid = ctx.proc.pid;
    this.umask = ctx.proc.umask;
    if (!init) return;
    for (const [k, v] of Object.entries(ctx.env)) {
      this.vars.set(k, v);
      this.exported.add(k);
    }
    for (const [fd, f] of ctx.proc.fds) this.fds.set(fd, f.ref());
    if (!this.vars.has('PWD')) this.vars.set('PWD', this.cwd);
    this.vars.set('PWD', this.cwd);
    this.exported.add('PWD');
    if (!this.vars.has('IFS')) this.vars.set('IFS', ' \t\n');
    this.vars.set('PPID', String(ctx.proc.ppid));
  }

  get kernel(): Kernel {
    return this.ctx.kernel;
  }

  /** Creates a subshell copy (shares nothing mutable with the parent). */
  clone(): Shell {
    const s = new Shell(this.ctx, false);
    s.ctx = this.ctx;
    s.vars = new Map(this.vars);
    s.exported = new Set(this.exported);
    s.readonlyVars = new Set(this.readonlyVars);
    s.funcs = new Map(this.funcs);
    s.aliases = new Map(this.aliases);
    s.positional = [...this.positional];
    s.arg0 = this.arg0;
    s.status = this.status;
    s.lastBg = this.lastBg;
    s.bgJobs = new Map();
    s.opts = { ...this.opts, interactive: false };
    s.fds = new Map();
    for (const [fd, f] of this.fds) s.fds.set(fd, f.ref());
    s.locals = [];
    // a subshell resets the traps, except that ignored signals stay ignored
    for (const [k, v] of this.traps) if (v === '' && k !== 'EXIT' && k !== 'ERR') s.traps.set(k, v);
    s.arrays = new Map(this.arrays);
    s.opts_allexport = this.opts_allexport;
    s.shellPid = this.shellPid;
    s.umask = this.umask;
    s.pipelinePgid = this.pipelinePgid;
    s.onSpawn = this.onSpawn;
    s.onSigint = this.onSigint;
    s.cwd = this.cwd;
    s.depth = this.depth;
    s.noErrexit = this.noErrexit;
    return s;
  }

  /** The child shell of a background job, in its own process. */
  private adoptProcess(ctx: ProgramContext) {
    this.ctx = ctx;
    this.releaseFds();
    for (const [fd, f] of ctx.proc.fds) this.fds.set(fd, f.ref());
    ctx.proc.umask = this.umask;
    this.ownsProc = true;
    this.installSignalHandler();
  }

  releaseFds() {
    for (const f of this.fds.values()) f.unref();
    this.fds.clear();
  }

  // ---------------------------------------------------------------------------
  // variables

  getVar(name: string): string | undefined {
    switch (name) {
      case '?':
        return String(this.status);
      case '$':
        return String(this.shellPid);
      case '!':
        return this.lastBg ? String(this.lastBg) : '';
      case '#':
        return String(this.positional.length);
      case '0':
        return this.arg0;
      case '@':
      case '*':
        return this.positional.join(name === '*' ? (this.vars.get('IFS') ?? ' ')[0] ?? '' : ' ');
      case '-':
        return (this.opts.errexit ? 'e' : '') + (this.opts.xtrace ? 'x' : '') + (this.opts.nounset ? 'u' : '') + (this.opts.interactive ? 'i' : '');
      case 'RANDOM':
        return String(Math.floor(Math.random() * 32768));
      case 'SECONDS':
        return String(Math.floor((Date.now() - this.ctx.proc.startedAt) / 1000));
      case 'PWD':
        return this.cwd;
      case 'BASHPID':
        return String(this.ctx.proc.pid);
    }
    if (/^[0-9]+$/.test(name)) return this.positional[Number(name) - 1];
    return this.vars.get(name);
  }

  setVar(name: string, value: string, exportIt = false) {
    if (this.readonlyVars.has(name)) throw new ShellError(`${name}: readonly variable`);
    this.vars.set(name, value);
    if (exportIt || this.opts_allexport) this.exported.add(name);
    if (name === 'PWD') this.cwd = value;
  }
  opts_allexport = false;

  unsetVar(name: string) {
    if (this.readonlyVars.has(name)) throw new ShellError(`${name}: readonly variable`);
    this.vars.delete(name);
    this.exported.delete(name);
  }

  envForChild(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of this.exported) {
      const v = this.vars.get(k);
      if (v !== undefined) env[k] = v;
    }
    env.PWD = this.cwd;
    if (extra) Object.assign(env, extra);
    return env;
  }

  // ---------------------------------------------------------------------------
  // output helpers

  write(fd: number, s: string | Uint8Array) {
    const f = this.fds.get(fd);
    if (!f) return;
    try {
      f.write(typeof s === 'string' ? enc.encode(s) : s);
    } catch (e: any) {
      if (e?.code === 'EPIPE') throw new ExitSignal(141);
      throw e;
    }
  }
  out(s: string) {
    this.write(1, s);
  }
  err(s: string) {
    this.write(2, s);
  }

  async readFd(fd: number, max = 65536): Promise<Uint8Array | null> {
    const f = this.fds.get(fd);
    if (!f) return null;
    const d = await f.read(max);
    return d.length ? d : null;
  }

  resolve(p: string) {
    return path.resolve(this.cwd, p);
  }

  // ---------------------------------------------------------------------------
  // running

  /**
   * Parses and runs `src` one complete command (line) at a time. An error that abandons a command
   * (assigning a readonly variable, a bad $(( )) …) skips the rest of that line and goes on with
   * the next, as bash does; a syntax error stops with status 2.
   */
  async runSource(src: string, name = this.arg0): Promise<number> {
    const parser = new Parser(src, this.aliases);
    let st = 0;
    for (;;) {
      let node: Node | null;
      try {
        node = parser.parseNext();
      } catch (e: any) {
        if (!(e instanceof ShellSyntaxError)) throw e;
        this.err(`${name}: ${e.message}\n`);
        this.status = 2;
        return 2;
      }
      if (!node) return st;
      try {
        st = await this.exec(node);
      } catch (e) {
        if (!(e instanceof ShellError)) throw e;
        this.err(`sh: ${e.message}\n`);
        this.status = st = e.code;
        if (this.opts.errexit && this.noErrexit === 0) throw new ExitSignal(st);
      }
    }
  }

  /**
   * Runs `body` as a subshell in `sub` (a clone): `exit`, errors and stray `return`/`break` end
   * the subshell only, then its EXIT trap runs and its fds are released.
   */
  private static async isolated(sub: Shell, body: () => Promise<number>): Promise<number> {
    let code: number;
    try {
      code = await body();
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code;
      else if (e instanceof ReturnSig) code = e.code;
      else if (e instanceof BreakSig || e instanceof ContinueSig) code = 0;
      else if (e instanceof ShellError) {
        try {
          sub.err(`sh: ${e.message}\n`);
        } catch {}
        code = e.code;
      } else {
        sub.releaseFds();
        throw e;
      }
    }
    try {
      return await sub.runExitTrap(code);
    } finally {
      sub.releaseFds();
    }
  }

  // ---------------------------------------------------------------------------
  // traps

  /** Runs the EXIT trap (once) and returns the shell's exit status: `code`, or the trap's `exit`. */
  async runExitTrap(code: number): Promise<number> {
    const action = this.traps.get('EXIT');
    this.traps.delete('EXIT');
    if (!action) return code;
    this.status = code;
    try {
      await this.runSource(action, 'trap');
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      if (e instanceof ReturnSig || e instanceof BreakSig || e instanceof ContinueSig || e instanceof InterruptSig) return code;
      throw e;
    }
    return code;
  }

  /** Runs the traps of the signals that arrived since the last command, keeping $?. */
  private async runPendingTraps() {
    if (this.inTrap) return;
    this.inTrap = true;
    try {
      while (this.pendingTraps.length) {
        const sig = this.pendingTraps.shift()!;
        const action = this.traps.get(sig);
        if (!action) continue;
        const saved = this.status;
        await this.runSource(action, 'trap');
        this.status = saved;
      }
    } finally {
      this.inTrap = false;
    }
  }

  /** Resolves when a trapped signal arrives (`wait` returns early then). */
  waitForTrap(): Promise<void> {
    if (this.pendingTraps.length) return Promise.resolve();
    return new Promise((r) => this.trapWaiters.push(r));
  }

  /** The signal whose trap is about to run (for wait's status). */
  pendingTrapSignal(): string | undefined {
    return this.pendingTraps[0];
  }

  /** The process's signal handler: trapped signals are queued, the rest take their default action. */
  installSignalHandler() {
    const proc = this.ctx.proc;
    proc.onSignal = (sig) => {
      const name = sig.replace(/^SIG/, '');
      const action = this.traps.get(name);
      if (action !== undefined) {
        if (action !== '') {
          this.pendingTraps.push(name);
          const ws = this.trapWaiters;
          this.trapWaiters = [];
          for (const w of ws) w();
        }
        return true;
      }
      if (this.opts.interactive && (sig === 'SIGINT' || sig === 'SIGTSTP' || sig === 'SIGQUIT' || sig === 'SIGTERM' || sig === 'SIGWINCH')) {
        // an interactive shell isn't stopped by these; ^C abandons the command line
        if (sig === 'SIGINT') this.interrupted = true;
        return true;
      }
      if (FATAL_SIGNALS.has(sig) && this.traps.has('EXIT')) {
        // bash runs the EXIT trap before it dies of the signal
        void this.dieOfSignal(sig);
        return true;
      }
      return false;
    };
  }

  private async dieOfSignal(sig: string) {
    const proc = this.ctx.proc;
    try {
      await this.runExitTrap(128 + (SIGNALS[sig] ?? 15));
    } catch {}
    if (proc.state !== 'running') return;
    proc.abort.abort(sig);
    proc.finish({ code: null, signal: sig });
  }

  setUmask(mask: number) {
    this.umask = mask;
    // the process's own mask too (what its node threads and /proc see), unless this is a subshell
    if (this.ownsProc) this.ctx.proc.umask = mask;
  }

  /** `set -o` / `[[ -o name ]]`: whether a shell option is on. */
  optionIsSet(name: string): boolean {
    switch (name) {
      case 'errexit':
        return this.opts.errexit;
      case 'xtrace':
        return this.opts.xtrace;
      case 'nounset':
        return this.opts.nounset;
      case 'pipefail':
        return this.opts.pipefail;
      case 'noglob':
        return this.opts.noglob;
      case 'allexport':
        return this.opts_allexport;
      case 'interactive':
        return this.opts.interactive;
    }
    return false;
  }

  async exec(node: Node): Promise<number> {
    if (this.ctx.signal.aborted) throw new ExitSignal(130);
    if (this.pendingTraps.length) await this.runPendingTraps();
    if (this.interrupted) {
      this.interrupted = false;
      throw new InterruptSig();
    }
    let st: number;
    switch (node.t) {
      case 'simple':
        st = await this.execSimple(node);
        break;
      case 'pipeline':
        st = await this.execPipeline(node);
        break;
      case 'andor': {
        this.noErrexit++;
        let s: number;
        try {
          s = await this.exec(node.first);
        } finally {
          this.noErrexit--;
        }
        for (let i = 0; i < node.rest.length; i++) {
          const { op, node: n } = node.rest[i];
          if ((op === '&&' && s === 0) || (op === '||' && s !== 0)) {
            const last = i === node.rest.length - 1;
            if (!last) this.noErrexit++;
            try {
              s = await this.exec(n);
            } finally {
              if (!last) this.noErrexit--;
            }
          }
        }
        st = s;
        this.status = st;
        return st;
      }
      case 'list': {
        st = 0;
        for (const item of node.items) {
          if (item.async) {
            this.spawnAsync(item.node);
            st = 0;
          } else {
            st = await this.exec(item.node);
          }
          this.status = st;
        }
        return st;
      }
      case 'subshell': {
        st = await this.withRedirs(node.redirs, async () => {
          const sub = this.clone();
          return Shell.isolated(sub, () => sub.exec(node.body));
        });
        break;
      }
      case 'group':
        st = await this.withRedirs(node.redirs, () => this.exec(node.body));
        break;
      case 'if':
        st = await this.withRedirs(node.redirs, async () => {
          for (const c of node.clauses) {
            if ((await this.cond(c.cond)) === 0) return this.exec(c.body);
          }
          if (node.else) return this.exec(node.else);
          return 0;
        });
        break;
      case 'while':
        st = await this.withRedirs(node.redirs, async () => {
          let s = 0;
          for (;;) {
            const c = await this.cond(node.cond);
            if (node.until ? c === 0 : c !== 0) break;
            try {
              s = await this.exec(node.body);
            } catch (e) {
              if (e instanceof BreakSig) {
                if (e.n > 1) throw new BreakSig(e.n - 1);
                break;
              }
              if (e instanceof ContinueSig) {
                if (e.n > 1) throw new ContinueSig(e.n - 1);
                continue;
              }
              throw e;
            }
          }
          return s;
        });
        break;
      case 'for':
        st = await this.withRedirs(node.redirs, async () => {
          const items = node.words ? await this.expandWords(node.words) : [...this.positional];
          let s = 0;
          for (const it of items) {
            this.setVar(node.name, it);
            try {
              s = await this.exec(node.body);
            } catch (e) {
              if (e instanceof BreakSig) {
                if (e.n > 1) throw new BreakSig(e.n - 1);
                break;
              }
              if (e instanceof ContinueSig) {
                if (e.n > 1) throw new ContinueSig(e.n - 1);
                continue;
              }
              throw e;
            }
          }
          return s;
        });
        break;
      case 'case':
        st = await this.withRedirs(node.redirs, async () => {
          const w = await this.expandSingle(node.word);
          let s = 0;
          let k = 0;
          while (k < node.items.length) {
            let hit = false;
            for (const p of node.items[k].patterns) {
              if (matchPattern(await this.expandPattern(p), w)) {
                hit = true;
                break;
              }
            }
            if (!hit) {
              k++;
              continue;
            }
            // ;& runs the next body too, without testing its patterns
            for (;;) {
              const item = node.items[k];
              s = item.body ? await this.exec(item.body) : 0;
              if (item.term !== ';&' || k === node.items.length - 1) break;
              k++;
            }
            // ;;& goes on testing the clauses after it
            if (node.items[k].term !== ';;&') return s;
            k++;
          }
          return s;
        });
        break;
      case 'func':
        this.funcs.set(node.name, node.body);
        st = 0;
        break;
      case 'dbracket':
        st = await this.withRedirs(node.redirs, () => this.execDbracket(node.words));
        break;
    }
    this.status = st;
    if (st !== 0 && this.noErrexit === 0 && (node.t === 'simple' || node.t === 'pipeline' || node.t === 'subshell') && this.depth === 0 && this.traps.get('ERR') && !this.inTrap) {
      // the ERR trap: where set -e would exit (not inside functions: there is no set -E)
      this.inTrap = true;
      try {
        await this.runSource(this.traps.get('ERR')!, 'trap');
      } finally {
        this.inTrap = false;
      }
      this.status = st;
    }
    if (this.pendingTraps.length) {
      await this.runPendingTraps();
      this.status = st;
    }
    if (st !== 0 && this.opts.errexit && this.noErrexit === 0 && node.t !== 'func') {
      throw new ExitSignal(st);
    }
    return st;
  }

  private async cond(n: Node): Promise<number> {
    this.noErrexit++;
    try {
      return await this.exec(n);
    } finally {
      this.noErrexit--;
    }
  }

  /**
   * `cmd &`: the job runs in a new process (a copy of this shell, as fork does), so $! is a real
   * pid that kill and wait can use. A simple command is exec'd in that process, so $! is the
   * command's own pid. With job control (interactive) the job gets its own process group.
   */
  private spawnAsync(node: Node) {
    const sub = this.clone();
    sub.releaseFds();
    const maxFd = Math.max(2, ...this.fds.keys());
    const stdio: (OpenFile | null)[] = [];
    for (let i = 0; i <= maxFd; i++) stdio.push(this.fds.get(i) ?? null);
    let proc: Proc;
    try {
      proc = this.kernel.spawn({
        argv: [...this.ctx.proc.argv],
        env: this.envForChild(),
        cwd: this.cwd,
        stdio,
        ppid: this.ctx.proc.pid,
        pgid: this.opts.interactive ? 0 : undefined,
        searchPath: false,
      });
    } catch (e: any) {
      this.err(`sh: fork: ${e.message}\n`);
      this.status = 1;
      return;
    }
    // the process starts on a microtask, after this
    pendingJobs.set(proc, async (ctx) => {
      sub.adoptProcess(ctx);
      if (node.t === 'simple') sub.execLast = true;
      return Shell.isolated(sub, () => sub.exec(node));
    });
    this.lastBg = proc.pid;
    this.bgJobs.set(proc.pid, proc.exited.then(exitCodeOf));
    if (this.opts.interactive) this.err(`[${this.bgJobs.size}] ${proc.pid}\n`);
  }

  // ---------------------------------------------------------------------------
  // pipelines

  private async execPipeline(node: Extract<Node, { t: 'pipeline' }>): Promise<number> {
    const n = node.cmds.length;
    if (n === 1) {
      const s = node.bang ? await this.cond(node.cmds[0]) : await this.exec(node.cmds[0]);
      return node.bang ? (s === 0 ? 1 : 0) : s;
    }
    const pipes = Array.from({ length: n - 1 }, () => createPipe());
    // with job control (an interactive shell on a tty) the pipeline is one job: one process group,
    // the terminal's foreground group while it runs, so ^C reaches every command of it
    const tty = this.opts.interactive ? this.ctx.proc.tty : undefined;
    let pgid: number | undefined;
    let sigint = false;
    const runs: Promise<number>[] = [];
    for (let i = 0; i < n; i++) {
      const sub = this.clone();
      if (i > 0) {
        sub.fds.get(0)?.unref();
        sub.fds.set(0, pipes[i - 1].r);
      }
      if (i < n - 1) {
        sub.fds.get(1)?.unref();
        sub.fds.set(1, pipes[i].w);
      }
      if (tty) {
        sub.pipelinePgid = () => pgid;
        sub.onSpawn = (p) => {
          if (pgid !== undefined) return;
          pgid = p.pgid;
          tty.foregroundPgid = pgid;
        };
        sub.onSigint = () => (sigint = true);
      }
      runs.push(Shell.isolated(sub, () => sub.exec(node.cmds[i])));
    }
    let codes: number[];
    try {
      codes = await Promise.all(runs);
    } finally {
      if (tty && pgid !== undefined) {
        tty.foregroundPgid = this.ctx.proc.pgid;
        tty.raw = false;
        tty.echo = true;
      }
    }
    let s = codes[n - 1];
    if (this.opts.pipefail) {
      for (let i = n - 1; i >= 0; i--) if (codes[i] !== 0) {
        s = codes[i];
        break;
      }
    }
    if (node.bang) s = s === 0 ? 1 : 0;
    if (sigint) throw new InterruptSig();
    return s;
  }
  /** Set in the commands of a pipeline run with job control: the pipeline's process group. */
  pipelinePgid?: () => number | undefined;
  onSpawn?: (proc: Proc) => void;
  /** A command of the pipeline died of ^C. */
  onSigint?: () => void;

  // ---------------------------------------------------------------------------
  // simple commands

  private async execSimple(node: Extract<Node, { t: 'simple' }>): Promise<number> {
    let execTail = this.execLast;
    this.execLast = false;
    // $? of an assignment-only command: the last command substitution in it, else 0
    this.lastSubstStatus = undefined;
    const words = await this.expandWords(node.words);
    const assigns: [string, string][] = [];
    for (const a of node.assigns) {
      let v = await this.expandSingle(a.value, true);
      if (a.append) v = (this.getVar(a.name) ?? '') + v;
      assigns.push([a.name, v]);
    }
    if (this.opts.xtrace) {
      const ps4 = this.vars.get('PS4') ?? '+ ';
      this.err(ps4 + [...assigns.map(([k, v]) => `${k}=${v}`), ...words].map(quoteForTrace).join(' ') + '\n');
    }
    if (words.length === 0) {
      for (const [k, v] of assigns) this.setVar(k, v);
      if (node.redirs.length) return this.withRedirs(node.redirs, async () => 0);
      return this.lastSubstStatus ?? 0;
    }
    let cmd = words[0];
    let args = words.slice(1);

    // `exec cmd`: the command replaces the shell in its process (an in-process subshell, which has
    // no process of its own, runs it and exits instead: see the exec builtin)
    if (cmd === 'exec' && args.length && this.ownsProc && args[0] !== '--' && !this.funcs.has(args[0]) && !BUILTINS[args[0]]) {
      cmd = args[0];
      args = args.slice(1);
      execTail = true;
    }

    // `exec` with only redirections modifies the shell itself
    if (cmd === 'exec' && args.length === 0) {
      const saved = this.fds;
      try {
        this.fds = await this.applyRedirs(node.redirs, saved, true);
      } catch (e: any) {
        this.err(`sh: ${e.message}\n`);
        return 1;
      }
      for (const f of saved.values()) f.unref();
      return 0;
    }

    const fn = this.funcs.get(cmd);
    if (fn) {
      return this.withRedirs(node.redirs, async () => {
        const savedPos = this.positional;
        const savedArg0 = this.arg0;
        const savedVals: [string, string | undefined][] = assigns.map(([k]) => [k, this.vars.get(k)]);
        for (const [k, v] of assigns) this.setVar(k, v);
        this.positional = args;
        this.locals.push(new Map());
        this.depth++;
        if (this.depth > 200) {
          this.depth--;
          throw new ShellError('maximum function nesting level exceeded');
        }
        try {
          return await this.exec(fn);
        } catch (e) {
          if (e instanceof ReturnSig) return e.code;
          throw e;
        } finally {
          this.depth--;
          const scope = this.locals.pop()!;
          for (const [k, v] of scope) {
            if (v === undefined) this.vars.delete(k);
            else this.vars.set(k, v);
          }
          this.positional = savedPos;
          this.arg0 = savedArg0;
          for (const [k, v] of savedVals) {
            if (v === undefined) this.vars.delete(k);
            else this.vars.set(k, v);
          }
        }
      });
    }

    const bi = BUILTINS[cmd];
    if (bi) {
      const special = SPECIAL_BUILTINS.has(cmd);
      const savedVals: [string, string | undefined][] = [];
      for (const [k, v] of assigns) {
        if (!special) savedVals.push([k, this.vars.get(k)]);
        this.setVar(k, v);
      }
      try {
        return await this.withRedirs(node.redirs, async () => {
          try {
            return await bi(this, args);
          } catch (e) {
            if (e instanceof ShellError) {
              this.err(`sh: ${cmd}: ${e.message}\n`);
              return e.code;
            }
            throw e;
          }
        });
      } finally {
        for (const [k, v] of savedVals) {
          if (v === undefined) this.vars.delete(k);
          else this.vars.set(k, v);
        }
      }
    }

    // external command
    let fds: Map<number, OpenFile>;
    try {
      fds = await this.applyRedirs(node.redirs, this.fds, false);
    } catch (e: any) {
      this.err(`sh: ${e.message}\n`);
      return 1;
    }
    try {
      const env = this.envForChild(Object.fromEntries(assigns));
      if (execTail) return await this.execImage(cmd, args, env, fds);
      const maxFd = Math.max(2, ...fds.keys());
      const stdio: (OpenFile | null)[] = [];
      for (let i = 0; i <= maxFd; i++) stdio.push(fds.get(i) ?? null);
      let proc;
      try {
        // job control: an interactive shell starts each job in its own process group (a pipeline
        // shares one); otherwise commands stay in the shell's group, so ^C reaches them
        const pg = this.pipelinePgid?.();
        proc = this.kernel.spawn({
          argv: [cmd, ...args],
          env,
          cwd: this.cwd,
          stdio,
          ppid: this.ctx.proc.pid,
          pgid: pg !== undefined ? pg : this.pipelinePgid || this.opts.interactive ? 0 : undefined,
        });
      } catch (e: any) {
        return this.spawnError(cmd, e);
      }
      proc.umask = this.umask;
      this.onSpawn?.(proc);
      const tty = this.ctx.proc.tty;
      const fg = this.opts.interactive && tty;
      if (fg) tty!.foregroundPgid = proc.pgid;
      const st = await proc.exited;
      if (fg) {
        tty!.foregroundPgid = this.ctx.proc.pgid;
        tty!.raw = false;
        tty!.echo = true;
      }
      if (st.signal && (this.opts.interactive || this.onSigint) && st.signal !== 'SIGINT' && st.signal !== 'SIGPIPE') this.err(`${st.signal}\n`);
      if (st.signal === 'SIGINT') {
        // like bash: a job killed by ^C abandons the command line (loops included)
        if (this.opts.interactive) throw new InterruptSig();
        this.onSigint?.();
      }
      return exitCodeOf(st);
    } finally {
      if (fds !== this.fds) for (const f of fds.values()) f.unref();
    }
  }
  lastSubstStatus?: number;

  private spawnError(cmd: string, e: any): number {
    if (e.code === 'ENOENT') {
      this.err(`sh: ${cmd}: command not found\n`);
      return 127;
    }
    if (e.code === 'EACCES') {
      this.err(`sh: ${cmd}: Permission denied\n`);
      return 126;
    }
    this.err(`sh: ${cmd}: ${e.message}\n`);
    return 126;
  }

  /**
   * exec: replaces the program of this shell's process with the command (same pid and fds), then
   * waits for it; the process ends with the command's status.
   */
  private async execImage(cmd: string, args: string[], env: Record<string, string>, fds: Map<number, OpenFile>): Promise<never | number> {
    const proc = this.ctx.proc;
    const old = proc.fds;
    proc.fds = new Map();
    for (const [k, f] of fds) proc.fds.set(k, f.ref());
    const oldCwd = proc.cwd;
    proc.cwd = this.cwd;
    proc.umask = this.umask;
    const onSignal = proc.onSignal;
    proc.onSignal = undefined;
    try {
      this.kernel.execImage(proc, [cmd, ...args], env);
    } catch (e: any) {
      for (const f of proc.fds.values()) f.unref();
      proc.fds = old;
      proc.cwd = oldCwd;
      proc.onSignal = onSignal;
      const code = this.spawnError(cmd, e);
      // a failed exec ends a non-interactive shell
      if (this.opts.interactive) return code;
      throw new ExitSignal(code);
    }
    for (const f of old.values()) f.unref();
    // the shell's own references must not keep pipes open for the new program's readers
    this.releaseFds();
    // the shell is gone: nothing more of it runs, not even its EXIT trap
    this.traps.clear();
    throw new ExitSignal(exitCodeOf(await proc.exited));
  }

  /** Runs `fn` with redirections applied to this shell's fds, then restores. */
  private async withRedirs(redirs: Redir[], fn: () => Promise<number>): Promise<number> {
    if (!redirs.length) return fn();
    const saved = this.fds;
    try {
      this.fds = await this.applyRedirs(redirs, saved, false);
    } catch (e: any) {
      this.err(`sh: ${e.message}\n`);
      return 1;
    }
    try {
      return await fn();
    } finally {
      for (const f of this.fds.values()) f.unref();
      this.fds = saved;
    }
  }

  /** Returns a new fd map (refs taken) with redirections applied. */
  private async applyRedirs(redirs: Redir[], base: Map<number, OpenFile>, permanent: boolean): Promise<Map<number, OpenFile>> {
    if (!redirs.length) return base;
    const fds = new Map<number, OpenFile>();
    for (const [k, f] of base) fds.set(k, f.ref());
    const set = (fd: number, f: OpenFile | null) => {
      fds.get(fd)?.unref();
      if (f) fds.set(fd, f);
      else fds.delete(fd);
    };
    try {
      for (const r of redirs) {
        if (r.heredoc) {
          const body = r.heredoc.quoted ? r.heredoc.raw ?? '' : await this.expandSingle(r.heredoc.body);
          const { r: rd, w } = createPipe();
          if (body) w.write(enc.encode(body));
          w.unref();
          set(r.fd ?? 0, rd);
          continue;
        }
        const target = await this.expandSingle(r.target);
        const fd = r.fd ?? (r.op.startsWith('<') ? 0 : 1);
        switch (r.op) {
          case '>':
          case '>|':
            set(fd, this.open(target, O_WRONLY | O_CREAT | O_TRUNC));
            break;
          case '>>':
            set(fd, this.open(target, O_WRONLY | O_CREAT | O_APPEND));
            break;
          case '<':
            set(fd, this.open(target, O_RDONLY));
            break;
          case '<>':
            set(fd, this.open(target, O_RDWR | O_CREAT));
            break;
          case '&>':
            {
              const f = this.open(target, O_WRONLY | O_CREAT | O_TRUNC);
              set(1, f);
              set(2, f.ref());
            }
            break;
          case '&>>':
            {
              const f = this.open(target, O_WRONLY | O_CREAT | O_APPEND);
              set(1, f);
              set(2, f.ref());
            }
            break;
          case '>&':
          case '<&': {
            if (target === '-') {
              set(fd, null);
            } else if (/^[0-9]+$/.test(target)) {
              const src = fds.get(Number(target));
              if (!src) throw new ShellError(`${target}: Bad file descriptor`);
              set(fd, src.ref());
            } else if (r.op === '>&') {
              const f = this.open(target, O_WRONLY | O_CREAT | O_TRUNC);
              set(1, f);
              set(2, f.ref());
            } else throw new ShellError(`${target}: ambiguous redirect`);
            break;
          }
          case '<<<': {
            const { r: rd, w } = createPipe();
            w.write(enc.encode(target + '\n'));
            w.unref();
            set(fd, rd);
            break;
          }
        }
      }
    } catch (e) {
      for (const f of fds.values()) f.unref();
      throw e;
    }
    void permanent;
    return fds;
  }

  private open(target: string, flags: number): OpenFile {
    try {
      return this.kernel.openFile({ cwd: this.cwd, fds: this.fds, tty: this.ctx.proc.tty, umask: this.umask } as any, target, flags, 0o666);
    } catch (e: any) {
      const msg = e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EISDIR' ? 'Is a directory' : e.code === 'EACCES' ? 'Permission denied' : e.message;
      throw new ShellError(`${target}: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // [[ ... ]]

  private async execDbracket(words: Word[]): Promise<number> {
    // operators are recognised only as unquoted words; operands are expanded when they are needed
    // (no field splitting or globbing), so `&&` and `||` short-circuit like in bash
    const toks = words.map((w) => ({ w, op: w.length === 1 && w[0].t === 'lit' ? w[0].v : null }));
    const isOp = (k: number, ...ops: string[]) => toks[k]?.op !== null && toks[k]?.op !== undefined && ops.includes(toks[k].op!);
    let i = 0;
    const fail = (msg: string): never => {
      throw new DbracketError(msg);
    };
    const orExpr = async (): Promise<boolean> => {
      let v = await andExpr();
      while (isOp(i, '||')) {
        i++;
        if (v) {
          await andExpr(true);
          continue;
        }
        v = await andExpr();
      }
      return v;
    };
    // `skip`: parse without evaluating (the side of && / || that isn't taken)
    let skipping = 0;
    const andExpr = async (skip = false): Promise<boolean> => {
      if (skip) skipping++;
      try {
        let v = await notExpr();
        while (isOp(i, '&&')) {
          i++;
          if (!v) {
            skipping++;
            try {
              await notExpr();
            } finally {
              skipping--;
            }
            continue;
          }
          v = await notExpr();
        }
        return v;
      } finally {
        if (skip) skipping--;
      }
    };
    const notExpr = async (): Promise<boolean> => {
      if (isOp(i, '!')) {
        i++;
        return !(await notExpr());
      }
      if (isOp(i, '(')) {
        i++;
        const v = await orExpr();
        if (!isOp(i, ')')) fail("expected `)'");
        i++;
        return v;
      }
      return primary();
    };
    const str = async (k: number) => (skipping ? '' : this.expandSingle(toks[k].w));
    const arith = async (k: number) => {
      if (skipping) return 0n;
      const e = await str(k);
      try {
        return evalArith(e, (n) => this.getVar(n), (n, val) => this.setVar(n, val));
      } catch (err: any) {
        throw new ShellError(`${e}: ${err.message}`);
      }
    };
    const primary = async (): Promise<boolean> => {
      if (i >= toks.length) fail('unexpected end of expression');
      const bop = toks[i + 1]?.op;
      if (i + 2 < toks.length && bop && (BINARY_OPS.has(bop) || bop === '=~')) {
        const a = i;
        const c = i + 2;
        i += 3;
        if (skipping) return false;
        switch (bop) {
          case '==':
          case '=':
            return matchPattern(await this.expandPattern(toks[c].w), await str(a));
          case '!=':
            return !matchPattern(await this.expandPattern(toks[c].w), await str(a));
          case '=~':
            return this.regexMatch(await str(a), toks[c].w);
          case '<':
            return (await str(a)) < (await str(c));
          case '>':
            return (await str(a)) > (await str(c));
          case '-eq':
            return (await arith(a)) === (await arith(c));
          case '-ne':
            return (await arith(a)) !== (await arith(c));
          case '-lt':
            return (await arith(a)) < (await arith(c));
          case '-le':
            return (await arith(a)) <= (await arith(c));
          case '-gt':
            return (await arith(a)) > (await arith(c));
          case '-ge':
            return (await arith(a)) >= (await arith(c));
          default:
            return builtinTest(this, [await str(a), bop, await str(c)]) === 0;
        }
      }
      const uop = toks[i].op;
      if (uop && UNARY_OPS.has(uop) && i + 1 < toks.length && !isOp(i + 1, '&&', '||', ')')) {
        const a = i + 1;
        i += 2;
        if (skipping) return false;
        return builtinTest(this, [uop, await str(a)]) === 0;
      }
      if (toks[i].op && /^-./.test(toks[i].op!) && i + 1 < toks.length && !isOp(i + 1, '&&', '||', ')')) fail(`unexpected argument \`${toks[i + 1].op ?? '…'}' to conditional unary operator`);
      const k = i++;
      if (i < toks.length && !isOp(i, '&&', '||', ')')) fail('conditional binary operator expected');
      return (await str(k)) !== '';
    };
    try {
      if (!toks.length) fail('unexpected end of expression');
      const v = await orExpr();
      if (i < toks.length) fail(`syntax error near \`${toks[i].op ?? '…'}'`);
      return v ? 0 : 1;
    } catch (e) {
      if (!(e instanceof DbracketError)) throw e;
      this.err(`sh: [[: ${e.message}\n`);
      return 2;
    }
  }

  /**
   * [[ s =~ re ]]: `re` is a POSIX extended regular expression; quoted parts of it match
   * literally. Sets BASH_REMATCH (the match and its groups). An invalid regex gives status 2.
   */
  private async regexMatch(s: string, w: Word): Promise<boolean> {
    const segs = await this.expandSegs(w, false);
    let src = '';
    for (const seg of segs) {
      if ('brk' in seg) src += ' ';
      else src += seg.quoted ? seg.s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') : seg.s;
    }
    let re: RegExp;
    try {
      re = new RegExp(eregToRegexSource(src));
    } catch {
      throw new DbracketError(`invalid regular expression \`${src}'`);
    }
    const m = re.exec(s);
    const groups = m ? [...m].map((g) => g ?? '') : [];
    this.arrays.set('BASH_REMATCH', groups);
    this.vars.set('BASH_REMATCH', groups[0] ?? '');
    return !!m;
  }

  // ---------------------------------------------------------------------------
  // expansion

  async expandWords(words: Word[]): Promise<string[]> {
    const out: string[] = [];
    for (const w of words) {
      for (const f of await this.expandFields(w)) {
        if (f.glob && !this.opts.noglob) {
          const matches = this.glob(f.pat);
          if (matches.length) {
            out.push(...matches);
            continue;
          }
        }
        out.push(f.value);
      }
    }
    return out;
  }

  /** Expansion without field splitting or globbing (assignments, redirect targets). */
  async expandSingle(w: Word, assignment = false): Promise<string> {
    const segs = await this.expandSegs(w, false, assignment);
    let s = '';
    for (const seg of segs) if (!('brk' in seg)) s += seg.s;
      else s += ' ';
    return s;
  }

  /** Expansion into a pattern string (quoted chars escaped). */
  async expandPattern(w: Word): Promise<string> {
    const segs = await this.expandSegs(w, false);
    let s = '';
    for (const seg of segs) {
      if ('brk' in seg) s += ' ';
      else s += seg.quoted ? escapePattern(seg.s) : seg.s;
    }
    return s;
  }

  private async expandFields(w: Word): Promise<Field[]> {
    const segs = await this.expandSegs(w, false);
    const ifs = this.vars.get('IFS') ?? ' \t\n';
    const fields: Field[] = [];
    let cur: Field | null = null;
    const ensure = () => (cur ??= { value: '', pat: '', glob: false });
    const push = () => {
      if (cur) fields.push(cur);
      cur = null;
    };
    let sawQuoted = false;
    for (const seg of segs) {
      if ('brk' in seg) {
        push();
        sawQuoted = false;
        continue;
      }
      if (seg.quoted) {
        const f = ensure();
        f.value += seg.s;
        f.pat += escapePattern(seg.s);
        sawQuoted = true;
        continue;
      }
      if (!seg.split || ifs === '') {
        const f = ensure();
        f.value += seg.s;
        f.pat += seg.s;
        if (hasGlobChars(seg.s)) f.glob = true;
        continue;
      }
      // field splitting
      let i = 0;
      const s = seg.s;
      while (i < s.length) {
        const c = s[i];
        if (ifs.includes(c)) {
          const ws = ' \t\n'.includes(c);
          if (cur) push();
          else if (!ws) fields.push({ value: '', pat: '', glob: false });
          i++;
          continue;
        }
        let j = i;
        while (j < s.length && !ifs.includes(s[j])) j++;
        const part = s.slice(i, j);
        const f = ensure();
        f.value += part;
        f.pat += part;
        if (hasGlobChars(part)) f.glob = true;
        i = j;
      }
    }
    if (cur) push();
    else if (sawQuoted && fields.length === 0) fields.push({ value: '', pat: '', glob: false });
    // an empty quoted string "" yields one empty field
    if (fields.length === 0 && segs.some((s) => !('brk' in s) && s.quoted)) fields.push({ value: '', pat: '', glob: false });
    return fields;
  }

  private async expandSegs(w: Word, inDq: boolean, assignment = false): Promise<Seg[]> {
    const segs: Seg[] = [];
    for (const p of w) await this.expandPart(p, inDq, segs, assignment);
    return segs;
  }

  private async expandPart(p: WordPart, inDq: boolean, segs: Seg[], assignment = false): Promise<void> {
    switch (p.t) {
      case 'lit':
        segs.push({ s: p.v, quoted: inDq, split: false });
        return;
      case 'sq':
        segs.push({ s: p.v, quoted: true, split: false });
        return;
      case 'dq': {
        // "$@" with no positional parameters expands to no word at all (not an empty one)
        const only = p.parts.length === 1 ? p.parts[0] : null;
        if (only?.t === 'param' && only.name === '@' && !only.op && !only.length && this.positional.length === 0) return;
        const before = segs.length;
        for (const q of p.parts) await this.expandPart(q, true, segs);
        if (segs.length === before) segs.push({ s: '', quoted: true, split: false });
        return;
      }
      case 'tilde': {
        const home = p.user ? (p.user === 'root' ? '/root' : `/home/${p.user}`) : (this.vars.get('HOME') ?? '/home/user');
        segs.push({ s: home, quoted: true, split: false });
        return;
      }
      case 'cmd': {
        const s = await this.commandSubst(p.src);
        segs.push({ s, quoted: inDq, split: !inDq && !assignment });
        return;
      }
      case 'arith': {
        const expr = await this.expandSingle(p.expr);
        let v: bigint;
        try {
          v = evalArith(expr, (n) => this.getVar(n), (n, val) => this.setVar(n, val));
        } catch (e: any) {
          throw new ShellError(`${expr}: ${e.message}`);
        }
        segs.push({ s: String(v), quoted: inDq, split: !inDq && !assignment });
        return;
      }
      case 'param':
        await this.expandParam(p, inDq, segs, assignment);
        return;
    }
  }

  private async expandParam(p: Extract<WordPart, { t: 'param' }>, inDq: boolean, segs: Seg[], assignment: boolean) {
    const name = p.name;
    if ((name === '@' || name === '*') && !p.op && !p.length) {
      if (inDq && name === '@') {
        this.positional.forEach((v, i) => {
          if (i > 0) segs.push({ brk: true });
          segs.push({ s: v, quoted: true, split: false });
        });
        return;
      }
      if (inDq) {
        segs.push({ s: this.getVar('*') ?? '', quoted: true, split: false });
        return;
      }
      this.positional.forEach((v, i) => {
        if (i > 0) segs.push({ brk: true });
        segs.push({ s: v, quoted: false, split: true });
      });
      return;
    }
    let val = this.getVar(name);
    if (p.index !== undefined) {
      const arr = this.arrays.get(name);
      const all = p.index === '@' || p.index === '*';
      if (p.length && all) {
        segs.push({ s: String(arr ? arr.length : val === undefined ? 0 : 1), quoted: inDq, split: false });
        return;
      }
      if (arr) val = all ? arr.join(' ') : arr[Number(evalArith(p.index, (n) => this.getVar(n), (n, v) => this.setVar(n, v)))];
      else if (!all && Number(evalArith(p.index, (n) => this.getVar(n), (n, v) => this.setVar(n, v))) !== 0) val = undefined;
    }
    if (p.length) {
      segs.push({ s: String((name === '@' || name === '*' ? this.positional.length : [...(val ?? '')].length)), quoted: inDq, split: false });
      return;
    }
    const op = p.op;
    const unsetOrNull = val === undefined || (op?.startsWith(':') && val === '');
    switch (op) {
      case ':-':
      case '-':
        if (op === ':-' ? unsetOrNull : val === undefined) {
          const segs2 = await this.expandSegs(p.arg ?? [], inDq);
          for (const s of segs2) if (!('brk' in s) && !inDq && !s.quoted) s.split = !assignment;
          segs.push(...segs2);
          return;
        }
        break;
      case ':=':
      case '=':
        if (op === ':=' ? unsetOrNull : val === undefined) {
          val = await this.expandSingle(p.arg ?? []);
          this.setVar(name, val);
        }
        break;
      case ':?':
      case '?':
        if (op === ':?' ? unsetOrNull : val === undefined) {
          const msg = p.arg?.length ? await this.expandSingle(p.arg) : 'parameter null or not set';
          this.expansionError(`${name}: ${msg}`);
        }
        break;
      case ':+':
      case '+':
        if (op === ':+' ? !unsetOrNull : val !== undefined) {
          const segs2 = await this.expandSegs(p.arg ?? [], inDq);
          for (const s of segs2) if (!('brk' in s) && !inDq && !s.quoted) s.split = !assignment;
          segs.push(...segs2);
        }
        return;
      case '#':
      case '##':
      case '%':
      case '%%': {
        const pat = await this.expandPattern(p.arg ?? []);
        val = removeMatch(val ?? '', pat, op);
        break;
      }
      case '/':
      case '//':
      case '/#':
      case '/%': {
        const pat = await this.expandPattern(p.arg ?? []);
        const rep = await this.expandSingle(p.arg2 ?? []);
        val = replaceMatch(val ?? '', pat, rep, op);
        break;
      }
      case '^^':
        val = (val ?? '').toUpperCase();
        break;
      case '^':
        val = (val ?? '').replace(/^./, (c) => c.toUpperCase());
        break;
      case ',,':
        val = (val ?? '').toLowerCase();
        break;
      case ',':
        val = (val ?? '').replace(/^./, (c) => c.toLowerCase());
        break;
      case ':': {
        const s = val ?? '';
        const off = Number(await this.expandSingle(p.arg ?? [])) || 0;
        const start = off < 0 ? Math.max(0, s.length + off) : off;
        if (p.arg2) {
          const len = Number(await this.expandSingle(p.arg2)) || 0;
          val = len < 0 ? s.slice(start, s.length + len) : s.slice(start, start + len);
        } else val = s.slice(start);
        break;
      }
    }
    if (val === undefined) {
      if (this.opts.nounset && !/^[@*#?$!0-]$/.test(name)) this.expansionError(`${name}: unbound variable`);
      val = '';
    }
    segs.push({ s: val, quoted: inDq, split: !inDq && !assignment });
  }

  /**
   * ${p:?msg} or an unset variable under set -u: a non-interactive shell exits (status 1); an
   * interactive one abandons the command line and keeps running.
   */
  private expansionError(msg: string): never {
    if (this.opts.interactive) throw new ShellError(msg);
    this.err(`sh: ${msg}\n`);
    throw new ExitSignal(1);
  }

  private async commandSubst(src: string): Promise<string> {
    const { r, w } = createPipe();
    const sub = this.clone();
    sub.fds.get(1)?.unref();
    sub.fds.set(1, w);
    const reader = (async () => {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const d = await r.read(65536);
        if (d.length === 0) break;
        chunks.push(d);
      }
      return chunks;
    })();
    const code = await Shell.isolated(sub, () => sub.runSource(src, 'sh'));
    const chunks = await reader;
    r.unref();
    this.lastSubstStatus = code;
    this.status = code;
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return dec.decode(buf).replace(/\n+$/, '');
  }

  /** Pathname expansion. `pat` uses backslash escapes for quoted chars. */
  glob(pat: string): string[] {
    const abs = pat.startsWith('/');
    const parts = pat.split('/').filter((x, i) => x !== '' || i === 0);
    let bases: string[] = [abs ? '/' : ''];
    const vfs = this.kernel.vfs;
    for (let i = abs ? 1 : 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '') continue;
      const next: string[] = [];
      if (!hasGlobChars(part)) {
        const lit = unescapePattern(part);
        for (const b of bases) {
          const p = b === '' ? lit : b.endsWith('/') ? b + lit : `${b}/${lit}`;
          if (vfs.tryLookup(this.resolve(p), false)) next.push(p);
        }
      } else if (part === '**') {
        // globstar-ish: match any depth of directories
        for (const b of bases) {
          const walk = (dir: string, rel: string) => {
            next.push(rel);
            let names: string[];
            try {
              names = vfs.readdir(this.resolve(dir || '.'));
            } catch {
              return;
            }
            for (const n of names.sort()) {
              if (n.startsWith('.')) continue;
              const full = dir === '' ? n : dir.endsWith('/') ? dir + n : `${dir}/${n}`;
              const node = vfs.tryLookup(this.resolve(full));
              if (node && isDir(node)) walk(full, full);
            }
          };
          walk(b, b);
        }
      } else {
        const re = new RegExp(`^${patternToRegexSource(part, { pathname: true })}$`);
        for (const b of bases) {
          let names: string[];
          try {
            names = vfs.readdir(this.resolve(b || '.'));
          } catch {
            continue;
          }
          for (const n of names.sort()) {
            if (n.startsWith('.') && !part.startsWith('.') && !part.startsWith('\\.')) continue;
            if (!re.test(n)) continue;
            const p = b === '' ? n : b.endsWith('/') ? b + n : `${b}/${n}`;
            if (i < parts.length - 1) {
              const node = vfs.tryLookup(this.resolve(p));
              if (!node || !isDir(node)) continue;
            }
            next.push(p);
          }
        }
      }
      bases = next;
      if (!bases.length) break;
    }
    // a trailing slash matches directories only (and symlinks to them)
    if (pat.endsWith('/')) {
      bases = bases
        .filter((b) => {
          const node = vfs.tryLookup(this.resolve(b));
          return !!node && isDir(node);
        })
        .map((b) => (b.endsWith('/') ? b : b + '/'));
    }
    return bases.filter((b) => b !== '' && b !== '/').sort();
  }

  // ---------------------------------------------------------------------------
  // interactive mode

  prompt(): string {
    const ps1 = this.vars.get('PS1');
    if (ps1 !== undefined) return ps1.replace(/\\w/g, this.prettyCwd()).replace(/\\u/g, 'user').replace(/\\h/g, this.kernel.hostname).replace(/\\\$/g, '$');
    return `\x1b[1;32muser@${this.kernel.hostname}\x1b[0m:\x1b[1;34m${this.prettyCwd()}\x1b[0m$ `;
  }

  prettyCwd() {
    const home = this.vars.get('HOME') ?? '/home/user';
    if (this.cwd === home) return '~';
    if (this.cwd.startsWith(home + '/')) return '~' + this.cwd.slice(home.length);
    return this.cwd;
  }

  async interactive(): Promise<number> {
    this.opts.interactive = true;
    const proc = this.ctx.proc;
    this.installSignalHandler();
    const tty = proc.fds.get(0)?.opts.tty;
    if (tty) tty.foregroundPgid = proc.pgid;
    let buffer = '';
    for (;;) {
      const line = await this.readLine(buffer ? '> ' : this.prompt());
      if (line === null) {
        if (buffer) {
          buffer = '';
          continue;
        }
        this.out('exit\n');
        return this.status;
      }
      const src = buffer ? buffer + '\n' + line : line;
      try {
        parse(src);
      } catch (e: any) {
        if (e instanceof ShellSyntaxError && e.incomplete) {
          buffer = src;
          continue;
        }
      }
      buffer = '';
      if (!src.trim()) continue;
      if (this.history[this.history.length - 1] !== src) this.history.push(src);
      this.interrupted = false;
      try {
        this.status = await this.runSource(src);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        if (e instanceof BreakSig || e instanceof ContinueSig || e instanceof ReturnSig) continue;
        if (e instanceof InterruptSig) {
          this.status = 130;
          continue;
        }
        if (e instanceof ShellError) {
          this.err(`sh: ${e.message}\n`);
          this.status = e.code;
          continue;
        }
        this.err(`sh: ${(e as Error)?.message ?? e}\n`);
        this.status = 1;
      }
    }
  }
  interrupted = false;

  /** Line editor (raw mode on a tty; plain read otherwise). */
  async readLine(prompt: string): Promise<string | null> {
    const f = this.fds.get(0);
    const tty = f?.opts.tty;
    if (!tty) {
      this.err(prompt);
      return this.readPlainLine();
    }
    tty.raw = true;
    tty.echo = false;
    this.err(prompt);
    let buf: string[] = [];
    let cursor = 0;
    let hist = this.history.length;
    let saved = '';
    const redraw = () => {
      const s = buf.join('');
      this.err(`\r\x1b[K${prompt}${s}`);
      const back = buf.length - cursor;
      if (back > 0) this.err(`\x1b[${back}D`);
    };
    let pending = '';
    try {
      for (;;) {
        const d = await f!.read(4096);
        if (d.length === 0) return null;
        let s = pending + dec.decode(d, { stream: true });
        pending = '';
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          const code = c.charCodeAt(0);
          if (c === '\x1b') {
            const rest = s.slice(i);
            const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|[bf])/.exec(rest);
            if (!m) {
              if (rest.length < 4) {
                pending = rest;
                break;
              }
              continue;
            }
            i += m[0].length - 1;
            const seq = m[1];
            if (seq === '[A' || seq === 'OA') {
              if (hist > 0) {
                if (hist === this.history.length) saved = buf.join('');
                hist--;
                buf = [...this.history[hist]];
                cursor = buf.length;
                redraw();
              }
            } else if (seq === '[B' || seq === 'OB') {
              if (hist < this.history.length) {
                hist++;
                buf = [...(hist === this.history.length ? saved : this.history[hist])];
                cursor = buf.length;
                redraw();
              }
            } else if (seq === '[C' || seq === 'OC') {
              if (cursor < buf.length) {
                cursor++;
                this.err('\x1b[C');
              }
            } else if (seq === '[D' || seq === 'OD') {
              if (cursor > 0) {
                cursor--;
                this.err('\x1b[D');
              }
            } else if (seq === '[H' || seq === 'OH' || seq === '[1~') {
              cursor = 0;
              redraw();
            } else if (seq === '[F' || seq === 'OF' || seq === '[4~') {
              cursor = buf.length;
              redraw();
            } else if (seq === '[3~') {
              if (cursor < buf.length) {
                buf.splice(cursor, 1);
                redraw();
              }
            } else if (seq === 'b' || seq === '[1;5D') {
              while (cursor > 0 && buf[cursor - 1] === ' ') cursor--;
              while (cursor > 0 && buf[cursor - 1] !== ' ') cursor--;
              redraw();
            } else if (seq === 'f' || seq === '[1;5C') {
              while (cursor < buf.length && buf[cursor] === ' ') cursor++;
              while (cursor < buf.length && buf[cursor] !== ' ') cursor++;
              redraw();
            }
            continue;
          }
          if (c === '\r' || c === '\n') {
            this.err('\r\n');
            return buf.join('');
          }
          if (code === 3) {
            this.err('^C\r\n');
            this.status = 130;
            buf = [];
            cursor = 0;
            hist = this.history.length;
            this.err(prompt);
            continue;
          }
          if (code === 4) {
            if (buf.length === 0) {
              this.err('\r\n');
              return null;
            }
            if (cursor < buf.length) {
              buf.splice(cursor, 1);
              redraw();
            }
            continue;
          }
          if (code === 127 || code === 8) {
            if (cursor > 0) {
              buf.splice(cursor - 1, 1);
              cursor--;
              redraw();
            }
            continue;
          }
          if (code === 1) {
            cursor = 0;
            redraw();
            continue;
          }
          if (code === 5) {
            cursor = buf.length;
            redraw();
            continue;
          }
          if (code === 11) {
            buf.length = cursor;
            redraw();
            continue;
          }
          if (code === 21) {
            buf.splice(0, cursor);
            cursor = 0;
            redraw();
            continue;
          }
          if (code === 23) {
            let j = cursor;
            while (j > 0 && buf[j - 1] === ' ') j--;
            while (j > 0 && buf[j - 1] !== ' ') j--;
            buf.splice(j, cursor - j);
            cursor = j;
            redraw();
            continue;
          }
          if (code === 12) {
            this.err('\x1b[H\x1b[2J');
            redraw();
            continue;
          }
          if (code === 9) {
            const res = this.complete(buf.slice(0, cursor).join(''));
            if (res.insert) {
              buf.splice(cursor, 0, ...res.insert);
              cursor += [...res.insert].length;
              redraw();
            } else if (res.options.length > 1) {
              this.err('\r\n' + res.options.join('  ') + '\r\n');
              redraw();
            }
            continue;
          }
          if (code < 32) continue;
          buf.splice(cursor, 0, c);
          cursor++;
          if (cursor === buf.length) this.err(c);
          else redraw();
        }
      }
    } finally {
      tty.raw = false;
      tty.echo = true;
    }
  }

  private lineBuf = '';
  private async readPlainLine(): Promise<string | null> {
    for (;;) {
      const nl = this.lineBuf.indexOf('\n');
      if (nl !== -1) {
        const line = this.lineBuf.slice(0, nl);
        this.lineBuf = this.lineBuf.slice(nl + 1);
        return line;
      }
      const d = await this.readFd(0);
      if (!d) {
        if (this.lineBuf) {
          const l = this.lineBuf;
          this.lineBuf = '';
          return l;
        }
        return null;
      }
      this.lineBuf += dec.decode(d);
    }
  }

  /** Tab completion: commands for the first word, paths otherwise. */
  private complete(before: string): { insert: string; options: string[] } {
    const m = /(\S*)$/.exec(before)!;
    const word = m[1];
    const isFirst = before.slice(0, before.length - word.length).trim() === '';
    let candidates: string[] = [];
    const vfs = this.kernel.vfs;
    if (isFirst && !word.includes('/')) {
      const set = new Set<string>([...Object.keys(BUILTINS), ...this.funcs.keys()]);
      for (const dir of (this.vars.get('PATH') ?? '').split(':')) {
        try {
          for (const n of vfs.readdir(dir)) set.add(n);
        } catch {}
      }
      candidates = [...set].filter((n) => n.startsWith(word)).sort();
    } else {
      const slash = word.lastIndexOf('/');
      const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
      const base = word.slice(slash + 1);
      const dirAbs = this.resolve((dirPart || '.').replace(/^~(?=\/|$)/, this.vars.get('HOME') ?? '/home/user'));
      try {
        for (const n of vfs.readdir(dirAbs)) {
          if (!n.startsWith(base)) continue;
          if (n.startsWith('.') && !base.startsWith('.')) continue;
          const node = vfs.tryLookup(`${dirAbs}/${n}`);
          candidates.push(dirPart + n + (node && isDir(node) ? '/' : ''));
        }
      } catch {}
      candidates.sort();
    }
    if (candidates.length === 0) return { insert: '', options: [] };
    if (candidates.length === 1) {
      const c = candidates[0];
      return { insert: c.slice(word.length) + (c.endsWith('/') ? '' : ' '), options: candidates };
    }
    let prefix = candidates[0];
    for (const c of candidates) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
    return { insert: prefix.slice(word.length), options: candidates.map((c) => c.replace(/^.*\/(?=.)/, '')) };
  }
}

export class ShellError extends Error {
  constructor(msg: string, public code = 1) {
    super(msg);
  }
}

/** A malformed [[ ]] expression (status 2). */
class DbracketError extends Error {}

function escapePattern(s: string) {
  return s.replace(/[\\*?[\]]/g, (c) => '\\' + c);
}

function quoteForTrace(s: string) {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// -----------------------------------------------------------------------------
// builtins

const SPECIAL_BUILTINS = new Set([':', '.', 'break', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set', 'shift', 'trap', 'unset', 'source']);

export const BUILTINS: Record<string, ShellBuiltin> = {
  ':': () => 0,
  true: () => 0,
  false: () => 1,
  cd(sh, args) {
    let target = args[0];
    if (target === '-L' || target === '-P') target = args[1];
    if (target === undefined) target = sh.getVar('HOME') ?? '/';
    else if (target === '-') {
      target = sh.getVar('OLDPWD') ?? sh.cwd;
      sh.out(target + '\n');
    }
    let dir = sh.resolve(target);
    if (!target.startsWith('/') && !target.startsWith('.') && sh.getVar('CDPATH')) {
      for (const base of sh.getVar('CDPATH')!.split(':')) {
        const cand = path.resolve(sh.cwd, base || '.', target);
        const n = sh.kernel.vfs.tryLookup(cand);
        if (n && isDir(n)) {
          dir = cand;
          break;
        }
      }
    }
    const node = sh.kernel.vfs.tryLookup(dir);
    if (!node) throw new ShellError(`${target}: No such file or directory`);
    if (!isDir(node)) throw new ShellError(`${target}: Not a directory`);
    sh.setVar('OLDPWD', sh.cwd, true);
    sh.cwd = dir;
    sh.vars.set('PWD', dir);
    // an in-process subshell must not move its parent's process
    if (sh.ownsProc) sh.ctx.proc.cwd = dir;
    return 0;
  },
  pwd(sh) {
    sh.out(sh.cwd + '\n');
    return 0;
  },
  export(sh, args) {
    if (args.length === 0 || args[0] === '-p') {
      for (const k of [...sh.exported].sort()) {
        const v = sh.vars.get(k);
        if (v !== undefined) sh.out(`export ${k}='${v.replace(/'/g, "'\\''")}'\n`);
      }
      return 0;
    }
    for (const a of args) {
      if (a === '-n') continue;
      const eq = a.indexOf('=');
      if (eq > 0) sh.setVar(a.slice(0, eq), a.slice(eq + 1), true);
      else if (isName(a)) sh.exported.add(a);
      else throw new ShellError(`\`${a}': not a valid identifier`);
    }
    return 0;
  },
  readonly(sh, args) {
    for (const a of args) {
      if (a === '-p') continue;
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (eq > 0) sh.setVar(name, a.slice(eq + 1));
      sh.readonlyVars.add(name);
    }
    return 0;
  },
  unset(sh, args) {
    let funcs = false;
    for (const a of args) {
      if (a === '-f') {
        funcs = true;
        continue;
      }
      if (a === '-v') continue;
      if (funcs) sh.funcs.delete(a);
      else sh.unsetVar(a);
    }
    return 0;
  },
  set(sh, args) {
    if (args.length === 0) {
      for (const [k, v] of [...sh.vars].sort()) sh.out(`${k}='${v.replace(/'/g, "'\\''")}'\n`);
      return 0;
    }
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        i++;
        sh.positional = args.slice(i);
        return 0;
      }
      if (/^[-+][a-zA-Z]+$/.test(a)) {
        const on = a[0] === '-';
        for (const c of a.slice(1)) {
          if (c === 'e') sh.opts.errexit = on;
          else if (c === 'x') sh.opts.xtrace = on;
          else if (c === 'u') sh.opts.nounset = on;
          else if (c === 'f') sh.opts.noglob = on;
          else if (c === 'a') sh.opts_allexport = on;
          else if (c === 'o') {
            // -o name (also inside a group: set -euo pipefail)
            const name = args[++i];
            if (name === undefined) {
              for (const n of ['allexport', 'errexit', 'noglob', 'nounset', 'pipefail', 'xtrace']) sh.out(`${n.padEnd(15)}\t${sh.optionIsSet(n) ? 'on' : 'off'}\n`);
              continue;
            }
            if (name === 'pipefail') sh.opts.pipefail = on;
            else if (name === 'errexit') sh.opts.errexit = on;
            else if (name === 'nounset') sh.opts.nounset = on;
            else if (name === 'xtrace') sh.opts.xtrace = on;
            else if (name === 'noglob') sh.opts.noglob = on;
            else if (name === 'allexport') sh.opts_allexport = on;
          }
        }
        continue;
      }
      sh.positional = args.slice(i);
      return 0;
    }
    return 0;
  },
  shift(sh, args) {
    const n = args[0] ? Number(args[0]) : 1;
    if (n > sh.positional.length) return 1;
    sh.positional = sh.positional.slice(n);
    return 0;
  },
  exit(sh, args) {
    throw new ExitSignal(args[0] !== undefined ? Number(args[0]) & 255 : sh.status);
  },
  return(sh, args) {
    throw new ReturnSig(args[0] !== undefined ? Number(args[0]) & 255 : sh.status);
  },
  break(_sh, args) {
    throw new BreakSig(args[0] ? Number(args[0]) : 1);
  },
  continue(_sh, args) {
    throw new ContinueSig(args[0] ? Number(args[0]) : 1);
  },
  echo(sh, args) {
    let newline = true;
    let escapes = false;
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (!/^-[neE]+$/.test(a)) break;
      for (const c of a.slice(1)) {
        if (c === 'n') newline = false;
        else if (c === 'e') escapes = true;
        else if (c === 'E') escapes = false;
      }
    }
    let s = args.slice(i).join(' ');
    if (escapes) {
      const cut = s.indexOf('\\c');
      if (cut !== -1) {
        s = s.slice(0, cut);
        newline = false;
      }
      s = s.replace(/\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|[abefnrtv\\])/g, (_m, e: string) => {
        if (e[0] === '0') return String.fromCharCode(parseInt(e.slice(1) || '0', 8));
        if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
        return ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' } as Record<string, string>)[e];
      });
    }
    sh.out(s + (newline ? '\n' : ''));
    return 0;
  },
  printf(sh, args) {
    if (args.length === 0) throw new ShellError('usage: printf format [arguments]', 2);
    let varName: string | undefined;
    if (args[0] === '-v') {
      varName = args[1];
      args = args.slice(2);
    }
    const out = formatPrintf(args[0], args.slice(1));
    if (varName) sh.setVar(varName, out);
    else sh.out(out);
    return 0;
  },
  test: (sh, args) => builtinTest(sh, args),
  '[': (sh, args) => {
    if (args[args.length - 1] !== ']') {
      sh.err('sh: [: missing `]\'\n');
      return 2;
    }
    return builtinTest(sh, args.slice(0, -1));
  },
  '((': (sh, args) => {
    const expr = args.join(' ');
    try {
      const v = evalArith(expr, (n) => sh.getVar(n), (n, val) => sh.setVar(n, val));
      return v !== 0n ? 0 : 1;
    } catch (e: any) {
      if (e instanceof ShellError) throw e;
      sh.err(`sh: ((: ${expr}: ${e.message}\n`);
      return 1;
    }
  },
  let(sh, args) {
    if (!args.length) throw new ShellError('expression expected');
    let v = 0n;
    for (const a of args) {
      try {
        v = evalArith(a, (n) => sh.getVar(n), (n, val) => sh.setVar(n, val));
      } catch (e: any) {
        if (e instanceof ShellError) throw e;
        throw new ShellError(`${a}: ${e.message}`);
      }
    }
    return v !== 0n ? 0 : 1;
  },
  async read(sh, args) {
    let raw = false;
    let prompt = '';
    let delim = '\n';
    let nchars = -1;
    let silent = false;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-r') raw = true;
      else if (a === '-p') prompt = args[++i];
      else if (a === '-d') delim = args[++i] || '\0';
      else if (a === '-n' || a === '-N') nchars = Number(args[++i]);
      else if (a === '-s') silent = true;
      else if (a === '-t' || a === '-u' || a === '-a') i++;
      else names.push(a);
    }
    void silent;
    if (prompt) sh.err(prompt);
    let line = '';
    let gotAny = false;
    const f = sh.fds.get(0);
    if (!f) return 1;
    let eof = false;
    for (;;) {
      const d = await f.read(1);
      if (d.length === 0) {
        eof = true;
        break;
      }
      gotAny = true;
      const c = String.fromCharCode(d[0]);
      if (c === delim) break;
      if (!raw && c === '\\') {
        const n = await f.read(1);
        if (n.length && n[0] !== 10) line += String.fromCharCode(n[0]);
        continue;
      }
      line += c;
      if (nchars > 0 && line.length >= nchars) break;
    }
    line = new TextDecoder().decode(Uint8Array.from(line, (c) => c.charCodeAt(0)));
    if (names.length === 0) names.push('REPLY');
    const ifs = sh.vars.get('IFS') ?? ' \t\n';
    if (names.length === 1) {
      sh.setVar(names[0], names[0] === 'REPLY' ? line : trimIfs(line, ifs));
    } else {
      let rest = trimIfs(line, ifs);
      for (let i = 0; i < names.length; i++) {
        if (i === names.length - 1) {
          sh.setVar(names[i], rest);
          break;
        }
        const m = new RegExp(`^([^${escapeClass(ifs)}]*)[${escapeClass(ifs)}]*`).exec(rest)!;
        sh.setVar(names[i], m[1]);
        rest = rest.slice(m[0].length);
      }
    }
    return eof && !gotAny ? 1 : eof && line === '' ? 1 : 0;
  },
  async source(sh, args) {
    if (!args[0]) throw new ShellError('filename argument required', 2);
    let file = args[0];
    if (!file.includes('/')) {
      const found = sh.kernel.which(file, { PATH: sh.getVar('PATH') ?? '' }, sh.cwd);
      file = found ?? file;
    }
    let src: string;
    try {
      src = dec.decode(sh.kernel.vfs.readFile(sh.resolve(file)));
    } catch {
      throw new ShellError(`${args[0]}: No such file or directory`);
    }
    const saved = sh.positional;
    if (args.length > 1) sh.positional = args.slice(1);
    try {
      return await sh.runSource(src, args[0]);
    } catch (e) {
      // `return` at the top of a sourced file ends the file
      if (e instanceof ReturnSig) return e.code;
      throw e;
    } finally {
      if (args.length > 1) sh.positional = saved;
    }
  },
  async eval(sh, args) {
    return sh.runSource(args.join(' '));
  },
  async exec(sh, args) {
    // exec cmd: run and exit with its status
    const code = await sh.runSource(args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' '));
    throw new ExitSignal(code);
  },
  alias(sh, args) {
    if (!args.length) {
      for (const [k, v] of sh.aliases) sh.out(`alias ${k}='${v}'\n`);
      return 0;
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq > 0) sh.aliases.set(a.slice(0, eq), a.slice(eq + 1));
      else if (sh.aliases.has(a)) sh.out(`alias ${a}='${sh.aliases.get(a)}'\n`);
    }
    return 0;
  },
  unalias(sh, args) {
    for (const a of args) sh.aliases.delete(a);
    return 0;
  },
  type(sh, args) {
    let st = 0;
    for (const a of args) {
      if (a.startsWith('-')) continue;
      if (sh.funcs.has(a)) sh.out(`${a} is a function\n`);
      else if (sh.aliases.has(a)) sh.out(`${a} is aliased to \`${sh.aliases.get(a)}'\n`);
      else if (BUILTINS[a]) sh.out(`${a} is a shell builtin\n`);
      else {
        const p = sh.kernel.which(a, { PATH: sh.getVar('PATH') ?? '' }, sh.cwd);
        if (p) sh.out(`${a} is ${p}\n`);
        else {
          sh.err(`sh: type: ${a}: not found\n`);
          st = 1;
        }
      }
    }
    return st;
  },
  async command(sh, args) {
    if (args[0] === '-v' || args[0] === '-V') {
      let st = 0;
      for (const a of args.slice(1)) {
        if (BUILTINS[a] || sh.funcs.has(a)) sh.out(a + '\n');
        else {
          const p = sh.kernel.which(a, { PATH: sh.getVar('PATH') ?? '' }, sh.cwd);
          if (p) sh.out(p + '\n');
          else st = 1;
        }
      }
      return st;
    }
    if (!args.length) return 0;
    // run bypassing functions
    const saved = sh.funcs;
    sh.funcs = new Map();
    try {
      return await sh.runSource(args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' '));
    } finally {
      sh.funcs = saved;
    }
  },
  hash: () => 0,
  builtin: async (sh, args) => {
    const b = BUILTINS[args[0]];
    if (!b) return 1;
    return b(sh, args.slice(1));
  },
  async wait(sh, args) {
    // a trapped signal interrupts the wait: it returns 128+n and the trap runs
    const interrupted: unique symbol = Symbol();
    const untilTrap = async <T>(p: Promise<T>): Promise<T | typeof interrupted> => {
      if (!sh.ownsProc) return p;
      return Promise.race([p, sh.waitForTrap().then((): typeof interrupted => interrupted)]);
    };
    const statusOfTrap = () => 128 + (SIGNALS['SIG' + (sh.pendingTrapSignal() ?? 'TERM')] ?? 15);
    if (args.length) {
      let st = 0;
      for (const a of args) {
        const pid = a === '%%' || a === '%+' || a === '%' ? sh.lastBg : Number(a);
        const j = sh.bgJobs.get(pid);
        if (!j) {
          sh.err(`sh: wait: pid ${a} is not a child of this shell\n`);
          st = 127;
          continue;
        }
        const r = await untilTrap(j);
        if (r === interrupted) return statusOfTrap();
        st = r;
        sh.bgJobs.delete(pid);
      }
      return st;
    }
    const r = await untilTrap(Promise.all(sh.bgJobs.values()));
    if (r === interrupted) return statusOfTrap();
    sh.bgJobs.clear();
    return 0;
  },
  trap(sh, args) {
    const signalSpec = (s: string): string | null => {
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (n === 0) return 'EXIT';
        const name = Object.keys(SIGNALS).find((k) => SIGNALS[k] === n);
        return name ? name.slice(3) : null;
      }
      const u = s.toUpperCase().replace(/^SIG/, '');
      if (u === 'EXIT' || u === 'ERR' || u === 'DEBUG' || u === 'RETURN') return u;
      return SIGNALS['SIG' + u] !== undefined ? u : null;
    };
    const show = (name: string) => {
      const v = sh.traps.get(name);
      if (v !== undefined) sh.out(`trap -- '${v.replace(/'/g, "'\\''")}' ${name === 'EXIT' || name === 'ERR' || name === 'DEBUG' || name === 'RETURN' ? name : 'SIG' + name}\n`);
    };
    if (args[0] === '--') args = args.slice(1);
    if (args[0] === '-l') {
      sh.out(Object.entries(SIGNALS).map(([k, v]) => `${String(v).padStart(2)}) ${k}`).join('\n') + '\n');
      return 0;
    }
    if (args.length === 0 || args[0] === '-p') {
      const names = args.length > 1 ? args.slice(1).map(signalSpec) : [...sh.traps.keys()];
      for (const n of names) if (n) show(n);
      return 0;
    }
    // `trap SIG…` (the first operand a signal number) or `trap - SIG…` resets them
    let action: string | null = args[0];
    let sigs = args.slice(1);
    if (action === '-' || (args.length === 1 && signalSpec(action) !== null) || /^\d+$/.test(action)) {
      if (action !== '-') sigs = args;
      action = null;
    }
    let st = 0;
    for (const s of sigs) {
      const name = signalSpec(s);
      if (!name || name === 'KILL' || name === 'STOP') {
        sh.err(`sh: trap: ${s}: invalid signal specification\n`);
        st = 1;
        continue;
      }
      if (action === null) sh.traps.delete(name);
      else sh.traps.set(name, action);
    }
    return st;
  },
  local(sh, args) {
    const scope = sh.locals[sh.locals.length - 1];
    for (const a of args) {
      if (a.startsWith('-')) continue;
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (scope && !scope.has(name)) scope.set(name, sh.vars.get(name));
      if (eq > 0) sh.setVar(name, a.slice(eq + 1));
      else if (!sh.vars.has(name)) sh.setVar(name, '');
    }
    return 0;
  },
  declare(sh, args) {
    const exp = args.includes('-x');
    for (const a of args) {
      if (a.startsWith('-')) continue;
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const scope = sh.locals[sh.locals.length - 1];
      if (scope && !scope.has(name)) scope.set(name, sh.vars.get(name));
      if (eq > 0) sh.setVar(name, a.slice(eq + 1), exp);
      else if (exp) sh.exported.add(name);
    }
    return 0;
  },
  ulimit(sh, args) {
    // only -n (open files) has an effect: it bounds how many worker threads a process can start
    let i = 0;
    let which = 'f';
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-a') {
        sh.out(`open files                          (-n) ${sh.ctx.proc.nofile}\n`);
        return 0;
      }
      which = args[i].slice(-1);
      i++;
    }
    const value = args[i];
    if (value === undefined) {
      sh.out((which === 'n' ? String(sh.ctx.proc.nofile) : 'unlimited') + '\n');
      return 0;
    }
    if (which === 'n') {
      const n = value === 'unlimited' ? 1024 * 1024 : Number(value);
      if (!Number.isInteger(n) || n < 0) throw new ShellError(`ulimit: ${value}: invalid number`);
      sh.ctx.proc.nofile = n;
    }
    return 0;
  },
  umask(sh, args) {
    let symbolic = false;
    let reusable = false;
    while (args[0]?.startsWith('-') && args[0].length > 1) {
      const a = args.shift()!;
      if (a === '--') break;
      for (const c of a.slice(1)) {
        if (c === 'S') symbolic = true;
        else if (c === 'p') reusable = true;
        else throw new ShellError(`${a}: invalid option`, 2);
      }
    }
    const mask = sh.umask;
    if (!args.length) {
      const v = symbolic ? symbolicUmask(mask) : mask.toString(8).padStart(4, '0');
      sh.out((reusable ? `umask ${symbolic ? '-S ' : ''}` : '') + v + '\n');
      return 0;
    }
    const spec = args[0];
    if (/^[0-7]+$/.test(spec)) {
      sh.setUmask(parseInt(spec, 8) & 0o777);
      return 0;
    }
    // symbolic: the operations act on the permissions the mask leaves
    const allowed = applySymbolicMode(~mask & 0o777, spec, { umask: 0 });
    if (allowed === null) throw new ShellError(`${spec}: invalid symbolic mode operator`);
    sh.setUmask(~allowed & 0o777);
    return 0;
  },
  getopts(sh, args) {
    const [spec, name, ...rest] = args;
    const argv = rest.length ? rest : sh.positional;
    let ind = Number(sh.getVar('OPTIND') ?? '1');
    const sub = Number(sh.vars.get('__OV_OPTSUB') ?? '1');
    const arg = argv[ind - 1];
    if (!arg || arg === '--' || !arg.startsWith('-') || arg === '-') {
      if (arg === '--') sh.setVar('OPTIND', String(ind + 1));
      sh.setVar(name, '?');
      return 1;
    }
    const c = arg[sub];
    const k = spec.indexOf(c);
    let nextSub = sub + 1;
    if (k === -1) {
      sh.setVar(name, '?');
    } else {
      sh.setVar(name, c);
      if (spec[k + 1] === ':') {
        if (arg.length > sub + 1) sh.setVar('OPTARG', arg.slice(sub + 1));
        else {
          sh.setVar('OPTARG', argv[ind] ?? '');
          ind++;
        }
        nextSub = arg.length;
      }
    }
    if (nextSub >= arg.length) {
      ind++;
      nextSub = 1;
    }
    sh.setVar('OPTIND', String(ind));
    sh.vars.set('__OV_OPTSUB', String(nextSub));
    return 0;
  },
  jobs: () => 0,
  times: () => 0,
  pushd(sh, args) {
    const stack = (sh.vars.get('__OV_DIRSTACK') ?? '').split('\n').filter(Boolean);
    stack.push(sh.cwd);
    sh.vars.set('__OV_DIRSTACK', stack.join('\n'));
    return BUILTINS.cd(sh, args);
  },
  popd(sh) {
    const stack = (sh.vars.get('__OV_DIRSTACK') ?? '').split('\n').filter(Boolean);
    const d = stack.pop();
    sh.vars.set('__OV_DIRSTACK', stack.join('\n'));
    if (!d) return 1;
    return BUILTINS.cd(sh, [d]);
  },
  history(sh) {
    sh.history.forEach((h, i) => sh.out(`${String(i + 1).padStart(5)}  ${h}\n`));
    return 0;
  },
};
BUILTINS['.'] = BUILTINS.source;
BUILTINS.typeset = BUILTINS.declare;

function trimIfs(s: string, ifs: string) {
  const ws = [...ifs].filter((c) => ' \t\n'.includes(c)).join('');
  if (!ws) return s;
  const re = new RegExp(`^[${escapeClass(ws)}]+|[${escapeClass(ws)}]+$`, 'g');
  return s.replace(re, '');
}

function escapeClass(s: string) {
  return s.replace(/[\\\]^-]/g, '\\$&').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

// -----------------------------------------------------------------------------
// the `sh` program

export async function shProgram(ctx: ProgramContext): Promise<number> {
  // the process of a background job: run the job in the copy of the shell that started it
  const job = pendingJobs.get(ctx.proc);
  if (job) {
    pendingJobs.delete(ctx.proc);
    return job(ctx);
  }
  const sh = new Shell(ctx);
  sh.ownsProc = true;
  const args = ctx.argv.slice(1);
  let readCommand = false;
  let interactive = false;
  let i = 0;
  // options may be grouped (sh -ec '…', sh -eo pipefail script); with -c the command string is
  // the first operand after the options, then $0 and the positional parameters
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      if (['--login', '--norc', '--noprofile', '--posix', '--noediting'].includes(a)) continue;
      if (a === '--rcfile' || a === '--init-file') {
        i++;
        continue;
      }
      ctx.err(`sh: ${a}: invalid option\n`);
      return 2;
    }
    if (!/^[-+]./.test(a)) break;
    const on = a[0] === '-';
    for (const c of a.slice(1)) {
      if (c === 'c' && on) readCommand = true;
      else if (c === 'i' && on) interactive = true;
      else if (c === 's' || c === 'l') {
        // read from stdin (the default without operands) / login shell
      } else if (c === 'o') await BUILTINS.set(sh, [`${a[0]}o`, args[++i] ?? '']);
      else if ('euxfavnhmbCBHPTE'.includes(c)) await BUILTINS.set(sh, [a[0] + c]);
      else {
        ctx.err(`sh: ${a[0]}${c}: invalid option\n`);
        return 2;
      }
    }
  }
  const rest = args.slice(i);
  sh.installSignalHandler();
  let code: number;
  try {
    code = await runMain();
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else if (e instanceof ShellError) {
      sh.err(`sh: ${e.message}\n`);
      code = e.code;
    } else if (e instanceof ReturnSig) code = e.code;
    else if (e instanceof BreakSig || e instanceof ContinueSig || e instanceof InterruptSig) code = sh.status;
    else {
      sh.releaseFds();
      throw e;
    }
  }
  try {
    return await sh.runExitTrap(code);
  } finally {
    sh.releaseFds();
  }

  async function runMain(): Promise<number> {
    if (readCommand) {
      if (!rest.length) {
        ctx.err('sh: -c: option requires an argument\n');
        return 2;
      }
      sh.arg0 = rest[1] ?? ctx.argv[0];
      sh.positional = rest.slice(2);
      return await sh.runSource(rest[0]);
    }
    if (rest.length > 0) {
      const file = rest[0];
      let src: string;
      try {
        src = dec.decode(ctx.vfs.readFile(sh.resolve(file)));
      } catch {
        ctx.err(`sh: ${file}: No such file or directory\n`);
        return 127;
      }
      if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
      sh.arg0 = file;
      sh.positional = rest.slice(1);
      return await sh.runSource(src, file);
    }
    if (interactive || ctx.isatty(0)) {
      try {
        const rc = dec.decode(ctx.vfs.readFile((sh.getVar('HOME') ?? '/home/user') + '/.shrc'));
        await sh.runSource(rc);
      } catch {}
      return await sh.interactive();
    }
    const src = await ctx.readAllText(0);
    return await sh.runSource(src);
  }
}

void ProgramContext;
