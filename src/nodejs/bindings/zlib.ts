// internalBinding('zlib') — node_zlib.cc in JS.
//
//   Zlib            pako's z_stream port of zlib (byte-identical deflate output to Node's zlib)
//   BrotliEncoder/Decoder   brotli 1.1.0 compiled to wasm (zlib/wasm/build.mjs)
//   ZstdCompress/Decompress zstd 1.5.7 compiled to wasm
//   crc32           table-driven
//
// CompressionStream mirrors the C++ template: write() queues the work and completes it on a later
// macrotask (the libuv threadpool round trip), writeSync() runs it inline; errors go to
// handle.onerror(message, errno, code).

import { macrotask, scope, startReq } from '../loop.ts';
import { fromShape } from './shape.ts';
import { BrotliDecoderContext, BrotliEncoderContext } from './zlib/brotli.ts';
import { bytesOf, type CompressionContext, type CompressionError, Mode } from './zlib/common.ts';
import { ZlibContext } from './zlib/zlib-context.ts';
import { ZSTD_CONTENTSIZE_UNKNOWN, ZstdCompressContext, ZstdDecompressContext } from './zlib/zstd.ts';

const Z_NO_FLUSH = 0;
const Z_BLOCK = 5;

function nodeError(Ctor: ErrorConstructor | TypeErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** A failed CHECK() in node_zlib.cc: Node aborts; we throw. */
function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`internalBinding('zlib'): ${what}`);
}

const isView = (v: unknown): v is ArrayBufferView => ArrayBuffer.isView(v);
// a view's real size (ArrayBufferViewContents), whatever its own `length`/`byteLength` claim
const viewByteLength = (() => {
  const typed = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
  const data = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
  return (v: ArrayBufferView): number => (v instanceof DataView ? data.call(v) : typed.call(v));
})();
const viewByteOffset = (() => {
  const typed = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset')!.get!;
  const data = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
  return (v: ArrayBufferView): number => (v instanceof DataView ? data.call(v) : typed.call(v));
})();
const realBytes = (v: ArrayBufferView) => new Uint8Array(v.buffer, viewByteOffset(v), viewByteLength(v));

// -----------------------------------------------------------------------------
// CompressionStream<Context>

abstract class CompressionStream<C extends CompressionContext> {
  /** set by zlib.js */
  declare onerror: ((message: string, errno: number, code: string) => void) | undefined;
  #ctx: C;
  #initDone = false;
  #writeInProgress = false;
  #pendingClose = false;
  #closed = false;
  #writeResult: Uint32Array | null = null;
  #callback: (() => void) | null = null;

  constructor(ctx: C) {
    this.#ctx = ctx;
  }

  protected get ctx(): C {
    return this.#ctx;
  }

  protected initStream(writeResult: unknown, callback: unknown) {
    check(writeResult instanceof Uint32Array, 'writeResult must be a Uint32Array');
    check(typeof callback === 'function', 'writeCallback must be a function');
    this.#writeResult = writeResult;
    this.#callback = callback as () => void;
    this.#initDone = true;
  }

