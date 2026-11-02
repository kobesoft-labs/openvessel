// ZstdCompressContext / ZstdDecompressContext from node_zlib.cc, over zstd 1.5.7 (the version
// Node 26.13.0 ships) compiled to wasm by wasm/build.mjs, single-threaded (ZSTD_c_nbWorkers > 0
// is rejected by the library, as in a non-ZSTD_MULTITHREAD build).
//
// Node 26 keeps more state than the library does: the compressor checks the pledged size itself and
// refuses to reset a frame that has partly been written out; the decompressor follows frame
// boundaries so that it can tell further frames from trailing garbage, and a truncated frame from a
// complete one.

import * as zstdWasm from './zstd-wasm.ts';
import { type CompressionContext, type CompressionError, compressionError, InputCache } from './common.ts';
import { cString, Scratch, type WasmExports, wasmLoader } from './wasm.ts';

const loadZstd = wasmLoader(() => zstdWasm);

export const ZSTD_CONTENTSIZE_UNKNOWN = 0xffffffffffffffffn;
const ZSTD_e_continue = 0;
const ZSTD_e_end = 2;
const ZSTD_error_no_error = 0;
const ZSTD_error_GENERIC = 1;
const ZSTD_error_stage_wrong = 60;
const ZSTD_error_srcSize_wrong = 72;
const ZSTD_c_nbWorkers = 400;
const ZSTD_c_jobSize = 401;
const ZSTD_c_overlapLog = 402;
const Z_BUF_ERROR = -5;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// the low nibble of the first byte is free (0x184D2A50..0x184D2A5F, little-endian)
const SKIPPABLE_MAGIC = [0x50, 0x2a, 0x4d, 0x18];

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
const zstdStrerror = (code: number) => ZSTD_ERROR_NAMES[code] ?? 'ZSTD_error_GENERIC';

abstract class ZstdContext implements CompressionContext {
  protected w: WasmExports;
  protected ctx = 0;
  protected flush = ZSTD_e_continue;
  protected error = ZSTD_error_no_error;
  protected errorString = '';
  protected errorCodeString = '';
  protected input: Uint8Array | null = null;
  protected inOff = 0;
  /** input_.size / output_.size */
  protected inLen = 0;
  protected outLen = 0;
  /** input_.pos / output_.pos after the last call */
  protected inPos = 0;
  protected outPos = 0;
  private out: Uint8Array | null = null;
  private outOff = 0;
  private outPtr = 0;
  private ioPtr = 0;
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
    this.inLen = inLen;
    this.out = out;
    this.outOff = outOff;
    this.outLen = outLen;
    this.inPos = 0;
    this.outPos = 0;
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

  /**
   * Puts the buffers from setBuffers into ov_io() as a ZSTD_inBuffer and a ZSTD_outBuffer at
   * position 0. Library calls may follow (the instance is shared, so nothing else may run in
   * between) until end() copies the output out.
   */
  protected begin() {
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
    this.outPtr = this.outBuf.reserve(Math.max(outLen, 1));
    this.ioPtr = w.ov_io();
    new Uint32Array(w.memory.buffer, this.ioPtr, 6).set([inPtr, inLen, 0, this.outPtr, outLen, 0]);
    this.inPos = 0;
    this.outPos = 0;
  }

  /** Reads input_.pos / output_.pos back after a library call. */
  protected readPositions() {
    const io = new Uint32Array(this.w.memory.buffer, this.ioPtr, 6); // memory may have grown
    this.inPos = io[2];
    this.outPos = io[5];
  }

  protected end() {
    this.readPositions();
    if (this.outPos > 0) this.out!.set(new Uint8Array(this.w.memory.buffer, this.outPtr, this.outPos), this.outOff);
    if (this.inPos === this.inLen) this.cache.clear();
  }

  /** Records a library error from a size_t result; true if it was one. */
  protected failed(ret: number): boolean {
    if (!this.w.z_is_error(ret)) return false;
    this.setError(this.w.z_error_code(ret));
    return true;
  }

  protected setError(code: number) {
    this.error = code;
    this.errorCodeString = zstdStrerror(code);
    this.errorString = cString(this.w, this.w.z_error_string(code));
  }

