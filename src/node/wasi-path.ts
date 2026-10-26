// Path resolution for WASI's path_* calls: a path is looked up beneath the directory fd it is relative
// to and may not leave it, the way a capability-based WASI runtime confines a module to its preopens.

import * as path from '../shared/path.ts';

/** What the resolver needs from the file system (kernel paths). */
export interface WasiPathOps {
  /** st_mode of the path without following a final symlink; throws (code ENOENT, ENOTDIR…) when it can't be looked up. */
  lstatMode(p: string): number;
  readlink(p: string): string;
}

export class WasiPathError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/** Symlinks followed in one lookup before ELOOP (Linux's MAXSYMLINKS is 40, uvwasi's limit 32). */
const MAX_LINKS = 32;

/**
 * Resolves `p` relative to the directory `dir` (a kernel path) whose path inside the module is `guestDir`
 * (the preopen's name, or the path the module opened it by). Every component is walked: `..` and
 * symlinks are followed inside `dir`, and anything that would leave it — an absolute path, `..` above
 * it, a symlink whose target is outside it — fails with ENOTCAPABLE, as in uvwasi. When `guestDir` is
 * `/`, `..` above it stays at it (the module's root has no parent). An absolute symlink
 * target is read in the module's view (relative to `guestDir`). The final component is followed only
 * when `follow` is set (WASI's LOOKUPFLAGS_SYMLINK_FOLLOW). Returns the kernel path and the part below
 * `dir`.
 */
export function resolveBeneath(ops: WasiPathOps, dir: string, guestDir: string, p: string, follow: boolean): { host: string; rel: string } {
  if (p === '') throw new WasiPathError('ENOENT');
  if (p.includes('\0')) throw new WasiPathError('EINVAL');
  const guestRoot = path.normalize(guestDir).replace(/(.)\/$/, '$1');
  /** an absolute path in the module's view → components below dir */
  const fromAbsolute = (abs: string) => {
    if (!path.isAbsolute(guestRoot)) throw new WasiPathError('ENOTCAPABLE');
    const rel = path.relative(guestRoot, path.normalize(abs));
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw new WasiPathError('ENOTCAPABLE');
    return rel ? rel.split('/') : [];
  };
  // a path argument is always relative to its fd; only symlink targets may be absolute
  if (p.startsWith('/')) throw new WasiPathError('ENOTCAPABLE');
  let parts: string[] = [];
  let rest = p.split('/');
  // a trailing slash names a directory: the last component is followed like any other
  const trailingSlash = p.endsWith('/');
  let links = 0;
  while (rest.length) {
    const c = rest.shift()!;
    if (c === '' || c === '.') continue;
    if (c === '..') {
      // the module's path is normalized in its own view (uvwasi): '..' of a directory it sees as '/'
      // is that directory again, like a root's; above any other directory it leaves the fd
      if (!parts.length) {
        if (guestRoot === '/') continue;
        throw new WasiPathError('ENOTCAPABLE');
      }
      parts.pop();
      continue;
    }
    parts.push(c);
    const last = rest.every((r) => r === '' || r === '.');
    if (last && !follow && !trailingSlash) break;
    const host = path.join(dir, ...parts);
    let mode: number;
    try {
      mode = ops.lstatMode(host);
    } catch (e) {
      // a missing last component is fine (the call may create it); a missing directory on the way is not
      if (last) break;
      throw e;
    }
    if ((mode & S_IFMT) !== S_IFLNK) continue;
    if (++links > MAX_LINKS) throw new WasiPathError('ELOOP');
    const target = ops.readlink(host);
    parts.pop();
    if (target.startsWith('/')) {
      parts = [];
      rest = [...fromAbsolute(target), ...rest];
    } else rest = [...target.split('/'), ...rest];
  }
  const rel = parts.join('/');
  return { host: rel ? path.join(dir, rel) : dir, rel };
}
