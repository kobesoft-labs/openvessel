// crypto_cipher.cc: CipherBase, getCiphers, getCipherInfo, getSSLCiphers — with the cipher modes
// implemented to OpenSSL 3's streaming semantics (what each update()/final() returns, and when it fails).

import { GHASH } from '@noble/ciphers/_polyval.js';
import { Poly1305 } from '@noble/ciphers/_poly1305.js';
import { aes, desEde, type BlockCipher } from './blockcipher.ts';
import { ChaChaStream } from './chacha.ts';
import { md5 } from '@noble/hashes/legacy.js';
import { CIPHERS, SSL_CIPHERS, type CipherInfo } from './tables.ts';
import { secretKeyBytes } from './keys.ts';
import { OSSL, concat, cryptoError, decodeInput, equalBytes, err, toBuffer, view } from './util.ts';

/** Thrown inside an engine when OpenSSL fails without queuing an error. */
const FAIL = Symbol('fail');

interface Engine {
  /** null: EVP_CipherUpdate failed */
  update(data: Uint8Array): Uint8Array | null;
  /** throws an OpenSSL error object or FAIL */
  final(): Uint8Array;
  padding?: boolean;
}

interface AeadEngine extends Engine {
  aad(data: Uint8Array): boolean;
  /** CCM only: the message length, before the AAD */
  setLength?(len: number): boolean;
  tag(len: number): Uint8Array;
  expectTag(tag: Uint8Array): void;
}

// -----------------------------------------------------------------------------
// block modes (ecb, cbc) with PKCS#7 padding — ossl_cipher_generic_block_update/final

class BlockMode implements Engine {
  padding = true;
  private buf: Uint8Array;
  private n = 0;
  private iv: Uint8Array | null;
  constructor(
    private c: BlockCipher,
    private enc: boolean,
    iv: Uint8Array | null,
  ) {
    this.buf = new Uint8Array(c.blockSize);
    this.iv = iv ? iv.slice() : null;
  }
  private block(src: Uint8Array, so: number, dst: Uint8Array, d: number) {
    const b = this.c.blockSize;
    const iv = this.iv;
    if (this.enc) {
      if (iv) {
        for (let i = 0; i < b; i++) dst[d + i] = src[so + i] ^ iv[i];
        this.c.encrypt(dst, d, dst, d);
        iv.set(dst.subarray(d, d + b));
      } else this.c.encrypt(src, so, dst, d);
    } else if (iv) {
      const saved = src.slice(so, so + b);
      this.c.decrypt(src, so, dst, d);
      for (let i = 0; i < b; i++) dst[d + i] ^= iv[i];
      iv.set(saved);
    } else this.c.decrypt(src, so, dst, d);
  }
  update(data: Uint8Array) {
    const b = this.c.blockSize;
    const all = this.n ? concat([this.buf.subarray(0, this.n), data]) : data;
    let process = all.length - (all.length % b);
    // decrypting with padding holds back a final full block in case it is the padded one
    if (!this.enc && this.padding && all.length > 0 && all.length % b === 0) process -= b;
    const out = new Uint8Array(process);
    for (let i = 0; i < process; i += b) this.block(all, i, out, i);
    this.n = all.length - process;
    this.buf.set(all.subarray(process));
    return out;
  }
  final() {
    const b = this.c.blockSize;
    if (this.enc) {
      if (this.padding) {
        const p = b - this.n;
        this.buf.fill(p, this.n);
      } else if (this.n === 0) return new Uint8Array(0);
      else throw OSSL.wrongFinalBlockLength();
      const out = new Uint8Array(b);
      this.block(this.buf, 0, out, 0);
      return out;
    }
    if (this.n !== b) {
      if (this.n === 0 && !this.padding) return new Uint8Array(0);
      throw OSSL.wrongFinalBlockLength();
    }
    const out = new Uint8Array(b);
    this.block(this.buf, 0, out, 0);
    if (!this.padding) return out;
    const p = out[b - 1];
    if (p === 0 || p > b) throw OSSL.badDecrypt();
    for (let i = b - p; i < b; i++) if (out[i] !== p) throw OSSL.badDecrypt();
    return out.subarray(0, b - p).slice();
  }
}

// -----------------------------------------------------------------------------
// stream modes

