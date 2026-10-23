// SM3 (GB/T 32905-2016), streaming, in the shape of the digests in digests.ts.

const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
const rotl = (x: number, n: number) => ((x << (n & 31)) | (x >>> ((32 - (n & 31)) & 31))) >>> 0;
const P0 = (x: number) => x ^ rotl(x, 9) ^ rotl(x, 17);
const P1 = (x: number) => x ^ rotl(x, 15) ^ rotl(x, 23);

export class SM3 {
  blockLen = 64;
  outputLen = 32;
  private v = Uint32Array.from(IV);
  private buf = new Uint8Array(64);
  private pos = 0;
  private len = 0;
  private w = new Uint32Array(68);

  private compress(b: Uint8Array, off: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = ((b[off + 4 * i] << 24) | (b[off + 4 * i + 1] << 16) | (b[off + 4 * i + 2] << 8) | b[off + 4 * i + 3]) >>> 0;
    for (let i = 16; i < 68; i++) w[i] = (P1(w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15)) ^ rotl(w[i - 13], 7) ^ w[i - 6]) >>> 0;
    const v = this.v;
    let [a, bb, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j++) {
      const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rotl((rotl(a, 12) + e + rotl(t, j)) >>> 0, 7);
      const ss2 = ss1 ^ rotl(a, 12);
      const ff = j < 16 ? a ^ bb ^ c : (a & bb) | (a & c) | (bb & c);
      const gg = j < 16 ? e ^ f ^ g : (e & f) | (~e & g);
      const tt1 = (ff + d + ss2 + (w[j] ^ w[j + 4])) >>> 0;
      const tt2 = (gg + h + ss1 + w[j]) >>> 0;
      d = c;
      c = rotl(bb, 9);
      bb = a;
      a = tt1;
      h = g;
      g = rotl(f, 19);
      f = e;
      e = P0(tt2) >>> 0;
    }
    v[0] ^= a;
    v[1] ^= bb;
    v[2] ^= c;
    v[3] ^= d;
    v[4] ^= e;
    v[5] ^= f;
    v[6] ^= g;
    v[7] ^= h;
  }

  update(data: Uint8Array): this {
    this.len += data.length;
    let i = 0;
    if (this.pos) {
      const n = Math.min(64 - this.pos, data.length);
      this.buf.set(data.subarray(0, n), this.pos);
      this.pos += n;
      i = n;
      if (this.pos < 64) return this;
      this.compress(this.buf, 0);
      this.pos = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.pos = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.len * 8;
    const pad = new Uint8Array(((this.pos + 9 + 63) & ~63) - this.pos);
    pad[0] = 0x80;
    const n = pad.length;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    pad[n - 8] = hi >>> 24;
    pad[n - 7] = hi >>> 16;
    pad[n - 6] = hi >>> 8;
    pad[n - 5] = hi;
    pad[n - 4] = lo >>> 24;
    pad[n - 3] = lo >>> 16;
    pad[n - 2] = lo >>> 8;
    pad[n - 1] = lo;
    const len = this.len;
    this.update(pad);
    this.len = len;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[4 * i] = this.v[i] >>> 24;
      out[4 * i + 1] = this.v[i] >>> 16;
      out[4 * i + 2] = this.v[i] >>> 8;
      out[4 * i + 3] = this.v[i];
    }
    return out;
  }

  clone(): SM3 {
    const c = new SM3();
    c.v.set(this.v);
    c.buf.set(this.buf);
    c.pos = this.pos;
    c.len = this.len;
    return c;
  }
}
