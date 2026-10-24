// Asymmetric key material (what an EVP_PKEY holds) and its encodings: SPKI, PKCS#8 (plain and
// PBES2-encrypted), PKCS#1, SEC1, PEM (with legacy Proc-Type encryption), JWK and raw.

import { p256, p384, p521 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ecdsa, weierstrass } from '@noble/curves/abstract/weierstrass.js';
import { sha224 } from '@noble/hashes/sha2.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { ed448, x448 } from '@noble/curves/ed448.js';
import { Enc, decode, encode } from '../buffer.ts';
import * as der from './asn1.ts';
import { ALGOS, getDigest, pbkdf2, type DigestAlgo } from './digests.ts';
import { bigIntToBytes, bitLength, bytesToBigInt, modPow } from './random.ts';
import { completeRsa, digestOid, type RsaKey } from './rsa.ts';
import { dhFromPrivate, type DhKey, type DsaKey } from './dsa.ts';
import { md5 } from '@noble/hashes/legacy.js';
import { CipherBase, findCipher } from './cipher.ts';
import { concat, cryptoError, err, fillRandom, osslError } from './util.ts';
import type { KeyData } from './keys.ts';

// -----------------------------------------------------------------------------
// key model

export interface Curve {
  /** OpenSSL short name */
  name: string;
  oid: string;
  jwk: string;
  impl: typeof p256;
  /** field element bytes */
  size: number;
  /** no JWK "crv" for this curve (ExportJWKEcKey) */
  noJwk?: boolean;
  /** the X9.62 seed OpenSSL writes into explicit parameters */
  seed?: string;
}

// secp224r1 (P-224) is not in @noble/curves' presets
const p224 = ecdsa(
  weierstrass({
    p: BigInt('0xffffffffffffffffffffffffffffffff000000000000000000000001'),
    a: BigInt('0xfffffffffffffffffffffffffffffffefffffffffffffffffffffffe'),
    b: BigInt('0xb4050a850c04b3abf54132565044b0b7d7bfd8ba270b39432355ffb4'),
    Gx: BigInt('0xb70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21'),
    Gy: BigInt('0xbd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34'),
    n: BigInt('0xffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3d'),
    h: 1n,
  }),
  sha224,
);

export const CURVES: Curve[] = [
  { name: 'secp224r1', oid: '1.3.132.0.33', jwk: 'P-224', impl: p224 as unknown as typeof p256, size: 28, noJwk: true, seed: 'bd71344799d5c7fcdc45b59fa3b9ab8f6a948bc5' },
  { name: 'prime256v1', oid: '1.2.840.10045.3.1.7', jwk: 'P-256', impl: p256, size: 32, seed: 'c49d360886e704936a6678e1139d26b7819f7e90' },
  { name: 'secp384r1', oid: '1.3.132.0.34', jwk: 'P-384', impl: p384, size: 48, seed: 'a335926aa319a27a1d00896a6773a4827acdac73' },
  { name: 'secp521r1', oid: '1.3.132.0.35', jwk: 'P-521', impl: p521, size: 66, seed: 'd09e8800291cb85396cc6717393284aaa0da64ba' },
  { name: 'secp256k1', oid: '1.3.132.0.10', jwk: 'secp256k1', impl: secp256k1 as unknown as typeof p256, size: 32 },
];

/** OBJ_sn2nid / OBJ_txt2nid / EC_curve_nist2nid for the curves implemented here. */
export function curveByName(name: string, allowNist = true): Curve | undefined {
  return CURVES.find((c) => c.name === name || c.oid === name || (allowNist && c.jwk === name));
}

export type OkpKind = 'ed25519' | 'ed448' | 'x25519' | 'x448';

export interface OkpInfo {
  kind: OkpKind;
  oid: string;
  jwk: string;
  len: number;
  pubFromPriv: (priv: Uint8Array) => Uint8Array;
}

export const OKP: Record<OkpKind, OkpInfo> = {
  ed25519: { kind: 'ed25519', oid: '1.3.101.112', jwk: 'Ed25519', len: 32, pubFromPriv: (p) => ed25519.getPublicKey(p) },
  ed448: { kind: 'ed448', oid: '1.3.101.113', jwk: 'Ed448', len: 57, pubFromPriv: (p) => ed448.getPublicKey(p) },
  x25519: { kind: 'x25519', oid: '1.3.101.110', jwk: 'X25519', len: 32, pubFromPriv: (p) => x25519.getPublicKey(p) },
  x448: { kind: 'x448', oid: '1.3.101.111', jwk: 'X448', len: 56, pubFromPriv: (p) => x448.getPublicKey(p) },
};

export interface PssParams {
  hash: DigestAlgo;
  mgf1: DigestAlgo;
  saltLength: number;
}

