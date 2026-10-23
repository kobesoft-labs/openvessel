// internalBinding('fs_event_wrap') — fs_event_wrap.cc (uv_fs_event_t) over the kernel's watch/unwatch
// syscalls. The kernel reports every VFS mutation under the watched path as { t: 'watch', id, type, path }
// with an absolute path; this turns it into what libuv's inotify backend reports:
//   - a child of a watched directory: its name ('rename' for create/delete/move, 'change' for writes)
//   - the watched file or directory itself: its basename
//   - recursive (the native macOS/Windows behaviour; Linux's lib uses recursive_watch.js instead):
//     the path relative to the watched directory
// inotify watches follow the inode, so once the watched file/directory is deleted (or replaced by a
// rename) the handle stays open but reports nothing more.

import { sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S, lib } from '../state.ts';
import { encodeOut, pathString } from './fs.ts';
import { fromShape } from './shape.ts';
import { HandleWrap } from './stream.ts';

const watchers = new Map<number, FSEvent>();
let nextId = 1;
let handlerInstalled = false;

function installHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  S.kernelHandlers.set('watch', (msg: { id: number; type: 'rename' | 'change'; path: string }) => {
    watchers.get(msg.id)?._onEvent(msg.type, msg.path);
  });
}

function errno(code: string): number {
  return S.internalBinding('uv')[`UV_${code}`] ?? -1;
}

function inodeOf(p: string): number | null {
  try {
    return sys<{ ino: number }>('stat', { p, l: false }).ino;
  } catch {
    return null;
  }
}

export class FSEvent extends HandleWrap {
  onchange: ((status: number, eventType: string, filename: unknown) => void) | null = null;
  #id = 0;
  #path = '';
  #ino: number | null = null;
  #isDir = false;
  #encoding: unknown = 'utf8';
  #started = false;
  #stopped = false;

  constructor() {
    super('FSEventWrap');
  }

  get initialized() {
    return this.#started && !this._closed;
  }

  start(path: unknown, persistent: unknown, recursive: unknown, encoding: unknown): number {
    const p = lib('path').resolve(pathString(path));
    this.#started = true;
    this.#encoding = encoding ?? 'utf8';
    try {
      const st = sys<{ ino: number; mode: number }>('stat', { p, l: false });
      this.#ino = st.ino;
      this.#isDir = (st.mode & 0o170000) === 0o040000;
    } catch (e) {
      // uv_fs_event_start failed: the handle is closed and the error returned
      this.close();
      return errno((e as { code?: string }).code ?? 'EIO');
    }
    installHandler();
    this.#path = p;
    this.#id = nextId++;
    watchers.set(this.#id, this);
    sys('watch', { id: this.#id, p, recursive: recursive === true });
    this.setActive(true);
    if (persistent !== true) this.unref();
    return 0;
  }

  /** @internal a kernel watch event */
  _onEvent(type: 'rename' | 'change', path: string) {
    if (this._closed || this.#stopped) return;
    const base = this.#path;
    let filename: string;
    if (path === base) filename = lib('path').basename(base);
    else if (path.startsWith(base === '/' ? '/' : base + '/')) filename = path.slice(base === '/' ? 1 : base.length + 1);
    else return;
    if (path === base && type === 'rename' && inodeOf(base) !== this.#ino) {
      // The watched inode left this path. inotify reports a deleted file as IN_ATTRIB (nlink),
      // IN_DELETE_SELF and IN_IGNORED ('change', 'rename', 'rename'; a directory without the
      // 'change'), and the watch ends.
      this.#stop();
      const events = this.#isDir ? ['rename', 'rename'] : ['change', 'rename', 'rename'];
      for (const t of events) {
        if (this._closed) break;
        this.#emit(t, filename);
      }
      return;
    }
    this.#emit(type, filename);
  }

  #emit(type: string, filename: string) {
    if (typeof this.onchange === 'function') loop.scope(this.onchange, this, 0, type, encodeOut(filename, this.#encoding));
  }

  #stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    watchers.delete(this.#id);
    try {
      sys('unwatch', { id: this.#id });
    } catch {}
  }

  protected override _onClose() {
    if (this.#id) this.#stop();
  }
}

export function createFsEventWrap() {
  return Object.assign(fromShape('fs_event_wrap'), { FSEvent });
}
