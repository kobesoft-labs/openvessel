// internalBinding('fs') — node_file.cc over the kernel's syscalls.
// Every operation is sync (throws a UVException), callback-based (last arg is an FSReqCallback,
// completed with req.oncomplete(err, result) on a later turn) or promise-based (last arg is kUsePromises).

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S, lib } from '../state.ts';
import { Enc, decode, encode, encodingOf } from './buffer.ts';
import { fromShape } from './shape.ts';
import { readOnce } from './stream.ts';
import { HandleWrap } from './stream.ts';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

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

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFIFO = 0o010000;
const DIRENT: Record<number, number> = { 0o100000: 1, 0o040000: 2, 0o120000: 3, 0o010000: 4, 0o140000: 5, 0o020000: 6, 0o060000: 7 };

let uvCodes: Record<string, number> | null = null;
function errnoOf(code: string): number {
  uvCodes ??= S.internalBinding('uv');
  return uvCodes![`UV_${code}`] ?? -1;
}

/** The error a failed libuv fs call produces (UVException). */
export function uvError(e: unknown, syscall: string, path?: unknown, dest?: unknown): Error {
  if (!(e instanceof SysError)) return e as Error;
  if (!e.code.startsWith('E')) {
    const err = new Error(e.message) as Error & { code: string };
    err.code = e.code;
    return err;
  }
  const { UVException } = lib('internal/errors');
  const ctx: Record<string, unknown> = { errno: errnoOf(e.code), code: e.code, syscall };
  if (path !== undefined) ctx.path = pathString(path);
  if (dest !== undefined) ctx.dest = pathString(dest);
  return new UVException(ctx);
}

export function pathString(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p instanceof Uint8Array) return decode(p, Enc.UTF8);
  if (p instanceof URL) return decodeURIComponent(p.pathname);
  return String(p);
}

export function fillStats(arr: Float64Array | BigInt64Array, offset: number, st: StatData) {
  // (no array destructuring: user code may have deleted Array.prototype[Symbol.iterator])
  const s = (ms: number) => Math.floor(ms / 1000);
  const ns = (ms: number) => Math.round((ms % 1000) * 1e6);
  const v = [st.dev, st.mode, st.nlink, st.uid, st.gid, st.rdev, st.blksize, st.ino, st.size, st.blocks, s(st.atimeMs), ns(st.atimeMs), s(st.mtimeMs), ns(st.mtimeMs), s(st.ctimeMs), ns(st.ctimeMs), s(st.birthtimeMs), ns(st.birthtimeMs)];
  if (arr instanceof BigInt64Array) for (let i = 0; i < 18; i++) arr[offset + i] = BigInt(Math.trunc(v[i]));
  else for (let i = 0; i < 18; i++) arr[offset + i] = v[i];
  return arr;
}

export function encodeOut(s: string, encoding: unknown): string | Uint8Array {
  if (encoding === 'buffer') return lib('buffer').Buffer.from(s);
  if (encoding === undefined || encoding === null || encoding === 'utf8' || encoding === 'utf-8') return s;
  return decode(encode(s, Enc.UTF8), encodingOf(encoding));
}

