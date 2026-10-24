// internalBinding('encoding_binding') — encoding_binding.cc, plus the ada::idna helpers it exposes
// (toASCII / toUnicode), which url.ts shares.

import { fromShape } from './shape.ts';
import { latin1, utf8EncodeInto } from './buffer.ts';

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NativeURL: typeof URL = globalThis.URL;
// Windows-1252 for bytes 0x80–0x9F (encoding_binding.cc)
const WINDOWS_1252 = [0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178];

function nodeError(Ctor: ErrorConstructor | TypeErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** Bytes of an ArrayBuffer / SharedArrayBuffer / view, or null for anything else. */
export function bufferSourceBytes(v: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer) return new Uint8Array(v);
  return null;
}

/** TextDecoder rejects views on a SharedArrayBuffer in some browsers; copy those. */
export function decodable(b: Uint8Array): Uint8Array {
  return Object.prototype.toString.call(b.buffer) === '[object SharedArrayBuffer]' ? new Uint8Array(b) : b;
}

// -----------------------------------------------------------------------------
// punycode (ada::idna::punycode_to_utf32 / verify_punycode)

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAXINT = 0x7fffffff;

function adapt(d: number, n: number, first: boolean): number {
  d = first ? Math.trunc(d / DAMP) : Math.trunc(d / 2);
  d += Math.trunc(d / n);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.trunc(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.trunc(((BASE - TMIN + 1) * d) / (d + SKEW));
}

function digitOf(c: number): number {
  if (c >= 0x61 && c <= 0x7a) return c - 0x61;
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 26;
  return -1;
}

/** Decodes a punycode label (without "xn--") to code points; null when invalid. */
export function punycodeDecode(input: string): number[] | null {
  const out: number[] = [];
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  let pos = 0;
  const endOfAscii = input.lastIndexOf('-');
  if (endOfAscii !== -1) {
    for (let j = 0; j < endOfAscii; j++) {
      const c = input.charCodeAt(j);
      if (c >= 0x80) return null;
      out.push(c);
    }
    pos = endOfAscii + 1;
  }
  while (pos < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (pos >= input.length) return null;
      const digit = digitOf(input.charCodeAt(pos++));
      if (digit < 0) return null;
      if (digit > Math.trunc((MAXINT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      if (w > Math.trunc(MAXINT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    if (Math.trunc(i / len) > MAXINT - n) return null;
    n += Math.trunc(i / len);
    i %= len;
    if (n < 0x80) return null;
    out.splice(i, 0, n);
    i++;
  }
  return out;
}

function fromCodePoints(cps: number[]): string {
  let s = '';
  for (const cp of cps) {
    // utf32_to_utf8 of an invalid scalar value: V8 then decodes the bytes with replacement.
    s += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
  }
  return s;
}

/** ada::idna::to_unicode: decodes "xn--" labels, leaves everything else as is. */
export function punycodeToUnicode(input: string): string {
  let out = '';
  let start = 0;
  while (start < input.length) {
    let dot = input.indexOf('.', start);
    const last = dot === -1;
    if (last) dot = input.length;
    const label = input.slice(start, dot);
    let decoded: number[] | null = null;
    if (label.startsWith('xn--') && isAscii(label)) decoded = punycodeDecode(label.slice(4));
    out += decoded ? fromCodePoints(decoded) : label;
    if (!last) out += '.';
    start = dot + 1;
  }
  return out;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) return false;
  return true;
}

// -----------------------------------------------------------------------------
// to_ascii

// ASCII code points the URL host parser rejects (forbidden domain code points) or strips.
const URL_UNSAFE = /[\x00-\x20#%/:<>?@[\\\]^|\x7f]/;
const LABEL_SEPARATORS = /[.。．｡]/;

/** UTS #46 ToASCII of one label through the platform URL host parser; null on failure. */
function labelViaURL(label: string): string | null {
  if (URL_UNSAFE.test(label)) return null;
  try {
    // The ".a" suffix keeps the host parser from reading a numeric label as IPv4.
    const host = new NativeURL(`http://${label}.a/`).hostname;
    return host.endsWith('.a') ? host.slice(0, -2) : null;
  } catch {
    return null;
  }
}

/**
 * ada::idna::to_ascii: UTS #46 processing (non-transitional, no STD3 rules, no DNS length check);
 * "" on error. ASCII labels pass through lowercased; "xn--" labels must decode to a valid label.
 */
export function toASCII(input: string): string {
  input = input.toWellFormed?.() ?? input;
  const ascii = isAscii(input);
  const labels = (ascii ? input.toLowerCase() : input).split(ascii ? '.' : LABEL_SEPARATORS);
  const out: string[] = [];
  for (let label of labels) {
    if (label !== '' && isAscii(label)) {
      label = label.toLowerCase();
      if (label.startsWith('xn--') && (punycodeDecode(label.slice(4))?.length ?? 0) === 0) return '';
      if (label.startsWith('xn--') && labelViaURL(label) !== label) return '';
    } else if (label !== '') {
      const mapped = labelViaURL(label);
      if (mapped === null) return '';
      label = mapped;
    }
    out.push(label);
  }
  return out.join('.');
}

// -----------------------------------------------------------------------------

export function createEncodingBinding() {
  const b = fromShape('encoding_binding');
  const encodeIntoResults: Uint32Array = b.encodeIntoResults instanceof Uint32Array ? b.encodeIntoResults : new Uint32Array(2);

  return Object.assign(b, {
    encodeIntoResults,

    encodeInto(source: string, dest: Uint8Array) {
      const r = utf8EncodeInto(source, dest);
      encodeIntoResults[0] = r.read;
      encodeIntoResults[1] = r.written;
    },

    encodeUtf8String(str: string) {
      return utf8Enc.encode(str);
    },

    decodeUTF8(input: unknown, ignoreBOM?: boolean, fatal?: boolean) {
      let data = bufferSourceBytes(input);
      if (data === null) {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
      }
      data = decodable(data);
      if (fatal === true) {
        try {
          utf8Strict.decode(data);
        } catch {
          throw nodeError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', 'The encoded data was not valid for encoding utf-8');
        }
      }
      if (ignoreBOM !== true && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
      if (data.length === 0) return '';
      return utf8Dec.decode(data);
    },

    toASCII(input: string) {
      return toASCII(input);
    },

    toUnicode(input: string) {
      return punycodeToUnicode(input.toWellFormed?.() ?? input);
    },

    decodeWindows1252(input: unknown, ignoreBOM?: boolean, _fatal?: boolean) {
      let data = bufferSourceBytes(input);
      if (data === null) {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "input" argument must be an instance of ArrayBuffer, SharedArrayBuffer, or ArrayBufferView.');
      }
      // Mirrors the C++: a leading 0xFF is dropped when ignoreBOM is set.
      if (ignoreBOM === true && data.length > 0 && data[0] === 0xff) data = data.subarray(1);
      if (data.length === 0) return '';
      // latin1, except 0x80–0x9F, which Windows-1252 maps to other code points
      let out = '';
      let from = 0;
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        if (b >= 0x80 && b <= 0x9f) {
          if (i > from) out += latin1(data.subarray(from, i));
          out += String.fromCharCode(WINDOWS_1252[b - 0x80]);
          from = i + 1;
        }
      }
      return from === 0 ? latin1(data) : out + latin1(data.subarray(from));
    },
  });
}
