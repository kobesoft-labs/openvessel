// In-memory POSIX-like virtual file system.

import { KernelError, kerr } from '../shared/errno.ts';

export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFBLK = 0o060000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

export const DEV_ID = 2049;
const MAX_SYMLINKS = 40;

export interface CharDevice {
  read(len: number): Uint8Array | null; // null = would block (not used for simple devices)
  write(data: Uint8Array): number;
}

export interface Inode {
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  // regular file
  data?: Uint8Array;
  size: number;
  // directory
  entries?: Map<string, Inode>;
  parent?: Inode;
  // symlink
  target?: string;
  // character device
  device?: CharDevice;
  rdev?: number;
}

export interface StatData {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export type WatchEvent = { type: 'rename' | 'change'; path: string };

const textEncoder = new TextEncoder();

export function isDir(n: Inode) {
  return (n.mode & S_IFMT) === S_IFDIR;
}
export function isFile(n: Inode) {
  return (n.mode & S_IFMT) === S_IFREG;
}
export function isLink(n: Inode) {
  return (n.mode & S_IFMT) === S_IFLNK;
}

export function splitPath(p: string): string[] {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    out.push(part);
  }
  return out;
}

export class VFS {
  root: Inode;
  private nextIno = 1;
  private watchers = new Set<(ev: WatchEvent) => void>();
  /** Bumped on every mutation; lets callers cache lookups cheaply. */
  generation = 0;

  constructor() {
    this.root = this.newInode(S_IFDIR | 0o755);
    this.root.entries = new Map();
    this.root.parent = this.root;
    this.root.nlink = 2;
  }

  private newInode(mode: number): Inode {
    const now = Date.now();
    return {
      ino: this.nextIno++,
      mode,
      uid: 1000,
      gid: 1000,
      nlink: 1,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      size: 0,
    };
  }

