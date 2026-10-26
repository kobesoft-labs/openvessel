// stream_wrap, pipe_wrap and tty_wrap: libuv stream handles over kernel file descriptors.
// HandleWrap (close/ref/unref) → LibuvStreamWrap (readStart/readStop/write*/shutdown) → Pipe, TTY.
// Reads come from the kernel as 'fd-data' messages after readStart. Writes are syscalls: stdio
// (fds 0-2) writes whole buffers synchronously, like Node's stdio pipes on Linux; other pipes and
// sockets take what fits in the kernel buffer and finish the rest asynchronously once the reader
// has drained it ('fd-writable'), so writers see backpressure like with libuv.

import { SysError, post, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { Enc, encode } from './buffer.ts';
import { fromShape } from './shape.ts';
import { asyncDestroy, asyncIdOf, completeReq, emitAsyncInit, providerNumber, reqInit, withDefaultTrigger } from './process.ts';

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
// fd → stream waiting for room to write ('fd-writable')
const writers = new Map<number, LibuvStreamWrap>();
let handlerInstalled = false;
function installHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  S.kernelHandlers.set('fd-data', (msg: { fd?: number; id?: number; data: Uint8Array | null; err?: string; handle?: HandleDescriptor }) => {
    if (msg.id !== undefined) {
      const cb = oneShot.get(msg.id);
      oneShot.delete(msg.id);
      cb?.(msg.data, msg.err);
      return;
    }
    if (msg.fd === undefined) return;
    readers.get(msg.fd)?._onData(msg.data, msg.handle);
  });
  S.kernelHandlers.set('fd-writable', (msg: { fd: number }) => writers.get(msg.fd)?._onWritable());
}

interface QueuedWrite {
  req: { oncomplete?: (status: number) => void };
  data: Uint8Array;
  done: () => void;
  sendHandle?: HandleDescriptor;
}

/**
 * A handle passed over an IPC pipe (uv_write2 / uv_accept of the pending handle): what kind of
 * wrap it is, its fd in the receiving process (the kernel installs it), and what the wrap needs.
 */
export interface HandleDescriptor {
  type: string;
  fd?: number;
  [k: string]: unknown;
}
/** Makes the receiving process's wrap for a passed handle, by descriptor type (pipe, tcp, …). */
export const handleFactories: Record<string, (d: HandleDescriptor) => object> = {};

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

/**
 * HandleWrap: something that keeps the loop alive while active and ref'd. It is an AsyncWrap of
 * its provider (TCPWRAP, PIPEWRAP…): an async id and the init hook when made, its callbacks in its
 * async context, the destroy hook once closed.
 */
