// node:wasi — WASI preview1 on top of the kernel's file system.

import * as path from '../shared/path.ts';
import { SysError, sys } from './sys.ts';

const ERRNO: Record<string, number> = {
  E2BIG: 1, EACCES: 2, EADDRINUSE: 3, EAGAIN: 6, EBADF: 8, EBUSY: 10, ECANCELED: 11, ECHILD: 12, ECONNREFUSED: 14, ECONNRESET: 15, EEXIST: 20, EFAULT: 21, EFBIG: 22, EINTR: 27,
  EINVAL: 28, EIO: 29, EISDIR: 31, ELOOP: 32, EMFILE: 33, EMLINK: 34, ENAMETOOLONG: 37, ENFILE: 41, ENODEV: 43, ENOENT: 44, ENOEXEC: 45, ENOMEM: 48, ENOSPC: 51, ENOSYS: 52,
  ENOTCONN: 53, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58, ENOTTY: 59, ENXIO: 60, EPERM: 63, EPIPE: 64, ERANGE: 68, EROFS: 69, ESPIPE: 70, ESRCH: 71, ETIMEDOUT: 73, EXDEV: 75, ENOTCAPABLE: 76,
};
const ESUCCESS = 0;
const EBADF = 8;
const EINVAL = 28;
const ENOSYS = 52;

const FT_UNKNOWN = 0;
const FT_CHAR = 2;
const FT_DIR = 3;
const FT_REG = 4;
const FT_SYMLINK = 7;

const RIGHTS_ALL = 0x1fffffffn;

function errnoOf(e: unknown): number {
  if (e instanceof WASIExit) throw e;
  if (e instanceof SysError) return ERRNO[e.code] ?? 29;
  const code = (e as any)?.code;
  if (code && ERRNO[code] !== undefined) return ERRNO[code];
  return 29;
}

function filetypeOf(mode: number): number {
  switch (mode & 0o170000) {
    case 0o040000:
      return FT_DIR;
    case 0o100000:
      return FT_REG;
    case 0o120000:
      return FT_SYMLINK;
    case 0o020000:
      return FT_CHAR;
    default:
      return FT_UNKNOWN;
  }
}

class WASIExit extends Error {
  constructor(public code: number) {
    super(`WASI exit ${code}`);
  }
}

interface FdEntry {
  kfd: number | null; // kernel fd (null for pure directory handles)
  path: string; // host path
  type: number;
  preopen?: string; // guest name
  dirents?: [string, number][];
  append?: boolean;
}

export class WASI {
  wasiImport: Record<string, (...a: any[]) => number>;
  private fds = new Map<number, FdEntry>();
  private args: string[];
  private env: string[];
  private memory: WebAssembly.Memory | null = null;
  private returnOnExit: boolean;
  private started = false;

  constructor(opts: { version?: string; args?: string[]; env?: Record<string, string>; preopens?: Record<string, string>; returnOnExit?: boolean; stdin?: number; stdout?: number; stderr?: number } = {}) {
    this.args = opts.args ?? [];
    this.env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    this.returnOnExit = opts.returnOnExit ?? true;
    this.fds.set(0, { kfd: opts.stdin ?? 0, path: '/dev/stdin', type: FT_CHAR });
    this.fds.set(1, { kfd: opts.stdout ?? 1, path: '/dev/stdout', type: FT_CHAR });
    this.fds.set(2, { kfd: opts.stderr ?? 2, path: '/dev/stderr', type: FT_CHAR });
    let next = 3;
    for (const [guest, host] of Object.entries(opts.preopens ?? {})) {
      const hostAbs = path.resolve((globalThis as any).process?.cwd?.() ?? '/', host);
      this.fds.set(next++, { kfd: null, path: hostAbs, type: FT_DIR, preopen: guest });
    }
    this.wasiImport = this.makeImports();
  }

  getImportObject() {
    return { wasi_snapshot_preview1: this.wasiImport };
  }

