// POSIX-ish utilities implemented as kernel programs.

import * as path from '../shared/path.ts';
import { O_RDONLY } from './io.ts';
import type { Kernel, Program, ProgramContext } from './kernel.ts';
import { type Proc, SIGNALS, exitCodeOf, signalName } from './proc.ts';
import { BUILTINS, Shell } from './sh/interp.ts';
import { matchPattern } from './sh/pattern.ts';
import { applySymbolicMode } from './sh/mode.ts';
import { eregToRegexSource } from './sh/pattern.ts';
import { S_IFBLK, S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFMT, S_IFREG, S_IFSOCK, type StatData, isDir, isLink } from './vfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Parsed {
  flags: Set<string>;
  /** The last value of each option that takes one. */
  opts: Map<string, string>;
  /** Every value of each option, in order (grep -e a -e b). */
  all: Map<string, string[]>;
  args: string[];
}

/**
 * Small getopt: `withArg` lists the short options that take a value. Like GNU getopt, options
 * may follow operands (`ls dir -l`) unless `stopAtOperand` is set: then the first operand ends
 * the options, as for commands that run another command (xargs, env, timeout, nice…), whose own
 * options must reach it. `-1`, `-0` are options like any other letter.
 */
function getopt(argv: string[], withArg = '', longMap: Record<string, string> = {}, stopAtOperand = false): Parsed {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  const all = new Map<string, string[]>();
  const args: string[] = [];
  const setOpt = (k: string, v: string) => {
    opts.set(k, v);
    if (!all.has(k)) all.set(k, []);
    all.get(k)!.push(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const mapped = longMap[name] ?? name;
      if (eq > 0) setOpt(mapped, a.slice(eq + 1));
      else if (withArg.includes(mapped) && mapped.length === 1) setOpt(mapped, argv[++i] ?? '');
      else flags.add(mapped);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withArg.includes(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : (argv[++i] ?? '');
          setOpt(c, v);
          break;
        }
        flags.add(c);
      }
      continue;
    }
    if (stopAtOperand) {
      args.push(...argv.slice(i));
      break;
    }
    args.push(a);
  }
  return { flags, opts, all, args };
}

function errMsg(e: any): string {
  switch (e?.code) {
    case 'ENOENT':
      return 'No such file or directory';
    case 'ENOTDIR':
      return 'Not a directory';
    case 'EISDIR':
      return 'Is a directory';
    case 'EEXIST':
      return 'File exists';
    case 'ENOTEMPTY':
      return 'Directory not empty';
    case 'EACCES':
      return 'Permission denied';
    case 'EPERM':
      return 'Operation not permitted';
    case 'ESRCH':
      return 'No such process';
    case 'ENXIO':
      return 'No such device or address';
    case 'ELOOP':
      return 'Too many levels of symbolic links';
    default:
      return e?.message ?? String(e);
  }
}

/**
 * Starts the command of a wrapper (env, nice, timeout, xargs…): when it can't be started the
 * error is reported and the GNU status returned instead, 127 if it doesn't exist, else 126.
 */
function spawnCommand(ctx: ProgramContext, name: string, argv: string[], opts: Parameters<ProgramContext['spawn']>[1] = {}): Proc | number {
  try {
    return ctx.spawn(argv, opts);
  } catch (e: any) {
    ctx.err(`${name}: '${argv[0]}': ${errMsg(e)}\n`);
    return e?.code === 'ENOENT' ? 127 : 126;
  }
}

async function runCommand(ctx: ProgramContext, name: string, argv: string[], opts: Parameters<ProgramContext['spawn']>[1] = {}): Promise<number> {
  const p = spawnCommand(ctx, name, argv, opts);
  return typeof p === 'number' ? p : exitCodeOf(await p.exited);
}

/** A duration with an optional s/m/h/d suffix (sleep, timeout), in milliseconds; null if invalid. */
function parseDuration(s: string): number | null {
  if (/^inf(inity)?$/i.test(s)) return Infinity;
  const m = /^(\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([smhd]?)$/i.exec(s);
  if (!m) return null;
  const n = Number(s.slice(0, s.length - m[2].length));
  return Number.isFinite(n) ? n * { s: 1000, m: 60000, h: 3600000, d: 86400000, '': 1000 }[m[2].toLowerCase() as 's'] : null;
}

/** A signal given as a number or a name (TERM, SIGTERM, term); 0 is the existence check; null if unknown. */
function parseSignal(s: string): number | null {
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n === 0 || Object.values(SIGNALS).includes(n) ? n : null;
  }
  return SIGNALS['SIG' + s.toUpperCase().replace(/^SIG/, '')] ?? null;
}

