// BrotliEncoderContext / BrotliDecoderContext from node_zlib.cc, over Google's brotli 1.1.0 (the
// version Node 22.20.0 ships) compiled to wasm by wasm/build.mjs. All encoder/decoder parameters
// are passed straight to BrotliEncoderSetParameter / BrotliDecoderSetParameter.

import * as brotliWasm from './brotli-wasm.ts';
import { type CompressionContext, type CompressionError, compressionError, InputCache, Mode } from './common.ts';
import { cString, Scratch, type WasmExports, wasmLoader } from './wasm.ts';

const loadBrotli = wasmLoader(() => brotliWasm);

const BROTLI_OPERATION_PROCESS = 0;
const BROTLI_OPERATION_FINISH = 2;
const BROTLI_DECODER_RESULT_ERROR = 0;
const BROTLI_DECODER_RESULT_SUCCESS = 1;
const BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT = 2;
const BROTLI_DECODER_NO_ERROR = 0;
const Z_BUF_ERROR = -5;

abstract class BrotliContext implements CompressionContext {
  protected w: WasmExports | null = null;
  protected state = 0;
  protected flush = BROTLI_OPERATION_PROCESS;
  protected availIn = 0;
  protected availOut = 0;
  private input: Uint8Array | null = null;
  private inOff = 0;
  private out: Uint8Array | null = null;
  private outOff = 0;
  private inBuf!: Scratch;
  private outBuf!: Scratch;
  private cache = new InputCache();

  constructor(protected mode: Mode) {}

  protected wasm(): WasmExports {
    if (!this.w) {
      this.w = loadBrotli();
      this.inBuf = new Scratch(this.w);
      this.outBuf = new Scratch(this.w);
    }
    return this.w;
  }

  setBuffers(input: Uint8Array | null, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) {
    this.input = input;
    this.inOff = inOff;
    this.availIn = inLen;
    this.out = out;
    this.outOff = outOff;
    this.availOut = outLen;
  }

  setFlush(flush: number) {
    this.flush = flush;
  }

  /** Runs one streaming call with the buffers from setBuffers; returns its result code. */
  protected stream(call: (io: Uint32Array) => number): number {
    const w = this.wasm();
    const inLen = this.availIn;
    const outLen = this.availOut;
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
    let io = new Uint32Array(w.memory.buffer, ioPtr, 4);
    io[0] = inLen;
    io[1] = inPtr;
    io[2] = outLen;
    io[3] = outPtr;
    const r = call(io);
    io = new Uint32Array(w.memory.buffer, ioPtr, 4); // memory may have grown
    this.availIn = io[0];
    this.availOut = io[2];
    const produced = outLen - this.availOut;
    if (produced > 0) this.out!.set(new Uint8Array(w.memory.buffer, outPtr, produced), this.outOff);
    if (this.availIn === 0) this.cache.clear();
    return r;
  }

  afterWriteOffsets(): [number, number] {
    return [this.availIn, this.availOut];
  }

  abstract init(): CompressionError | null;
  abstract setParams(key: number, value: number): CompressionError | null;
  abstract work(): void;
  abstract errorInfo(): CompressionError | null;
  abstract close(): void;

  resetStream(): CompressionError | null {
    return this.init();
  }
}

export class BrotliEncoderContext extends BrotliContext {
  private lastResult = false;

  init(): CompressionError | null {
    const w = this.wasm();
    if (this.state) w.enc_destroy(this.state);
    this.state = w.enc_create();
    if (!this.state) return compressionError('Could not initialize Brotli instance', 'ERR_ZLIB_INITIALIZATION_FAILED', -1);
    return null;
  }

  setParams(key: number, value: number): CompressionError | null {
    if (!this.wasm().enc_set(this.state, key, value >>> 0)) return compressionError('Setting parameter failed', 'ERR_BROTLI_PARAM_SET_FAILED', -1);
    return null;
  }

  work() {
    if (this.mode !== Mode.BROTLI_ENCODE || !this.state) throw new Error('brotli encoder not initialized');
    this.lastResult = this.stream(() => this.w!.enc_stream(this.state, this.flush)) !== 0;
  }

  errorInfo(): CompressionError | null {
    if (!this.lastResult) return compressionError('Compression failed', 'ERR_BROTLI_COMPRESSION_FAILED', -1);
    return null;
  }

  close() {
    if (this.state) this.w!.enc_destroy(this.state);
    this.state = 0;
    this.mode = Mode.NONE;
  }
}

export class BrotliDecoderContext extends BrotliContext {
  private lastResult = BROTLI_DECODER_RESULT_SUCCESS;
  private error = BROTLI_DECODER_NO_ERROR;
  private errorString = '';

  init(): CompressionError | null {
    const w = this.wasm();
    if (this.state) w.dec_destroy(this.state);
    this.state = w.dec_create();
    if (!this.state) return compressionError('Could not initialize Brotli instance', 'ERR_ZLIB_INITIALIZATION_FAILED', -1);
    return null;
  }

  setParams(key: number, value: number): CompressionError | null {
    if (!this.wasm().dec_set(this.state, key, value >>> 0)) return compressionError('Setting parameter failed', 'ERR_BROTLI_PARAM_SET_FAILED', -1);
    return null;
  }

  work() {
    if (this.mode !== Mode.BROTLI_DECODE || !this.state) throw new Error('brotli decoder not initialized');
    const w = this.w!;
    this.lastResult = this.stream(() => w.dec_stream(this.state));
    if (this.lastResult === BROTLI_DECODER_RESULT_ERROR) {
      this.error = w.dec_error_code(this.state);
      this.errorString = 'ERR_' + cString(w, w.dec_error_string(this.error));
    }
  }

  errorInfo(): CompressionError | null {
    if (this.error !== BROTLI_DECODER_NO_ERROR) return compressionError('Decompression failed', this.errorString, this.error);
    if (this.flush === BROTLI_OPERATION_FINISH && this.lastResult === BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
      // Match zlib's behaviour, as brotli doesn't have its own code for this.
      return compressionError('unexpected end of file', 'Z_BUF_ERROR', Z_BUF_ERROR);
    }
    return null;
  }

  close() {
    if (this.state) this.w!.dec_destroy(this.state);
    this.state = 0;
    this.mode = Mode.NONE;
  }
}