/** XORs a keystream produced block by block; `next` returns the next keystream block. */
class KeystreamMode implements Engine {
  private ks: Uint8Array = new Uint8Array(0);
  private pos = 0;
  constructor(private next: () => Uint8Array) {}
  update(data: Uint8Array) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.pos === this.ks.length) {
        this.ks = this.next();
        this.pos = 0;
      }
      out[i] = data[i] ^ this.ks[this.pos++];
    }
    return out;
  }
  final() {
    return new Uint8Array(0);
  }
}

function incBE(ctr: Uint8Array, from = 0) {
  for (let i = ctr.length - 1; i >= from; i--) {
    ctr[i] = (ctr[i] + 1) & 0xff;
    if (ctr[i] !== 0) break;
  }
}

function ctrMode(c: BlockCipher, iv: Uint8Array): Engine {
  const ctr = iv.slice();
  return new KeystreamMode(() => {
    const ks = new Uint8Array(c.blockSize);
    c.encrypt(ctr, 0, ks, 0);
    incBE(ctr); // the whole block is the counter (CRYPTO_ctr128_encrypt)
    return ks;
  });
}

function ofbMode(c: BlockCipher, iv: Uint8Array): Engine {
  const reg = iv.slice();
  return new KeystreamMode(() => {
    c.encrypt(reg, 0, reg, 0);
    return reg.slice();
  });
}

/** Full-block CFB (cfb128 / cfb64): the feedback register is the previous ciphertext block. */
class CfbMode implements Engine {
  private reg: Uint8Array;
  private ks: Uint8Array;
  private pos: number;
  constructor(
    private c: BlockCipher,
    private enc: boolean,
    iv: Uint8Array,
  ) {
    this.reg = iv.slice();
    this.ks = new Uint8Array(c.blockSize);
    this.pos = c.blockSize;
  }
  update(data: Uint8Array) {
    const b = this.c.blockSize;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.pos === b) {
        this.c.encrypt(this.reg, 0, this.ks, 0);
        this.pos = 0;
      }
      const o = data[i] ^ this.ks[this.pos];
      this.reg[this.pos++] = this.enc ? o : data[i];
      out[i] = o;
    }
    return out;
  }
  final() {
    return new Uint8Array(0);
  }
}

/** CFB8 and CFB1: shift the register by 8 or 1 bits per step. */
class CfbShiftMode implements Engine {
  private reg: Uint8Array;
  private tmp: Uint8Array;
  constructor(
    private c: BlockCipher,
    private enc: boolean,
    iv: Uint8Array,
    private bits: 1 | 8,
  ) {
    this.reg = iv.slice();
    this.tmp = new Uint8Array(c.blockSize);
  }
  private shiftIn(bit: number, nbits: number) {
    const r = this.reg;
    if (nbits === 8) {
      r.copyWithin(0, 1);
      r[r.length - 1] = bit;
      return;
    }
    for (let i = 0; i < r.length - 1; i++) r[i] = ((r[i] << 1) | (r[i + 1] >>> 7)) & 0xff;
    r[r.length - 1] = ((r[r.length - 1] << 1) | bit) & 0xff;
  }
  update(data: Uint8Array) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.bits === 8) {
        this.c.encrypt(this.reg, 0, this.tmp, 0);
        const o = data[i] ^ this.tmp[0];
        this.shiftIn(this.enc ? o : data[i], 8);
        out[i] = o;
        continue;
      }
      let byte = 0;
      for (let k = 7; k >= 0; k--) {
        this.c.encrypt(this.reg, 0, this.tmp, 0);
        const inBit = (data[i] >>> k) & 1;
        const o = inBit ^ (this.tmp[0] >>> 7);
        this.shiftIn(this.enc ? o : inBit, 1);
        byte |= o << k;
      }
      out[i] = byte;
    }
    return out;
  }
  final() {
    return new Uint8Array(0);
  }
}

// -----------------------------------------------------------------------------
// GCM