/** Reads all input files (or stdin when none / "-"). Calls fn per file. */
async function eachInput(ctx: ProgramContext, files: string[], name: string, fn: (data: Uint8Array, file: string) => void | Promise<void>): Promise<number> {
  let st = 0;
  if (files.length === 0) files = ['-'];
  for (const f of files) {
    if (f === '-') {
      await fn(await ctx.readAll(0), '-');
      continue;
    }
    try {
      await fn(ctx.vfs.readFile(ctx.resolve(f)), f);
    } catch (e) {
      ctx.err(`${name}: ${f}: ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
}

async function eachLine(ctx: ProgramContext, files: string[], name: string, fn: (line: string, file: string) => void | boolean): Promise<number> {
  return eachInput(ctx, files, name, (data, file) => {
    const text = dec.decode(data);
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) if (fn(l, file) === false) break;
  });
}

function modeString(mode: number): string {
  const t = mode & S_IFMT;
  const c = t === S_IFDIR ? 'd' : t === S_IFLNK ? 'l' : t === S_IFREG ? '-' : t === S_IFCHR ? 'c' : t === S_IFIFO ? 'p' : t === S_IFSOCK ? 's' : t === S_IFBLK ? 'b' : '?';
  const bits = [...'rwxrwxrwx'].map((b, i) => (mode & (1 << (8 - i)) ? b : '-'));
  // setuid, setgid and sticky show in the x positions
  const special = (i: number, bit: number, ch: string) => {
    if (mode & bit) bits[i] = bits[i] === 'x' ? ch : ch.toUpperCase();
  };
  special(2, 0o4000, 's');
  special(5, 0o2000, 's');
  special(8, 0o1000, 't');
  return c + bits.join('');
}

function humanSize(n: number): string {
  const units = ['', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? String(n) : (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + units[i];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lsDate(ms: number): string {
  const d = new Date(ms);
  const recent = Math.abs(Date.now() - ms) < 180 * 86400e3;
  const day = String(d.getDate()).padStart(2, ' ');
  if (recent) return `${MONTHS[d.getMonth()]} ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${MONTHS[d.getMonth()]} ${day}  ${d.getFullYear()}`;
}

const ls: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), '', { all: 'a', 'almost-all': 'A', long: 'l', human: 'h', recursive: 'R', color: 'color' });
  const all = flags.has('a');
  const almost = flags.has('A');
  const long = flags.has('l');
  const one = flags.has('1') || !ctx.isatty(1);
  const color = ctx.isatty(1) && !flags.has('no-color');
  const targets = args.length ? args : ['.'];
  let st = 0;
  const vfs = ctx.vfs;
  const fmtName = (name: string, s: StatData, full: string) => {
    if (!color) return name;
    const t = s.mode & S_IFMT;
    if (t === S_IFDIR) return `\x1b[1;34m${name}\x1b[0m`;
    if (t === S_IFLNK) return `\x1b[1;36m${name}\x1b[0m`;
    if (s.mode & 0o111) return `\x1b[1;32m${name}\x1b[0m`;
    void full;
    return name;
  };
  const listDir = (dir: string, label: boolean) => {
    const abs = ctx.resolve(dir);
    let names = vfs.readdir(abs).sort((a, b) => a.localeCompare(b));
    if (!all && !almost) names = names.filter((n) => !n.startsWith('.'));
    if (all) names = ['.', '..', ...names];
    if (flags.has('t')) names.sort((a, b) => (vfs.tryLookup(path.join(abs, b), false)?.mtimeMs ?? 0) - (vfs.tryLookup(path.join(abs, a), false)?.mtimeMs ?? 0));
    if (flags.has('r')) names.reverse();
    if (label) ctx.out(`${dir}:\n`);
    printEntries(names.map((n) => ({ name: n, full: path.join(abs, n) })), true);
    if (flags.has('R')) {
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const node = vfs.tryLookup(path.join(abs, n), false);
        if (node && isDir(node)) {
          ctx.out('\n');
          listDir(path.join(dir, n), true);
        }
      }
    }
  };
  /** `inDir`: the contents of a directory (only those get a "total" line; file operands don't). */
  const printEntries = (entries: { name: string; full: string }[], inDir: boolean) => {
    if (long) {
      const rows = entries.map((e) => {
        const s = vfs.lstat(e.full);
        let name = fmtName(e.name, s, e.full);
        if ((s.mode & S_IFMT) === S_IFLNK) name += ` -> ${vfs.readlink(e.full)}`;
        return [modeString(s.mode), String(s.nlink), 'user', 'user', flags.has('h') ? humanSize(s.size) : String(s.size), lsDate(s.mtimeMs), name];
      });
      if (inDir) {
        const total = entries.reduce((a, e) => a + Math.ceil(vfs.lstat(e.full).size / 1024), 0);
        ctx.out(`total ${total}\n`);
      }
      const w = [0, 0, 0, 0, 0];
      for (const r of rows) for (let i = 0; i < 5; i++) w[i] = Math.max(w[i], r[i].length);
      for (const r of rows) ctx.out(`${r[0]} ${r[1].padStart(w[1])} ${r[2].padEnd(w[2])} ${r[3].padEnd(w[3])} ${r[4].padStart(w[4])} ${r[5]} ${r[6]}\n`);
      return;
    }
    if (one) {
      for (const e of entries) ctx.out(fmtName(e.name, vfs.lstat(e.full), e.full) + '\n');
      return;
    }
    if (!entries.length) return;
    const cols = ctx.proc.tty?.cols ?? 80;
    const width = Math.max(...entries.map((e) => [...e.name].length)) + 2;
    const per = Math.max(1, Math.floor(cols / width));
    const rowsN = Math.ceil(entries.length / per);
    for (let r = 0; r < rowsN; r++) {
      let line = '';
      for (let c = 0; c < per; c++) {
        const e = entries[c * rowsN + r];
        if (!e) continue;
        const pad = width - [...e.name].length;
        line += fmtName(e.name, vfs.lstat(e.full), e.full) + ' '.repeat(pad);
      }
      ctx.out(line.trimEnd() + '\n');
    }
  };
  const files: { name: string; full: string }[] = [];
  const dirs: string[] = [];
  for (const t of targets) {
    try {
      const n = vfs.lookup(ctx.resolve(t), true);
      if (isDir(n) && !flags.has('d')) dirs.push(t);
      else files.push({ name: t, full: ctx.resolve(t) });
    } catch (e) {
      ctx.err(`ls: cannot access '${t}': ${errMsg(e)}\n`);
      st = 2;
    }
  }
  printEntries(files, false);
  dirs.forEach((d, i) => {
    if (i > 0 || files.length) ctx.out('\n');
    listDir(d, targets.length > 1 || flags.has('R'));
  });
  return st;
};

const cat: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let lineNo = 1;
  let atLineStart = true;
  const emit = (d: Uint8Array) => {
    if (!flags.has('n')) return ctx.out(d);
    const text = dec.decode(d, { stream: true });
    let out = '';
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      if (atLineStart) out += `${String(lineNo++).padStart(6)}\t`;
      out += part;
      atLineStart = part.endsWith('\n');
    }
    ctx.out(out);
  };
  let st = 0;
  for (const f of args.length ? args : ['-']) {
    if (f === '-') {
      // stream stdin: a reader on the other end of a pipe sees each chunk as it arrives
      for (let d; (d = await ctx.read(0)); ) emit(d);
      continue;
    }
    try {
      emit(ctx.vfs.readFile(ctx.resolve(f)));
    } catch (e) {
      ctx.err(`cat: ${f}: ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
};

const mkdir: Program = async (ctx) => {
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'm', { parents: 'p' });
  let st = 0;
  const mode = opts.has('m') ? parseInt(opts.get('m')!, 8) : 0o777;
  for (const a of args) {
    try {
      if (flags.has('p')) ctx.vfs.mkdir(ctx.resolve(a), mode, true);
      else ctx.vfs.mkdir(ctx.resolve(a), mode);
    } catch (e) {
      ctx.err(`mkdir: cannot create directory '${a}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  if (!args.length) {
    ctx.err('mkdir: missing operand\n');
    return 1;
  }
  return st;
};

const mkfifo: Program = async (ctx) => {
  const { opts, args } = getopt(ctx.argv.slice(1), 'm');
  if (!args.length) {
    ctx.err('mkfifo: missing operand\n');
    return 1;
  }
  const mode = opts.has('m') ? parseInt(opts.get('m')!, 8) : 0o666 & ~ctx.proc.umask;
  let st = 0;
  for (const a of args) {
    try {
      ctx.vfs.mknodFifo(ctx.resolve(a), mode);
    } catch (e) {
      ctx.err(`mkfifo: cannot create fifo '${a}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
};

const rm: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), '', { recursive: 'r', force: 'f', verbose: 'v', dir: 'd' });
  const recursive = flags.has('r') || flags.has('R');
  const force = flags.has('f');
  let st = 0;
  for (const a of args) {
    const abs = ctx.resolve(a);
    // GNU rm: --preserve-root is the default (and --no-preserve-root isn't offered here)
    if (recursive && abs === '/') {
      ctx.err(`rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n`);
      st = 1;
      continue;
    }
    if (/(^|\/)\.\.?\/*$/.test(a)) {
      ctx.err(`rm: refusing to remove '.' or '..' directory: skipping '${a}'\n`);
      st = 1;
      continue;
    }
    const node = ctx.vfs.tryLookup(abs, false);
    if (!node) {
      if (!force) {
        ctx.err(`rm: cannot remove '${a}': No such file or directory\n`);
        st = 1;
      }
      continue;
    }
    try {
      if (isDir(node)) {
        if (!recursive && !flags.has('d')) {
          ctx.err(`rm: cannot remove '${a}': Is a directory\n`);
          st = 1;
          continue;
        }
        if (recursive) ctx.vfs.rmrf(abs);
        else ctx.vfs.rmdir(abs);
        if (flags.has('v')) ctx.out(`removed directory '${a}'\n`);
      } else {
        ctx.vfs.unlink(abs);
        if (flags.has('v')) ctx.out(`removed '${a}'\n`);
      }
    } catch (e) {
      ctx.err(`rm: cannot remove '${a}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  if (!args.length && !force) {
    ctx.err('rm: missing operand\n');
    return 1;
  }
  return st;
};

const rmdir: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let st = 0;
  for (const a of args) {
    try {
      ctx.vfs.rmdir(ctx.resolve(a));
      if (flags.has('p')) {
        let d = path.dirname(a);
        while (d !== '.' && d !== '/') {
          ctx.vfs.rmdir(ctx.resolve(d));
          d = path.dirname(d);
        }
      }
    } catch (e) {
      ctx.err(`rmdir: failed to remove '${a}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
};

const cp: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), '', { recursive: 'r', force: 'f' });
  if (args.length < 2) {
    ctx.err('cp: missing file operand\n');
    return 1;
  }
  const dest = args.pop()!;
  const destAbs = ctx.resolve(dest);
  const destNode = ctx.vfs.tryLookup(destAbs);
  const destIsDir = !!destNode && isDir(destNode);
  if (args.length > 1 && !destIsDir) {
    ctx.err(`cp: target '${dest}' is not a directory\n`);
    return 1;
  }
  let st = 0;
  for (const src of args) {
    const srcAbs = ctx.resolve(src);
    const target = destIsDir ? path.join(destAbs, path.basename(srcAbs)) : destAbs;
    try {
      const node = ctx.vfs.lookup(srcAbs, !flags.has('P') && !flags.has('d'));
      if (isDir(node) && !(flags.has('r') || flags.has('R') || flags.has('a'))) {
        ctx.err(`cp: -r not specified; omitting directory '${src}'\n`);
        st = 1;
        continue;
      }
      if (flags.has('n') && ctx.vfs.exists(target)) continue;
      ctx.vfs.copy(srcAbs, target, { dereference: !flags.has('a') && !flags.has('P') && !flags.has('d') ? isDir(node) ? false : true : false });
    } catch (e) {
      ctx.err(`cp: cannot copy '${src}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
};

const mv: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  if (args.length < 2) {
    ctx.err('mv: missing file operand\n');
    return 1;
  }
  const dest = args.pop()!;
  const destAbs = ctx.resolve(dest);
  const destNode = ctx.vfs.tryLookup(destAbs);
  const destIsDir = !!destNode && isDir(destNode);
  let st = 0;
  for (const src of args) {
    const srcAbs = ctx.resolve(src);
    const target = destIsDir ? path.join(destAbs, path.basename(srcAbs)) : destAbs;
    try {
      if (flags.has('n') && ctx.vfs.exists(target)) continue;
      const existing = ctx.vfs.tryLookup(target, false);
      if (existing && !isDir(existing) && target !== srcAbs) ctx.vfs.unlink(target);
      ctx.vfs.rename(srcAbs, target);
    } catch (e) {
      ctx.err(`mv: cannot move '${src}' to '${dest}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
};

const touch: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), 'dtr');
  const now = Date.now();
  for (const a of args) {
    const abs = ctx.resolve(a);
    if (!ctx.vfs.exists(abs)) {
      if (flags.has('c')) continue;
      try {
        ctx.vfs.createFile(abs);
      } catch (e) {
        ctx.err(`touch: cannot touch '${a}': ${errMsg(e)}\n`);
        return 1;
      }
    } else ctx.vfs.utimes(abs, now, now);
  }
  return 0;
};

const ln: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  if (args.length < 1) return 1;
  const target = args[0];
  let link = args[1] ?? path.basename(target);
  const linkAbs0 = ctx.resolve(link);
  const ln0 = ctx.vfs.tryLookup(linkAbs0);
  if (ln0 && isDir(ln0) && !flags.has('n')) link = path.join(link, path.basename(target));
  const linkAbs = ctx.resolve(link);
  try {
    if (flags.has('f') && ctx.vfs.tryLookup(linkAbs, false)) ctx.vfs.unlink(linkAbs);
    if (flags.has('s')) ctx.vfs.symlink(target, linkAbs);
    else ctx.vfs.link(ctx.resolve(target), linkAbs);
  } catch (e) {
    ctx.err(`ln: failed to create link '${link}': ${errMsg(e)}\n`);
    return 1;
  }
  return 0;
};

const chmod: Program = async (ctx) => {
  // a mode like -x or -w is the mode operand, not an option (GNU chmod's own options are R c f v)
  const SYMBOLIC = /^[ugoa]*(?:[-+=](?:[rwxXst]*|[ugo]))+(?:,[ugoa]*(?:[-+=](?:[rwxXst]*|[ugo]))+)*$/;
  const flags = new Set<string>();
  const args: string[] = [];
  let modeSpec: string | undefined;
  const argv = ctx.argv.slice(1);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (modeSpec === undefined && a.startsWith('-') && SYMBOLIC.test(a)) modeSpec = a;
    else if (a === '--recursive') flags.add('R');
    else if (a.startsWith('--')) {
      // --verbose, --changes, --silent and friends: nothing to report here
    } else if (/^-[Rcfv]+$/.test(a)) for (const c of a.slice(1)) flags.add(c);
    else if (modeSpec === undefined) modeSpec = a;
    else args.push(a);
  }
  if (modeSpec === undefined && args.length) modeSpec = args.shift();
  if (modeSpec === undefined || !args.length) {
    ctx.err(modeSpec === undefined ? 'chmod: missing operand\n' : `chmod: missing operand after '${modeSpec}'\n`);
    return 1;
  }
  const octal = /^[0-7]{1,4}$/.test(modeSpec);
  if (!octal && !SYMBOLIC.test(modeSpec)) {
    ctx.err(`chmod: invalid mode: '${modeSpec}'\n`);
    return 1;
  }
  const apply = (p: string, top = true) => {
    // symlinks met while recursing are neither changed nor followed
    const node = ctx.vfs.lookup(p, top);
    if (isLink(node)) return;
    const mode = octal ? parseInt(modeSpec!, 8) : applySymbolicMode(node.mode & 0o7777, modeSpec!, { isDir: isDir(node), umask: ctx.proc.umask })!;
    ctx.vfs.chmod(p, mode);
    if (flags.has('R') && isDir(node)) for (const n of ctx.vfs.readdir(p)) apply(path.join(p, n), false);
  };
  let st = 0;
  for (const a of args) {
    try {
      apply(ctx.resolve(a));
    } catch (e) {
      ctx.err(`chmod: cannot access '${a}': ${errMsg(e)}\n`);
      st = 1;
    }
  }
  return st;
};

const head: Program = async (ctx) => {
  const argv = ctx.argv.slice(1).map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
  const { opts, args } = getopt(argv, 'nc');
  const n = Number(opts.get('n') ?? 10);
  const multi = args.length > 1;
  if (!args.length && (opts.has('c') ? Number(opts.get('c')) >= 0 : n >= 0)) {
    // stdin is streamed: head exits once it has its lines/bytes, without waiting for EOF
    let left = opts.has('c') ? Number(opts.get('c')) : n;
    while (left > 0) {
      const d = await ctx.read(0);
      if (!d) break;
      let end = d.length;
      if (opts.has('c')) end = Math.min(d.length, left);
      else
        for (let i = 0; i < d.length; i++)
          if (d[i] === 10 && --left === 0) {
            end = i + 1;
            break;
          }
      if (opts.has('c')) left -= end;
      ctx.out(d.subarray(0, end));
    }
    return 0;
  }
  return eachInput(ctx, args, 'head', (d, f) => {
    if (multi) ctx.out(`==> ${f} <==\n`);
    if (opts.has('c')) {
      ctx.out(d.subarray(0, Number(opts.get('c'))));
      return;
    }
    const text = dec.decode(d);
    const lines = text.split('\n');
    const take = n < 0 ? lines.slice(0, Math.max(0, lines.length - 1 + n)) : lines.slice(0, n);
    const hadNl = lines.length > take.length;
    ctx.out(take.join('\n') + (hadNl && take.length ? '\n' : ''));
  });
};

const tail: Program = async (ctx) => {
  const argv = ctx.argv.slice(1).map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
  const { opts, args, flags } = getopt(argv, 'nc');
  const spec = opts.get('n') ?? '10';
  const fromStart = spec.startsWith('+');
  const n = Math.abs(Number(spec));
  let nth = 0;
  const st = await eachInput(ctx, args, 'tail', (d, f) => {
    if (args.length > 1 && !flags.has('q')) ctx.out(`${nth++ ? '\n' : ''}==> ${f === '-' ? 'standard input' : f} <==\n`);
    if (opts.has('c')) {
      // -c N: the last N bytes; -c +N: from byte N on
      const c = opts.get('c')!;
      const k = Math.abs(Number(c));
      ctx.out(c.startsWith('+') ? d.subarray(Math.max(0, k - 1)) : d.subarray(Math.max(0, d.length - k)));
      return;
    }
    const text = dec.decode(d);
    const lines = text.split('\n');
    const trailing = lines[lines.length - 1] === '';
    if (trailing) lines.pop();
    const out = fromStart ? lines.slice(Math.max(0, n - 1)) : n === 0 ? [] : lines.slice(Math.max(0, lines.length - n));
    // a last line without a newline stays without one
    if (out.length) ctx.out(out.join('\n') + (trailing ? '\n' : ''));
  });
  if (flags.has('f') && args.length === 1) {
    // follow: poll for growth until killed
    const abs = ctx.resolve(args[0]);
    let size = ctx.vfs.stat(abs).size;
    while (!ctx.signal.aborted) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const s = ctx.vfs.stat(abs).size;
        if (s > size) {
          ctx.out(ctx.vfs.readFile(abs).subarray(size, s));
          size = s;
        } else if (s < size) size = s;
      } catch {}
    }
  }
  return st;
};

const wc: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  const showL = flags.has('l') || (!flags.has('w') && !flags.has('c') && !flags.has('m'));
  const showW = flags.has('w') || (!flags.has('l') && !flags.has('c') && !flags.has('m'));
  const showC = flags.has('c') || flags.has('m') || (!flags.has('l') && !flags.has('w'));
  const totals = [0, 0, 0];
  const rows: [number, number, number, string][] = [];
  const st = await eachInput(ctx, args, 'wc', (d, f) => {
    const text = dec.decode(d);
    const l = (text.match(/\n/g) ?? []).length;
    const w = text.split(/\s+/).filter(Boolean).length;
    const c = flags.has('m') ? [...text].length : d.length;
    totals[0] += l;
    totals[1] += w;
    totals[2] += c;
    rows.push([l, w, c, f === '-' ? '' : f]);
  });
  if (rows.length > 1) rows.push([totals[0], totals[1], totals[2], 'total']);
  const width = rows.length === 1 && args.length === 0 ? 0 : Math.max(...rows.flatMap((r) => [String(r[0]).length, String(r[1]).length, String(r[2]).length]));
  for (const r of rows) {
    const parts: string[] = [];
    if (showL) parts.push(String(r[0]).padStart(width));
    if (showW) parts.push(String(r[1]).padStart(width));
    if (showC) parts.push(String(r[2]).padStart(width));
    ctx.out(parts.join(' ') + (r[3] ? ` ${r[3]}` : '') + '\n');
  }
  return st;
};

/** GNU sed's escapes for characters, in regexes and replacements. */
function sedEscape(s: string, i: number): { ch: string; len: number } | null {
  const n = s[i + 1];
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07' };
  if (n in simple) return { ch: simple[n], len: 2 };
  const m = /^(d([0-9]{3})|o([0-7]{3})|x([0-9a-fA-F]{2})|c(.))/.exec(s.slice(i + 1));
  if (!m) return null;
  const code = m[2] ? parseInt(m[2], 10) : m[3] ? parseInt(m[3], 8) : m[4] ? parseInt(m[4], 16) : m[5].toUpperCase().charCodeAt(0) ^ 0x40;
  return { ch: String.fromCharCode(code), len: 1 + m[0].length };
}

/**
 * A POSIX regular expression as JavaScript regex source: basic (BRE: `\(` `\)` `\{` `\}` `\|`
 * `\+` `\?` are the operators, the bare characters literal) unless `extended`, with POSIX bracket
 * expressions and the GNU \w \s \b \< \> escapes. `sed` adds GNU sed's \n \t … escapes.
 */
function posixRegexToJs(p: string, extended: boolean, sed = false): string {
  let ere = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '[') {
      // copy the bracket expression as it is (its own syntax is the same in BRE and ERE)
      let j = i + 1;
      let head = '[';
      if (p[j] === '^') head += p[j++];
      if (p[j] === ']') head += p[j++];
      let body = '';
      for (; j < p.length && p[j] !== ']'; j++) {
        if (p[j] === '[' && ':=.'.includes(p[j + 1] ?? '')) {
          const close = p.indexOf(p[j + 1] + ']', j + 2);
          if (close !== -1) {
            body += p.slice(j, close + 2);
            j = close + 1;
            continue;
          }
        }
        const e = sed && p[j] === '\\' ? sedEscape(p, j) : null;
        if (e) {
          body += e.ch;
          j += e.len - 1;
        } else body += p[j];
      }
      ere += head + body + (j < p.length ? ']' : '');
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < p.length) {
      const e = sed ? sedEscape(p, i) : null;
      if (e) {
        ere += /[\\^$.*+?()[\]{}|]/.test(e.ch) ? '\\' + e.ch : e.ch;
        i += e.len - 1;
        continue;
      }
      const n = p[++i];
      if (!extended && '(){}|+?'.includes(n)) ere += n;
      else ere += '\\' + n;
      continue;
    }
    if (!extended && '(){}|+?'.includes(c)) {
      ere += '\\' + c;
      continue;
    }
    // a `*` at the start of a BRE (or of a group) is literal
    if (!extended && c === '*' && (ere === '' || ere === '^' || ere.endsWith('(') || ere.endsWith('|'))) {
      ere += '\\*';
      continue;
    }
    ere += c;
  }
  return eregToRegexSource(ere);
}

const grep: Program = async (ctx) => {
  const name = ctx.argv[0].split('/').pop()!;
  const { flags, opts, all, args } = getopt(ctx.argv.slice(1), 'efmABCd', {
    'ignore-case': 'i', 'invert-match': 'v', 'line-number': 'n', count: 'c', recursive: 'r', 'dereference-recursive': 'R',
    'files-with-matches': 'l', 'files-without-match': 'L', quiet: 'q', silent: 'q', 'word-regexp': 'w', 'line-regexp': 'x',
    'only-matching': 'o', 'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', 'perl-regexp': 'P',
    'no-filename': 'h', 'with-filename': 'H', 'no-messages': 's', regexp: 'e', file: 'f', 'max-count': 'm',
    'after-context': 'A', 'before-context': 'B', context: 'C', text: 'a', include: 'include', exclude: 'exclude', 'exclude-dir': 'exclude-dir', color: 'color', colour: 'color',
  });
  const patterns: string[] = [...(all.get('e') ?? [])];
  for (const f of all.get('f') ?? []) {
    try {
      const text = dec.decode(f === '-' ? await ctx.readAll(0) : ctx.vfs.readFile(ctx.resolve(f)));
      patterns.push(...text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== ''));
    } catch (e) {
      ctx.err(`${name}: ${f}: ${errMsg(e)}\n`);
      return 2;
    }
  }
  if (!all.has('e') && !all.has('f')) {
    if (!args.length) {
      ctx.err(`Usage: ${name} [OPTION]... PATTERNS [FILE]...\n`);
      return 2;
    }
    // a pattern operand may hold several patterns, one per line
    patterns.push(...args.shift()!.split('\n'));
  }
  const extended = flags.has('E') || name === 'egrep';
  const fixed = flags.has('F') || name === 'fgrep';
  let re: RegExp;
  try {
    let src = patterns
      .map((p) => (fixed ? p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') : flags.has('P') ? p : posixRegexToJs(p, extended)))
      .map((p) => `(?:${p})`)
      .join('|');
    if (!patterns.length) src = '(?!)';
    if (flags.has('w')) src = `(?<![\\w])(?:${src})(?![\\w])`;
    if (flags.has('x')) src = `^(?:${src})$`;
    re = new RegExp(src, flags.has('i') || flags.has('y') ? 'i' : '');
  } catch (e: any) {
    ctx.err(`${name}: ${e?.message ?? 'invalid regular expression'}\n`);
    return 2;
  }
  const num = (k: string) => {
    const v = opts.get(k);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new Error(`${v}: invalid context length argument`);
    return Number(v);
  };
  let after: number;
  let before: number;
  try {
    after = num('A') ?? num('C') ?? 0;
    before = num('B') ?? num('C') ?? 0;
  } catch (e: any) {
    ctx.err(`${name}: ${e.message}\n`);
    return 2;
  }
  const maxCount = opts.has('m') ? Number(opts.get('m')) : Infinity;
  const invert = flags.has('v');
  const recursive = flags.has('r') || flags.has('R');
  let files = args;
  if (recursive) {
    if (!files.length) files = ['.'];
    const expanded: string[] = [];
    const include = all.get('include') ?? [];
    const exclude = all.get('exclude') ?? [];
    const excludeDir = all.get('exclude-dir') ?? [];
    const walk = (p: string, top: boolean) => {
      const node = ctx.vfs.tryLookup(ctx.resolve(p), top || flags.has('R'));
      if (!node) {
        if (top) expanded.push(p);
        return;
      }
      if (isDir(node)) {
        if (!top && excludeDir.some((g) => matchPattern(g, path.basename(p)))) return;
        for (const n of ctx.vfs.readdir(ctx.resolve(p)).sort()) walk(p === '.' && !args.length ? n : path.join(p, n), false);
      } else if (isLink(node)) {
        // symlinks found while recursing are skipped (-r), followed with -R
      } else {
        const base = path.basename(p);
        if (include.length && !include.some((g) => matchPattern(g, base))) return;
        if (exclude.some((g) => matchPattern(g, base))) return;
        expanded.push(p);
      }
    };
    for (const f of files) walk(f, true);
    files = expanded;
  }
  const showName = flags.has('H') || ((files.length > 1 || recursive) && !flags.has('h'));
  const context = (after > 0 || before > 0) && !flags.has('o');
  let matched = false;
  // `--` between groups of context that aren't adjacent (also across files)
  let printedAny = false;
  const st = await eachInput(ctx, files, name, (d, f) => {
    const label = f === '-' ? '(standard input)' : f;
    let count = 0;
    const text = dec.decode(d);
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (text.includes('\0') && !flags.has('a')) {
      for (const l of lines) {
        if (re.test(l) !== invert && ++count) break;
      }
      if (count) {
        matched = true;
        if (flags.has('l')) ctx.out(label + '\n');
        else if (flags.has('c')) ctx.out((showName ? `${label}:` : '') + '1\n');
        else if (!flags.has('q') && !flags.has('L')) ctx.out(`Binary file ${label} matches\n`);
      } else if (flags.has('L')) ctx.out(label + '\n');
      return;
    }
    let lastPrinted = -1;
    let afterLeft = 0;
    const emit = (i: number, sep: string) => {
      if (context && printedAny && (lastPrinted === -1 || i > lastPrinted + 1)) ctx.out('--\n');
      ctx.out((showName ? label + sep : '') + (flags.has('n') ? `${i + 1}${sep}` : '') + lines[i] + '\n');
      lastPrinted = i;
      printedAny = true;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const hit = count < maxCount && re.test(l) !== invert;
      if (!hit) {
        if (afterLeft > 0) {
          emit(i, '-');
          afterLeft--;
        } else if (count >= maxCount) break;
        continue;
      }
      matched = true;
      count++;
      if (flags.has('q')) return;
      if (flags.has('l') || flags.has('L') || flags.has('c')) {
        if (count >= maxCount || flags.has('l') || flags.has('L')) break;
        continue;
      }
      if (flags.has('o')) {
        if (invert) continue;
        const g = new RegExp(re.source, re.flags + 'g');
        for (const m of l.matchAll(g)) {
          // empty matches print nothing
          if (m[0] === '') continue;
          ctx.out((showName ? `${label}:` : '') + (flags.has('n') ? `${i + 1}:` : '') + m[0] + '\n');
        }
        continue;
      }
      for (let j = Math.max(lastPrinted + 1, i - before); j < i; j++) emit(j, '-');
      emit(i, ':');
      afterLeft = after;
    }
    if (flags.has('c')) ctx.out((showName ? `${label}:` : '') + count + '\n');
    if (flags.has('l') && count) ctx.out(label + '\n');
    if (flags.has('L') && !count) ctx.out(label + '\n');
  });
  // an error (a missing file…) gives 2, unless -q found a match
  if (flags.has('q') && matched) return 0;
  if (st) return 2;
  return matched ? 0 : 1;
};

const find: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  const roots: string[] = [];
  let i = 0;
  while (i < argv.length && !argv[i].startsWith('-') && argv[i] !== '!' && argv[i] !== '(') roots.push(argv[i++]);
  if (!roots.length) roots.push('.');
  type Pred = (p: string, s: StatData, depth: number) => boolean;
  const expr = argv.slice(i);
  let maxDepth = Infinity;
  let minDepth = 0;
  let hasAction = false;
  let k = 0;
  const parseOr = (): Pred => {
    let left = parseAnd();
    while (expr[k] === '-o' || expr[k] === '-or') {
      k++;
      const right = parseAnd();
      const l = left;
      left = (p, s, d) => l(p, s, d) || right(p, s, d);
    }
    return left;
  };
  const parseAnd = (): Pred => {
    let left = parseNot();
    while (k < expr.length && expr[k] !== '-o' && expr[k] !== '-or' && expr[k] !== ')') {
      if (expr[k] === '-a' || expr[k] === '-and') k++;
      const right = parseNot();
      const l = left;
      left = (p, s, d) => l(p, s, d) && right(p, s, d);
    }
    return left;
  };
  const parseNot = (): Pred => {
    if (expr[k] === '!' || expr[k] === '-not') {
      k++;
      const inner = parseNot();
      return (p, s, d) => !inner(p, s, d);
    }
    if (expr[k] === '(') {
      k++;
      const inner = parseOr();
      k++;
      return inner;
    }
    return parsePrim();
  };
  const parsePrim = (): Pred => {
    const t = expr[k++];
    switch (t) {
      case '-name':
      case '-iname': {
        const pat = expr[k++];
        const ci = t === '-iname';
        return (p) => matchPattern(ci ? pat.toLowerCase() : pat, ci ? path.basename(p).toLowerCase() : path.basename(p));
      }
      case '-path':
      case '-wholename': {
        const pat = expr[k++];
        return (p) => matchPattern(pat, p);
      }
      case '-type': {
        const ty = expr[k++];
        return (_p, s) => {
          const m = s.mode & S_IFMT;
          const types: Record<string, number> = { f: S_IFREG, d: S_IFDIR, l: S_IFLNK, p: S_IFIFO, s: S_IFSOCK, c: S_IFCHR, b: S_IFBLK };
          // -type f,d: any of the listed types
          return ty.split(',').some((t) => types[t] === m);
        };
      }
      case '-maxdepth':
        maxDepth = Number(expr[k++]);
        return () => true;
      case '-mindepth':
        minDepth = Number(expr[k++]);
        return () => true;
      case '-empty':
        // `p` is the path as displayed (relative to the cwd for a relative start point)
        return (p, s) => ((s.mode & S_IFMT) === S_IFDIR ? ctx.vfs.readdir(ctx.resolve(p)).length === 0 : (s.mode & S_IFMT) === S_IFREG && s.size === 0);
      case '-newer': {
        const ref = ctx.vfs.stat(ctx.resolve(expr[k++])).mtimeMs;
        return (_p, s) => s.mtimeMs > ref;
      }
      case '-size': {
        const spec = expr[k++];
        const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(spec);
        const mult = { c: 1, k: 1024, M: 1 << 20, G: 1 << 30, '': 512 }[m?.[3] ?? ''] ?? 512;
        const n = Number(m?.[2] ?? 0) * mult;
        return (_p, s) => (m?.[1] === '+' ? s.size > n : m?.[1] === '-' ? s.size < n : Math.ceil(s.size / mult) * mult === n);
      }
      case '-print':
        hasAction = true;
        return (p) => {
          ctx.out(p + '\n');
          return true;
        };
      case '-print0':
        hasAction = true;
        return (p) => {
          ctx.out(p + '\0');
          return true;
        };
      case '-prune':
        return () => {
          prune = true;
          return true;
        };
      case '-delete':
        hasAction = true;
        return (p) => {
          deletions.push(p);
          return true;
        };
      case '-exec': {
        hasAction = true;
        const cmd: string[] = [];
        while (k < expr.length && expr[k] !== ';' && !(expr[k] === '+' && expr[k - 1] === '{}')) cmd.push(expr[k++]);
        if (k >= expr.length) throw new Error("missing argument to `-exec'");
        const batch = expr[k++] === '+';
        if (batch) {
          // -exec cmd {} +: one run with every path in place of the {}
          const run = { argv: cmd.slice(0, -1), paths: [] as string[] };
          batches.push(run);
          return (p) => {
            run.paths.push(p);
            return true;
          };
        }
        return (p) => {
          execs.push(cmd.map((c) => c.split('{}').join(p)));
          return true;
        };
      }
      case '-true':
        return () => true;
      case '-false':
        return () => false;
      default:
        throw new Error(`unknown predicate '${t}'`);
    }
  };
  let pred: Pred;
  let prune = false;
  const deletions: string[] = [];
  const execs: string[][] = [];
  const batches: { argv: string[]; paths: string[] }[] = [];
  try {
    pred = expr.length ? parseOr() : () => true;
  } catch (e: any) {
    ctx.err(`find: ${e.message}\n`);
    return 1;
  }
  let st = 0;
  const visit = (display: string, abs: string, depth: number) => {
    let s: StatData;
    try {
      s = ctx.vfs.lstat(abs);
    } catch (e) {
      ctx.err(`find: '${display}': ${errMsg(e)}\n`);
      st = 1;
      return;
    }
    prune = false;
    if (depth >= minDepth) {
      const ok = pred(display, s, depth);
      if (ok && !hasAction) ctx.out(display + '\n');
    }
    if ((s.mode & S_IFMT) === S_IFDIR && depth < maxDepth && !prune) {
      for (const n of ctx.vfs.readdir(abs).sort()) visit(display.endsWith('/') ? display + n : `${display}/${n}`, path.join(abs, n), depth + 1);
    }
  };
  for (const r of roots) visit(r, ctx.resolve(r), 0);
  for (const d of deletions.reverse()) {
    try {
      ctx.vfs.rmrf(ctx.resolve(d));
    } catch {}
  }
  for (const c of execs) {
    const code = await ctx.run(c);
    if (code) st = 1;
  }
  for (const b of batches) {
    if (!b.paths.length) continue;
    const code = await ctx.run([...b.argv, ...b.paths]);
    if (code) st = 1;
  }
  return st;
};

const sort: Program = async (ctx) => {
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'tko');
  const lines: string[] = [];
  const st = await eachLine(ctx, args, 'sort', (l) => {
    lines.push(l);
  });
  const sep = opts.get('t');
  const keySpec = opts.get('k');
  const key = (l: string) => {
    if (!keySpec) return l;
    const n = parseInt(keySpec, 10) - 1;
    const fields = sep ? l.split(sep) : l.trim().split(/\s+/);
    return fields.slice(n).join(sep ?? ' ');
  };
  const numeric = flags.has('n') || flags.has('h');
  lines.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    let c: number;
    if (numeric) c = (parseFloat(ka) || 0) - (parseFloat(kb) || 0);
    else if (flags.has('f')) c = ka.toLowerCase() < kb.toLowerCase() ? -1 : ka.toLowerCase() > kb.toLowerCase() ? 1 : 0;
    else c = ka < kb ? -1 : ka > kb ? 1 : 0;
    return c;
  });
  if (flags.has('r')) lines.reverse();
  let out = flags.has('u') ? lines.filter((l, i) => i === 0 || l !== lines[i - 1]) : lines;
  void out;
  const text = out.map((l) => l + '\n').join('');
  if (opts.has('o')) ctx.vfs.writeFile(ctx.resolve(opts.get('o')!), text);
  else ctx.out(text);
  return st;
};

const uniq: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  const lines: string[] = [];
  const st = await eachLine(ctx, args.slice(0, 1), 'uniq', (l) => {
    lines.push(l);
  });
  const groups: [string, number][] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    const eq = last && (flags.has('i') ? last[0].toLowerCase() === l.toLowerCase() : last[0] === l);
    if (eq) last[1]++;
    else groups.push([l, 1]);
  }
  for (const [l, n] of groups) {
    if (flags.has('d') && n < 2) continue;
    if (flags.has('u') && n > 1) continue;
    ctx.out((flags.has('c') ? `${String(n).padStart(7)} ` : '') + l + '\n');
  }
  return st;
};

const cut: Program = async (ctx) => {
  const { opts, args } = getopt(ctx.argv.slice(1), 'dfcb');
  const delim = opts.get('d') ?? '\t';
  const listSpec = opts.get('f') ?? opts.get('c') ?? opts.get('b') ?? '';
  const ranges = listSpec.split(',').map((r) => {
    const [a, b] = r.split('-');
    const from = a ? Number(a) : 1;
    const to = r.includes('-') ? (b ? Number(b) : Infinity) : from;
    return [from, to] as const;
  });
  const want = (i: number) => ranges.some(([a, b]) => i >= a && i <= b);
  return eachLine(ctx, args, 'cut', (l) => {
    if (opts.has('f')) {
      if (!l.includes(delim)) {
        ctx.out(l + '\n');
        return;
      }
      ctx.out(l.split(delim).filter((_, i) => want(i + 1)).join(delim) + '\n');
    } else ctx.out([...l].filter((_, i) => want(i + 1)).join('') + '\n');
  });
};

function expandTrSet(s: string): string[] {
  const out: string[] = [];
  const classes: Record<string, string> = {
    '[:lower:]': 'abcdefghijklmnopqrstuvwxyz',
    '[:upper:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '[:digit:]': '0123456789',
    '[:space:]': ' \t\n\r\f\v',
    '[:alpha:]': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '[:alnum:]': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  };
  for (let i = 0; i < s.length; i++) {
    const cls = Object.keys(classes).find((k) => s.startsWith(k, i));
    if (cls) {
      out.push(...classes[cls]);
      i += cls.length - 1;
      continue;
    }
    let c = s[i];
    if (c === '\\') {
      const n = s[++i];
      c = n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '\\' ? '\\' : n;
    }
    if (s[i + 1] === '-' && i + 2 < s.length) {
      const end = s[i + 2];
      for (let x = c.charCodeAt(0); x <= end.charCodeAt(0); x++) out.push(String.fromCharCode(x));
      i += 2;
      continue;
    }
    out.push(c);
  }
  return out;
}

const tr: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), '', { complement: 'c', delete: 'd', 'squeeze-repeats': 's', truncate: 't' });
  const complement = flags.has('c') || flags.has('C');
  const del = flags.has('d');
  const set1 = expandTrSet(args[0] ?? '');
  const set2 = expandTrSet(args[1] ?? '');
  if (!args.length || (!del && !flags.has('s') && args.length < 2)) {
    ctx.err(args.length ? `tr: missing operand after '${args[0]}'\n` : 'tr: missing operand\n');
    return 1;
  }
  if (flags.has('t') && !complement) set1.splice(set2.length);
  const inSet1 = (c: string) => set1.includes(c) !== complement;
  // translating: SET2 is padded with its last character; with -c every character outside SET1
  // maps to SET2's last character (the complement is in code point order, longer than any SET2)
  const translating = !del && set2.length > 0;
  const map = (c: string) => {
    if (!translating || !inSet1(c)) return c;
    if (complement) return set2[set2.length - 1];
    return set2[Math.min(set1.lastIndexOf(c), set2.length - 1)];
  };
  // -s squeezes runs of characters in the last set given (SET2 when translating or with -d)
  const squeezeSet = del || translating ? set2 : null;
  const inSqueeze = (c: string) => (squeezeSet ? squeezeSet.includes(c) : inSet1(c));
  const text = await ctx.readAllText(0);
  let out = '';
  let prev: string | null = null;
  for (const c of text) {
    if (del && inSet1(c)) continue;
    const r = map(c);
    if (flags.has('s') && r === prev && inSqueeze(r)) continue;
    out += r;
    prev = r;
  }
  ctx.out(out);
  return 0;
};

type SedRep = { lit: string } | { group: number } | { conv: 'U' | 'L' | 'u' | 'l' | 'E' };

/** The replacement of s///: & and \1…\9, \& and \\, GNU sed's \n \t … and \U \L \u \l \E. */
function compileSedReplacement(rep: string): SedRep[] {
  const out: SedRep[] = [];
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '&') out.push({ group: 0 });
    else if (c === '\\' && i + 1 < rep.length) {
      const n = rep[i + 1];
      const e = sedEscape(rep, i);
      if (/[0-9]/.test(n)) out.push({ group: Number(n) });
      else if ('ULulE'.includes(n)) out.push({ conv: n as 'U' });
      else if (e) {
        out.push({ lit: e.ch });
        i += e.len - 1;
        continue;
      } else out.push({ lit: n });
      i++;
    } else out.push({ lit: c });
  }
  return out;
}

