// node:fs

import { Buffer } from 'buffer';
import * as pathMod from '../shared/path.ts';
import { fileURLToPathLoose } from '../shared/resolve.ts';
import { EventEmitter } from './events.ts';
import { Handle, macrotask, ref, unref } from './loop.ts';
import { Readable, Writable } from './stream.ts';
import { SysError, fsCall, post, sys } from './sys.ts';

const enc = new TextEncoder();

export const constants = {
  UV_FS_SYMLINK_DIR: 1,
  UV_FS_SYMLINK_JUNCTION: 2,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  UV_DIRENT_UNKNOWN: 0,
  UV_DIRENT_FILE: 1,
  UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4,
  UV_DIRENT_SOCKET: 5,
  UV_DIRENT_CHAR: 6,
  UV_DIRENT_BLOCK: 7,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFCHR: 0o020000,
  S_IFBLK: 0o060000,
  S_IFIFO: 0o010000,
  S_IFLNK: 0o120000,
  S_IFSOCK: 0o140000,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  UV_FS_O_FILEMAP: 0,
  O_NOCTTY: 0o400,
  O_TRUNC: 0o1000,
  O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000,
  O_NOATIME: 0o1000000,
  O_NOFOLLOW: 0o400000,
  O_SYNC: 0o4010000,
  O_DSYNC: 0o10000,
  O_DIRECT: 0o40000,
  O_NONBLOCK: 0o4000,
  S_IRWXU: 0o700,
  S_IRUSR: 0o400,
  S_IWUSR: 0o200,
  S_IXUSR: 0o100,
  S_IRWXG: 0o70,
  S_IRGRP: 0o40,
  S_IWGRP: 0o20,
  S_IXGRP: 0o10,
  S_IRWXO: 0o7,
  S_IROTH: 0o4,
  S_IWOTH: 0o2,
  S_IXOTH: 0o1,
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  UV_FS_COPYFILE_EXCL: 1,
  COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4,
  COPYFILE_FICLONE_FORCE: 4,
};
export const F_OK = 0;
export const R_OK = 4;
export const W_OK = 2;
export const X_OK = 1;

type PathLike = string | Buffer | URL | Uint8Array;

let cwdFn: () => string = () => '/';
export function setCwd(fn: () => string) {
  cwdFn = fn;
}

export function toPath(p: PathLike, name = 'path'): string {
  let s: string;
  if (typeof p === 'string') s = p;
  else if (p instanceof URL) {
    if (p.protocol !== 'file:') throw invalidArg(name, 'The URL must be of scheme file');
    s = fileURLToPathLoose(p.href);
  } else if (p instanceof Uint8Array) s = Buffer.from(p).toString();
  else if (p && typeof p === 'object' && typeof (p as any).href === 'string' && (p as any).protocol === 'file:') s = fileURLToPathLoose((p as any).href);
  else throw invalidArg(name, `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? 'null' : typeof p}`);
  if (s.includes('\0')) throw invalidArg(name, `The argument '${name}' must be a string without null bytes`);
  if (s.startsWith('/')) return pathMod.normalize(s).replace(/(.)\/$/, '$1');
  return pathMod.resolve(cwdFn(), s);
}

function invalidArg(name: string, msg: string) {
  const e = new TypeError(msg) as TypeError & { code: string };
  e.code = name === 'path' && msg.includes('null bytes') ? 'ERR_INVALID_ARG_VALUE' : 'ERR_INVALID_ARG_TYPE';
  return e;
}

function flagsToNumber(flags: string | number | undefined, dflt = 'r'): number {
  if (typeof flags === 'number') return flags;
  switch (flags ?? dflt) {
    case 'r':
    case 'rs':
    case 'sr':
      return 0;
    case 'r+':
    case 'rs+':
    case 'sr+':
      return 2;
    case 'w':
      return 0o1 | 0o100 | 0o1000;
    case 'wx':
    case 'xw':
      return 0o1 | 0o100 | 0o1000 | 0o200;
    case 'w+':
      return 0o2 | 0o100 | 0o1000;
    case 'wx+':
    case 'xw+':
      return 0o2 | 0o100 | 0o1000 | 0o200;
    case 'a':
    case 'as':
    case 'sa':
      return 0o1 | 0o100 | 0o2000;
    case 'ax':
    case 'xa':
      return 0o1 | 0o100 | 0o2000 | 0o200;
    case 'a+':
    case 'as+':
    case 'sa+':
      return 0o2 | 0o100 | 0o2000;
    case 'ax+':
    case 'xa+':
      return 0o2 | 0o100 | 0o2000 | 0o200;
  }
  const e = new TypeError(`The value "${flags}" is invalid for option "flags"`) as TypeError & { code: string };
  e.code = 'ERR_INVALID_ARG_VALUE';
  throw e;
}

function encodingOf(opts: any): BufferEncoding | null | 'buffer' {
  if (typeof opts === 'string') return opts as BufferEncoding;
  if (opts && typeof opts === 'object') return opts.encoding ?? null;
  return null;
}

