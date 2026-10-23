// ZstdCompressContext / ZstdDecompressContext from node_zlib.cc, over zstd 1.5.7 (the version
// Node 22.20.0 ships) compiled to wasm by wasm/build.mjs, single-threaded (ZSTD_c_nbWorkers > 0
// is rejected by the library, as in a non-ZSTD_MULTITHREAD build).

import * as zstdWasm from './zstd-wasm.ts';
import { type CompressionContext, type CompressionError, compressionError, InputCache } from './common.ts';
import { cString, Scratch, type WasmExports, wasmLoader } from './wasm.ts';

const loadZstd = wasmLoader(() => zstdWasm);

export const ZSTD_CONTENTSIZE_UNKNOWN = 0xffffffffffffffffn;
const ZSTD_e_continue = 0;
const ZSTD_error_no_error = 0;
const ZSTD_c_nbWorkers = 400;
const ZSTD_c_jobSize = 401;
const ZSTD_c_overlapLog = 402;

// ZstdStrerror(): the names Node knows; anything else is reported as ZSTD_error_GENERIC.
const ZSTD_ERROR_NAMES: Record<number, string> = {
  0: 'ZSTD_error_no_error',
  1: 'ZSTD_error_GENERIC',
  10: 'ZSTD_error_prefix_unknown',
  12: 'ZSTD_error_version_unsupported',
  14: 'ZSTD_error_frameParameter_unsupported',
  16: 'ZSTD_error_frameParameter_windowTooLarge',
  20: 'ZSTD_error_corruption_detected',
  22: 'ZSTD_error_checksum_wrong',
  24: 'ZSTD_error_literals_headerWrong',
  30: 'ZSTD_error_dictionary_corrupted',
  32: 'ZSTD_error_dictionary_wrong',
  34: 'ZSTD_error_dictionaryCreation_failed',
  40: 'ZSTD_error_parameter_unsupported',
  41: 'ZSTD_error_parameter_combination_unsupported',
  42: 'ZSTD_error_parameter_outOfBound',
  44: 'ZSTD_error_tableLog_tooLarge',
  46: 'ZSTD_error_maxSymbolValue_tooLarge',
  48: 'ZSTD_error_maxSymbolValue_tooSmall',
  50: 'ZSTD_error_stabilityCondition_notRespected',
  60: 'ZSTD_error_stage_wrong',
  62: 'ZSTD_error_init_missing',
  64: 'ZSTD_error_memory_allocation',
  66: 'ZSTD_error_workSpace_tooSmall',
  70: 'ZSTD_error_dstSize_tooSmall',
  72: 'ZSTD_error_srcSize_wrong',
  74: 'ZSTD_error_dstBuffer_null',
  80: 'ZSTD_error_noForwardProgress_destFull',
  82: 'ZSTD_error_noForwardProgress_inputEmpty',
};

abstract class ZstdContext implements CompressionContext {
  protected w: WasmExports;
  protected ctx = 0;
  protected flush = ZSTD_e_continue;
  protected error = ZSTD_error_no_error;
  private errorString = '';
  private errorCodeString = '';
  private input: Uint8Array | null = null;
  private inOff = 0;
  private inLen = 0;
  private out: Uint8Array | null = null;
  private outOff = 0;
  private outLen = 0;
  private availIn = 0;
  private availOut = 0;
  private inBuf: Scratch;
  private outBuf: Scratch;
  private cache = new InputCache();

  constructor() {
    this.w = loadZstd();
    this.inBuf = new Scratch(this.w);
    this.outBuf = new Scratch(this.w);
  }

  setBuffers(input: Uint8Array | null, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) {
    this.input = input;
    this.inOff = inOff;
    this.inLen = this.availIn = inLen;
    this.out = out;
    this.outOff = outOff;
    this.outLen = this.availOut = outLen;
  }

  setFlush(flush: number) {
    this.flush = flush;
  }

  /** Copies a dictionary into the instance; the pointer stays valid until the next call. */
  protected copyIn(bytes: Uint8Array): number {
    const cap = this.inBuf.cap;
    const p = this.inBuf.reserve(Math.max(bytes.length, 1));
    if (this.inBuf.cap !== cap) this.cache.clear();
    this.cache.clear();
    new Uint8Array(this.w.memory.buffer, p, bytes.length).set(bytes);
    return p;
  }

  protected stream(call: () => number) {
    const w = this.w;
    const inLen = this.inLen;
    const outLen = this.outLen;
    let inPtr = 0;
    if (inLen > 0 && this.input) {
      inPtr = this.cache.lookup(this.input, this.inOff, inLen);
      if (inPtr < 0) {
        const cap = this.inBuf.cap;
        inPtr = this.inBuf.reserve(inLen);
        if (this.inBuf.cap !== cap) this.cache.clear();
        new Uint8Array(w.memory.buffer, inPtr, inLen).set(this.input.subarray(this.inOff, this.inOff + inLen));
        this.cache.remember(this.input, this.inOff, inLen, inPtr);
      }
    }
    const outPtr = this.outBuf.reserve(Math.max(outLen, 1));
    const ioPtr = w.ov_io();
    let io = new Uint32Array(w.memory.buffer, ioPtr, 6);
    io.set([inPtr, inLen, 0, outPtr, outLen, 0]);
    const ret = call() >>> 0;
    io = new Uint32Array(w.memory.buffer, ioPtr, 6); // memory may have grown
    this.availIn = io[1] - io[2];
    this.availOut = io[4] - io[5];
    const produced = io[5];
    if (produced > 0) this.out!.set(new Uint8Array(w.memory.buffer, outPtr, produced), this.outOff);
    if (this.availIn === 0) this.cache.clear();
    if (w.z_is_error(ret)) {
      this.error = w.z_error_code(ret);
      this.errorCodeString = ZSTD_ERROR_NAMES[this.error] ?? 'ZSTD_error_GENERIC';
      this.errorString = cString(w, w.z_error_string(this.error));
    }
  }

