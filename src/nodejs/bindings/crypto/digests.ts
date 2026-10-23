// The message digests OpenSSL 3 exposes through EVP_get_digestbyname, backed by @noble/hashes,
// plus generic HMAC / PBKDF2 / HKDF over them.

import { md5, sha1, ripemd160 } from '@noble/hashes/legacy.js';
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js';
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from '@noble/hashes/sha3.js';
import { blake2b, blake2s } from '@noble/hashes/blake2.js';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2.js';
import { SM3 } from './sm3.ts';
import { HASH_ALIASES } from './tables.ts';

/** A running digest context (EVP_MD_CTX). */
export interface Ctx {
  update(b: Uint8Array): unknown;
  /** Final output; `len` only for XOFs. */
  final(len?: number): Uint8Array;
  clone(): Ctx;
}

export interface DigestAlgo {
  /** Node's alias-cache id (crypto_hash.cc's EVP_MD list order). */
  id: number;
  /** OBJ_nid2sn-style name */
  name: string;
  size: number;
  block: number;
  xof?: boolean;
  /** the @noble/hashes function, when there is one (fast paths for PBKDF2) */
  noble?: any;
  create(): Ctx;
}

function wrapNoble(h: any, xof = false): Ctx {
  return {
    update: (b) => h.update(b),
    final: (len) => (xof ? (len === 0 ? new Uint8Array(0) : h.xof(len)) : h.digest()),
    clone: () => wrapNoble(h.clone(), xof),
  };
}

function nobleAlgo(id: number, name: string, fn: any, xofSize = 0): DigestAlgo {
  const xof = xofSize > 0;
  return {
    id,
    name,
    size: xof ? xofSize : fn.outputLen,
    block: fn.blockLen,
    xof: xof || undefined,
    noble: xof ? undefined : fn,
    create: () => wrapNoble(fn.create(), xof),
  };
}

function md5sha1(): Ctx {
  const a = md5.create();
  const b = sha1.create();
  const make = (x: any, y: any): Ctx => ({
    update: (d) => {
      x.update(d);
      y.update(d);
    },
    final: () => {
      const out = new Uint8Array(36);
      out.set(x.digest(), 0);
      out.set(y.digest(), 16);
      return out;
    },
    clone: () => make(x.clone(), y.clone()),
  });
  return make(a, b);
}

function sm3Ctx(h = new SM3()): Ctx {
  return { update: (d) => h.update(d), final: () => h.digest(), clone: () => sm3Ctx(h.clone()) };
}

/** Indexed by Node's cache id. */
export const ALGOS: DigestAlgo[] = [
  nobleAlgo(0, 'MD5', md5),
  nobleAlgo(1, 'RIPEMD160', ripemd160),
  nobleAlgo(2, 'SHA1', sha1),
  nobleAlgo(3, 'SHA224', sha224),
  nobleAlgo(4, 'SHA256', sha256),
  nobleAlgo(5, 'SHA3-224', sha3_224),
  nobleAlgo(6, 'SHA3-256', sha3_256),
  nobleAlgo(7, 'SHA3-384', sha3_384),
  nobleAlgo(8, 'SHA3-512', sha3_512),
  nobleAlgo(9, 'SHA384', sha384),
  nobleAlgo(10, 'SHA512', sha512),
  nobleAlgo(11, 'SHA512-224', sha512_224),
  nobleAlgo(12, 'SHA512-256', sha512_256),
  { id: 13, name: 'SM3', size: 32, block: 64, create: () => sm3Ctx() },
  nobleAlgo(14, 'BLAKE2B512', blake2b),
  nobleAlgo(15, 'BLAKE2S256', blake2s),
  { id: 16, name: 'MD5-SHA1', size: 36, block: 64, create: md5sha1 },
  nobleAlgo(17, 'SHAKE128', shake128, 16),
  nobleAlgo(18, 'SHAKE256', shake256, 32),
];

// Names accepted by EVP_get_digestbyname (case-insensitive) beyond the alias cache.
const EXTRA: Record<string, number> = {
  'rsa-md5': 0, md5: 0, 'ssl3-md5': 0, md5withrsaencryption: 0,
  'rsa-ripemd160': 1, ripemd: 1, ripemd160: 1, rmd160: 1, ripemd160withrsa: 1,
  'rsa-sha1': 2, 'rsa-sha1-2': 2, sha1: 2, sha1withrsaencryption: 2, 'ssl3-sha1': 2,
  'rsa-sha224': 3, sha224: 3, sha224withrsaencryption: 3,
  'rsa-sha256': 4, sha256: 4, sha256withrsaencryption: 4,
  'rsa-sha3-224': 5, 'sha3-224': 5, 'id-rsassa-pkcs1-v1_5-with-sha3-224': 5,
  'rsa-sha3-256': 6, 'sha3-256': 6, 'id-rsassa-pkcs1-v1_5-with-sha3-256': 6,
  'rsa-sha3-384': 7, 'sha3-384': 7, 'id-rsassa-pkcs1-v1_5-with-sha3-384': 7,
  'rsa-sha3-512': 8, 'sha3-512': 8, 'id-rsassa-pkcs1-v1_5-with-sha3-512': 8,
  'rsa-sha384': 9, sha384: 9, sha384withrsaencryption: 9,
  'rsa-sha512': 10, sha512: 10, sha512withrsaencryption: 10,
  'rsa-sha512/224': 11, 'sha512-224': 11, 'sha512-224withrsaencryption': 11,
  'rsa-sha512/256': 12, 'sha512-256': 12, 'sha512-256withrsaencryption': 12,
  'rsa-sm3': 13, sm3: 13, sm3withrsaencryption: 13,
  blake2b512: 14,
  blake2s256: 15,
  'md5-sha1': 16,
  shake128: 17,
  shake256: 18,
};