export type Asym =
  | { kind: 'rsa'; rsa: RsaKey }
  | { kind: 'rsa-pss'; rsa: RsaKey; pss: PssParams | null }
  | { kind: 'ec'; curve: Curve; pub: Uint8Array; d?: bigint; explicit?: boolean }
  | { kind: 'dsa'; dsa: DsaKey }
  | { kind: 'dh'; dh: DhKey }
  | { kind: OkpKind; pub: Uint8Array; priv?: Uint8Array };

export function hasPrivate(a: Asym): boolean {
  if ('rsa' in a) return a.rsa.d !== undefined;
  if (a.kind === 'ec') return a.d !== undefined;
  if (a.kind === 'dsa') return a.dsa.x !== undefined;
  if (a.kind === 'dh') return a.dh.x !== undefined;
  return (a as any).priv !== undefined;
}

const OID = {
  rsa: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  mgf1: '1.2.840.113549.1.1.8',
  ec: '1.2.840.10045.2.1',
  primeField: '1.2.840.10045.1.1',
  dsa: '1.2.840.10040.4.1',
  dh: '1.2.840.113549.1.3.1',
  dhx: '1.2.840.10046.2.1',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacWithSHA1: '1.2.840.113549.2.7',
  hmacWithSHA224: '1.2.840.113549.2.8',
  hmacWithSHA256: '1.2.840.113549.2.9',
  hmacWithSHA384: '1.2.840.113549.2.10',
  hmacWithSHA512: '1.2.840.113549.2.11',
};

const PBE_CIPHERS: Record<string, string> = {
  '2.16.840.1.101.3.4.1.2': 'aes-128-cbc',
  '2.16.840.1.101.3.4.1.22': 'aes-192-cbc',
  '2.16.840.1.101.3.4.1.42': 'aes-256-cbc',
  '2.16.840.1.101.3.4.1.1': 'aes-128-ecb',
  '2.16.840.1.101.3.4.1.21': 'aes-192-ecb',
  '2.16.840.1.101.3.4.1.41': 'aes-256-ecb',
  '2.16.840.1.101.3.4.1.3': 'aes-128-ofb',
  '2.16.840.1.101.3.4.1.23': 'aes-192-ofb',
  '2.16.840.1.101.3.4.1.43': 'aes-256-ofb',
  '2.16.840.1.101.3.4.1.4': 'aes-128-cfb',
  '2.16.840.1.101.3.4.1.24': 'aes-192-cfb',
  '2.16.840.1.101.3.4.1.44': 'aes-256-cfb',
  '1.2.840.113549.3.7': 'des-ede3-cbc',
  '1.3.14.3.2.7': 'des-cbc',
};

// -----------------------------------------------------------------------------
// OpenSSL-style errors for key decoding

