// Open file descriptions, pipes and the TTY line discipline.

import { kerr } from '../shared/errno.ts';
import { type Inode, type VFS, isDir } from './vfs.ts';

export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_NOCTTY = 0o400;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;
export const O_NONBLOCK = 0o4000;
export const O_DIRECTORY = 0o200000;
export const O_NOFOLLOW = 0o400000;
export const O_SYNC = 0o4010000;

/** Something that can be read from asynchronously (pipe read end, tty). */
export interface ReadableEnd {
  /** Resolves with data, or null on EOF. */
  read(max: number): Promise<Uint8Array | null>;
  /** Returns available data immediately, null on EOF, or undefined if it would block. */
  tryRead(max: number): Uint8Array | null | undefined;
}

export interface WritableEnd {
  write(data: Uint8Array): number;
}

export type FileKind = 'file' | 'dir' | 'pipe' | 'tty' | 'null' | 'socket';

export class OpenFile {
  refs = 1;
  pos = 0;
  closed = false;
  dirCursor?: string[];
  onClose?: () => void;
  constructor(
    public kind: FileKind,
    public flags: number,
    public opts: {
      vfs?: VFS;
      node?: Inode;
      path?: string;
      reader?: ReadableEnd;
      writer?: WritableEnd;
      tty?: Tty;
    } = {},
  ) {}

  get readable() {
    return (this.flags & O_ACCMODE) !== O_WRONLY;
  }
  get writable() {
    return (this.flags & O_ACCMODE) !== O_RDONLY;
  }

  ref() {
    this.refs++;
    return this;
  }

  unref() {
    if (--this.refs > 0) return;
    this.closed = true;
    this.onClose?.();
  }

  /** Synchronous-ish read for regular files; for streams use readAsync. */
  readFileAt(buf: Uint8Array, position: number | null): number {
    if (!this.readable) throw kerr('EBADF');
    const { vfs, node } = this.opts;
    if (!vfs || !node) throw kerr('EBADF');
    if (isDir(node)) throw kerr('EISDIR');
    const pos = position ?? this.pos;
    const n = vfs.readAt(node, buf, pos);
    if (position === null || position === undefined) this.pos += n;
    return n;
  }

  writeFileAt(data: Uint8Array, position: number | null): number {
    if (!this.writable) throw kerr('EBADF');
    const { vfs, node, path } = this.opts;
    if (!vfs || !node) throw kerr('EBADF');
    let pos = position ?? this.pos;
    if (this.flags & O_APPEND) pos = node.size;
    const n = vfs.writeAt(node, data, pos, path);
    if (position === null || position === undefined) this.pos = pos + n;
    return n;
  }

  /** Reads from any kind; may wait (pipes, tty). */
  async read(max: number, position: number | null = null): Promise<Uint8Array> {
    if (!this.readable) throw kerr('EBADF');
    switch (this.kind) {
      case 'file': {
        const buf = new Uint8Array(max);
        const n = this.readFileAt(buf, position);
        return buf.subarray(0, n);
      }
      case 'null':
        return new Uint8Array(0);
      case 'dir':
        throw kerr('EISDIR');
      default: {
        const r = this.opts.reader ?? this.opts.tty;
        if (!r) throw kerr('EBADF');
        const d = await r.read(max);
        return d ?? new Uint8Array(0);
      }
    }
  }

  /** Non-blocking read: undefined means EAGAIN. */
  tryRead(max: number, position: number | null = null): Uint8Array | undefined {
    if (this.kind === 'file' || this.kind === 'null' || this.kind === 'dir') {
      const buf = new Uint8Array(max);
      if (this.kind === 'null') return buf.subarray(0, 0);
      const n = this.readFileAt(buf, position);
      return buf.subarray(0, n);
    }
    const r = this.opts.reader ?? this.opts.tty;
    if (!r) throw kerr('EBADF');
    const d = r.tryRead(max);
    if (d === undefined) return undefined;
    return d ?? new Uint8Array(0);
  }

