// internalBinding('fs_dir') — node_dir.cc over the kernel's readdir.
// uv_fs_opendir/readdir/closedir: the kernel has no directory streams, so opendir takes a snapshot
// of the entries (with their types) and read() hands them out in batches of bufferSize.
// Like the fs binding, every call is sync (throws), FSReqCallback or kUsePromises.

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { FSReqPromise, encodeOut, pathString, uvError } from './fs.ts';
import { asyncIdOf, completeReq, emitAsyncInit } from './process.ts';
import { fromShape } from './shape.ts';

const S_IFMT = 0o170000;
// uv_dirent_type_t by file mode
const DIRENT: Record<number, number> = { 0o100000: 1, 0o040000: 2, 0o120000: 3, 0o010000: 4, 0o140000: 5, 0o020000: 6, 0o060000: 7 };

type Req = { oncomplete?: ((...a: unknown[]) => void) | null } | symbol | undefined;

/** Runs fn in the mode selected by req (see run() in fs.ts). */
function run<T>(req: Req, syscall: string, path: unknown, fn: () => T): T | Promise<T> | undefined {
  if (req === undefined) {
    try {
      return fn();
    } catch (e) {
      throw uvError(e, syscall, path);
    }
  }
  if (typeof req === 'symbol') {
    const done = loop.startReq('FSReqPromise');
    const wrap = new FSReqPromise();
    return new Promise<T>((resolve, reject) => {
      loop.macrotask(() => {
        done();
        loop.scope(() => {
          try {
            resolve(fn());
          } catch (e) {
            reject(uvError(e, syscall, path));
          }
        }, wrap);
      });
    });
  }
  const done = loop.startReq('FSReqCallback');
  loop.macrotask(() => {
    let err: Error | null = null;
    let result: T | undefined;
    try {
      result = fn();
    } catch (e) {
      err = uvError(e, syscall, path);
    }
    done();
    if (err) completeReq(req, err);
    else if (result === undefined) completeReq(req, null);
    else completeReq(req, null, result);
  });
  return undefined;
}

export class DirHandle {
  #entries: [string, number][];
  #pos = 0;
  #closed = false;
  constructor(entries: [string, number][]) {
    this.#entries = entries;
    emitAsyncInit(this, 'DIRHANDLE');
  }
  getAsyncId() {
    return asyncIdOf(this);
  }
  /** [name, type, name, type, …] (at most bufferSize entries), or null at the end. */
  read(encoding: unknown, bufferSize: number, req?: Req) {
    return run(req, 'readdir', undefined, () => {
      if (this.#closed) throw new SysError('EBADF', 'bad file descriptor');
      const n = Math.max(1, bufferSize | 0);
      if (this.#pos >= this.#entries.length) return null;
      const out: unknown[] = [];
      for (const [name, mode] of this.#entries.slice(this.#pos, this.#pos + n)) out.push(encodeOut(name, encoding), DIRENT[mode & S_IFMT] ?? 0);
      this.#pos += n;
      return out;
    });
  }
  close(req?: Req) {
    return run(req, 'closedir', undefined, () => {
      this.#closed = true;
      this.#entries = [];
    });
  }
}

function open(path: unknown): DirHandle {
  const p = pathString(path);
  // readdir on a non-directory fails with ENOTDIR, a missing one with ENOENT (as opendir(3) does)
  return new DirHandle(sys<[string, number][]>('readdir', { p, types: true }));
}

export function createFsDir() {
  const b = fromShape('fs_dir');
  return Object.assign(b, {
    DirHandle,
    opendir: (path: unknown, _encoding: unknown, req?: Req) => run(req, 'opendir', path, () => open(path)),
    // node_dir.cc's OpenDirSync throws without the path ("ENOENT: no such file or directory, opendir")
    opendirSync: (path: unknown) => run(undefined, 'opendir', undefined, () => open(path)),
  });
}
