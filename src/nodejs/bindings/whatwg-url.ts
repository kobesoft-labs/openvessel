// The WHATWG URL Standard's basic URL parser and serializer, as ada (Node's URL engine) does them.
// A browser's own URL class isn't used for parsing: Chrome's differs from the standard in many
// places (file URLs, forbidden host code points, percent-encode sets, invalid "xn--" labels…).
// Only UTS #46 mapping of non-ASCII domains goes through it (encoding.ts toASCII).

import { toASCII } from './encoding.ts';

export interface URLRecord {
  scheme: string;
  username: string;
  password: string;
  /** null: no host; '' : empty host */
  host: string | null;
  port: number | null;
  /** a list of segments, or an opaque path (string) */
  path: string[] | string;
  query: string | null;
  fragment: string | null;
}

const SPECIAL: Record<string, number | null> = { ftp: 21, file: null, http: 80, https: 443, ws: 80, wss: 443 };
const isSpecialScheme = (s: string) => Object.prototype.hasOwnProperty.call(SPECIAL, s);
export const isSpecial = (u: URLRecord) => isSpecialScheme(u.scheme);
const defaultPort = (s: string) => (isSpecialScheme(s) ? SPECIAL[s] : null);

// ---------------------------------------------------------------------------
// code points

const isAsciiDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAsciiHex = (c: number) => isAsciiDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isAsciiAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiAlnum = (c: number) => isAsciiAlpha(c) || isAsciiDigit(c);

const C0_CONTROL = (c: number) => c < 0x20 || c > 0x7e;
const FRAGMENT = (c: number) => C0_CONTROL(c) || c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
const QUERY = (c: number) => C0_CONTROL(c) || c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e;
const SPECIAL_QUERY = (c: number) => QUERY(c) || c === 0x27;
const PATH = (c: number) => QUERY(c) || c === 0x3f || c === 0x60 || c === 0x7b || c === 0x7d;
const USERINFO = (c: number) => PATH(c) || c === 0x2f || c === 0x3a || c === 0x3b || c === 0x3d || c === 0x40 || (c >= 0x5b && c <= 0x5e) || c === 0x7c;

const FORBIDDEN_HOST = new Set([0x00, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x7c]);
const isForbiddenHost = (c: number) => FORBIDDEN_HOST.has(c);
const isForbiddenDomain = (c: number) => isForbiddenHost(c) || c <= 0x1f || c === 0x25 || c === 0x7f;

const utf8 = (s: string): number[] => {
  const out: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
};
const HEX = '0123456789ABCDEF';

/** UTF-8 percent-encodes a code point (given as a string) if it is in the set. */
function encodeCp(ch: string, set: (c: number) => boolean): string {
  let out = '';
  for (const b of utf8(ch)) out += set(b) ? `%${HEX[b >> 4]}${HEX[b & 15]}` : String.fromCharCode(b);
  return out;
}
function encodeString(s: string, set: (c: number) => boolean): string {
  let out = '';
  for (const ch of s) out += encodeCp(ch, set);
  return out;
}

function percentDecode(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x25 && i + 2 < bytes.length && isAsciiHex(bytes[i + 1]) && isAsciiHex(bytes[i + 2])) {
      out.push(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
      i += 2;
    } else out.push(b);
  }
  return out;
}

function utf8DecodeWithoutBOM(bytes: number[]): string {
  // (a lone byte sequence decodes with U+FFFD, like TextDecoder)
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let cp = 0xfffd;
    let n = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b <= 0xdf && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
      cp = ((b & 31) << 6) | (bytes[i + 1] & 63);
      n = 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      const lo = b === 0xe0 ? 0xa0 : 0x80;
      const hi = b === 0xed ? 0x9f : 0xbf;
      if (i + 1 < bytes.length && bytes[i + 1] >= lo && bytes[i + 1] <= hi) {
        if (i + 2 < bytes.length && (bytes[i + 2] & 0xc0) === 0x80) {
          cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
          n = 3;
        } else n = 2;
      }
    } else if (b >= 0xf0 && b <= 0xf4) {
      const lo = b === 0xf0 ? 0x90 : 0x80;
      const hi = b === 0xf4 ? 0x8f : 0xbf;
      if (i + 1 < bytes.length && bytes[i + 1] >= lo && bytes[i + 1] <= hi) {
        if (i + 2 < bytes.length && (bytes[i + 2] & 0xc0) === 0x80) {
          if (i + 3 < bytes.length && (bytes[i + 3] & 0xc0) === 0x80) {
            cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
            n = 4;
          } else n = 3;
        } else n = 2;
      }
    }
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// hosts