  close() {
    if (this.#writeInProgress) {
      this.#pendingClose = true;
      return;
    }
    this.#pendingClose = false;
    this.#closed = true;
    check(this.#initDone, 'close before init');
    this.#ctx.close();
  }

  // write(flush, in, in_off, in_len, out, out_off, out_len)
  write(...args: unknown[]) {
    this.#write(true, args);
  }

  writeSync(...args: unknown[]) {
    this.#write(false, args);
  }

  #write(async: boolean, args: unknown[]) {
    check(args.length === 7, 'write() takes 7 arguments');
    check(args[0] !== undefined, 'must provide flush value');
    const flush = Number(args[0]) >>> 0;
    check(flush >= Z_NO_FLUSH && flush <= Z_BLOCK, 'Invalid flush value');

    let input: Uint8Array | null = null;
    let inOff = 0;
    let inLen = 0;
    if (args[1] !== null) {
      check(isView(args[1]), 'in must be a buffer');
      input = realBytes(args[1]);
      inOff = Number(args[2]) >>> 0;
      inLen = Number(args[3]) >>> 0;
      if (inOff + inLen > input.length) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'input buffer is out of bounds');
    }
    check(isView(args[4]), 'out must be a buffer');
    const out = realBytes(args[4]);
    const outOff = Number(args[5]) >>> 0;
    const outLen = Number(args[6]) >>> 0;
    if (outOff + outLen > out.length) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'output buffer is out of bounds');

    check(this.#initDone, 'write before init');
    check(!this.#closed, 'already finalized');
    check(!this.#writeInProgress, 'write already in progress');
    check(!this.#pendingClose, 'close pending');
    this.#writeInProgress = true;

    this.#ctx.setBuffers(input, inOff, inLen, out, outOff, outLen);
    this.#ctx.setFlush(flush);

    if (!async) {
      this.#ctx.work();
      if (this.#checkError(false)) {
        this.#updateWriteResult();
        this.#writeInProgress = false;
      }
      return;
    }

    const done = startReq('ZLIB');
    macrotask(() => {
      // the threadpool part
      try {
        this.#ctx.work();
      } finally {
        done();
      }
      this.#afterWork();
    });
  }

  #afterWork() {
    this.#writeInProgress = false;
    if (!this.#checkError(true)) return;
    this.#updateWriteResult();
    scope(this.#callback!, this);
    if (this.#pendingClose) this.close();
  }

  #updateWriteResult() {
    const [availIn, availOut] = this.#ctx.afterWriteOffsets();
    this.#writeResult![0] = availOut;
    this.#writeResult![1] = availIn;
  }

  #checkError(fromLoop: boolean): boolean {
    const err = this.#ctx.errorInfo();
    if (!err) return true;
    this.emitError(err, fromLoop);
    return false;
  }

  protected emitError(err: CompressionError, fromLoop = false) {
    const fn = this.onerror;
    if (typeof fn === 'function') {
      if (fromLoop) scope(fn, this, err.message, err.err, err.code);
      else fn.call(this, err.message, err.err, err.code);
    }
    // no hope of rescue
    this.#writeInProgress = false;
    if (this.#pendingClose) this.close();
  }

  reset() {
    // the threadpool may be using the stream's state
    if (this.#writeInProgress) throw new Error('Cannot reset zlib stream while a write is in progress');
    const err = this.#ctx.resetStream();
    if (err) this.emitError(err);
  }

  abstract init(...args: unknown[]): void;
  abstract params(...args: unknown[]): void;
}

// -----------------------------------------------------------------------------
// Zlib

class Zlib extends CompressionStream<ZlibContext> {
  constructor(mode: unknown) {
    check(Number.isInteger(mode) && (mode as number) >= -0x80000000 && (mode as number) <= 0x7fffffff, 'mode must be an int32');
    super(new ZlibContext(mode as Mode));
  }

  // init(windowBits, level, memLevel, strategy, writeResult, writeCallback, dictionary)
  init(...args: unknown[]) {
    if (args.length === 5) {
      console.error(
        'WARNING: You are likely using a version of node-tar or npm that ' +
          'is incompatible with this version of Node.js.\nPlease use ' +
          'either the version of npm that is bundled with Node.js, or ' +
          'a version of npm (> 5.5.1 or < 5.4.0) or node-tar (> 4.0.1) ' +
          'that is compatible with Node.js 9 and above.',
      );
    }
    check(args.length === 7, 'init(windowBits, level, memLevel, strategy, writeResult, writeCallback, dictionary)');
    const windowBits = Number(args[0]) >>> 0;
    const level = Number(args[1]) | 0;
    const memLevel = Number(args[2]) >>> 0;
    const strategy = Number(args[3]) >>> 0;
    const dict = isView(args[6]) ? bytesOf(args[6]).slice() : new Uint8Array(0);
    this.initStream(args[4], args[5]);
    this.ctx.init(level, windowBits, memLevel, strategy, dict);
  }

  params(...args: unknown[]) {
    check(args.length === 2, 'params(level, strategy)');
    const err = this.ctx.setParams(Number(args[0]) | 0, Number(args[1]) | 0);
    if (err) this.emitError(err);
  }
}

// -----------------------------------------------------------------------------
// Brotli

abstract class BrotliStream<C extends BrotliEncoderContext | BrotliDecoderContext> extends CompressionStream<C> {
  // init(params, writeResult, writeCallback)
  init(...args: unknown[]) {
    check(args.length === 3, 'init(params, writeResult, writeCallback)');
    this.initStream(args[1], args[2]);
    let err = this.ctx.init();
    if (err) {
      this.emitError(err);
      throw nodeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
    }
    check(args[0] instanceof Uint32Array, 'params must be a Uint32Array');
    const data = args[0];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xffffffff) continue;
      err = this.ctx.setParams(i, data[i]);
      if (err) {
        this.emitError(err);
        throw nodeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
      }
    }
  }

  // Currently a no-op, and not accessed from JS land (as in Node).
  params() {}
}

const checkMode = (mode: unknown) => check(Number.isInteger(mode), 'mode must be an int32');

class BrotliEncoder extends BrotliStream<BrotliEncoderContext> {
  constructor(mode: unknown) {
    checkMode(mode);
    super(new BrotliEncoderContext(mode as Mode));
  }
}

class BrotliDecoder extends BrotliStream<BrotliDecoderContext> {
  constructor(mode: unknown) {
    checkMode(mode);
    super(new BrotliDecoderContext(mode as Mode));
  }
}

// -----------------------------------------------------------------------------
// Zstd

abstract class ZstdStream<C extends ZstdCompressContext | ZstdDecompressContext> extends CompressionStream<C> {
  // init(params, pledgedSrcSize, writeResult, writeCallback[, dictionary])
  init(...args: unknown[]) {
    check(args.length === 4 || args.length === 5, 'init(params, pledgedSrcSize, writeResult, writeCallback[, dictionary])');
    this.initStream(args[2], args[3]);

    let pledged = ZSTD_CONTENTSIZE_UNKNOWN;
    if (typeof args[1] === 'number') {
      const n = Number.isFinite(args[1]) ? Math.trunc(args[1]) : Number.isNaN(args[1]) ? 0 : args[1] > 0 ? 2 ** 63 - 1 : -(2 ** 63);
      if (n < 0) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'pledgedSrcSize may not be negative');
      pledged = BigInt(Math.min(n, 2 ** 63 - 1));
    }

    let dictionary: Uint8Array | undefined;
    if (args.length === 5 && args[4] !== undefined) {
      if (!isView(args[4])) throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'dictionary must be an ArrayBufferView if provided');
      dictionary = bytesOf(args[4]);
    }

    const err = this.ctx.init(pledged, dictionary);
    if (err) {
      this.emitError(err);
      throw nodeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', err.message);
    }

    check(args[0] instanceof Uint32Array, 'params must be a Uint32Array');
    const data = args[0];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xffffffff) continue;
      const e = this.ctx.setParameter(i, data[i] | 0);
      if (e) {
        this.emitError(e);
        throw nodeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', e.message);
      }
    }
  }

  // Currently a no-op, and not accessed from JS land (as in Node).
  params() {}
}

