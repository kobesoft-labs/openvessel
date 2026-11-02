// internalBinding('encoding_binding') — encoding_binding.cc, plus the ada::idna helpers it exposes
// (toASCII / toUnicode), which url.ts shares.

import { fromShape } from './shape.ts';
import { latin1, utf8EncodeInto } from './buffer.ts';

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NativeURL: typeof URL = globalThis.URL;

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
  // ada 4 rejects a double-encoded ACE label (one decoding to "xn--…"), whatwg/url#803.
  if (out.length >= 4 && out[0] === 0x78 && out[1] === 0x6e && out[2] === 0x2d && out[3] === 0x2d) return null;
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

// ada::idna::max_domain_input_bytes: longer inputs are not processed at all.
const MAX_DOMAIN_INPUT_BYTES = 16384;
const utf8Length = (s: string) => (isAscii(s) ? s.length : utf8Enc.encode(s).length);

/**
 * The label an "xn--" label decodes to, when ada 4 accepts it (UTS #46 re-validation): it must
 * not be pure ASCII (an ACE form of an ASCII label, including the empty one) and must be a valid
 * label already in mapped and NFC form. null otherwise.
 */
function decodeAceLabel(label: string): string | null {
  const decoded = punycodeDecode(label.slice(4));
  if (decoded === null || decoded.every((c) => c < 0x80)) return null;
  const u = fromCodePoints(decoded);
  return validDecodedLabel(u) ? u : null;
}

/**
 * ada::idna::to_unicode: decodes "xn--" labels, leaves everything else as is. Since ada 4 a label
 * whose decoding fails UTS #46 validation (ASCII-only, unmapped like an uppercase letter, invalid)
 * is kept in its original form.
 */
export function punycodeToUnicode(input: string): string {
  if (utf8Length(input) > MAX_DOMAIN_INPUT_BYTES) return input;
  let out = '';
  let start = 0;
  while (start < input.length) {
    let dot = input.indexOf('.', start);
    const last = dot === -1;
    if (last) dot = input.length;
    const label = input.slice(start, dot);
    const decoded = label.startsWith('xn--') && isAscii(label) ? decodeAceLabel(label) : null;
    out += decoded ?? label;
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

const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
const hasLtrLetter = (u: string) => Array.from(u).some((ch) => /\p{L}/u.test(ch) && !RTL.test(ch));

/**
 * UTS #46 validity of a label decoded from "xn--", as ada checks it: already in mapped form
 * ("㉓" maps to "23", so it isn't valid as is), no leading combining mark, no controls, U+FFFD
 * or joiners, and an RTL label holds no left-to-right letters (the Bidi rule).
 */
function validDecodedLabel(u: string): boolean {
  if (u.normalize('NFKC').toLowerCase() !== u) return false;
  if (/^\p{M}/u.test(u)) return false;
  if (/[\p{Cc}\ufffd\u200c\u200d]/u.test(u)) return false;
  if (RTL.test(u) && hasLtrLetter(u)) return false;
  return true;
}

/**
 * ada::idna::to_ascii: UTS #46 processing (non-transitional, no STD3 rules, no DNS length check);
 * "" on error. Since ada 4 an all-ASCII input is only lowercased, never validated (the URL
 * Standard's domain to ASCII with beStrict = false), so "xn--" or "xn--zz" come back as they are.
 * In a non-ASCII input, ASCII labels pass through lowercased and "xn--" labels must decode to a
 * valid non-ASCII label.
 */
export function toASCII(input: string): string {
  input = input.toWellFormed?.() ?? input;
  if (utf8Length(input) > MAX_DOMAIN_INPUT_BYTES) return '';
  if (isAscii(input)) return input.toLowerCase();
  const out: string[] = [];
  for (let label of input.split(LABEL_SEPARATORS)) {
    if (label !== '' && isAscii(label)) {
      label = label.toLowerCase();
      if (label.startsWith('xn--') && decodeAceLabel(label) === null) return '';
    } else if (label !== '') {
      // ada checks the Bidi rule on every label; platform parsers (older ada among them) may not.
      if (RTL.test(label) && hasLtrLetter(label)) return '';
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
  });
}