function applySedReplacement(rep: SedRep[], groups: (string | undefined)[]): string {
  let out = '';
  let mode: 'U' | 'L' | null = null;
  let once: 'u' | 'l' | null = null;
  const add = (s: string) => {
    if (mode === 'U') s = s.toUpperCase();
    else if (mode === 'L') s = s.toLowerCase();
    if (once && s) {
      s = (once === 'u' ? s[0].toUpperCase() : s[0].toLowerCase()) + s.slice(1);
      once = null;
    }
    out += s;
  };
  for (const r of rep) {
    if ('lit' in r) add(r.lit);
    else if ('group' in r) add(groups[r.group] ?? '');
    else if (r.conv === 'U' || r.conv === 'L') mode = r.conv;
    else if (r.conv === 'E') mode = null;
    else once = r.conv;
  }
  return out;
}

/** A small sed: s///, d, p, q, y, =, a/i/c text; addresses: N, $, /re/, ranges. */
const sed: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  const scripts: string[] = [];
  const files: string[] = [];
  let quiet = false;
  let inPlace: string | null = null;
  let extended = false;
  // options may be grouped (-ne, -Ei, -i.bak) and come anywhere (GNU); without -e/-f the first
  // operand is the script
  const operands: string[] = [];
  let scriptGiven = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') {
        operands.push(...argv.slice(i + 1));
        break;
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq > 0 ? a.slice(eq + 1) : undefined;
        if (name === 'quiet' || name === 'silent') quiet = true;
        else if (name === 'regexp-extended') extended = true;
        else if (name === 'in-place') inPlace = val ?? '';
        else if (name === 'expression') {
          scripts.push(val ?? argv[++i] ?? '');
          scriptGiven = true;
        } else if (name === 'file') {
          scripts.push(dec.decode(ctx.vfs.readFile(ctx.resolve(val ?? argv[++i] ?? ''))).replace(/\n$/, ''));
          scriptGiven = true;
        }
        continue;
      }
      if (a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'n') quiet = true;
          else if (c === 'E' || c === 'r') extended = true;
          else if (c === 'i') {
            inPlace = a.slice(j + 1);
            break;
          } else if (c === 'e' || c === 'f') {
            const v = j + 1 < a.length ? a.slice(j + 1) : (argv[++i] ?? '');
            scripts.push(c === 'e' ? v : dec.decode(ctx.vfs.readFile(ctx.resolve(v))).replace(/\n$/, ''));
            scriptGiven = true;
            break;
          } else if (!'suz'.includes(c)) throw new Error(`invalid option -- '${c}'`);
        }
        continue;
      }
      operands.push(a);
    }
  } catch (e: any) {
    ctx.err(`sed: ${e.code ? errMsg(e) : e.message}\n`);
    return 1;
  }
  if (!scriptGiven) {
    if (!operands.length) {
      ctx.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n');
      return 1;
    }
    scripts.push(operands.shift()!);
  }
  files.push(...operands);
  type Addr = { line?: number; last?: boolean; re?: RegExp };
  type Cmd = { a1?: Addr; a2?: Addr; neg: boolean; c: string; re?: RegExp; rep?: SedRep[]; global?: boolean; nth?: number; print?: boolean; text?: string; from?: string; to?: string; inRange?: boolean };
  const cmds: Cmd[] = [];
  const toRe = (src: string, flagsStr = '') => new RegExp(posixRegexToJs(src, extended, true), flagsStr);
  const script = scripts.join('\n');
  let p = 0;
  const readDelimited = (delim: string): string => {
    let out = '';
    while (p < script.length && script[p] !== delim) {
      if (script[p] === '\\' && script[p + 1] === delim) {
        out += delim;
        p += 2;
        continue;
      }
      if (script[p] === '\\' && script[p + 1] === 'n') {
        out += '\n';
        p += 2;
        continue;
      }
      if (script[p] === '\\' && p + 1 < script.length) {
        // other escapes (\\ included) pass through whole, so `\\/` doesn't end the part
        out += script.slice(p, p + 2);
        p += 2;
        continue;
      }
      out += script[p++];
    }
    if (p >= script.length) throw new Error(`unterminated expression (missing '${delim}')`);
    p++;
    return out;
  };
  const readAddr = (): Addr | undefined => {
    if (/\d/.test(script[p])) {
      const m = /^\d+/.exec(script.slice(p))!;
      p += m[0].length;
      return { line: Number(m[0]) };
    }
    if (script[p] === '$') {
      p++;
      return { last: true };
    }
    if (script[p] === '/' || script[p] === '\\') {
      const d = script[p] === '\\' ? script[++p] : '/';
      p++;
      const src = readDelimited(d);
      let fl = '';
      if (script[p] === 'I') {
        fl = 'i';
        p++;
      }
      return { re: toRe(src, fl) };
    }
    return undefined;
  };
  try {
    while (p < script.length) {
      while (p < script.length && /[\s;]/.test(script[p])) p++;
      if (p >= script.length) break;
      const cmd: Cmd = { neg: false, c: '' };
      cmd.a1 = readAddr();
      if (cmd.a1 && script[p] === ',') {
        p++;
        cmd.a2 = readAddr();
      }
      while (script[p] === ' ') p++;
      if (script[p] === '!') {
        cmd.neg = true;
        p++;
      }
      cmd.c = script[p++];
      if (cmd.c === 's') {
        const d = script[p++];
        const pat = readDelimited(d);
        let rep = readDelimited(d);
        let fl = '';
        while (p < script.length && /[gipI0-9]/.test(script[p])) {
          const f = script[p++];
          if (f === 'g') cmd.global = true;
          else if (f === 'i' || f === 'I') fl += 'i';
          else if (f === 'p') cmd.print = true;
          else cmd.nth = Number(f);
        }
        cmd.re = toRe(pat, fl + 'g');
        cmd.rep = compileSedReplacement(rep);
      } else if (cmd.c === 'y') {
        const d = script[p++];
        cmd.from = readDelimited(d);
        cmd.to = readDelimited(d);
      } else if (cmd.c === 'a' || cmd.c === 'i' || cmd.c === 'c') {
        if (script[p] === '\\') p++;
        if (script[p] === '\n') p++;
        while (script[p] === ' ') p++;
        let end = script.indexOf('\n', p);
        if (end === -1) end = script.length;
        cmd.text = script.slice(p, end);
        p = end;
      } else if (cmd.c === '{' || cmd.c === '}') {
        // blocks are not supported; ignore braces
      }
      cmds.push(cmd);
    }
  } catch (e: any) {
    ctx.err(`sed: ${e.message}\n`);
    return 1;
  }
  const processText = (text: string): string => {
    const lines = text.split('\n');
    const trailing = lines[lines.length - 1] === '';
    if (trailing) lines.pop();
    let out = '';
    const matchAddr = (a: Addr, n: number, l: string, isLast: boolean) => (a.line !== undefined ? n === a.line : a.last ? isLast : a.re!.test(l));
    for (let n = 1; n <= lines.length; n++) {
      let line = lines[n - 1];
      const isLast = n === lines.length;
      let deleted = false;
      let append = '';
      let quit = false;
      for (const c of cmds) {
        let sel = true;
        if (c.a1 && c.a2) {
          if (c.inRange) {
            sel = true;
            if (matchAddr(c.a2, n, line, isLast) || (c.a2.line !== undefined && n >= c.a2.line)) c.inRange = false;
          } else if (matchAddr(c.a1, n, line, isLast)) {
            sel = true;
            c.inRange = !(c.a2.line !== undefined && c.a2.line <= n);
          } else sel = false;
        } else if (c.a1) sel = matchAddr(c.a1, n, line, isLast);
        if (c.neg) sel = !sel;
        if (!sel) continue;
        switch (c.c) {
          case 's': {
            let count = 0;
            let did = false;
            c.re!.lastIndex = 0;
            line = line.replace(c.re!, (...m) => {
              count++;
              if ((c.nth && count !== c.nth) || (!c.global && !c.nth && count > 1)) return m[0];
              did = true;
              const groups = m.slice(1, -2);
              return applySedReplacement(c.rep!, [m[0], ...groups]);
            });
            if (did && c.print) out += line + '\n';
            break;
          }
          case 'd':
            deleted = true;
            break;
          case 'p':
            out += line + '\n';
            break;
          case '=':
            out += n + '\n';
            break;
          case 'q':
            quit = true;
            break;
          case 'y':
            line = [...line].map((ch) => {
              const i = c.from!.indexOf(ch);
              return i === -1 ? ch : c.to![i];
            }).join('');
            break;
          case 'a':
            append += c.text + '\n';
            break;
          case 'i':
            out += c.text + '\n';
            break;
          case 'c':
            out += c.text + '\n';
            deleted = true;
            break;
        }
        if (deleted || quit) break;
      }
      if (!deleted && !quiet) out += line + (isLast && !trailing ? '' : '\n');
      out += append;
      if (quit) break;
    }
    return out;
  };
  if (inPlace !== null) {
    for (const f of files) {
      const abs = ctx.resolve(f);
      const text = dec.decode(ctx.vfs.readFile(abs));
      if (inPlace) ctx.vfs.writeFile(abs + inPlace, text);
      ctx.vfs.writeFile(abs, processText(text));
    }
    return 0;
  }
  let all = '';
  const st = await eachInput(ctx, files, 'sed', (d) => {
    all += dec.decode(d);
  });
  ctx.out(processText(all));
  return st;
};

