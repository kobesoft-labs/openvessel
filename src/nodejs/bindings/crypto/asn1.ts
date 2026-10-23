// Minimal DER reader/writer for the key formats (SPKI, PKCS#8, PKCS#1, SEC1, PBES2).

import { Enc, decode, encode } from '../buffer.ts';
import { concat } from './util.ts';

export interface Node {
  tag: number;
  /** content bytes */
  body: Uint8Array;
  /** the whole TLV */
  raw: Uint8Array;
}

export class DerError extends Error {}

export function read(b: Uint8Array, off = 0): Node {
  if (off + 2 > b.length) throw new DerError('truncated');
  const tag = b[off];
  let len = b[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > b.length) throw new DerError('bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new DerError('truncated');
  return { tag, body: b.subarray(p, p + len), raw: b.subarray(off, p + len) };
}

/** Parses exactly one element spanning all of `b`. */
export function parse(b: Uint8Array): Node {
  const n = read(b);
  if (n.raw.length !== b.length) throw new DerError('trailing data');
  return n;
}

export function children(n: Node): Node[] {
  const out: Node[] = [];
  for (let off = 0; off < n.body.length; ) {
    const c = read(n.body, off);
    out.push(c);
    off += c.raw.length;
  }
  return out;
}

export function expect(n: Node | undefined, tag: number): Node {
  if (!n || n.tag !== tag) throw new DerError('wrong tag');
  return n;
}

// --- writing

function lenBytes(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | out.length, ...out];
}

export function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([tag, ...lenBytes(body.length)]), body]);
}

export const seq = (...items: Uint8Array[]) => tlv(0x30, concat(items));
export const octets = (b: Uint8Array) => tlv(0x04, b);
export const bitString = (b: Uint8Array) => tlv(0x03, concat([Uint8Array.of(0), b]));
export const nul = () => Uint8Array.of(0x05, 0x00);
export const ctx = (n: number, body: Uint8Array) => tlv(0xa0 + n, body);

export function int(v: bigint | number): Uint8Array {
  let hex = BigInt(v).toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  if (bytes[0] & 0x80) bytes = [0, ...bytes];
  return tlv(0x02, Uint8Array.from(bytes));
}

export function readInt(n: Node): bigint {
  expect(n, 0x02);
  let hex = '';
  for (const b of n.body) hex += (b < 16 ? '0' : '') + b.toString(16);
  return hex ? BigInt('0x' + hex) : 0n;
}

export function oid(s: string): Uint8Array {
  const parts = s.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const enc = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return tlv(0x06, Uint8Array.from(out));
}

export function readOid(n: Node): string {
  expect(n, 0x06);
  const b = n.body;
  if (!b.length) throw new DerError('empty oid');
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

export function readBitString(n: Node): Uint8Array {
  expect(n, 0x03);
  if (!n.body.length || n.body[0] !== 0) throw new DerError('bad bit string');
  return n.body.subarray(1);
}

// --- PEM

export function toPem(label: string, der: Uint8Array): string {
  const b64 = decode(der, Enc.BASE64);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}${lines.length ? '\n' : ''}-----END ${label}-----\n`;
}

export interface PemBlock {
  label: string;
  headers: Record<string, string>;
  der: Uint8Array;
}

/** All PEM blocks in the text, in order. */
export function fromPem(text: string): PemBlock[] {
  const out: PemBlock[] = [];
  const re = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/g;
  for (let m; (m = re.exec(text)); ) {
    const headers: Record<string, string> = {};
    let body = m[2];
    if (/^\s*[A-Za-z-]+:/.test(body)) {
      const split = body.split(/\r?\n\r?\n/);
      for (const line of split[0].split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      body = split.slice(1).join('\n');
    }
    const b64 = body.replace(/[^A-Za-z0-9+/=]/g, '');
    const der = encode(b64, Enc.BASE64);
    out.push({ label: m[1], headers, der });
  }
  return out;
}
