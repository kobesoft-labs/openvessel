// internalBinding('buffer') — node_buffer.cc in JS.

import { fromShape } from './shape.ts';
import { setCryptoBufferPrototype } from './crypto.ts';

const utf8Enc = new TextEncoder();

/** TextEncoder.encodeInto, also into shared memory (the browser rejects views on a SharedArrayBuffer). */
export function utf8EncodeInto(str: string, dest: Uint8Array): { read: number; written: number } {
  if (Object.prototype.toString.call(dest.buffer) === '[object SharedArrayBuffer]') {
    const tmp = new Uint8Array(dest.length);
    const r = utf8Enc.encodeInto(str, tmp);
    dest.set(tmp.subarray(0, r.written!));
    return { read: r.read!, written: r.written! };
  }
  const r = utf8Enc.encodeInto(str, dest);
  return { read: r.read!, written: r.written! };
}
// ignoreBOM: Node keeps a leading U+FEFF (the WHATWG decoder would strip it)
const utf8Dec = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// v8::String::kMaxLength (64-bit)
const kStringMaxLength = 0x1fffffe8;

// string_decoder.encodings order: ascii, utf8, base64, utf16le, latin1, hex, buffer, base64url
export const enum Enc {
  ASCII = 0,
  UTF8 = 1,
  BASE64 = 2,
  UCS2 = 3,
  LATIN1 = 4,
  HEX = 5,
  BUFFER = 6,
  BASE64URL = 7,
}
const ENC_BY_NAME: Record<string, Enc> = { ascii: Enc.ASCII, utf8: Enc.UTF8, 'utf-8': Enc.UTF8, base64: Enc.BASE64, ucs2: Enc.UCS2, 'ucs-2': Enc.UCS2, utf16le: Enc.UCS2, 'utf-16le': Enc.UCS2, latin1: Enc.LATIN1, binary: Enc.LATIN1, hex: Enc.HEX, buffer: Enc.BUFFER, base64url: Enc.BASE64URL };

function oob(): never {
  const e = new RangeError('Index out of range') as RangeError & { code: string };
  e.code = 'ERR_OUT_OF_RANGE';
  throw e;
}

function bytesOf(v: ArrayBufferView | ArrayBufferLike): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v as ArrayBuffer);
}

function notDetached(v: ArrayBufferView | ArrayBufferLike) {
  const ab = (ArrayBuffer.isView(v) ? v.buffer : v) as ArrayBuffer & { detached?: boolean };
  if (ab.detached) {
    const e = new Error('Cannot validate on a detached buffer') as Error & { code: string };
    e.code = 'ERR_INVALID_STATE';
    throw e;
  }
}

function sliceArgs(buf: Uint8Array, start: unknown, end: unknown): [number, number] {
  const len = buf.length;
  let s = start === undefined ? 0 : Number(start);
  let e = end === undefined ? len : Number(end);
  if (!Number.isFinite(s) || s < 0) s = s < 0 ? oob() : 0;
  if (!Number.isFinite(e)) e = len;
  if (e < 0) oob();
  if (s > len) oob();
  if (e > len) e = len;
  if (e < s) e = s;
  return [Math.trunc(s), Math.trunc(e)];
}

// -----------------------------------------------------------------------------
// decoding (bytes → string)

