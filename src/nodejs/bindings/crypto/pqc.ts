// The post-quantum key types OpenSSL 3.5 brings to Node 24+ (FIPS 203 ML-KEM, FIPS 204 ML-DSA,
// FIPS 205 SLH-DSA), on @noble/post-quantum: key material, their PKCS#8 / SPKI / JWK ("AKP")
// encodings as OpenSSL writes them, signatures and encapsulation.

import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem512, ml_kem768, ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as slh from '@noble/post-quantum/slh-dsa.js';
import * as der from './asn1.ts';
import { err, osslError } from './util.ts';

export type PqFamily = 'ml-dsa' | 'ml-kem' | 'slh-dsa';

export interface PqInfo {
  kind: string;
  family: PqFamily;
  oid: string;
  /** the JWK "alg" (the WebCrypto / OpenSSL name) */
  alg: string;
  impl: any;
  /** FIPS 203/204 seed length (ML only) */
  seedLen: number;
  pubLen: number;
}

const ML_DSA: [string, string, any][] = [
  ['ml-dsa-44', '17', ml_dsa44],
  ['ml-dsa-65', '18', ml_dsa65],
  ['ml-dsa-87', '19', ml_dsa87],
];
const ML_KEM: [string, string, any][] = [
  ['ml-kem-512', '1', ml_kem512],
  ['ml-kem-768', '2', ml_kem768],
  ['ml-kem-1024', '3', ml_kem1024],
];
const SLH = ['sha2-128s', 'sha2-128f', 'sha2-192s', 'sha2-192f', 'sha2-256s', 'sha2-256f', 'shake-128s', 'shake-128f', 'shake-192s', 'shake-192f', 'shake-256s', 'shake-256f'];

export const PQ: Record<string, PqInfo> = Object.create(null);
for (const [kind, n, impl] of ML_DSA) PQ[kind] = { kind, family: 'ml-dsa', oid: `2.16.840.1.101.3.4.3.${n}`, alg: kind.toUpperCase(), impl, seedLen: 32, pubLen: impl.lengths.publicKey };
for (const [kind, n, impl] of ML_KEM) PQ[kind] = { kind, family: 'ml-kem', oid: `2.16.840.1.101.3.4.4.${n}`, alg: kind.toUpperCase(), impl, seedLen: 64, pubLen: impl.lengths.publicKey };
SLH.forEach((p, i) => {
  const kind = `slh-dsa-${p}`;
  const impl = (slh as any)[`slh_dsa_${p.replace('-', '_')}`];
  // OpenSSL's names keep the lower-case s/f: SLH-DSA-SHA2-128f
  PQ[kind] = { kind, family: 'slh-dsa', oid: `2.16.840.1.101.3.4.3.${20 + i}`, alg: `SLH-DSA-${p.slice(0, -1).toUpperCase()}${p.slice(-1)}`, impl, seedLen: 0, pubLen: impl.lengths.publicKey };
});

export const isPqKind = (k: string) => Object.prototype.hasOwnProperty.call(PQ, k);
export const pqByOid = (oid: string) => Object.values(PQ).find((p) => p.oid === oid);
export const pqByAlg = (alg: string) => Object.values(PQ).find((p) => p.alg === alg);

/** A post-quantum key: the public key, and for a private one the (expanded) secret key and, when known, its seed. */
export interface PqKey {
  kind: string;
  pub: Uint8Array;
  priv?: Uint8Array;
  seed?: Uint8Array;
}

const invalidKeyData = () => err('ERR_INVALID_ARG_VALUE', 'Invalid key data');

export function pqFromSeed(kind: string, seed: Uint8Array): PqKey {
  const info = PQ[kind];
  if (info.family === 'slh-dsa') {
    // SLH-DSA's raw private key is SK.seed || SK.prf || PK.seed || PK.root; its keygen takes the first three
    const { secretKey, publicKey } = info.impl.keygen(seed);
    return { kind, pub: publicKey, priv: secretKey };
  }
  if (seed.length !== info.seedLen) throw invalidKeyData();
  const { secretKey, publicKey } = info.impl.keygen(seed);
  return { kind, pub: publicKey, priv: secretKey, seed: seed.slice() };
}

export function pqGenerate(kind: string, random: (n: number) => Uint8Array): PqKey {
  const info = PQ[kind];
  return pqFromSeed(kind, random(info.family === 'slh-dsa' ? info.impl.lengths.seed : info.seedLen));
}

export function pqFromPrivate(kind: string, priv: Uint8Array): PqKey {
  const info = PQ[kind];
  if (priv.length !== info.impl.lengths.secretKey) throw invalidKeyData();
  let pub: Uint8Array;
  try {
    pub = info.impl.getPublicKey(priv);
  } catch {
    throw invalidKeyData();
  }
  return { kind, pub, priv: priv.slice() };
}