  protected clearError() {
    this.error = ZSTD_error_no_error;
    this.errorString = '';
    this.errorCodeString = '';
  }

  /** A library call's error as a CompressionError (for the reset paths), or null. */
  protected resultError(ret: number): CompressionError | null {
    const w = this.w;
    if (!w.z_is_error(ret)) return null;
    const code = w.z_error_code(ret);
    return compressionError(cString(w, w.z_error_string(code)), zstdStrerror(code), code);
  }

  afterWriteOffsets(): [number, number] {
    return [this.inLen - this.inPos, this.outLen - this.outPos];
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
  abstract init(pledgedSrcSize: bigint, dictionary?: Uint8Array, rejectGarbageAfterEnd?: boolean): CompressionError | null;
  abstract setParameter(key: number, value: number): CompressionError | null;
  abstract work(): void;
  abstract resetStream(): CompressionError | null;
}

export class ZstdCompressContext extends ZstdContext {
  protected destroy(ctx: number) {
    this.w.zc_free(ctx);
  }

  private pledgedSrcSize = ZSTD_CONTENTSIZE_UNKNOWN;
  // Bytes taken into the current frame when a size was pledged, else null. zstd overrides a pledge
  // when the first call already ends the frame, so Node checks the size itself.
  private consumedSrcSize: number | null = null;
  // A frame is complete once ZSTD_e_end has returned 0. Resetting an incomplete frame is refused
  // only once some of it has been written out: those bytes cannot be taken back, and the next frame
  // would follow the fragment. Unflushed state alone is dropped by ZSTD_reset_session_only.
  private frameComplete = true;
  private frameOutputEmitted = false;

  init(pledgedSrcSize: bigint, dictionary?: Uint8Array): CompressionError | null {
    const w = this.w;
    this.pledgedSrcSize = pledgedSrcSize;
    this.frameComplete = true;
    this.frameOutputEmitted = false;
    this.consumedSrcSize = pledgedSrcSize === ZSTD_CONTENTSIZE_UNKNOWN ? null : 0;
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

  // A new frame with the same dictionary, parameters and pledged size (ZSTD_reset_session_only).
  resetStream(): CompressionError | null {
    if (!this.frameComplete && this.frameOutputEmitted) {
      return compressionError(
        'Cannot reset a zstd stream with an incomplete frame; end the frame or discard the output produced so far',
        'ERR_ZLIB_INCOMPLETE_FRAME',
        ZSTD_error_stage_wrong,
      );
    }
    const err = this.resultError(this.w.zc_reset(this.ctx) >>> 0) ?? this.resultError(this.w.zc_pledge(this.ctx, this.pledgedSrcSize) >>> 0);
    if (err) return err;
    this.consumedSrcSize = this.pledgedSrcSize === ZSTD_CONTENTSIZE_UNKNOWN ? null : 0;
    this.frameComplete = true;
    this.frameOutputEmitted = false;
    this.clearError();
    return null;
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
    this.begin();
    const remaining = this.w.zc_stream(this.ctx, this.flush) >>> 0;
    this.end();
    if (this.consumedSrcSize !== null) this.consumedSrcSize += this.inPos;
    if (this.outPos > 0) this.frameOutputEmitted = true;
    if (this.failed(remaining)) {
      this.frameComplete = false;
    } else if (remaining === 0 && this.flush === ZSTD_e_end) {
      this.frameComplete = true;
      this.frameOutputEmitted = false;
      if (this.consumedSrcSize !== null) {
        const consumed = this.consumedSrcSize;
        this.consumedSrcSize = null;
        if (BigInt(consumed) !== this.pledgedSrcSize) this.setError(ZSTD_error_srcSize_wrong);
      }
    } else {
      this.frameComplete = false;
    }
  }
}

export class ZstdDecompressContext extends ZstdContext {
  protected destroy(ctx: number) {
    this.w.zd_free(ctx);
  }

  private frameComplete = false;
  private decodingFrameAfterComplete = false;
  private rejectGarbageAfterEnd = false;
  private ignoringTrailingInput = false;
  // how many bytes of the next frame's magic number have been seen, and which kinds of frame they
  // still match (bit 0: zstd, bit 1: skippable)
  private framePrefixSize = 0;
  private possibleFrameTypes = 0;