class GcmMode implements AeadEngine {
  private h: Uint8Array;
  private j0: Uint8Array;
  private ghash: GHASH;
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private aadLen = 0;
  private ctLen = 0;
  private inAad = true;
  private stream: Engine;
  private expected: Uint8Array | null = null;
  private tagValue: Uint8Array | null = null;
  constructor(
    private c: BlockCipher,
    private enc: boolean,
    iv: Uint8Array,
  ) {
    this.h = new Uint8Array(16);
    c.encrypt(this.h, 0, this.h, 0);
    this.ghash = new GHASH(this.h);
    if (iv.length === 12) {
      this.j0 = new Uint8Array(16);
      this.j0.set(iv);
      this.j0[15] = 1;
    } else {
      const g = new GHASH(this.h);
      const padded = new Uint8Array(Math.ceil(iv.length / 16) * 16 + 16);
      padded.set(iv);
      const bits = iv.length * 8;
      const dv = new DataView(padded.buffer);
      dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
      dv.setUint32(padded.length - 4, bits >>> 0);
      g.update(padded);
      this.j0 = g.digest();
    }
    const ctr = this.j0.slice();
    this.stream = new KeystreamMode(() => {
      incBE(ctr, 12); // inc32
      const ks = new Uint8Array(16);
      c.encrypt(ctr, 0, ks, 0);
      return ks;
    });
  }
  /** Feeds GHASH in whole blocks; `flush` zero-pads the tail. */
  private feed(data: Uint8Array, flush = false) {
    if (data.length) {
      this.pending.push(data);
      this.pendingLen += data.length;
    }
    if (this.pendingLen < 16 && !flush) return;
    const all = concat(this.pending);
    const whole = all.length - (all.length % 16);
    if (whole) this.ghash.update(all.subarray(0, whole));
    const rest = all.subarray(whole);
    this.pending = [];
    this.pendingLen = 0;
    if (flush) {
      if (rest.length) this.ghash.update(rest); // GHASH.update zero-pads a partial block
    } else if (rest.length) {
      this.pending.push(rest.slice());
      this.pendingLen = rest.length;
    }
  }
  aad(data: Uint8Array) {
    if (!this.inAad || this.ctLen > 0) return false;
    this.aadLen += data.length;
    this.feed(data);
    return true;
  }
  update(data: Uint8Array) {
    if (data.length === 0) return new Uint8Array(0);
    if (this.inAad) {
      this.feed(new Uint8Array(0), true);
      this.inAad = false;
    }
    const out = this.stream.update(data)!;
    this.ctLen += data.length;
    this.feed(this.enc ? out : data.slice());
    return out;
  }
  private computeTag() {
    if (this.inAad) {
      this.feed(new Uint8Array(0), true);
      this.inAad = false;
    }
    this.feed(new Uint8Array(0), true);
    const lens = new Uint8Array(16);
    const dv = new DataView(lens.buffer);
    const a = this.aadLen * 8;
    const c = this.ctLen * 8;
    dv.setUint32(0, Math.floor(a / 0x100000000));
    dv.setUint32(4, a >>> 0);
    dv.setUint32(8, Math.floor(c / 0x100000000));
    dv.setUint32(12, c >>> 0);
    this.ghash.update(lens);
    const s = this.ghash.digest();
    const ej0 = new Uint8Array(16);
    this.c.encrypt(this.j0, 0, ej0, 0);
    for (let i = 0; i < 16; i++) s[i] ^= ej0[i];
    return s;
  }
  expectTag(tag: Uint8Array) {
    this.expected = tag;
  }
  final() {
    const t = this.computeTag();
    if (this.enc) this.tagValue = t;
    else if (!this.expected || !equalBytes(t.subarray(0, this.expected.length), this.expected)) throw FAIL;
    return new Uint8Array(0);
  }
  tag(len: number) {
    return this.tagValue!.slice(0, len);
  }
}

// -----------------------------------------------------------------------------
// CCM (RFC 3610 / SP 800-38C) — one message per context, like OpenSSL