export function latin1(b: Uint8Array, s = 0, e = b.length): string {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)) as unknown as number[]);
  return out;
}
function ascii(b: Uint8Array, s: number, e: number): string {
  let out = '';
  const tmp = new Uint8Array(Math.min(8192, e - s));
  for (let i = s; i < e; i += 8192) {
    const n = Math.min(8192, e - i);
    for (let j = 0; j < n; j++) tmp[j] = b[i + j] & 0x7f;
    out += String.fromCharCode.apply(null, tmp.subarray(0, n) as unknown as number[]);
  }
  return out;
}
function ucs2(b: Uint8Array, s: number, e: number): string {
  let out = '';
  const n = (e - s) >> 1;
  const units = new Uint16Array(Math.min(n, 8192));
  for (let i = 0; i < n; i += 8192) {
    const m = Math.min(8192, n - i);
    for (let j = 0; j < m; j++) {
      const p = s + 2 * (i + j);
      units[j] = b[p] | (b[p + 1] << 8);
    }
    out += String.fromCharCode.apply(null, units.subarray(0, m) as unknown as number[]);
  }
  return out;
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
function hex(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i++) out += HEX[b[i]];
  return out;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function base64(b: Uint8Array, s: number, e: number, url: boolean): string {
  const A = url ? B64URL : B64;
  let out = '';
  let i = s;
  for (; i + 2 < e; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  const rem = e - i;
  if (rem === 1) {
    const n = b[i] << 16;
    out += A[n >> 18] + A[(n >> 12) & 63] + (url ? '' : '==');
  } else if (rem === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + (url ? '' : '=');
  }
  return out;
}

/** Length of the string StringBytes::Encode would ask V8 for (UTF-8: the byte count). */
function encodedLength(enc: Enc, n: number): number {
  switch (enc) {
    case Enc.UCS2:
      return n >> 1;
    case Enc.HEX:
      return n * 2;
    case Enc.BASE64:
      return Math.ceil(n / 3) * 4;
    case Enc.BASE64URL:
      return Math.ceil((n * 4) / 3);
    default:
      return n;
  }
}

function stringTooLong(): never {
  const e = new Error(`Cannot create a string longer than 0x${kStringMaxLength.toString(16)} characters`) as Error & { code: string };
  e.code = 'ERR_STRING_TOO_LONG';
  throw e;
}

/** TextDecoder rejects views on a SharedArrayBuffer (wasm threads' memory); copy those. */
// (a copy by value: Buffer.prototype.slice is subarray, so it would stay on the shared memory)
const unshared = (b: Uint8Array) => (Object.prototype.toString.call(b.buffer) === '[object SharedArrayBuffer]' ? new Uint8Array(b) : b);

export function decode(b: Uint8Array, enc: Enc, s = 0, e = b.length): string {
  if (encodedLength(enc, e - s) > kStringMaxLength) stringTooLong();
  switch (enc) {
    case Enc.UTF8:
    case Enc.BUFFER:
      return utf8Dec.decode(unshared(b.subarray(s, e)));
    case Enc.LATIN1:
      return latin1(b, s, e);
    case Enc.ASCII:
      return ascii(b, s, e);
    case Enc.UCS2:
      return ucs2(b, s, e);
    case Enc.HEX:
      return hex(b, s, e);
    case Enc.BASE64:
      return base64(b, s, e, false);
    case Enc.BASE64URL:
      return base64(b, s, e, true);
  }
}

// -----------------------------------------------------------------------------
// encoding (string → bytes)

const B64_VALUE = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  B64_VALUE[B64.charCodeAt(i)] = i;
  B64_VALUE[B64URL.charCodeAt(i)] = i;
}

/** Node's lenient base64 decoder: either alphabet, skips invalid characters, stops at '='. */
function base64Decode(str: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((str.length * 3) / 4));
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 256 ? B64_VALUE[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

function hexDecode(str: string): Uint8Array {
  const n = str.length >>> 1;
  const out = new Uint8Array(n);
  let i = 0;
  for (; i < n; i++) {
    const v = parseInt(str.substr(i * 2, 2), 16);
    if (Number.isNaN(v) || !/^[0-9a-fA-F]{2}$/.test(str.substr(i * 2, 2))) break;
    out[i] = v;
  }
  return out.subarray(0, i);
}

export function encode(str: string, enc: Enc): Uint8Array {
  switch (enc) {
    case Enc.UTF8:
    case Enc.BUFFER:
      return utf8Enc.encode(str);
    case Enc.LATIN1:
    case Enc.ASCII: {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
      return out;
    }
    case Enc.UCS2: {
      const out = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[2 * i] = c & 0xff;
        out[2 * i + 1] = c >> 8;
      }
      return out;
    }
    case Enc.HEX:
      return hexDecode(str);
    case Enc.BASE64:
    case Enc.BASE64URL:
      return base64Decode(str);
  }
}

export function encodingOf(e: unknown): Enc {
  if (typeof e === 'number') return e as Enc;
  return ENC_BY_NAME[String(e ?? 'utf8').toLowerCase()] ?? Enc.UTF8;
}

function writeInto(buf: Uint8Array, bytes: Uint8Array, offset: number, length: number): number {
  const max = Math.max(0, Math.min(length, buf.length - offset));
  const n = Math.min(max, bytes.length);
  buf.set(bytes.subarray(0, n), offset);
  return n;
}

function writeArgs(buf: Uint8Array, offset: unknown, length: unknown): [number, number] {
  const off = offset === undefined ? 0 : Number(offset);
  if (off < 0 || off > buf.length) {
    const e = new RangeError('"offset" is outside of buffer bounds') as RangeError & { code: string };
    e.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    throw e;
  }
  const len = length === undefined ? buf.length - off : Math.min(Number(length), buf.length - off);
  return [off, Math.max(0, len)];
}

// -----------------------------------------------------------------------------
// searching

function indexOfOffset(length: number, offset: number, needleLength: number, forward: boolean): number {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset;
    if (forward || needleLength === 0) return 0;
    return -1;
  }
  if (offset + needleLength <= length) return offset;
  if (needleLength === 0) return length;
  if (forward) return -1;
  return length - 1;
}

