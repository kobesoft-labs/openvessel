// ZlibContext from node_zlib.cc on top of pako's port of zlib's z_stream API. pako 3 defaults to
// the hash that Node's (Chromium's) zlib uses, so deflate output is byte-identical to Node's.

import {
  ZStream,
  zlibDeflate,
  zlibDeflateEnd,
  zlibDeflateInit2,
  zlibDeflateReset,
  zlibDeflateSetDictionary,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
  zlibInflateReset,
  zlibInflateSetDictionary,
} from 'pako';
import { type CompressionContext, type CompressionError, compressionError, Mode } from './common.ts';

const Z_NO_FLUSH = 0;
const Z_FINISH = 4;
const Z_BLOCK = 5;
const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_NEED_DICT = 2;
const Z_STREAM_ERROR = -2;
const Z_DATA_ERROR = -3;
const Z_BUF_ERROR = -5;
const Z_DEFAULT_STRATEGY = 0;
const Z_FILTERED = 1;
const Z_HUFFMAN_ONLY = 2;
const Z_RLE = 3;
const Z_FIXED = 4;
const Z_DEFLATED = 8;

const GZIP_HEADER_ID1 = 0x1f;
const GZIP_HEADER_ID2 = 0x8b;

const ERROR_NAMES: Record<number, string> = {
  0: 'Z_OK',
  1: 'Z_STREAM_END',
  2: 'Z_NEED_DICT',
  [-1]: 'Z_ERRNO',
  [-2]: 'Z_STREAM_ERROR',
  [-3]: 'Z_DATA_ERROR',
  [-4]: 'Z_MEM_ERROR',
  [-5]: 'Z_BUF_ERROR',
  [-6]: 'Z_VERSION_ERROR',
};
const zlibStrerror = (err: number) => ERROR_NAMES[err] ?? 'Z_UNKNOWN_ERROR';

const EMPTY = new Uint8Array(0);

// -----------------------------------------------------------------------------
// zlib's flush_pending() starts with _tr_flush_bits(), moving whole bytes of the bit buffer into
// the pending output; pako's does not, so those bytes come out one call later than with zlib
// (visible after Z_BLOCK, or a block emitted mid-stream). Every zlib return path that sent bits
// ends in flush_pending(), so doing that step after each call restores zlib's output timing.

function deflate(strm: any, flush: number): number {
  const r = zlibDeflate(strm, flush as any);
  if (r === Z_OK || r === Z_BUF_ERROR || r === Z_STREAM_END) {
    const s = strm.state;
    if (s && s.bi_valid >= 8) {
      // Unsent pending bytes start at pending_out (zlib flushes the bits before sending them).
      const at = s.pending_out + s.pending;
      if (s.bi_valid === 16) {
        s.pending_buf[at] = s.bi_buf & 0xff;
        s.pending_buf[at + 1] = (s.bi_buf >>> 8) & 0xff;
        s.pending += 2;
        s.bi_buf = 0;
        s.bi_valid = 0;
      } else {
        s.pending_buf[at] = s.bi_buf & 0xff;
        s.pending++;
        s.bi_buf >>= 8;
        s.bi_valid -= 8;
      }
      const len = Math.min(s.pending, strm.avail_out);
      if (len > 0) {
        strm.output.set(s.pending_buf.subarray(s.pending_out, s.pending_out + len), strm.next_out);
        strm.next_out += len;
        s.pending_out += len;
        strm.total_out += len;
        strm.avail_out -= len;
        s.pending -= len;
        if (s.pending === 0) s.pending_out = 0;
      }
      if (strm.avail_out === 0) s.last_flush = -1;
    }
  }
  return r;
}

// -----------------------------------------------------------------------------
// deflateParams (pako has none): zlib 1.3.1's, operating on pako's deflate state.

// configuration_table: [good_length, max_lazy, nice_length, max_chain, func] where func is
// 0 = deflate_stored, 1 = deflate_fast, 2 = deflate_slow.
const CONFIG: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 0],
  [4, 4, 8, 4, 1],
  [4, 5, 16, 8, 1],
  [4, 6, 32, 32, 1],
  [4, 4, 16, 16, 2],
  [8, 16, 32, 32, 2],
  [8, 16, 128, 128, 2],
  [8, 32, 128, 256, 2],
  [32, 128, 258, 1024, 2],
  [32, 258, 258, 4096, 2],
];

function slideHash(s: any) {
  const wsize = s.w_size;
  for (let p = 0; p < s.hash_size; p++) {
    const m = s.head[p];
    s.head[p] = m >= wsize ? m - wsize : 0;
  }
  for (let p = 0; p < wsize; p++) {
    const m = s.prev[p];
    s.prev[p] = m >= wsize ? m - wsize : 0;
  }
}

