// internalBinding('fs') — node_file.cc over the kernel's syscalls.
// Every operation is sync (throws a UVException), callback-based (last arg is an FSReqCallback,
// completed with req.oncomplete(err, result) on a later turn) or promise-based (last arg is kUsePromises).

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S, lib } from '../state.ts';
import { Enc, decode, encode, encodingOf } from './buffer.ts';
import { registerHostObject } from './messaging.ts';
import { fromShape } from './shape.ts';
import { readOnce } from './stream.ts';
import { HandleWrap } from './stream.ts';
import { asyncDestroy, asyncIdOf, completeReq, emitAsyncInit } from './process.ts';

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
  // seconds rounded down and a non-negative nanosecond part, also before 1970 (no array
  // destructuring: user code may have deleted Array.prototype[Symbol.iterator])
  const s = (ms: number) => Math.floor(ms / 1000);
  const ns = (ms: number) => Math.round((ms - s(ms) * 1000) * 1e6);
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

/** A C++-style error (THROW_ERR_*): the class and a code, the message as is. */
function nodeError(C: ErrorConstructor, code: string, message: string): Error {
  const e = new C(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** GetValidatedFd() in node_file.cc: an int32 >= 0, or ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE. */
export function validatedFd(v: unknown): number {
  if (typeof v !== 'number') {
    const { codes } = lib('internal/errors');
    throw new codes.ERR_INVALID_ARG_TYPE('fd', 'number', v);
  }
  const outOfRange = v < 0 || v > 0x7fffffff;
  if (outOfRange || !Number.isSafeInteger(v)) {
    if (outOfRange && Number.isFinite(v)) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received ${v}`);
    throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "fd" is out of range. It must be an integer. Received ${v}`);
  }
  return v;
}

/** GetValidMode() in node_file.cc: the mode of access() (0..7, default F_OK) and copyFile() (0..7, default 0). */
function validatedMode(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const { codes } = lib('internal/errors');
  if (typeof v !== 'number') throw new codes.ERR_INVALID_ARG_TYPE('mode', 'integer', v);
  if (!Number.isInteger(v) || v < 0 || v > 7) throw new codes.ERR_OUT_OF_RANGE('mode', 'an integer >= 0 && <= 7', v);
  return v;
}

/** The request behind an fs promise (FSReqPromise, made on the native side): the promise settles in its async context. */
export class FSReqPromise {
  constructor() {
    emitAsyncInit(this, 'FSREQPROMISE', { req: true });
  }
}

export function createFs() {
  const b = fromShape('fs');
  const kUsePromises: symbol = b.kUsePromises;
  const statValues: Float64Array = b.statValues;
  const bigintStatValues: BigInt64Array = b.bigintStatValues;

  // requests whose cancel() came before their work started (uv_cancel succeeded)
  const cancelled = new WeakSet<object>();

  class FSReqCallback {
    oncomplete: ((...a: unknown[]) => void) | null = null;
    context: unknown = null;
    constructor(public bigint = false) {
      emitAsyncInit(this, 'FSREQCALLBACK', { req: true });
    }
    getAsyncId() {
      return asyncIdOf(this);
    }
    /**
     * uv_cancel: the work of a request still queued is skipped and oncomplete gets ECANCELED (with the
     * syscall and path the request would have reported). fs.readFile/writeFile use it on abort. A
     * request whose work already runs (an async read on a pipe) completes normally, as in libuv.
     */
    cancel() {
      cancelled.add(this);
    }
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
      const wrap = new FSReqPromise();
      return new Promise<T>((resolve, reject) => {
        loop.macrotask(() => {
          done();
          // the work, then FSReqPromise::Resolve/Reject in the request's async context
          let result: T;
          try {
            result = fn();
          } catch (e) {
            const err = uvError(e, syscall, path, dest);
            loop.scope(reject, wrap, err);
            return;
          }
          loop.scope(resolve, wrap, result);
        });
      });
    }
    const r = req as FSReqCallback;
    const done = loop.startReq('FSReqCallback');
    loop.macrotask(() => {
      let err: Error | null = null;
      let result: T | undefined;
      try {
        if (cancelled.has(r)) throw new SysError('ECANCELED', 'operation canceled');
        result = fn();
      } catch (e) {
        err = uvError(e, syscall, path, dest);
      }
      done();
      // FSReqCallback::Resolve passes the value only when it isn't undefined
      if (err) completeReq(r, err);
      else if (result === undefined) completeReq(r, null);
      else completeReq(r, null, result);
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
    if (req === kUsePromises) {
      const wrap = new FSReqPromise();
      return new Promise<T>((resolve, reject) =>
        p.then(
          (v) => loop.scope(resolve, wrap, v),
          (e) => loop.scope(reject, wrap, e),
        ),
      );
    }
    const r = req as FSReqCallback;
    p.then(
      (v) => (v === undefined ? completeReq(r, null) : completeReq(r, null, v)),
      (e) => completeReq(r, e),
    );
    return undefined;
  }

  const st = (p: unknown, l: boolean) => sys<StatData>('stat', { p: pathString(p), l });
  const fst = (fd: number) => sys<StatData>('fstat', { fd });

  // sync calls and FSReqCallback fill the shared stat array (FillGlobalStatsArray); promises get their own
  function statResult(data: StatData, bigint: boolean, sync: boolean) {
    if (sync) return fillStats(bigint ? bigintStatValues : statValues, 0, data);
    return fillStats(bigint ? new BigInt64Array(18) : new Float64Array(18), 0, data);
  }

  function statOrMissing(path: unknown, l: boolean, bigint: boolean, shared: boolean, throwIfNoEntry: unknown) {
    let data: StatData;
    try {
      data = st(path, l);
    } catch (e) {
      if (!throwIfNoEntry && e instanceof SysError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined;
      throw e;
    }
    return statResult(data, bigint, shared);
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
      super('StatWatcher', false, 'STATWATCHER');
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
      emitAsyncInit(this, 'FILEHANDLE');
    }
    get fd() {
      return this.#fd;
    }
    getAsyncId() {
      return asyncIdOf(this);
    }
    close() {
      const fd = this.#fd;
      this.#closing = true;
      // FileHandle::ClosePromise: a FileHandleCloseReq settles the promise
      const wrap = new FileHandleCloseReq();
      const done = loop.startReq('FileHandleCloseReq');
      return new Promise<void>((resolve, reject) => {
        loop.macrotask(() => {
          done();
          loop.scope(() => {
            try {
              if (fd >= 0) sys('close', { fd });
              this.#fd = -1;
              resolve();
            } catch (e) {
              reject(uvError(e, 'close'));
            }
          }, wrap);
        });
      });
    }
    /** FileHandle::CloseSync (filehandle[Symbol.dispose]): closes the fd now, throwing a UVException. */
    closeSync() {
      const fd = this.#fd;
      if (fd < 0) return;
      this.#closing = true;
      this.#fd = -1;
      try {
        sys('close', { fd });
      } catch (e) {
        throw uvError(e, 'close');
      }
    }
    releaseFD() {
      const fd = this.#fd;
      this.#fd = -1;
      return fd;
    }
  }

  class FileHandleCloseReq {
    constructor() {
      emitAsyncInit(this, 'FILEHANDLECLOSEREQ', { req: true });
    }
  }

  // Environment::AddUnmanagedFd/RemoveUnmanagedFd: a worker thread (trackUnmanagedFds) closes the
  // fds it opened with fs.open when it exits
  const unmanaged =
    !S.isMainThread && S.init.trackUnmanagedFds
      ? (() => {
          const fds = new Set<number>();
          const warn = (msg: string) => S.process?.emitWarning?.(msg);
          S.atThreadExit.push(() => {
            for (const fd of fds) {
              try {
                sys('close', { fd });
              } catch {}
            }
          });
          return {
            add(fd: number) {
              if (fds.has(fd)) warn(`File descriptor ${fd} opened in unmanaged mode twice`);
              fds.add(fd);
            },
            remove(fd: number) {
              if (!fds.delete(fd)) warn(`File descriptor ${fd} closed but not opened in unmanaged mode`);
            },
          };
        })()
      : null;

  /**
   * The jobs that do a whole operation in one thread pool round trip (ReadFileJob, WriteFileJob,
   * CpDirJob): AsyncWraps of provider FSREQCALLBACK, made with the job. run() queues the work and
   * returns the permission model's error (there is none here: undefined); job.ondone(...) gets the
   * outcome on a later turn, in the job's async context.
   */
  abstract class FsJob {
    ondone: ((...a: unknown[]) => void) | null = null;
    context: unknown = null;
    constructor() {
      emitAsyncInit(this, 'FSREQCALLBACK', { req: true });
    }
    getAsyncId() {
      return asyncIdOf(this);
    }
    /** The arguments of ondone. */
    protected abstract work(): unknown[];
    run(): undefined {
      const done = loop.startReq('FSReqCallback');
      loop.macrotask(() => {
        let args: unknown[];
        try {
          args = this.work();
        } catch (e) {
          args = [uvError(e, 'open')];
        }
        done();
        if (typeof this.ondone === 'function') loop.scope(this.ondone, this, ...args);
        asyncDestroy(this);
      });
      return undefined;
    }
  }

  const toBuffer = (u8: Uint8Array) => lib('buffer').Buffer.from(u8.buffer, u8.byteOffset, u8.length);

  /**
   * fs.readFile / fsPromises.readFile without a user buffer: open + fstat + read + close in one job.
   * ondone(err, buffer, fd, size, closeErr): the contents and fd -1 for a file of up to one chunk;
   * otherwise (larger, or not a regular file: a pipe, a tty, a device) no buffer and the open fd with
   * the fstat size, which lib reads in chunks and closes (tracked as unmanaged when trackFd is set,
   * as fs.open's fds are). A failure is (err, undefined, -1).
   */
  class ReadFileJob extends FsJob {
    #path: unknown;
    #flags: number;
    #chunk: number;
    #trackFd: boolean;
    constructor(path: unknown, flags: number, chunk: number, trackFd?: boolean) {
      super();
      this.#path = path;
      this.#flags = flags | 0;
      this.#chunk = chunk > 0 ? chunk : 512 * 1024;
      this.#trackFd = !!trackFd;
    }
    protected work(): unknown[] {
      const path = this.#path;
      const p = pathString(path);
      const fail = (e: unknown, syscall: string) => [uvError(e, syscall, path), undefined, -1, undefined, undefined];
      const isDirError = () => new SysError('EISDIR', 'illegal operation on a directory');
      if (this.#flags === 0) {
        // the usual case (flag 'r') in two syscalls: stat, then the kernel's readFile
        let s: StatData;
        try {
          s = st(p, false);
        } catch (e) {
          return fail(e, 'open');
        }
        const type = s.mode & S_IFMT;
        if (type === S_IFDIR) return fail(isDirError(), 'read');
        if (type === S_IFREG && s.size <= this.#chunk) {
          try {
            return [null, toBuffer(sys<Uint8Array>('readFile', { p })), -1, undefined, undefined];
          } catch (e) {
            return fail(e, e instanceof SysError && e.code === 'EISDIR' ? 'read' : 'open');
          }
        }
      }
      let fd: number;
      try {
        fd = sys<number>('open', { p, flags: this.#flags, mode: 0o666 });
      } catch (e) {
        return fail(e, 'open');
      }
      const closeQuietly = () => {
        try {
          sys('close', { fd });
        } catch {}
      };
      let s: StatData;
      try {
        s = fst(fd);
      } catch (e) {
        closeQuietly();
        return fail(e, 'fstat');
      }
      const type = s.mode & S_IFMT;
      if (type === S_IFDIR) {
        closeQuietly();
        return fail(isDirError(), 'read');
      }
      if (type === S_IFREG && s.size <= this.#chunk) {
        let data: Uint8Array | null;
        try {
          data = this.#readAll(fd);
        } catch (e) {
          closeQuietly();
          return fail(e, 'read');
        }
        if (data) {
          let closeErr: Error | undefined;
          try {
            sys('close', { fd });
          } catch (e) {
            closeErr = uvError(e, 'close');
          }
          return [null, toBuffer(data), -1, undefined, closeErr];
        }
      }
      if (this.#trackFd) unmanaged?.add(fd);
      return [null, undefined, fd, s.size, undefined];
    }
    /**
     * The whole file with positional reads from 0, or null when it is longer than one chunk (it grew
     * since fstat): the fd's position is still 0 then, so lib's chunked reader starts at the beginning.
     */
    #readAll(fd: number): Uint8Array | null {
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const d = readBytes(fd, Math.min(this.#chunk + 1 - total, 1 << 20), total);
        if (!d.length) break;
        parts.push(d.slice());
        total += d.length;
        if (total > this.#chunk) return null;
      }
      if (parts.length === 1) return parts[0];
      const all = new Uint8Array(total);
      let off = 0;
      for (const x of parts) {
        all.set(x, off);
        off += x.length;
      }
      return all;
    }
  }

  const O_CREAT = 0o100;
  const O_TRUNC = 0o1000;
  const O_APPEND = 0o2000;

  /** fs.writeFile / fsPromises.writeFile of a buffer: open + write + close in one job; ondone(err | null). */
  class WriteFileJob extends FsJob {
    #path: unknown;
    #flags: number;
    #mode: number;
    #data: ArrayBufferView;
    constructor(path: unknown, flags: number, mode: number, data: ArrayBufferView) {
      super();
      this.#path = path;
      this.#flags = flags | 0;
      this.#mode = mode;
      this.#data = data;
    }
    protected work(): unknown[] {
      const path = this.#path;
      const p = pathString(path);
      const flags = this.#flags;
      const d = this.#data;
      const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      // write-only with create and truncate or append ('w', 'a', 'wx'…): the kernel's writeFile, one
      // syscall; other flags ('r+', 'w+'…) write from the start of the opened file
      if ((flags & 3) === 1 && flags & O_CREAT && flags & (O_TRUNC | O_APPEND)) {
        try {
          sys('writeFile', { p, flags, mode: this.#mode }, bytes);
          return [null];
        } catch (e) {
          return [uvError(e, 'open', path)];
        }
      }
      let fd: number;
      try {
        fd = sys<number>('open', { p, flags, mode: this.#mode });
      } catch (e) {
        return [uvError(e, 'open', path)];
      }
      try {
        let off = 0;
        while (off < bytes.length) off += writeBytes(fd, bytes.subarray(off), null);
      } catch (e) {
        try {
          sys('close', { fd });
        } catch {}
        return [uvError(e, 'write')];
      }
      try {
        sys('close', { fd });
      } catch (e) {
        return [uvError(e, 'close')];
      }
      return [null];
    }
  }

  /**
   * fs.cp / fsPromises.cp of a directory to a dest that does not exist yet (no filter, no
   * dereference): creates dest with the mode of src and copies the tree as fs.cpSync does.
   * ondone(err) or, for a socket, FIFO or other special file in the tree, ondone(null, kind, destPath)
   * (lib turns that into ERR_FS_CP_SOCKET / ERR_FS_CP_FIFO_PIPE / ERR_FS_CP_UNKNOWN).
   */
  class CpDirJob extends FsJob {
    #args: [unknown, unknown, CopyOptions];
    constructor(src: unknown, dest: unknown, force: boolean, dereference: boolean, errorOnExist: boolean, verbatimSymlinks: boolean, preserveTimestamps: boolean, mode: number) {
      super();
      this.#args = [src, dest, { force: !!force, dereference: !!dereference, errorOnExist: !!errorOnExist, verbatimSymlinks: !!verbatimSymlinks, preserveTimestamps: !!preserveTimestamps, mode: mode | 0 }];
    }
    protected work(): unknown[] {
      const [src, dest, o] = this.#args;
      const from = pathString(src);
      const to = pathString(dest);
      let s: StatData;
      try {
        s = st(from, false);
      } catch (e) {
        return [stdfsError(e, 'cp', from, false)];
      }
      const mode = s.mode & 0o7777;
      try {
        // owner-writable while it is filled (a read-only source dir), the exact mode at the end
        sys('mkdir', { p: to, mode: mode | 0o700 });
      } catch (e) {
        return [uvError(e, 'mkdir', to)];
      }
      try {
        const special = copyTree(from, to, o, true);
        if (special) return [null, special[0], special[1]];
        sys('chmod', { p: to, mode });
      } catch (e) {
        return [uvError(e, 'cp', from, to)];
      }
      return [null];
    }
  }

  /**
   * readdir(path, { recursive: true }) in one request (node_file.cc ReadDirRecursive): breadth first,
   * following links to directories (a link loop ends at ELOOP, which counts as not a directory).
   * Without types: the paths relative to path (joined with '/'). With types: [names, types (Uint8Array),
   * counts (Uint32Array), dirs] where counts[i] entries belong to dirs[i] (relative, '' for path itself).
   */
  function readdirTree(path: unknown, encoding: unknown, withTypes: boolean) {
    const base = pathString(path);
    const prefix = base.endsWith('/') ? base : base + '/';
    const names: unknown[] = [];
    const types: number[] = [];
    const counts: number[] = [];
    const dirs: string[] = [''];
    for (let d = 0; d < dirs.length; d++) {
      const rel = dirs[d];
      const full = rel === '' ? base : prefix + rel;
      let entries: [string, number][];
      try {
        entries = sys<[string, number][]>('readdir', { p: full, types: true });
      } catch (e) {
        throw uvError(e, 'scandir', full);
      }
      counts.push(entries.length);
      for (const [name, mode] of entries) {
        const type = DIRENT[mode & S_IFMT] ?? 0;
        const relName = rel === '' ? name : `${rel}/${name}`;
        if (withTypes) {
          names.push(encodeOut(name, encoding));
          types.push(type);
        } else {
          names.push(encodeOut(relName, encoding));
        }
        let isDir = type === 2;
        if (type === 3 || type === 0) {
          try {
            isDir = (st(prefix + relName, false).mode & S_IFMT) === S_IFDIR;
          } catch {}
        }
        if (isDir) dirs.push(relName);
      }
    }
    if (!withTypes) return names;
    return [names, Uint8Array.from(types), Uint32Array.from(counts), dirs.map((x) => encodeOut(x, encoding))];
  }

  // a FileHandle moves to another thread of the process as its fd (the fd table is per process)
  registerHostObject(FileHandle.prototype, {
    name: 'fs:FileHandle',
    mode: 1 /* kTransferable */,
    transfer: (h: FileHandle) => ({ fd: h.releaseFD() }),
    revive: (d: { fd: number }) => new FileHandle(d.fd),
  });

  Object.assign(b, {
    FSReqCallback,
    FileHandle,
    StatWatcher,
    ReadFileJob,
    WriteFileJob,
    CpDirJob,
    readdirRecursive: (path: unknown, encoding: unknown, withTypes: boolean, req?: unknown) =>
      run(req, 'scandir', path, undefined, () => readdirTree(path, encoding, !!withTypes)),
    rmSync,
    access(path: unknown, mode: unknown, req?: unknown) {
      const m = validatedMode(mode);
      return run(req, 'access', path, undefined, () => void sys('access', { p: pathString(path), mode: m }));
    },
    existsSync(path: unknown) {
      try {
        st(path, false);
        return true;
      } catch {
        return false;
      }
    },
    open: (path: unknown, flags: number, mode: number, req?: unknown) =>
      run(req, 'open', path, undefined, () => {
        const fd = sys<number>('open', { p: pathString(path), flags, mode });
        unmanaged?.add(fd);
        return fd;
      }),
    openFileHandle: (path: unknown, flags: number, mode: number, req?: unknown) =>
      run(req, 'open', path, undefined, () => new FileHandle(sys<number>('open', { p: pathString(path), flags, mode }))),
    close: (fd: number, req?: unknown) => (
      validatedFd(fd),
      run(req, 'close', undefined, undefined, () => {
        unmanaged?.remove(fd);
        sys('close', { fd });
      })
    ),
    read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: unknown, req?: unknown) =>
      validatedFd(fd) >= 0 && req !== undefined && length > 0 && isStreamFd(fd)
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
      validatedFd(fd) >= 0 && run(req, 'read', undefined, undefined, () => {
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
      let opened = -1;
      try {
        // other flags than O_RDONLY (e.g. 'a+', which creates the file) go through open()
        if (typeof path !== 'number' && flags) opened = sys<number>('open', { p: pathString(path), flags, mode: 0o666 });
        const fd = opened >= 0 ? opened : path;
        if (typeof fd === 'number') {
          const parts: Uint8Array[] = [];
          for (;;) {
            const d = readBytes(fd, 1 << 20, null);
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
        const data = sys<Uint8Array>('readFile', { p: pathString(path) });
        return decode(data, Enc.UTF8);
      } catch (e) {
        throw uvError(e, 'open', path);
      } finally {
        if (opened >= 0) sys('close', { fd: opened });
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
      validatedFd(fd);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      if (req === undefined) return syncWithCtx(ctx, 'write', () => writeBytes(fd, bytes, position));
      return run(req, 'write', undefined, undefined, () => writeBytes(fd, bytes.slice(), position));
    },
    writeBuffers(fd: number, buffers: ArrayBufferView[], position: unknown, req?: unknown) {
      validatedFd(fd);
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
      validatedFd(fd);
      const bytes = encode(String(str), encodingOf(encoding ?? 'utf8'));
      if (req === undefined) return syncWithCtx(ctx, 'write', () => writeBytes(fd, bytes, position));
      return run(req, 'write', undefined, undefined, () => writeBytes(fd, bytes, position));
    },
    fdatasync: (fd: number, req?: unknown) => (validatedFd(fd), run(req, 'fdatasync', undefined, undefined, () => void fst(fd))),
    fsync: (fd: number, req?: unknown) => (validatedFd(fd), run(req, 'fsync', undefined, undefined, () => void fst(fd))),
    rename: (from: unknown, to: unknown, req?: unknown) => run(req, 'rename', from, to, () => void sys('rename', { from: pathString(from), to: pathString(to) })),
    ftruncate: (fd: number, len: number, req?: unknown) => (validatedFd(fd), run(req, 'ftruncate', undefined, undefined, () => void sys('ftruncate', { fd, len: Number(len) }))),
    rmdir: (path: unknown, req?: unknown) => run(req, 'rmdir', path, undefined, () => void sys('rmdir', { p: pathString(path) })),
    mkdir: (path: unknown, mode: number, recursive: boolean, req?: unknown) =>
      run(req, 'mkdir', path, undefined, () => {
        let r: string | null;
        try {
          r = sys<string | null>('mkdir', { p: pathString(path), mode, recursive });
        } catch (e) {
          // MKDirpSync: the path itself being a file is EEXIST, a file higher up ENOTDIR (the
          // kernel's permission check of the first missing directory's parent says EACCES then)
          if (recursive && e instanceof SysError && (e.code === 'ENOTDIR' || e.code === 'EACCES')) {
            const p = pathString(path);
            if (isExistingNonDir(p)) throw new SysError('EEXIST', 'file already exists');
            const pathMod = lib('path');
            for (let up = pathMod.dirname(p); up !== pathMod.dirname(up); up = pathMod.dirname(up)) {
              if (isExistingNonDir(up)) throw new SysError('ENOTDIR', 'not a directory');
            }
          }
          throw e;
        }
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
    // throwIfNoEntry = false: a missing entry (ENOENT, ENOTDIR) gives undefined instead of an error,
    // in every mode (Node 26 passes it for callbacks and promises too)
    stat: (path: unknown, bigint: boolean, req?: unknown, throwIfNoEntry = true) =>
      run(req, 'stat', path, undefined, () => statOrMissing(path, false, bigint, req !== kUsePromises, throwIfNoEntry)),
    lstat: (path: unknown, bigint: boolean, req?: unknown, throwIfNoEntry = true) =>
      run(req, 'lstat', path, undefined, () => statOrMissing(path, true, bigint, req !== kUsePromises, throwIfNoEntry)),
    fstat(fd: number, bigint: boolean, req?: unknown, shouldNotThrow = false) {
      validatedFd(fd);
      if (req === undefined && shouldNotThrow) {
        try {
          return statResult(fst(fd), bigint, true);
        } catch {
          return undefined;
        }
      }
      return run(req, 'fstat', undefined, undefined, () => statResult(fst(fd), bigint, req !== kUsePromises));
    },
    statfs(path: unknown, bigint: boolean, req?: unknown) {
      return run(req, 'statfs', path, undefined, () => {
        st(path, false);
        // [type, bsize, frsize, blocks, bfree, bavail, files, ffree] (StatFs in internal/fs/utils.js)
        const v = [0xef53, 4096, 4096, 1 << 20, 1 << 19, 1 << 19, 1 << 20, 1 << 19];
        if (bigint) return BigInt64Array.from(v.map(BigInt));
        return Float64Array.from(v);
      });
    },
    link: (from: unknown, to: unknown, req?: unknown) => run(req, 'link', from, to, () => void sys('link', { from: pathString(from), to: pathString(to) })),
    symlink: (target: unknown, path: unknown, _flags: number, req?: unknown) => run(req, 'symlink', target, path, () => void sys('symlink', { target: pathString(target), p: pathString(path) })),
    readlink: (path: unknown, encoding: unknown, req?: unknown) => run(req, 'readlink', path, undefined, () => encodeOut(sys<string>('readlink', { p: pathString(path) }), encoding)),
    unlink: (path: unknown, req?: unknown) => run(req, 'unlink', path, undefined, () => void sys('unlink', { p: pathString(path) })),
    realpath: (path: unknown, encoding: unknown, req?: unknown) => run(req, 'realpath', path, undefined, () => encodeOut(sys<string>('realpath', { p: pathString(path) }), encoding)),
    copyFile(from: unknown, to: unknown, mode: unknown, req?: unknown) {
      const m = validatedMode(mode);
      return run(req, 'copyfile', from, to, () => void sys('copyFile', { from: pathString(from), to: pathString(to), excl: !!(m & 1) }));
    },
    chmod: (path: unknown, mode: number, req?: unknown) => run(req, 'chmod', path, undefined, () => void sys('chmod', { p: pathString(path), mode })),
    fchmod: (fd: number, mode: number, req?: unknown) => (validatedFd(fd), run(req, 'fchmod', undefined, undefined, () => void sys('fchmod', { fd, mode }))),
    chown: (path: unknown, _u: number, _g: number, req?: unknown) => run(req, 'chown', path, undefined, () => void st(path, false)),
    fchown: (fd: number, _u: number, _g: number, req?: unknown) => (validatedFd(fd), run(req, 'fchown', undefined, undefined, () => void fst(fd))),
    lchown: (path: unknown, _u: number, _g: number, req?: unknown) => run(req, 'lchown', path, undefined, () => void st(path, true)),
    utimes: (path: unknown, atime: number, mtime: number, req?: unknown) =>
      run(req, 'utime', path, undefined, () => void sys('utimes', { p: pathString(path), atime: atime * 1000, mtime: mtime * 1000 })),
    futimes: (fd: number, atime: number, mtime: number, req?: unknown) => (validatedFd(fd), run(req, 'futime', undefined, undefined, () => void sys('futimes', { fd, atime: atime * 1000, mtime: mtime * 1000 }))),
    lutimes: (path: unknown, atime: number, mtime: number, req?: unknown) =>
      run(req, 'lutime', path, undefined, () => void sys('utimes', { p: pathString(path), atime: atime * 1000, mtime: mtime * 1000, l: true })),
    // the result is the prefix as given plus the 6 random characters (a relative prefix stays
    // relative), as mkdtemp(3) fills in the template; the kernel returns the absolute path
    mkdtemp: (prefix: unknown, encoding: unknown, req?: unknown) =>
      run(req, 'mkdtemp', `${pathString(prefix)}XXXXXX`, undefined, () => encodeOut(pathString(prefix) + sys<string>('mkdtemp', { prefix: pathString(prefix) }).slice(-6), encoding)),
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
      const srcRoot = pathString(src);
      const destRoot = pathString(dest);
      // a dest it creates gets the mode of src (set once filled), an existing one keeps its own
      let srcMode = -1;
      try {
        if (sys<string | null>('mkdir', { p: destRoot, mode: 0o777, recursive: true })) srcMode = st(srcRoot, false).mode & 0o7777;
        if (srcMode >= 0) sys('chmod', { p: destRoot, mode: srcMode | 0o700 });
      } catch (e) {
        throw uvError(e, 'cp', destRoot);
      }
      // cpSync skips sockets and FIFOs inside the tree
      copyTree(srcRoot, destRoot, { force, dereference, errorOnExist, verbatimSymlinks, preserveTimestamps, mode: 0 }, false);
      if (srcMode >= 0) setMode(destRoot, srcMode);
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

interface CopyOptions {
  force: boolean;
  dereference: boolean;
  errorOnExist: boolean;
  verbatimSymlinks: boolean;
  preserveTimestamps: boolean;
  /** copyFile's mode (COPYFILE_EXCL = 1) */
  mode: number;
}

/** A socket, FIFO or other special file met in the tree: its kind and its path under dest. */
type SpecialFile = [kind: 'socket' | 'fifo' | 'unknown', destPath: string];

/**
 * The walk under node_file.cc's CpSyncCopyDir and CpDirJob: copies the entries of the directory
 * srcRoot into the existing destRoot, including their quirks: errors are UVExceptions with syscall
 * 'cp', copied symlinks get absolute, resolved targets (unless verbatimSymlinks), an existing link is
 * replaced even without force. With preserveTimestamps, files and directories (destRoot too) get the
 * source's times, a directory's once its contents are in. A special file (socket, FIFO…) stops the
 * walk and is returned when reportSpecial is set (CpDirJob: fs.cp rejects), and is skipped otherwise
 * (fs.cpSync).
 */
function copyTree(srcRoot: string, destRoot: string, o: CopyOptions, reportSpecial: boolean): SpecialFile | null {
  const pathMod = lib('path');
  const isSubPath = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
  const copyDir = (from: string, to: string): SpecialFile | null => {
    let entries: [string, number][];
    try {
      entries = sys<[string, number][]>('readdir', { p: from, types: true });
    } catch (e) {
      throw uvError(e, 'cp', from);
    }
    for (const [name, mode] of entries) {
      const srcItem = pathMod.join(from, name);
      const destItem = pathMod.join(to, name);
      let type = mode & S_IFMT;
      if (type === S_IFLNK && o.dereference) {
        // dereference: a link is copied as what it points to (a directory as a directory)
        try {
          type = sys<StatData>('stat', { p: srcItem, l: false }).mode & S_IFMT;
        } catch (e) {
          throw uvError(e, 'cp', srcItem, destItem);
        }
      }
      if (type === S_IFLNK) {
        try {
          if (o.verbatimSymlinks) {
            sys('symlink', { target: sys<string>('readlink', { p: srcItem }), p: destItem });
            continue;
          }
          const target = sys<string>('readlink', { p: srcItem });
          let destLink: StatData | null = null;
          try {
            destLink = sys<StatData>('stat', { p: destItem, l: true });
          } catch {}
          if (destLink && (destLink.mode & S_IFMT) === S_IFLNK) {
            const current = sys<string>('readlink', { p: destItem });
            // as cp-sync.js onLink: the existing link may not point inside the source link's
            // directory, nor the source link inside what the existing one points to
            if (!o.dereference && isDirPath(srcItem) && isSubPath(current, target)) throw cpError('ERR_FS_CP_EINVAL', `Cannot copy ${target} to a subdirectory of self ${current}`);
            if (isDirPath(destItem) && isSubPath(target, current)) throw cpError('ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', `cannot overwrite ${current} with ${target}`);
            // the existing link is replaced even without force (as node_file.cc does)
            sys('unlink', { p: destItem });
          } else if (destLink && (destLink.mode & S_IFMT) === S_IFREG && (!o.dereference || (!o.force && o.errorOnExist))) {
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
        // a directory it creates gets the source's mode (owner-writable while it is filled, for a
        // read-only source); an existing one keeps its own
        let srcMode = -1;
        try {
          srcMode = sys<StatData>('stat', { p: srcItem, l: false }).mode & 0o7777;
          sys('mkdir', { p: destItem, mode: srcMode | 0o700 });
        } catch (e) {
          srcMode = -1;
          if (!(e instanceof SysError && e.code === 'EEXIST')) throw uvError(e, 'cp', srcItem, destItem);
        }
        const special = copyDir(srcItem, destItem);
        if (special) return special;
        if (srcMode >= 0) setMode(destItem, srcMode);
        if (o.preserveTimestamps) copyUtimes(srcItem, destItem);
      } else if (type === S_IFREG) {
        let exists = false;
        try {
          sys('stat', { p: destItem, l: false });
          exists = true;
        } catch {}
        if (!exists || o.force) {
          try {
            if (exists) sys('unlink', { p: destItem });
            sys('copyFile', { from: srcItem, to: destItem, excl: !!(o.mode & 1) });
          } catch (e) {
            throw uvError(e, 'cp', srcItem, destItem);
          }
        } else if (o.errorOnExist) {
          throw cpError('ERR_FS_CP_EEXIST', `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${destItem} already exists)`);
        }
        if (o.preserveTimestamps) copyUtimes(srcItem, destItem);
      } else if (reportSpecial) {
        return [type === S_IFSOCK ? 'socket' : type === S_IFIFO ? 'fifo' : 'unknown', destItem];
      }
    }
    return null;
  };
  const special = copyDir(srcRoot, destRoot);
  if (!special && o.preserveTimestamps) copyUtimes(srcRoot, destRoot);
  return special;
}

/** chmod for the walk: errors are cp's UVExceptions. */
function setMode(p: string, mode: number) {
  try {
    sys('chmod', { p, mode });
  } catch (e) {
    throw uvError(e, 'cp', p);
  }
}

function isExistingNonDir(p: string): boolean {
  try {
    return (sys<StatData>('stat', { p, l: false }).mode & S_IFMT) !== S_IFDIR;
  } catch {
    return false;
  }
}

function isDirPath(p: string): boolean {
  try {
    return (sys<StatData>('stat', { p, l: false }).mode & S_IFMT) === S_IFDIR;
  } catch {
    return false;
  }
}

// strerror(3) of the errors std::filesystem reports (its messages are built from it)
const STRERROR: Record<string, string> = {
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty',
  EEXIST: 'File exists',
  EBUSY: 'Device or resource busy',
  EROFS: 'Read-only file system',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long',
  EMFILE: 'Too many open files',
  ENFILE: 'Too many open files in system',
  EINVAL: 'Invalid argument',
  EIO: 'Input/output error',
  ENOSPC: 'No space left on device',
};

/**
 * The error node_file.cc builds from a std::filesystem error (rmSync, CpDirJob): a plain Error with
 * a positive errno, the code, the path and the syscall, and the message "CODE, Strerror: 'path'"
 * (CpDirJob's "CODE, Strerror 'path'" has no colon).
 */
function stdfsError(e: unknown, syscall: string, path: string, colon = true): Error {
  if (!(e instanceof SysError) || !e.code.startsWith('E')) return e as Error;
  const text = STRERROR[e.code] ?? e.message;
  const err = new Error(`${e.code}, ${text}${colon ? ':' : ''} '${path}'`) as Error & Record<string, unknown>;
  err.errno = -errnoOf(e.code);
  err.code = e.code;
  err.path = path;
  err.syscall = syscall;
  return err;
}

/** Blocks the thread for ms (the runtime is a worker, which may): rmSync's delay between retries. */
function sleepSync(ms: number) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * std::filesystem::remove_all, not following links: a directory's entries first, then the directory.
 * An entry that is already gone is not an error. Done with unlink/rmdir (not the kernel's rm) so that
 * permissions are checked on each entry as on Linux.
 */
function removeTree(p: string, isDir: boolean) {
  const gone = (e: unknown) => e instanceof SysError && e.code === 'ENOENT';
  if (!isDir) {
    try {
      sys('unlink', { p });
    } catch (e) {
      if (!gone(e)) throw e;
    }
    return;
  }
  let entries: [string, number][];
  try {
    entries = sys<[string, number][]>('readdir', { p, types: true });
  } catch (e) {
    if (gone(e)) return;
    throw e;
  }
  const base = p.endsWith('/') ? p : p + '/';
  for (const [name, mode] of entries) removeTree(base + name, (mode & S_IFMT) === S_IFDIR);
  try {
    sys('rmdir', { p });
  } catch (e) {
    if (!gone(e)) throw e;
  }
}

// the errors node_file.cc's RmSync retries (Windows sharing violations, a writer racing the removal)
const RM_RETRY = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

/**
 * node_file.cc RmSync (fs.rmSync after lib validated the options, and mkdtempDisposableSync): a
 * missing path is not an error, a directory needs recursive (a plain ERR_FS_EISDIR Error), other
 * failures are std::filesystem errors for the given path, retried maxRetries times with a sleep of
 * i * retryDelay ms before retry i.
 */
function rmSync(path: unknown, maxRetries: unknown, recursive: unknown, retryDelay: unknown) {
  const p = pathString(path);
  let s: StatData;
  try {
    s = sys<StatData>('stat', { p, l: true });
  } catch (e) {
    if (e instanceof SysError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;
    throw stdfsError(e, 'rm', p);
  }
  const isDir = (s.mode & S_IFMT) === S_IFDIR;
  if (isDir && !recursive) throw cpError('ERR_FS_EISDIR', `Path is a directory: ${p}`);
  const retries = Math.max(0, Number(maxRetries) | 0);
  const delay = Math.max(0, Number(retryDelay) || 0);
  for (let i = 1; ; i++) {
    try {
      removeTree(p, isDir);
      return;
    } catch (e) {
      if (i > retries || !(e instanceof SysError && RM_RETRY.has(e.code))) throw stdfsError(e, 'rm', p);
      sleepSync(i * delay);
    }
  }
}