/** xargs's input split into items: blanks separate them, quotes and backslashes protect them. */
function xargsItems(input: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" || c === '"') {
      const end = input.indexOf(c, i + 1);
      if (end === -1) throw new Error(`unmatched ${c === '"' ? 'double' : 'single'} quote; by default quotes are special to xargs unless you use the -0 option`);
      cur = (cur ?? '') + input.slice(i + 1, end);
      i = end;
    } else if (c === '\\' && i + 1 < input.length) cur = (cur ?? '') + input[++i];
    else if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

const xargs: Program = async (ctx) => {
  // the options end at the command: `xargs stat -c %F` passes -c to stat
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'nIdPLsEa', { null: '0', 'no-run-if-empty': 'r', 'max-args': 'n', delimiter: 'd', replace: 'I', 'max-lines': 'L', 'max-procs': 'P', verbose: 't', 'arg-file': 'a' }, true);
  let input: string;
  try {
    input = opts.has('a') ? dec.decode(ctx.vfs.readFile(ctx.resolve(opts.get('a')!))) : await ctx.readAllText(0);
  } catch (e) {
    ctx.err(`xargs: ${opts.get('a')}: ${errMsg(e)}\n`);
    return 1;
  }
  const repl = opts.get('I') ?? (flags.has('i') ? '{}' : undefined);
  let items: string[];
  try {
    if (flags.has('0')) items = input.split('\0');
    else if (opts.has('d')) items = input.split(sedEscape(opts.get('d')!, 0)?.ch ?? opts.get('d')![0]);
    // -I takes whole lines (leading blanks dropped)
    else if (repl !== undefined) items = input.split('\n').map((l) => l.replace(/^[ \t]+/, '')).filter((l) => l !== '');
    else items = xargsItems(input);
  } catch (e: any) {
    ctx.err(`xargs: ${e.message}\n`);
    return 1;
  }
  if ((flags.has('0') || opts.has('d')) && items[items.length - 1] === '') items.pop();
  const cmd = args.length ? args : ['echo'];
  const groups: string[][] = [];
  if (repl !== undefined) for (const it of items) groups.push(cmd.map((c) => c.split(repl).join(it)));
  else {
    const n = opts.has('n') ? Math.max(1, Number(opts.get('n'))) : opts.has('L') ? Math.max(1, Number(opts.get('L'))) : items.length || 1;
    // without input the command runs once with no items (GNU), unless -r
    if (!items.length && !flags.has('r')) groups.push(cmd);
    for (let i = 0; i < items.length; i += n) groups.push([...cmd, ...items.slice(i, i + n)]);
  }
  let st = 0;
  for (const g of groups) {
    if (flags.has('t')) ctx.err(g.join(' ') + '\n');
    const p = spawnCommand(ctx, 'xargs', g);
    if (typeof p === 'number') return p;
    const res = await p.exited;
    // GNU: 255 stops xargs with 124, a signal with 125, any other failure gives 123 at the end
    if (res.signal) {
      ctx.err(`xargs: ${g[0]}: terminated by signal ${SIGNALS[res.signal] ?? 15}\n`);
      return 125;
    }
    if (res.code === 255) {
      ctx.err(`xargs: ${g[0]}: exited with status 255; aborting\n`);
      return 124;
    }
    if (res.code) st = 123;
  }
  return st;
};