export const keyErr = {
  unsupported: () => osslError('1E08010C', 'DECODER routines', 'unsupported', 'ERR_OSSL_UNSUPPORTED'),
  wrongTag: () => osslError('068000A8', 'asn1 encoding routines', 'wrong tag', 'ERR_OSSL_ASN1_WRONG_TAG'),
  fieldMissing: () => osslError('06800079', 'asn1 encoding routines', 'field missing', 'ERR_OSSL_ASN1_FIELD_MISSING'),
  interrupted: () => osslError('07880109', 'common libcrypto routines', 'interrupted or cancelled', 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED'),
  readAsym: () => cryptoError('Failed to read asymmetric key'),
};

// -----------------------------------------------------------------------------
// building keys

export function ecFromPrivate(curve: Curve, d: bigint): Asym {
  const pub = curve.impl.Point.BASE.multiply(d).toBytes(false);
  return { kind: 'ec', curve, pub, d };
}

export function ecPoint(curve: Curve, bytes: Uint8Array) {
  return curve.impl.Point.fromBytes(hybridToUncompressed(bytes));
}

/** OpenSSL accepts hybrid encodings (0x06 / 0x07 prefix); noble does not. */
export function hybridToUncompressed(b: Uint8Array): Uint8Array {
  if (b.length && (b[0] === 6 || b[0] === 7)) {
    const u = b.slice();
    u[0] = 4;
    return u;
  }
  return b;
}

export function curveOrder(curve: Curve): bigint {
  return (curve.impl.Point as any).Fn.ORDER;
}

export function randomScalar(curve: Curve): bigint {
  const n = curveOrder(curve);
  const bytes = new Uint8Array(curve.size + 16);
  fillRandom(bytes);
  return (bytesToBigInt(bytes) % (n - 1n)) + 1n;
}

export function okpFromPrivate(kind: OkpKind, priv: Uint8Array): Asym {
  return { kind, pub: OKP[kind].pubFromPriv(priv), priv: priv.slice() };
}

// -----------------------------------------------------------------------------
// DER encoders

function bigBytes(n: bigint, len?: number) {
  return bigIntToBytes(n, len);
}

function pssParamsDer(p: PssParams): Uint8Array {
  const parts: Uint8Array[] = [];
  if (p.hash.name !== 'SHA1') parts.push(der.ctx(0, der.seq(der.oid(digestOid(p.hash)!), der.nul())));
  if (p.mgf1.name !== 'SHA1') parts.push(der.ctx(1, der.seq(der.oid(OID.mgf1), der.seq(der.oid(digestOid(p.mgf1)!), der.nul()))));
  if (p.saltLength !== 20) parts.push(der.ctx(2, der.int(p.saltLength)));
  return der.seq(...parts);
}

function algId(a: Asym): Uint8Array {
  switch (a.kind) {
    case 'rsa':
      return der.seq(der.oid(OID.rsa), der.nul());
    case 'rsa-pss':
      return a.pss ? der.seq(der.oid(OID.rsaPss), pssParamsDer(a.pss)) : der.seq(der.oid(OID.rsaPss));
    case 'ec':
      return der.seq(der.oid(OID.ec), a.explicit ? ecParamsDer(a.curve) : der.oid(a.curve.oid));
    case 'dsa':
      return der.seq(der.oid(OID.dsa), der.seq(der.int(a.dsa.p), der.int(a.dsa.q), der.int(a.dsa.g)));
    case 'dh':
      return a.dh.q !== undefined
        ? der.seq(der.oid(OID.dhx), der.seq(der.int(a.dh.p), der.int(a.dh.g), der.int(a.dh.q)))
        : der.seq(der.oid(OID.dh), der.seq(der.int(a.dh.p), der.int(a.dh.g)));
    default:
      return der.seq(der.oid(OKP[a.kind].oid));
  }
}

export function rsaPublicDer(k: RsaKey) {
  return der.seq(der.int(k.n), der.int(k.e));
}

export function rsaPrivateDer(k: RsaKey) {
  return der.seq(der.int(0), der.int(k.n), der.int(k.e), der.int(k.d!), der.int(k.p!), der.int(k.q!), der.int(k.dp!), der.int(k.dq!), der.int(k.qi!));
}

/** ECParameters (RFC 3279) for paramEncoding 'explicit': prime field, a, b, base point, order, cofactor. */
function ecParamsDer(curve: Curve): Uint8Array {
  const c = curve.impl.Point.CURVE();
  const fe = (n: bigint) => der.octets(bigBytes(n, curve.size));
  const base = curve.impl.Point.BASE.toBytes(false);
  const curveSeq = curve.seed ? der.seq(fe(c.a), fe(c.b), der.bitString(encode(curve.seed, Enc.HEX))) : der.seq(fe(c.a), fe(c.b));
  return der.seq(der.int(1), der.seq(der.oid(OID.primeField), der.int(c.p)), curveSeq, der.octets(base), der.int(c.n), der.int(c.h ?? 1n));
}

/** The named curve whose parameters an explicit ECParameters spells out. */
function curveFromParams(n: der.Node): Curve | undefined {
  const [, field, curveSeq, base, order] = der.children(der.expect(n, 0x30));
  const [fieldOid, prime] = der.children(der.expect(field, 0x30));
  if (der.readOid(fieldOid) !== OID.primeField) return undefined;
  const p = der.readInt(prime);
  const [a, b] = der.children(der.expect(curveSeq, 0x30)).slice(0, 2).map((x) => bytesToBigInt(der.expect(x, 0x04).body));
  const nOrder = der.readInt(order);
  const g = der.expect(base, 0x04).body;
  return CURVES.find((cv) => {
    const c = cv.impl.Point.CURVE();
    if (c.p !== p || c.a !== a || c.b !== b || c.n !== nOrder) return false;
    try {
      return cv.impl.Point.fromBytes(hybridToUncompressed(g)).equals(cv.impl.Point.BASE);
    } catch {
      return false;
    }
  });
}

/** The curve named or spelled out by ECParameters / ECPKParameters. */
function curveOfParams(params: der.Node | undefined): { curve?: Curve; explicit: boolean } {
  if (params?.tag === 0x06) return { curve: curveByName(der.readOid(params)), explicit: false };
  if (params?.tag === 0x30) return { curve: curveFromParams(params), explicit: true };
  return { explicit: false };
}

function ecPrivateDer(a: Extract<Asym, { kind: 'ec' }>, withParams: boolean) {
  const parts = [der.int(1), der.octets(bigBytes(a.d!, Math.ceil(bitLength(curveOrder(a.curve)) / 8)))];
  if (withParams) parts.push(der.ctx(0, a.explicit ? ecParamsDer(a.curve) : der.oid(a.curve.oid)));
  parts.push(der.ctx(1, der.bitString(a.pub)));
  return der.seq(...parts);
}

export function spki(a: Asym): Uint8Array {
  let key: Uint8Array;
  if ('rsa' in a) key = rsaPublicDer(a.rsa);
  else if (a.kind === 'dsa') key = der.int(a.dsa.y);
  else if (a.kind === 'dh') key = der.int(a.dh.y);
  else key = a.pub;
  return der.seq(algId(a), der.bitString(key));
}

export function pkcs8(a: Asym): Uint8Array {
  let inner: Uint8Array;
  if ('rsa' in a) inner = rsaPrivateDer(a.rsa);
  else if (a.kind === 'ec') inner = ecPrivateDer(a, false);
  else if (a.kind === 'dsa') inner = der.int(a.dsa.x!);
  else if (a.kind === 'dh') inner = der.int(a.dh.x!);
  else inner = der.octets((a as any).priv);
  return der.seq(der.int(0), algId(a), der.octets(inner));
}

// -----------------------------------------------------------------------------
// DER decoders

function digestByOid(oid: string): DigestAlgo | undefined {
  return ALGOS.find((a) => digestOid(a) === oid);
}

function readPssParams(n: der.Node | undefined): PssParams | null {
  if (!n) return null;
  der.expect(n, 0x30);
  let hash = getDigest('sha1')!;
  let mgf1 = hash;
  let saltLength = 20;
  for (const c of der.children(n)) {
    if (c.tag === 0xa0) {
      const alg = der.children(der.read(c.body))[0];
      hash = digestByOid(der.readOid(alg)) ?? hash;
    } else if (c.tag === 0xa1) {
      const [, params] = der.children(der.read(c.body));
      const alg = der.children(params)[0];
      mgf1 = digestByOid(der.readOid(alg)) ?? mgf1;
    } else if (c.tag === 0xa2) {
      saltLength = Number(der.readInt(der.read(c.body)));
    }
  }
  return { hash, mgf1, saltLength };
}

function readRsaPublic(b: Uint8Array): RsaKey {
  const [n, e] = der.children(der.expect(der.parse(b), 0x30));
  return { n: der.readInt(n), e: der.readInt(e) };
}

function readRsaPrivate(b: Uint8Array): RsaKey {
  const f = der.children(der.expect(der.parse(b), 0x30)).map((x) => der.readInt(x));
  if (f.length < 9) throw new der.DerError('short');
  const [, n, e, d, p, q, dp, dq, qi] = f;
  return completeRsa({ n, e, d, p, q, dp, dq, qi });
}

export function isRsaPrivateDer(b: Uint8Array): boolean {
  try {
    return der.children(der.parse(b)).length >= 9;
  } catch {
    return false;
  }
}

function readEcPrivate(b: Uint8Array, curve?: Curve, explicit = false): Asym {
  const parts = der.children(der.expect(der.parse(b), 0x30));
  const d = bytesToBigInt(der.expect(parts[1], 0x04).body);
  for (const p of parts.slice(2)) {
    if (p.tag === 0xa0) ({ curve, explicit } = curveOfParams(der.read(p.body)));
  }
  if (!curve) throw keyErr.unsupported();
  const a = ecFromPrivate(curve, d) as Extract<Asym, { kind: 'ec' }>;
  if (explicit) a.explicit = true;
  return a;
}

function dsaParams(params: der.Node | undefined) {
  const [p, q, g] = der.children(der.expect(params, 0x30)).map((x) => der.readInt(x));
  if (g === undefined) throw keyErr.unsupported();
  return { p, q, g };
}

function dhParams(oid: string, params: der.Node | undefined): { p: bigint; g: bigint; q?: bigint } {
  const f = der.children(der.expect(params, 0x30)).map((x) => (x.tag === 0x02 ? der.readInt(x) : undefined));
  if (f[0] === undefined || f[1] === undefined) throw keyErr.unsupported();
  // PKCS#3: p, g[, privateValueLength]; X9.42: p, g, q, ...
  return oid === OID.dhx ? { p: f[0], g: f[1], q: f[2] } : { p: f[0], g: f[1] };
}

/** Traditional "DSA PRIVATE KEY": SEQUENCE { 0, p, q, g, y, x } */
function readDsaPrivate(b: Uint8Array): Asym {
  const f = der.children(der.expect(der.parse(b), 0x30)).map((x) => der.readInt(x));
  if (f.length < 6) throw new der.DerError('short');
  const [, p, q, g, y, x] = f;
  return { kind: 'dsa', dsa: { p, q, g, y, x } };
}


function algorithm(alg: der.Node): { oid: string; params?: der.Node } {
  const [o, params] = der.children(der.expect(alg, 0x30));
  return { oid: der.readOid(o), params };
}

export function readSpki(b: Uint8Array): Asym {
  const [alg, bits] = der.children(der.expect(der.parse(b), 0x30));
  const { oid, params } = algorithm(alg);
  const key = der.readBitString(bits);
  if (oid === OID.rsa) return { kind: 'rsa', rsa: readRsaPublic(key) };
  if (oid === OID.rsaPss) return { kind: 'rsa-pss', rsa: readRsaPublic(key), pss: readPssParams(params) };
  if (oid === OID.ec) {
    const { curve, explicit } = curveOfParams(params);
    if (!curve) throw keyErr.unsupported();
    ecPoint(curve, key);
    const a: Asym = { kind: 'ec', curve, pub: curve.impl.Point.fromBytes(hybridToUncompressed(key)).toBytes(false) };
    if (explicit) a.explicit = true;
    return a;
  }
  if (oid === OID.dsa) return { kind: 'dsa', dsa: { ...dsaParams(params), y: der.readInt(der.parse(key)) } };
  if (oid === OID.dh || oid === OID.dhx) return { kind: 'dh', dh: { ...dhParams(oid, params), y: der.readInt(der.parse(key)) } };
  for (const info of Object.values(OKP)) {
    if (info.oid === oid) {
      if (key.length !== info.len) throw keyErr.unsupported();
      return { kind: info.kind, pub: key.slice() };
    }
  }
  throw keyErr.unsupported();
}

export function readPkcs8(b: Uint8Array): Asym {
  const [, alg, keyOctets] = der.children(der.expect(der.parse(b), 0x30));
  const { oid, params } = algorithm(alg);
  const inner = der.expect(keyOctets, 0x04).body;
  if (oid === OID.rsa) return { kind: 'rsa', rsa: readRsaPrivate(inner) };
  if (oid === OID.rsaPss) return { kind: 'rsa-pss', rsa: readRsaPrivate(inner), pss: readPssParams(params) };
  if (oid === OID.ec) {
    const { curve, explicit } = curveOfParams(params);
    return readEcPrivate(inner, curve, explicit);
  }
  if (oid === OID.dsa) {
    const { p, q, g } = dsaParams(params);
    const x = der.readInt(der.parse(inner));
    return { kind: 'dsa', dsa: { p, q, g, y: modPow(g, x, p), x } };
  }
  if (oid === OID.dh || oid === OID.dhx) {
    const { p, g, q } = dhParams(oid, params);
    return { kind: 'dh', dh: dhFromPrivate(p, g, der.readInt(der.parse(inner)), q) };
  }
  for (const info of Object.values(OKP)) {
    if (info.oid === oid) {
      const priv = der.expect(der.parse(inner), 0x04).body;
      if (priv.length !== info.len) throw keyErr.unsupported();
      return okpFromPrivate(info.kind, priv);
    }
  }
  throw keyErr.unsupported();
}

// -----------------------------------------------------------------------------
// encryption of private keys

function bytesToKey(cipher: string, pass: Uint8Array, salt: Uint8Array): { key: Uint8Array; keyLen: number } {
  const info = findCipher(cipher)!;
  const need = info.keyLength;
  const parts: Uint8Array[] = [];
  let prev = new Uint8Array(0);
  let have = 0;
  while (have < need) {
    prev = md5(concat([prev, pass, salt])) as Uint8Array<ArrayBuffer>;
    parts.push(prev);
    have += prev.length;
  }
  return { key: concat(parts).subarray(0, need), keyLen: need };
}

function runCipher(name: string, encrypt: boolean, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const c = new CipherBase(encrypt);
  c.initiv(name, key, iv, -1);
  return concat([c.update(data), c.final()]);
}

function decryptPkcs8(b: Uint8Array, pass: Uint8Array): Uint8Array {
  const [alg, data] = der.children(der.expect(der.parse(b), 0x30));
  const { oid, params } = algorithm(alg);
  if (oid !== OID.pbes2 || !params) throw keyErr.unsupported();
  const [kdf, enc] = der.children(params);
  const kdfAlg = algorithm(kdf);
  if (kdfAlg.oid !== OID.pbkdf2 || !kdfAlg.params) throw keyErr.unsupported();
  const kp = der.children(kdfAlg.params);
  const salt = der.expect(kp[0], 0x04).body;
  const iter = Number(der.readInt(kp[1]));
  let prf = getDigest('sha1')!;
  for (const x of kp.slice(2)) {
    if (x.tag === 0x30) {
      const p = der.readOid(der.children(x)[0]);
      const name = Object.entries(OID).find(([, v]) => v === p)?.[0];
      prf = getDigest(name?.replace('hmacWith', '') ?? '') ?? prf;
    }
  }
  const encAlg = algorithm(enc);
  const cipher = PBE_CIPHERS[encAlg.oid];
  if (!cipher) throw keyErr.unsupported();
  const ivLength = findCipher(cipher)!.ivLength ?? 0;
  const iv = ivLength ? der.expect(encAlg.params, 0x04).body : new Uint8Array(0);
  const keyLen = findCipher(cipher)!.keyLength;
  const key = pbkdf2(prf, pass, salt, iter, keyLen);
  return runCipher(cipher, false, key, iv, der.expect(data, 0x04).body);
}

function encryptPkcs8(plain: Uint8Array, cipher: string, pass: Uint8Array): Uint8Array {
  const info = findCipher(cipher);
  const oid = Object.entries(PBE_CIPHERS).find(([, n]) => info && findCipher(n)!.nid === info.nid)?.[0];
  if (!info || !oid) throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
  const salt = new Uint8Array(16);
  fillRandom(salt);
  const iv = new Uint8Array(info.ivLength ?? 0);
  fillRandom(iv);
  const iter = 2048;
  const key = pbkdf2(getDigest('sha256')!, pass, salt, iter, info.keyLength);
  const ct = runCipher(info.name, true, key, iv, plain);
  const kdf = der.seq(der.oid(OID.pbkdf2), der.seq(der.octets(salt), der.int(iter), der.seq(der.oid(OID.hmacWithSHA256), der.nul())));
  const enc = iv.length ? der.seq(der.oid(oid), der.octets(iv)) : der.seq(der.oid(oid));
  return der.seq(der.seq(der.oid(OID.pbes2), der.seq(kdf, enc)), der.octets(ct));
}

/** Legacy "Proc-Type: 4,ENCRYPTED" PEM bodies. */
function decryptLegacy(block: der.PemBlock, pass: Uint8Array): Uint8Array {
  const [cipherName, ivHex] = (block.headers['DEK-Info'] ?? '').split(',');
  const cipher = findCipher(cipherName?.toLowerCase());
  if (!cipher || !ivHex) throw keyErr.unsupported();
  const iv = encode(ivHex, Enc.HEX);
  const { key } = bytesToKey(cipherName.toLowerCase(), pass, iv.subarray(0, 8));
  return runCipher(cipherName.toLowerCase(), false, key, iv, block.der);
}

function encryptLegacy(label: string, plain: Uint8Array, cipher: string, pass: Uint8Array): string {
  const info = findCipher(cipher);
  if (!info) throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
  const iv = new Uint8Array(info.ivLength ?? 8);
  fillRandom(iv);
  const { key } = bytesToKey(cipher, pass, iv.subarray(0, 8));
  const ct = runCipher(cipher, true, key, iv, plain);
  const pem = der.toPem(label, ct);
  const head = `-----BEGIN ${label}-----\n`;
  return head + `Proc-Type: 4,ENCRYPTED\nDEK-Info: ${info.name.toUpperCase()},${decode(iv, Enc.HEX).toUpperCase()}\n\n` + pem.slice(head.length);
}

// -----------------------------------------------------------------------------
// parsing from (data, format, type, passphrase)

export const kKeyFormatDER = 0;
export const kKeyFormatPEM = 1;
export const kKeyFormatJWK = 2;
export const kKeyEncodingPKCS1 = 0;
export const kKeyEncodingPKCS8 = 1;
export const kKeyEncodingSPKI = 2;
export const kKeyEncodingSEC1 = 3;

function wrapDecode<T>(f: () => T, onError: () => Error): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof der.DerError || (e instanceof Error && !(e as any).code && !(e as any).library && e.message !== 'Failed to read asymmetric key')) throw onError();
    throw e;
  }
}