export function deflateParams(strm: any, level: number, strategy: number): number {
  const s = strm?.state;
  if (!s || s.strm !== strm) return Z_STREAM_ERROR;
  if (level === -1) level = 6;
  if (level < 0 || level > 9 || strategy < 0 || strategy > Z_FIXED) return Z_STREAM_ERROR;
  const func = CONFIG[s.level][4];
  if ((strategy !== s.strategy || func !== CONFIG[level][4]) && s.last_flush !== -2) {
    // Flush the last buffer
    const err = deflate(strm, Z_BLOCK);
    if (err === Z_STREAM_ERROR) return err;
    if (strm.avail_in || s.strstart - s.block_start + s.lookahead) return Z_BUF_ERROR;
  }
  if (s.level !== level) {
    if (s.level === 0 && s.matches !== 0) {
      if (s.matches === 1) slideHash(s);
      else s.head.fill(0);
      s.matches = 0;
    }
    s.level = level;
    s.max_lazy_match = CONFIG[level][1];
    s.good_match = CONFIG[level][0];
    s.nice_match = CONFIG[level][2];
    s.max_chain_length = CONFIG[level][3];
  }
  s.strategy = strategy;
  return Z_OK;
}

// -----------------------------------------------------------------------------

export class ZlibContext implements CompressionContext {
  private initDone = false;
  private err = 0;
  private flush = 0;
  private level = 0;
  private memLevel = 0;
  private strategy = 0;
  private windowBits = 0;
  private gzipIdBytesRead = 0;
  private dictionary: Uint8Array = EMPTY;
  private strm: any = new ZStream();

  constructor(private mode: Mode) {}

  init(level: number, windowBits: number, memLevel: number, strategy: number, dictionary: Uint8Array) {
    const m = this.mode;
    if (!(windowBits === 0 && (m === Mode.INFLATE || m === Mode.GUNZIP || m === Mode.UNZIP))) {
      if (!(windowBits >= 8 && windowBits <= 15)) throw new Error('invalid windowBits');
    }
    if (!(level >= -1 && level <= 9)) throw new Error('invalid compression level');
    if (!(memLevel >= 1 && memLevel <= 9)) throw new Error('invalid memlevel');
    if (![Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY].includes(strategy)) throw new Error('invalid strategy');

    this.level = level;
    this.windowBits = windowBits;
    this.memLevel = memLevel;
    this.strategy = strategy;
    this.flush = Z_NO_FLUSH;
    this.err = Z_OK;
    if (m === Mode.GZIP || m === Mode.GUNZIP) this.windowBits += 16;
    if (m === Mode.UNZIP) this.windowBits += 32;
    if (m === Mode.DEFLATERAW || m === Mode.INFLATERAW) this.windowBits *= -1;
    this.dictionary = dictionary;
  }

  /** Lazily runs deflateInit2/inflateInit2; true on the call that did it. */
  private initZlib(): boolean {
    if (this.initDone) return false;
    switch (this.mode) {
      case Mode.DEFLATE:
      case Mode.GZIP:
      case Mode.DEFLATERAW:
        this.err = zlibDeflateInit2(this.strm, this.level, Z_DEFLATED as any, this.windowBits, this.memLevel, this.strategy);
        break;
      case Mode.INFLATE:
      case Mode.GUNZIP:
      case Mode.INFLATERAW:
      case Mode.UNZIP:
        this.err = zlibInflateInit2(this.strm, this.windowBits);
        break;
      default:
        throw new Error('unreachable');
    }
    if (this.err !== Z_OK) {
      this.dictionary = EMPTY;
      this.mode = Mode.NONE;
      return true;
    }
    this.setDictionary();
    this.initDone = true;
    return true;
  }

  private errorForMessage(message: string): CompressionError {
    if (this.strm.msg) message = this.strm.msg;
    return compressionError(message, zlibStrerror(this.err), this.err);
  }

  private setDictionary(): CompressionError | null {
    if (!this.dictionary.length) return null;
    this.err = Z_OK;
    switch (this.mode) {
      case Mode.DEFLATE:
      case Mode.DEFLATERAW:
        this.err = zlibDeflateSetDictionary(this.strm, this.dictionary);
        break;
      case Mode.INFLATERAW:
        // the other inflate modes set it when inflate() returns Z_NEED_DICT
        this.err = zlibInflateSetDictionary(this.strm, this.dictionary);
        break;
    }
    if (this.err !== Z_OK) return this.errorForMessage('Failed to set dictionary');
    return null;
  }

  setBuffers(input: Uint8Array | null, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) {
    const s = this.strm;
    s.input = input ?? EMPTY;
    s.next_in = input ? inOff : 0;
    s.avail_in = inLen;
    s.output = out;
    s.next_out = outOff;
    s.avail_out = outLen;
  }

  setFlush(flush: number) {
    this.flush = flush;
  }

