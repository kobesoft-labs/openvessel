// stream_wrap, pipe_wrap and tty_wrap: libuv stream handles over kernel file descriptors.
// HandleWrap (close/ref/unref) → LibuvStreamWrap (readStart/readStop/write*/shutdown) → Pipe, TTY.
// Reads come from the kernel as 'fd-data' messages after readStart; writes are synchronous syscalls,
// so every write completes synchronously (kLastWriteWasAsync = 0), like a blocking stdio pipe.

import { SysError, post, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { Enc, encode } from './buffer.ts';
import { fromShape } from './shape.ts';

const UV_EOF = -4095;
let streamBaseState: Int32Array;
const kReadBytesOrError = 0;
const kArrayBufferOffset = 1;
const kBytesWritten = 2;
const kLastWriteWasAsync = 3;

function errno(code: string): number {
  return S.internalBinding('uv')[`UV_${code}`] ?? -1;
}

// fd → stream receiving its 'fd-data'
const readers = new Map<number, LibuvStreamWrap>();
let handlerInstalled = false;
function installHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  S.kernelHandlers.set('fd-data', (msg: { fd?: number; id?: number; data: Uint8Array | null; err?: string }) => {
    if (msg.id !== undefined) {
      const cb = oneShot.get(msg.id);
      oneShot.delete(msg.id);
      cb?.(msg.data, msg.err);
      return;
    }
    if (msg.fd === undefined) return;
    readers.get(msg.fd)?._onData(msg.data);
  });
}

// single reads that must not block the worker (async fs.read on a pipe, tty or socket)
const oneShot = new Map<number, (data: Uint8Array | null, err?: string) => void>();
let nextReadId = 1;
export function readOnce(fd: number, len: number): Promise<Uint8Array> {
  installHandler();
  const id = nextReadId++;
  return new Promise((resolve, reject) => {
    oneShot.set(id, (data, err) => (err ? reject(new SysError(err, err)) : resolve(data ?? new Uint8Array(0))));
    post({ t: 'readOnce', id, fd, len });
  });
}