function search(hay: Uint8Array, needle: Uint8Array, offset: number, forward: boolean, step = 1): number {
  const n = needle.length;
  const h = hay.length;
  const matchAt = (i: number) => {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle[j]) return false;
    return true;
  };
  if (forward) {
    const first = needle[0];
    for (let i = offset; i <= h - n; i += step) {
      if (hay[i] === first && matchAt(i)) return i;
    }
  } else {
    let i = Math.min(offset, h - n);
    if (step === 2) i -= i % 2;
    for (; i >= 0; i -= step) if (matchAt(i)) return i;
  }
  return -1;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, byteOffset: number, forward: boolean, step = 1): number {
  let off = indexOfOffset(hay.length, Math.trunc(byteOffset), needle.length, forward);
  if (needle.length === 0) return off;
  if (hay.length === 0 || off <= -1) return -1;
  if ((forward && needle.length + off > hay.length) || needle.length > hay.length) return -1;
  if (step === 2 && forward && off % 2) off++;
  return search(hay, needle, off, forward, step);
}

// -----------------------------------------------------------------------------

let bufferPrototype: object | null = null;
/** A Buffer (FastBuffer) over these bytes, for bindings that hand buffers to JS (Buffer::New). */
export function asBuffer(bytes: Uint8Array): Uint8Array {
  if (bufferPrototype) Object.setPrototypeOf(bytes, bufferPrototype);
  return bytes;
}