function privateFromDer(b: Uint8Array, type: number | undefined, pass: Uint8Array | undefined): Asym {
  if (type === kKeyEncodingPKCS1) return wrapDecode(() => ({ kind: 'rsa', rsa: readRsaPrivate(b) }) as Asym, keyErr.unsupported);
  if (type === kKeyEncodingSEC1) return wrapDecode(() => readEcPrivate(b), keyErr.unsupported);
  // PKCS#8, maybe encrypted
  return wrapDecode(() => {
    const top = der.children(der.expect(der.parse(b), 0x30));
    if (top.length === 2 && top[0].tag === 0x30) {
      if (!pass) throw err('ERR_MISSING_PASSPHRASE', 'Passphrase required for encrypted key');
      return readPkcs8(decryptPkcs8(b, pass));
    }
    return readPkcs8(b);
  }, keyErr.fieldMissing);
}

const PRIVATE_LABELS = ['PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY'];
const PUBLIC_LABELS = ['PUBLIC KEY', 'RSA PUBLIC KEY', 'CERTIFICATE'];

function privateFromPem(text: string, pass: Uint8Array | undefined): Asym {
  const block = der.fromPem(text).find((b) => PRIVATE_LABELS.includes(b.label));
  if (!block) throw keyErr.unsupported();
  let body = block.der;
  const encrypted = block.headers['Proc-Type']?.includes('ENCRYPTED');
  if (encrypted) {
    if (!pass) throw keyErr.interrupted();
    body = decryptLegacy(block, pass);
  }
  return wrapDecode(() => {
    switch (block.label) {
      case 'RSA PRIVATE KEY':
        return { kind: 'rsa', rsa: readRsaPrivate(body) } as Asym;
      case 'EC PRIVATE KEY':
        return readEcPrivate(body);
      case 'DSA PRIVATE KEY':
        return readDsaPrivate(body);
      case 'ENCRYPTED PRIVATE KEY':
        if (!pass) throw keyErr.interrupted();
        return readPkcs8(decryptPkcs8(body, pass));
      default:
        return readPkcs8(body);
    }
  }, keyErr.unsupported);
}