const tee: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  const files = args.map((f) => ctx.kernel.openFile(ctx.proc, f, 0o1 | 0o100 | (flags.has('a') ? 0o2000 : 0o1000)));
  try {
    for (;;) {
      const d = await ctx.read(0);
      if (!d) break;
      ctx.out(d);
      for (const f of files) f.write(d);
    }
  } finally {
    for (const f of files) f.unref();
  }
  return 0;
};

const env: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  const e: Record<string, string> = { ...ctx.env };
  let i = 0;
  let clear = false;
  let chdir: string | undefined;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i' || a === '-' || a === '--ignore-environment') clear = true;
    else if (a === '-u' || a === '--unset') delete e[argv[++i]];
    else if (/^-u./.test(a) || a.startsWith('--unset=')) delete e[a.slice(a.startsWith('-u') ? 2 : 8)];
    else if (a === '-C' || a === '--chdir') chdir = argv[++i];
    else if (a === '--') {
      i++;
      break;
    }
    else if (a === '-S') {
      const rest = argv.slice(i + 1).join(' ').split(/\s+/);
      argv.splice(i, argv.length - i, ...rest);
      i--;
    } else if (a.includes('=') && !a.startsWith('=')) {
      const eq = a.indexOf('=');
      e[a.slice(0, eq)] = a.slice(eq + 1);
    } else break;
  }
  const env2 = clear ? Object.fromEntries(Object.entries(e).filter(([k]) => argv.slice(0, i).some((a) => a.startsWith(k + '=')))) : e;
  if (i >= argv.length) {
    for (const [k, v] of Object.entries(env2)) ctx.out(`${k}=${v}\n`);
    return 0;
  }
  return runCommand(ctx, 'env', argv.slice(i), { env: env2, cwd: chdir === undefined ? undefined : ctx.resolve(chdir) });
};

const which: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let st = 0;
  for (const a of args) {
    if (flags.has('a')) {
      let found = false;
      for (const dir of (ctx.env.PATH ?? '').split(':')) {
        const p = path.join(dir, a);
        const n = ctx.vfs.tryLookup(p);
        if (n && !isDir(n) && n.mode & 0o111) {
          ctx.out(p + '\n');
          found = true;
        }
      }
      if (!found) st = 1;
      continue;
    }
    const p = ctx.kernel.which(a, ctx.env, ctx.cwd);
    if (p) ctx.out(p + '\n');
    else st = 1;
  }
  return st;
};

const basename: Program = async (ctx) => {
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 's');
  if (flags.has('a') || opts.has('s')) {
    for (const a of args) ctx.out(path.basename(a, opts.get('s')) + '\n');
  } else ctx.out(path.basename(args[0] ?? '', args[1]) + '\n');
  return 0;
};

const dirname: Program = async (ctx) => {
  for (const a of ctx.argv.slice(1)) ctx.out(path.dirname(a) + '\n');
  return 0;
};

const realpath: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let st = 0;
  for (const a of args) {
    try {
      ctx.out(ctx.vfs.realpath(ctx.resolve(a)) + '\n');
    } catch (e) {
      if (flags.has('m')) ctx.out(ctx.resolve(a) + '\n');
      else {
        ctx.err(`realpath: ${a}: ${errMsg(e)}\n`);
        st = 1;
      }
    }
  }
  return st;
};

const readlink: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let st = 0;
  for (const a of args) {
    try {
      if (flags.has('f') || flags.has('e') || flags.has('m')) ctx.out(ctx.vfs.realpath(ctx.resolve(a)) + '\n');
      else ctx.out(ctx.vfs.readlink(ctx.resolve(a)) + '\n');
    } catch {
      st = 1;
    }
  }
  return st;
};

/** The file type as stat %F and file(1) name it. */
function fileTypeName(s: StatData): string {
  switch (s.mode & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFLNK:
      return 'symbolic link';
    case S_IFIFO:
      return 'fifo';
    case S_IFSOCK:
      return 'socket';
    case S_IFCHR:
      return 'character special file';
    case S_IFBLK:
      return 'block special file';
    default:
      return s.size ? 'regular file' : 'regular empty file';
  }
}