class CcmMode implements AeadEngine {
  private msgLen = -1;
  private aadData: Uint8Array | null = null;
  private done = false;
  private expected: Uint8Array | null = null;
  private tagValue: Uint8Array | null = null;
  constructor(
    private c: BlockCipher,
    private enc: boolean,
    private nonce: Uint8Array,
    private M: number,
  ) {}
  setLength(len: number) {
    if (this.done) return false;
    this.msgLen = len;
    return true;
  }
  aad(data: Uint8Array) {
    if (this.done) return false;
    this.aadData = data.slice(); // a later setAAD replaces the earlier one, as in OpenSSL
    return true;
  }
  expectTag(tag: Uint8Array) {
    this.expected = tag;
  }
  private block(i: number, flags: number): Uint8Array {
    const q = 15 - this.nonce.length;
    const b = new Uint8Array(16);
    b[0] = flags;
    b.set(this.nonce, 1);
    for (let k = 0; k < q; k++) b[15 - k] = k < 6 ? Math.floor(i / 2 ** (8 * k)) & 0xff : 0;
    return b;
  }
  private mac(msg: Uint8Array): Uint8Array {
    const q = 15 - this.nonce.length;
    const aad = this.aadData ?? new Uint8Array(0);
    const flags = (aad.length ? 0x40 : 0) | (((this.M - 2) / 2) << 3) | (q - 1);
    const x = this.block(msg.length, flags);
    this.c.encrypt(x, 0, x, 0);
    const absorb = (data: Uint8Array) => {
      for (let i = 0; i < data.length; i += 16) {
        for (let j = 0; j < 16 && i + j < data.length; j++) x[j] ^= data[i + j];
        this.c.encrypt(x, 0, x, 0);
      }
    };
    if (aad.length) {
      const hdr = aad.length < 0xff00 ? [aad.length >> 8, aad.length & 0xff] : [0xff, 0xfe, aad.length >>> 24, (aad.length >>> 16) & 0xff, (aad.length >>> 8) & 0xff, aad.length & 0xff];
      absorb(concat([Uint8Array.from(hdr), aad]));
    }
    absorb(msg);
    return x;
  }
  private ctr(data: Uint8Array): Uint8Array {
    const q = 15 - this.nonce.length;
    const out = new Uint8Array(data.length);
    const ks = new Uint8Array(16);
    for (let i = 0; i < data.length; i += 16) {
      const a = this.block(i / 16 + 1, q - 1);
      this.c.encrypt(a, 0, ks, 0);
      for (let j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
    }
    return out;
  }
  private s0(): Uint8Array {
    const q = 15 - this.nonce.length;
    const a = this.block(0, q - 1);
    this.c.encrypt(a, 0, a, 0);
    return a;
  }
  private broken = false;
  update(data: Uint8Array): Uint8Array | null {
    if (this.done || (this.msgLen >= 0 && this.msgLen !== data.length)) {
      this.broken = true;
      return null;
    }
    this.done = true;
    this.msgLen = data.length;
    const s0 = this.s0();
    if (this.enc) {
      const t = this.mac(data);
      for (let i = 0; i < 16; i++) t[i] ^= s0[i];
      this.tagValue = t.subarray(0, this.M).slice();
      return this.ctr(data);
    }
    const pt = this.ctr(data);
    const t = this.mac(pt);
    for (let i = 0; i < 16; i++) t[i] ^= s0[i];
    if (!this.expected || !equalBytes(t.subarray(0, this.M), this.expected)) return null;
    return pt;
  }
  final() {
    if (this.broken) throw FAIL;
    // OpenSSL 3.5.9 (Node 22.23): with no update, encryption finishes as an empty message
    if (this.enc && !this.done && this.update(new Uint8Array(0)) === null) throw FAIL;
    return new Uint8Array(0);
  }
  tag(len: number) {
    return (this.tagValue ?? new Uint8Array(this.M)).slice(0, len);
  }
}

// -----------------------------------------------------------------------------
// ChaCha20-Poly1305 (RFC 8439)

class ChaChaPolyMode implements AeadEngine {
  // Follows OpenSSL's chacha20_poly1305_aead_cipher: AAD is MACed as it arrives (even after
  // text) and padded when the next text update or the final comes.
  private stream: ChaChaStream;
  private poly: Poly1305;
  private aadLen = 0;
  private ctLen = 0;
  private aadPending = false;
  private expected: Uint8Array | null = null;
  private tagValue: Uint8Array | null = null;
  constructor(
    key: Uint8Array,
    nonce: Uint8Array,
    private enc: boolean,
  ) {
    const cn = new Uint8Array(16);
    cn.set(nonce, 4);
    this.stream = new ChaChaStream(key, cn);
    const otk = this.stream.xor(new Uint8Array(64)).subarray(0, 32);
    this.poly = new Poly1305(otk);
  }
  private pad(len: number) {
    if (len % 16) this.poly.update(new Uint8Array(16 - (len % 16)));
  }
  private wrapUpAad() {
    if (this.aadPending) {
      this.pad(this.aadLen);
      this.aadPending = false;
    }
  }
  aad(data: Uint8Array) {
    // Node 22.23+ rejects AAD once text has gone through (ERR_CRYPTO_INVALID_STATE in lib)
    if (this.ctLen > 0) return false;
    this.poly.update(data);
    this.aadLen += data.length;
    this.aadPending = true;
    return true;
  }
  update(data: Uint8Array) {
    this.wrapUpAad();
    const out = this.stream.xor(data);
    this.poly.update(this.enc ? out : data);
    this.ctLen += data.length;
    return out;
  }
  expectTag(tag: Uint8Array) {
    this.expected = tag;
  }
  final() {
    this.wrapUpAad();
    this.pad(this.ctLen);
    const lens = new Uint8Array(16);
    const dv = new DataView(lens.buffer);
    dv.setUint32(0, this.aadLen >>> 0, true);
    dv.setUint32(4, Math.floor(this.aadLen / 0x100000000), true);
    dv.setUint32(8, this.ctLen >>> 0, true);
    dv.setUint32(12, Math.floor(this.ctLen / 0x100000000), true);
    this.poly.update(lens);
    const t = this.poly.digest();
    if (this.enc) this.tagValue = t;
    else if (!this.expected || !equalBytes(t.subarray(0, this.expected.length), this.expected)) throw FAIL;
    return new Uint8Array(0);
  }
  tag(len: number) {
    return this.tagValue!.slice(0, len);
  }
}

// -----------------------------------------------------------------------------
// AES key wrap (RFC 3394) and key wrap with padding (RFC 5649)

class WrapMode implements Engine {
  constructor(
    private c: BlockCipher,
    private enc: boolean,
    private iv: Uint8Array,
    private pad: boolean,
  ) {}
  private wrapCore(a: Uint8Array, r: Uint8Array): Uint8Array {
    const n = r.length / 8;
    const b = new Uint8Array(16);
    for (let j = 0; j < 6; j++) {
      for (let i = 1; i <= n; i++) {
        b.set(a, 0);
        b.set(r.subarray((i - 1) * 8, i * 8), 8);
        this.c.encrypt(b, 0, b, 0);
        const t = n * j + i;
        a.set(b.subarray(0, 8));
        for (let k = 0; k < 4; k++) a[7 - k] ^= (t >>> (8 * k)) & 0xff;
        r.set(b.subarray(8), (i - 1) * 8);
      }
    }
    return concat([a, r]);
  }
  private unwrapCore(c: Uint8Array): [Uint8Array, Uint8Array] {
    const n = c.length / 8 - 1;
    const a = c.slice(0, 8);
    const r = c.slice(8);
    const b = new Uint8Array(16);
    for (let j = 5; j >= 0; j--) {
      for (let i = n; i >= 1; i--) {
        const t = n * j + i;
        for (let k = 0; k < 4; k++) a[7 - k] ^= (t >>> (8 * k)) & 0xff;
        b.set(a, 0);
        b.set(r.subarray((i - 1) * 8, i * 8), 8);
        this.c.decrypt(b, 0, b, 0);
        a.set(b.subarray(0, 8));
        r.set(b.subarray(8), (i - 1) * 8);
      }
    }
    return [a, r];
  }
  update(data: Uint8Array): Uint8Array | null {
    if (data.length === 0) return new Uint8Array(0);
    if (this.enc) {
      if (!this.pad) {
        if (data.length < 16 || data.length % 8) return null;
        return this.wrapCore(this.iv.slice(), data.slice());
      }
      const mli = data.length;
      const padded = new Uint8Array(Math.ceil(mli / 8) * 8);
      padded.set(data);
      const a = new Uint8Array(8);
      a.set(this.iv.subarray(0, 4));
      new DataView(a.buffer).setUint32(4, mli);
      if (padded.length === 8) {
        const b = concat([a, padded]);
        this.c.encrypt(b, 0, b, 0);
        return b;
      }
      return this.wrapCore(a, padded);
    }
    if (data.length % 8 || data.length < (this.pad ? 16 : 24)) return null;
    if (!this.pad) {
      const [a, r] = this.unwrapCore(data);
      return equalBytes(a, this.iv) ? r : null;
    }
    let a: Uint8Array;
    let r: Uint8Array;
    if (data.length === 16) {
      const b = data.slice();
      this.c.decrypt(b, 0, b, 0);
      a = b.slice(0, 8);
      r = b.slice(8);
    } else [a, r] = this.unwrapCore(data);
    if (!equalBytes(a.subarray(0, 4), this.iv.subarray(0, 4))) return null;
    const mli = new DataView(a.buffer, a.byteOffset).getUint32(4);
    if (mli > r.length || mli <= r.length - 8) return null;
    for (let i = mli; i < r.length; i++) if (r[i] !== 0) return null;
    return r.slice(0, mli);
  }
  final() {
    return new Uint8Array(0);
  }
}

// -----------------------------------------------------------------------------
// cipher lookup

export function findCipher(name: unknown): CipherInfo | undefined {
  if (typeof name !== 'string') return undefined;
  return CIPHERS[name.replace(/ +$/, '').toLowerCase()];
}

function findByNid(nid: number): CipherInfo | undefined {
  for (const k in CIPHERS) if (CIPHERS[k].nid === nid) return CIPHERS[k];
  return undefined;
}

const isChaChaPoly = (info: CipherInfo) => info.nid === 1018;
const isChaCha = (info: CipherInfo) => info.nid === 1019;
const isAuthMode = (info: CipherInfo) => info.mode === 'gcm' || info.mode === 'ccm' || isChaChaPoly(info);
const isDes = (info: CipherInfo) => /^des/i.test(info.name);
const isValidGcmTagLength = (n: number) => n === 4 || n === 8 || (n >= 12 && n <= 16);

/** The OpenSSL block size (EVP_CIPHER_block_size). */
function blockSizeOf(info: CipherInfo) {
  return info.blockSize ?? 1;
}

function makeEngine(info: CipherInfo, key: Uint8Array, iv: Uint8Array, enc: boolean, tagLen: number): Engine {
  if (isChaChaPoly(info)) return new ChaChaPolyMode(key, iv, enc);
  if (isChaCha(info)) {
    const s = new ChaChaStream(key, iv);
    return { update: (d) => s.xor(d), final: () => new Uint8Array(0) };
  }
  const c = isDes(info) ? desEde(key) : aes(key);
  const name = info.name.toLowerCase();
  switch (info.mode) {
    case 'ecb':
      return new BlockMode(c, enc, null);
    case 'cbc':
      return new BlockMode(c, enc, iv);
    case 'ctr':
      return ctrMode(c, iv);
    case 'ofb':
      return ofbMode(c, iv);
    case 'cfb':
      if (name.endsWith('cfb1')) return new CfbShiftMode(c, enc, iv, 1);
      if (name.endsWith('cfb8')) return new CfbShiftMode(c, enc, iv, 8);
      return new CfbMode(c, enc, iv);
    case 'gcm':
      return new GcmMode(c, enc, iv);
    case 'ccm':
      return new CcmMode(c, enc, iv, tagLen);
    case 'wrap':
      return new WrapMode(c, enc, iv, name.includes('pad'));
  }
  throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
}

const kAuthTagUnknown = 0;
const kAuthTagKnown = 1;
const kAuthTagPassed = 2;
const INT_MAX = 2147483647;

export class CipherBase {
  #encrypt: boolean;
  #info: CipherInfo | null = null;
  #ctx: Engine | null = null;
  #authTagLen = -1;
  #authTag: Uint8Array | null = null;
  #authTagState = kAuthTagUnknown;
  #pendingAuthFailed = false;
  #maxMessageSize = INT_MAX;

