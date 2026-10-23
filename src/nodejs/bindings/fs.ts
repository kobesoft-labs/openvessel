// internalBinding('fs') — node_file.cc over the kernel's syscalls.
// Every operation is sync (throws a UVException), callback-based (last arg is an FSReqCallback,
// completed with req.oncomplete(err, result) on a later turn) or promise-based (last arg is kUsePromises).

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S, lib } from '../state.ts';
import { Enc, decode, encode, encodingOf } from './buffer.ts';
import { fromShape } from './shape.ts';

interface StatData {
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

function pathString(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p instanceof Uint8Array) return decode(p, Enc.UTF8);
  if (p instanceof URL) return decodeURIComponent(p.pathname);
  return String(p);
}

function fillStats(arr: Float64Array | BigInt64Array, offset: number, st: StatData) {
  const ns = (ms: number) => [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];
  const [as, an] = ns(st.atimeMs);
  const [ms, mn] = ns(st.mtimeMs);
  const [cs, cn] = ns(st.ctimeMs);
  const [bs, bn] = ns(st.birthtimeMs);
  const v = [st.dev, st.mode, st.nlink, st.uid, st.gid, st.rdev, st.blksize, st.ino, st.size, st.blocks, as, an, ms, mn, cs, cn, bs, bn];
  if (arr instanceof BigInt64Array) for (let i = 0; i < 18; i++) arr[offset + i] = BigInt(Math.trunc(v[i]));
  else for (let i = 0; i < 18; i++) arr[offset + i] = v[i];
  return arr;
}

function encodeOut(s: string, encoding: unknown): string | Uint8Array {
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
      run(req, 'read', undefined, undefined, () => {
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
    cpSyncCheckPaths(src: string, dest: string, dereference: boolean, recursive: boolean) {
      let s: StatData;
      try {
        s = st(src, !dereference);
      } catch (e) {
        throw uvError(e, 'cp', src);
      }
      if ((s.mode & S_IFMT) === S_IFDIR && !recursive) {
        const { codes } = lib('internal/errors');
        throw new codes.ERR_FS_EISDIR({ message: `Recursive option is required to copy a directory: ${src}`, path: src, syscall: 'cp', errno: 21, code: 'EISDIR' });
      }
      const resolvedSrc = sys<string>('realpath', { p: src });
      let resolvedDest = dest;
      try {
        resolvedDest = sys<string>('realpath', { p: dest });
      } catch {}
      if (resolvedSrc === resolvedDest) {
        const { codes } = lib('internal/errors');
        throw new codes.ERR_FS_CP_EINVAL({ message: 'src and dest cannot be the same', path: dest, syscall: 'cp', errno: 22, code: 'EINVAL' });
      }
      if ((resolvedDest + '/').startsWith(resolvedSrc + '/')) {
        const { codes } = lib('internal/errors');
        throw new codes.ERR_FS_CP_EINVAL({ message: `cannot copy ${src} to a subdirectory of self ${dest}`, path: dest, syscall: 'cp', errno: 22, code: 'EINVAL' });
      }
    },
    cpSyncOverrideFile(src: string, dest: string, mode: number, preserveTimestamps: boolean) {
      try {
        sys('unlink', { p: dest });
        sys('copyFile', { from: src, to: dest, excl: !!(mode & 1) });
        if (preserveTimestamps) {
          const s = st(src, false);
          sys('utimes', { p: dest, atime: s.atimeMs, mtime: s.mtimeMs });
        }
      } catch (e) {
        throw uvError(e, 'cp', src, dest);
      }
    },
    cpSyncCopyDir(src: string, dest: string, force: boolean, dereference: boolean, errorOnExist: boolean, verbatimSymlinks: boolean, preserveTimestamps: boolean) {
      void verbatimSymlinks;
      void preserveTimestamps;
      try {
        sys('cp', { from: src, to: dest, force, errorOnExist, dereference });
      } catch (e) {
        throw uvError(e, 'cp', src, dest);
      }
    },
  });
  void S_IFREG;
  return b;
}