const stat: Program = async (ctx) => {
  // -f is "file system", not an option with a value
  // --printf FORMAT and --format FORMAT take the next word
  const argv = ctx.argv.slice(1).flatMap((a, i, arr) => (a === '--printf' || a === '--format' ? [] : arr[i - 1] === '--printf' || arr[i - 1] === '--format' ? [`${arr[i - 1]}=${a}`] : [a]));
  const { opts, args, flags } = getopt(argv, 'c', { format: 'c', dereference: 'L', 'file-system': 'f', terse: 't' });
  if (!args.length) {
    ctx.err('stat: missing operand\n');
    return 1;
  }
  const printf = opts.get('printf');
  const fmt = printf ?? opts.get('c');
  const tz = ctx.env.TZ;
  const time = (ms: number) => strftime('%Y-%m-%d %H:%M:%S.%N %z', new Date(Math.floor(ms)), tz, Math.round((ms % 1000) * 1e6));
  const escapes = (f: string) => f.replace(/\\(n|t|\\|"|0)/g, (_m, c) => ({ n: '\n', t: '\t', '\\': '\\', '"': '"', '0': '\0' })[c as 'n']);
  let st = 0;
  for (const a of args) {
    let s: StatData;
    try {
      s = flags.has('L') || flags.has('f') ? ctx.vfs.stat(ctx.resolve(a)) : ctx.vfs.lstat(ctx.resolve(a));
    } catch (e) {
      ctx.err(`stat: cannot ${flags.has('f') ? 'read file system information for' : 'stat'} '${a}': ${errMsg(e)}\n`);
      st = 1;
      continue;
    }
    if (flags.has('f')) {
      // one in-memory file system
      const fs: Record<string, string> = { n: a, i: '0', l: '255', t: '1021994', T: 'tmpfs', s: '4096', S: '4096', b: '1048576', f: '1048576', a: '1048576', c: '0', d: '0' };
      if (fmt !== undefined) ctx.out((printf !== undefined ? escapes(fmt) : fmt).replace(/%([a-zA-Z%])/g, (_m, c) => (c === '%' ? '%' : (fs[c] ?? '?'))) + (printf !== undefined ? '' : '\n'));
      else ctx.out(`  File: "${a}"\n    ID: 0        Namelen: 255     Type: tmpfs\nBlock size: 4096       Fundamental block size: 4096\nBlocks: Total: 1048576    Free: 1048576    Available: 1048576\nInodes: Total: 0          Free: 0\n`);
      continue;
    }
    const isLnk = (s.mode & S_IFMT) === S_IFLNK;
    const quoted = () => (isLnk ? `'${a}' -> '${ctx.vfs.readlink(ctx.resolve(a))}'` : `'${a}'`);
    const field = (c: string): string => {
      switch (c) {
        case 'a': return (s.mode & 0o7777).toString(8);
        case 'A': return modeString(s.mode);
        case 'b': return String(s.blocks);
        case 'B': return '512';
        case 'd': return String(s.dev);
        case 'D': return s.dev.toString(16);
        case 'f': return s.mode.toString(16);
        case 'F': return fileTypeName(s);
        case 'g': return String(s.gid);
        case 'G': return 'user';
        case 'h': return String(s.nlink);
        case 'i': return String(s.ino);
        case 'n': return a;
        case 'N': return quoted();
        case 'o': return String(s.blksize);
        case 's': return String(s.size);
        case 't': return ((s.rdev >> 8) & 0xfff).toString(16);
        case 'T': return (s.rdev & 0xff).toString(16);
        case 'u': return String(s.uid);
        case 'U': return 'user';
        case 'w': return time(s.birthtimeMs);
        case 'W': return String(Math.floor(s.birthtimeMs / 1000));
        case 'x': return time(s.atimeMs);
        case 'X': return String(Math.floor(s.atimeMs / 1000));
        case 'y': return time(s.mtimeMs);
        case 'Y': return String(Math.floor(s.mtimeMs / 1000));
        case 'z': return time(s.ctimeMs);
        case 'Z': return String(Math.floor(s.ctimeMs / 1000));
        case '%': return '%';
        default: return '?';
      }
    };
    if (fmt !== undefined) {
      ctx.out((printf !== undefined ? escapes(fmt) : fmt).replace(/%([a-zA-Z%])/g, (_m, c) => field(c)) + (printf !== undefined ? '' : '\n'));
      continue;
    }
    if (flags.has('t')) {
      ctx.out(`${a} ${s.size} ${s.blocks} ${s.mode.toString(16)} ${s.uid} ${s.gid} ${s.dev.toString(16)} ${s.ino} ${s.nlink} 0 0 ${field('X')} ${field('Y')} ${field('Z')} ${field('W')} ${s.blksize}\n`);
      continue;
    }
    ctx.out(
      `  File: ${isLnk ? quoted().replace(/'/g, '') : a}\n  Size: ${String(s.size).padEnd(15)} Blocks: ${String(s.blocks).padEnd(10)} IO Block: ${String(s.blksize).padEnd(6)} ${fileTypeName(s)}\n` +
        `Device: ${s.dev.toString(16)}h/${s.dev}d\tInode: ${String(s.ino).padEnd(11)} Links: ${s.nlink}\n` +
        `Access: (${(s.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(s.mode)})  Uid: ( ${String(s.uid).padStart(4)}/    user)   Gid: ( ${String(s.gid).padStart(4)}/    user)\n` +
        `Access: ${time(s.atimeMs)}\nModify: ${time(s.mtimeMs)}\nChange: ${time(s.ctimeMs)}\n Birth: ${time(s.birthtimeMs)}\n`,
    );
  }
  return st;
};

const du: Program = async (ctx) => {
  const { flags, args, opts } = getopt(ctx.argv.slice(1), 'd', { 'max-depth': 'd' });
  const targets = args.length ? args : ['.'];
  const maxDepth = flags.has('s') ? 0 : opts.has('d') ? Number(opts.get('d')) : Infinity;
  const fmt = (n: number) => (flags.has('h') ? humanSize(n) : String(Math.ceil(n / 1024)));
  const walk = (disp: string, abs: string, depth: number): number => {
    const s = ctx.vfs.lstat(abs);
    let total = (s.mode & S_IFMT) === S_IFDIR ? 4096 : s.size;
    if ((s.mode & S_IFMT) === S_IFDIR) {
      for (const n of ctx.vfs.readdir(abs)) total += walk(`${disp}/${n}`, path.join(abs, n), depth + 1);
      if (depth <= maxDepth) ctx.out(`${fmt(total)}\t${disp}\n`);
    } else if (flags.has('a') && depth <= maxDepth) ctx.out(`${fmt(total)}\t${disp}\n`);
    return total;
  };
  for (const t of targets) {
    try {
      const total = walk(t, ctx.resolve(t), 0);
      if (!isDir(ctx.vfs.lookup(ctx.resolve(t), false))) ctx.out(`${fmt(total)}\t${t}\n`);
    } catch (e) {
      ctx.err(`du: ${t}: ${errMsg(e)}\n`);
    }
  }
  return 0;
};

/** Abbreviations Intl doesn't give (it says GMT+9 for Japan): zone → [standard, daylight saving]. */
const ZONE_ABBR: Record<string, [string, string?]> = {
  'Asia/Tokyo': ['JST'], Japan: ['JST'], 'Asia/Seoul': ['KST'], 'Asia/Shanghai': ['CST'], 'Asia/Taipei': ['CST'], 'Asia/Hong_Kong': ['HKT'],
  'Asia/Kolkata': ['IST'], 'Asia/Calcutta': ['IST'], 'Asia/Jakarta': ['WIB'], 'Asia/Manila': ['PST'], 'Europe/Moscow': ['MSK'],
  'Europe/Berlin': ['CET', 'CEST'], 'Europe/Paris': ['CET', 'CEST'], 'Europe/Madrid': ['CET', 'CEST'], 'Europe/Rome': ['CET', 'CEST'],
  'Europe/Amsterdam': ['CET', 'CEST'], 'Europe/Brussels': ['CET', 'CEST'], 'Europe/Vienna': ['CET', 'CEST'], 'Europe/Zurich': ['CET', 'CEST'],
  'Europe/Stockholm': ['CET', 'CEST'], 'Europe/Oslo': ['CET', 'CEST'], 'Europe/Copenhagen': ['CET', 'CEST'], 'Europe/Prague': ['CET', 'CEST'],
  'Europe/Warsaw': ['CET', 'CEST'], 'Europe/Helsinki': ['EET', 'EEST'], 'Europe/Athens': ['EET', 'EEST'], 'Europe/Kyiv': ['EET', 'EEST'],
  'Europe/Kiev': ['EET', 'EEST'], 'Europe/Lisbon': ['WET', 'WEST'], 'Australia/Sydney': ['AEST', 'AEDT'], 'Australia/Melbourne': ['AEST', 'AEDT'],
  'Australia/Brisbane': ['AEST'], 'Australia/Adelaide': ['ACST', 'ACDT'], 'Australia/Perth': ['AWST'], 'Pacific/Auckland': ['NZST', 'NZDT'],
};

/** +09, +0530 (how tzdata names zones without an abbreviation), or +0900 / +09:00 for %z / %:z. */
function zoneOffset(min: number, style: 'name' | 'z' | ':z'): string {
  const a = Math.abs(min);
  const h = String(Math.floor(a / 60)).padStart(2, '0');
  const m = String(a % 60).padStart(2, '0');
  const sign = min < 0 ? '-' : '+';
  if (style === 'name') return sign + h + (a % 60 ? m : '');
  return sign + h + (style === ':z' ? ':' : '') + m;
}

/**
 * The wall clock of `t` in the time zone `tz` (TZ: an IANA name, a POSIX one such as JST-9 or
 * EST5, '' for UTC; the runtime's own zone when unset). `d` is read with the getUTC* methods.
 */
function wallClock(t: Date, tz: string | undefined): { d: Date; offset: number; zone: string } {
  const name = tz?.replace(/^:/, '');
  let iana: string | undefined;
  if (name === undefined) iana = Intl.DateTimeFormat().resolvedOptions().timeZone;
  else if (name) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: name });
      iana = name;
    } catch {}
  }
  if (iana) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: iana, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const offsetAt = (at: Date) => {
      const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
      return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000) / 60000);
    };
    const offset = offsetAt(t);
    let zone = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'short' }).formatToParts(t).find((x) => x.type === 'timeZoneName')?.value ?? '';
    if (/^GMT[+-]/.test(zone) || (zone === 'GMT' && offset !== 0) || !zone) {
      const y = t.getUTCFullYear();
      const dst = offset > Math.min(offsetAt(new Date(Date.UTC(y, 0, 1))), offsetAt(new Date(Date.UTC(y, 6, 1))));
      const known = ZONE_ABBR[iana];
      zone = (known && (dst ? known[1] : known[0])) || zoneOffset(offset, 'name');
    }
    if (/^(Etc\/)?(UTC|UCT|Universal|Zulu)$/.test(iana)) zone = 'UTC';
    return { d: new Date(t.getTime() + offset * 60000), offset, zone };
  }
  // POSIX: NAME followed by the offset west of Greenwich; anything unknown is UTC under that name
  const m = /^([A-Za-z]{3,}|<[^>]+>)(?:([+-]?)(\d{1,2})(?::(\d{2}))?)?/.exec(name ?? '');
  const offset = m?.[3] ? (m[2] === '-' ? 1 : -1) * (Number(m[3]) * 60 + Number(m[4] ?? 0)) : 0;
  return { d: new Date(t.getTime() + offset * 60000), offset, zone: m ? m[1].replace(/^<|>$/g, '') : 'UTC' };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** strftime as GNU date has it (C locale), with the - _ 0 ^ # flags and widths. */
function strftime(fmt: string, t: Date, tz: string | undefined, nanos = (t.getTime() % 1000) * 1e6): string {
  const { d, offset, zone } = wallClock(t, tz);
  const Y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const H = d.getUTCHours();
  const wd = d.getUTCDay();
  const yday = Math.floor((Date.UTC(Y, mo, day) - Date.UTC(Y, 0, 1)) / 86400000);
  // ISO 8601 week and its year
  const thursday = new Date(Date.UTC(Y, mo, day + 3 - ((wd + 6) % 7)));
  const isoYear = thursday.getUTCFullYear();
  const isoWeek = 1 + Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / (7 * 86400000));
  return fmt.replace(/%([-_0^#]*)(\d*)(:{0,3})([a-zA-Z%+])/g, (whole, fl: string, width: string, colons: string, c: string) => {
    // [value, default pad character, default width]
    let v: string | number;
    let pad = '0';
    let w = 2;
    switch (c) {
      case 'a': v = DAYS[wd].slice(0, 3); w = 0; break;
      case 'A': v = DAYS[wd]; w = 0; break;
      case 'b': case 'h': v = MONTH_NAMES[mo].slice(0, 3); w = 0; break;
      case 'B': v = MONTH_NAMES[mo]; w = 0; break;
      case 'c': v = strftime('%a %b %e %H:%M:%S %Y', t, tz); w = 0; break;
      case 'C': v = Math.floor(Y / 100); break;
      case 'd': v = day; break;
      case 'D': case 'x': v = strftime('%m/%d/%y', t, tz); w = 0; break;
      case 'e': v = day; pad = ' '; break;
      case 'F': v = strftime('%Y-%m-%d', t, tz); w = 0; break;
      case 'g': v = isoYear % 100; break;
      case 'G': v = isoYear; w = 4; break;
      case 'H': v = H; break;
      case 'I': v = H % 12 || 12; break;
      case 'j': v = yday + 1; w = 3; break;
      case 'k': v = H; pad = ' '; break;
      case 'l': v = H % 12 || 12; pad = ' '; break;
      case 'm': v = mo + 1; break;
      case 'M': v = d.getUTCMinutes(); break;
      case 'n': v = '\n'; w = 0; break;
      case 'N': v = String(Math.floor(nanos)).padStart(9, '0').slice(0, width ? Number(width) : 9); width = ''; w = 0; break;
      case 'p': v = H < 12 ? 'AM' : 'PM'; w = 0; break;
      case 'P': v = H < 12 ? 'am' : 'pm'; w = 0; break;
      case 'r': v = strftime('%I:%M:%S %p', t, tz); w = 0; break;
      case 'R': v = strftime('%H:%M', t, tz); w = 0; break;
      case 's': v = Math.floor(t.getTime() / 1000); w = 0; break;
      case 'S': v = d.getUTCSeconds(); break;
      case 't': v = '\t'; w = 0; break;
      case 'T': case 'X': v = strftime('%H:%M:%S', t, tz); w = 0; break;
      case 'u': v = wd || 7; w = 1; break;
      case 'U': v = Math.floor((yday + 7 - wd) / 7); break;
      case 'V': v = isoWeek; break;
      case 'w': v = wd; w = 1; break;
      case 'W': v = Math.floor((yday + 7 - ((wd + 6) % 7)) / 7); break;
      case 'y': v = Y % 100; break;
      case 'Y': v = Y; w = 0; break;
      case 'z': v = colons ? zoneOffset(offset, ':z') + (colons.length > 1 ? ':00' : '') : zoneOffset(offset, 'z'); w = 0; break;
      case 'Z': v = zone; w = 0; break;
      case '%': v = '%'; w = 0; break;
      default: return whole;
    }
    let str = String(v);
    if (fl.includes('-')) return str;
    if (fl.includes('_')) pad = ' ';
    else if (fl.includes('0')) pad = '0';
    if (fl.includes('^')) str = str.toUpperCase();
    else if (fl.includes('#')) str = /[a-z]/.test(str) ? str.toUpperCase() : str.toLowerCase();
    const n = width ? Number(width) : w;
    return typeof v === 'number' && v < 0 && pad === '0' ? '-' + String(-v).padStart(n - 1, '0') : str.padStart(n, pad);
  });
}

const date: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  let utc = false;
  let when: string | undefined;
  let ref: string | undefined;
  let fmt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-u' || a === '--utc' || a === '--universal') utc = true;
    else if (a === '-d' || a === '--date') when = argv[++i];
    else if (a.startsWith('--date=')) when = a.slice(7);
    else if (/^-d./.test(a)) when = a.slice(2);
    else if (a === '-r' || a === '--reference') ref = argv[++i];
    else if (a.startsWith('--reference=')) ref = a.slice(12);
    else if (a === '-R' || a === '--rfc-email') fmt = '%a, %d %b %Y %H:%M:%S %z';
    else if (/^(-I|--iso-8601)/.test(a)) {
      const spec = a.startsWith('-I') ? a.slice(2) : a.slice(11).replace(/^=/, '');
      const parts = { '': '%Y-%m-%d', date: '%Y-%m-%d', hours: '%Y-%m-%dT%H%:z', minutes: '%Y-%m-%dT%H:%M%:z', seconds: '%Y-%m-%dT%H:%M:%S%:z', ns: '%Y-%m-%dT%H:%M:%S,%N%:z' } as Record<string, string>;
      fmt = parts[spec];
      if (!fmt) {
        ctx.err(`date: invalid argument '${spec}' for '--iso-8601'\n`);
        return 1;
      }
    } else if (a.startsWith('+')) fmt = a.slice(1);
    else {
      ctx.err(`date: invalid date '${a}'\n`);
      return 1;
    }
  }
  const tz = utc ? 'UTC0' : ctx.env.TZ;
  let t = new Date();
  if (ref !== undefined) {
    try {
      t = new Date(ctx.vfs.stat(ctx.resolve(ref)).mtimeMs);
    } catch (e) {
      ctx.err(`date: ${ref}: ${errMsg(e)}\n`);
      return 1;
    }
  }
  if (when !== undefined) {
    const v = when.trim();
    const rel = /^(now|today)$/i.test(v) ? 0 : /^tomorrow$/i.test(v) ? 86400000 : /^yesterday$/i.test(v) ? -86400000 : null;
    if (rel !== null) t = new Date(Date.now() + rel);
    else if (v.startsWith('@') && /^@-?\d+(\.\d+)?$/.test(v)) t = new Date(Number(v.slice(1)) * 1000);
    else {
      // a date without a zone is wall time in TZ, not UTC as Date.parse reads 2026-01-01
      const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
      if (local) {
        const guess = Date.UTC(+local[1], +local[2] - 1, +local[3], +(local[4] ?? 0), +(local[5] ?? 0), +(local[6] ?? 0));
        t = new Date(guess - wallClock(new Date(guess), tz).offset * 60000);
        t = new Date(guess - wallClock(t, tz).offset * 60000);
      } else t = new Date(v);
    }
    if (Number.isNaN(t.getTime())) {
      ctx.err(`date: invalid date '${when}'\n`);
      return 1;
    }
  }
  ctx.out(strftime(fmt ?? '%a %b %e %H:%M:%S %Z %Y', t, tz) + '\n');
  return 0;
};