  write(data: Uint8Array, position: number | null = null): number {
    if (!this.writable) throw kerr('EBADF');
    switch (this.kind) {
      case 'file':
        return this.writeFileAt(data, position);
      case 'null':
        return data.length;
      case 'dir':
        throw kerr('EISDIR');
      default: {
        const w = this.opts.writer ?? this.opts.tty;
        if (!w) throw kerr('EBADF');
        return w.write(data);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pipes

export class Pipe {
  private chunks: Uint8Array[] = [];
  private size = 0;
  readers = 0;
  writers = 0;
  private waiting: { max: number; resolve: (d: Uint8Array | null) => void }[] = [];
  private drainWaiters: (() => void)[] = [];
  /** Called when there is new data or EOF (for push-style readers). */
  onReadable = new Set<() => void>();
  onBroken?: () => void;

  constructor(public id: number) {}

  readEnd(): ReadableEnd & { pipe: Pipe } {
    const self = this;
    return {
      pipe: self,
      read: (max) => self.read(max),
      tryRead: (max) => self.tryRead(max),
    };
  }

  writeEnd(): WritableEnd & { pipe: Pipe } {
    const self = this;
    return { pipe: self, write: (d) => self.write(d) };
  }

  get buffered() {
    return this.size;
  }

  write(data: Uint8Array): number {
    if (this.readers === 0) {
      this.onBroken?.();
      throw kerr('EPIPE');
    }
    if (data.length === 0) return 0;
    const copy = data.slice();
    if (this.waiting.length > 0 && this.chunks.length === 0) {
      const w = this.waiting.shift()!;
      if (copy.length <= w.max) {
        w.resolve(copy);
        this.notify();
        return data.length;
      }
      w.resolve(copy.subarray(0, w.max));
      this.chunks.push(copy.subarray(w.max));
      this.size += copy.length - w.max;
    } else {
      this.chunks.push(copy);
      this.size += copy.length;
    }
    this.flushWaiting();
    this.notify();
    return data.length;
  }

  private notify() {
    for (const fn of [...this.onReadable]) fn();
  }

  private take(max: number): Uint8Array {
    if (this.chunks.length === 1 || this.chunks[0].length >= max) {
      const c = this.chunks[0];
      if (c.length <= max) {
        this.chunks.shift();
        this.size -= c.length;
        return c;
      }
      this.chunks[0] = c.subarray(max);
      this.size -= max;
      return c.subarray(0, max);
    }
    const n = Math.min(max, this.size);
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) {
        out.set(c, off);
        off += c.length;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, need), off);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.size -= n;
    return out;
  }

  private flushWaiting() {
    while (this.waiting.length > 0 && this.size > 0) {
      const w = this.waiting.shift()!;
      w.resolve(this.take(w.max));
    }
    if (this.size === 0) {
      const d = this.drainWaiters;
      this.drainWaiters = [];
      for (const fn of d) fn();
    }
  }

  tryRead(max: number): Uint8Array | null | undefined {
    if (this.size > 0) {
      const d = this.take(max);
      if (this.size === 0) this.flushWaiting();
      return d;
    }
    if (this.writers === 0) return null;
    return undefined;
  }

  read(max: number): Promise<Uint8Array | null> {
    const d = this.tryRead(max);
    if (d !== undefined) return Promise.resolve(d);
    return new Promise((resolve) => this.waiting.push({ max, resolve }));
  }

  closeWriter() {
    this.writers--;
    if (this.writers <= 0) {
      this.writers = 0;
      const w = this.waiting;
      this.waiting = [];
      for (const x of w) x.resolve(null);
      this.notify();
    }
  }

  closeReader() {
    this.readers--;
    if (this.readers <= 0) {
      this.readers = 0;
      this.chunks = [];
      this.size = 0;
      const d = this.drainWaiters;
      this.drainWaiters = [];
      for (const fn of d) fn();
    }
  }
}

let nextPipeId = 1;

export function createPipe(): { pipe: Pipe; r: OpenFile; w: OpenFile } {
  const pipe = new Pipe(nextPipeId++);
  pipe.readers = 1;
  pipe.writers = 1;
  const r = new OpenFile('pipe', O_RDONLY, { reader: pipe.readEnd() });
  const w = new OpenFile('pipe', O_WRONLY, { writer: pipe.writeEnd() });
  r.onClose = () => pipe.closeReader();
  w.onClose = () => {
    if ((globalThis as any).__ovTrace) console.warn(`[trace] pipe ${pipe.id} writer closed`, new Error().stack);
    pipe.closeWriter();
  };
  return { pipe, r, w };
}

// ---------------------------------------------------------------------------
// TTY with a small line discipline.

export interface TtyHooks {
  output(data: Uint8Array): void;
  signal(sig: 'SIGINT' | 'SIGQUIT' | 'SIGTSTP' | 'SIGWINCH'): void;
}

const enc = new TextEncoder();

export class Tty implements ReadableEnd, WritableEnd {
  raw = false;
  echo = true;
  cols = 80;
  rows = 24;
  foregroundPgid = 0;
  private line: number[] = [];
  private ready: Uint8Array[] = [];
  private eof = false;
  private waiting: { max: number; resolve: (d: Uint8Array | null) => void }[] = [];
  onReadable = new Set<() => void>();

  constructor(public id: number, private hooks: TtyHooks) {}

  /** Output from processes → terminal (with \n → \r\n). */
  write(data: Uint8Array): number {
    if (this.raw) {
      // keep ONLCR even in raw mode: node's setRawMode only touches input
    }
    let count = 0;
    for (let i = 0; i < data.length; i++) if (data[i] === 10 && (i === 0 || data[i - 1] !== 13)) count++;
    if (count === 0) {
      this.hooks.output(data.slice());
      return data.length;
    }
    const out = new Uint8Array(data.length + count);
    let j = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 10 && (i === 0 || data[i - 1] !== 13)) out[j++] = 13;
      out[j++] = data[i];
    }
    this.hooks.output(out);
    return data.length;
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.hooks.signal('SIGWINCH');
  }

