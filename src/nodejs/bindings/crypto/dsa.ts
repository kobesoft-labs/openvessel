// DSA (FIPS 186-4) and finite-field DH key material on BigInt: domain parameter generation,
// DSA signatures (DER Dss-Sig-Value) and the DH key pairs behind KeyObjects of type 'dh'.

import { bigIntToBytes, bitLength, bytesToBigInt, generatePrime, modPow } from './random.ts';
import { modInverse } from './rsa.ts';
import { fillRandom, osslError } from './util.ts';
import * as der from './asn1.ts';

export interface DsaKey {
  p: bigint;
  q: bigint;
  g: bigint;
  y: bigint;
  x?: bigint;
}

export interface DhKey {
  p: bigint;
  g: bigint;
  /** the X9.42 subgroup order, when known */
  q?: bigint;
  y: bigint;
  x?: bigint;
}

/** Uniform in [1, n - 1]. */
export function randomBelow(n: bigint): bigint {
  const bytes = new Uint8Array(Math.ceil(bitLength(n) / 8) + 8);
  fillRandom(bytes);
  return (bytesToBigInt(bytes) % (n - 1n)) + 1n;
}

/** DSA_generate_parameters_ex: OpenSSL picks N = 256 for L >= 2048 and N = 160 below. */
export function generateDsa(L: number, N: number): DsaKey {
  if (N < 0) N = L >= 2048 ? 256 : 160;
  if (L < 512 || N < 160 || N >= L) throw osslError('1C8000AC', 'Provider routines', 'invalid modulus size', 'ERR_OSSL_INVALID_MODULUS_SIZE');
  const q = generatePrime(N, false);
  // p = 1 mod 2q, exactly L bits
  const p = generatePrime(L, false, 2n * q, 1n);
  const e = (p - 1n) / q;
  let g = 1n;
  for (let h = 2n; g === 1n; h++) g = modPow(h, e, p);
  const x = randomBelow(q);
  return { p, q, g, y: modPow(g, x, p), x };
}

/** The leftmost min(N, outlen) bits of the digest as an integer (FIPS 186-4 4.6). */
function digestInt(hash: Uint8Array, q: bigint): bigint {
  const n = bitLength(q);
  let z = bytesToBigInt(hash);
  const hbits = hash.length * 8;
  if (hbits > n) z >>= BigInt(hbits - n);
  return z;
}

export function dsaSign(k: DsaKey, hash: Uint8Array): Uint8Array {
  const { p, q, g, x } = k;
  const z = digestInt(hash, q);
  for (;;) {
    const kk = randomBelow(q);
    const r = modPow(g, kk, p) % q;
    if (r === 0n) continue;
    const s = (modInverse(kk, q) * (z + x! * r)) % q;
    if (s === 0n) continue;
    return der.seq(der.int(r), der.int(s));
  }
}

export function dsaVerify(k: DsaKey, hash: Uint8Array, sig: Uint8Array): boolean {
  const { p, q, g, y } = k;
  let r: bigint;
  let s: bigint;
  try {
    const n = der.parse(sig);
    const parts = der.children(der.expect(n, 0x30));
    if (parts.length !== 2) return false;
    r = der.readInt(parts[0]);
    s = der.readInt(parts[1]);
    // OpenSSL re-encodes and compares, rejecting non-minimal encodings
    const again = der.seq(der.int(r), der.int(s));
    if (again.length !== sig.length || again.some((b, i) => b !== sig[i])) return false;
  } catch {
    return false;
  }
  if (r <= 0n || r >= q || s <= 0n || s >= q) return false;
  const w = modInverse(s, q);
  const z = digestInt(hash, q);
  const u1 = (z * w) % q;
  const u2 = (r * w) % q;
  const v = ((modPow(g, u1, p) * modPow(y, u2, p)) % p) % q;
  return v === r;
}

/** Bytes of the subgroup order, for IEEE P1363 signatures. */
export function dsaOrderBytes(k: DsaKey) {
  return Math.ceil(bitLength(k.q) / 8);
}

/** A DH private value: OpenSSL draws one of 2 * security bits for large safe-prime groups. */
export function dhPrivate(p: bigint, q?: bigint): bigint {
  if (q) return randomBelow(q);
  const bits = bitLength(p);
  const len = Math.min(bits - 1, bits >= 2048 ? 512 : bits - 1);
  const bytes = new Uint8Array(Math.ceil(len / 8));
  fillRandom(bytes);
  let x = bytesToBigInt(bytes) & ((1n << BigInt(len)) - 1n);
  if (x < 2n) x = 2n;
  return x;
}

export function dhFromPrivate(p: bigint, g: bigint, x: bigint, q?: bigint): DhKey {
  return { p, g, q, y: modPow(g, x, p), x };
}

/** DH shared secret, zero-padded to the size of p like EVP_PKEY_derive. */
export function dhSecret(priv: DhKey, peerY: bigint): Uint8Array {
  return bigIntToBytes(modPow(peerY, priv.x!, priv.p), Math.ceil(bitLength(priv.p) / 8));
}
