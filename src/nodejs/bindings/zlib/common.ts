// Shared pieces of the zlib binding (node_zlib.cc): mode numbers, error records, the context
// interface every compression library implements, and input caching for the wasm backends.

export const enum Mode {
  NONE = 0,
  DEFLATE = 1,
  INFLATE = 2,
  GZIP = 3,
  GUNZIP = 4,
  DEFLATERAW = 5,
  INFLATERAW = 6,
  UNZIP = 7,
  BROTLI_DECODE = 8,
  BROTLI_ENCODE = 9,
  ZSTD_COMPRESS = 10,
  ZSTD_DECOMPRESS = 11,
}

/** CompressionError: { message, code, err } — reported through handle.onerror(message, err, code). */
export interface CompressionError {
  message: string;
  code: string;
  err: number;
}

export function compressionError(message: string, code: string, err: number): CompressionError {
  return { message, code, err };
}

/** The per-library half of CompressionStream<Context>. */
export interface CompressionContext {
  setBuffers(input: Uint8Array | null, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number): void;
  setFlush(flush: number): void;
  /** DoThreadPoolWork */
  work(): void;
  /** [avail_in, avail_out] */
  afterWriteOffsets(): [number, number];
  errorInfo(): CompressionError | null;
  resetStream(): CompressionError | null;
  close(): void;
}

export function bytesOf(v: ArrayBufferView): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Remembers which JS input range was last copied into wasm memory. zlib.js re-submits the same
 * chunk with an advancing offset until it is consumed, so later calls can reuse the copy instead of
 * copying the remaining input again on every output-buffer refill.
 */
export class InputCache {
  src: Uint8Array | null = null;
  base = 0;
  end = 0;
  ptr = 0;
  /**
   * Returns the wasm pointer for input[off, off+len) if it continues the cached range, else -1.
   * Only a strictly advanced offset counts: a resubmission from the start may be a new write of a
   * buffer whose contents changed in the meantime.
   */
  lookup(src: Uint8Array, off: number, len: number): number {
    if (src === this.src && off > this.base && off + len === this.end) return this.ptr + (off - this.base);
    return -1;
  }
  remember(src: Uint8Array, off: number, len: number, ptr: number) {
    this.src = src;
    this.base = off;
    this.end = off + len;
    this.ptr = ptr;
  }
  clear() {
    this.src = null;
  }
}