  start(instance: WebAssembly.Instance): number | undefined {
    if (this.started) throw Object.assign(new Error('WASI instance has already started'), { code: 'ERR_WASI_ALREADY_STARTED' });
    this.started = true;
    this.bind(instance);
    const start = instance.exports._start as (() => void) | undefined;
    if (typeof start !== 'function') throw Object.assign(new TypeError('instance.exports._start is not a function'), { code: 'ERR_INVALID_ARG_TYPE' });
    try {
      start();
    } catch (e) {
      if (e instanceof WASIExit) {
        if (this.returnOnExit) return e.code;
        (globalThis as any).process.exit(e.code);
      }
      throw e;
    }
    return 0;
  }

  initialize(instance: WebAssembly.Instance) {
    if (this.started) throw Object.assign(new Error('WASI instance has already started'), { code: 'ERR_WASI_ALREADY_STARTED' });
    this.started = true;
    this.bind(instance);
    const init = instance.exports._initialize as (() => void) | undefined;
    if (typeof init === 'function') init();
  }

  /** Allows callers that import memory to set it explicitly. */
  setMemory(m: WebAssembly.Memory) {
    this.memory = m;
  }

  private bind(instance: WebAssembly.Instance) {
    const mem = instance.exports.memory as WebAssembly.Memory | undefined;
    if (mem) this.memory = mem;
  }

  private view() {
    return new DataView(this.memory!.buffer);
  }
  private bytes() {
    return new Uint8Array(this.memory!.buffer);
  }
  private readStr(ptr: number, len: number) {
    return new TextDecoder().decode(this.bytes().slice(ptr, ptr + len));
  }
  private hostPath(dirfd: number, p: string): string | null {
    const d = this.fds.get(dirfd);
    if (!d) return null;
    return path.resolve(d.path, p);
  }