/** The SubjectPublicKeyInfo inside an X.509 certificate. */
function certificateSpki(b: Uint8Array): Uint8Array {
  const [tbs] = der.children(der.parse(b));
  const f = der.children(tbs);
  const i = f[0].tag === 0xa0 ? 6 : 5;
  return f[i].raw;
}

/** EVPKeyPointer::TryParsePublicKeyPEM: null when there is no public-key PEM block. */
function publicFromPem(text: string): Asym | null {
  const block = der.fromPem(text).find((b) => PUBLIC_LABELS.includes(b.label));
  if (!block) return null;
  return wrapDecode(() => {
    if (block.label === 'RSA PUBLIC KEY') return { kind: 'rsa', rsa: readRsaPublic(block.der) } as Asym;
    if (block.label === 'CERTIFICATE') return readSpki(certificateSpki(block.der));
    return readSpki(block.der);
  }, keyErr.wrongTag);
}

const latin1 = (b: Uint8Array) => decode(b, Enc.LATIN1);

/** KeyObjectData::GetPrivateKeyFromJs for buffer input. */
export function parsePrivate(data: Uint8Array, format: number, type: number | undefined, pass: Uint8Array | undefined): Asym {
  if (format === kKeyFormatPEM) return privateFromPem(latin1(data), pass);
  return privateFromDer(data, type, pass);
}