class ZstdCompress extends ZstdStream<ZstdCompressContext> {
  constructor() {
    super(new ZstdCompressContext());
  }
}

class ZstdDecompress extends ZstdStream<ZstdDecompressContext> {
  constructor() {
    super(new ZstdDecompressContext());
  }
}

// -----------------------------------------------------------------------------
// crc32

let crcTable: Uint32Array | null = null;
function makeCrcTable(): Uint32Array {
  // slicing-by-4 tables
  const t = new Uint32Array(1024);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 4; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
}

export function crc32Update(crc: number, buf: Uint8Array): number {
  const t = (crcTable ??= makeCrcTable());
  let c = ~crc >>> 0;
  let i = 0;
  const n = buf.length;
  const n4 = n - (n & 3);
  for (; i < n4; i += 4) {
    c ^= buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    c = t[768 + (c & 0xff)] ^ t[512 + ((c >>> 8) & 0xff)] ^ t[256 + ((c >>> 16) & 0xff)] ^ t[c >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Created at load time: Node's bootstrap later replaces the TextEncoder global with its own.
const utf8 = new TextEncoder();

function crc32(data: unknown, value: unknown): number {
  check(isView(data) || typeof data === 'string', 'data must be an ArrayBufferView or a string');
  check(typeof value === 'number' && value >>> 0 === value, 'value must be a uint32');
  const bytes = typeof data === 'string' ? utf8.encode(data) : bytesOf(data as ArrayBufferView);
  return crc32Update(value as number, bytes);
}

// -----------------------------------------------------------------------------

export function createZlib() {
  return Object.assign(fromShape('zlib'), {
    Zlib,
    BrotliEncoder,
    BrotliDecoder,
    ZstdCompress,
    ZstdDecompress,
    crc32,
  });
}