  init(_pledgedSrcSize: bigint, dictionary?: Uint8Array, rejectGarbageAfterEnd = false): CompressionError | null {
    const w = this.w;
    this.frameComplete = false;
    this.decodingFrameAfterComplete = false;
    this.rejectGarbageAfterEnd = rejectGarbageAfterEnd;
    this.ignoringTrailingInput = false;
    this.framePrefixSize = 0;
    this.possibleFrameTypes = 0;
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

  // ZSTD_reset_session_only: the dictionary and the parameters stay.
  resetStream(): CompressionError | null {
    const err = this.resultError(this.w.zd_reset(this.ctx) >>> 0);
    if (err) return err;
    this.frameComplete = false;
    this.decodingFrameAfterComplete = false;
    this.ignoringTrailingInput = false;
    this.framePrefixSize = 0;
    this.possibleFrameTypes = 0;
    this.clearError();
    return null;
  }

  setParameter(key: number, value: number): CompressionError | null {
    if (this.w.z_is_error(this.w.zd_set(this.ctx, key, value | 0))) {
      return compressionError('Setting parameter failed', 'ERR_ZSTD_PARAM_SET_FAILED', -1);
    }
    return null;
  }

  work() {
    // Trailing garbage that is ignored stays unconsumed, which zlib.js accepts at the end.
    if (this.ignoringTrailingInput) return;
    // zlib.js retries with an empty input when the previous call filled the output buffer; that is
    // not the start of a new, incomplete frame.
    if (this.frameComplete && this.inLen === 0) return;
    this.begin();
    try {
      this.decompress();
    } finally {
      this.end();
    }
  }

  private decompress() {
    do {
      if (this.frameComplete) {
        this.decodingFrameAfterComplete = true;
        this.framePrefixSize = 0;
        this.possibleFrameTypes = 0b11;
      }
      if (this.decodingFrameAfterComplete && this.framePrefixSize < 4) {
        // Only a zstd or a skippable frame's magic number starts another frame; anything else is
        // trailing garbage.
        let k = 0;
        while (this.framePrefixSize < 4 && this.inPos + k < this.inLen) {
          const index = this.framePrefixSize;
          const byte = this.input![this.inOff + this.inPos + k];
          if (byte !== ZSTD_MAGIC[index]) this.possibleFrameTypes &= ~0b01;
          if ((index === 0 && (byte & 0xf0) !== SKIPPABLE_MAGIC[0]) || (index !== 0 && byte !== SKIPPABLE_MAGIC[index])) {
            this.possibleFrameTypes &= ~0b10;
          }
          this.framePrefixSize++;
          k++;
        }
        if (this.possibleFrameTypes === 0) {
          this.frameComplete = true;
          this.decodingFrameAfterComplete = false;
          if (this.rejectGarbageAfterEnd) {
            this.error = ZSTD_error_GENERIC;
            this.errorCodeString = 'ERR_TRAILING_JUNK_AFTER_STREAM_END';
            this.errorString = 'Trailing junk found after the end of the compressed stream';
          } else {
            this.ignoringTrailingInput = true;
          }
          return;
        }
      }

      const ret = this.w.zd_stream(this.ctx) >>> 0;
      this.readPositions();
      if (this.failed(ret)) {
        this.frameComplete = false;
        return;
      }
      this.frameComplete = ret === 0;
      if (this.frameComplete) this.decodingFrameAfterComplete = false;
    } while (this.frameComplete && this.inPos < this.inLen && this.outPos < this.outLen);
  }

  errorInfo(): CompressionError | null {
    const error = super.errorInfo();
    if (error) return error;
    if (this.flush === ZSTD_e_end && !this.frameComplete && this.inPos === this.inLen && this.outPos < this.outLen) {
      if (this.decodingFrameAfterComplete && this.framePrefixSize < 4) {
        // the input ended inside what may be the magic number of another frame
        if (this.rejectGarbageAfterEnd) {
          return compressionError('Trailing junk found after the end of the compressed stream', 'ERR_TRAILING_JUNK_AFTER_STREAM_END', -1);
        }
        return null;
      }
      return compressionError('unexpected end of file', 'Z_BUF_ERROR', Z_BUF_ERROR);
    }
    return null;
  }
}