  private makeImports(): Record<string, (...a: any[]) => number> {
    const self = this;
    const enc = new TextEncoder();
    const wrap = (fn: (...a: any[]) => number) => (...a: any[]) => {
      try {
        return fn(...a);
      } catch (e) {
        return errnoOf(e);
      }
    };
    const writeStrings = (list: string[], ptrs: number, buf: number) => {
      const v = self.view();
      const b = self.bytes();
      let off = buf;
      list.forEach((s, i) => {
        v.setUint32(ptrs + i * 4, off, true);
        const e = enc.encode(s + '\0');
        b.set(e, off);
        off += e.length;
      });
      return ESUCCESS;
    };
    const sizes = (list: string[], countPtr: number, sizePtr: number) => {
      const v = self.view();
      v.setUint32(countPtr, list.length, true);
      v.setUint32(sizePtr, list.reduce((a, s) => a + enc.encode(s).length + 1, 0), true);
      return ESUCCESS;
    };
    const iovecs = (ptr: number, len: number) => {
      const v = self.view();
      const out: [number, number][] = [];
      for (let i = 0; i < len; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
      return out;
    };
    const writeFilestat = (ptr: number, st: any) => {
      const v = self.view();
      v.setBigUint64(ptr, BigInt(st.dev ?? 0), true);
      v.setBigUint64(ptr + 8, BigInt(st.ino ?? 0), true);
      v.setUint8(ptr + 16, filetypeOf(st.mode));
      v.setBigUint64(ptr + 24, BigInt(st.nlink ?? 1), true);
      v.setBigUint64(ptr + 32, BigInt(st.size ?? 0), true);
      v.setBigUint64(ptr + 40, BigInt(Math.floor((st.atimeMs ?? 0) * 1e6)), true);
      v.setBigUint64(ptr + 48, BigInt(Math.floor((st.mtimeMs ?? 0) * 1e6)), true);
      v.setBigUint64(ptr + 56, BigInt(Math.floor((st.ctimeMs ?? 0) * 1e6)), true);
    };
    const ensureKfd = (e: FdEntry) => {
      if (e.kfd === null) e.kfd = sys<number>('open', { p: e.path, flags: 0, mode: 0 });
      return e.kfd;
    };
    const allocFd = (e: FdEntry) => {
      let fd = 3;
      while (self.fds.has(fd)) fd++;
      self.fds.set(fd, e);
      return fd;
    };
    return {
      args_get: wrap((argv, buf) => writeStrings(self.args, argv, buf)),
      args_sizes_get: wrap((c, s) => sizes(self.args, c, s)),
      environ_get: wrap((envp, buf) => writeStrings(self.env, envp, buf)),
      environ_sizes_get: wrap((c, s) => sizes(self.env, c, s)),
      clock_res_get: wrap((_id, ptr) => {
        self.view().setBigUint64(ptr, 1000n, true);
        return ESUCCESS;
      }),
      clock_time_get: wrap((id, _prec, ptr) => {
        const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.floor((performance.timeOrigin + performance.now()) * 1e6));
        self.view().setBigUint64(ptr, ns, true);
        return ESUCCESS;
      }),
      fd_advise: () => ESUCCESS,
      fd_allocate: () => ESUCCESS,
      fd_close: wrap((fd) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        if (e.kfd !== null && fd > 2) sys('close', { fd: e.kfd });
        self.fds.delete(fd);
        return ESUCCESS;
      }),
      fd_datasync: () => ESUCCESS,
      fd_sync: () => ESUCCESS,
      fd_fdstat_get: wrap((fd, ptr) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const v = self.view();
        v.setUint8(ptr, e.type);
        v.setUint16(ptr + 2, e.append ? 1 : 0, true);
        v.setBigUint64(ptr + 8, RIGHTS_ALL, true);
        v.setBigUint64(ptr + 16, RIGHTS_ALL, true);
        return ESUCCESS;
      }),
      fd_fdstat_set_flags: () => ESUCCESS,
      fd_fdstat_set_rights: () => ESUCCESS,
      fd_filestat_get: wrap((fd, ptr) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const st = e.kfd !== null ? sys('fstat', { fd: e.kfd }) : sys('stat', { p: e.path });
        writeFilestat(ptr, st);
        return ESUCCESS;
      }),
      fd_filestat_set_size: wrap((fd, size) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        sys('ftruncate', { fd: ensureKfd(e), len: Number(size) });
        return ESUCCESS;
      }),
      fd_filestat_set_times: wrap((fd, atim, mtim) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        sys('utimes', { p: e.path, atime: Number(atim) / 1e6, mtime: Number(mtim) / 1e6 });
        return ESUCCESS;
      }),
      fd_pread: wrap((fd, iovs, iovsLen, offset, nread) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const kfd = ensureKfd(e);
        let total = 0;
        let pos = Number(offset);
        for (const [p, l] of iovecs(iovs, iovsLen)) {
          const d = sys<Uint8Array>('read', { fd: kfd, len: l, pos });
          self.bytes().set(d, p);
          total += d.length;
          pos += d.length;
          if (d.length < l) break;
        }
        self.view().setUint32(nread, total, true);
        return ESUCCESS;
      }),
      fd_pwrite: wrap((fd, iovs, iovsLen, offset, nwritten) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const kfd = ensureKfd(e);
        let total = 0;
        let pos = Number(offset);
        for (const [p, l] of iovecs(iovs, iovsLen)) {
          const n = sys<number>('write', { fd: kfd, pos }, self.bytes().slice(p, p + l));
          total += n;
          pos += n;
        }
        self.view().setUint32(nwritten, total, true);
        return ESUCCESS;
      }),
      fd_prestat_get: wrap((fd, ptr) => {
        const e = self.fds.get(fd);
        if (!e || e.preopen === undefined) return EBADF;
        const v = self.view();
        v.setUint8(ptr, 0);
        v.setUint32(ptr + 4, enc.encode(e.preopen).length, true);
        return ESUCCESS;
      }),
      fd_prestat_dir_name: wrap((fd, ptr, len) => {
        const e = self.fds.get(fd);
        if (!e || e.preopen === undefined) return EBADF;
        self.bytes().set(enc.encode(e.preopen).subarray(0, len), ptr);
        return ESUCCESS;
      }),
      fd_read: wrap((fd, iovs, iovsLen, nread) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const kfd = ensureKfd(e);
        let total = 0;
        for (const [p, l] of iovecs(iovs, iovsLen)) {
          if (l === 0) continue;
          const d = sys<Uint8Array>('read', { fd: kfd, len: l, pos: null });
          self.bytes().set(d, p);
          total += d.length;
          if (d.length < l) break;
        }
        self.view().setUint32(nread, total, true);
        return ESUCCESS;
      }),
      fd_readdir: wrap((fd, buf, bufLen, cookie, bufused) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        if (!e.dirents || Number(cookie) === 0) e.dirents = [['.', 0o040000], ['..', 0o040000], ...sys<[string, number][]>('readdir', { p: e.path, types: true })];
        const v = self.view();
        const b = self.bytes();
        let off = 0;
        for (let i = Number(cookie); i < e.dirents.length; i++) {
          const [name, type] = e.dirents[i];
          const nb = enc.encode(name);
          const header = new Uint8Array(24);
          const hv = new DataView(header.buffer);
          hv.setBigUint64(0, BigInt(i + 1), true);
          hv.setBigUint64(8, BigInt(i + 1), true);
          hv.setUint32(16, nb.length, true);
          hv.setUint8(20, filetypeOf(type));
          const entry = new Uint8Array(24 + nb.length);
          entry.set(header);
          entry.set(nb, 24);
          const room = bufLen - off;
          if (room <= 0) break;
          b.set(entry.subarray(0, Math.min(room, entry.length)), buf + off);
          off += Math.min(room, entry.length);
          if (room < entry.length) break;
        }
        v.setUint32(bufused, off, true);
        return ESUCCESS;
      }),
      fd_renumber: wrap((from, to) => {
        const e = self.fds.get(from);
        if (!e) return EBADF;
        const old = self.fds.get(to);
        if (old?.kfd !== null && old && to > 2) sys('close', { fd: old.kfd });
        self.fds.set(to, e);
        self.fds.delete(from);
        return ESUCCESS;
      }),
      fd_seek: wrap((fd, offset, whence, newOffset) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const pos = sys<number>('lseek', { fd: ensureKfd(e), offset: Number(offset), whence });
        self.view().setBigUint64(newOffset, BigInt(pos), true);
        return ESUCCESS;
      }),
      fd_tell: wrap((fd, ptr) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const pos = sys<number>('lseek', { fd: ensureKfd(e), offset: 0, whence: 1 });
        self.view().setBigUint64(ptr, BigInt(pos), true);
        return ESUCCESS;
      }),
      fd_write: wrap((fd, iovs, iovsLen, nwritten) => {
        const e = self.fds.get(fd);
        if (!e) return EBADF;
        const kfd = ensureKfd(e);
        const parts = iovecs(iovs, iovsLen);
        const total = parts.reduce((a, [, l]) => a + l, 0);
        const data = new Uint8Array(total);
        let off = 0;
        const b = self.bytes();
        for (const [p, l] of parts) {
          data.set(b.subarray(p, p + l), off);
          off += l;
        }
        const n = total ? sys<number>('write', { fd: kfd, pos: null }, data) : 0;
        self.view().setUint32(nwritten, n, true);
        return ESUCCESS;
      }),
      path_create_directory: wrap((dirfd, p, l) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        sys('mkdir', { p: hp, recursive: false, mode: 0o777 });
        return ESUCCESS;
      }),
      path_filestat_get: wrap((dirfd, flags, p, l, ptr) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        const st = sys('stat', { p: hp, l: !(flags & 1) });
        writeFilestat(ptr, st);
        return ESUCCESS;
      }),
      path_filestat_set_times: wrap((dirfd, _flags, p, l, atim, mtim) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        sys('utimes', { p: hp, atime: Number(atim) / 1e6, mtime: Number(mtim) / 1e6 });
        return ESUCCESS;
      }),
      path_link: wrap((ofd, _f, op, ol, nfd, np, nl) => {
        const a = self.hostPath(ofd, self.readStr(op, ol));
        const b = self.hostPath(nfd, self.readStr(np, nl));
        if (!a || !b) return EBADF;
        sys('link', { from: a, to: b });
        return ESUCCESS;
      }),
      path_open: wrap((dirfd, _dirflags, p, l, oflags, rightsBase, _ri, fdflags, fdOut) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        const creat = oflags & 1;
        const directory = oflags & 2;
        const excl = oflags & 4;
        const trunc = oflags & 8;
        let st: any = null;
        try {
          st = sys('stat', { p: hp });
        } catch (e) {
          if (!creat) throw e;
        }
        if (st && (st.mode & 0o170000) === 0o040000) {
          const fd = allocFd({ kfd: null, path: hp, type: FT_DIR });
          self.view().setUint32(fdOut, fd, true);
          return ESUCCESS;
        }
        if (directory) return ERRNO.ENOTDIR;
        const rb = BigInt(rightsBase);
        const write = (rb & (1n << 6n)) !== 0n || (rb & (1n << 4n)) !== 0n || (rb & (1n << 22n)) !== 0n || !!creat || !!trunc;
        const read = (rb & (1n << 1n)) !== 0n || (rb & (1n << 14n)) !== 0n || !write;
        let flags = read && write ? 2 : write ? 1 : 0;
        if (creat) flags |= 0o100;
        if (excl) flags |= 0o200;
        if (trunc) flags |= 0o1000;
        if (fdflags & 1) flags |= 0o2000;
        const kfd = sys<number>('open', { p: hp, flags, mode: 0o666 });
        const fd = allocFd({ kfd, path: hp, type: FT_REG, append: !!(fdflags & 1) });
        self.view().setUint32(fdOut, fd, true);
        return ESUCCESS;
      }),
      path_readlink: wrap((dirfd, p, l, buf, bufLen, used) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        const t = enc.encode(sys<string>('readlink', { p: hp }));
        const n = Math.min(t.length, bufLen);
        self.bytes().set(t.subarray(0, n), buf);
        self.view().setUint32(used, n, true);
        return ESUCCESS;
      }),
      path_remove_directory: wrap((dirfd, p, l) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        sys('rmdir', { p: hp });
        return ESUCCESS;
      }),
      path_rename: wrap((ofd, op, ol, nfd, np, nl) => {
        const a = self.hostPath(ofd, self.readStr(op, ol));
        const b = self.hostPath(nfd, self.readStr(np, nl));
        if (!a || !b) return EBADF;
        sys('rename', { from: a, to: b });
        return ESUCCESS;
      }),
      path_symlink: wrap((op, ol, dirfd, np, nl) => {
        const target = self.readStr(op, ol);
        const hp = self.hostPath(dirfd, self.readStr(np, nl));
        if (!hp) return EBADF;
        sys('symlink', { target, p: hp });
        return ESUCCESS;
      }),
      path_unlink_file: wrap((dirfd, p, l) => {
        const hp = self.hostPath(dirfd, self.readStr(p, l));
        if (!hp) return EBADF;
        sys('unlink', { p: hp });
        return ESUCCESS;
      }),
      poll_oneoff: wrap((inPtr, outPtr, nsubs, neventsPtr) => {
        const v = self.view();
        let timeout = Infinity;
        let events = 0;
        for (let i = 0; i < nsubs; i++) {
          const base = inPtr + i * 48;
          const userdata = v.getBigUint64(base, true);
          const tag = v.getUint8(base + 8);
          if (tag === 0) {
            const t = v.getBigUint64(base + 24, true);
            const abs = v.getUint16(base + 40, true) & 1;
            const ns = abs ? Number(t) - (performance.timeOrigin + performance.now()) * 1e6 : Number(t);
            timeout = Math.min(timeout, Math.max(0, ns / 1e6));
            const ev = outPtr + events * 32;
            v.setBigUint64(ev, userdata, true);
            v.setUint16(ev + 8, 0, true);
            v.setUint8(ev + 10, 0);
            events++;
          } else {
            // fd readiness: report ready immediately
            const ev = outPtr + events * 32;
            v.setBigUint64(ev, userdata, true);
            v.setUint16(ev + 8, 0, true);
            v.setUint8(ev + 10, tag);
            v.setBigUint64(ev + 16, 1n, true);
            events++;
            timeout = 0;
          }
        }
        if (timeout > 0 && timeout !== Infinity) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
        v.setUint32(neventsPtr, events, true);
        return ESUCCESS;
      }),
      proc_exit: (code: number) => {
        throw new WASIExit(code);
      },
      proc_raise: () => ENOSYS,
      sched_yield: () => ESUCCESS,
      random_get: wrap((buf, len) => {
        const tmp = new Uint8Array(len);
        for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, Math.min(len, i + 65536)));
        self.bytes().set(tmp, buf);
        return ESUCCESS;
      }),
      sock_accept: () => ENOSYS,
      sock_recv: () => ENOSYS,
      sock_send: () => ENOSYS,
      sock_shutdown: () => ENOSYS,
    };
  }
}

void EINVAL;
export const wasiModule = { WASI };