  constructor(isEncrypt: unknown) {
    this.#encrypt = isEncrypt === true;
  }

  #commonInit(cipherType: string, info: CipherInfo, key: Uint8Array, iv: Uint8Array, authTagLen: number) {
    if (isAuthMode(info) && !this.#initAuthenticated(cipherType, info, iv.length, authTagLen)) return;
    if (key.length !== info.keyLength) throw err('ERR_CRYPTO_INVALID_KEYLEN');
    this.#info = info;
    this.#ctx = makeEngine(info, key, iv, this.#encrypt, this.#authTagLen);
  }

  #initAuthenticated(cipherType: string, info: CipherInfo, ivLen: number, authTagLen: number): boolean {
    const ivOk = info.mode === 'gcm' ? ivLen > 0 : info.mode === 'ccm' ? ivLen >= 7 && ivLen <= 13 : ivLen === 12;
    if (!ivOk) throw err('ERR_CRYPTO_INVALID_IV');
    if (info.mode === 'gcm') {
      if (authTagLen !== -1) {
        if (!isValidGcmTagLength(authTagLen)) throw err('ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${authTagLen}`);
        this.#authTagLen = authTagLen;
      }
      return true;
    }
    if (authTagLen === -1) {
      if (isChaChaPoly(info)) authTagLen = 16;
      else throw err('ERR_CRYPTO_INVALID_AUTH_TAG', `authTagLength required for ${cipherType}`);
    }
    const tagOk = info.mode === 'ccm' ? authTagLen >= 4 && authTagLen <= 16 && authTagLen % 2 === 0 : authTagLen >= 1 && authTagLen <= 16;
    if (!tagOk) throw err('ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${authTagLen}`);
    this.#authTagLen = authTagLen;
    if (info.mode === 'ccm') {
      this.#maxMessageSize = ivLen === 12 ? 16777215 : ivLen === 13 ? 65535 : INT_MAX;
    }
    return true;
  }

  // init(cipher, password, authTagLength): the deprecated createCipher (EVP_BytesToKey with MD5)
  init(cipherType: string, password: unknown, authTagLength: number) {
    const info = findCipher(cipherType);
    if (!info) throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
    const pass = view(password);
    const keyLen = info.keyLength;
    const ivLen = info.ivLength ?? 0;
    const material: Uint8Array[] = [];
    let have = 0;
    let prev = new Uint8Array(0);
    while (have < keyLen + ivLen) {
      prev = md5(concat([prev, pass])) as Uint8Array<ArrayBuffer>;
      material.push(prev);
      have += prev.length;
    }
    const all = concat(material);
    this.#commonInit(cipherType, info, all.subarray(0, keyLen), all.subarray(keyLen, keyLen + ivLen), authTagLength);
  }

  // initiv(cipher, key, iv | null, authTagLength)
  initiv(cipherType: string, key: unknown, iv: unknown, authTagLength: number) {
    const info = findCipher(cipherType);
    if (!info) throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
    const k = secretKeyBytes(key);
    const ivb = iv === null || iv === undefined ? new Uint8Array(0) : view(iv);
    const expected = info.ivLength ?? 0;
    const hasIv = ivb.length > 0;
    if (!hasIv && expected !== 0) throw err('ERR_CRYPTO_INVALID_IV');
    if (!isAuthMode(info) && hasIv && ivb.length !== expected) throw err('ERR_CRYPTO_INVALID_IV');
    if (isChaChaPoly(info) && ivb.length > 12) throw err('ERR_CRYPTO_INVALID_IV');
    this.#commonInit(cipherType, info, k, ivb.slice(), authTagLength);
  }

  #isAuth() {
    return !!this.#info && isAuthMode(this.#info);
  }