/** KeyObjectData::GetPublicOrPrivateKeyFromJs for buffer input: [key, isPrivate]. */
export function parsePublicOrPrivate(data: Uint8Array, format: number, type: number | undefined, pass: Uint8Array | undefined): [Asym, boolean] {
  if (format === kKeyFormatPEM) {
    const text = latin1(data);
    const pub = publicFromPem(text);
    if (pub) return [pub, false];
    return [privateFromPem(text, pass), true];
  }
  const isPublic = type === kKeyEncodingPKCS1 ? !isRsaPrivateDer(data) : type === kKeyEncodingSPKI;
  if (isPublic) {
    try {
      if (type === kKeyEncodingPKCS1) return [{ kind: 'rsa', rsa: readRsaPublic(data) }, false];
      return [readSpki(data), false];
    } catch (e) {
      if ((e as any)?.library) throw e;
      throw keyErr.readAsym();
    }
  }
  return [privateFromDer(data, type, pass), true];
}

// -----------------------------------------------------------------------------
// writing to (format, type, cipher, passphrase)

export function writePublic(a: Asym, format: number, type: number): string | Uint8Array {
  let body: Uint8Array;
  let label: string;
  if (type === kKeyEncodingPKCS1 && 'rsa' in a) {
    body = rsaPublicDer(a.rsa);
    label = 'RSA PUBLIC KEY';
  } else {
    body = spki(a);
    label = 'PUBLIC KEY';
  }
  return format === kKeyFormatPEM ? der.toPem(label, body) : body;
}