function toBytes(data: any, encoding?: BufferEncoding | null): Uint8Array {
  if (typeof data === 'string') {
    if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return enc.encode(data);
    return Buffer.from(data, encoding);
  }
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data === 'object' && typeof data.toString === 'function' && data.toString !== Object.prototype.toString) return enc.encode(String(data));
  const e = new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${typeof data}`) as TypeError & { code: string };
  e.code = 'ERR_INVALID_ARG_TYPE';
  throw e;
}

// -----------------------------------------------------------------------------
// Stats

interface RawStat {
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

export class Stats {
  dev!: number;
  ino!: number;
  mode!: number;
  nlink!: number;
  uid!: number;
  gid!: number;
  rdev!: number;
  size!: number;
  blksize!: number;
  blocks!: number;
  atimeMs!: number;
  mtimeMs!: number;
  ctimeMs!: number;
  birthtimeMs!: number;
  atime!: Date;
  mtime!: Date;
  ctime!: Date;
  birthtime!: Date;
  constructor(raw?: RawStat) {
    if (raw) {
      Object.assign(this, raw);
      this.atime = new Date(raw.atimeMs);
      this.mtime = new Date(raw.mtimeMs);
      this.ctime = new Date(raw.ctimeMs);
      this.birthtime = new Date(raw.birthtimeMs);
    }
  }
  isFile() {
    return (this.mode & 0o170000) === 0o100000;
  }
  isDirectory() {
    return (this.mode & 0o170000) === 0o040000;
  }
  isSymbolicLink() {
    return (this.mode & 0o170000) === 0o120000;
  }
  isBlockDevice() {
    return (this.mode & 0o170000) === 0o060000;
  }
  isCharacterDevice() {
    return (this.mode & 0o170000) === 0o020000;
  }
  isFIFO() {
    return (this.mode & 0o170000) === 0o010000;
  }
  isSocket() {
    return (this.mode & 0o170000) === 0o140000;
  }
}

export class BigIntStats extends Stats {
  constructor(raw: RawStat) {
    super(raw);
    for (const k of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks'] as const) (this as any)[k] = BigInt(raw[k]);
    for (const k of ['atime', 'mtime', 'ctime', 'birthtime'] as const) {
      (this as any)[k + 'Ms'] = BigInt(Math.floor(raw[`${k}Ms`]));
      (this as any)[k + 'Ns'] = BigInt(Math.floor(raw[`${k}Ms`] * 1e6));
    }
  }
  isFile() {
    return (Number(this.mode) & 0o170000) === 0o100000;
  }
  isDirectory() {
    return (Number(this.mode) & 0o170000) === 0o040000;
  }
  isSymbolicLink() {
    return (Number(this.mode) & 0o170000) === 0o120000;
  }
}

function makeStats(raw: RawStat, opts?: { bigint?: boolean }) {
  return opts?.bigint ? new BigIntStats(raw) : new Stats(raw);
}

export class Dirent {
  name: string;
  parentPath: string;
  path: string;
  private _type: number;
  constructor(name: string, type: number, parentPath: string) {
    this.name = name;
    this._type = type;
    this.parentPath = parentPath;
    this.path = parentPath;
  }
  isFile() {
    return this._type === 0o100000;
  }
  isDirectory() {
    return this._type === 0o040000;
  }
  isSymbolicLink() {
    return this._type === 0o120000;
  }
  isBlockDevice() {
    return this._type === 0o060000;
  }
  isCharacterDevice() {
    return this._type === 0o020000;
  }
  isFIFO() {
    return this._type === 0o010000;
  }
  isSocket() {
    return this._type === 0o140000;
  }
}

// -----------------------------------------------------------------------------
// synchronous API

export function existsSync(p: PathLike): boolean {
  try {
    sys('stat', { p: toPath(p) });
    return true;
  } catch {
    return false;
  }
}

export function accessSync(p: PathLike, mode = F_OK) {
  const path = toPath(p);
  fsCall('access', path, () => sys('access', { p: path, mode }));
}

export function statSync(p: PathLike, opts?: { bigint?: boolean; throwIfNoEntry?: boolean }): Stats | undefined {
  const path = toPath(p);
  try {
    return makeStats(sys('stat', { p: path }), opts);
  } catch (e) {
    if (opts?.throwIfNoEntry === false && e instanceof SysError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined;
    return fsCall('stat', path, () => {
      throw e;
    });
  }
}

export function lstatSync(p: PathLike, opts?: { bigint?: boolean; throwIfNoEntry?: boolean }): Stats | undefined {
  const path = toPath(p);
  try {
    return makeStats(sys('stat', { p: path, l: true }), opts);
  } catch (e) {
    if (opts?.throwIfNoEntry === false && e instanceof SysError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined;
    return fsCall('lstat', path, () => {
      throw e;
    });
  }
}

export function fstatSync(fd: number, opts?: { bigint?: boolean }): Stats {
  return makeStats(fsCall('fstat', undefined, () => sys('fstat', { fd })), opts);
}

export function statfsSync(_p: PathLike) {
  return { type: 0x858458f6, bsize: 4096, blocks: 1048576, bfree: 1048576, bavail: 1048576, files: 1048576, ffree: 1048576 };
}

export function readFileSync(p: PathLike | number, opts?: any): any {
  const encoding = encodingOf(opts);
  let bytes: Uint8Array;
  if (typeof p === 'number') {
    bytes = readAllFd(p);
  } else {
    const path = toPath(p);
    bytes = fsCall('open', path, () => sys<Uint8Array>('readFile', { p: path }));
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (encoding && encoding !== 'buffer') return buf.toString(encoding as BufferEncoding);
  return buf;
}

function readAllFd(fd: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const d = fsCall('read', undefined, () => sys<Uint8Array>('read', { fd, len: 1 << 20, pos: null }));
    if (d.length === 0) break;
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

export function writeFileSync(p: PathLike | number, data: any, opts?: any) {
  const encoding = encodingOf(opts) as BufferEncoding | null;
  const bytes = toBytes(data, encoding);
  if (typeof p === 'number') {
    writeSync(p, bytes);
    return;
  }
  const path = toPath(p);
  const flag = (typeof opts === 'object' && opts?.flag) || 'w';
  const mode = (typeof opts === 'object' && opts?.mode) || 0o666;
  fsCall('open', path, () => sys('writeFile', { p: path, flags: flagsToNumber(flag), mode }, bytes));
}

export function appendFileSync(p: PathLike | number, data: any, opts?: any) {
  const o = typeof opts === 'string' ? { encoding: opts } : { ...(opts ?? {}) };
  o.flag = o.flag ?? 'a';
  writeFileSync(p, data, o);
}

export function openSync(p: PathLike, flags?: string | number, mode = 0o666): number {
  const path = toPath(p);
  return fsCall('open', path, () => sys<number>('open', { p: path, flags: flagsToNumber(flags), mode }));
}

export function closeSync(fd: number) {
  fsCall('close', undefined, () => sys('close', { fd }));
}

export function readSync(fd: number, buffer: ArrayBufferView, offsetOrOpts?: any, length?: number, position?: number | bigint | null): number {
  let offset = 0;
  if (offsetOrOpts && typeof offsetOrOpts === 'object') {
    offset = offsetOrOpts.offset ?? 0;
    length = offsetOrOpts.length;
    position = offsetOrOpts.position;
  } else offset = offsetOrOpts ?? 0;
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  length = length ?? view.length - offset;
  if (length === 0) return 0;
  const pos = position === undefined || position === null || position === -1 ? null : Number(position);
  const d = fsCall('read', undefined, () => sys<Uint8Array>('read', { fd, len: length, pos }));
  view.set(d, offset);
  return d.length;
}

export function writeSync(fd: number, buffer: any, offsetOrPos?: any, lengthOrEnc?: any, position?: number | null): number {
  let bytes: Uint8Array;
  let pos: number | null = null;
  if (typeof buffer === 'string') {
    bytes = toBytes(buffer, (typeof lengthOrEnc === 'string' ? lengthOrEnc : 'utf8') as BufferEncoding);
    pos = typeof offsetOrPos === 'number' ? offsetOrPos : null;
  } else {
    const view = toBytes(buffer);
    if (offsetOrPos && typeof offsetOrPos === 'object') {
      const o = offsetOrPos;
      bytes = view.subarray(o.offset ?? 0, (o.offset ?? 0) + (o.length ?? view.length - (o.offset ?? 0)));
      pos = o.position ?? null;
    } else {
      const off = offsetOrPos ?? 0;
      const len = typeof lengthOrEnc === 'number' ? lengthOrEnc : view.length - off;
      bytes = view.subarray(off, off + len);
      pos = position ?? null;
    }
  }
  return fsCall('write', undefined, () => sys<number>('write', { fd, pos }, bytes));
}

export function readvSync(fd: number, buffers: ArrayBufferView[], position?: number | null): number {
  let total = 0;
  for (const b of buffers) {
    const n = readSync(fd, b, 0, b.byteLength, position === null || position === undefined ? null : position + total);
    total += n;
    if (n < b.byteLength) break;
  }
  return total;
}

export function writevSync(fd: number, buffers: ArrayBufferView[], position?: number | null): number {
  let total = 0;
  for (const b of buffers) total += writeSync(fd, b, 0, b.byteLength, position === null || position === undefined ? null : position + total);
  return total;
}

export function ftruncateSync(fd: number, len = 0) {
  fsCall('ftruncate', undefined, () => sys('ftruncate', { fd, len }));
}

export function truncateSync(p: PathLike | number, len = 0) {
  if (typeof p === 'number') return ftruncateSync(p, len);
  const path = toPath(p);
  fsCall('open', path, () => sys('truncate', { p: path, len }));
}

export function fsyncSync(_fd: number) {}
export const fdatasyncSync = fsyncSync;

export function readdirSync(p: PathLike, opts?: any): any[] {
  const path = toPath(p);
  const withTypes = typeof opts === 'object' && opts?.withFileTypes;
  const recursive = typeof opts === 'object' && opts?.recursive;
  const encoding = encodingOf(opts);
  const list = (dir: string, rel: string, out: any[]) => {
    const entries = fsCall('scandir', dir, () => sys<[string, number][]>('readdir', { p: dir, types: true }));
    for (const [name, type] of entries) {
      const relName = rel ? `${rel}/${name}` : name;
      if (withTypes) out.push(new Dirent(name, type, dir));
      else out.push(encoding === 'buffer' ? Buffer.from(relName) : relName);
      if (recursive && type === 0o040000) list(`${dir}/${name}`, relName, out);
    }
  };
  const out: any[] = [];
  list(path, '', out);
  return out;
}

export function mkdirSync(p: PathLike, opts?: any): string | undefined {
  const path = toPath(p);
  const recursive = typeof opts === 'object' ? !!opts?.recursive : false;
  const mode = typeof opts === 'number' ? opts : typeof opts === 'string' ? parseInt(opts, 8) : (opts?.mode ?? 0o777);
  return fsCall('mkdir', path, () => sys<string | null>('mkdir', { p: path, recursive, mode })) ?? undefined;
}

export function mkdtempSync(prefix: string, _opts?: any): string {
  const base = toPath(prefix + 'XXXXXX').slice(0, -6);
  return fsCall('mkdtemp', prefix, () => sys<string>('mkdtemp', { prefix: base }));
}

export function rmdirSync(p: PathLike, opts?: { recursive?: boolean }) {
  const path = toPath(p);
  if (opts?.recursive) return rmSync(path, { recursive: true, force: true });
  fsCall('rmdir', path, () => sys('rmdir', { p: path }));
}

export function rmSync(p: PathLike, opts?: { recursive?: boolean; force?: boolean }) {
  const path = toPath(p);
  fsCall('rm', path, () => sys('rm', { p: path, recursive: !!opts?.recursive, force: !!opts?.force }));
}

export function unlinkSync(p: PathLike) {
  const path = toPath(p);
  fsCall('unlink', path, () => sys('unlink', { p: path }));
}

export function renameSync(from: PathLike, to: PathLike) {
  const a = toPath(from, 'oldPath');
  const b = toPath(to, 'newPath');
  fsCall('rename', a, () => sys('rename', { from: a, to: b }), b);
}

export function linkSync(existing: PathLike, newPath: PathLike) {
  const a = toPath(existing);
  const b = toPath(newPath);
  fsCall('link', a, () => sys('link', { from: a, to: b }), b);
}

export function symlinkSync(target: PathLike, p: PathLike, _type?: string) {
  const t = typeof target === 'string' ? target : toPath(target);
  const path = toPath(p);
  fsCall('symlink', t, () => sys('symlink', { target: t, p: path }), path);
}

export function readlinkSync(p: PathLike, opts?: any): any {
  const path = toPath(p);
  const r = fsCall('readlink', path, () => sys<string>('readlink', { p: path }));
  return encodingOf(opts) === 'buffer' ? Buffer.from(r) : r;
}

export function realpathSync(p: PathLike, opts?: any): any {
  const path = toPath(p);
  const r = fsCall('realpath', path, () => sys<string>('realpath', { p: path }));
  return encodingOf(opts) === 'buffer' ? Buffer.from(r) : r;
}
realpathSync.native = realpathSync;

export function chmodSync(p: PathLike, mode: number | string) {
  const path = toPath(p);
  fsCall('chmod', path, () => sys('chmod', { p: path, mode: typeof mode === 'string' ? parseInt(mode, 8) : mode }));
}
export const lchmodSync = chmodSync;

export function fchmodSync(fd: number, mode: number | string) {
  fsCall('fchmod', undefined, () => sys('fchmod', { fd, mode: typeof mode === 'string' ? parseInt(mode, 8) : mode }));
}

export function chownSync(_p: PathLike, _uid: number, _gid: number) {}
export const lchownSync = chownSync;
export function fchownSync(_fd: number, _uid: number, _gid: number) {}

function toMs(t: any): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string') return Number(t) * 1000;
  if (typeof t === 'bigint') return Number(t) * 1000;
  return Number(t) * 1000;
}

export function utimesSync(p: PathLike, atime: any, mtime: any) {
  const path = toPath(p);
  fsCall('utime', path, () => sys('utimes', { p: path, atime: toMs(atime), mtime: toMs(mtime) }));
}
export const lutimesSync = utimesSync;

export function futimesSync(fd: number, atime: any, mtime: any) {
  fsCall('futime', undefined, () => sys('futimes', { fd, atime: toMs(atime), mtime: toMs(mtime) }));
}

export function copyFileSync(src: PathLike, dest: PathLike, mode = 0) {
  const a = toPath(src, 'src');
  const b = toPath(dest, 'dest');
  fsCall('copyfile', a, () => sys('copyFile', { from: a, to: b, excl: !!(mode & 1) }), b);
}

export function cpSync(src: PathLike, dest: PathLike, opts: any = {}) {
  const a = toPath(src, 'src');
  const b = toPath(dest, 'dest');
  if (typeof opts.filter === 'function') {
    // walk in JS so the filter can be applied
    const walk = (s: string, d: string) => {
      if (!opts.filter(s, d)) return;
      const st = lstatSync(s)!;
      if (st.isDirectory()) {
        mkdirSync(d, { recursive: true });
        for (const n of readdirSync(s)) walk(`${s}/${n}`, `${d}/${n}`);
      } else if (st.isSymbolicLink() && !opts.dereference) {
        try {
          unlinkSync(d);
        } catch {}
        symlinkSync(readlinkSync(s), d);
      } else {
        if (opts.errorOnExist && existsSync(d) && opts.force === false) throw fsCall('cp', d, () => {
          throw new SysError('EEXIST', 'exists');
        });
        if (opts.force === false && existsSync(d)) return;
        copyFileSync(s, d);
      }
    };
    walk(a, b);
    return;
  }
  const st = statSync(a)!;
  if (st.isDirectory() && !opts.recursive) {
    const e = new Error(`Recursive option is required to copy a directory: ${a}`) as Error & { code: string };
    e.code = 'ERR_FS_EISDIR';
    throw e;
  }
  fsCall('cp', a, () => sys('cp', { from: a, to: b, force: opts.force !== false, errorOnExist: !!opts.errorOnExist, dereference: !!opts.dereference }), b);
}

export function opendirSync(p: PathLike, _opts?: any): Dir {
  const path = toPath(p);
  return new Dir(path, readdirSync(path, { withFileTypes: true }));
}

export class Dir {
  private i = 0;
  constructor(public path: string, private entries: Dirent[]) {}
  readSync(): Dirent | null {
    return this.entries[this.i++] ?? null;
  }
  read(cb?: (err: Error | null, d: Dirent | null) => void): any {
    const d = this.readSync();
    if (cb) {
      macrotask(() => cb(null, d));
      return;
    }
    return Promise.resolve(d);
  }
  closeSync() {}
  close(cb?: (err: Error | null) => void): any {
    if (cb) {
      macrotask(() => cb(null));
      return;
    }
    return Promise.resolve();
  }
  async *[Symbol.asyncIterator]() {
    let d: Dirent | null;
    while ((d = this.readSync())) yield d;
  }
  *entriesSync() {
    let d: Dirent | null;
    while ((d = this.readSync())) yield d;
  }
}

export function globSync(pattern: string | string[], opts: any = {}): string[] {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const cwd = opts.cwd ? toPath(opts.cwd) : cwdFn();
  const out = new Set<string>();
  const exclude = typeof opts.exclude === 'function' ? opts.exclude : null;
  const all: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude(r)) continue;
      all.push(r);
      if (e.isDirectory()) walk(`${dir}/${e.name}`, r);
    }
  };
  walk(cwd, '');
  for (const p of patterns) {
    const re = pathMod.globToRegExp(p);
    for (const f of all) if (re.test(f)) out.add(f);
  }
  return [...out];
}

// -----------------------------------------------------------------------------
// callback API (runs the sync version, calls back on a later macrotask)

function callbackify(fnSync: (...a: any[]) => any) {
  return function (this: unknown, ...args: any[]) {
    let cb = args[args.length - 1];
    if (typeof cb !== 'function') {
      cb = null;
    } else args.pop();
    let result: any;
    let error: any = null;
    try {
      result = fnSync(...args);
    } catch (e) {
      error = e;
    }
    if (!cb) {
      if (error) throw error;
      return;
    }
    ref();
    macrotask(() => {
      unref();
      if (error) cb(error);
      else cb(null, result);
    });
  };
}

export const access = callbackify(accessSync);
export const stat = callbackify(statSync);
export const lstat = callbackify(lstatSync);
export const fstat = callbackify(fstatSync);
export const statfs = callbackify(statfsSync);
export const readFile = callbackify(readFileSync);
export const writeFile = callbackify(writeFileSync);
export const appendFile = callbackify(appendFileSync);
export const open = callbackify(openSync);
export const close = callbackify(closeSync);
export const ftruncate = callbackify(ftruncateSync);
export const truncate = callbackify(truncateSync);
export const fsync = callbackify(fsyncSync);
export const fdatasync = fsync;
export const readdir = callbackify(readdirSync);
export const mkdir = callbackify(mkdirSync);
export const mkdtemp = callbackify(mkdtempSync);
export const rmdir = callbackify(rmdirSync);
export const rm = callbackify(rmSync);
export const unlink = callbackify(unlinkSync);
export const rename = callbackify(renameSync);
export const link = callbackify(linkSync);
export const symlink = callbackify(symlinkSync);
export const readlink = callbackify(readlinkSync);
export const realpath: any = callbackify(realpathSync);
realpath.native = realpath;
export const chmod = callbackify(chmodSync);
export const lchmod = chmod;
export const fchmod = callbackify(fchmodSync);
export const chown = callbackify(chownSync);
export const lchown = chown;
export const fchown = callbackify(fchownSync);
export const utimes = callbackify(utimesSync);
export const lutimes = utimes;
export const futimes = callbackify(futimesSync);
export const copyFile = callbackify(copyFileSync);
export const cp = callbackify(cpSync);
export const opendir = callbackify(opendirSync);
export const glob = callbackify(globSync);

export function exists(p: PathLike, cb: (e: boolean) => void) {
  const r = existsSync(p);
  macrotask(() => cb(r));
}

// read/write with async-looking callbacks; reads on pipes/tty may block, so use the async path for those
export function read(fd: number, ...args: any[]) {
  const cb = args.pop();
  let buffer: ArrayBufferView;
  let offset = 0;
  let length: number | undefined;
  let position: number | null = null;
  if (args.length === 0 || (args.length === 1 && !ArrayBuffer.isView(args[0]))) {
    const o = args[0] ?? {};
    buffer = o.buffer ?? Buffer.alloc(16384);
    offset = o.offset ?? 0;
    length = o.length;
    position = o.position ?? null;
  } else {
    buffer = args[0];
    if (args[1] && typeof args[1] === 'object') {
      offset = args[1].offset ?? 0;
      length = args[1].length;
      position = args[1].position ?? null;
    } else {
      offset = args[1] ?? 0;
      length = args[2];
      position = args[3] ?? null;
    }
  }
  const len = length ?? buffer.byteLength - offset;
  if (isStreamFd(fd)) {
    readAsync(fd, len).then(
      (d) => {
        new Uint8Array(buffer.buffer, buffer.byteOffset + offset, d.length).set(d);
        cb(null, d.length, buffer);
      },
      (e) => cb(e),
    );
    return;
  }
  try {
    const n = readSync(fd, buffer, offset, len, position);
    ref();
    macrotask(() => {
      unref();
      cb(null, n, buffer);
    });
  } catch (e) {
    macrotask(() => cb(e));
  }
}

export function write(fd: number, buffer: any, ...args: any[]) {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
  try {
    const n = (writeSync as any)(fd, buffer, ...args);
    ref();
    macrotask(() => {
      unref();
      cb(null, n, buffer);
    });
  } catch (e) {
    macrotask(() => cb(e));
  }
}

export const readv = callbackify(readvSync);
export const writev = callbackify(writevSync);

// fds that are pipes/ttys: kernel reports via fstat (S_IFIFO / S_IFCHR)
const streamFdCache = new Map<number, boolean>();
function isStreamFd(fd: number): boolean {
  try {
    const s = sys<RawStat>('fstat', { fd });
    const t = s.mode & 0o170000;
    const r = t === 0o010000 || t === 0o020000 || t === 0o140000;
    streamFdCache.set(fd, r);
    return r;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// async reads of pipes/ttys (kernel pushes data messages)

type StreamReader = { onData: (d: Uint8Array | null) => void };
const fdReaders = new Map<number, StreamReader>();
let readSeq = 1;
const pendingReads = new Map<number, { resolve: (d: Uint8Array) => void; reject: (e: unknown) => void }>();

/** One-shot async read on a stream fd. */
export function readAsync(fd: number, len: number): Promise<Uint8Array> {
  const id = readSeq++;
  ref();
  return new Promise<Uint8Array>((resolve, reject) => {
    pendingReads.set(id, { resolve, reject });
    post({ t: 'readOnce', fd, len, id });
  }).finally(unref);
}

/** Starts continuous reading of a stream fd; returns a stop function. */
export function startReading(fd: number, onData: (d: Uint8Array | null) => void): () => void {
  fdReaders.set(fd, { onData });
  post({ t: 'readStart', fd });
  return () => {
    if (fdReaders.get(fd)?.onData === onData) {
      fdReaders.delete(fd);
      post({ t: 'readStop', fd });
    }
  };
}

export function onKernelData(msg: { fd?: number; id?: number; data: Uint8Array | null; err?: string }) {
  if (msg.id !== undefined) {
    const p = pendingReads.get(msg.id);
    if (!p) return;
    pendingReads.delete(msg.id);
    if (msg.err) p.reject(fsCall('read', undefined, () => {
      throw new SysError(msg.err!, msg.err!);
    }));
    else p.resolve(msg.data ?? new Uint8Array(0));
    return;
  }
  const r = fdReaders.get(msg.fd!);
  if (!r) return;
  if (msg.data === null) fdReaders.delete(msg.fd!);
  r.onData(msg.data);
}

// -----------------------------------------------------------------------------
// watch

const watchers = new Map<number, (ev: { type: string; path: string }) => void>();
let watchSeq = 1;

export function onWatchEvent(msg: { id: number; type: string; path: string }) {
  watchers.get(msg.id)?.(msg);
}

export class FSWatcher extends EventEmitter {
  private id: number;
  private handle = new Handle();
  constructor(path: string, opts: { recursive?: boolean; persistent?: boolean }, listener?: (ev: string, f: string) => void) {
    super();
    this.id = watchSeq++;
    const base = path;
    watchers.set(this.id, (ev) => {
      const rel = ev.path === base ? pathMod.basename(base) : ev.path.startsWith(base + '/') ? ev.path.slice(base.length + 1) : pathMod.basename(ev.path);
      this.emit('change', ev.type, rel);
    });
    if (listener) this.on('change', listener);
    sys('watch', { id: this.id, p: path, recursive: !!opts.recursive });
    this.handle.activate();
    if (opts.persistent === false) this.handle.unref();
  }
  close() {
    if (!watchers.has(this.id)) return;
    watchers.delete(this.id);
    try {
      sys('unwatch', { id: this.id });
    } catch {}
    this.handle.deactivate();
    macrotask(() => this.emit('close'));
  }
  ref() {
    this.handle.ref();
    return this;
  }
  unref() {
    this.handle.unref();
    return this;
  }
}

export function watch(p: PathLike, opts?: any, listener?: any): FSWatcher {
  if (typeof opts === 'function') {
    listener = opts;
    opts = {};
  }
  if (typeof opts === 'string') opts = { encoding: opts };
  const path = toPath(p);
  fsCall('watch', path, () => sys('stat', { p: path }));
  return new FSWatcher(path, opts ?? {}, listener);
}

const statWatchers = new Map<string, { timer: any; listeners: Set<(cur: Stats, prev: Stats) => void>; prev: Stats }>();

export function watchFile(p: PathLike, opts?: any, listener?: any) {
  if (typeof opts === 'function') {
    listener = opts;
    opts = {};
  }
  const path = toPath(p);
  let w = statWatchers.get(path);
  const empty = new Stats({ dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 0, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 });
  if (!w) {
    const interval = opts?.interval ?? 5007;
    const entry = { timer: null as any, listeners: new Set<(cur: Stats, prev: Stats) => void>(), prev: (statSync(path, { throwIfNoEntry: false }) as Stats) ?? empty };
    entry.timer = setInterval(() => {
      const cur = (statSync(path, { throwIfNoEntry: false }) as Stats) ?? empty;
      if (cur.mtimeMs !== entry.prev.mtimeMs || cur.size !== entry.prev.size || cur.ino !== entry.prev.ino) {
        const prev = entry.prev;
        entry.prev = cur;
        for (const l of entry.listeners) l(cur, prev);
      }
    }, Math.min(interval, 1000));
    if (opts?.persistent === false) entry.timer.unref?.();
    statWatchers.set(path, entry);
    w = entry;
  }
  if (listener) w.listeners.add(listener);
  return { ref() {}, unref() {} };
}

export function unwatchFile(p: PathLike, listener?: any) {
  const path = toPath(p);
  const w = statWatchers.get(path);
  if (!w) return;
  if (listener) w.listeners.delete(listener);
  else w.listeners.clear();
  if (!w.listeners.size) {
    clearInterval(w.timer);
    statWatchers.delete(path);
  }
}

// -----------------------------------------------------------------------------
// streams

export class ReadStream extends Readable {
  path: string;
  fd: number | null;
  flags: string;
  mode: number;
  start: number | undefined;
  end: number;
  pos: number | undefined;
  bytesRead = 0;
  pending = true;
  private _autoClose: boolean;
  private _stopStream?: () => void;
  constructor(p: PathLike | null, opts: any = {}) {
    if (typeof opts === 'string') opts = { encoding: opts };
    super({ highWaterMark: opts.highWaterMark ?? 64 * 1024, encoding: opts.encoding, emitClose: opts.emitClose ?? true, signal: opts.signal });
    this.path = p === null || p === undefined ? '' : toPath(p as PathLike);
    this.fd = opts.fd ?? null;
    this.flags = opts.flags ?? 'r';
    this.mode = opts.mode ?? 0o666;
    this.start = opts.start;
    this.end = opts.end ?? Infinity;
    this.pos = this.start;
    this._autoClose = opts.autoClose ?? true;
    if (this.fd === null) {
      macrotask(() => this._openNow());
    } else this.pending = false;
  }
  private _openNow() {
    if (this.fd !== null || this.destroyed) return;
    try {
      this.fd = openSync(this.path, this.flags, this.mode);
      this.pending = false;
      this.emit('open', this.fd);
      this.emit('ready');
    } catch (e) {
      this.destroy(e as Error);
    }
  }
  _construct(cb: (e?: Error | null) => void) {
    cb();
  }
  _read(n: number) {
    if (this.fd === null) {
      this.once('open', () => this._read(n));
      return;
    }
    const fd = this.fd;
    if (isStreamFd(fd)) {
      if (!this._stopStream) {
        this._stopStream = startReading(fd, (d) => {
          if (d === null) {
            this._stopStream = undefined;
            this.push(null);
            return;
          }
          this.bytesRead += d.length;
          if (!this.push(Buffer.from(d))) {
            this._stopStream?.();
            this._stopStream = undefined;
          }
        });
      }
      return;
    }
    const remaining = this.end === Infinity ? n : Math.min(n, this.end - (this.pos ?? this.bytesRead) + 1);
    if (remaining <= 0) {
      this.push(null);
      return;
    }
    const buf = Buffer.allocUnsafe(remaining);
    let got: number;
    try {
      got = readSync(fd, buf, 0, remaining, this.pos ?? null);
    } catch (e) {
      this.destroy(e as Error);
      return;
    }
    if (this.pos !== undefined) this.pos += got;
    this.bytesRead += got;
    this.push(got === 0 ? null : buf.subarray(0, got));
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this._stopStream?.();
    if (this.fd !== null && this._autoClose && this.fd > 2) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    cb(err);
  }
  close(cb?: (e?: Error | null) => void) {
    if (cb) this.once('close', cb);
    this.destroy();
  }
}

export class WriteStream extends Writable {
  path: string;
  fd: number | null;
  flags: string;
  mode: number;
  start: number | undefined;
  pos: number | undefined;
  bytesWritten = 0;
  pending = true;
  private _autoClose: boolean;
  constructor(p: PathLike | null, opts: any = {}) {
    if (typeof opts === 'string') opts = { encoding: opts };
    super({ highWaterMark: opts.highWaterMark, decodeStrings: true, emitClose: opts.emitClose ?? true, signal: opts.signal });
    this.path = p === null || p === undefined ? '' : toPath(p as PathLike);
    this.fd = opts.fd ?? null;
    this.flags = opts.flags ?? 'w';
    this.mode = opts.mode ?? 0o666;
    this.start = opts.start;
    this.pos = this.start;
    this._autoClose = opts.autoClose ?? true;
    if (this.fd === null) {
      try {
        this.fd = openSync(this.path, this.flags, this.mode);
        this.pending = false;
        macrotask(() => {
          this.emit('open', this.fd);
          this.emit('ready');
        });
      } catch (e) {
        macrotask(() => this.destroy(e as Error));
      }
    } else this.pending = false;
  }
  _write(chunk: any, encoding: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
      const n = writeSync(this.fd!, bytes, 0, bytes.length, this.pos ?? null);
      if (this.pos !== undefined) this.pos += n;
      this.bytesWritten += n;
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    if (this.fd !== null && this._autoClose && this.fd > 2) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    cb(err);
  }
  close(cb?: (e?: Error | null) => void) {
    if (cb) this.once('close', cb);
    if (!this.writableEnded) this.end();
    else this.destroy();
  }
  destroySoon() {
    this.end();
  }
}

export function createReadStream(p: PathLike, opts?: any) {
  return new ReadStream(p, opts);
}

export function createWriteStream(p: PathLike, opts?: any) {
  return new WriteStream(p, opts);
}

// -----------------------------------------------------------------------------
// promises

export class FileHandle extends EventEmitter {
  constructor(public fd: number) {
    super();
  }
  async readFile(opts?: any) {
    return readFileSync(this.fd, opts);
  }
  async writeFile(data: any, opts?: any) {
    writeFileSync(this.fd, data, opts);
  }
  async appendFile(data: any, opts?: any) {
    writeFileSync(this.fd, data, opts);
  }
  async read(buffer?: any, offset?: number, length?: number, position?: number | null) {
    if (buffer && !ArrayBuffer.isView(buffer)) {
      const o = buffer;
      buffer = o.buffer ?? Buffer.alloc(16384);
      offset = o.offset;
      length = o.length;
      position = o.position;
    }
    buffer ??= Buffer.alloc(16384);
    const bytesRead = readSync(this.fd, buffer, offset ?? 0, length ?? buffer.byteLength - (offset ?? 0), position ?? null);
    return { bytesRead, buffer };
  }
  async write(data: any, ...args: any[]) {
    const bytesWritten = (writeSync as any)(this.fd, data, ...args);
    return { bytesWritten, buffer: data };
  }
  async writev(buffers: ArrayBufferView[], position?: number) {
    return { bytesWritten: writevSync(this.fd, buffers, position), buffers };
  }
  async readv(buffers: ArrayBufferView[], position?: number) {
    return { bytesRead: readvSync(this.fd, buffers, position), buffers };
  }
  async stat(opts?: any) {
    return fstatSync(this.fd, opts);
  }
  async truncate(len?: number) {
    ftruncateSync(this.fd, len);
  }
  async sync() {}
  async datasync() {}
  async chmod(mode: number) {
    fchmodSync(this.fd, mode);
  }
  async chown() {}
  async utimes(a: any, m: any) {
    futimesSync(this.fd, a, m);
  }
  async close() {
    if (this.fd < 0) return;
    closeSync(this.fd);
    this.fd = -1;
    this.emit('close');
  }
  createReadStream(opts: any = {}) {
    return new ReadStream(null, { ...opts, fd: this.fd });
  }
  createWriteStream(opts: any = {}) {
    return new WriteStream(null, { ...opts, fd: this.fd });
  }
  readLines(opts?: any) {
    // lazily require readline to avoid a cycle
    const { createInterface } = (globalThis as any).__ov.builtin('readline');
    return createInterface({ input: this.createReadStream(opts), crlfDelay: Infinity });
  }
  readableWebStream() {
    const fd = this.fd;
    return new ReadableStream({
      pull(ctrl) {
        const buf = new Uint8Array(65536);
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) ctrl.close();
        else ctrl.enqueue(buf.subarray(0, n));
      },
    });
  }
  [Symbol.asyncDispose ?? Symbol.for('asyncDispose')]() {
    return this.close();
  }
}

function promisifySync<T extends (...a: any[]) => any>(fn: T) {
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => fn(...args);
}

export const promises = {
  access: promisifySync(accessSync),
  stat: promisifySync(statSync),
  lstat: promisifySync(lstatSync),
  statfs: promisifySync(statfsSync),
  readFile: async (p: any, opts?: any) => (p instanceof FileHandle ? p.readFile(opts) : readFileSync(p, opts)),
  writeFile: async (p: any, data: any, opts?: any) => {
    if (p instanceof FileHandle) return p.writeFile(data, opts);
    if (data && typeof data === 'object' && !(data instanceof Uint8Array) && !ArrayBuffer.isView(data) && (Symbol.asyncIterator in data || Symbol.iterator in data) && typeof data !== 'string') {
      const chunks: Uint8Array[] = [];
      for await (const c of data) chunks.push(typeof c === 'string' ? enc.encode(c) : c);
      return writeFileSync(p, Buffer.concat(chunks), opts);
    }
    return writeFileSync(p, data, opts);
  },
  appendFile: promisifySync(appendFileSync),
  open: async (p: PathLike, flags?: string | number, mode?: number) => new FileHandle(openSync(p, flags, mode)),
  truncate: promisifySync(truncateSync),
  readdir: promisifySync(readdirSync),
  mkdir: promisifySync(mkdirSync),
  mkdtemp: promisifySync(mkdtempSync),
  rmdir: promisifySync(rmdirSync),
  rm: promisifySync(rmSync),
  unlink: promisifySync(unlinkSync),
  rename: promisifySync(renameSync),
  link: promisifySync(linkSync),
  symlink: promisifySync(symlinkSync),
  readlink: promisifySync(readlinkSync),
  realpath: promisifySync(realpathSync),
  chmod: promisifySync(chmodSync),
  lchmod: promisifySync(chmodSync),
  chown: promisifySync(chownSync),
  lchown: promisifySync(chownSync),
  utimes: promisifySync(utimesSync),
  lutimes: promisifySync(utimesSync),
  copyFile: promisifySync(copyFileSync),
  cp: async (src: PathLike, dest: PathLike, opts: any = {}) => {
    if (typeof opts.filter === 'function') {
      const filter = opts.filter;
      const walk = async (s: string, d: string) => {
        if (!(await filter(s, d))) return;
        const st = lstatSync(s)!;
        if (st.isDirectory()) {
          mkdirSync(d, { recursive: true });
          for (const n of readdirSync(s)) await walk(`${s}/${n}`, `${d}/${n}`);
        } else if (st.isSymbolicLink() && !opts.dereference) {
          try {
            unlinkSync(d);
          } catch {}
          symlinkSync(readlinkSync(s), d);
        } else if (!(opts.force === false && existsSync(d))) copyFileSync(s, d);
      };
      return walk(toPath(src), toPath(dest));
    }
    return cpSync(src, dest, opts);
  },
  opendir: promisifySync(opendirSync),
  watch: (p: PathLike, opts: any = {}) => {
    const w = watch(p, { ...opts, persistent: opts.persistent ?? true });
    return on_(w, 'change', opts.signal);
  },
  glob: async function* (pattern: string | string[], opts?: any) {
    for (const f of globSync(pattern, opts)) yield f;
  },
  constants,
  FileHandle,
};

function on_(w: FSWatcher, ev: string, signal?: AbortSignal): AsyncIterableIterator<{ eventType: string; filename: string }> {
  const q: { eventType: string; filename: string }[] = [];
  let waiter: ((v: IteratorResult<any>) => void) | null = null;
  let done = false;
  w.on(ev, (eventType: string, filename: string) => {
    const item = { eventType, filename };
    if (waiter) {
      waiter({ value: item, done: false });
      waiter = null;
    } else q.push(item);
  });
  signal?.addEventListener('abort', () => {
    done = true;
    w.close();
    waiter?.({ value: undefined, done: true });
  });
  return {
    next: () => (q.length ? Promise.resolve({ value: q.shift()!, done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => (waiter = r))),
    return: () => {
      done = true;
      w.close();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as any;
}

export default {
  constants, F_OK, R_OK, W_OK, X_OK, Stats, BigIntStats, Dirent, Dir, FSWatcher, ReadStream, WriteStream, FileHandle,
  existsSync, accessSync, statSync, lstatSync, fstatSync, statfsSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, readSync, writeSync, readvSync, writevSync, ftruncateSync, truncateSync, fsyncSync, fdatasyncSync, readdirSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, unlinkSync, renameSync, linkSync, symlinkSync, readlinkSync, realpathSync, chmodSync, lchmodSync, fchmodSync, chownSync, lchownSync, fchownSync, utimesSync, lutimesSync, futimesSync, copyFileSync, cpSync, opendirSync, globSync,
  access, stat, lstat, fstat, statfs, readFile, writeFile, appendFile, open, close, read, write, readv, writev, ftruncate, truncate, fsync, fdatasync, readdir, mkdir, mkdtemp, rmdir, rm, unlink, rename, link, symlink, readlink, realpath, chmod, lchmod, fchmod, chown, lchown, fchown, utimes, lutimes, futimes, copyFile, cp, opendir, glob, exists,
  watch, watchFile, unwatchFile, createReadStream, createWriteStream, promises,
};
