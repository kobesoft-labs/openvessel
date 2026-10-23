// node:string_decoder

import { Buffer } from 'buffer';

function normEnc(e?: string): string {
  const s = String(e ?? 'utf8').toLowerCase();
  switch (s) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'base64':
    case 'base64url':
    case 'hex':
    case 'ascii':
      return s;
  }
  const err = new TypeError(`Unknown encoding: ${e}`) as TypeError & { code: string };
  err.code = 'ERR_UNKNOWN_ENCODING';
  throw err;
}

export class StringDecoder {
  encoding: string;
  private td?: TextDecoder;
  private pending: Uint8Array = new Uint8Array(0);
  constructor(encoding?: string) {
    this.encoding = normEnc(encoding);
    if (this.encoding === 'utf8') this.td = new TextDecoder('utf-8');
    else if (this.encoding === 'utf16le') this.td = new TextDecoder('utf-16le');
  }
  write(buf: Uint8Array | string): string {
    if (typeof buf === 'string') return buf;
    if (this.td) return this.td.decode(buf, { stream: true });
    const unit = this.encoding === 'base64' || this.encoding === 'base64url' ? 3 : 1;
    let data = buf;
    if (this.pending.length) {
      const c = new Uint8Array(this.pending.length + buf.length);
      c.set(this.pending);
      c.set(buf, this.pending.length);
      data = c;
    }
    const keep = data.length % unit;
    this.pending = data.slice(data.length - keep);
    return Buffer.from(data.buffer, data.byteOffset, data.length - keep).toString(this.encoding as BufferEncoding);
  }
  end(buf?: Uint8Array): string {
    let out = buf ? this.write(buf) : '';
    if (this.td) out += this.td.decode();
    else if (this.pending.length) {
      out += Buffer.from(this.pending).toString(this.encoding as BufferEncoding);
      this.pending = new Uint8Array(0);
    }
    return out;
  }
  text(buf: Uint8Array, offset: number) {
    return this.write(buf.subarray(offset));
  }
  get lastNeed() {
    return 0;
  }
  get lastTotal() {
    return 0;
  }
}

export default { StringDecoder };