export function writePrivate(a: Asym, format: number, type: number, cipher: string | undefined | null, pass: Uint8Array | undefined): string | Uint8Array {
  if (type === kKeyEncodingPKCS8) {
    let body = pkcs8(a);
    let label = 'PRIVATE KEY';
    if (cipher) {
      body = encryptPkcs8(body, cipher, pass ?? new Uint8Array(0));
      label = 'ENCRYPTED PRIVATE KEY';
    }
    return format === kKeyFormatPEM ? der.toPem(label, body) : body;
  }
  let body: Uint8Array;
  let label: string;
  if (type === kKeyEncodingPKCS1 && 'rsa' in a) {
    body = rsaPrivateDer(a.rsa);
    label = 'RSA PRIVATE KEY';
  } else if (type === kKeyEncodingSEC1 && a.kind === 'ec') {
    body = ecPrivateDer(a, true);
    label = 'EC PRIVATE KEY';
  } else {
    throw err('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Unsupported key encoding');
  }
  if (format !== kKeyFormatPEM) return body;
  if (cipher) return encryptLegacy(label, body, cipher.toLowerCase(), pass ?? new Uint8Array(0));
  return der.toPem(label, body);
}

// -----------------------------------------------------------------------------
// JWK

const b64url = (b: Uint8Array) => decode(b, Enc.BASE64URL);
const unb64 = (s: string) => encode(s, Enc.BASE64URL);
const bigB64 = (n: bigint) => b64url(bigIntToBytes(n));