export function pqFromPublic(kind: string, pub: Uint8Array): PqKey {
  if (pub.length !== PQ[kind].pubLen) throw invalidKeyData();
  return { kind, pub: pub.slice() };
}

// --- PKCS#8 private keys: ML keys as the seed ([0] IMPLICIT), the expanded key (OCTET STRING) or
// both (SEQUENCE); OpenSSL writes the seed when it has one. SLH-DSA keys are the raw key.

export function pqPkcs8Inner(k: PqKey): Uint8Array {
  const info = PQ[k.kind];
  if (info.family === 'slh-dsa') return k.priv!;
  if (k.seed) return der.tlv(0x80, k.seed);
  return der.octets(k.priv!);
}

export function pqReadPkcs8(info: PqInfo, inner: Uint8Array): PqKey {
  const bad = () => osslError('1E08010C', 'DECODER routines', 'unsupported', 'ERR_OSSL_UNSUPPORTED');
  if (info.family === 'slh-dsa') {
    try {
      return pqFromPrivate(info.kind, inner);
    } catch {
      throw bad();
    }
  }
  let n: der.Node;
  try {
    n = der.parse(inner);
  } catch {
    throw bad();
  }
  try {
    if (n.tag === 0x80) return pqFromSeed(info.kind, n.body);
    if (n.tag === 0x04) return pqFromPrivate(info.kind, n.body);
    if (n.tag === 0x30) {
      const [s, e] = der.children(n);
      const k = pqFromSeed(info.kind, der.expect(s, 0x04).body);
      // the expanded key must be the one the seed makes
      const expanded = der.expect(e, 0x04).body;
      if (expanded.length !== k.priv!.length || !expanded.every((b, i) => b === k.priv![i])) throw bad();
      return k;
    }
  } catch (e) {
    if ((e as any)?.library) throw e;
    throw bad();
  }
  throw bad();
}

// --- JWK (draft-ietf-cose-dilithium / jose AKP): {kty: "AKP", alg, pub, priv (the seed)}

export function pqExportJwk(k: PqKey, isPrivate: boolean, target: any, b64url: (b: Uint8Array) => string) {
  const info = PQ[k.kind];
  target.kty = 'AKP';
  target.alg = info.alg;
  target.pub = b64url(k.pub);
  if (isPrivate) {
    if (info.family === 'slh-dsa') target.priv = b64url(k.priv!);
    else if (k.seed) target.priv = b64url(k.seed);
    else throw err('ERR_CRYPTO_OPERATION_FAILED', 'key does not have an available seed');
  }
}

export function pqImportJwk(jwk: any, wantPrivate: boolean, unb64: (s: string) => Uint8Array): { type: 1 | 2; key: PqKey } {
  const bad = () => err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK AKP key');
  const info = typeof jwk.alg === 'string' ? pqByAlg(jwk.alg) : undefined;
  if (!info || typeof jwk.pub !== 'string') throw bad();
  const pub = unb64(jwk.pub);
  if (pub.length !== info.pubLen) throw bad();
  if (jwk.priv === undefined) {
    if (wantPrivate) throw err('ERR_CRYPTO_INVALID_JWK', 'JWK does not contain private key material');
    return { type: 1, key: { kind: info.kind, pub } };
  }
  if (typeof jwk.priv !== 'string') throw bad();
  let k: PqKey;
  try {
    const priv = unb64(jwk.priv);
    k = info.family === 'slh-dsa' ? pqFromPrivate(info.kind, priv) : pqFromSeed(info.kind, priv);
  } catch {
    throw bad();
  }
  if (k.pub.length !== pub.length || !k.pub.every((b, i) => b === pub[i])) throw bad();
  return { type: 2, key: k };
}

// --- operations

export function pqSign(k: PqKey, msg: Uint8Array, context?: Uint8Array): Uint8Array {
  const info = PQ[k.kind];
  return info.impl.sign(msg, k.priv!, context?.length ? { context } : undefined);
}

export function pqVerify(k: PqKey, msg: Uint8Array, sig: Uint8Array, context?: Uint8Array): boolean {
  try {
    return PQ[k.kind].impl.verify(sig, msg, k.pub, context?.length ? { context } : undefined);
  } catch {
    return false;
  }
}

export function pqEncapsulate(k: PqKey): [Uint8Array, Uint8Array] {
  const { cipherText, sharedSecret } = PQ[k.kind].impl.encapsulate(k.pub);
  return [sharedSecret, cipherText];
}

export function pqDecapsulate(k: PqKey, ct: Uint8Array): Uint8Array {
  if (ct.length !== PQ[k.kind].impl.lengths.cipherText) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Decapsulation failed');
  return PQ[k.kind].impl.decapsulate(ct, k.priv!);
}
