// POSIX-ish utilities implemented as kernel programs.

import * as path from '../shared/path.ts';
import { O_RDONLY } from './io.ts';
import type { Kernel, Program, ProgramContext } from './kernel.ts';
import { exitCodeOf, signalName } from './proc.ts';
import { BUILTINS, Shell } from './sh/interp.ts';
import { matchPattern } from './sh/pattern.ts';
import { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, type StatData, isDir, isLink } from './vfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Parsed {
  flags: Set<string>;
  opts: Map<string, string>;
  args: string[];
}

/** Small getopt: `spec` lists short flags; `withArg` flags that take a value. */
function getopt(argv: string[], withArg = '', longMap: Record<string, string> = {}): Parsed {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  const args: string[] = [];
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
      if (eq > 0) opts.set(mapped, a.slice(eq + 1));
      else if (withArg.includes(mapped) && mapped.length === 1) opts.set(mapped, argv[++i] ?? '');
      else flags.add(mapped);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withArg.includes(c)) {
          const v = a.slice(j + 1) || argv[++i] || '';
          opts.set(c, v);
          break;
        }
        flags.add(c);
      }
      continue;
    }
    args.push(a);
  }
  return { flags, opts, args };
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
    default:
      return e?.message ?? String(e);
  }
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
  const c = t === S_IFDIR ? 'd' : t === S_IFLNK ? 'l' : t === S_IFREG ? '-' : t === 0o020000 ? 'c' : t === 0o010000 ? 'p' : '?';
  let s = c;
  const bits = 'rwxrwxrwx';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  return s;
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
    printEntries(names.map((n) => ({ name: n, full: path.join(abs, n) })));
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
  const printEntries = (entries: { name: string; full: string }[]) => {
    if (long) {
      const rows = entries.map((e) => {
        const s = vfs.lstat(e.full);
        let name = fmtName(e.name, s, e.full);
        if ((s.mode & S_IFMT) === S_IFLNK) name += ` -> ${vfs.readlink(e.full)}`;
        return [modeString(s.mode), String(s.nlink), 'user', 'user', flags.has('h') ? humanSize(s.size) : String(s.size), lsDate(s.mtimeMs), name];
      });
      const total = entries.reduce((a, e) => a + Math.ceil(vfs.lstat(e.full).size / 1024), 0);
      ctx.out(`total ${total}\n`);
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
  printEntries(files);
  dirs.forEach((d, i) => {
    if (i > 0 || files.length) ctx.out('\n');
    listDir(d, targets.length > 1 || flags.has('R'));
  });
  return st;
};

const cat: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1));
  let lineNo = 1;
  return eachInput(ctx, args, 'cat', (d) => {
    if (flags.has('n')) {
      const text = dec.decode(d);
      const lines = text.split('\n');
      const last = lines.pop();
      ctx.out(lines.map((l) => `${String(lineNo++).padStart(6)}\t${l}\n`).join('') + (last ? `${String(lineNo++).padStart(6)}\t${last}` : ''));
    } else ctx.out(d);
  });
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