export function exportJwk(a: Asym, isPrivate: boolean, target: any, handleRsaPss: boolean) {
  if (a.kind === 'rsa' || (a.kind === 'rsa-pss' && handleRsaPss)) {
    const k = a.rsa;
    target.kty = 'RSA';
    target.n = bigB64(k.n);
    target.e = bigB64(k.e);
    if (isPrivate) {
      target.d = bigB64(k.d!);
      target.p = bigB64(k.p!);
      target.q = bigB64(k.q!);
      target.dp = bigB64(k.dp!);
      target.dq = bigB64(k.dq!);
      target.qi = bigB64(k.qi!);
    }
    return;
  }
  if (a.kind === 'ec') {
    const s = a.curve.size;
    if (a.curve.noJwk) throw err('ERR_CRYPTO_JWK_UNSUPPORTED_CURVE', `Unsupported JWK EC curve: ${a.curve.name}.`);
    target.kty = 'EC';
    target.x = b64url(a.pub.subarray(1, 1 + s));
    target.y = b64url(a.pub.subarray(1 + s));
    target.crv = a.curve.jwk;
    if (isPrivate) target.d = b64url(bigIntToBytes(a.d!, Math.ceil(bitLength(curveOrder(a.curve)) / 8)));
    return;
  }
  if (a.kind === 'rsa-pss' || a.kind === 'dsa' || a.kind === 'dh') throw err('ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE');
  target.crv = OKP[a.kind].jwk;
  if (isPrivate) target.d = b64url((a as any).priv);
  target.x = b64url(a.pub);
  target.kty = 'OKP';
}

/** ImportJWKAsymmetricKey */
export function importJwk(jwk: any, kty: string, namedCurve: unknown): KeyData {
  if (kty === 'RSA') {
    const bad = () => err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK RSA key');
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw bad();
    const big = (s: string) => bytesToBigInt(unb64(s));
    const rsa: RsaKey = { n: big(jwk.n), e: big(jwk.e) };
    if (jwk.d === undefined) return { type: 1, asym: { kind: 'rsa', rsa } };
    for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi']) if (typeof jwk[f] !== 'string') throw bad();
    Object.assign(rsa, { d: big(jwk.d), p: big(jwk.p), q: big(jwk.q), dp: big(jwk.dp), dq: big(jwk.dq), qi: big(jwk.qi) });
    return { type: 2, asym: { kind: 'rsa', rsa } };
  }
  if (kty === 'EC') {
    const curve = typeof namedCurve === 'string' ? curveByName(namedCurve) : undefined;
    if (!curve) throw err('ERR_CRYPTO_INVALID_CURVE');
    const bad = () => err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK EC key');
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw bad();
    const x = unb64(jwk.x);
    const y = unb64(jwk.y);
    let pub: Uint8Array;
    try {
      pub = curve.impl.Point.fromBytes(concat([Uint8Array.of(4), bigIntToBytes(bytesToBigInt(x), curve.size), bigIntToBytes(bytesToBigInt(y), curve.size)])).toBytes(false);
    } catch {
      throw bad();
    }
    if (jwk.d === undefined) return { type: 1, asym: { kind: 'ec', curve, pub } };
    if (typeof jwk.d !== 'string') throw bad();
    const d = bytesToBigInt(unb64(jwk.d));
    const a = ecFromPrivate(curve, d) as Extract<Asym, { kind: 'ec' }>;
    if (decode(a.pub, Enc.HEX) !== decode(pub, Enc.HEX)) throw bad();
    return { type: 2, asym: a };
  }
  throw err('ERR_CRYPTO_INVALID_JWK', `${kty} is not a supported JWK key type`);
}

// -----------------------------------------------------------------------------
// details

export function asymmetricKeyType(a: Asym): string {
  return a.kind;
}

const LN: Record<string, string> = { SHA1: 'sha1', SHA224: 'sha224', SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512', 'SHA512-224': 'sha512-224', 'SHA512-256': 'sha512-256', MD5: 'md5', 'SHA3-224': 'sha3-224', 'SHA3-256': 'sha3-256', 'SHA3-384': 'sha3-384', 'SHA3-512': 'sha3-512', RIPEMD160: 'ripemd160', SM3: 'sm3' };
export const digestLn = (a: DigestAlgo) => LN[a.name] ?? a.name.toLowerCase();

export function keyDetail(a: Asym, target: any) {
  if ('rsa' in a) {
    target.modulusLength = bitLength(a.rsa.n);
    const e = bigIntToBytes(a.rsa.e);
    target.publicExponent = e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
    if (a.kind === 'rsa-pss' && a.pss) {
      target.hashAlgorithm = digestLn(a.pss.hash);
      target.mgf1HashAlgorithm = digestLn(a.pss.mgf1);
      target.saltLength = a.pss.saltLength;
    }
    return;
  }
  if (a.kind === 'ec') {
    target.namedCurve = a.curve.name;
    return;
  }
  if (a.kind === 'dsa') {
    target.modulusLength = bitLength(a.dsa.p);
    target.divisorLength = bitLength(a.dsa.q);
    return;
  }
  throw err('ERR_CRYPTO_INVALID_KEYTYPE');
}