  afterWriteOffsets(): [number, number] {
    return [this.availIn, this.availOut];
  }

  errorInfo(): CompressionError | null {
    if (this.error !== ZSTD_error_no_error) return compressionError(this.errorString, this.errorCodeString, this.error);
    return null;
  }

  #closed = false;
  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.ctx) this.destroy(this.ctx);
    this.ctx = 0;
    this.inBuf.release();
    this.outBuf.release();
    this.cache.clear();
    loadZstd.release(this.w);
  }

  protected abstract destroy(ctx: number): void;
  abstract init(pledgedSrcSize: bigint, dictionary?: Uint8Array): CompressionError | null;
  abstract setParameter(key: number, value: number): CompressionError | null;
  abstract work(): void;
  abstract resetStream(): CompressionError | null;
}

export class ZstdCompressContext extends ZstdContext {
  protected destroy(ctx: number) {
    this.w.zc_free(ctx);
  }

  private pledgedSrcSize = ZSTD_CONTENTSIZE_UNKNOWN;

  init(pledgedSrcSize: bigint, dictionary?: Uint8Array): CompressionError | null {
    const w = this.w;
    this.pledgedSrcSize = pledgedSrcSize;
    if (this.ctx) w.zc_free(this.ctx);
    this.ctx = w.zc_create();
    if (!this.ctx) return compressionError('Could not initialize zstd instance', 'ERR_ZLIB_INITIALIZATION_FAILED', -1);
    if (dictionary?.length) {
      const p = this.copyIn(dictionary);
      if (w.z_is_error(w.zc_load_dict(this.ctx, p, dictionary.length))) {
        return compressionError('Failed to load zstd dictionary', 'ERR_ZLIB_DICTIONARY_LOAD_FAILED', -1);
      }
    }
    if (w.z_is_error(w.zc_pledge(this.ctx, pledgedSrcSize))) {
      return compressionError('Could not set pledged src size', 'ERR_ZLIB_INITIALIZATION_FAILED', -1);
    }
    return null;
  }

  // Like Node, a reset drops the dictionary and the parameters.
  resetStream(): CompressionError | null {
    return this.init(this.pledgedSrcSize);
  }

  setParameter(key: number, value: number): CompressionError | null {
    // Node's zstd is built with ZSTD_MULTITHREAD, where these are accepted (and clamped). The wasm
    // build has no threads, so accept and ignore them: compression stays single-threaded. Inputs
    // larger than a job (512 KiB+) may then produce different (equally valid) frames than Node.
    if (key === ZSTD_c_nbWorkers || key === ZSTD_c_jobSize || key === ZSTD_c_overlapLog) return null;
    if (this.w.z_is_error(this.w.zc_set(this.ctx, key, value | 0))) {
      return compressionError('Setting parameter failed', 'ERR_ZSTD_PARAM_SET_FAILED', -1);
    }
    return null;
  }

  work() {
    this.stream(() => this.w.zc_stream(this.ctx, this.flush));
  }
}

export class ZstdDecompressContext extends ZstdContext {
  protected destroy(ctx: number) {
    this.w.zd_free(ctx);
  }

  init(_pledgedSrcSize: bigint, dictionary?: Uint8Array): CompressionError | null {
    const w = this.w;
    if (this.ctx) w.zd_free(this.ctx);
    this.ctx = w.zd_create();
    if (!this.ctx) return compressionError('Could not initialize zstd instance', 'ERR_ZLIB_INITIALIZATION_FAILED', -1);
    if (dictionary?.length) {
      const p = this.copyIn(dictionary);
      if (w.z_is_error(w.zd_load_dict(this.ctx, p, dictionary.length))) {
        return compressionError('Failed to load zstd dictionary', 'ERR_ZLIB_DICTIONARY_LOAD_FAILED', -1);
      }
    }
    return null;
  }

  resetStream(): CompressionError | null {
    return this.init(ZSTD_CONTENTSIZE_UNKNOWN);
  }

  setParameter(key: number, value: number): CompressionError | null {
    if (this.w.z_is_error(this.w.zd_set(this.ctx, key, value | 0))) {
      return compressionError('Setting parameter failed', 'ERR_ZSTD_PARAM_SET_FAILED', -1);
    }
    return null;
  }

  work() {
    this.stream(() => this.w.zd_stream(this.ctx));
  }
}
