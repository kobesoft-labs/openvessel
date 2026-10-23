// node:zlib on top of fflate (pure JS).

import { Buffer } from 'buffer';
import * as f from 'fflate';
import { Transform } from './stream.ts';

export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_BUF_ERROR: -5,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4865,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_PARAM_SIZE_HINT: 5,
};
export const codes = { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6 };

function bytes(data: any): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer.');
}

const buf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
const lvl = (o: any) => (o?.level === undefined || o.level < 0 ? 6 : o.level) as any;

function zerr(e: any): Error {
  const err = new Error(e?.message ?? 'zlib error') as Error & { code: string; errno: number };
  err.code = 'Z_DATA_ERROR';
  err.errno = -3;
  return err;
}

function wrap(fn: (d: Uint8Array, o: any) => Uint8Array) {
  return (data: any, opts?: any) => {
    try {
      return buf(fn(bytes(data), opts));
    } catch (e) {
      throw zerr(e);
    }
  };
}

export const gzipSync = wrap((d, o) => f.gzipSync(d, { level: lvl(o) }));
export const gunzipSync = wrap((d) => f.gunzipSync(d));
export const deflateSync = wrap((d, o) => f.zlibSync(d, { level: lvl(o) }));
export const inflateSync = wrap((d) => f.unzlibSync(d));
export const deflateRawSync = wrap((d, o) => f.deflateSync(d, { level: lvl(o) }));
export const inflateRawSync = wrap((d) => f.inflateSync(d));
export const unzipSync = wrap((d) => (d[0] === 0x1f && d[1] === 0x8b ? f.gunzipSync(d) : f.unzlibSync(d)));

function brotliUnsupported(): never {
  const e = new Error('Brotli is not supported in OpenVessel') as Error & { code: string };
  e.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
  throw e;
}
export const brotliCompressSync = (_d: any, _o?: any) => brotliUnsupported();
export const brotliDecompressSync = (_d: any, _o?: any) => brotliUnsupported();
export const zstdCompressSync = brotliCompressSync;
export const zstdDecompressSync = brotliDecompressSync;

function asyncify(fn: (d: any, o?: any) => Buffer) {
  return (data: any, opts?: any, cb?: any) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = undefined;
    }
    let r: Buffer;
    try {
      r = fn(data, opts);
    } catch (e) {
      setTimeout(() => cb(e), 0);
      return;
    }
    setTimeout(() => cb(null, r), 0);
  };
}

export const gzip = asyncify(gzipSync);
export const gunzip = asyncify(gunzipSync);
export const deflate = asyncify(deflateSync);
export const inflate = asyncify(inflateSync);
export const deflateRaw = asyncify(deflateRawSync);
export const inflateRaw = asyncify(inflateRawSync);
export const unzip = asyncify(unzipSync);
export const brotliCompress = asyncify(brotliCompressSync);
export const brotliDecompress = asyncify(brotliDecompressSync);

class ZStream extends (Transform as any) {
  private s: any;
  bytesWritten = 0;
  constructor(make: (push: (d: Uint8Array, final: boolean) => void) => any, opts?: any) {
    super(opts);
    this.s = make((d, _final) => {
      if (d && d.length) (this as any).push(buf(d));
    });
  }
  _transform(chunk: any, _enc: any, cb: (e?: Error | null) => void) {
    try {
      const b = bytes(chunk);
      this.bytesWritten += b.length;
      this.s.push(b, false);
      cb();
    } catch (e) {
      cb(zerr(e));
    }
  }
  _flush(cb: (e?: Error | null) => void) {
    try {
      this.s.push(new Uint8Array(0), true);
      cb();
    } catch (e) {
      cb(zerr(e));
    }
  }
  flush(_kind?: any, cb?: () => void) {
    cb?.();
  }
  params(_l: number, _s: number, cb?: () => void) {
    cb?.();
  }
  reset() {}
  close(cb?: () => void) {
    (this as any).destroy();
    cb?.();
  }
}

const mk = (Cls: any, o?: any) => (push: (d: Uint8Array, final: boolean) => void) => {
  const s = o ? new Cls(o) : new Cls();
  s.ondata = (d: Uint8Array, final: boolean) => push(d, final);
  return s;
};

export class Gzip extends ZStream {
  constructor(o?: any) {
    super(mk(f.Gzip, { level: lvl(o) }), o);
  }
}
export class Gunzip extends ZStream {
  constructor(o?: any) {
    super(mk(f.Gunzip), o);
  }
}
export class Deflate extends ZStream {
  constructor(o?: any) {
    super(mk(f.Zlib, { level: lvl(o) }), o);
  }
}
export class Inflate extends ZStream {
  constructor(o?: any) {
    super(mk(f.Unzlib), o);
  }
}
export class DeflateRaw extends ZStream {
  constructor(o?: any) {
    super(mk(f.Deflate, { level: lvl(o) }), o);
  }
}
export class InflateRaw extends ZStream {
  constructor(o?: any) {
    super(mk(f.Inflate), o);
  }
}
export class Unzip extends ZStream {
  constructor(o?: any) {
    super(mk(f.Decompress), o);
  }
}
export class BrotliCompress extends ZStream {
  constructor(o?: any) {
    super(() => brotliUnsupported(), o);
  }
}
export class BrotliDecompress extends BrotliCompress {}

export const createGzip = (o?: any) => new Gzip(o);
export const createGunzip = (o?: any) => new Gunzip(o);
export const createDeflate = (o?: any) => new Deflate(o);
export const createInflate = (o?: any) => new Inflate(o);
export const createDeflateRaw = (o?: any) => new DeflateRaw(o);
export const createInflateRaw = (o?: any) => new InflateRaw(o);
export const createUnzip = (o?: any) => new Unzip(o);
export const createBrotliCompress = (o?: any) => new BrotliCompress(o);
export const createBrotliDecompress = (o?: any) => new BrotliDecompress(o);

let crcTable: Uint32Array | null = null;
export function crc32(data: any, value = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const d = bytes(data);
  let c = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export default {
  constants, codes, crc32, gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, unzipSync, brotliCompressSync, brotliDecompressSync, zstdCompressSync, zstdDecompressSync,
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip, brotliCompress, brotliDecompress, Gzip, Gunzip, Deflate, Inflate, DeflateRaw, InflateRaw, Unzip, BrotliCompress, BrotliDecompress,
  createGzip, createGunzip, createDeflate, createInflate, createDeflateRaw, createInflateRaw, createUnzip, createBrotliCompress, createBrotliDecompress,
};