  #passTag() {
    if (this.#authTagState === kAuthTagKnown) {
      (this.#ctx as AeadEngine).expectTag(this.#authTag!);
      this.#authTagState = kAuthTagPassed;
    }
  }

  update(data: unknown, encoding?: unknown) {
    const input = decodeInput(data, encoding);
    const ctx = this.#ctx;
    if (!ctx) throw cryptoError('Trying to add data in unsupported state');
    const info = this.#info!;
    if (info.mode === 'ccm' && input.length > this.#maxMessageSize) throw err('ERR_CRYPTO_INVALID_MESSAGELEN');
    if (!this.#encrypt && this.#isAuth()) this.#passTag();
    const out = ctx.update(input);
    if (out === null) {
      if (!this.#encrypt && info.mode === 'ccm') {
        this.#pendingAuthFailed = true;
        return toBuffer(new Uint8Array(0));
      }
      throw cryptoError('Trying to add data in unsupported state');
    }
    return toBuffer(out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out : out.slice());
  }

  final() {
    const ctx = this.#ctx;
    if (!ctx) throw err('ERR_CRYPTO_INVALID_STATE');
    const isAuth = this.#isAuth();
    const info = this.#info!;
    if (!this.#encrypt && isAuth) this.#passTag();
    this.#ctx = null;
    let out: Uint8Array;
    try {
      if (!this.#encrypt && info.mode === 'ccm') {
        if (this.#pendingAuthFailed) throw FAIL;
        out = new Uint8Array(0);
      } else {
        out = ctx.final();
        if (this.#encrypt && isAuth) {
          if (this.#authTagLen === -1) this.#authTagLen = 16;
          this.#authTag = (ctx as AeadEngine).tag(this.#authTagLen);
        }
      }
    } catch (e) {
      if (this.#encrypt && isAuth && this.#authTagLen !== -1) this.#authTag = new Uint8Array(this.#authTagLen);
      if (e !== FAIL) throw e;
      throw cryptoError(isAuth ? 'Unsupported state or unable to authenticate data' : 'Unsupported state');
    }
    return toBuffer(out.slice());
  }

  setAutoPadding(on?: unknown) {
    if (!this.#ctx) return false;
    this.#ctx.padding = on === undefined || on === true;
    return true;
  }

  getAuthTag() {
    if (this.#ctx || !this.#encrypt || this.#authTagLen === -1 || !this.#authTag) return undefined;
    return toBuffer(this.#authTag.slice());
  }

  setAuthTag(tag: unknown) {
    if (!this.#ctx || !this.#isAuth() || this.#encrypt || this.#authTagState !== kAuthTagUnknown) return false;
    const t = view(tag);
    const len = t.length;
    const valid = this.#info!.mode === 'gcm' ? (this.#authTagLen === -1 || this.#authTagLen === len) && isValidGcmTagLength(len) : this.#authTagLen === len;
    if (!valid) throw err('ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${len}`);
    this.#authTagLen = len;
    this.#authTagState = kAuthTagKnown;
    this.#authTag = t.slice();
    return true;
  }

  setAAD(aad: unknown, plaintextLength: number) {
    const ctx = this.#ctx as AeadEngine | null;
    if (!ctx || !this.#isAuth()) return false;
    const data = view(aad);
    if (this.#info!.mode === 'ccm') {
      if (plaintextLength < 0) throw err('ERR_MISSING_ARGS', 'options.plaintextLength required for CCM mode with AAD');
      if (plaintextLength > this.#maxMessageSize) throw err('ERR_CRYPTO_INVALID_MESSAGELEN');
      if (!this.#encrypt) this.#passTag();
      if (!ctx.setLength!(plaintextLength)) return false;
    }
    return ctx.aad(data);
  }
}

// -----------------------------------------------------------------------------

/** EVP_CIPHER_do_all_sorted names, restricted to the ciphers implemented here. */
export function getCiphers() {
  return Object.keys(CIPHERS).map((k) => (k.startsWith('id-aes') ? k.replace(/-(gcm|ccm)$/, (m) => m.toUpperCase()) : k));
}

export function getSSLCiphers() {
  return SSL_CIPHERS.slice();
}

// getCipherInfo(target, nameOrNid, keyLength, ivLength)
export function getCipherInfo(target: any, nameOrNid: unknown, keyLength?: number, ivLength?: number) {
  const info = typeof nameOrNid === 'number' ? findByNid(nameOrNid) : findCipher(nameOrNid);
  if (!info) return undefined;
  let keyLen = info.keyLength;
  let ivLen = info.ivLength ?? 0;
  if (typeof keyLength === 'number') {
    if (keyLength !== info.keyLength) return undefined;
    keyLen = keyLength;
  }
  if (typeof ivLength === 'number') {
    if (info.mode === 'ccm') {
      if (ivLength < 7 || ivLength > 13) return undefined;
    } else if (info.mode === 'gcm') {
      if (ivLength <= 0) return undefined;
    } else if (ivLength !== ivLen) return undefined;
    ivLen = ivLength;
  }
  if (info.mode) target.mode = info.mode;
  target.name = info.name;
  target.nid = info.nid;
  if (info.mode !== 'stream') target.blockSize = blockSizeOf(info);
  if (ivLen !== 0) target.ivLength = ivLen;
  target.keyLength = keyLen;
  return target;
}