const FAIL = Symbol('failure');
type Fail = typeof FAIL;

function parseIPv6(input: string): number[] | Fail {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let pieceIndex = 0;
  let compress: number | null = null;
  let p = 0;
  const cps = Array.from(input, (c) => c.codePointAt(0)!);
  const c = () => cps[p];
  if (c() === 0x3a) {
    if (cps[p + 1] !== 0x3a) return FAIL;
    p += 2;
    pieceIndex++;
    compress = pieceIndex;
  }
  while (c() !== undefined) {
    if (pieceIndex === 8) return FAIL;
    if (c() === 0x3a) {
      if (compress !== null) return FAIL;
      p++;
      pieceIndex++;
      compress = pieceIndex;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && c() !== undefined && isAsciiHex(c())) {
      value = value * 0x10 + parseInt(String.fromCharCode(c()), 16);
      p++;
      length++;
    }
    if (c() === 0x2e) {
      if (length === 0) return FAIL;
      p -= length;
      if (pieceIndex > 6) return FAIL;
      let numbersSeen = 0;
      while (c() !== undefined) {
        let ipv4Piece: number | null = null;
        if (numbersSeen > 0) {
          if (c() === 0x2e && numbersSeen < 4) p++;
          else return FAIL;
        }
        if (c() === undefined || !isAsciiDigit(c())) return FAIL;
        while (c() !== undefined && isAsciiDigit(c())) {
          const number = c() - 0x30;
          if (ipv4Piece === null) ipv4Piece = number;
          else if (ipv4Piece === 0) return FAIL;
          else ipv4Piece = ipv4Piece * 10 + number;
          if (ipv4Piece > 255) return FAIL;
          p++;
        }
        address[pieceIndex] = address[pieceIndex] * 0x100 + ipv4Piece!;
        numbersSeen++;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
      }
      if (numbersSeen !== 4) return FAIL;
      break;
    } else if (c() === 0x3a) {
      p++;
      if (c() === undefined) return FAIL;
    } else if (c() !== undefined) return FAIL;
    address[pieceIndex] = value;
    pieceIndex++;
  }
  if (compress !== null) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const t = address[compress + swaps - 1];
      address[compress + swaps - 1] = address[pieceIndex];
      address[pieceIndex] = t;
      pieceIndex--;
      swaps--;
    }
  } else if (pieceIndex !== 8) return FAIL;
  return address;
}