const sleep: Program = async (ctx) => {
  let ms = 0;
  const argv = ctx.argv.slice(1);
  if (!argv.length) {
    ctx.err('sleep: missing operand\n');
    return 1;
  }
  for (const a of argv) {
    const d = parseDuration(a);
    if (d === null) {
      ctx.err(`sleep: invalid time interval '${a}'\n`);
      return 1;
    }
    ms += d;
  }
  await new Promise<void>((resolve) => {
    const t = ms === Infinity ? undefined : setTimeout(resolve, ms);
    ctx.signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
  return 0;
};

const uname: Program = async (ctx) => {
  const { flags } = getopt(ctx.argv.slice(1));
  const parts: string[] = [];
  const all = flags.has('a');
  if (all || flags.has('s') || flags.size === 0) parts.push('Linux');
  if (all || flags.has('n')) parts.push(ctx.kernel.hostname);
  if (all || flags.has('r')) parts.push('6.1.0-openvessel');
  if (all || flags.has('v')) parts.push('#1 SMP');
  if (all || flags.has('m') || flags.has('p')) parts.push('x86_64');
  if (all || flags.has('o')) parts.push('GNU/Linux');
  ctx.out(parts.join(' ') + '\n');
  return 0;
};

const ps: Program = async (ctx) => {
  ctx.out('  PID  PPID CMD\n');
  for (const p of ctx.kernel.procs.values()) {
    if (p.state !== 'running') continue;
    ctx.out(`${String(p.pid).padStart(5)} ${String(p.ppid).padStart(5)} ${p.argv.join(' ')}\n`);
  }
  return 0;
};

const kill: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  const names = Object.keys(SIGNALS);
  if (/^(-l|-L|--list|--table)$/.test(args[0] ?? '')) {
    if (args.length === 1) {
      if (args[0] === '-L' || args[0] === '--table') ctx.out(names.map((k) => `${String(SIGNALS[k]).padStart(2)} ${k.slice(3)}`).join('\n') + '\n');
      else ctx.out(names.map((k) => k.slice(3)).join(' ') + '\n');
      return 0;
    }
    // kill -l 15 / kill -l 143 (an exit status) gives the name, kill -l TERM the number
    let st = 0;
    for (const a of args.slice(1)) {
      const n = /^\d+$/.test(a) ? Number(a) & 127 : parseSignal(a);
      const k = names.find((x) => SIGNALS[x] === n);
      if (n === null || (/^\d+$/.test(a) && !k)) {
        ctx.err(`kill: ${a}: invalid signal specification\n`);
        st = 1;
      } else ctx.out((/^\d+$/.test(a) ? k!.slice(3) : String(n)) + '\n');
    }
    return st;
  }
  let sig: number | null = 15;
  let i = 0;
  if (args[0] === '-s' || args[0] === '-n' || args[0] === '--signal') {
    if (args.length < 2) {
      ctx.err(`kill: ${args[0]}: option requires an argument\n`);
      return 2;
    }
    sig = parseSignal(args[1]);
    i = 2;
  } else if (args[0]?.startsWith('--signal=')) {
    sig = parseSignal(args[0].slice(9));
    i = 1;
  } else if (args[0] && args[0] !== '--' && /^-./.test(args[0])) {
    // -9, -KILL, -SIGKILL
    sig = parseSignal(args[0].slice(1));
    i = 1;
  }
  if (sig === null) {
    ctx.err(`kill: ${args[i - 1].replace(/^-(?!-)/, '').replace(/^--signal=/, '')}: invalid signal specification\n`);
    return 1;
  }
  if (args[i] === '--') i++;
  const pids = args.slice(i);
  if (!pids.length) {
    ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid ... or kill -l [sigspec]\n');
    return 2;
  }
  let st = 0;
  for (const a of pids) {
    if (!/^-?\d+$/.test(a)) {
      ctx.err(`kill: ${a}: arguments must be process or job IDs\n`);
      st = 1;
      continue;
    }
    const pid = Number(a);
    const running = [...ctx.kernel.procs.values()].filter((p) => p.state === 'running');
    // 0: the caller's process group; -1: every process but the caller; -N: process group N
    const targets =
      pid > 0 ? running.filter((p) => p.pid === pid) : pid === 0 ? running.filter((p) => p.pgid === ctx.proc.pgid) : pid === -1 ? running.filter((p) => p.pid !== ctx.proc.pid) : running.filter((p) => p.pgid === -pid);
    if (!targets.length) {
      ctx.err(`kill: (${a}) - No such process\n`);
      st = 1;
      continue;
    }
    // signal 0 only checks that the process exists
    if (sig) for (const p of targets) ctx.kernel.kill(p.pid, signalName(sig));
  }
  return st;
};

const seq: Program = async (ctx) => {
  // negative numbers are operands, not options
  const argv = ctx.argv.slice(1);
  let sep = '\n';
  let fmt: string | undefined;
  let equalWidth = false;
  const nums: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (nums.length || /^-\.?\d/.test(a) || !a.startsWith('-') || a === '-') nums.push(a);
    else if (a === '--') {
      nums.push(...argv.slice(i + 1));
      break;
    }
    else if (a === '-w' || a === '--equal-width') equalWidth = true;
    else if (a.startsWith('--separator=')) sep = a.slice(12);
    else if (a.startsWith('--format=')) fmt = a.slice(9);
    else if (a === '-s' || a === '--separator' || a === '-f' || a === '--format') {
      if (i + 1 >= argv.length) {
        ctx.err(`seq: option requires an argument -- '${a.replace(/^-+/, '')[0]}'\n`);
        return 1;
      }
      if (a[1] === 's' || a === '--separator') sep = argv[++i];
      else fmt = argv[++i];
    } else if (/^-[sf]/.test(a)) {
      if (a[1] === 's') sep = a.slice(2);
      else fmt = a.slice(2);
    } else {
      ctx.err(`seq: invalid option -- '${a.slice(1)}'\n`);
      return 1;
    }
  }
  if (!nums.length || nums.length > 3) {
    ctx.err(nums.length ? `seq: extra operand '${nums[3]}'\n` : 'seq: missing operand\n');
    return 1;
  }
  for (const n of nums) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(n)) {
      ctx.err(`seq: invalid floating point argument: '${n}'\n`);
      return 1;
    }
  }
  const [firstS, incS, lastS] = nums.length === 1 ? ['1', '1', nums[0]] : nums.length === 2 ? [nums[0], '1', nums[1]] : nums;
  const first = Number(firstS);
  const inc = Number(incS);
  const last = Number(lastS);
  if (inc === 0) {
    ctx.err(`seq: invalid Zero increment value: '${incS}'\n`);
    return 1;
  }
  // as many decimals as FIRST and INCREMENT have
  const decimals = (x: string) => (/e/i.test(x) ? 0 : (x.split('.')[1]?.length ?? 0));
  const prec = Math.max(decimals(firstS), decimals(incS));
  const show = (x: number) => {
    if (fmt) return fmt.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([fgeFGE])/, (_m, fl: string, w: string, p: string | undefined, conv: string) => {
      let v = /[fF]/.test(conv) ? x.toFixed(p === undefined ? 6 : Number(p)) : /[eE]/.test(conv) ? x.toExponential(p === undefined ? 6 : Number(p)) : String(Number(x.toPrecision(Number(p ?? 6) || 1)));
      if (fl.includes('+') && x >= 0) v = '+' + v;
      if (w) v = fl.includes('-') ? v.padEnd(Number(w)) : fl.includes('0') ? (v.startsWith('-') ? '-' + v.slice(1).padStart(Number(w) - 1, '0') : v.padStart(Number(w), '0')) : v.padStart(Number(w));
      return v.replace(/%%/g, '%');
    });
    return x.toFixed(prec);
  };
  const out: string[] = [];
  for (let k = 0; ; k++) {
    // first + k*inc, not a running sum, so decimals don't drift
    const x = first + k * inc;
    if (inc > 0 ? x > last + 1e-10 * Math.abs(inc) : x < last - 1e-10 * Math.abs(inc)) break;
    out.push(show(x));
  }
  if (equalWidth && !fmt) {
    const w = Math.max(...out.map((o) => o.length));
    for (let k = 0; k < out.length; k++) out[k] = out[k].startsWith('-') ? '-' + out[k].slice(1).padStart(w - 1, '0') : out[k].padStart(w, '0');
  }
  if (out.length) ctx.out(out.join(sep) + '\n');
  return 0;
};

const yes: Program = async (ctx) => {
  const s = (ctx.argv.slice(1).join(' ') || 'y') + '\n';
  const chunk = enc.encode(s.repeat(Math.max(1, Math.floor(4096 / s.length))));
  while (!ctx.signal.aborted) {
    ctx.out(chunk);
    await new Promise((r) => setTimeout(r, 0));
  }
  return 0;
};

const mktemp: Program = async (ctx) => {
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'p');
  const tmpl = args[0] ?? 'tmp.XXXXXXXXXX';
  const dir = opts.get('p') ?? (flags.has('t') || !args[0] ? (ctx.env.TMPDIR ?? '/tmp') : '');
  const name = tmpl.replace(/X+$/, (m) => Array.from({ length: m.length }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''));
  const full = ctx.resolve(dir ? path.join(dir, name) : name);
  if (flags.has('d')) ctx.vfs.mkdir(full, 0o700);
  else ctx.vfs.createFile(full, 0o600, { excl: true });
  ctx.out(full + '\n');
  return 0;
};

const base64: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let data: Uint8Array = new Uint8Array(0);
  await eachInput(ctx, args, 'base64', (d) => {
    data = d;
  });
  if (flags.has('d')) {
    const bin = atob(dec.decode(data).replace(/\s+/g, ''));
    ctx.out(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } else {
    let s = '';
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const b = btoa(s);
    ctx.out((flags.has('w') ? b : b.replace(/(.{76})/g, '$1\n')) + '\n');
  }
  return 0;
};