  work() {
    const first = this.initZlib();
    if (first && this.err !== Z_OK) return;
    const strm = this.strm;
    switch (this.mode) {
      case Mode.DEFLATE:
      case Mode.GZIP:
      case Mode.DEFLATERAW:
        this.err = deflate(strm, this.flush);
        return;
      case Mode.UNZIP: {
        let next = strm.avail_in > 0 ? strm.next_in : -1;
        if (this.gzipIdBytesRead === 0) {
          if (next < 0) {
            this.inflate();
            return;
          }
          if (strm.input[next] === GZIP_HEADER_ID1) {
            this.gzipIdBytesRead = 1;
            next++;
            if (strm.avail_in === 1) {
              // the only available byte was already read
              this.inflate();
              return;
            }
          } else {
            this.mode = Mode.INFLATE;
            this.inflate();
            return;
          }
        }
        // gzipIdBytesRead === 1
        if (next >= 0) {
          if (strm.input[next] === GZIP_HEADER_ID2) {
            this.gzipIdBytesRead = 2;
            this.mode = Mode.GUNZIP;
          } else {
            // there is no actual difference between INFLATE and INFLATERAW after initialization
            this.mode = Mode.INFLATE;
          }
        }
        this.inflate();
        return;
      }
      case Mode.INFLATE:
      case Mode.GUNZIP:
      case Mode.INFLATERAW:
        this.inflate();
        return;
      default:
        throw new Error('unreachable');
    }
  }

  private inflate() {
    const strm = this.strm;
    this.err = zlibInflate(strm, this.flush as any);
    // If data was encoded with a dictionary (INFLATERAW has it set in setDictionary already)
    if (this.mode !== Mode.INFLATERAW && this.err === Z_NEED_DICT && this.dictionary.length) {
      this.err = zlibInflateSetDictionary(strm, this.dictionary);
      if (this.err === Z_OK) {
        this.err = zlibInflate(strm, this.flush as any);
      } else if (this.err === Z_DATA_ERROR) {
        // Both inflateSetDictionary() and inflate() return Z_DATA_ERROR; tell a bad dictionary from bad input.
        this.err = Z_NEED_DICT;
      }
    }
    while (strm.avail_in > 0 && this.mode === Mode.GUNZIP && this.err === Z_STREAM_END && strm.input[strm.next_in] !== 0x00) {
      // Bytes remain: another gzip member, or trailing garbage. Trailing zero bytes are padding.
      this.resetStream();
      this.err = zlibInflate(strm, this.flush as any);
    }
  }

  afterWriteOffsets(): [number, number] {
    return [this.strm.avail_in, this.strm.avail_out];
  }

  errorInfo(): CompressionError | null {
    switch (this.err) {
      case Z_OK:
      case Z_BUF_ERROR:
        if (this.strm.avail_out !== 0 && this.flush === Z_FINISH) return this.errorForMessage('unexpected end of file');
        return null;
      case Z_STREAM_END:
        return null;
      case Z_NEED_DICT:
        return this.errorForMessage(this.dictionary.length ? 'Bad dictionary' : 'Missing dictionary');
      default:
        return this.errorForMessage('Zlib error');
    }
  }

  resetStream(): CompressionError | null {
    const first = this.initZlib();
    if (first && this.err !== Z_OK) return this.errorForMessage('Failed to init stream before reset');
    this.err = Z_OK;
    switch (this.mode) {
      case Mode.DEFLATE:
      case Mode.DEFLATERAW:
      case Mode.GZIP:
        this.err = zlibDeflateReset(this.strm);
        this.strm.msg = ''; // zlib's deflateResetKeep clears msg; pako's does not
        break;
      case Mode.INFLATE:
      case Mode.INFLATERAW:
      case Mode.GUNZIP:
        this.err = zlibInflateReset(this.strm);
        break;
    }
    if (this.err !== Z_OK) return this.errorForMessage('Failed to reset stream');
    return this.setDictionary();
  }

  setParams(level: number, strategy: number): CompressionError | null {
    const first = this.initZlib();
    if (first && this.err !== Z_OK) return this.errorForMessage('Failed to init stream before set parameters');
    this.err = Z_OK;
    switch (this.mode) {
      case Mode.DEFLATE:
      case Mode.DEFLATERAW:
        this.err = deflateParams(this.strm, level, strategy);
        break;
    }
    if (this.err !== Z_OK && this.err !== Z_BUF_ERROR) return this.errorForMessage('Failed to set parameters');
    return null;
  }

  close() {
    if (!this.initDone) {
      this.dictionary = EMPTY;
      this.mode = Mode.NONE;
      return;
    }
    const m = this.mode;
    if (m === Mode.DEFLATE || m === Mode.GZIP || m === Mode.DEFLATERAW) zlibDeflateEnd(this.strm);
    else if (m === Mode.INFLATE || m === Mode.GUNZIP || m === Mode.INFLATERAW || m === Mode.UNZIP) zlibInflateEnd(this.strm);
    this.mode = Mode.NONE;
    this.dictionary = EMPTY;
  }
}