function serializeIPv6(address: number[]): string {
  // the first longest run of two or more zero pieces is compressed
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (address[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && address[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  let out = '';
  let ignore0 = false;
  for (let i = 0; i < 8; i++) {
    if (ignore0 && address[i] === 0) continue;
    ignore0 = false;
    if (best === i) {
      out += i === 0 ? '::' : ':';
      ignore0 = true;
      continue;
    }
    out += address[i].toString(16);
    if (i !== 7) out += ':';
  }
  return `[${out}]`;
}

function parseIPv4Number(s: string): number | Fail {
  if (s === '') return FAIL;
  let radix = 10;
  if (s.length >= 2 && (s.startsWith('0x') || s.startsWith('0X'))) {
    s = s.slice(2);
    radix = 16;
  } else if (s.length >= 2 && s[0] === '0') {
    s = s.slice(1);
    radix = 8;
  }
  if (s === '') return 0;
  const re = radix === 10 ? /^[0-9]+$/ : radix === 16 ? /^[0-9A-Fa-f]+$/ : /^[0-7]+$/;
  if (!re.test(s)) return FAIL;
  // exact for the sizes that matter (anything over 2^32 fails anyway)
  return Number(BigInt(radix === 16 ? `0x${s}` : radix === 8 ? `0o${s}` : s) > 0xffffffffffn ? 0xffffffffff : BigInt(radix === 16 ? `0x${s}` : radix === 8 ? `0o${s}` : s));
}

function endsInANumber(input: string): boolean {
  const parts = input.split('.');
  if (parts[parts.length - 1] === '') {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1];
  if (last !== '' && /^[0-9]+$/.test(last)) return true;
  return parseIPv4Number(last) !== FAIL;
}

function parseIPv4(input: string): number | Fail {
  const parts = input.split('.');
  if (parts[parts.length - 1] === '' && parts.length > 1) parts.pop();
  if (parts.length > 4) return FAIL;
  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseIPv4Number(part);
    if (n === FAIL) return FAIL;
    numbers.push(n);
  }
  for (let i = 0; i < numbers.length - 1; i++) if (numbers[i] > 255) return FAIL;
  if (numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return FAIL;
  let ipv4 = numbers[numbers.length - 1];
  for (let i = 0; i < numbers.length - 1; i++) ipv4 += numbers[i] * 256 ** (3 - i);
  return ipv4;
}

function serializeIPv4(n: number): string {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    out.unshift(n % 256);
    n = Math.floor(n / 256);
  }
  return out.join('.');
}

function parseOpaqueHost(input: string): string | Fail {
  for (const ch of input) {
    const c = ch.codePointAt(0)!;
    if (c !== 0x25 && isForbiddenHost(c)) return FAIL;
  }
  return encodeString(input, C0_CONTROL);
}

/** domain to ASCII (beStrict = false) */
function domainToAscii(domain: string): string | Fail {
  // UTS #46 maps compatibility forms (fullwidth "％" is "%"); what is forbidden after mapping fails
  const mapped = domain.normalize('NFKC').toLowerCase();
  for (const ch of mapped) if (ch !== '.' && ch.length === 1 && isForbiddenDomain(ch.charCodeAt(0)) && !/[。．｡]/.test(ch)) return FAIL;
  const result = toASCII(domain);
  if (result === '') return FAIL;
  return result;
}

export function parseHost(input: string, isOpaque: boolean): string | Fail {
  if (input.startsWith('[')) {
    if (!input.endsWith(']')) return FAIL;
    const a = parseIPv6(input.slice(1, -1));
    return a === FAIL ? FAIL : serializeIPv6(a);
  }
  if (isOpaque) return parseOpaqueHost(input);
  const domain = utf8DecodeWithoutBOM(percentDecode(utf8(input)));
  const ascii = domainToAscii(domain);
  if (ascii === FAIL) return FAIL;
  for (let i = 0; i < ascii.length; i++) if (isForbiddenDomain(ascii.charCodeAt(i))) return FAIL;
  if (endsInANumber(ascii)) {
    const v4 = parseIPv4(ascii);
    return v4 === FAIL ? FAIL : serializeIPv4(v4);
  }
  return ascii;
}

// ---------------------------------------------------------------------------
// paths

const isWindowsDriveLetter = (s: string, normalizedOnly = false) => s.length === 2 && isAsciiAlpha(s.charCodeAt(0)) && (s[1] === ':' || (!normalizedOnly && s[1] === '|'));
function startsWithWindowsDriveLetter(cps: number[], p: number): boolean {
  if (cps.length - p < 2) return false;
  if (!isAsciiAlpha(cps[p]) || (cps[p + 1] !== 0x3a && cps[p + 1] !== 0x7c)) return false;
  if (cps.length - p === 2) return true;
  const c = cps[p + 2];
  return c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23;
}
const isSingleDot = (s: string) => s === '.' || s.toLowerCase() === '%2e';
const isDoubleDot = (s: string) => {
  const l = s.toLowerCase();
  return l === '..' || l === '.%2e' || l === '%2e.' || l === '%2e%2e';
};

function shortenPath(u: URLRecord) {
  const path = u.path as string[];
  if (u.scheme === 'file' && path.length === 1 && isWindowsDriveLetter(path[0], true)) return;
  path.pop();
}

// ---------------------------------------------------------------------------
// the basic URL parser

export const enum State {
  SchemeStart,
  Scheme,
  NoScheme,
  SpecialRelativeOrAuthority,
  PathOrAuthority,
  Relative,
  RelativeSlash,
  SpecialAuthoritySlashes,
  SpecialAuthorityIgnoreSlashes,
  Authority,
  Host,
  Hostname,
  Port,
  File,
  FileSlash,
  FileHost,
  PathStart,
  Path,
  OpaquePath,
  Query,
  Fragment,
}

export const newRecord = (): URLRecord => ({ scheme: '', username: '', password: '', host: null, port: null, path: [], query: null, fragment: null });

/**
 * The basic URL parser. With `url` and `override`, it updates `url` in place (the setters); the
 * result is then false when the input was rejected (the URL is left as it was where the standard
 * says so), true otherwise.
 */
export function basicParse(input: string, base: URLRecord | null, url?: URLRecord, override?: State): URLRecord | null | boolean {
  if (!url) {
    url = newRecord();
    input = input.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  }
  input = input.replace(/[\t\n\r]/g, '');
  let state = override ?? State.SchemeStart;
  let buffer = '';
  let atSignSeen = false;
  let insideBrackets = false;
  let passwordTokenSeen = false;
  const cps = Array.from(input, (ch) => ch.codePointAt(0)!);
  const u = url;
  const failure = override !== undefined ? false : null;
  const done = override !== undefined ? true : u;

  for (let p = 0; ; p++) {
    const c = cps[p]; // undefined: EOF
    const ch = c === undefined ? '' : String.fromCodePoint(c);
    switch (state) {
      case State.SchemeStart:
        if (c !== undefined && isAsciiAlpha(c)) {
          buffer += ch.toLowerCase();
          state = State.Scheme;
        } else if (override === undefined) {
          state = State.NoScheme;
          p--;
        } else return failure;
        break;

      case State.Scheme:
        if (c !== undefined && (isAsciiAlnum(c) || c === 0x2b || c === 0x2d || c === 0x2e)) {
          buffer += ch.toLowerCase();
        } else if (c === 0x3a) {
          if (override !== undefined) {
            if (isSpecialScheme(u.scheme) !== isSpecialScheme(buffer)) return true;
            if ((u.username !== '' || u.password !== '' || u.port !== null) && buffer === 'file') return true;
            if (u.scheme === 'file' && u.host === '') return true;
          }
          u.scheme = buffer;
          if (override !== undefined) {
            if (u.port === defaultPort(u.scheme)) u.port = null;
            return true;
          }
          buffer = '';
          if (u.scheme === 'file') state = State.File;
          else if (isSpecial(u) && base && base.scheme === u.scheme) state = State.SpecialRelativeOrAuthority;
          else if (isSpecial(u)) state = State.SpecialAuthoritySlashes;
          else if (cps[p + 1] === 0x2f) {
            state = State.PathOrAuthority;
            p++;
          } else {
            u.path = '';
            state = State.OpaquePath;
          }
        } else if (override === undefined) {
          buffer = '';
          state = State.NoScheme;
          p = -1;
        } else return failure;
        break;

      case State.NoScheme:
        if (!base || (typeof base.path === 'string' && c !== 0x23)) return failure;
        if (typeof base.path === 'string' && c === 0x23) {
          u.scheme = base.scheme;
          u.path = base.path;
          u.query = base.query;
          u.fragment = '';
          state = State.Fragment;
        } else if (base.scheme !== 'file') {
          state = State.Relative;
          p--;
        } else {
          state = State.File;
          p--;
        }
        break;

      case State.SpecialRelativeOrAuthority:
        if (c === 0x2f && cps[p + 1] === 0x2f) {
          state = State.SpecialAuthorityIgnoreSlashes;
          p++;
        } else {
          state = State.Relative;
          p--;
        }
        break;

      case State.PathOrAuthority:
        if (c === 0x2f) state = State.Authority;
        else {
          state = State.Path;
          p--;
        }
        break;

      case State.Relative:
        u.scheme = base!.scheme;
        if (c === 0x2f) state = State.RelativeSlash;
        else if (isSpecial(u) && c === 0x5c) state = State.RelativeSlash;
        else {
          u.username = base!.username;
          u.password = base!.password;
          u.host = base!.host;
          u.port = base!.port;
          u.path = (base!.path as string[]).slice();
          u.query = base!.query;
          if (c === 0x3f) {
            u.query = '';
            state = State.Query;
          } else if (c === 0x23) {
            u.fragment = '';
            state = State.Fragment;
          } else if (c !== undefined) {
            u.query = null;
            shortenPath(u);
            state = State.Path;
            p--;
          }
        }
        break;

      case State.RelativeSlash:
        if (isSpecial(u) && (c === 0x2f || c === 0x5c)) state = State.SpecialAuthorityIgnoreSlashes;
        else if (c === 0x2f) state = State.Authority;
        else {
          u.username = base!.username;
          u.password = base!.password;
          u.host = base!.host;
          u.port = base!.port;
          state = State.Path;
          p--;
        }
        break;

      case State.SpecialAuthoritySlashes:
        if (c === 0x2f && cps[p + 1] === 0x2f) {
          state = State.SpecialAuthorityIgnoreSlashes;
          p++;
        } else {
          state = State.SpecialAuthorityIgnoreSlashes;
          p--;
        }
        break;

      case State.SpecialAuthorityIgnoreSlashes:
        if (c !== 0x2f && c !== 0x5c) {
          state = State.Authority;
          p--;
        }
        break;

      case State.Authority:
        if (c === 0x40) {
          if (atSignSeen) buffer = '%40' + buffer;
          atSignSeen = true;
          for (const bc of buffer) {
            if (bc === ':' && !passwordTokenSeen) {
              passwordTokenSeen = true;
              continue;
            }
            const enc = encodeCp(bc, USERINFO);
            if (passwordTokenSeen) u.password += enc;
            else u.username += enc;
          }
          buffer = '';
        } else if (c === undefined || c === 0x2f || c === 0x3f || c === 0x23 || (isSpecial(u) && c === 0x5c)) {
          if (atSignSeen && buffer === '') return failure;
          p -= Array.from(buffer).length + 1;
          buffer = '';
          state = State.Host;
        } else buffer += ch;
        break;

      case State.Host:
      case State.Hostname:
        if (override !== undefined && u.scheme === 'file') {
          p--;
          state = State.FileHost;
        } else if (c === 0x3a && !insideBrackets) {
          if (buffer === '') return failure;
          if (override === State.Hostname) return failure;
          const host = parseHost(buffer, !isSpecial(u));
          if (host === FAIL) return failure;
          u.host = host;
          buffer = '';
          state = State.Port;
        } else if (c === undefined || c === 0x2f || c === 0x3f || c === 0x23 || (isSpecial(u) && c === 0x5c)) {
          p--;
          if (isSpecial(u) && buffer === '') return failure;
          if (override !== undefined && buffer === '' && (u.username !== '' || u.password !== '' || u.port !== null)) return failure;
          const host = parseHost(buffer, !isSpecial(u));
          if (host === FAIL) return failure;
          u.host = host;
          buffer = '';
          state = State.PathStart;
          if (override !== undefined) return true;
        } else {
          if (c === 0x5b) insideBrackets = true;
          if (c === 0x5d) insideBrackets = false;
          buffer += ch;
        }
        break;

      case State.Port:
        if (c !== undefined && isAsciiDigit(c)) buffer += ch;
        else if (c === undefined || c === 0x2f || c === 0x3f || c === 0x23 || (isSpecial(u) && c === 0x5c) || override !== undefined) {
          if (buffer !== '') {
            const port = parseInt(buffer, 10);
            if (port > 65535) return failure;
            u.port = port === defaultPort(u.scheme) ? null : port;
            buffer = '';
            if (override !== undefined) return true;
          }
          if (override !== undefined) return failure;
          state = State.PathStart;
          p--;
        } else return failure;
        break;

      case State.File:
        u.scheme = 'file';
        u.host = '';
        if (c === 0x2f || c === 0x5c) state = State.FileSlash;
        else if (base && base.scheme === 'file') {
          u.host = base.host;
          u.path = (base.path as string[]).slice();
          u.query = base.query;
          if (c === 0x3f) {
            u.query = '';
            state = State.Query;
          } else if (c === 0x23) {
            u.fragment = '';
            state = State.Fragment;
          } else if (c !== undefined) {
            u.query = null;
            if (!startsWithWindowsDriveLetter(cps, p)) shortenPath(u);
            else u.path = [];
            state = State.Path;
            p--;
          }
        } else {
          state = State.Path;
          p--;
        }
        break;

      case State.FileSlash:
        if (c === 0x2f || c === 0x5c) state = State.FileHost;
        else {
          if (base && base.scheme === 'file') {
            u.host = base.host;
            if (!startsWithWindowsDriveLetter(cps, p) && typeof base.path !== 'string' && base.path.length > 0 && isWindowsDriveLetter(base.path[0], true)) {
              (u.path as string[]).push(base.path[0]);
            }
          }
          state = State.Path;
          p--;
        }
        break;

      case State.FileHost:
        if (c === undefined || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
          p--;
          if (override === undefined && isWindowsDriveLetter(buffer)) {
            state = State.Path;
          } else if (buffer === '') {
            u.host = '';
            if (override !== undefined) return true;
            state = State.PathStart;
          } else {
            let host = parseHost(buffer, !isSpecial(u));
            if (host === FAIL) return failure;
            if (host === 'localhost') host = '';
            u.host = host;
            if (override !== undefined) return true;
            buffer = '';
            state = State.PathStart;
          }
        } else buffer += ch;
        break;

      case State.PathStart:
        if (isSpecial(u)) {
          state = State.Path;
          if (c !== 0x2f && c !== 0x5c) p--;
        } else if (override === undefined && c === 0x3f) {
          u.query = '';
          state = State.Query;
        } else if (override === undefined && c === 0x23) {
          u.fragment = '';
          state = State.Fragment;
        } else if (c !== undefined) {
          state = State.Path;
          if (c !== 0x2f) p--;
        } else if (override !== undefined && u.host === null) {
          (u.path as string[]).push('');
        }
        break;

      case State.Path:
        if (c === undefined || c === 0x2f || (isSpecial(u) && c === 0x5c) || (override === undefined && (c === 0x3f || c === 0x23))) {
          const path = u.path as string[];
          if (isDoubleDot(buffer)) {
            shortenPath(u);
            if (c !== 0x2f && !(isSpecial(u) && c === 0x5c)) path.push('');
          } else if (isSingleDot(buffer) && c !== 0x2f && !(isSpecial(u) && c === 0x5c)) {
            path.push('');
          } else if (!isSingleDot(buffer)) {
            if (u.scheme === 'file' && path.length === 0 && isWindowsDriveLetter(buffer)) buffer = buffer[0] + ':';
            path.push(buffer);
          }
          buffer = '';
          if (c === 0x3f) {
            u.query = '';
            state = State.Query;
          }
          if (c === 0x23) {
            u.fragment = '';
            state = State.Fragment;
          }
        } else buffer += encodeCp(ch, PATH);
        break;

      case State.OpaquePath:
        if (c === 0x3f) {
          u.query = '';
          state = State.Query;
        } else if (c === 0x23) {
          u.fragment = '';
          state = State.Fragment;
        } else if (c !== undefined) {
          u.path += encodeCp(ch, C0_CONTROL);
        }
        break;

      case State.Query:
        if ((override === undefined && c === 0x23) || c === undefined) {
          u.query = (u.query ?? '') + encodeString(buffer, isSpecial(u) ? SPECIAL_QUERY : QUERY);
          buffer = '';
          if (c === 0x23) {
            u.fragment = '';
            state = State.Fragment;
          }
        } else buffer += ch;
        break;

      case State.Fragment:
        if (c !== undefined) u.fragment += encodeCp(ch, FRAGMENT);
        break;
    }
    // the pointer at EOF (not moved back): done
    if (p >= cps.length) break;
  }
  return done;
}

// ---------------------------------------------------------------------------
// serializing and the URL API's getters/setters

export function serializePath(u: URLRecord): string {
  if (typeof u.path === 'string') return u.path;
  let out = '';
  for (const seg of u.path) out += '/' + seg;
  return out;
}

export function serialize(u: URLRecord, excludeFragment = false): string {
  let out = u.scheme + ':';
  if (u.host !== null) {
    out += '//';
    if (u.username !== '' || u.password !== '') {
      out += u.username;
      if (u.password !== '') out += ':' + u.password;
      out += '@';
    }
    out += u.host;
    if (u.port !== null) out += ':' + u.port;
  }
  if (u.host === null && typeof u.path !== 'string' && u.path.length > 1 && u.path[0] === '') out += '/.';
  out += serializePath(u);
  if (u.query !== null) out += '?' + u.query;
  if (!excludeFragment && u.fragment !== null) out += '#' + u.fragment;
  return out;
}

export function parse(input: string, base?: string): URLRecord | null {
  let b: URLRecord | null = null;
  if (base !== undefined) {
    b = basicParse(base, null) as URLRecord | null;
    if (!b) return null;
  }
  return basicParse(input, b) as URLRecord | null;
}

export function origin(u: URLRecord): string {
  switch (u.scheme) {
    case 'blob': {
      const inner = typeof u.path === 'string' ? parse(u.path) : null;
      return inner && (inner.scheme === 'http' || inner.scheme === 'https') ? origin(inner) : 'null';
    }
    case 'ftp':
    case 'http':
    case 'https':
    case 'ws':
    case 'wss':
      return `${u.scheme}://${u.host}${u.port !== null ? ':' + u.port : ''}`;
    default:
      return 'null';
  }
}

const cannotHaveUsernamePasswordPort = (u: URLRecord) => u.host === null || u.host === '' || u.scheme === 'file';

/** The URL API's getters, as ada exposes them. */
export const get = {
  protocol: (u: URLRecord) => u.scheme + ':',
  username: (u: URLRecord) => u.username,
  password: (u: URLRecord) => u.password,
  host: (u: URLRecord) => (u.host === null ? '' : u.port === null ? u.host : `${u.host}:${u.port}`),
  hostname: (u: URLRecord) => u.host ?? '',
  port: (u: URLRecord) => (u.port === null ? '' : String(u.port)),
  pathname: (u: URLRecord) => serializePath(u),
  search: (u: URLRecord) => (u.query === null || u.query === '' ? '' : '?' + u.query),
  hash: (u: URLRecord) => (u.fragment === null || u.fragment === '' ? '' : '#' + u.fragment),
};

/** The URL API's setters (on a copy; null when the value is rejected and nothing changes). */
export const set = {
  protocol(u: URLRecord, v: string) {
    basicParse(v + ':', null, u, State.SchemeStart);
  },
  username(u: URLRecord, v: string) {
    if (cannotHaveUsernamePasswordPort(u)) return false;
    u.username = encodeString(v, USERINFO);
    return true;
  },
  password(u: URLRecord, v: string) {
    if (cannotHaveUsernamePasswordPort(u)) return false;
    u.password = encodeString(v, USERINFO);
    return true;
  },
  host(u: URLRecord, v: string) {
    if (typeof u.path === 'string') return false;
    return basicParse(v, null, u, State.Host) as boolean;
  },
  hostname(u: URLRecord, v: string) {
    if (typeof u.path === 'string') return false;
    return basicParse(v, null, u, State.Hostname) as boolean;
  },
  port(u: URLRecord, v: string) {
    if (cannotHaveUsernamePasswordPort(u)) return false;
    if (v === '') u.port = null;
    else return basicParse(v, null, u, State.Port) as boolean;
    return true;
  },
  pathname(u: URLRecord, v: string) {
    if (typeof u.path === 'string') return false;
    u.path = [];
    basicParse(v, null, u, State.PathStart);
    return true;
  },
  search(u: URLRecord, v: string) {
    if (v === '') {
      u.query = null;
      stripTrailingSpacesFromOpaquePath(u);
      return true;
    }
    const input = v[0] === '?' ? v.slice(1) : v;
    u.query = '';
    basicParse(input, null, u, State.Query);
    return true;
  },
  hash(u: URLRecord, v: string) {
    if (v === '') {
      u.fragment = null;
      stripTrailingSpacesFromOpaquePath(u);
      return true;
    }
    const input = v[0] === '#' ? v.slice(1) : v;
    u.fragment = '';
    basicParse(input, null, u, State.Fragment);
    return true;
  },
};

function stripTrailingSpacesFromOpaquePath(u: URLRecord) {
  if (typeof u.path !== 'string') return;
  if (u.fragment !== null || u.query !== null) return;
  u.path = u.path.replace(/ +$/, '');
}

export const cloneRecord = (u: URLRecord): URLRecord => ({ ...u, path: typeof u.path === 'string' ? u.path : u.path.slice() });
