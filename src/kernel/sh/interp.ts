// Shell interpreter.

import * as path from '../../shared/path.ts';
import { O_APPEND, O_CREAT, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY, type OpenFile, createPipe } from '../io.ts';
import { ExitSignal, type Kernel, ProgramContext } from '../kernel.ts';
import { exitCodeOf } from '../proc.ts';
import { isDir } from '../vfs.ts';
import { evalArith } from './arith.ts';
import { type Node, type Redir, type Word, type WordPart, ShellSyntaxError, isName, parse } from './parse.ts';
import { hasGlobChars, matchPattern, patternToRegexSource, removeMatch, replaceMatch, unescapePattern } from './pattern.ts';
import { builtinTest } from './test.ts';
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
  lastBg = 0;
  bgJobs = new Map<number, Promise<number>>();
  opts: ShellOptions = { errexit: false, xtrace: false, nounset: false, pipefail: false, noglob: false, interactive: false };
  fds = new Map<number, OpenFile>();
  locals: Map<string, string | undefined>[] = [];
  traps = new Map<string, string>();
  cwd: string;
  depth = 0;
  /** errexit suppressed (inside conditions). */
  private noErrexit = 0;
  history: string[] = [];

  constructor(public ctx: ProgramContext) {
    this.cwd = ctx.cwd;
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
    const s: Shell = Object.create(Shell.prototype);
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
    s.traps = new Map();
    s.cwd = this.cwd;
    s.depth = this.depth;
    s.noErrexit = this.noErrexit;
    s.history = [];
    return s;
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
        return String(this.ctx.proc.pid);
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

  async runSource(src: string, name = this.arg0): Promise<number> {
    let ast: Node;
    try {
      ast = parse(src);
    } catch (e: any) {
      this.err(`${name}: ${e.message}\n`);
      return 2;
    }
    try {
      return await this.exec(ast);
    } catch (e) {
      if (e instanceof ReturnSig) return e.code;
      throw e;
    }
  }

  async exec(node: Node): Promise<number> {
    if (this.ctx.signal.aborted) throw new ExitSignal(130);
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
          try {
            return await sub.exec(node.body);
          } catch (e) {
            if (e instanceof ExitSignal) return e.code;
            throw e;
          } finally {
            sub.releaseFds();
          }
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
          for (const item of node.items) {
            for (const p of item.patterns) {
              const pat = await this.expandPattern(p);
              if (matchPattern(pat, w)) return item.body ? this.exec(item.body) : 0;
            }
          }
          return 0;
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

  private spawnAsync(node: Node) {
    const sub = this.clone();
    // background jobs read from /dev/null unless redirected
    if (!this.opts.interactive) {
      // keep stdin
    }
    const p = (async () => {
      try {
        return await sub.exec(node);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        return 1;
      } finally {
        sub.releaseFds();
      }
    })();
    const id = sub.lastBgPid ?? -Math.floor(Math.random() * 1e6);
    this.lastBg = Math.abs(id);
    this.bgJobs.set(this.lastBg, p);
    p.then(() => this.bgJobs.delete(this.lastBg));
  }
  lastBgPid?: number;

  // ---------------------------------------------------------------------------
  // pipelines

  private async execPipeline(node: Extract<Node, { t: 'pipeline' }>): Promise<number> {
    const n = node.cmds.length;
    if (n === 1) {
      const s = node.bang ? await this.cond(node.cmds[0]) : await this.exec(node.cmds[0]);
      return node.bang ? (s === 0 ? 1 : 0) : s;
    }
    const pipes = Array.from({ length: n - 1 }, () => createPipe());
    let pgid: number | undefined;
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
      sub.pipelinePgid = () => pgid;
      sub.onSpawn = (pid) => {
        if (pgid === undefined) pgid = pid;
      };
      runs.push(
        (async () => {
          try {
            return await sub.exec(node.cmds[i]);
          } catch (e) {
            if (e instanceof ExitSignal) return e.code;
            if (e instanceof ShellError) {
              sub.err(`sh: ${e.message}\n`);
              return 1;
            }
            throw e;
          } finally {
            sub.releaseFds();
          }
        })(),
      );
    }
    const codes = await Promise.all(runs);
    let s = codes[n - 1];
    if (this.opts.pipefail) {
      for (let i = n - 1; i >= 0; i--) if (codes[i] !== 0) {
        s = codes[i];
        break;
      }
    }
    if (node.bang) s = s === 0 ? 1 : 0;
    return s;
  }
  pipelinePgid?: () => number | undefined;
  onSpawn?: (pid: number) => void;

  // ---------------------------------------------------------------------------
  // simple commands

  private async execSimple(node: Extract<Node, { t: 'simple' }>): Promise<number> {
    let words: string[] = [];
    words = await this.expandWords(node.words);
    if (words.length > 0 && this.aliases.has(words[0])) {
      const a = this.aliases.get(words[0])!;
      const expanded = await this.expandWords((parse(a) as any).words ?? []);
      words = [...expanded, ...words.slice(1)];
    }
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
    const cmd = words[0];
    const args = words.slice(1);

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
      const maxFd = Math.max(2, ...fds.keys());
      const stdio: (OpenFile | null)[] = [];
      for (let i = 0; i <= maxFd; i++) stdio.push(fds.get(i) ?? null);
      let proc;
      try {
        const pg = this.pipelinePgid?.();
        proc = this.kernel.spawn({
          argv: [cmd, ...args],
          env,
          cwd: this.cwd,
          stdio,
          ppid: this.ctx.proc.pid,
          pgid: this.opts.interactive ? 0 : pg !== undefined ? pg : this.pipelinePgid ? 0 : undefined,
        });
      } catch (e: any) {
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
      this.onSpawn?.(proc.pid);
      const tty = this.ctx.proc.tty;
      const fg = this.opts.interactive && tty;
      if (fg) tty!.foregroundPgid = proc.pgid;
      const st = await proc.exited;
      if (fg) {
        tty!.foregroundPgid = this.ctx.proc.pgid;
        tty!.raw = false;
        tty!.echo = true;
      }
      if (st.signal && this.opts.interactive && st.signal !== 'SIGINT' && st.signal !== 'SIGPIPE') this.err(`${st.signal}\n`);
      return exitCodeOf(st);
    } finally {
      if (fds !== this.fds) for (const f of fds.values()) f.unref();
    }
  }
  lastSubstStatus?: number;

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
      return this.kernel.openFile({ cwd: this.cwd, fds: this.fds, tty: this.ctx.proc.tty } as any, target, flags, 0o666);
    } catch (e: any) {
      const msg = e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EISDIR' ? 'Is a directory' : e.code === 'EACCES' ? 'Permission denied' : e.message;
      throw new ShellError(`${target}: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // [[ ... ]]

  private async execDbracket(words: Word[]): Promise<number> {
    // expand without splitting/globbing; keep operators
    const toks: { s: string; pat: string; lit: boolean }[] = [];
    for (const w of words) {
      const lit = w.length === 1 && w[0].t === 'lit' ? w[0].v : null;
      if (lit !== null && ['&&', '||', '!', '(', ')', '<', '>', '==', '=', '!=', '=~', '-eq', '-ne', '-lt', '-gt', '-le', '-ge', '-z', '-n', '-e', '-f', '-d', '-x', '-r', '-w', '-s', '-L', '-h', '-nt', '-ot'].includes(lit)) {
        toks.push({ s: lit, pat: lit, lit: true });
      } else {
        toks.push({ s: await this.expandSingle(w), pat: await this.expandPattern(w), lit: false });
      }
    }
    let i = 0;
    const orExpr = (): boolean => {
      let v = andExpr();
      while (toks[i]?.lit && toks[i].s === '||') {
        i++;
        const r = andExpr();
        v = v || r;
      }
      return v;
    };
    const andExpr = (): boolean => {
      let v = notExpr();
      while (toks[i]?.lit && toks[i].s === '&&') {
        i++;
        const r = notExpr();
        v = v && r;
      }
      return v;
    };
    const notExpr = (): boolean => {
      if (toks[i]?.lit && toks[i].s === '!') {
        i++;
        return !notExpr();
      }
      if (toks[i]?.lit && toks[i].s === '(') {
        i++;
        const v = orExpr();
        i++;
        return v;
      }
      return primary();
    };
    const primary = (): boolean => {
      const a = toks[i];
      const b = toks[i + 1];
      if (b && b.lit && ['==', '=', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-gt', '-le', '-ge', '-nt', '-ot'].includes(b.s) && toks[i + 2]) {
        const c = toks[i + 2];
        i += 3;
        switch (b.s) {
          case '==':
          case '=':
            return matchPattern(c.pat, a.s);
          case '!=':
            return !matchPattern(c.pat, a.s);
          case '=~': {
            try {
              const m = new RegExp(c.s).exec(a.s);
              this.vars.set('BASH_REMATCH', m ? m[0] : '');
              return !!m;
            } catch {
              return false;
            }
          }
          case '<':
            return a.s < c.s;
          case '>':
            return a.s > c.s;
          default:
            return builtinTest(this, [a.s, b.s, c.s]) === 0;
        }
      }
      if (a?.lit && a.s.startsWith('-') && b) {
        i += 2;
        return builtinTest(this, [a.s, b.s]) === 0;
      }
      i++;
      return !!a && a.s !== '';
    };
    try {
      return orExpr() ? 0 : 1;
    } catch {
      return 2;
    }
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
        let v: number;
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
    if (p.length) {
      segs.push({ s: String((name === '@' || name === '*' ? this.positional.length : (val ?? '').length)), quoted: inDq, split: false });
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
          this.err(`sh: ${name}: ${msg}\n`);
          throw new ExitSignal(1);
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
      if (this.opts.nounset && !/^[@*#?$!0-]$/.test(name)) {
        this.err(`sh: ${name}: unbound variable\n`);
        throw new ExitSignal(1);
      }
      val = '';
    }
    segs.push({ s: val, quoted: inDq, split: !inDq && !assignment });
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
    let code = 0;
    try {
      code = await sub.runSource(src, 'sh');
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code;
      else throw e;
    } finally {
      sub.releaseFds();
    }
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
    if (pat.endsWith('/')) bases = bases.map((b) => b + '/');
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
    proc.onSignal = (sig) => {
      if (sig === 'SIGINT' || sig === 'SIGTSTP' || sig === 'SIGQUIT' || sig === 'SIGWINCH') {
        this.interrupted = true;
        return true;
      }
      return false;
    };
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
      try {
        this.status = await this.runSource(src);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        if (e instanceof BreakSig || e instanceof ContinueSig) continue;
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
    sh.ctx.proc.cwd = dir;
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
      if (a === '-o' || a === '+o') {
        const on = a === '-o';
        const name = args[++i];
        if (name === 'pipefail') sh.opts.pipefail = on;
        else if (name === 'errexit') sh.opts.errexit = on;
        else if (name === 'nounset') sh.opts.nounset = on;
        else if (name === 'xtrace') sh.opts.xtrace = on;
        else if (name === 'noglob') sh.opts.noglob = on;
        else if (name === 'allexport') sh.opts_allexport = on;
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(a)) {
        const on = a[0] === '-';
        for (const c of a.slice(1)) {
          if (c === 'e') sh.opts.errexit = on;
          else if (c === 'x') sh.opts.xtrace = on;
          else if (c === 'u') sh.opts.nounset = on;
          else if (c === 'f') sh.opts.noglob = on;
          else if (c === 'a') sh.opts_allexport = on;
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
    try {
      const v = evalArith(args.join(' '), (n) => sh.getVar(n), (n, val) => sh.setVar(n, val));
      return v !== 0 ? 0 : 1;
    } catch (e: any) {
      sh.err(`sh: ((: ${e.message}\n`);
      return 1;
    }
  },
  let(sh, args) {
    let v = 0;
    for (const a of args) v = evalArith(a, (n) => sh.getVar(n), (n, val) => sh.setVar(n, val));
    return v !== 0 ? 0 : 1;
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
    if (args.length) {
      let st = 0;
      for (const a of args) {
        const j = sh.bgJobs.get(Number(a));
        if (j) st = await j;
        else {
          try {
            const p = sh.kernel.get(Number(a));
            st = exitCodeOf(await p.exited);
          } catch {
            st = 127;
          }
        }
      }
      return st;
    }
    await Promise.all(sh.bgJobs.values());
    return 0;
  },
  trap(sh, args) {
    if (args.length >= 2) for (const s of args.slice(1)) sh.traps.set(s.replace(/^SIG/, ''), args[0]);
    return 0;
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
  umask(sh, args) {
    if (!args.length) {
      sh.out(sh.ctx.proc.umask.toString(8).padStart(4, '0') + '\n');
      return 0;
    }
    sh.ctx.proc.umask = parseInt(args[0], 8) & 0o777;
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
  const sh = new Shell(ctx);
  const args = ctx.argv.slice(1);
  let command: string | null = null;
  let interactive = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') {
      command = args[++i] ?? '';
      i++;
      break;
    }
    if (a === '-i') interactive = true;
    else if (a === '-l' || a === '--login' || a === '--norc' || a === '--noprofile' || a === '-s') {
      // ignore
    } else if (/^[-+][euxfa]+$/.test(a) || a === '-o' || a === '+o') {
      if (a === '-o' || a === '+o') {
        await BUILTINS.set(sh, [a, args[++i]]);
      } else await BUILTINS.set(sh, [a]);
    } else if (a === '--') {
      i++;
      break;
    } else break;
  }
  const rest = args.slice(i);
  try {
    if (command !== null) {
      sh.arg0 = rest[0] ?? 'sh';
      sh.positional = rest.slice(1);
      return await sh.runSource(command);
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
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    if (e instanceof ShellError) {
      ctx.err(`sh: ${e.message}\n`);
      return e.code;
    }
    if (e instanceof ReturnSig) return e.code;
    if (e instanceof BreakSig || e instanceof ContinueSig) return 0;
    throw e;
  } finally {
    sh.releaseFds();
  }
}

void ProgramContext;