export function createFs() {
  const b = fromShape('fs');
  const kUsePromises: symbol = b.kUsePromises;
  const statValues: Float64Array = b.statValues;
  const bigintStatValues: BigInt64Array = b.bigintStatValues;

  class FSReqCallback {
    oncomplete: ((...a: unknown[]) => void) | null = null;
    context: unknown = null;
    constructor(public bigint = false) {}
  }

  /** Runs fn in the mode selected by req. */
  function run<T>(req: unknown, syscall: string, path: unknown, dest: unknown, fn: () => T): T | Promise<T> | undefined {
    if (req === undefined) {
      try {
        return fn();
      } catch (e) {
        throw uvError(e, syscall, path, dest);
      }
    }
    if (req === kUsePromises) {
      const done = loop.startReq('FSReqPromise');
      return new Promise<T>((resolve, reject) => {
        loop.macrotask(() => {
          done();
          try {
            resolve(fn());
          } catch (e) {
            reject(uvError(e, syscall, path, dest));
          }
        });
      });
    }
    const r = req as FSReqCallback;
    const done = loop.startReq('FSReqCallback');
    loop.macrotask(() => {
      let err: Error | null = null;
      let result: T | undefined;
      try {
        result = fn();
      } catch (e) {
        err = uvError(e, syscall, path, dest);
      }
      done();
      if (typeof r.oncomplete === 'function') {
        if (err) loop.scope(r.oncomplete, r, err);
        else loop.scope(r.oncomplete, r, null, result);
      }
    });
    return undefined;
  }

  /** Pipes, ttys and sockets: an async read waits for data without blocking the worker. */
  const isStreamFd = (fd: number) => {
    try {
      const k = sys<string | null>('fdKind', { fd });
      return k === 'pipe' || k === 'tty' || k === 'socket';
    } catch {
      return false;
    }
  };

  /** Like run() for work that completes asynchronously. */
  function runAsync<T>(req: unknown, syscall: string, fn: () => Promise<T>): Promise<T> | undefined {
    const done = loop.startReq(req === kUsePromises ? 'FSReqPromise' : 'FSReqCallback');
    const p = fn().then(
      (v) => {
        done();
        return v;
      },
      (e) => {
        done();
        throw uvError(e, syscall);
      },
    );
    if (req === kUsePromises) return p;
    const r = req as FSReqCallback;
    p.then(
      (v) => typeof r.oncomplete === 'function' && loop.scope(r.oncomplete, r, null, v),
      (e) => typeof r.oncomplete === 'function' && loop.scope(r.oncomplete, r, e),
    );
    return undefined;
  }

  const st = (p: unknown, l: boolean) => sys<StatData>('stat', { p: pathString(p), l });
  const fst = (fd: number) => sys<StatData>('fstat', { fd });

  function statResult(data: StatData, bigint: boolean, sync: boolean) {
    if (sync) return fillStats(bigint ? bigintStatValues : statValues, 0, data);
    return fillStats(bigint ? new BigInt64Array(18) : new Float64Array(18), 0, data);
  }

  function writeBytes(fd: number, bytes: Uint8Array, position: unknown): number {
    const pos = typeof position === 'number' && position >= 0 ? position : typeof position === 'bigint' ? Number(position) : null;
    return sys<number>('write', { fd, pos }, bytes);
  }

  function readBytes(fd: number, len: number, position: unknown): Uint8Array {
    const pos = typeof position === 'bigint' ? Number(position) : typeof position === 'number' && position >= 0 ? position : null;
    return sys<Uint8Array>('read', { fd, len, pos });
  }

  // a sync write reports errors through ctx (old-style), not by throwing
  function syncWithCtx<T>(ctx: any, syscall: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (e instanceof SysError && ctx) {
        ctx.errno = errnoOf(e.code);
        ctx.code = e.code;
        ctx.syscall = syscall;
        return undefined;
      }
      throw uvError(e, syscall);
    }
  }

  const ZERO_STAT: StatData = { dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 0, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 };
  // statbuf_eq() in libuv's fs-poll.c (atime and nlink are not compared)
  const sameStat = (a: StatData, b: StatData) =>
    a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.birthtimeMs === b.birthtimeMs && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.ino === b.ino && a.dev === b.dev;

  /**
   * node_stat_watcher.cc (uv_fs_poll_t): stats the path every `interval` ms and calls
   * onchange(status, stats) with the current stats at [0, 18) and the previous ones at [18, 36) of
   * the shared stat array. The first successful poll only records a baseline; an error is reported
   * once (with zeroed current stats) until the result changes again.
   */
  class StatWatcher extends HandleWrap {
    onchange: ((status: number, stats: Float64Array | BigInt64Array) => void) | null = null;
    #bigint: boolean;
    #path = '';
    #interval = 0;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #prev: StatData = ZERO_STAT;
    // libuv's busy_polling: 0 before the first result, 1 after a success, the error code after a failure
    #busy = 0;
    constructor(bigint: boolean) {
      super('StatWatcher');
      this.#bigint = !!bigint;
    }
    start(path: unknown, interval: number): number {
      if (this.#timer !== null || this._closed) return 0;
      this.#path = pathString(path);
      this.#interval = Math.max(1, interval >>> 0);
      this.setActive(true);
      // uv_fs_poll_start issues the first stat right away (on the thread pool)
      this.#timer = nativeSetTimeout(() => this.#poll(), 0);
      return 0;
    }
    #poll() {
      this.#timer = null;
      if (this._closed) return;
      const started = loop.now();
      let cur: StatData | null = null;
      let status = 0;
      try {
        cur = st(this.#path, false);
      } catch (e) {
        status = e instanceof SysError ? errnoOf(e.code) : errnoOf('EIO');
      }
      const prev = this.#prev;
      let notify = false;
      if (cur === null) {
        notify = this.#busy !== status;
        this.#busy = status;
      } else {
        notify = this.#busy !== 0 && (this.#busy < 0 || !sameStat(prev, cur));
        this.#prev = cur;
        this.#busy = 1;
      }
      if (notify && typeof this.onchange === 'function') {
        const arr = this.#bigint ? bigintStatValues : statValues;
        fillStats(arr, 0, cur ?? ZERO_STAT);
        fillStats(arr, 18, prev);
        loop.scope(this.onchange, this, status, arr);
      }
      if (this._closed) return;
      const elapsed = loop.now() - started;
      this.#timer = nativeSetTimeout(() => this.#poll(), Math.max(1, this.#interval - (elapsed % this.#interval)));
    }
    protected override _onClose() {
      if (this.#timer !== null) nativeClearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  class FileHandle {
    #fd: number;
    #closing = false;
    onread: unknown = null;
    constructor(fd: number) {
      this.#fd = fd;
    }
    get fd() {
      return this.#fd;
    }
    getAsyncId() {
      return -1;
    }
    close() {
      const fd = this.#fd;
      this.#closing = true;
      return run(kUsePromises, 'close', undefined, undefined, () => {
        if (fd >= 0) sys('close', { fd });
        this.#fd = -1;
      });
    }
    releaseFD() {
      const fd = this.#fd;
      this.#fd = -1;
      return fd;
    }
  }

  Object.assign(b, {
    FSReqCallback,
    FileHandle,
    StatWatcher,
    access: (path: unknown, mode: number, req?: unknown) => run(req, 'access', path, undefined, () => void sys('access', { p: pathString(path), mode })),
    existsSync(path: unknown) {
      try {
        st(path, false);
        return true;
      } catch {
        return false;
      }
    },
    open: (path: unknown, flags: number, mode: number, req?: unknown) => run(req, 'open', path, undefined, () => sys<number>('open', { p: pathString(path), flags, mode })),
    openFileHandle: (path: unknown, flags: number, mode: number, req?: unknown) =>
      run(req, 'open', path, undefined, () => new FileHandle(sys<number>('open', { p: pathString(path), flags, mode }))),
    close: (fd: number, req?: unknown) => run(req, 'close', undefined, undefined, () => void sys('close', { fd })),
    read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: unknown, req?: unknown) =>
      req !== undefined && length > 0 && isStreamFd(fd)
        ? runAsync(req, 'read', () =>
            readOnce(fd, length).then((d) => {
              buffer.set(d, offset);
              return d.length;
            }),
          )
        : run(req, 'read', undefined, undefined, () => {
        if (length === 0) return 0;
        const d = readBytes(fd, length, position);
        buffer.set(d, offset);
        return d.length;
      }),
    readBuffers: (fd: number, buffers: Uint8Array[], position: unknown, req?: unknown) =>
      run(req, 'read', undefined, undefined, () => {
        let total = 0;
        let pos = typeof position === 'number' && position >= 0 ? position : null;
        for (const buf of buffers) {
          const d = readBytes(fd, buf.byteLength, pos);
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).set(d);
          total += d.length;
          if (pos !== null) pos += d.length;
          if (d.length < buf.byteLength) break;
        }
        return total;
      }),
    readFileUtf8(path: unknown, flags: number) {
      try {
        if (typeof path === 'number') {
          const parts: Uint8Array[] = [];
          for (;;) {
            const d = readBytes(path, 1 << 20, null);
            if (!d.length) break;
            parts.push(d.slice());
          }
          let n = 0;
          for (const p of parts) n += p.length;
          const all = new Uint8Array(n);
          n = 0;
          for (const p of parts) {
            all.set(p, n);
            n += p.length;
          }
          return decode(all, Enc.UTF8);
        }
        void flags;
        const data = sys<Uint8Array>('readFile', { p: pathString(path) });
        return decode(data, Enc.UTF8);
      } catch (e) {
        throw uvError(e, 'open', path);
      }
    },
    writeFileUtf8(path: unknown, data: string, flags: number, mode: number) {
      const bytes = encode(data, Enc.UTF8);
      try {
        if (typeof path === 'number') {
          let off = 0;
          while (off < bytes.length) off += writeBytes(path, bytes.subarray(off), null);
          return;
        }
        sys('writeFile', { p: pathString(path), flags, mode }, bytes);
      } catch (e) {
        throw uvError(e, typeof path === 'number' ? 'write' : 'open', typeof path === 'number' ? undefined : path);
      }
    },
    writeBuffer(fd: number, buffer: ArrayBufferView, offset: number, length: number, position: unknown, req?: unknown, ctx?: unknown) {
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      if (req === undefined) return syncWithCtx(ctx, 'write', () => writeBytes(fd, bytes, position));
      return run(req, 'write', undefined, undefined, () => writeBytes(fd, bytes.slice(), position));
    },
    writeBuffers(fd: number, buffers: ArrayBufferView[], position: unknown, req?: unknown) {
      const parts = buffers.map((x) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
      let n = 0;
      for (const p of parts) n += p.length;
      const all = new Uint8Array(n);
      n = 0;
      for (const p of parts) {
        all.set(p, n);
        n += p.length;
      }
      return run(req, 'write', undefined, undefined, () => writeBytes(fd, all, position));
    },
    writeString(fd: number, str: string, position: unknown, encoding: unknown, req?: unknown, ctx?: unknown) {
      const bytes = encode(String(str), encodingOf(encoding ?? 'utf8'));
      if (req === undefined) return syncWithCtx(ctx, 'write', () => writeBytes(fd, bytes, position));
      return run(req, 'write', undefined, undefined, () => writeBytes(fd, bytes, position));
    },
    fdatasync: (fd: number, req?: unknown) => run(req, 'fdatasync', undefined, undefined, () => void fst(fd)),
    fsync: (fd: number, req?: unknown) => run(req, 'fsync', undefined, undefined, () => void fst(fd)),
    rename: (from: unknown, to: unknown, req?: unknown) => run(req, 'rename', from, to, () => void sys('rename', { from: pathString(from), to: pathString(to) })),
    ftruncate: (fd: number, len: number, req?: unknown) => run(req, 'ftruncate', undefined, undefined, () => void sys('ftruncate', { fd, len: Number(len) })),
    rmdir: (path: unknown, req?: unknown) => run(req, 'rmdir', path, undefined, () => void sys('rmdir', { p: pathString(path) })),
    mkdir: (path: unknown, mode: number, recursive: boolean, req?: unknown) =>
      run(req, 'mkdir', path, undefined, () => {
        const r = sys<string | null>('mkdir', { p: pathString(path), mode, recursive });
        return recursive ? (r ?? undefined) : undefined;
      }),
    readdir: (path: unknown, encoding: unknown, withTypes: boolean, req?: unknown) =>
      run(req, 'scandir', path, undefined, () => {
        if (withTypes) {
          const entries = sys<[string, number][]>('readdir', { p: pathString(path), types: true });
          return [entries.map(([n]) => encodeOut(n, encoding)), entries.map(([, t]) => DIRENT[t & S_IFMT] ?? 0)];
        }
        return sys<string[]>('readdir', { p: pathString(path) }).map((n) => encodeOut(n, encoding));
      }),
    internalModuleStat(path: unknown) {
      try {
        const s = st(path, false);
        return (s.mode & S_IFMT) === S_IFDIR ? 1 : 0;
      } catch {
        return -2;
      }
    },
    stat(path: unknown, bigint: boolean, req?: unknown, throwIfNoEntry = true) {
      if (req === undefined && !throwIfNoEntry) {
        try {
          return statResult(st(path, false), bigint, true);
        } catch (e) {
          if (e instanceof SysError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined;
          throw uvError(e, 'stat', path);
        }
      }
      return run(req, 'stat', path, undefined, () => statResult(st(path, false), bigint, req === undefined));
    },
    lstat(path: unknown, bigint: boolean, req?: unknown, throwIfNoEntry = true) {
      if (req === undefined && !throwIfNoEntry) {
        try {
          return statResult(st(path, true), bigint, true);
        } catch (e) {
          if (e instanceof SysError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined;
          throw uvError(e, 'lstat', path);
        }
      }
      return run(req, 'lstat', path, undefined, () => statResult(st(path, true), bigint, req === undefined));
    },
    fstat(fd: number, bigint: boolean, req?: unknown, shouldNotThrow = false) {
      if (req === undefined && shouldNotThrow) {
        try {
          return statResult(fst(fd), bigint, true);
        } catch {
          return undefined;
        }
      }
      return run(req, 'fstat', undefined, undefined, () => statResult(fst(fd), bigint, req === undefined));
    },
    statfs(path: unknown, bigint: boolean, req?: unknown) {
      return run(req, 'statfs', path, undefined, () => {
        st(path, false);
        const v = [0xef53, 4096, 1 << 20, 1 << 19, 1 << 19, 1 << 20, 1 << 19];
        if (bigint) return BigInt64Array.from(v.map(BigInt));
        return Float64Array.from(v);
      });
    },
    link: (from: unknown, to: unknown, req?: unknown) => run(req, 'link', from, to, () => void sys('link', { from: pathString(from), to: pathString(to) })),
    symlink: (target: unknown, path: unknown, _flags: number, req?: unknown) => run(req, 'symlink', target, path, () => void sys('symlink', { target: pathString(target), p: pathString(path) })),
    readlink: (path: unknown, encoding: unknown, req?: unknown) => run(req, 'readlink', path, undefined, () => encodeOut(sys<string>('readlink', { p: pathString(path) }), encoding)),
    unlink: (path: unknown, req?: unknown) => run(req, 'unlink', path, undefined, () => void sys('unlink', { p: pathString(path) })),
    realpath: (path: unknown, encoding: unknown, req?: unknown) => run(req, 'realpath', path, undefined, () => encodeOut(sys<string>('realpath', { p: pathString(path) }), encoding)),
    copyFile: (from: unknown, to: unknown, mode: number, req?: unknown) =>
      run(req, 'copyfile', from, to, () => void sys('copyFile', { from: pathString(from), to: pathString(to), excl: !!(mode & 1) })),
    chmod: (path: unknown, mode: number, req?: unknown) => run(req, 'chmod', path, undefined, () => void sys('chmod', { p: pathString(path), mode })),
    fchmod: (fd: number, mode: number, req?: unknown) => run(req, 'fchmod', undefined, undefined, () => void sys('fchmod', { fd, mode })),
    chown: (path: unknown, _u: number, _g: number, req?: unknown) => run(req, 'chown', path, undefined, () => void st(path, false)),
    fchown: (fd: number, _u: number, _g: number, req?: unknown) => run(req, 'fchown', undefined, undefined, () => void fst(fd)),
    lchown: (path: unknown, _u: number, _g: number, req?: unknown) => run(req, 'lchown', path, undefined, () => void st(path, true)),
    utimes: (path: unknown, atime: number, mtime: number, req?: unknown) =>
      run(req, 'utime', path, undefined, () => void sys('utimes', { p: pathString(path), atime: atime * 1000, mtime: mtime * 1000 })),
    futimes: (fd: number, atime: number, mtime: number, req?: unknown) => run(req, 'futime', undefined, undefined, () => void sys('futimes', { fd, atime: atime * 1000, mtime: mtime * 1000 })),
    lutimes: (path: unknown, atime: number, mtime: number, req?: unknown) =>
      run(req, 'lutime', path, undefined, () => void sys('utimes', { p: pathString(path), atime: atime * 1000, mtime: mtime * 1000, l: true })),
    mkdtemp: (prefix: unknown, encoding: unknown, req?: unknown) => run(req, 'mkdtemp', `${pathString(prefix)}XXXXXX`, undefined, () => encodeOut(sys<string>('mkdtemp', { prefix: pathString(prefix) }), encoding)),
    /** ESM resolution of a package's "main" (node_file.cc LegacyMainResolve): the index of the first candidate that is a file. */
    legacyMainResolve(pkgPath: string, main: string | undefined, base: string | undefined) {
      const isFile = (p: string) => {
        try {
          return (st(p, false).mode & S_IFMT) === S_IFREG;
        } catch {
          return false;
        }
      };
      const join = (a: string, b: string) => {
        const parts: string[] = [];
        for (const seg of `${a}/${b}`.split('/')) {
          if (!seg || seg === '.') continue;
          if (seg === '..') parts.pop();
          else parts.push(seg);
        }
        return '/' + parts.join('/');
      };
      if (typeof main === 'string') {
        const exts = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'];
        for (let i = 0; i < exts.length; i++) if (isFile(join(pkgPath, main + exts[i]))) return i;
      }
      const tail = ['./index.js', './index.json', './index.node'];
      for (let i = 0; i < tail.length; i++) if (isFile(join(pkgPath, tail[i]))) return 7 + i;
      const { codes } = lib('internal/errors');
      throw new codes.ERR_MODULE_NOT_FOUND(pkgPath, base && base.startsWith('file:') ? decodeURIComponent(new URL(base).pathname) : base, undefined);
    },
    getFormatOfExtensionlessFile(path: unknown) {
      try {
        const fd = sys<number>('open', { p: pathString(path), flags: 0 });
        try {
          const head = readBytes(fd, 4, 0);
          return head.length === 4 && head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d ? 1 : 0;
        } finally {
          sys('close', { fd });
        }
      } catch {
        return 0;
      }
    },
    // fs.cpSync's native half (node_file.cc CpSyncCheckPaths / CpSyncOverrideFile / CpSyncCopyDir),
    // including its quirks: the source is stat'ed with lstat only when dereference is set, errors are
    // plain Errors with an ERR_FS_CP_* code, and copied symlinks get absolute, resolved targets.
    cpSyncCheckPaths(src: unknown, dest: unknown, dereference: boolean, recursive: boolean) {
      let srcPath = pathString(src);
      const destPath = pathString(dest);
      let s: StatData;
      try {
        s = st(srcPath, !!dereference);
      } catch (e) {
        throw uvError(e, dereference ? 'stat' : 'lstat', srcPath);
      }
      let d: StatData | null = null;
      try {
        d = st(destPath, !dereference);
      } catch {}
      const srcIsDir = (s.mode & S_IFMT) === S_IFDIR || (!!dereference && (s.mode & S_IFMT) === S_IFLNK);
      if (d) {
        if (sameFile(srcPath, destPath)) throw cpError('ERR_FS_CP_EINVAL', `src and dest cannot be the same ${destPath}`);
        const destIsDir = (d.mode & S_IFMT) === S_IFDIR;
        if (srcIsDir && !destIsDir) throw cpError('ERR_FS_CP_DIR_TO_NON_DIR', `Cannot overwrite non-directory ${destPath} with directory ${srcPath}`);
        if (!srcIsDir && destIsDir) throw cpError('ERR_FS_CP_NON_DIR_TO_DIR', `Cannot overwrite directory ${destPath} with non-directory ${srcPath}`);
      }
      if (!srcPath.endsWith('/')) srcPath += '/';
      if (srcIsDir && destPath.startsWith(srcPath)) throw cpError('ERR_FS_CP_EINVAL', `Cannot copy ${srcPath} to a subdirectory of self ${destPath}`);
      const pathMod = lib('path');
      const srcParent = pathMod.dirname(srcPath.slice(0, -1) || '/');
      for (let p = pathMod.dirname(destPath); p !== srcParent; p = pathMod.dirname(p)) {
        if (sameFile(srcPath, p)) throw cpError('ERR_FS_CP_EINVAL', `Cannot copy ${srcPath} to a subdirectory of self ${destPath}`);
        if (p === '/') break;
      }
      if (srcIsDir && !recursive) throw cpError('ERR_FS_EISDIR', `Recursive option not enabled, cannot copy a directory: ${srcPath}`);
      const t = s.mode & S_IFMT;
      if (t === S_IFSOCK) throw cpError('ERR_FS_CP_SOCKET', `Cannot copy a socket file: ${pathString(src)}`);
      if (t === S_IFIFO) throw cpError('ERR_FS_CP_FIFO_PIPE', `Cannot copy a FIFO pipe: ${pathString(src)}`);
      if (!d) {
        try {
          sys('mkdir', { p: pathMod.dirname(destPath), mode: 0o777, recursive: true });
        } catch {}
      }
    },
    cpSyncOverrideFile(src: unknown, dest: unknown, mode: number, preserveTimestamps: boolean) {
      const from = pathString(src);
      const to = pathString(dest);
      try {
        sys('unlink', { p: to });
      } catch (e) {
        throw uvError(e, 'unlink', to);
      }
      try {
        sys('copyFile', { from, to, excl: !!(mode & 1) });
      } catch (e) {
        throw uvError(e, 'cp', from, to);
      }
      if (preserveTimestamps) copyUtimes(from, to);
    },
    cpSyncCopyDir(src: unknown, dest: unknown, force: boolean, dereference: boolean, errorOnExist: boolean, verbatimSymlinks: boolean, preserveTimestamps: boolean) {
      const pathMod = lib('path');
      const srcRoot = pathString(src);
      const destRoot = pathString(dest);
      try {
        sys('mkdir', { p: destRoot, mode: 0o777, recursive: true });
      } catch (e) {
        throw uvError(e, 'cp', destRoot);
      }
      const isSubPath = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
      const copyDir = (from: string, to: string) => {
        let entries: [string, number][];
        try {
          entries = sys<[string, number][]>('readdir', { p: from, types: true });
        } catch (e) {
          throw uvError(e, 'cp', from);
        }
        for (const [name, mode] of entries) {
          const srcItem = pathMod.join(from, name);
          const destItem = pathMod.join(to, name);
          const type = mode & S_IFMT;
          if (type === S_IFLNK) {
            try {
              if (verbatimSymlinks) {
                sys('symlink', { target: sys<string>('readlink', { p: srcItem }), p: destItem });
                continue;
              }
              const target = sys<string>('readlink', { p: srcItem });
              let destLink: StatData | null = null;
              try {
                destLink = st(destItem, true);
              } catch {}
              if (destLink && (destLink.mode & S_IFMT) === S_IFLNK) {
                const current = sys<string>('readlink', { p: destItem });
                let targetIsDir = false;
                try {
                  targetIsDir = (st(srcItem, false).mode & S_IFMT) === S_IFDIR;
                } catch {}
                if (!dereference && targetIsDir && isSubPath(target, current)) throw cpError('ERR_FS_CP_EINVAL', `Cannot copy ${target} to a subdirectory of self ${current}`);
                let destIsDir = false;
                try {
                  destIsDir = (st(destItem, false).mode & S_IFMT) === S_IFDIR;
                } catch {}
                if (destIsDir && isSubPath(current, target)) throw cpError('ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', `cannot overwrite ${current} with ${target}`);
                // the existing link is replaced even without force (as node_file.cc does)
                sys('unlink', { p: destItem });
              } else if (destLink && (destLink.mode & S_IFMT) === S_IFREG && (!dereference || (!force && errorOnExist))) {
                throw new SysError('EEXIST', 'file already exists');
              }
              // weakly_canonical(absolute(src / target))
              const resolved = pathMod.resolve(from, target);
              let canonical = resolved;
              try {
                canonical = sys<string>('realpath', { p: resolved });
              } catch {}
              sys('symlink', { target: canonical, p: destItem });
            } catch (e) {
              throw uvError(e, 'cp', srcItem, destItem);
            }
          } else if (type === S_IFDIR) {
            try {
              sys('mkdir', { p: destItem, mode: 0o777 });
            } catch (e) {
              if (!(e instanceof SysError && e.code === 'EEXIST')) throw uvError(e, 'cp', srcItem, destItem);
            }
            copyDir(srcItem, destItem);
          } else if (type === S_IFREG) {
            let exists = false;
            try {
              st(destItem, false);
              exists = true;
            } catch {}
            if (!exists || force) {
              try {
                if (exists) sys('unlink', { p: destItem });
                sys('copyFile', { from: srcItem, to: destItem, excl: false });
              } catch (e) {
                throw uvError(e, 'cp', srcItem, destItem);
              }
            } else if (errorOnExist) {
              throw cpError('ERR_FS_CP_EEXIST', `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${destItem} already exists)`);
            }
            if (preserveTimestamps) copyUtimes(srcItem, destItem);
          }
        }
      };
      copyDir(srcRoot, destRoot);
    },
  });
  return b;
}

/** THROW_ERR_FS_CP_*: a plain Error with a code (no syscall/path). */
function cpError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** std::filesystem::equivalent: both exist and are the same inode. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = sys<StatData>('stat', { p: a, l: false });
    const y = sys<StatData>('stat', { p: b, l: false });
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/** CopyUtimes in node_file.cc */
function copyUtimes(src: string, dest: string) {
  let s: StatData;
  try {
    s = sys<StatData>('stat', { p: src, l: false });
  } catch (e) {
    throw uvError(e, 'stat', src);
  }
  try {
    sys('utimes', { p: dest, atime: s.atimeMs, mtime: s.mtimeMs });
  } catch (e) {
    throw uvError(e, 'utime', dest);
  }
}