const BY_NAME = new Map<string, DigestAlgo>();
for (const [k, id] of Object.entries(HASH_ALIASES)) BY_NAME.set(k.toLowerCase(), ALGOS[id]);
for (const [k, id] of Object.entries(EXTRA)) BY_NAME.set(k, ALGOS[id]);

/** EVP_get_digestbyname */
export function getDigest(name: unknown): DigestAlgo | undefined {
  if (typeof name !== 'string') return undefined;
  // OpenSSL's name map ignores trailing spaces ("sha256 " resolves), nothing else
  return BY_NAME.get(name.replace(/ +$/, '').toLowerCase());
}

/** EVP_MD_do_all_sorted names, as Node reports them in getHashes(). */
export const HASH_NAMES = [
  'RSA-MD5', 'RSA-RIPEMD160', 'RSA-SHA1', 'RSA-SHA1-2', 'RSA-SHA224', 'RSA-SHA256', 'RSA-SHA3-224', 'RSA-SHA3-256',
  'RSA-SHA3-384', 'RSA-SHA3-512', 'RSA-SHA384', 'RSA-SHA512', 'RSA-SHA512/224', 'RSA-SHA512/256', 'RSA-SM3',
  'blake2b512', 'blake2s256', 'id-rsassa-pkcs1-v1_5-with-sha3-224', 'id-rsassa-pkcs1-v1_5-with-sha3-256',
  'id-rsassa-pkcs1-v1_5-with-sha3-384', 'id-rsassa-pkcs1-v1_5-with-sha3-512', 'md5', 'md5-sha1',
  'md5WithRSAEncryption', 'ripemd', 'ripemd160', 'ripemd160WithRSA', 'rmd160', 'sha1', 'sha1WithRSAEncryption',
  'sha224', 'sha224WithRSAEncryption', 'sha256', 'sha256WithRSAEncryption', 'sha3-224', 'sha3-256', 'sha3-384',
  'sha3-512', 'sha384', 'sha384WithRSAEncryption', 'sha512', 'sha512-224', 'sha512-224WithRSAEncryption',
  'sha512-256', 'sha512-256WithRSAEncryption', 'sha512WithRSAEncryption', 'shake128', 'shake256', 'sm3',
  'sm3WithRSAEncryption', 'ssl3-md5', 'ssl3-sha1',
];

/** EVP_Digest */
export function digestOnce(algo: DigestAlgo, data: Uint8Array, len = algo.size): Uint8Array {
  const c = algo.create();
  c.update(data);
  return c.final(len);
}

// -----------------------------------------------------------------------------
// HMAC

export class HmacCtx {
  private inner: Ctx;
  private outer: Ctx;
  constructor(
    private algo: DigestAlgo,
    key: Uint8Array,
    state?: { inner: Ctx; outer: Ctx },
  ) {
    if (state) {
      this.inner = state.inner;
      this.outer = state.outer;
      return;
    }
    const B = algo.block;
    let k = key;
    if (k.length > B) k = digestOnce(algo, k);
    const pad = new Uint8Array(B);
    pad.set(k);
    for (let i = 0; i < B; i++) pad[i] ^= 0x36;
    this.inner = algo.create();
    this.inner.update(pad);
    for (let i = 0; i < B; i++) pad[i] ^= 0x36 ^ 0x5c;
    this.outer = algo.create();
    this.outer.update(pad);
  }
  update(d: Uint8Array) {
    this.inner.update(d);
    return this;
  }
  final(): Uint8Array {
    this.outer.update(this.inner.final());
    return this.outer.final();
  }
  clone(): HmacCtx {
    return new HmacCtx(this.algo, new Uint8Array(0), { inner: this.inner.clone(), outer: this.outer.clone() });
  }
}

export function hmac(algo: DigestAlgo, key: Uint8Array, data: Uint8Array): Uint8Array {
  return new HmacCtx(algo, key).update(data).final();
}

// -----------------------------------------------------------------------------
// KDFs

export function pbkdf2(algo: DigestAlgo, pass: Uint8Array, salt: Uint8Array, iterations: number, length: number): Uint8Array {
  if (length === 0) return new Uint8Array(0);
  if (algo.noble && iterations >= 1) return noblePbkdf2(algo.noble, pass, salt, { c: iterations, dkLen: length });
  const base = new HmacCtx(algo, pass);
  const out = new Uint8Array(length);
  const ctr = new Uint8Array(4);
  for (let block = 1, pos = 0; pos < length; block++) {
    ctr[0] = block >>> 24;
    ctr[1] = block >>> 16;
    ctr[2] = block >>> 8;
    ctr[3] = block;
    let u = base.clone().update(salt).update(ctr).final();
    const t = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = base.clone().update(u).final();
      for (let j = 0; j < t.length; j++) t[j] ^= u[j];
    }
    const n = Math.min(t.length, length - pos);
    out.set(t.subarray(0, n), pos);
    pos += n;
  }
  return out;
}

export function hkdf(algo: DigestAlgo, key: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const prk = hmac(algo, salt.length ? salt : new Uint8Array(algo.size), key);
  const out = new Uint8Array(length);
  let prev = new Uint8Array(0);
  for (let i = 1, pos = 0; pos < length; i++) {
    prev = new HmacCtx(algo, prk).update(prev).update(info).update(Uint8Array.of(i)).final() as Uint8Array<ArrayBuffer>;
    const n = Math.min(prev.length, length - pos);
    out.set(prev.subarray(0, n), pos);
    pos += n;
  }
  return out;
}