export function createBuffer() {
  const b = fromShape('buffer');
  const slice = (enc: Enc) =>
    function (this: Uint8Array, start?: number, end?: number) {
      const [s, e] = sliceArgs(this, start, end);
      return decode(this, enc, s, e);
    };
  const write = (enc: Enc) =>
    function (this: Uint8Array, str: string, offset?: number, length?: number) {
      const [off, len] = writeArgs(this, offset, length);
      if (enc === Enc.UCS2) return writeInto(this, encode(str, enc), off, len - (len % 2));
      return writeInto(this, encode(str, enc), off, len);
    };
  const writeStatic = (enc: Enc) => (buf: Uint8Array, str: string, offset: number, length: number) => {
    const [off, len] = writeArgs(buf, offset, length);
    if (enc === Enc.UTF8) {
      if (len === 0) return 0;
      return utf8EncodeInto(str, buf.subarray(off, off + len)).written;
    }
    return writeInto(buf, encode(str, enc), off, len);
  };
  return Object.assign(b, {
    asciiSlice: slice(Enc.ASCII),
    base64Slice: slice(Enc.BASE64),
    base64urlSlice: slice(Enc.BASE64URL),
    latin1Slice: slice(Enc.LATIN1),
    hexSlice: slice(Enc.HEX),
    ucs2Slice: slice(Enc.UCS2),
    utf8Slice: slice(Enc.UTF8),
    base64Write: write(Enc.BASE64),
    base64urlWrite: write(Enc.BASE64URL),
    hexWrite: write(Enc.HEX),
    ucs2Write: write(Enc.UCS2),
    asciiWriteStatic: writeStatic(Enc.ASCII),
    latin1WriteStatic: writeStatic(Enc.LATIN1),
    utf8WriteStatic: writeStatic(Enc.UTF8),
    byteLengthUtf8(str: string) {
      let n = 0;
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
          n += 4;
          i++;
        } else n += 3;
      }
      return n;
    },
    copy(source: Uint8Array, target: Uint8Array, targetStart: number, sourceStart: number, nb: number) {
      // the target may be any TypedArray (a Uint16Array…): copy bytes, not elements
      bytesOf(target).set(bytesOf(source).subarray(sourceStart, sourceStart + nb), targetStart);
      return nb;
    },
    copyArrayBuffer(dest: ArrayBuffer, destOffset: number, src: ArrayBuffer, srcOffset: number, len: number) {
      new Uint8Array(dest, destOffset, len).set(new Uint8Array(src, srcOffset, len));
    },
    compare(a: Uint8Array, b2: Uint8Array) {
      const x = bytesOf(a);
      const y = bytesOf(b2);
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    },
    compareOffset(source: Uint8Array, target: Uint8Array, targetStart: number, sourceStart: number, targetEnd: number, sourceEnd: number) {
      if (sourceStart > source.length) oob();
      if (targetStart > target.length) oob();
      const s = bytesOf(source).subarray(sourceStart, Math.min(sourceEnd, source.length));
      const t = bytesOf(target).subarray(targetStart, Math.min(targetEnd, target.length));
      return b.compare(s, t);
    },
    fill(buf: Uint8Array, value: unknown, start: number, end: number, encoding?: string) {
      if (start > end || end > buf.length) return -2;
      if (typeof value !== 'string' && !ArrayBuffer.isView(value)) {
        // everything else is coerced to a uint32 and its low byte repeated (node_buffer.cc Fill)
        Uint8Array.prototype.fill.call(buf, Number(value) >>> 0 & 255, start, end);
        return undefined;
      }
      const bytes = typeof value === 'string' ? encode(value, encodingOf(encoding)) : bytesOf(value);
      if (bytes.length === 0) return -1;
      for (let i = start; i < end; i += bytes.length) buf.set(bytes.subarray(0, Math.min(bytes.length, end - i)), i);
      return undefined;
    },
    indexOfString(buf: Uint8Array, needle: string, byteOffset: number, encoding: number, forward: boolean) {
      const enc = encoding as Enc;
      const bytes = encode(needle, enc);
      if (enc === Enc.UCS2) {
        if (buf.length < 2 || bytes.length < 2) return needle.length === 0 ? indexOfOffset(buf.length, byteOffset, 0, forward) : -1;
        return indexOfBytes(buf, bytes, byteOffset, forward, 2);
      }
      return indexOfBytes(buf, bytes, byteOffset, forward);
    },
    indexOfBuffer(buf: Uint8Array, needle: Uint8Array, byteOffset: number, encoding: number, forward: boolean) {
      const n = bytesOf(needle);
      if ((encoding as Enc) === Enc.UCS2) {
        if (buf.length < 2 || n.length < 2) return n.length === 0 ? indexOfOffset(buf.length, byteOffset, 0, forward) : -1;
        return indexOfBytes(buf, n, byteOffset, forward, 2);
      }
      return indexOfBytes(buf, n, byteOffset, forward);
    },
    indexOfNumber(buf: Uint8Array, num: number, byteOffset: number, forward: boolean) {
      const off = indexOfOffset(buf.length, Math.trunc(byteOffset), 1, forward);
      if (off <= -1 || buf.length === 0) return -1;
      const v = num & 0xff;
      // (not buf.indexOf: that is Buffer.prototype.indexOf, which calls back here)
      return forward ? Uint8Array.prototype.indexOf.call(buf, v, off) : Uint8Array.prototype.lastIndexOf.call(buf, v, off);
    },
    swap16(buf: Uint8Array) {
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const t = buf[i];
        buf[i] = buf[i + 1];
        buf[i + 1] = t;
      }
    },
    swap32(buf: Uint8Array) {
      for (let i = 0; i + 3 < buf.length; i += 4) {
        const a = buf[i];
        const c = buf[i + 1];
        buf[i] = buf[i + 3];
        buf[i + 1] = buf[i + 2];
        buf[i + 2] = c;
        buf[i + 3] = a;
      }
    },
    swap64(buf: Uint8Array) {
      for (let i = 0; i + 7 < buf.length; i += 8) buf.subarray(i, i + 8).reverse();
    },
    isUtf8(v: ArrayBufferView | ArrayBuffer) {
      notDetached(v);
      try {
        utf8Strict.decode(unshared(bytesOf(v)));
        return true;
      } catch {
        return false;
      }
    },
    isAscii(v: ArrayBufferView | ArrayBuffer) {
      notDetached(v);
      const x = bytesOf(v);
      for (let i = 0; i < x.length; i++) if (x[i] > 0x7f) return false;
      return true;
    },
    btoa(input: string) {
      for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) > 0xff) return -1;
      return base64(encode(input, Enc.LATIN1), 0, input.length, false);
    },
    atob(input: string) {
      // forgiving-base64 decode (WHATWG)
      let s = input.replace(/[\t\n\f\r ]/g, '');
      if (s.length % 4 === 0) s = s.replace(/={1,2}$/, '');
      if (s.length % 4 === 1) return -1;
      if (/[^A-Za-z0-9+/]/.test(s)) return -2;
      return latin1(base64Decode(s));
    },
    getZeroFillToggle: () => new Uint32Array(1),
    // memory from ArrayBuffer is always zeroed in JS; "unsafe" only skips that in C++
    createUnsafeArrayBuffer: (size: number) => new ArrayBuffer(size),
    // removed by bootstrap/node.js right after the call (so it is not in the recorded shape)
    setBufferPrototype(proto: object) {
      bufferPrototype = proto;
      setCryptoBufferPrototype(proto);
    },
  });
}