export class HandleWrap {
  #handle: loop.LoopHandle;
  #closed = false;
  #provider: string;
  onclose: unknown;
  constructor(resourceName: string, active = false, provider = 'NONE') {
    this.#handle = { active, refed: true, resourceName, owner: this };
    this.#provider = provider;
    loop.addHandle(this.#handle);
    if (provider !== 'NONE') emitAsyncInit(this, provider);
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
      asyncDestroy(this);
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
    return asyncIdOf(this);
  }
  getProviderType() {
    return providerNumber(this.#provider);
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

  /** data the kernel sent before it saw a readStop(), delivered on the next readStart() */
  #held: { data: Uint8Array | null; handle?: HandleDescriptor }[] = [];
  /** the kernel is reading this fd for us */
  #kernelReading = false;
  #startQueued = false;

  readStart(): number {
    if (this._fd < 0) return errno('EBADF');
    installHandler();
    readers.set(this._fd, this);
    this.reading = true;
    this.setActive(true);
    // libuv reads in the poll phase, not inside readStart(): a pipe handed to another child right
    // after (readStop() in the same tick, as child_process does for stdio 'wrap') loses nothing
    if (!this.#kernelReading && !this.#startQueued) {
      this.#startQueued = true;
      loop.macrotask(() => {
        this.#startQueued = false;
        if (!this.reading || this._closed || this._fd < 0 || this.#kernelReading) return;
        // what was held comes first
        while (this.#held.length && this.reading) {
          const d = this.#held.shift()!;
          this._onData(d.data, d.handle);
          if (d.data === null) return;
        }
        if (!this.reading || this.#held.some((h) => h.data === null)) return;
        this.#kernelReading = true;
        post({ t: 'readStart', fd: this._fd });
      });
    }
    return 0;
  }

  readStop(): number {
    // stays in `readers` so data already on its way is held, not lost
    if (this.#kernelReading) post({ t: 'readStop', fd: this._fd });
    this.#kernelReading = false;
    this.reading = false;
    this.setActive(false);
    return 0;
  }

  useUserBuffer(buf: Uint8Array) {
    this.#userBuffer = buf;
  }

  /** @internal kernel data (null = EOF) */
  _onData(data: Uint8Array | null, handle?: HandleDescriptor) {
    if (this._closed || !this.onread) {
      if (typeof handle?.fd === 'number') closeFd(handle.fd);
      return;
    }
    if (!this.reading) {
      this.#held.push({ data, handle });
      return;
    }
    if (handle) {
      const make = handleFactories[handle.type];
      if (make) (this as any).pendingHandle = make(handle);
      else if (typeof handle.fd === 'number') closeFd(handle.fd);
    }
    if (data === null) {
      readers.delete(this._fd);
      this.#kernelReading = false;
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

  writeQueueSize = 0;
  #queue: QueuedWrite[] = [];
  #blocking = false;
  #afterQueue: (() => void)[] = [];

  /** What the kernel needs to pass this handle to another process (uv_write2's send_handle). */
  _sendDescriptor(): HandleDescriptor | null {
    return this._fd >= 0 ? { type: 'pipe', fd: this._fd } : null;
  }

  #write(req: unknown, bytes: Uint8Array, handle?: unknown): number {
    streamBaseState[kLastWriteWasAsync] = 0;
    streamBaseState[kBytesWritten] = 0;
    if (this._fd < 0) return errno('EBADF');
    let sendHandle: HandleDescriptor | undefined;
    if (handle) {
      const d = typeof (handle as LibuvStreamWrap)._sendDescriptor === 'function' ? (handle as LibuvStreamWrap)._sendDescriptor() : null;
      if (!d) return errno('EINVAL');
      sendHandle = d;
    }
    if ((this._fd <= 2 || this.#blocking) && !sendHandle) {
      try {
        let off = 0;
        while (off < bytes.length) off += sys<number>('write', { fd: this._fd, pos: null }, bytes.subarray(off));
      } catch (e) {
        return e instanceof SysError ? errno(e.code) : errno('EIO');
      }
    } else {
      let off = 0;
      const entry = { sendHandle } as { sendHandle?: HandleDescriptor };
      if (!this.#queue.length) {
        try {
          off = this.#tryWrite(bytes, entry);
        } catch (e) {
          return e instanceof SysError ? errno(e.code) : errno('EIO');
        }
      }
      if (off < bytes.length) {
        // uv_write: the rest is queued and completes later (req.oncomplete); only such a write
        // has a native WriteWrap (StreamBase::Write tries the write first)
        reqInit(req, 'WRITEWRAP', this);
        this.#queue.push({ req: req as QueuedWrite['req'], data: bytes.slice(off), done: loop.startReq('WriteWrap', req as object), sendHandle: entry.sendHandle });
        this.writeQueueSize += bytes.length - off;
        streamBaseState[kLastWriteWasAsync] = 1;
        if (this.#queue.length === 1) this.#waitWritable();
      }
    }
    this.bytesWritten += bytes.length;
    streamBaseState[kBytesWritten] = bytes.length;
    return 0;
  }

  /** Writes what the kernel buffer takes now; returns the byte count. */
  #tryWrite(bytes: Uint8Array, w: { sendHandle?: HandleDescriptor } = {}): number {
    let off = 0;
    while (off < bytes.length) {
      // a handle goes with the first byte written; the kernel takes such a write whole
      const n = sys<number>('write', w.sendHandle ? { fd: this._fd, pos: null, sendHandle: w.sendHandle } : { fd: this._fd, pos: null, nonblock: true }, bytes.subarray(off));
      if (!(n > 0)) break;
      w.sendHandle = undefined;
      off += n;
    }
    return off;
  }

  #waitWritable() {
    installHandler();
    writers.set(this._fd, this);
    post({ t: 'writeWait', fd: this._fd });
  }

  /** @internal the kernel buffer has room again */
  _onWritable() {
    while (this.#queue.length) {
      const w = this.#queue[0];
      let n: number;
      try {
        n = this.#tryWrite(w.data, w);
      } catch (e) {
        this.#failQueue(e instanceof SysError ? errno(e.code) : errno('EIO'));
        return;
      }
      this.writeQueueSize -= n;
      if (n < w.data.length) {
        w.data = w.data.subarray(n);
        this.#waitWritable();
        return;
      }
      this.#queue.shift();
      w.done();
      completeReq(w.req, 0, this, undefined);
    }
    if (writers.get(this._fd) === this) writers.delete(this._fd);
    this.#runAfterQueue();
  }

  #failQueue(status: number) {
    const q = this.#queue;
    this.#queue = [];
    this.writeQueueSize = 0;
    if (writers.get(this._fd) === this) writers.delete(this._fd);
    for (const w of q) {
      w.done();
      completeReq(w.req, status, this, undefined);
    }
    this.#runAfterQueue();
  }

  #runAfterQueue() {
    const fns = this.#afterQueue;
    this.#afterQueue = [];
    for (const fn of fns) fn();
  }

  writeBuffer(req: unknown, buf: ArrayBufferView, handle?: unknown) {
    if (!ArrayBuffer.isView(buf)) {
      const e = new TypeError('Second argument must be a buffer') as TypeError & { code: string };
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    return this.#write(req, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), handle);
  }
  writev(req: unknown, chunks: unknown[], allBuffers: boolean, handle?: unknown) {
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
    return this.#write(req, all, handle);
  }
  writeUtf8String(req: unknown, s: string, handle?: unknown) {
    return this.#write(req, encode(s, Enc.UTF8), handle);
  }
  writeAsciiString(req: unknown, s: string, handle?: unknown) {
    return this.#write(req, encode(s, Enc.ASCII), handle);
  }
  writeLatin1String(req: unknown, s: string, handle?: unknown) {
    return this.#write(req, encode(s, Enc.LATIN1), handle);
  }
  writeUcs2String(req: unknown, s: string, handle?: unknown) {
    return this.#write(req, encode(s, Enc.UCS2), handle);
  }

  shutdown(req: { oncomplete?: (status: number) => void }) {
    // uv_shutdown waits for the queued writes
    if (this.#queue.length) {
      const done = loop.startReq('ShutdownWrap');
      this.#afterQueue.push(() => {
        done();
        this.shutdown(req);
      });
      return 0;
    }
    let status = 0;
    if (this._fd >= 0 && sys<string | null>('fdKind', { fd: this._fd }) === 'socket') {
      try {
        sys('shutdown', { fd: this._fd });
      } catch (e) {
        status = e instanceof SysError ? errno(e.code) : errno('EINVAL');
      }
    }
    reqInit(req, 'SHUTDOWNWRAP', this);
    const done = loop.startReq('ShutdownWrap');
    loop.macrotask(() => {
      done();
      completeReq(req, status);
    });
    return 0;
  }

  setBlocking(v: boolean) {
    this.#blocking = !!v;
    return 0;
  }

  protected override _onClose() {
    if (this.reading) this.readStop();
    if (readers.get(this._fd) === this) readers.delete(this._fd);
    for (const h of this.#held) if (typeof h.handle?.fd === 'number') closeFd(h.handle.fd);
    this.#held = [];
    if (this.#queue.length) {
      // uv_close cancels the queued writes
      const q = this.#queue;
      this.#queue = [];
      this.writeQueueSize = 0;
      if (writers.get(this._fd) === this) writers.delete(this._fd);
      const canceled = errno('ECANCELED');
      loop.macrotask(() => {
        for (const w of q) {
          w.done();
          completeReq(w.req, canceled, this, undefined);
        }
      });
    }
    this.#afterQueue = [];
    if (this._fd > 2) {
      try {
        sys('close', { fd: this._fd });
      } catch {}
    }
    this._fd = -1;
  }
}

function closeFd(fd: number) {
  try {
    sys('close', { fd });
  } catch {}
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

// Unix domain sockets: bind() makes the socket inode, connections arrive as 'pipe-accept' with a
// new fd (a kernel socketpair, like TCP), keyed by that inode.
const pipeServers = new Map<number, Pipe>();
let pipeAcceptInstalled = false;
function installPipeAccept() {
  if (pipeAcceptInstalled) return;
  pipeAcceptInstalled = true;
  S.kernelHandlers.set('pipe-accept', (msg: { port: number; fd: number }) => {
    const server = pipeServers.get(msg.port);
    if (!server || !server._listening || typeof server.onconnection !== 'function') {
      try {
        sys('close', { fd: msg.fd });
      } catch {}
      return;
    }
    // the client handle is triggered by the server (ConnectionWrap::OnConnection)
    const client = withDefaultTrigger(server, () => new Pipe(0));
    client._setFd(msg.fd);
    loop.scope(server.onconnection, server, 0, client);
  });
}

export class Pipe extends LibuvStreamWrap {
  onconnection: ((err: number, client?: Pipe) => void) | null = null;
  #ino = -1;
  /** @internal */
  _listening = false;

  constructor(public type = 0) {
    super(type === 1 ? 'PipeServerWrap' : 'PipeWrap', false, type === 1 ? 'PIPESERVERWRAP' : 'PIPEWRAP');
  }
  open(fd: number) {
    this._fd = fd;
    return 0;
  }
  /** @internal set by process_wrap when the kernel hands back the parent side of a stdio pipe */
  _setFd(fd: number) {
    this._fd = fd;
  }
  bind(name: string) {
    try {
      this.#ino = sys<number>('unixListen', { p: name });
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('EADDRINUSE');
    }
    installPipeAccept();
    pipeServers.set(this.#ino, this);
    return 0;
  }
  listen(_backlog: number) {
    if (this.#ino < 0) return errno('EINVAL');
    this._listening = true;
    this.setActive(true);
    return 0;
  }
  connect(req: { oncomplete?: (status: number, handle: Pipe, req: unknown, readable: boolean, writable: boolean) => void }, name: string) {
    let status = 0;
    try {
      this._fd = sys<number>('unixConnect', { p: name });
    } catch (e) {
      status = e instanceof SysError ? errno(e.code) : errno('ECONNREFUSED');
    }
    reqInit(req, 'PIPECONNECTWRAP', this);
    // libuv reports the result on a later turn, even failures
    const done = loop.startReq('PipeConnectWrap');
    loop.macrotask(() => {
      done();
      completeReq(req, status, this, req, true, true);
    });
  }
  fchmod() {
    return 0;
  }
  setPendingInstances() {}

  protected override _onClose() {
    if (this.#ino >= 0) {
      pipeServers.delete(this.#ino);
      try {
        sys('unixUnlisten', { ino: this.#ino });
      } catch {}
      this.#ino = -1;
      this._listening = false;
    }
    super._onClose();
  }
}

export class TTY extends LibuvStreamWrap {
  constructor(fd: number, ctx?: Record<string, unknown>) {
    super('TTYWrap', false, 'TTYWRAP');
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

/**
 * A request object lib makes (WriteWrap, ShutdownWrap, …): a plain object until the binding starts
 * a request with it, which makes it an AsyncWrap (reqInit) until the request is done.
 */
export class ReqWrap {
  getAsyncId() {
    return asyncIdOf(this);
  }
}

class WriteWrap extends ReqWrap {
  handle: unknown = null;
  oncomplete: unknown = null;
  async = false;
  bytes = 0;
  buffer: unknown = null;
  callback: unknown = null;
}
class ShutdownWrap extends ReqWrap {
  handle: unknown = null;
  oncomplete: unknown = null;
  callback: unknown = null;
}
class PipeConnectWrap extends ReqWrap {}

export function createStreamWrap() {
  const b = fromShape('stream_wrap');
  streamBaseState = b.streamBaseState;
  return Object.assign(b, { LibuvStreamWrap, WriteWrap, ShutdownWrap });
}

handleFactories.pipe = (d) => {
  const p = new Pipe(d.ipc ? 2 : 0);
  p._setFd(d.fd as number);
  return p;
};

export function createPipeWrap() {
  return Object.assign(fromShape('pipe_wrap'), { Pipe, PipeConnectWrap });
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
