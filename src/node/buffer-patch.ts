// Extends the `buffer` package with what newer Node versions have (base64url, etc.).

import { Buffer } from 'buffer';

const B: any = Buffer;
const proto: any = Buffer.prototype;
const toB64 = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return t + '='.repeat((4 - (t.length % 4)) % 4);
};

const origToString = proto.toString;
proto.toString = function (this: Buffer, enc?: string, start?: number, end?: number) {
  if (typeof enc === 'string' && enc.toLowerCase() === 'base64url') {
    return origToString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return origToString.call(this, enc, start, end);
};

const origFrom = B.from;
B.from = function (value: any, enc?: any, len?: any) {
  if (typeof value === 'string' && typeof enc === 'string' && enc.toLowerCase() === 'base64url') return origFrom.call(B, toB64(value), 'base64');
  return origFrom.call(B, value, enc, len);
};

const origByteLength = B.byteLength;
B.byteLength = function (s: any, enc?: any) {
  if (typeof s === 'string' && typeof enc === 'string' && enc.toLowerCase() === 'base64url') return origByteLength.call(B, toB64(s), 'base64');
  return origByteLength.call(B, s, enc);
};

const origIsEncoding = B.isEncoding;
B.isEncoding = (e: string) => (typeof e === 'string' && e.toLowerCase() === 'base64url') || origIsEncoding(e);

const origWrite = proto.write;
proto.write = function (this: Buffer, s: string, ...rest: any[]) {
  const encIdx = rest.findIndex((a) => typeof a === 'string');
  if (encIdx !== -1 && rest[encIdx].toLowerCase() === 'base64url') {
    rest[encIdx] = 'base64';
    s = toB64(s);
  }
  return origWrite.call(this, s, ...rest);
};

if (!B.copyBytesFrom) {
  B.copyBytesFrom = (view: ArrayBufferView, offset = 0, length?: number) => {
    const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const el = (view as any).BYTES_PER_ELEMENT ?? 1;
    return origFrom.call(B, u8.slice(offset * el, length === undefined ? undefined : (offset + length) * el));
  };
}
if (!proto.toLocaleString) proto.toLocaleString = proto.toString;

export { Buffer };
