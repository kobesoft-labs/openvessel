// `test` / `[` builtin.

import { S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFMT, S_IFREG } from '../vfs.ts';
import type { Shell } from './interp.ts';

export function builtinTest(sh: Shell, args: string[]): number {
  const vfs = sh.kernel.vfs;
  const st = (p: string, follow = true) => {
    try {
      return follow ? vfs.stat(sh.resolve(p)) : vfs.lstat(sh.resolve(p));
    } catch {
      return null;
    }
  };
  const num = (s: string) => {
    if (!/^\s*-?\d+\s*$/.test(s)) throw new Error(`${s}: integer expression expected`);
    return parseInt(s, 10);
  };
  const unary = (op: string, a: string): boolean | null => {
    switch (op) {
      case '-e':
      case '-a':
        return !!st(a);
      case '-f':
        return !!st(a) && (st(a)!.mode & S_IFMT) === S_IFREG;
      case '-d':
        return !!st(a) && (st(a)!.mode & S_IFMT) === S_IFDIR;
      case '-L':
      case '-h':
        return !!st(a, false) && (st(a, false)!.mode & S_IFMT) === S_IFLNK;
      case '-p':
        return !!st(a) && (st(a)!.mode & S_IFMT) === S_IFIFO;
      case '-c':
        return !!st(a) && (st(a)!.mode & S_IFMT) === S_IFCHR;
      case '-s':
        return !!st(a) && st(a)!.size > 0;
      case '-r':
      case '-w':
        return !!st(a);
      case '-x':
        return !!st(a) && (st(a)!.mode & 0o111) !== 0;
      case '-z':
        return a.length === 0;
      case '-n':
        return a.length !== 0;
      case '-t':
        return sh.fds.get(Number(a))?.kind === 'tty';
      case '-v':
        return sh.getVar(a) !== undefined;
    }
    return null;
  };
  const binary = (a: string, op: string, b: string): boolean | null => {
    switch (op) {
      case '=':
      case '==':
        return a === b;
      case '!=':
        return a !== b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '-eq':
        return num(a) === num(b);
      case '-ne':
        return num(a) !== num(b);
      case '-lt':
        return num(a) < num(b);
      case '-le':
        return num(a) <= num(b);
      case '-gt':
        return num(a) > num(b);
      case '-ge':
        return num(a) >= num(b);
      case '-nt':
        return (st(a)?.mtimeMs ?? -1) > (st(b)?.mtimeMs ?? -1);
      case '-ot':
        return (st(a)?.mtimeMs ?? Infinity) < (st(b)?.mtimeMs ?? Infinity);
      case '-ef':
        return !!st(a) && st(a)!.ino === st(b)?.ino;
    }
    return null;
  };
  // recursive descent over -o / -a / ! / ( )
  let i = 0;
  const expr = (): boolean => {
    let v = andE();
    while (args[i] === '-o') {
      i++;
      const r = andE();
      v = v || r;
    }
    return v;
  };
  const andE = (): boolean => {
    let v = notE();
    while (args[i] === '-a') {
      i++;
      const r = notE();
      v = v && r;
    }
    return v;
  };
  const notE = (): boolean => {
    if (args[i] === '!' && i + 1 < args.length) {
      i++;
      return !notE();
    }
    return prim();
  };
  const prim = (): boolean => {
    const remaining = args.length - i;
    if (args[i] === '(' && remaining >= 3) {
      i++;
      const v = expr();
      if (args[i] === ')') i++;
      return v;
    }
    if (remaining >= 3) {
      const r = binary(args[i], args[i + 1], args[i + 2]);
      if (r !== null) {
        i += 3;
        return r;
      }
    }
    if (remaining >= 2) {
      const r = unary(args[i], args[i + 1]);
      if (r !== null) {
        i += 2;
        return r;
      }
    }
    const a = args[i++];
    return a !== undefined && a !== '';
  };
  try {
    if (args.length === 0) return 1;
    const v = expr();
    if (i < args.length) {
      sh.err('sh: test: too many arguments\n');
      return 2;
    }
    return v ? 0 : 1;
  } catch (e: any) {
    sh.err(`sh: test: ${e.message}\n`);
    return 2;
  }
}