function hashProgram(algo: string): Program {
  return async (ctx) => {
    const { args } = getopt(ctx.argv.slice(1));
    const results: string[] = [];
    const st = await eachInput(ctx, args, ctx.argv[0], async (d, f) => {
      let hex: string;
      if (algo === 'MD5') {
        const { md5 } = await import('@noble/hashes/legacy.js');
        hex = [...md5(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
      } else {
        const h = new Uint8Array(await crypto.subtle.digest(algo, d.slice() as unknown as ArrayBuffer));
        hex = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
      }
      results.push(`${hex}  ${f}`);
    });
    if (results.length) ctx.out(results.join('\n') + '\n');
    return st;
  };
}

/**
 * The shortest edit script from `a` to `b` (Myers): ' ' keeps a line, '-' deletes one of `a`,
 * '+' inserts one of `b`. null when the files differ too much to keep the search's trace.
 */
function editScript(a: string[], b: string[]): string[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if ((d + 1) * v.length > 3e7) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  const ops: string[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = d ? vd[off + prevK] : 0;
    const prevY = d ? prevX - prevK : 0;
    while (x > prevX && y > prevY) {
      ops.push(' ');
      x--;
      y--;
    }
    if (d) ops.push(x === prevX ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

const diff: Program = async (ctx) => {
  const argv = ctx.argv.slice(1).map((a) => (a === '--unified' ? '-u' : a));
  const { args, flags, opts, all } = getopt(argv, 'UL', { unified: 'U', brief: 'q', 'report-identical-files': 's', 'ignore-case': 'i', 'ignore-all-space': 'w', 'ignore-space-change': 'b', label: 'L', text: 'a' });
  if (args.length !== 2) {
    ctx.err(args.length > 2 ? `diff: extra operand '${args[2]}'\n` : `diff: missing operand after '${args[0] ?? 'diff'}'\n`);
    return 2;
  }
  const files: { data: Uint8Array; mtime: number }[] = [];
  for (const f of args) {
    try {
      if (f === '-') files.push({ data: await ctx.readAll(0), mtime: Date.now() });
      else {
        const abs = ctx.resolve(f);
        const st = ctx.vfs.stat(abs);
        if ((st.mode & S_IFMT) === S_IFDIR) throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
        files.push({ data: ctx.vfs.readFile(abs), mtime: st.mtimeMs });
      }
    } catch (e) {
      ctx.err(`diff: ${f}: ${errMsg(e)}\n`);
      return 2;
    }
  }
  const [A, B] = files;
  const same = A.data.length === B.data.length && A.data.every((x, i) => x === B.data[i]);
  if (!flags.has('a') && (A.data.includes(0) || B.data.includes(0))) {
    if (same) return 0;
    ctx.out(`Binary files ${args[0]} and ${args[1]} differ\n`);
    return 1;
  }
  const split = (d: Uint8Array) => {
    const lines = dec.decode(d).split('\n');
    const noeol = lines[lines.length - 1] !== '';
    if (!noeol) lines.pop();
    return { lines, noeol };
  };
  const a = split(A.data);
  const b = split(B.data);
  const norm = (l: string) => {
    if (flags.has('w')) l = l.replace(/\s+/g, '');
    else if (flags.has('b')) l = l.replace(/\s+/g, ' ').replace(/ $/, '');
    return flags.has('i') ? l.toLowerCase() : l;
  };
  // a last line without a newline differs from the same line with one
  const keys = (x: { lines: string[]; noeol: boolean }) => x.lines.map((l, i) => norm(l) + (x.noeol && i === x.lines.length - 1 ? '\0' : ''));
  const ka = keys(a);
  const kb = keys(b);
  let pre = 0;
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++;
  let suf = 0;
  while (suf < ka.length - pre && suf < kb.length - pre && ka[ka.length - 1 - suf] === kb[kb.length - 1 - suf]) suf++;
  if (pre + suf === ka.length && pre + suf === kb.length) {
    if (flags.has('s')) ctx.out(`Files ${args[0]} and ${args[1]} are identical\n`);
    return 0;
  }
  if (flags.has('q')) {
    ctx.out(`Files ${args[0]} and ${args[1]} differ\n`);
    return 1;
  }
  const midA = ka.slice(pre, ka.length - suf);
  const midB = kb.slice(pre, kb.length - suf);
  // too different to search: replace the whole middle
  const mid = editScript(midA, midB) ?? [...midA.map(() => '-'), ...midB.map(() => '+')];
  const ops = [...Array(pre).fill(' '), ...mid, ...Array(suf).fill(' ')];
  // the changes as blocks of a[i1, i2) replaced by b[j1, j2)
  const blocks: { i1: number; i2: number; j1: number; j2: number }[] = [];
  let i = 0;
  let j = 0;
  for (let k = 0; k < ops.length; ) {
    if (ops[k] === ' ') {
      i++;
      j++;
      k++;
      continue;
    }
    const blk = { i1: i, i2: i, j1: j, j2: j };
    for (; k < ops.length && ops[k] !== ' '; k++) {
      if (ops[k] === '-') blk.i2 = ++i;
      else blk.j2 = ++j;
    }
    blocks.push(blk);
  }
  const line = (x: { lines: string[]; noeol: boolean }, idx: number, prefix: string) => {
    ctx.out(prefix + x.lines[idx] + '\n');
    if (x.noeol && idx === x.lines.length - 1) ctx.out('\\ No newline at end of file\n');
  };
  if (!flags.has('u') && !opts.has('U')) {
    // normal format: 3,5c3,4 / 2a3 / 4d3
    const range = (s0: number, e: number) => (e - s0 === 1 ? `${s0 + 1}` : `${s0 + 1},${e}`);
    for (const k of blocks) {
      if (k.i1 === k.i2) ctx.out(`${k.i1}a${range(k.j1, k.j2)}\n`);
      else if (k.j1 === k.j2) ctx.out(`${range(k.i1, k.i2)}d${k.j1}\n`);
      else ctx.out(`${range(k.i1, k.i2)}c${range(k.j1, k.j2)}\n`);
      for (let x = k.i1; x < k.i2; x++) line(a, x, '< ');
      if (k.i1 !== k.i2 && k.j1 !== k.j2) ctx.out('---\n');
      for (let x = k.j1; x < k.j2; x++) line(b, x, '> ');
    }
    return 1;
  }
  const C = opts.has('U') ? Math.max(0, Number(opts.get('U')) || 0) : 3;
  const labels = all.get('L') ?? [];
  const stamp = (f: { mtime: number }) => strftime('%Y-%m-%d %H:%M:%S.%N %z', new Date(Math.floor(f.mtime)), ctx.env.TZ, Math.round((f.mtime % 1000) * 1e6));
  ctx.out(`--- ${labels[0] ?? `${args[0]}\t${stamp(A)}`}\n+++ ${labels[1] ?? `${args[1]}\t${stamp(B)}`}\n`);
  // blocks closer than twice the context share a hunk
  for (let h = 0; h < blocks.length; ) {
    let last = h;
    while (last + 1 < blocks.length && blocks[last + 1].i1 - blocks[last].i2 <= 2 * C) last++;
    const aStart = Math.max(0, blocks[h].i1 - C);
    const aEnd = Math.min(a.lines.length, blocks[last].i2 + C);
    const bStart = blocks[h].j1 - (blocks[h].i1 - aStart);
    const bEnd = blocks[last].j2 + (aEnd - blocks[last].i2);
    const head = (s0: number, e: number) => `${e - s0 ? s0 + 1 : s0}${e - s0 === 1 ? '' : `,${e - s0}`}`;
    ctx.out(`@@ -${head(aStart, aEnd)} +${head(bStart, bEnd)} @@\n`);
    let x = aStart;
    for (let k = h; k <= last; k++) {
      const blk = blocks[k];
      for (; x < blk.i1; x++) line(a, x, ' ');
      for (let y = blk.i1; y < blk.i2; y++) line(a, y, '-');
      for (let y = blk.j1; y < blk.j2; y++) line(b, y, '+');
      x = blk.i2;
    }
    for (; x < aEnd; x++) line(a, x, ' ');
    h = last + 1;
  }
  return 1;
};

const clear: Program = async (ctx) => {
  ctx.out('\x1b[H\x1b[2J\x1b[3J');
  return 0;
};

const nproc: Program = async (ctx) => {
  ctx.out(`${navigator.hardwareConcurrency || 4}\n`);
  return 0;
};

/** Programs that reuse the shell builtins (echo, printf, test, [, true, false). */
function shellBuiltinProgram(name: string): Program {
  return async (ctx) => {
    const sh = new Shell(ctx);
    try {
      return await BUILTINS[name](sh, ctx.argv.slice(1));
    } finally {
      sh.releaseFds();
    }
  };
}

const timeProg: Program = async (ctx) => {
  const t0 = performance.now();
  const code = ctx.argv.length > 1 ? await runCommand(ctx, 'time', ctx.argv.slice(1)) : 0;
  const dt = (performance.now() - t0) / 1000;
  ctx.err(`\nreal\t${Math.floor(dt / 60)}m${(dt % 60).toFixed(3)}s\n`);
  return code;
};

const timeout: Program = async (ctx) => {
  // the options end at the duration; everything after it is the command and its own options
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'sk', { signal: 's', 'kill-after': 'k', 'preserve-status': 'preserve-status', foreground: 'foreground', verbose: 'v' }, true);
  if (args.length < 2) {
    ctx.err(args.length ? `timeout: missing operand after '${args[0]}'\n` : 'timeout: missing operand\n');
    return 125;
  }
  const ms = parseDuration(args[0]);
  const killAfter = opts.has('k') ? parseDuration(opts.get('k')!) : null;
  if (ms === null || (opts.has('k') && killAfter === null)) {
    ctx.err(`timeout: invalid time interval '${ms === null ? args[0] : opts.get('k')}'\n`);
    return 125;
  }
  const sig = opts.has('s') ? parseSignal(opts.get('s')!) : 15;
  if (sig === null) {
    ctx.err(`timeout: ${opts.get('s')}: invalid signal\n`);
    return 125;
  }
  const p = spawnCommand(ctx, 'timeout', args.slice(1));
  if (typeof p === 'number') return p;
  let timedOut = false;
  let killed = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const send = (s: string) => {
    try {
      ctx.kernel.kill(p.pid, s);
    } catch {}
  };
  // a duration of 0 disables the timeout
  if (ms > 0)
    timers.push(
      setTimeout(() => {
        timedOut = true;
        if (flags.has('v')) ctx.err(`timeout: sending signal ${signalName(sig).slice(3)} to command '${args[1]}'\n`);
        if (sig) send(signalName(sig));
        if (killAfter !== null)
          timers.push(
            setTimeout(() => {
              killed = true;
              if (flags.has('v')) ctx.err(`timeout: sending signal KILL to command '${args[1]}'\n`);
              send('SIGKILL');
            }, killAfter),
          );
      }, ms),
    );
  const st = await p.exited;
  for (const t of timers) clearTimeout(t);
  if (!timedOut || flags.has('preserve-status')) return exitCodeOf(st);
  // KILL can't be caught, so GNU timeout dies of it as well: 128+9
  return killed || sig === 9 ? 137 : 124;
};

const id: Program = async (ctx) => {
  const a = ctx.argv.slice(1);
  if (a.includes('-u')) ctx.out('1000\n');
  else if (a.includes('-g')) ctx.out('1000\n');
  else if (a.includes('-un') || a.includes('-nu')) ctx.out('user\n');
  else ctx.out('uid=1000(user) gid=1000(user) groups=1000(user)\n');
  return 0;
};

const df: Program = async (ctx) => {
  ctx.out('Filesystem     1K-blocks  Used Available Use% Mounted on\nvfs              4194304     0   4194304   0% /\n');
  return 0;
};

const free: Program = async (ctx) => {
  ctx.out('               total        used        free\nMem:         4194304           0     4194304\n');
  return 0;
};

const hostname: Program = async (ctx) => {
  ctx.out(ctx.kernel.hostname + '\n');
  return 0;
};

const whoami: Program = async (ctx) => {
  ctx.out('user\n');
  return 0;
};

const tty: Program = async (ctx) => {
  const silent = ctx.argv.slice(1).some((a) => a === '-s' || a === '--silent' || a === '--quiet');
  if (ctx.isatty(0)) {
    // a process's terminal is /dev/tty (also what /proc/self/fd/N links to); there is no /dev/pts
    if (!silent) ctx.out('/dev/tty\n');
    return 0;
  }
  if (!silent) ctx.out('not a tty\n');
  return 1;
};

const stty: Program = async (ctx) => {
  const tty = ctx.proc.fds.get(0)?.opts.tty;
  if (!tty) return 1;
  const a = ctx.argv.slice(1);
  if (a[0] === 'size') ctx.out(`${tty.rows} ${tty.cols}\n`);
  else if (a.includes('raw')) tty.raw = true;
  else if (a.includes('-raw') || a.includes('sane') || a.includes('cooked')) tty.raw = false;
  if (a.includes('-echo')) tty.echo = false;
  if (a.includes('echo')) tty.echo = true;
  return 0;
};

const nohup: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  if (argv[0] === '--') argv.shift();
  if (!argv.length) {
    ctx.err('nohup: missing operand\n');
    return 125;
  }
  return runCommand(ctx, 'nohup', argv);
};

/** nice [-n N] COMMAND: there is no scheduler priority here, so the command just runs. */
const nice: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--adjustment') i++;
    else if (/^-n-?\d+$/.test(a) || /^--adjustment=/.test(a) || /^--?\d+$/.test(a)) continue;
    else if (a === '--') {
      i++;
      break;
    } else break;
  }
  if (i >= argv.length) {
    ctx.out('0\n');
    return 0;
  }
  return runCommand(ctx, 'nice', argv.slice(i));
};

const less: Program = async (ctx) => cat(ctx);

const file: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), '', { brief: 'b', dereference: 'L', 'mime-type': 'mime-type' });
  if (!args.length) {
    ctx.err('Usage: file [-bL] file ...\n');
    return 1;
  }
  for (const a of args) {
    let what: string;
    try {
      const n = ctx.vfs.lookup(ctx.resolve(a), flags.has('L'));
      const t = n.mode & S_IFMT;
      if (t === S_IFDIR) what = 'directory';
      else if (t === S_IFLNK) what = `symbolic link to ${n.target}`;
      else if (t === S_IFIFO) what = 'fifo (named pipe)';
      else if (t === S_IFSOCK) what = 'socket';
      else if (t === S_IFCHR || t === S_IFBLK) {
        const rdev = ctx.vfs.stat(ctx.resolve(a)).rdev;
        what = `${t === S_IFCHR ? 'character' : 'block'} special (${(rdev >> 8) & 0xfff}/${rdev & 0xff})`;
      } else {
        const d = ctx.vfs.readFile(ctx.resolve(a)).subarray(0, 4096);
        const text = dec.decode(d);
        if (d.length === 0) what = 'empty';
        else if (d.includes(0)) what = 'data';
        else if (text.startsWith('#!')) what = `${text.slice(2).split('\n')[0].trim().split(/\s+/).pop()} script, ASCII text executable`;
        else what = /[^\x00-\x7f]/.test(text) ? (text.includes('�') ? 'ISO-8859 text' : 'Unicode text, UTF-8 text') : 'ASCII text';
      }
    } catch (e) {
      what = `cannot open \`${a}' (${errMsg(e)})`;
    }
    ctx.out(flags.has('b') ? `${what}\n` : `${a}: ${what}\n`);
  }
  return 0;
};

const rev: Program = async (ctx) => eachLine(ctx, ctx.argv.slice(1), 'rev', (l) => {
  ctx.out([...l].reverse().join('') + '\n');
});

const nl: Program = async (ctx) => {
  let n = 1;
  return eachLine(ctx, ctx.argv.slice(1), 'nl', (l) => {
    ctx.out(l.trim() ? `${String(n++).padStart(6)}\t${l}\n` : '\n');
  });
};

const truncateProg: Program = async (ctx) => {
  const { opts, args } = getopt(ctx.argv.slice(1), 's');
  const size = Number(opts.get('s') ?? 0);
  for (const a of args) {
    const abs = ctx.resolve(a);
    if (!ctx.vfs.exists(abs)) ctx.vfs.createFile(abs);
    ctx.vfs.truncate(abs, size);
  }
  return 0;
};

const sha256sum = hashProgram('SHA-256');

export function installCoreutils(kernel: Kernel) {
  const progs: Record<string, Program> = {
    ls, cat, mkdir, mkfifo, rm, rmdir, cp, mv, touch, ln, chmod, head, tail, wc, grep, egrep: grep, fgrep: grep, find, sort, uniq, cut, tr, sed, xargs, tee, env, which, basename, dirname, realpath, readlink, stat, du, df, free, date, sleep, uname, ps, kill, seq, yes, mktemp, base64, diff, clear, nproc, id, hostname, whoami, tty, stty, nohup, nice, less, more: less, file, rev, nl, timeout, time: timeProg, truncate: truncateProg,
    sha256sum, sha1sum: hashProgram('SHA-1'), sha512sum: hashProgram('SHA-512'), md5sum: hashProgram('MD5'),
    echo: shellBuiltinProgram('echo'), printf: shellBuiltinProgram('printf'), test: shellBuiltinProgram('test'), '[': shellBuiltinProgram('['), true: shellBuiltinProgram('true'), false: shellBuiltinProgram('false'), pwd: shellBuiltinProgram('pwd'),
    chown: async () => 0, sync: async () => 0, true_: async () => 0,
  };
  delete progs.true_;
  for (const [name, fn] of Object.entries(progs)) kernel.registerProgram(name, fn, ['/bin']);
  // `env` must live in /usr/bin for shebangs
  kernel.vfs.writeFile('/usr/bin/env', '#!/ov/builtin env\n', 0o755);
  kernel.vfs.chmod('/usr/bin/env', 0o755);
}

void O_RDONLY;
