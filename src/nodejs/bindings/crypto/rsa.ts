// RSA on BigInt: key generation, the RSA primitive with CRT, PKCS#1 v1.5 / PSS signatures and
// PKCS#1 v1.5 / OAEP encryption (RFC 8017).

import { digestOnce, type DigestAlgo } from './digests.ts';
import { bigIntToBytes, bitLength, bytesToBigInt, generatePrime, modPow } from './random.ts';
import { concat, equalBytes, fillRandom, osslError } from './util.ts';
import * as der from './asn1.ts';

export interface RsaKey {
  n: bigint;
  e: bigint;
  d?: bigint;
  p?: bigint;
  q?: bigint;
  dp?: bigint;
  dq?: bigint;
  qi?: bigint;
}

export const rsaErr = {
  dataTooLarge: () => osslError('0200006E', 'rsa routines', 'data too large for key size', 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE'),
  dataTooLargeForModulus: () => osslError('02000084', 'rsa routines', 'data too large for modulus', 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS'),
  invalidPadding: () => osslError('0200008A', 'rsa routines', 'invalid padding', 'ERR_OSSL_RSA_INVALID_PADDING'),
  oaepDecoding: () => osslError('02000079', 'rsa routines', 'oaep decoding error', 'ERR_OSSL_RSA_OAEP_DECODING_ERROR'),
  keySizeTooSmall: () => osslError('1C80006E', 'Provider routines', 'key size too small', 'ERR_OSSL_KEY_SIZE_TOO_SMALL'),
};

const gcd = (a: bigint, b: bigint): bigint => {
  while (b) [a, b] = [b, a % b];
  return a;
};

export function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

export function byteLen(k: RsaKey) {
  return Math.ceil(bitLength(k.n) / 8);
}

/** RSA_generate_multi_prime_key with two primes. */
export function generateRsa(bits: number, e: number): RsaKey {
  if (bits < 512) throw rsaErr.keySizeTooSmall();
  const E = BigInt(e);
  const bitsp = (bits + 1) >> 1;
  const bitsq = bits - bitsp;
  const prime = (b: number) => {
    for (;;) {
      const p = generatePrime(b, false, undefined, undefined, 5);
      if (gcd(p - 1n, E) === 1n) return p;
    }
  };
  for (;;) {
    let p = prime(bitsp);
    let q = prime(bitsq);
    if (p === q) continue;
    if (p < q) [p, q] = [q, p];
    const n = p * q;
    if (bitLength(n) !== bits) continue;
    const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
    const d = modInverse(E, lambda);
    return { n, e: E, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qi: modInverse(q, p) };
  }
}

/** Fills dp, dq, qi when a key came without them. */
export function completeRsa(k: RsaKey): RsaKey {
  if (k.d !== undefined && k.p !== undefined && k.q !== undefined) {
    k.dp ??= k.d % (k.p - 1n);
    k.dq ??= k.d % (k.q - 1n);
    k.qi ??= modInverse(k.q, k.p);
  }
  return k;
}

function publicOp(k: RsaKey, m: bigint): bigint {
  return modPow(m, k.e, k.n);
}

function privateOp(k: RsaKey, c: bigint): bigint {
  if (k.p && k.q && k.dp !== undefined && k.dq !== undefined && k.qi !== undefined) {
    const m1 = modPow(c, k.dp, k.p);
    const m2 = modPow(c, k.dq, k.q);
    let h = (k.qi * (m1 - m2)) % k.p;
    if (h < 0n) h += k.p;
    return m2 + h * k.q;
  }
  return modPow(c, k.d!, k.n);
}

export function rawPublic(k: RsaKey, input: Uint8Array): Uint8Array {
  const m = bytesToBigInt(input);
  if (m >= k.n) throw rsaErr.dataTooLargeForModulus();
  return bigIntToBytes(publicOp(k, m), byteLen(k));
}

export function rawPrivate(k: RsaKey, input: Uint8Array): Uint8Array {
  const c = bytesToBigInt(input);
  if (c >= k.n) throw rsaErr.dataTooLargeForModulus();
  return bigIntToBytes(privateOp(k, c), byteLen(k));
}

// -----------------------------------------------------------------------------
// MGF1, OAEP, PKCS#1 v1.5 encryption

export function mgf1(algo: DigestAlgo, seed: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const ctr = new Uint8Array(4);
  for (let i = 0, pos = 0; pos < len; i++) {
    new DataView(ctr.buffer).setUint32(0, i);
    const h = digestOnce(algo, concat([seed, ctr]));
    out.set(h.subarray(0, Math.min(h.length, len - pos)), pos);
    pos += h.length;
  }
  return out;
}

function randomNonZero(n: number): Uint8Array {
  const out = new Uint8Array(n);
  fillRandom(out);
  for (let i = 0; i < n; i++) {
    while (out[i] === 0) {
      const b = new Uint8Array(1);
      fillRandom(b);
      out[i] = b[0];
    }
  }
  return out;
}

export function oaepEncrypt(k: RsaKey, algo: DigestAlgo, label: Uint8Array, msg: Uint8Array): Uint8Array {
  const kLen = byteLen(k);
  const hLen = algo.size;
  if (msg.length > kLen - 2 * hLen - 2) throw rsaErr.dataTooLarge();
  const lHash = digestOnce(algo, label);
  const db = new Uint8Array(kLen - hLen - 1);
  db.set(lHash);
  db[db.length - msg.length - 1] = 1;
  db.set(msg, db.length - msg.length);
  const seed = new Uint8Array(hLen);
  fillRandom(seed);
  const dbMask = mgf1(algo, seed, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= dbMask[i];
  const seedMask = mgf1(algo, db, hLen);
  for (let i = 0; i < hLen; i++) seed[i] ^= seedMask[i];
  return rawPublic(k, concat([Uint8Array.of(0), seed, db]));
}

export function oaepDecrypt(k: RsaKey, algo: DigestAlgo, label: Uint8Array, ct: Uint8Array): Uint8Array {
  const kLen = byteLen(k);
  const hLen = algo.size;
  if (ct.length !== kLen || kLen < 2 * hLen + 2) throw rsaErr.oaepDecoding();
  const em = rawPrivate(k, ct);
  const seed = em.slice(1, 1 + hLen);
  const db = em.slice(1 + hLen);
  const seedMask = mgf1(algo, db, hLen);
  for (let i = 0; i < hLen; i++) seed[i] ^= seedMask[i];
  const dbMask = mgf1(algo, seed, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= dbMask[i];
  const lHash = digestOnce(algo, label);
  let ok = em[0] === 0 && equalBytes(db.subarray(0, hLen), lHash);
  let i = hLen;
  while (i < db.length && db[i] === 0) i++;
  ok = ok && i < db.length && db[i] === 1;
  if (!ok) throw rsaErr.oaepDecoding();
  return db.slice(i + 1);
}

/** EME-PKCS1-v1_5 (block type 2) or EMSA-PKCS1-v1_5 raw (block type 1, for privateEncrypt). */
export function pkcs1Pad(k: RsaKey, msg: Uint8Array, type: 1 | 2): Uint8Array {
  const kLen = byteLen(k);
  if (msg.length > kLen - 11) throw rsaErr.dataTooLarge();
  const ps = type === 2 ? randomNonZero(kLen - msg.length - 3) : new Uint8Array(kLen - msg.length - 3).fill(0xff);
  return concat([Uint8Array.of(0, type), ps, Uint8Array.of(0), msg]);
}

export function pkcs1Unpad(em: Uint8Array, type: 1 | 2): Uint8Array | null {
  if (em[0] !== 0 || em[1] !== type) return null;
  let i = 2;
  if (type === 1) {
    while (i < em.length && em[i] === 0xff) i++;
  } else {
    while (i < em.length && em[i] !== 0) i++;
  }
  if (i >= em.length || em[i] !== 0 || i < 10) return null;
  return em.slice(i + 1);
}

// -----------------------------------------------------------------------------
// signatures

const DIGEST_OIDS: Record<string, string> = {
  MD5: '1.2.840.113549.2.5',
  SHA1: '1.3.14.3.2.26',
  SHA224: '2.16.840.1.101.3.4.2.4',
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA384: '2.16.840.1.101.3.4.2.2',
  SHA512: '2.16.840.1.101.3.4.2.3',
  'SHA512-224': '2.16.840.1.101.3.4.2.5',
  'SHA512-256': '2.16.840.1.101.3.4.2.6',
  'SHA3-224': '2.16.840.1.101.3.4.2.7',
  'SHA3-256': '2.16.840.1.101.3.4.2.8',
  'SHA3-384': '2.16.840.1.101.3.4.2.9',
  'SHA3-512': '2.16.840.1.101.3.4.2.10',
  RIPEMD160: '1.3.36.3.2.1',
  SM3: '1.2.156.10197.1.401',
};

export function digestOid(algo: DigestAlgo): string | undefined {
  return DIGEST_OIDS[algo.name];
}

function digestInfo(algo: DigestAlgo, hash: Uint8Array): Uint8Array {
  if (algo.name === 'MD5-SHA1') return hash;
  const oid = DIGEST_OIDS[algo.name];
  if (!oid) throw osslError('1C8000AE', 'Provider routines', 'digest not allowed', 'ERR_OSSL_DIGEST_NOT_ALLOWED');
  return der.seq(der.seq(der.oid(oid), der.nul()), der.octets(hash));
}

export function pkcs1Sign(k: RsaKey, algo: DigestAlgo, hash: Uint8Array): Uint8Array {
  const t = digestInfo(algo, hash);
  const kLen = byteLen(k);
  if (t.length > kLen - 11) throw osslError('0200006E', 'rsa routines', 'data too large for key size', 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE');
  return rawPrivate(k, pkcs1Pad(k, t, 1));
}

export function pkcs1Verify(k: RsaKey, algo: DigestAlgo, hash: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== byteLen(k)) return false;
  let em: Uint8Array;
  try {
    em = rawPublic(k, sig);
  } catch {
    return false;
  }
  const t = pkcs1Unpad(em, 1);
  if (!t) return false;
  try {
    return equalBytes(t, digestInfo(algo, hash));
  } catch {
    return false;
  }
}

export const RSA_PSS_SALTLEN_DIGEST = -1;
export const RSA_PSS_SALTLEN_AUTO = -2; // max when signing, auto-detect when verifying
export const RSA_PSS_SALTLEN_MAX = -3;
export const RSA_PSS_SALTLEN_AUTO_DIGEST_MAX = -4;

export function pssSign(k: RsaKey, algo: DigestAlgo, mgfAlgo: DigestAlgo, hash: Uint8Array, saltLen: number): Uint8Array {
  const modBits = bitLength(k.n);
  const emBits = modBits - 1;
  const emLen = Math.ceil(emBits / 8);
  const hLen = algo.size;
  const maxSalt = emLen - hLen - 2;
  if (saltLen === RSA_PSS_SALTLEN_DIGEST) saltLen = hLen;
  else if (saltLen === RSA_PSS_SALTLEN_AUTO || saltLen === RSA_PSS_SALTLEN_MAX) saltLen = maxSalt;
  else if (saltLen === RSA_PSS_SALTLEN_AUTO_DIGEST_MAX) saltLen = Math.min(hLen, maxSalt);
  if (saltLen < 0 || maxSalt < 0 || saltLen > maxSalt) throw rsaErr.dataTooLarge();
  const salt = new Uint8Array(saltLen);
  fillRandom(salt);
  const mPrime = concat([new Uint8Array(8), hash, salt]);
  const h = digestOnce(algo, mPrime);
  const db = new Uint8Array(emLen - hLen - 1);
  db[db.length - saltLen - 1] = 1;
  db.set(salt, db.length - saltLen);
  const mask = mgf1(mgfAlgo, h, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  const em = concat([db, h, Uint8Array.of(0xbc)]);
  return rawPrivate(k, em.length < byteLen(k) ? concat([new Uint8Array(byteLen(k) - em.length), em]) : em);
}

export function pssVerify(k: RsaKey, algo: DigestAlgo, mgfAlgo: DigestAlgo, hash: Uint8Array, sig: Uint8Array, saltLen: number): boolean {
  if (sig.length !== byteLen(k)) return false;
  let full: Uint8Array;
  try {
    full = rawPublic(k, sig);
  } catch {
    return false;
  }
  const modBits = bitLength(k.n);
  const emBits = modBits - 1;
  const emLen = Math.ceil(emBits / 8);
  const em = full.subarray(full.length - emLen);
  if (full.length > emLen && full[0] !== 0) return false;
  const hLen = algo.size;
  if (emLen < hLen + 2 || em[emLen - 1] !== 0xbc) return false;
  const db = em.slice(0, emLen - hLen - 1);
  const h = em.subarray(emLen - hLen - 1, emLen - 1);
  if (db[0] & ~(0xff >> (8 * emLen - emBits)) & 0xff) return false;
  const mask = mgf1(mgfAlgo, h, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  let i = 0;
  while (i < db.length && db[i] === 0) i++;
  if (i >= db.length || db[i] !== 1) return false;
  const salt = db.subarray(i + 1);
  if (saltLen === RSA_PSS_SALTLEN_DIGEST && salt.length !== hLen) return false;
  if (saltLen >= 0 && salt.length !== saltLen) return false;
  if (saltLen === RSA_PSS_SALTLEN_MAX && salt.length !== emLen - hLen - 2) return false;
  return equalBytes(digestOnce(algo, concat([new Uint8Array(8), hash, salt])), h);
}