const rm: Program = async (ctx) => {
  const { flags, args } = getopt(ctx.argv.slice(1), '', { recursive: 'r', force: 'f' });
  const recursive = flags.has('r') || flags.has('R');
  const force = flags.has('f');
  let st = 0;
  for (const a of args) {
    const abs = ctx.resolve(a);
    const node = ctx.vfs.tryLookup(abs, false);
    if (!node) {
      if (!force) {
        ctx.err(`rm: cannot remove '${a}': No such file or directory\n`);
        st = 1;
      }
      continue;
    }
    if (abs === '/') {
      ctx.err(`rm: it is dangerous to operate recursively on '/'\n`);
      st = 1;
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
      } else ctx.vfs.unlink(abs);
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
  const { flags, args } = getopt(ctx.argv.slice(1).filter((a) => !/^-[rwxX]/.test(a) || a === '-R'));
  const modeSpec = args.shift() ?? '';
  const apply = (p: string) => {
    const node = ctx.vfs.lookup(p);
    let mode = node.mode & 0o7777;
    if (/^[0-7]+$/.test(modeSpec)) mode = parseInt(modeSpec, 8);
    else {
      for (const part of modeSpec.split(',')) {
        const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(part);
        if (!m) continue;
        const who = m[1] || 'a';
        let bits = 0;
        for (const c of m[3]) {
          const v = c === 'r' ? 4 : c === 'w' ? 2 : c === 'x' || (c === 'X' && (isDir(node) || mode & 0o111)) ? 1 : 0;
          if (who.includes('u') || who.includes('a')) bits |= v << 6;
          if (who.includes('g') || who.includes('a')) bits |= v << 3;
          if (who.includes('o') || who.includes('a')) bits |= v;
        }
        if (m[2] === '+') mode |= bits;
        else if (m[2] === '-') mode &= ~bits;
        else mode = bits;
      }
    }
    ctx.vfs.chmod(p, mode);
    if (flags.has('R') && isDir(node)) for (const n of ctx.vfs.readdir(p)) apply(path.join(p, n));
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
  const st = await eachInput(ctx, args, 'tail', (d) => {
    if (opts.has('c')) {
      ctx.out(d.subarray(Math.max(0, d.length - Number(opts.get('c')))));
      return;
    }
    const text = dec.decode(d);
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const out = fromStart ? lines.slice(n - 1) : lines.slice(Math.max(0, lines.length - n));
    if (out.length) ctx.out(out.join('\n') + '\n');
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

function bre2js(p: string, extended: boolean): string {
  if (extended) return p;
  // basic regex: \( \) \{ \} \| are special, bare ones literal
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i];
      if ('(){}|+?'.includes(n)) out += n;
      else out += '\\' + n;
      continue;
    }
    if ('(){}|+?'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

const grep: Program = async (ctx) => {
  const name = ctx.argv[0].split('/').pop()!;
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'emABC', { 'ignore-case': 'i', 'invert-match': 'v', 'line-number': 'n', count: 'c', recursive: 'r', 'files-with-matches': 'l', quiet: 'q', silent: 'q', 'word-regexp': 'w', 'only-matching': 'o', 'extended-regexp': 'E', 'fixed-strings': 'F', include: 'include', exclude: 'exclude', color: 'color' });
  const patterns: string[] = [];
  if (opts.has('e')) patterns.push(opts.get('e')!);
  else if (args.length) patterns.push(args.shift()!);
  else {
    ctx.err(`${name}: missing pattern\n`);
    return 2;
  }
  const extended = flags.has('E') || name === 'egrep';
  const fixed = flags.has('F') || name === 'fgrep';
  let src = patterns.map((p) => (fixed ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : bre2js(p, extended))).join('|');
  if (flags.has('w')) src = `\\b(?:${src})\\b`;
  if (flags.has('x')) src = `^(?:${src})$`;
  let re: RegExp;
  try {
    re = new RegExp(src, flags.has('i') ? 'i' : '');
  } catch {
    ctx.err(`${name}: invalid regular expression\n`);
    return 2;
  }
  const recursive = flags.has('r') || flags.has('R');
  let files = args;
  if (recursive) {
    if (!files.length) files = ['.'];
    const expanded: string[] = [];
    const include = opts.get('include');
    const walk = (p: string) => {
      const node = ctx.vfs.tryLookup(ctx.resolve(p));
      if (!node) return;
      if (isDir(node)) {
        for (const n of ctx.vfs.readdir(ctx.resolve(p)).sort()) {
          if (n === 'node_modules' && !flags.has('R') && false) continue;
          walk(p === '.' ? n : path.join(p, n));
        }
      } else if (!include || matchPattern(include, path.basename(p))) expanded.push(p);
    };
    for (const f of files) walk(f);
    files = expanded;
  }
  const showName = files.length > 1 || recursive;
  let matched = false;
  const st = await eachInput(ctx, files, name, (d, f) => {
    let count = 0;
    const text = dec.decode(d);
    if (text.includes('\0') && !flags.has('a')) {
      if (re.test(text)) {
        matched = true;
        if (!flags.has('q') && !flags.has('l') && !flags.has('c')) ctx.out(`Binary file ${f} matches\n`);
        if (flags.has('l')) ctx.out(f + '\n');
      }
      return;
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const hit = re.test(l) !== flags.has('v');
      if (!hit) continue;
      matched = true;
      count++;
      if (flags.has('q')) return;
      if (flags.has('l')) {
        ctx.out(f + '\n');
        return;
      }
      if (flags.has('c')) continue;
      const prefix = (showName && !flags.has('h') ? `${f}:` : '') + (flags.has('n') ? `${i + 1}:` : '');
      if (flags.has('o')) {
        const g = new RegExp(re.source, re.flags + 'g');
        for (const m of l.matchAll(g)) ctx.out(prefix + m[0] + '\n');
      } else ctx.out(prefix + l + '\n');
      if (opts.has('m') && count >= Number(opts.get('m'))) break;
    }
    if (flags.has('c')) ctx.out((showName ? `${f}:` : '') + count + '\n');
  });
  if (st && !matched) return 2;
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
          return (ty === 'f' && m === S_IFREG) || (ty === 'd' && m === S_IFDIR) || (ty === 'l' && m === S_IFLNK);
        };
      }
      case '-maxdepth':
        maxDepth = Number(expr[k++]);
        return () => true;
      case '-mindepth':
        minDepth = Number(expr[k++]);
        return () => true;
      case '-empty':
        return (p, s) => ((s.mode & S_IFMT) === S_IFDIR ? ctx.vfs.readdir(p).length === 0 : s.size === 0);
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
        while (k < expr.length && expr[k] !== ';' && expr[k] !== '+') cmd.push(expr[k++]);
        k++;
        return (p) => {
          execs.push(cmd.map((c) => (c === '{}' ? p : c)));
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
  const { flags, args } = getopt(ctx.argv.slice(1));
  const set1 = expandTrSet(args[0] ?? '');
  const set2 = expandTrSet(args[1] ?? '');
  const text = await ctx.readAllText(0);
  let out = '';
  const inSet1 = (c: string) => (flags.has('c') ? !set1.includes(c) : set1.includes(c));
  let prev = '';
  for (const c of text) {
    if (flags.has('d')) {
      if (inSet1(c)) continue;
      out += c;
      continue;
    }
    let r = c;
    if (set2.length) {
      const idx = set1.indexOf(c);
      if (idx !== -1) r = set2[Math.min(idx, set2.length - 1)];
      else if (flags.has('c')) r = set2[set2.length - 1];
    }
    if (flags.has('s') && r === prev && (set2.length ? set2.includes(r) : inSet1(c))) continue;
    out += r;
    prev = r;
  }
  ctx.out(out);
  return 0;
};

/** A small sed: s///, d, p, q, y, =, a/i/c text; addresses: N, $, /re/, ranges. */
const sed: Program = async (ctx) => {
  const argv = ctx.argv.slice(1);
  const scripts: string[] = [];
  const files: string[] = [];
  let quiet = false;
  let inPlace: string | null = null;
  let extended = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--quiet') quiet = true;
    else if (a === '-e') scripts.push(argv[++i]);
    else if (a === '-E' || a === '-r') extended = true;
    else if (a.startsWith('-i')) inPlace = a.slice(2);
    else if (a === '-f') scripts.push(dec.decode(ctx.vfs.readFile(ctx.resolve(argv[++i]))));
    else if (!scripts.length && !a.startsWith('-')) scripts.push(a);
    else files.push(a);
  }
  type Addr = { line?: number; last?: boolean; re?: RegExp };
  type Cmd = { a1?: Addr; a2?: Addr; neg: boolean; c: string; re?: RegExp; rep?: string; global?: boolean; nth?: number; print?: boolean; text?: string; from?: string; to?: string; inRange?: boolean };
  const cmds: Cmd[] = [];
  const toRe = (src: string, flagsStr = '') => new RegExp(bre2js(src, extended), flagsStr);
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
      out += script[p++];
    }
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
        rep = rep.replace(/\\(\d)/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\&/g, '&');
        cmd.rep = rep;
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
              return c.rep!.replace(/\$(\d|&)/g, (_x, g) => (g === '&' ? m[0] : (groups[Number(g) - 1] ?? '')));
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

const xargs: Program = async (ctx) => {
  const { flags, opts, args } = getopt(ctx.argv.slice(1), 'nIdP');
  const input = await ctx.readAllText(0);
  const items = flags.has('0') ? input.split('\0').filter(Boolean) : opts.has('d') ? input.split(opts.get('d')!).filter(Boolean) : input.split(/\s+/).filter(Boolean);
  const cmd = args.length ? args : ['echo'];
  const repl = opts.get('I');
  let st = 0;
  if (repl) {
    for (const it of items) {
      const code = await ctx.run(cmd.map((c) => c.split(repl).join(it)));
      if (code) st = 123;
    }
    return st;
  }
  const n = opts.has('n') ? Number(opts.get('n')) : items.length || 1;
  if (!items.length && flags.has('r')) return 0;
  for (let i = 0; i < Math.max(items.length, 1); i += n) {
    const code = await ctx.run([...cmd, ...items.slice(i, i + n)]);
    if (code) st = 123;
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
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i' || a === '-') clear = true;
    else if (a === '-u') delete e[argv[++i]];
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
  try {
    return await ctx.run(argv.slice(i), { env: env2 });
  } catch (err: any) {
    ctx.err(`env: '${argv[i]}': No such file or directory\n`);
    void err;
    return 127;
  }
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

const stat: Program = async (ctx) => {
  const { opts, args, flags } = getopt(ctx.argv.slice(1), 'cf');
  let st = 0;
  for (const a of args) {
    try {
      const s = flags.has('L') ? ctx.vfs.stat(ctx.resolve(a)) : ctx.vfs.lstat(ctx.resolve(a));
      const fmt = opts.get('c');
      if (fmt) {
        ctx.out(
          fmt.replace(/%([a-zA-Z])/g, (_m, c) => {
            switch (c) {
              case 's':
                return String(s.size);
              case 'n':
                return a;
              case 'a':
                return (s.mode & 0o7777).toString(8);
              case 'A':
                return modeString(s.mode);
              case 'Y':
                return String(Math.floor(s.mtimeMs / 1000));
              case 'i':
                return String(s.ino);
              case 'F':
                return (s.mode & S_IFMT) === S_IFDIR ? 'directory' : (s.mode & S_IFMT) === S_IFLNK ? 'symbolic link' : 'regular file';
              default:
                return '?';
            }
          }) + '\n',
        );
        continue;
      }
      const type = (s.mode & S_IFMT) === S_IFDIR ? 'directory' : (s.mode & S_IFMT) === S_IFLNK ? 'symbolic link' : 'regular file';
      ctx.out(`  File: ${a}\n  Size: ${s.size}\tBlocks: ${s.blocks}\tIO Block: ${s.blksize}\t${type}\nDevice: ${s.dev}\tInode: ${s.ino}\tLinks: ${s.nlink}\nAccess: (${(s.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(s.mode)})  Uid: ( ${s.uid}/ user)   Gid: ( ${s.gid}/ user)\nModify: ${new Date(s.mtimeMs).toISOString()}\n`);
    } catch (e) {
      ctx.err(`stat: cannot stat '${a}': ${errMsg(e)}\n`);
      st = 1;
    }
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

const date: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  let d = new Date();
  const utc = args.includes('-u') || args.includes('--utc');
  const di = args.findIndex((a) => a === '-d' || a.startsWith('--date'));
  if (di >= 0) {
    const v = args[di].includes('=') ? args[di].split('=')[1] : args[di + 1];
    d = v.startsWith('@') ? new Date(Number(v.slice(1)) * 1000) : new Date(v);
  }
  const fmt = args.find((a) => a.startsWith('+'));
  if (!fmt) {
    ctx.out((utc ? d.toUTCString() : d.toString()) + '\n');
    return 0;
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const g = (k: 'FullYear' | 'Month' | 'Date' | 'Hours' | 'Minutes' | 'Seconds' | 'Day' | 'Milliseconds') => (d as any)[`get${utc ? 'UTC' : ''}${k}`]();
  const out = fmt.slice(1).replace(/%([a-zA-Z%])/g, (_m, c) => {
    switch (c) {
      case 'Y':
        return String(g('FullYear'));
      case 'y':
        return pad(g('FullYear') % 100);
      case 'm':
        return pad(g('Month') + 1);
      case 'd':
        return pad(g('Date'));
      case 'H':
        return pad(g('Hours'));
      case 'M':
        return pad(g('Minutes'));
      case 'S':
        return pad(g('Seconds'));
      case 's':
        return String(Math.floor(d.getTime() / 1000));
      case 'N':
        return pad(g('Milliseconds') * 1e6, 9);
      case 'F':
        return `${g('FullYear')}-${pad(g('Month') + 1)}-${pad(g('Date'))}`;
      case 'T':
        return `${pad(g('Hours'))}:${pad(g('Minutes'))}:${pad(g('Seconds'))}`;
      case 'b':
        return MONTHS[g('Month')];
      case 'a':
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][g('Day')];
      case 'Z':
        return utc ? 'UTC' : 'JST';
      case '%':
        return '%';
      default:
        return '%' + c;
    }
  });
  ctx.out(out + '\n');
  return 0;
};

const sleep: Program = async (ctx) => {
  let ms = 0;
  for (const a of ctx.argv.slice(1)) {
    const m = /^(\d*\.?\d+)([smhd]?)$/.exec(a);
    if (!m) continue;
    ms += Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000, '': 1000 }[m[2]] ?? 1000);
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
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
  let sig = 'SIGTERM';
  if (args[0] === '-l') {
    ctx.out('HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM\n');
    return 0;
  }
  if (args[0]?.startsWith('-')) {
    const s = args.shift()!.slice(1);
    sig = args[0] === '-s' ? args.shift()! : /^\d+$/.test(s) ? signalName(Number(s)) : 'SIG' + s.replace(/^SIG/, '');
  }
  let st = 0;
  for (const a of args) {
    try {
      const pid = Number(a);
      if (pid < 0) ctx.kernel.killGroup(-pid, sig);
      else ctx.kernel.kill(pid, sig);
    } catch {
      ctx.err(`kill: (${a}) - No such process\n`);
      st = 1;
    }
  }
  return st;
};

const seq: Program = async (ctx) => {
  const args = ctx.argv.slice(1).filter((a) => !a.startsWith('-') || /^-\d/.test(a));
  let [first, inc, last] = args.length === 1 ? [1, 1, Number(args[0])] : args.length === 2 ? [Number(args[0]), 1, Number(args[1])] : args.map(Number);
  const sep = ctx.argv.includes('-s') ? ctx.argv[ctx.argv.indexOf('-s') + 1] : '\n';
  const out: string[] = [];
  if (inc === 0) return 1;
  for (let x = first; inc > 0 ? x <= last : x >= last; x += inc) out.push(String(x));
  if (out.length) ctx.out(out.join(sep) + '\n');
  void first;
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

const diff: Program = async (ctx) => {
  const { args, flags } = getopt(ctx.argv.slice(1));
  if (args.length !== 2) {
    ctx.err('diff: missing operand\n');
    return 2;
  }
  let a: string[];
  let b: string[];
  try {
    a = dec.decode(args[0] === '-' ? await ctx.readAll(0) : ctx.vfs.readFile(ctx.resolve(args[0]))).split('\n');
    b = dec.decode(args[1] === '-' ? await ctx.readAll(0) : ctx.vfs.readFile(ctx.resolve(args[1]))).split('\n');
  } catch (e) {
    ctx.err(`diff: ${errMsg(e)}\n`);
    return 2;
  }
  if (a.join('\n') === b.join('\n')) return 0;
  if (flags.has('q')) {
    ctx.out(`Files ${args[0]} and ${args[1]} differ\n`);
    return 1;
  }
  // LCS-based unified diff (no context merging)
  const n = a.length;
  const m = b.length;
  if (n * m > 4e7) {
    ctx.out(`Files ${args[0]} and ${args[1]} differ\n`);
    return 1;
  }
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  ctx.out(`--- ${args[0]}\n+++ ${args[1]}\n`);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ctx.out(` ${a[i]}\n`);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ctx.out(`+${b[j++]}\n`);
    } else {
      ctx.out(`-${a[i++]}\n`);
    }
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
  const code = ctx.argv.length > 1 ? await ctx.run(ctx.argv.slice(1)) : 0;
  const dt = (performance.now() - t0) / 1000;
  ctx.err(`\nreal\t${Math.floor(dt / 60)}m${(dt % 60).toFixed(3)}s\n`);
  return code;
};

const timeout: Program = async (ctx) => {
  const args = ctx.argv.slice(1).filter((a) => !a.startsWith('-'));
  const secs = parseFloat(args[0]);
  const p = ctx.spawn(args.slice(1));
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    try {
      ctx.kernel.kill(p.pid, 'SIGTERM');
    } catch {}
  }, secs * 1000);
  const st = await p.exited;
  clearTimeout(t);
  return timedOut ? 124 : exitCodeOf(st);
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
  if (ctx.isatty(0)) {
    ctx.out(`/dev/pts/${ctx.proc.tty?.id ?? 0}\n`);
    return 0;
  }
  ctx.out('not a tty\n');
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

const nohup: Program = async (ctx) => ctx.run(ctx.argv.slice(1));
const nice: Program = async (ctx) => ctx.run(ctx.argv.slice(1).filter((a, i, arr) => !(a === '-n' || arr[i - 1] === '-n')));

const less: Program = async (ctx) => cat(ctx);

const file: Program = async (ctx) => {
  for (const a of ctx.argv.slice(1)) {
    try {
      const n = ctx.vfs.lookup(ctx.resolve(a), false);
      if (isDir(n)) ctx.out(`${a}: directory\n`);
      else if (isLink(n)) ctx.out(`${a}: symbolic link to ${n.target}\n`);
      else {
        const d = ctx.vfs.readFile(ctx.resolve(a)).subarray(0, 512);
        const bin = d.includes(0);
        ctx.out(`${a}: ${d.length === 0 ? 'empty' : bin ? 'data' : 'ASCII text'}\n`);
      }
    } catch (e) {
      ctx.out(`${a}: cannot open (${errMsg(e)})\n`);
    }
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
    ls, cat, mkdir, rm, rmdir, cp, mv, touch, ln, chmod, head, tail, wc, grep, egrep: grep, fgrep: grep, find, sort, uniq, cut, tr, sed, xargs, tee, env, which, basename, dirname, realpath, readlink, stat, du, df, free, date, sleep, uname, ps, kill, seq, yes, mktemp, base64, diff, clear, nproc, id, hostname, whoami, tty, stty, nohup, nice, less, more: less, file, rev, nl, timeout, time: timeProg, truncate: truncateProg,
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