  onChange(fn: (ev: WatchEvent) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private emit(type: WatchEvent['type'], path: string) {
    this.generation++;
    if (this.watchers.size === 0) return;
    for (const w of this.watchers) w({ type, path });
  }

  // ---------- path walking ----------

  /**
   * Walks `path` (absolute) and returns the inode. Follows symlinks in all
   * intermediate components; follows the last one only if `follow`.
   */
  lookup(path: string, follow = true): Inode {
    return this.walk(path, follow, 0).node;
  }

  tryLookup(path: string, follow = true): Inode | undefined {
    try {
      return this.lookup(path, follow);
    } catch {
      return undefined;
    }
  }

  private walk(path: string, follow: boolean, depth: number): { node: Inode; real: string } {
    if (depth > MAX_SYMLINKS) throw kerr('ELOOP');
    const parts = splitPath(path);
    let node = this.root;
    let realParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!isDir(node)) throw kerr('ENOTDIR');
      if (name === '..') {
        node = node.parent!;
        realParts.pop();
        continue;
      }
      const child = node.entries!.get(name);
      if (!child) throw kerr('ENOENT');
      const last = i === parts.length - 1;
      if (isLink(child) && (!last || follow)) {
        const target = child.target!;
        const base = target.startsWith('/') ? target : '/' + realParts.join('/') + '/' + target;
        const res = this.walk(base, true, depth + 1);
        node = res.node;
        realParts = splitPath(res.real);
        continue;
      }
      node = child;
      realParts.push(name);
    }
    if (path.endsWith('/') && parts.length > 0 && !isDir(node)) throw kerr('ENOTDIR');
    return { node, real: '/' + realParts.join('/') };
  }

  realpath(path: string): string {
    return this.walk(path, true, 0).real;
  }

  /** Returns the parent directory inode and the final name component. */
  lookupParent(path: string): { dir: Inode; name: string; dirPath: string } {
    const parts = splitPath(path);
    if (parts.length === 0) throw kerr('EEXIST');
    const name = parts[parts.length - 1];
    const dirPath = '/' + parts.slice(0, -1).join('/');
    const dir = this.lookup(dirPath, true);
    if (!isDir(dir)) throw kerr('ENOTDIR');
    if (name === '..' || name === '.') throw kerr('EINVAL');
    return { dir, name, dirPath };
  }

  // ---------- stat ----------

  statOf(n: Inode): StatData {
    return {
      dev: DEV_ID,
      ino: n.ino,
      mode: n.mode,
      nlink: n.nlink,
      uid: n.uid,
      gid: n.gid,
      rdev: n.rdev ?? 0,
      size: isDir(n) ? 4096 : isLink(n) ? textEncoder.encode(n.target!).length : n.size,
      blksize: 4096,
      blocks: Math.ceil(n.size / 512),
      atimeMs: n.atimeMs,
      mtimeMs: n.mtimeMs,
      ctimeMs: n.ctimeMs,
      birthtimeMs: n.birthtimeMs,
    };
  }

  stat(path: string): StatData {
    return this.statOf(this.lookup(path, true));
  }

  lstat(path: string): StatData {
    return this.statOf(this.lookup(path, false));
  }

  exists(path: string): boolean {
    return this.tryLookup(path) !== undefined;
  }

  // ---------- directories ----------

  mkdir(path: string, mode = 0o777, recursive = false): string | undefined {
    if (recursive) {
      const parts = splitPath(path);
      let cur = '';
      let first: string | undefined;
      for (const part of parts) {
        cur += '/' + part;
        const existing = this.tryLookup(cur);
        if (existing) {
          if (!isDir(existing)) throw kerr('ENOTDIR');
          continue;
        }
        this.mkdir(cur, mode, false);
        first ??= cur;
      }
      return first;
    }
    const { dir, name } = this.lookupParent(path);
    if (dir.entries!.has(name)) throw kerr('EEXIST');
    const node = this.newInode(S_IFDIR | (mode & 0o7777 & ~0o022));
    node.entries = new Map();
    node.parent = dir;
    node.nlink = 2;
    dir.entries!.set(name, node);
    dir.nlink++;
    this.touchDir(dir);
    this.emit('rename', path);
    return path;
  }

  readdir(path: string): string[] {
    const node = this.lookup(path);
    if (!isDir(node)) throw kerr('ENOTDIR');
    node.atimeMs = Date.now();
    return [...node.entries!.keys()];
  }

  /** Directory listing with d_type style info: [name, type] (type = S_IF* constant). */
  readdirTypes(path: string): [string, number][] {
    const node = this.lookup(path);
    if (!isDir(node)) throw kerr('ENOTDIR');
    const out: [string, number][] = [];
    for (const [name, child] of node.entries!) out.push([name, child.mode & S_IFMT]);
    return out;
  }

  rmdir(path: string) {
    const { dir, name } = this.lookupParent(path);
    const node = dir.entries!.get(name);
    if (!node) throw kerr('ENOENT');
    if (!isDir(node)) throw kerr('ENOTDIR');
    if (node.entries!.size > 0) throw kerr('ENOTEMPTY');
    if (node === this.root) throw kerr('EBUSY');
    dir.entries!.delete(name);
    dir.nlink--;
    node.nlink = 0;
    this.touchDir(dir);
    this.emit('rename', path);
  }

  /** rm -rf semantics; returns silently if missing when `force`. */
  rmrf(path: string, force = true) {
    const node = this.tryLookup(path, false);
    if (!node) {
      if (force) return;
      throw kerr('ENOENT');
    }
    if (isDir(node)) {
      for (const name of [...node.entries!.keys()]) this.rmrf(path.replace(/\/$/, '') + '/' + name, true);
      this.rmdir(path);
    } else {
      this.unlink(path);
    }
  }

  private touchDir(dir: Inode) {
    const now = Date.now();
    dir.mtimeMs = now;
    dir.ctimeMs = now;
  }

  // ---------- files ----------

  /** Creates (or truncates/opens) a regular file; returns its inode. */
  createFile(path: string, mode = 0o666, opts: { excl?: boolean; trunc?: boolean } = {}): Inode {
    const { dir, name } = this.lookupParent(path);
    let node = dir.entries!.get(name);
    if (node && isLink(node)) {
      // follow symlink for creation
      const real = this.resolveLinkTarget(path, node);
      if (opts.excl) throw kerr('EEXIST');
      const existing = this.tryLookup(real);
      if (existing) {
        node = existing;
      } else {
        return this.createFile(real, mode, opts);
      }
    }
    if (node) {
      if (opts.excl) throw kerr('EEXIST');
      if (isDir(node)) throw kerr('EISDIR');
      if (opts.trunc && isFile(node)) this.truncateNode(node, 0, path);
      return node;
    }
    node = this.newInode(S_IFREG | (mode & 0o7777 & ~0o022));
    node.data = new Uint8Array(0);
    dir.entries!.set(name, node);
    this.touchDir(dir);
    this.emit('rename', path);
    return node;
  }

  private resolveLinkTarget(path: string, link: Inode): string {
    const t = link.target!;
    if (t.startsWith('/')) return t;
    const parts = splitPath(path);
    parts.pop();
    return '/' + [...parts, t].join('/');
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    if (isDir(node)) throw kerr('EISDIR');
    if (node.device) return new Uint8Array(0);
    node.atimeMs = Date.now();
    return node.data!.subarray(0, node.size);
  }

  /** Writes a whole file (creating parents is the caller's job). */
  writeFile(path: string, data: Uint8Array | string, mode = 0o666): Inode {
    const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
    const node = this.createFile(path, mode, {});
    if (node.device) {
      node.device.write(bytes);
      return node;
    }
    node.data = bytes.slice();
    node.size = bytes.length;
    const now = Date.now();
    node.mtimeMs = now;
    node.ctimeMs = now;
    this.emit('change', path);
    return node;
  }

  /** Writes and creates missing parent directories. */
  writeFileP(path: string, data: Uint8Array | string, mode = 0o666): Inode {
    const parts = splitPath(path);
    if (parts.length > 1) this.mkdir('/' + parts.slice(0, -1).join('/'), 0o777, true);
    return this.writeFile(path, data, mode);
  }

  readAt(node: Inode, buf: Uint8Array, position: number): number {
    if (isDir(node)) throw kerr('EISDIR');
    if (node.device) {
      const d = node.device.read(buf.length);
      if (!d) return 0;
      buf.set(d);
      return d.length;
    }
    if (position >= node.size) return 0;
    const n = Math.min(buf.length, node.size - position);
    buf.set(node.data!.subarray(position, position + n));
    node.atimeMs = Date.now();
    return n;
  }

  writeAt(node: Inode, data: Uint8Array, position: number, pathForEvent?: string): number {
    if (isDir(node)) throw kerr('EISDIR');
    if (node.device) return node.device.write(data);
    const end = position + data.length;
    this.ensureCapacity(node, end);
    node.data!.set(data, position);
    if (end > node.size) node.size = end;
    const now = Date.now();
    node.mtimeMs = now;
    node.ctimeMs = now;
    if (pathForEvent) this.emit('change', pathForEvent);
    else this.generation++;
    return data.length;
  }

  private ensureCapacity(node: Inode, size: number) {
    const cur = node.data!;
    if (cur.length >= size) return;
    let cap = Math.max(size, cur.length * 2, 64);
    if (cap > size + 64 * 1024 * 1024) cap = size;
    const next = new Uint8Array(cap);
    next.set(cur.subarray(0, node.size));
    node.data = next;
  }

  truncateNode(node: Inode, len: number, pathForEvent?: string) {
    if (isDir(node)) throw kerr('EISDIR');
    if (!isFile(node)) return;
    if (len > node.size) {
      this.ensureCapacity(node, len);
      node.data!.fill(0, node.size, len);
    }
    node.size = len;
    const now = Date.now();
    node.mtimeMs = now;
    node.ctimeMs = now;
    if (pathForEvent) this.emit('change', pathForEvent);
    else this.generation++;
  }

  truncate(path: string, len = 0) {
    this.truncateNode(this.lookup(path), len, path);
  }

  unlink(path: string) {
    const { dir, name } = this.lookupParent(path);
    const node = dir.entries!.get(name);
    if (!node) throw kerr('ENOENT');
    if (isDir(node)) throw kerr('EISDIR');
    dir.entries!.delete(name);
    node.nlink--;
    node.ctimeMs = Date.now();
    this.touchDir(dir);
    this.emit('rename', path);
  }

  rename(from: string, to: string) {
    const src = this.lookupParent(from);
    const node = src.dir.entries!.get(src.name);
    if (!node) throw kerr('ENOENT');
    const dst = this.lookupParent(to);
    if (isDir(node)) {
      // cannot move a directory into itself
      let p: Inode | undefined = dst.dir;
      while (p) {
        if (p === node) throw kerr('EINVAL');
        if (p === this.root) break;
        p = p.parent;
      }
    }
    const existing = dst.dir.entries!.get(dst.name);
    if (existing === node) return;
    if (existing) {
      if (isDir(existing)) {
        if (!isDir(node)) throw kerr('EISDIR');
        if (existing.entries!.size > 0) throw kerr('ENOTEMPTY');
        dst.dir.nlink--;
      } else if (isDir(node)) {
        throw kerr('ENOTDIR');
      }
      existing.nlink--;
    }
    src.dir.entries!.delete(src.name);
    dst.dir.entries!.set(dst.name, node);
    if (isDir(node)) {
      node.parent = dst.dir;
      src.dir.nlink--;
      if (!existing) dst.dir.nlink++;
    }
    node.ctimeMs = Date.now();
    this.touchDir(src.dir);
    this.touchDir(dst.dir);
    this.emit('rename', from);
    this.emit('rename', to);
  }

  link(existingPath: string, newPath: string) {
    const node = this.lookup(existingPath, false);
    if (isDir(node)) throw kerr('EPERM');
    const { dir, name } = this.lookupParent(newPath);
    if (dir.entries!.has(name)) throw kerr('EEXIST');
    dir.entries!.set(name, node);
    node.nlink++;
    node.ctimeMs = Date.now();
    this.touchDir(dir);
    this.emit('rename', newPath);
  }

  symlink(target: string, path: string) {
    const { dir, name } = this.lookupParent(path);
    if (dir.entries!.has(name)) throw kerr('EEXIST');
    const node = this.newInode(S_IFLNK | 0o777);
    node.target = target;
    dir.entries!.set(name, node);
    this.touchDir(dir);
    this.emit('rename', path);
  }

  readlink(path: string): string {
    const node = this.lookup(path, false);
    if (!isLink(node)) throw kerr('EINVAL');
    return node.target!;
  }

  chmod(path: string, mode: number, follow = true) {
    const node = this.lookup(path, follow);
    node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
    node.ctimeMs = Date.now();
    // IN_ATTRIB: watchers see a chmod as a 'change'
    this.emit('change', path);
  }

  chown(path: string, uid: number, gid: number, follow = true) {
    const node = this.lookup(path, follow);
    if (uid >= 0) node.uid = uid;
    if (gid >= 0) node.gid = gid;
    node.ctimeMs = Date.now();
  }

  utimes(path: string, atimeMs: number, mtimeMs: number, follow = true) {
    const node = this.lookup(path, follow);
    node.atimeMs = atimeMs;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = Date.now();
    this.emit('change', path);
  }

  mknodChar(path: string, device: CharDevice, rdev: number, mode = 0o666) {
    const { dir, name } = this.lookupParent(path);
    const node = this.newInode(S_IFCHR | mode);
    node.device = device;
    node.rdev = rdev;
    dir.entries!.set(name, node);
  }

  /** bind(2) of a Unix domain socket: a socket inode at `path` (EADDRINUSE if the name exists). */
  mknodSock(path: string, mode = 0o755): Inode {
    const { dir, name } = this.lookupParent(path);
    if (dir.entries!.has(name)) throw kerr('EADDRINUSE');
    const node = this.newInode(S_IFSOCK | mode);
    dir.entries!.set(name, node);
    this.touchDir(dir);
    this.emit('rename', path);
    return node;
  }

  /** Recursively copies `from` to `to` (files, dirs, symlinks). */
  copy(from: string, to: string, opts: { force?: boolean; errorOnExist?: boolean; dereference?: boolean } = {}) {
    const node = this.lookup(from, !!opts.dereference);
    if (isDir(node)) {
      if (!this.exists(to)) this.mkdir(to, node.mode & 0o7777);
      for (const name of node.entries!.keys()) this.copy(`${from}/${name}`, `${to}/${name}`, opts);
      return;
    }
    const existing = this.tryLookup(to, false);
    if (existing) {
      if (opts.errorOnExist) throw new KernelError('EEXIST');
      if (opts.force === false) return;
      if (isDir(existing)) throw kerr('EISDIR');
      this.unlink(to);
    }
    if (isLink(node)) {
      this.symlink(node.target!, to);
      return;
    }
    const n = this.writeFile(to, node.data!.subarray(0, node.size), node.mode & 0o7777);
    n.mode = (n.mode & S_IFMT) | (node.mode & 0o7777);
  }
}