  /** Input from the terminal (keyboard). */
  input(data: Uint8Array) {
    if (this.raw) {
      // ^C still generates SIGINT unless ISIG is off; node's raw mode turns ISIG off.
      this.pushReady(data.slice());
      return;
    }
    for (const b of data) this.inputByte(b);
  }

  private echoBytes(bytes: Uint8Array | number[]) {
    if (this.echo) this.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  private inputByte(b: number) {
    switch (b) {
      case 3: // ^C
        this.line = [];
        this.echoBytes(enc.encode('^C\n'));
        this.hooks.signal('SIGINT');
        return;
      case 28: // ^\
        this.line = [];
        this.hooks.signal('SIGQUIT');
        return;
      case 26: // ^Z
        this.hooks.signal('SIGTSTP');
        return;
      case 4: // ^D
        if (this.line.length === 0) {
          this.pushEof();
        } else {
          this.pushReady(new Uint8Array(this.line));
          this.line = [];
        }
        return;
      case 127:
      case 8: {
        if (this.line.length > 0) {
          // remove one UTF-8 character
          let n = 1;
          while (n < this.line.length && (this.line[this.line.length - n] & 0xc0) === 0x80) n++;
          this.line.splice(this.line.length - n, n);
          this.echoBytes([8, 32, 8]);
        }
        return;
      }
      case 21: // ^U
        if (this.line.length > 0) {
          this.echoBytes(enc.encode('\r\x1b[K'));
          this.line = [];
        }
        return;
      case 13:
      case 10: {
        this.line.push(10);
        this.echoBytes([10]);
        this.pushReady(new Uint8Array(this.line));
        this.line = [];
        return;
      }
      case 27:
        // ignore escape sequences in cooked mode (arrows etc.)
        this.line.push(b);
        return;
      default:
        this.line.push(b);
        if (b >= 32 || b === 9) this.echoBytes([b]);
    }
  }

  private pushReady(d: Uint8Array) {
    if (d.length === 0) return;
    // strip bare escape sequences from cooked lines
    this.ready.push(d);
    this.flush();
  }

  private pushEof() {
    this.eof = true;
    this.flush();
  }

  private flush() {
    while (this.waiting.length > 0 && (this.ready.length > 0 || this.eof)) {
      const w = this.waiting.shift()!;
      const d = this.takeReady(w.max);
      w.resolve(d);
    }
    for (const fn of [...this.onReadable]) fn();
  }

  private takeReady(max: number): Uint8Array | null {
    if (this.ready.length === 0) {
      if (this.eof) {
        this.eof = false; // EOF is consumed by one reader (like a real tty)
        return null;
      }
      return new Uint8Array(0);
    }
    const c = this.ready[0];
    if (c.length <= max) {
      this.ready.shift();
      return c;
    }
    this.ready[0] = c.subarray(max);
    return c.subarray(0, max);
  }

  tryRead(max: number): Uint8Array | null | undefined {
    if (this.ready.length > 0 || this.eof) return this.takeReady(max);
    return undefined;
  }

  read(max: number): Promise<Uint8Array | null> {
    const d = this.tryRead(max);
    if (d !== undefined) return Promise.resolve(d);
    return new Promise((resolve) => this.waiting.push({ max, resolve }));
  }

  /** Discards pending input (used when the foreground job changes). */
  flushInput() {
    this.line = [];
  }
}