/** HandleWrap: something that keeps the loop alive while active and ref'd. */
export class HandleWrap {
  #handle: loop.LoopHandle;
  #closed = false;
  onclose: unknown;
  constructor(resourceName: string, active = false) {
    this.#handle = { active, refed: true, resourceName };
    loop.addHandle(this.#handle);
  }
  protected setActive(v: boolean) {
    this.#handle.active = v;
    if (!v) loop.scheduleAliveCheck();
  }
  get _closed() {
    return this.#closed;
  }
  close(cb?: () => void) {
    if (this.#closed) return;
    this.#closed = true;
    this._onClose();
    this.#handle.active = false;
    loop.removeHandle(this.#handle);
    // uv_close callbacks run on a later loop turn
    const done = loop.startReq('HandleClose');
    loop.macrotask(() => {
      done();
      if (typeof cb === 'function') loop.scope(cb, this);
      const onclose = (this as any)[S.perIsolateSymbols.handle_onclose];
      if (typeof onclose === 'function') loop.scope(onclose, this);
    });
  }
  protected _onClose() {}
  ref() {
    this.#handle.refed = true;
    loop.scheduleAliveCheck();
  }
  unref() {
    this.#handle.refed = false;
    loop.scheduleAliveCheck();
  }
  hasRef() {
    return !this.#closed && this.#handle.refed;
  }
  getAsyncId() {
    return -1;
  }
  getProviderType() {
    return 0;
  }
}

export class LibuvStreamWrap extends HandleWrap {
  onread: ((buf?: ArrayBuffer) => unknown) | null = null;
  reading = false;
  bytesRead = 0;
  bytesWritten = 0;
  isStreamBase = true;
  protected _fd = -1;
  #userBuffer: Uint8Array | null = null;

  get fd() {
    return this._fd;
  }
  get _externalStream() {
    return undefined;
  }

  readStart(): number {
    if (this._fd < 0) return errno('EBADF');
    installHandler();
    readers.set(this._fd, this);
    this.reading = true;
    this.setActive(true);
    post({ t: 'readStart', fd: this._fd });
    return 0;
  }

  readStop(): number {
    if (this._fd >= 0 && readers.get(this._fd) === this) {
      post({ t: 'readStop', fd: this._fd });
      readers.delete(this._fd);
    }
    this.reading = false;
    this.setActive(false);
    return 0;
  }

  useUserBuffer(buf: Uint8Array) {
    this.#userBuffer = buf;
  }

  /** @internal kernel data (null = EOF) */
  _onData(data: Uint8Array | null) {
    if (this._closed || !this.onread) return;
    if (data === null) {
      readers.delete(this._fd);
      this.reading = false;
      this.setActive(false);
      streamBaseState[kReadBytesOrError] = UV_EOF;
      streamBaseState[kArrayBufferOffset] = 0;
      loop.scope(this.onread, this, undefined);
      return;
    }
    this.bytesRead += data.length;
    if (this.#userBuffer) {
      const n = Math.min(data.length, this.#userBuffer.length);
      this.#userBuffer.set(data.subarray(0, n));
      streamBaseState[kReadBytesOrError] = n;
      streamBaseState[kArrayBufferOffset] = 0;
      loop.scope(this.onread, this, this.#userBuffer.buffer);
      return;
    }
    const ab = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : data.slice().buffer;
    streamBaseState[kReadBytesOrError] = data.length;
    streamBaseState[kArrayBufferOffset] = 0;
    loop.scope(this.onread, this, ab);
  }

  #write(bytes: Uint8Array): number {
    streamBaseState[kLastWriteWasAsync] = 0;
    streamBaseState[kBytesWritten] = 0;
    if (this._fd < 0) return errno('EBADF');
    try {
      let off = 0;
      while (off < bytes.length) off += sys<number>('write', { fd: this._fd, pos: null }, bytes.subarray(off));
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('EIO');
    }
    this.bytesWritten += bytes.length;
    streamBaseState[kBytesWritten] = bytes.length;
    return 0;
  }

  writeBuffer(_req: unknown, buf: ArrayBufferView) {
    return this.#write(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  }
  writev(_req: unknown, chunks: unknown[], allBuffers: boolean) {
    const parts: Uint8Array[] = [];
    if (allBuffers) for (const c of chunks as ArrayBufferView[]) parts.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
    else
      for (let i = 0; i < chunks.length; i += 2) {
        const c = chunks[i];
        if (typeof c === 'string') parts.push(encode(c, encodingId(chunks[i + 1] as string)));
        else parts.push(new Uint8Array((c as ArrayBufferView).buffer, (c as ArrayBufferView).byteOffset, (c as ArrayBufferView).byteLength));
      }
    let n = 0;
    for (const p of parts) n += p.length;
    const all = new Uint8Array(n);
    n = 0;
    for (const p of parts) {
      all.set(p, n);
      n += p.length;
    }
    return this.#write(all);
  }
  writeUtf8String(_req: unknown, s: string) {
    return this.#write(encode(s, Enc.UTF8));
  }
  writeAsciiString(_req: unknown, s: string) {
    return this.#write(encode(s, Enc.ASCII));
  }
  writeLatin1String(_req: unknown, s: string) {
    return this.#write(encode(s, Enc.LATIN1));
  }
  writeUcs2String(_req: unknown, s: string) {
    return this.#write(encode(s, Enc.UCS2));
  }

  shutdown(req: { oncomplete?: (status: number) => void }) {
    const done = loop.startReq('ShutdownWrap');
    loop.macrotask(() => {
      done();
      if (typeof req.oncomplete === 'function') loop.scope(req.oncomplete, req, 0);
    });
    return 0;
  }

  setBlocking() {
    return 0;
  }

  protected override _onClose() {
    if (this.reading) this.readStop();
    if (this._fd > 2) {
      try {
        sys('close', { fd: this._fd });
      } catch {}
    }
    this._fd = -1;
  }
}

function encodingId(e: string): Enc {
  switch (e) {
    case 'latin1':
    case 'binary':
      return Enc.LATIN1;
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return Enc.UCS2;
    case 'ascii':
      return Enc.ASCII;
    case 'hex':
      return Enc.HEX;
    case 'base64':
      return Enc.BASE64;
    case 'base64url':
      return Enc.BASE64URL;
    default:
      return Enc.UTF8;
  }
}

export class Pipe extends LibuvStreamWrap {
  constructor(public type = 0) {
    super(type === 1 ? 'PipeServerWrap' : 'PipeWrap');
  }
  open(fd: number) {
    this._fd = fd;
    return 0;
  }
  /** @internal set by process_wrap when the kernel hands back the parent side of a stdio pipe */
  _setFd(fd: number) {
    this._fd = fd;
  }
  bind() {
    return errno('ENOTSUP');
  }
  listen() {
    return errno('ENOTSUP');
  }
  connect() {
    return errno('ENOTSUP');
  }
  fchmod() {
    return 0;
  }
  setPendingInstances() {}
}

export class TTY extends LibuvStreamWrap {
  constructor(fd: number, ctx?: Record<string, unknown>) {
    super('TTYWrap');
    this._fd = fd;
    void ctx;
  }
  getWindowSize(out: number[]) {
    try {
      const s = sys<{ cols: number; rows: number } | null>('ttySize', { fd: this._fd });
      if (!s) return errno('ENOTTY');
      out[0] = s.cols;
      out[1] = s.rows;
      return 0;
    } catch {
      return errno('EBADF');
    }
  }
  setRawMode(raw: boolean) {
    try {
      sys('setRawMode', { fd: this._fd, raw });
      return 0;
    } catch {
      return errno('ENOTTY');
    }
  }
}

class WriteWrap {
  handle: unknown = null;
  oncomplete: unknown = null;
  async = false;
  bytes = 0;
  buffer: unknown = null;
  callback: unknown = null;
}
class ShutdownWrap {
  handle: unknown = null;
  oncomplete: unknown = null;
  callback: unknown = null;
}

export function createStreamWrap() {
  const b = fromShape('stream_wrap');
  streamBaseState = b.streamBaseState;
  return Object.assign(b, { LibuvStreamWrap, WriteWrap, ShutdownWrap });
}

export function createPipeWrap() {
  return Object.assign(fromShape('pipe_wrap'), { Pipe, PipeConnectWrap: class PipeConnectWrap {} });
}

export function createTtyWrap() {
  return Object.assign(fromShape('tty_wrap'), {
    TTY,
    isTTY(fd: number) {
      try {
        return sys<string | null>('fdKind', { fd }) === 'tty';
      } catch {
        return false;
      }
    },
  });
}
