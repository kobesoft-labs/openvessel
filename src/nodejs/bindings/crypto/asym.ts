// crypto_sig.cc / crypto_keygen.cc / crypto_ec.cc / crypto_rsa.cc / crypto_cipher.cc (public-key
// ciphers) / crypto_dh.cc: Sign, Verify, SignJob, NamedKeyPairGenJob, EcKeyPairGenJob,
// RsaKeyPairGenJob, DsaKeyPairGenJob, DhKeyPairGenJob, DHBitsJob, ECDH, ECDHConvertKey,
// publicEncrypt/privateDecrypt/privateEncrypt/publicDecrypt.
// Key material and encodings live in asymkeys.ts; RSA math in rsa.ts.

import { ed25519, ed25519ctx, x25519 } from '@noble/curves/ed25519.js';
import { ed448, x448 } from '@noble/curves/ed448.js';
import { getDigest, type Ctx, type DigestAlgo } from './digests.ts';
import {
  CURVES,
  OKP,
  asymmetricKeyType,
  curveByName,
  curveOrder,
  ecFromPrivate,
  ecPoint,
  exportJwk,
  hasPrivate,
  importJwk,
  keyDetail,
  okpFromPrivate,
  parsePrivate,
  parsePublicOrPrivate,
  pkcs8,
  randomScalar,
  readPkcs8,
  readSpki,
  spki,
  writePrivate,
  writePublic,
  type Asym,
  type Curve,
  type OkpKind,
  type PqKind,
} from './asymkeys.ts';
import {
  base64Decode,
  handleFor,
  kKeyFormatJWK,
  kKeyFormatRawPrivate,
  kKeyFormatRawPublic,
  kKeyFormatRawSeed,
  kKeyFormatStore,
  keyDataOf,
  newCryptoKeyPair,
  registerAsymOps,
  type KeyData,
} from './keys.ts';
import * as rsa from './rsa.ts';
import { PQ, isPqKind, pqDecapsulate, pqEncapsulate, pqFromPrivate, pqFromPublic, pqFromSeed, pqGenerate, pqImportJwk, pqSign, pqVerify, type PqKey } from './pqc.ts';
import { dhkemDecapsulate, dhkemEncapsulate } from './dhkem.ts';
import { S } from '../../state.ts';
import { bigIntToBytes, bitLength, bytesToBigInt } from './random.ts';
import { decodeInput, err, fillRandom, isAnyBufferSource, isWebCryptoJob, jobClass, osslError, stringOrBuffer, toArrayBuffer, toBuffer, view } from './util.ts';
import * as der from './asn1.ts';
import { findCipher } from './cipher.ts';
import { DH_GROUPS } from './tables.ts';
import { dhFromPrivate, dhPrivate, dhSecret, dsaOrderBytes, dsaSign, dsaVerify, generateDsa } from './dsa.ts';
import { generatePrime } from './random.ts';

const asymOf = (d: KeyData) => (d as Extract<KeyData, { type: 1 | 2 }>).asym;

const notSupportedForKeyType = () =>
  osslError('03000096', 'digital envelope routines', 'operation not supported for this keytype', 'ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE');

// -----------------------------------------------------------------------------
// key arguments: (data | handle, format, type, passphrase, namedCurve)

function passphraseOf(v: unknown): Uint8Array | undefined {
  return isAnyBufferSource(v) ? view(v) : undefined;
}

const incompatible = () => err('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS');
const invalidKeyData = () => err('ERR_INVALID_ARG_VALUE', 'Invalid key data');

/** ImportJWKAsymmetricKey: the JWK validation lib did in JS before Node 24 now happens here. */
function jwkKey(jwk: any, wantPrivate: boolean): KeyData {
  if (!jwk || typeof jwk !== 'object' || typeof jwk.kty !== 'string') throw err('ERR_CRYPTO_INVALID_JWK');
  const kty = jwk.kty;
  let data: KeyData;
  if (kty === 'OKP') {
    const bad = () => err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK OKP key');
    const kind = typeof jwk.crv === 'string' ? (jwk.crv.toLowerCase() as OkpKind) : undefined;
    const info = kind && OKP[kind];
    if (!info || info.jwk !== jwk.crv || typeof jwk.x !== 'string') throw bad();
    const x = base64Decode(jwk.x);
    if (x.length !== info.len) throw bad();
    if (jwk.d === undefined) {
      data = { type: 1, asym: { kind: info.kind, pub: x.slice() } };
    } else {
      if (typeof jwk.d !== 'string') throw bad();
      const d = base64Decode(jwk.d);
      if (d.length !== info.len) throw bad();
      const a = okpFromPrivate(info.kind, d);
      if (!equalArrays((a as any).pub, x)) throw bad();
      data = { type: 2, asym: a };
    }
  } else if (kty === 'EC') {
    if (typeof jwk.crv !== 'string') throw err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK EC key');
    data = importJwk(jwk, kty, jwk.crv);
  } else if (kty === 'RSA') {
    data = importJwk(jwk, kty, undefined);
  } else if (kty === 'AKP') {
    const { type, key } = pqImportJwk(jwk, wantPrivate, base64Decode);
    data = { type, asym: { kind: key.kind as PqKind, pq: key } };
  } else {
    throw err('ERR_CRYPTO_INVALID_JWK', `${kty} is not a supported JWK key type`);
  }
  if (wantPrivate && data.type !== 2) throw err('ERR_CRYPTO_INVALID_JWK', 'JWK does not contain private key material');
  return data;
}

/** KeyObjectData::CreateFromRaw: raw-public / raw-private / raw-seed bytes of a named key type. */
function rawKey(bytes: Uint8Array, format: number, typeName: unknown, namedCurve: unknown): KeyData {
  const name = String(typeName);
  if (name === 'ec') {
    const curve = typeof namedCurve === 'string' ? curveByName(namedCurve) : undefined;
    if (!curve) throw err('ERR_CRYPTO_INVALID_CURVE');
    if (format === kKeyFormatRawPublic) {
      try {
        return { type: 1, asym: { kind: 'ec', curve, pub: ecPoint(curve, bytes).toBytes(false) } };
      } catch {
        throw invalidKeyData();
      }
    }
    if (format === kKeyFormatRawPrivate) {
      const d = bytesToBigInt(bytes);
      if (bytes.length !== Math.ceil(bitLength(curveOrder(curve)) / 8) || d < 1n || d >= curveOrder(curve)) throw invalidKeyData();
      return { type: 2, asym: ecFromPrivate(curve, d) };
    }
    throw incompatible();
  }
  const kind = name as OkpKind;
  if (Object.prototype.hasOwnProperty.call(OKP, kind)) {
    if (format === kKeyFormatRawSeed) throw incompatible();
    if (bytes.length !== OKP[kind].len) throw invalidKeyData();
    if (format === kKeyFormatRawPrivate) return { type: 2, asym: okpFromPrivate(kind, bytes) };
    return { type: 1, asym: { kind, pub: bytes.slice() } };
  }
  if (isPqKind(name)) {
    // ML keys are made from their seed, SLH-DSA keys from the whole raw private key
    const slhDsa = PQ[name].family === 'slh-dsa';
    const asym = (pq: PqKey): Asym => ({ kind: name as PqKind, pq });
    if (format === kKeyFormatRawPublic) return { type: 1, asym: asym(pqFromPublic(name, bytes)) };
    if (format === kKeyFormatRawSeed && !slhDsa) return { type: 2, asym: asym(pqFromSeed(name, bytes)) };
    if (format === kKeyFormatRawPrivate && slhDsa) return { type: 2, asym: asym(pqFromPrivate(name, bytes)) };
    throw incompatible();
  }
  if (name === 'rsa' || name === 'rsa-pss' || name === 'dsa' || name === 'dh') throw incompatible();
  // the comparison saw the whole string, the message is a C string
  throw err('ERR_INVALID_ARG_VALUE', `Invalid asymmetricKeyType: ${name.split('\0')[0]}`);
}

/**
 * A private key referenced by URI (OpenSSL's STORE, Node 26): only OpenSSL's `file` loader has a
 * counterpart here, reading the file (a path once lib has converted a file: URL) from the VFS.
 */
function storeKey(data: { uri: string; properties: string | null }, pass: Uint8Array | undefined): Asym {
  const uri = String(data?.uri);
  if (!uri.startsWith('/')) throw osslError('1600009A', 'STORE routines', 'unsupported', 'ERR_OSSL_OSSL_STORE_UNSUPPORTED');
  let bytes: Uint8Array;
  try {
    bytes = view(S.requireBuiltin!('fs').readFileSync(uri));
  } catch (e) {
    const reason = (e as any)?.code === 'ENOENT' ? 'No such file or directory' : String((e as any)?.message ?? e);
    throw Object.assign(new Error(`error:80000002:system library::${reason}`), { library: 'system library', opensslErrorStack: [`error:80000002:system library::${reason}`] });
  }
  const text = decodeLatin1(bytes);
  const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text);
  try {
    if (pem) return parsePrivate(bytes, 1, undefined, pass);
    for (const type of [1, 0, 3]) {
      try {
        return parsePrivate(bytes, 0, type, pass);
      } catch {}
    }
  } catch (e) {
    // a missing or wrong passphrase reports as such
    if ((e as any)?.code === 'ERR_MISSING_PASSPHRASE' || (e as any)?.library) throw e;
  }
  throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to load private key from store');
}

const decodeLatin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** KeyObjectData::GetPrivateKeyFromJs / GetPublicOrPrivateKeyFromJs */
function keyArg(args: any[], i: number, wantPrivate: boolean): KeyData {
  const d = keyDataOf(args[i]);
  if (d) return d;
  const format = args[i + 1];
  if (format === kKeyFormatJWK) return jwkKey(args[i], wantPrivate);
  if (format === kKeyFormatRawPublic || format === kKeyFormatRawPrivate || format === kKeyFormatRawSeed) {
    const k = rawKey(view(args[i]), format, args[i + 2], args[i + 4]);
    if (wantPrivate && k.type !== 2) throw incompatible();
    return k;
  }
  if (format === kKeyFormatStore) return { type: 2, asym: storeKey(args[i], passphraseOf(args[i + 3])) };
  if (typeof args[i] !== 'string' && !isAnyBufferSource(args[i])) throw err('ERR_INVALID_ARG_TYPE', 'Invalid key data');
  if (wantPrivate) return { type: 2, asym: parsePrivate(stringOrBuffer(args[i]), format, args[i + 2], passphraseOf(args[i + 3])) };
  const [asym, isPrivate] = parsePublicOrPrivate(stringOrBuffer(args[i]), format, args[i + 2], passphraseOf(args[i + 3]));
  return { type: isPrivate ? 2 : 1, asym };
}

const privateKeyArg = (args: any[], i: number) => keyArg(args, i, true);
const anyKeyArg = (args: any[], i: number) => keyArg(args, i, false);

// -----------------------------------------------------------------------------
// KeyObjectHandle operations for asymmetric keys

function asBuffer(v: string | Uint8Array) {
  return typeof v === 'string' ? v : toBuffer(v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v : v.slice());
}

function sameKey(a: Asym, b: Asym): boolean {
  if (a.kind !== b.kind) return false;
  // EVP_PKEY_eq compares the group, not how its parameters are encoded
  if (a.kind === 'ec' && b.kind === 'ec') return a.curve === b.curve && equalArrays(a.pub, b.pub);
  return equalArrays(spki(a), spki(b));
}

function equalArrays(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const isOkp = (a: Asym) => Object.prototype.hasOwnProperty.call(OKP, a.kind);

/** KeyObjectHandle::Export / keypair encodings for the raw formats (Node 24+). */
function exportRaw(data: KeyData, format: number, pointForm: unknown): Uint8Array {
  const a = asymOf(data);
  if (format === kKeyFormatRawPublic) {
    if (a.kind === 'ec') return encodePoint(a.curve, a.pub, typeof pointForm === 'number' ? pointForm : POINT_CONVERSION_UNCOMPRESSED);
    if (isOkp(a)) return (a as any).pub;
    if ('pq' in a) return a.pq.pub;
    throw incompatible();
  }
  if (format === kKeyFormatRawPrivate && data.type === 2) {
    if (a.kind === 'ec') return bigIntToBytes(a.d!, Math.ceil(bitLength(curveOrder(a.curve)) / 8));
    if (isOkp(a)) return (a as any).priv;
    if ('pq' in a && PQ[a.kind].family === 'slh-dsa') return a.pq.priv!;
  }
  if (format === kKeyFormatRawSeed && data.type === 2 && 'pq' in a && PQ[a.kind].family !== 'slh-dsa') {
    if (!a.pq.seed) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to get raw seed');
    return a.pq.seed;
  }
  throw incompatible();
}

registerAsymOps({
  init(type, args) {
    if (type === 1) return { type: 1, asym: asymOf(anyKeyArg(args, 0)) };
    return privateKeyArg(args, 0);
  },
  export(data, args) {
    const a = asymOf(data);
    const format = args[0];
    if (format === kKeyFormatRawPublic || format === kKeyFormatRawPrivate || format === kKeyFormatRawSeed) return toBuffer(exportRaw(data, format, args[1]).slice());
    if (data.type === 1) return asBuffer(writePublic(a, format, args[1]));
    return asBuffer(writePrivate(a, format, args[1], args[2], passphraseOf(args[3])));
  },
  exportJwk(data, target, handleRsaPss) {
    exportJwk(asymOf(data), data.type === 2, target, handleRsaPss);
  },
  keyDetail: (data, target) => keyDetail(asymOf(data), target),
  asymmetricKeyType: (data) => asymmetricKeyType(asymOf(data)),
  checkEcKeyData(data) {
    const a = asymOf(data);
    if (a.kind !== 'ec') return false;
    try {
      ecPoint(a.curve, a.pub);
      if (data.type === 2) return a.d! > 0n && a.d! < curveOrder(a.curve) && equalArrays((ecFromPrivate(a.curve, a.d!) as any).pub, a.pub);
      return true;
    } catch {
      return false;
    }
  },
  equals: (a, b) => sameKey(asymOf(a), asymOf(b)),
  rawPublicKey(data) {
    if (asymOf(data).kind === 'ec') throw incompatible();
    return exportRaw(data, kKeyFormatRawPublic, undefined);
  },
  rawPrivateKey(data) {
    return exportRaw(data, kKeyFormatRawPrivate, undefined);
  },
  // seeds belong to ML-DSA / ML-KEM keys
  rawSeed: (data) => exportRaw(data, kKeyFormatRawSeed, undefined),
  exportECPublicRaw(data, form) {
    if (asymOf(data).kind !== 'ec') throw incompatible();
    return exportRaw(data, kKeyFormatRawPublic, form);
  },
  exportECPrivateRaw(data) {
    if (asymOf(data).kind !== 'ec') throw incompatible();
    return exportRaw(data, kKeyFormatRawPrivate, undefined);
  },
  exportECPrivatePkcs8(data) {
    const a = asymOf(data);
    if (a.kind !== 'ec' || data.type !== 2) throw incompatible();
    return pkcs8(a);
  },
  toDer: (data) => (data.type === 2 ? pkcs8(asymOf(data)) : spki(asymOf(data))),
  fromDer: (type, bytes) => ({ type, asym: type === 2 ? readPkcs8(bytes) : readSpki(bytes) }),
});

// -----------------------------------------------------------------------------
// signatures

const RSA_PKCS1_PADDING = 1;
const RSA_NO_PADDING = 3;
const RSA_PKCS1_OAEP_PADDING = 4;
const RSA_PKCS1_PSS_PADDING = 6;
const kSigEncP1363 = 1;

const isEdKind = (k: string) => k === 'ed25519' || k === 'ed448';
const isXKind = (k: string) => k === 'x25519' || k === 'x448';

/** The digest an RSA-PSS key restricts signing to, or the requested one. */
function pssSetup(a: Asym, algo: DigestAlgo, saltLength: number | undefined, signing: boolean) {
  let mgf = algo;
  let salt = saltLength ?? (signing ? rsa.RSA_PSS_SALTLEN_AUTO_DIGEST_MAX : rsa.RSA_PSS_SALTLEN_AUTO);
  if (a.kind === 'rsa-pss' && a.pss) {
    // the key's minimum salt length is checked when the padding is set up, before the digest
    if (saltLength !== undefined && saltLength >= 0 && saltLength < a.pss.saltLength) {
      throw osslError('1C8000AC', 'Provider routines', 'pss saltlen too small', 'ERR_OSSL_PSS_SALTLEN_TOO_SMALL');
    }
    if (algo !== a.pss.hash) throw osslError('1C8000AE', 'Provider routines', 'digest not allowed', 'ERR_OSSL_DIGEST_NOT_ALLOWED');
    mgf = a.pss.mgf1;
    if (saltLength === undefined) salt = a.pss.saltLength;
  }
  return { mgf, salt };
}

function defaultDigest(a: Asym): DigestAlgo {
  if (a.kind === 'rsa-pss' && a.pss) return a.pss.hash;
  return getDigest('sha256')!;
}

function signDigest(a: Asym, algo: DigestAlgo, hash: Uint8Array, padding: number | undefined, saltLength: number | undefined): Uint8Array {
  if ('rsa' in a) {
    if (!hasPrivate(a)) throw notSupportedForKeyType();
    const pad = padding ?? (a.kind === 'rsa-pss' ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING);
    if (pad === RSA_PKCS1_PSS_PADDING) {
      const { mgf, salt } = pssSetup(a, algo, saltLength, true);
      return rsa.pssSign(a.rsa, algo, mgf, hash, salt);
    }
    if (pad !== RSA_PKCS1_PADDING || a.kind === 'rsa-pss') throw osslError('1C8000A5', 'Provider routines', 'illegal or unsupported padding mode', 'ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE');
    return rsa.pkcs1Sign(a.rsa, algo, hash);
  }
  if (a.kind === 'ec') {
    const sk = bigIntToBytes(a.d!, Math.ceil(bitLength(curveOrder(a.curve)) / 8));
    return a.curve.impl.sign(hash, sk, { prehash: false, lowS: false, format: 'der' });
  }
  if (a.kind === 'dsa') {
    if (a.dsa.x === undefined) throw notSupportedForKeyType();
    return dsaSign(a.dsa, hash);
  }
  throw notSupportedForKeyType();
}

export function verifyDigest(a: Asym, algo: DigestAlgo, hash: Uint8Array, sig: Uint8Array, padding: number | undefined, saltLength: number | undefined): boolean {
  if ('rsa' in a) {
    const pad = padding ?? (a.kind === 'rsa-pss' ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING);
    if (pad === RSA_PKCS1_PSS_PADDING) {
      let setup;
      try {
        setup = pssSetup(a, algo, saltLength, false);
      } catch {
        return false;
      }
      return rsa.pssVerify(a.rsa, algo, setup.mgf, hash, sig, setup.salt);
    }
    if (pad !== RSA_PKCS1_PADDING) return false;
    return rsa.pkcs1Verify(a.rsa, algo, hash, sig);
  }
  if (a.kind === 'ec') {
    try {
      return a.curve.impl.verify(sig, hash, a.pub, { prehash: false, lowS: false, format: 'der' });
    } catch {
      return false;
    }
  }
  if (a.kind === 'dsa') return dsaVerify(a.dsa, hash, sig);
  return false;
}

function orderBytes(a: Asym): number {
  if (a.kind === 'dsa') return dsaOrderBytes(a.dsa);
  return a.kind === 'ec' ? Math.ceil(bitLength(curveOrder(a.curve)) / 8) : 0;
}

/** Keys whose signatures are (r, s) pairs and so take the dsaEncoding option. */
const isDsaLike = (a: Asym) => a.kind === 'ec' || a.kind === 'dsa';

/** DER ECDSA-Sig-Value → r||s */
function derToP1363(a: Asym, sig: Uint8Array): Uint8Array {
  const n = orderBytes(a);
  try {
    const [r, s] = der.children(der.parse(sig)).map((x) => der.readInt(x));
    const out = new Uint8Array(2 * n);
    out.set(bigIntToBytes(r, n), 0);
    out.set(bigIntToBytes(s, n), n);
    return out;
  } catch {
    return sig;
  }
}

/** r||s → DER, or null when the length is wrong */
function p1363ToDer(a: Asym, sig: Uint8Array): Uint8Array | null {
  const n = orderBytes(a);
  if (sig.length !== 2 * n) return null;
  return der.seq(der.int(bytesToBigInt(sig.subarray(0, n))), der.int(bytesToBigInt(sig.subarray(n))));
}

/** Ed25519 (Ed25519ctx with a non-empty context, RFC 8032 5.1) and Ed448 (context: 5.2). */
function edSign(a: Asym, data: Uint8Array, context?: Uint8Array): Uint8Array {
  const priv = (a as any).priv as Uint8Array | undefined;
  if (!priv) throw notSupportedForKeyType();
  if (a.kind === 'ed25519') return context?.length ? ed25519ctx.sign(data, priv, { context }) : ed25519.sign(data, priv);
  return ed448.sign(data, priv, context?.length ? { context } : undefined);
}

function edVerify(a: Asym, data: Uint8Array, sig: Uint8Array, context?: Uint8Array): boolean {
  try {
    const pub = (a as any).pub as Uint8Array;
    if (a.kind === 'ed25519') {
      if (context?.length) return ed25519ctx.verify(sig, data, pub, { context, zip215: false });
      return ed25519.verify(sig, data, pub, { zip215: false });
    }
    return ed448.verify(sig, data, pub, { zip215: false, ...(context?.length ? { context } : {}) });
  } catch {
    return false;
  }
}

class SignBase {
  protected algo: DigestAlgo | null = null;
  protected ctx: Ctx | null = null;
  init(name: unknown) {
    let n = String(name);
    if (n === 'dss1' || n === 'DSS1') n = 'SHA1';
    const algo = getDigest(n);
    if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST');
    this.algo = algo;
    this.ctx = algo.create();
  }
  update(data: unknown, encoding?: unknown) {
    if (!this.ctx) throw err('ERR_CRYPTO_INVALID_STATE', 'Not initialised');
    this.ctx.update(decodeInput(data, encoding));
  }
  protected finish(): [DigestAlgo, Uint8Array] {
    if (!this.ctx || !this.algo) throw err('ERR_CRYPTO_INVALID_STATE', 'Not initialised');
    const hash = this.ctx.final();
    this.ctx = null;
    return [this.algo, hash];
  }
}

export class Sign extends SignBase {
  // sign(key, format, type, passphrase, namedCurve, rsaPadding, pssSaltLength, dsaSigEnc)
  sign(...args: any[]) {
    const a = asymOf(privateKeyArg(args, 0));
    // one-shot only: EdDSA, ML-DSA and SLH-DSA sign the message itself
    if (isEdKind(a.kind) || 'pq' in a) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION');
    const [algo, hash] = this.finish();
    let sig = signDigest(a, algo, hash, args[5], args[6]);
    if (args[7] === kSigEncP1363 && isDsaLike(a)) sig = derToP1363(a, sig);
    return toBuffer(sig.slice());
  }
}

export class Verify extends SignBase {
  // verify(key, format, type, passphrase, namedCurve, signature, rsaPadding, pssSaltLength, dsaSigEnc)
  verify(...args: any[]) {
    const a = asymOf(anyKeyArg(args, 0));
    // one-shot only: EdDSA, ML-DSA and SLH-DSA sign the message itself
    if (isEdKind(a.kind) || 'pq' in a) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION');
    let sig: Uint8Array | null = view(args[5]);
    if (args[8] === kSigEncP1363 && isDsaLike(a)) {
      sig = p1363ToDer(a, sig);
      if (!sig) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Malformed signature');
    }
    const [algo, hash] = this.finish();
    return verifyDigest(a, algo, hash, sig, args[6], args[7]);
  }
}

// new SignJob(mode, signMode, key, format, type, passphrase, namedCurve, data, algorithm, saltLength,
//             padding, dsaEncoding, context[, signature])
export const SignJob = jobClass('SignJob', (async, signMode: number, ...rest: any[]) => {
  const keyData = signMode === 1 ? anyKeyArg(rest, 0) : privateKeyArg(rest, 0);
  const a = asymOf(keyData);
  const data = async ? view(rest[5]).slice() : view(rest[5]);
  let algo: DigestAlgo | undefined;
  if (typeof rest[6] === 'string') {
    algo = getDigest(rest[6]);
    if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${rest[6]}`);
  }
  const saltLength = typeof rest[7] === 'number' ? rest[7] : undefined;
  const padding = typeof rest[8] === 'number' ? rest[8] : undefined;
  const dsaEnc = rest[9];
  if (dsaEnc !== undefined && dsaEnc !== 0 && dsaEnc !== 1) throw err('ERR_OUT_OF_RANGE', 'invalid signature encoding');
  // Ed25519 (Ed25519ctx when not empty) and Ed448 take a context string; other keys only an empty one
  // (checked when the job runs: an async job reports these through its callback)
  const context = isAnyBufferSource(rest[10]) ? view(rest[10]).slice() : undefined;
  let signature: Uint8Array | null = null;
  if (signMode === 1) {
    signature = view(rest[11]).slice();
    if (dsaEnc === kSigEncP1363 && isDsaLike(a)) signature = p1363ToDer(a, signature);
  }
  return () => {
    if (context) {
      if (context.length > 255) throw err('ERR_OUT_OF_RANGE', 'context string must be at most 255 bytes');
      if (context.length > 0 && !isEdKind(a.kind) && !('pq' in a && PQ[a.kind].family !== 'ml-kem')) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Context parameter is unsupported');
    }
    if ('pq' in a) {
      // ML-DSA / SLH-DSA sign the message (FIPS 204/205 pure mode); ML-KEM keys do not sign
      if (PQ[a.kind].family === 'ml-kem') throw notSupportedForKeyType();
      if (algo) throw osslError('1C80007A', 'Provider routines', 'invalid digest', 'ERR_OSSL_INVALID_DIGEST');
      if (signMode === 0) return toArrayBuffer(pqSign(a.pq, data, context));
      return !!signature && pqVerify(a.pq, data, signature, context);
    }
    if (isXKind(a.kind)) throw notSupportedForKeyType();
    if (isEdKind(a.kind)) {
      if (algo) throw osslError('1C8000AE', 'Provider routines', 'digest not allowed', 'ERR_OSSL_DIGEST_NOT_ALLOWED');
      if (signMode === 0) return toArrayBuffer(edSign(a, data, context));
      return !!signature && edVerify(a, data, signature, context);
    }
    const md = algo ?? defaultDigest(a);
    const hash = md.create();
    hash.update(data);
    const digest = hash.final();
    if (signMode === 0) {
      let sig = signDigest(a, md, digest, padding, saltLength);
      if (dsaEnc === kSigEncP1363 && isDsaLike(a)) sig = derToP1363(a, sig);
      return toArrayBuffer(sig);
    }
    return !!signature && verifyDigest(a, md, digest, signature, padding, saltLength);
  };
});

// -----------------------------------------------------------------------------
// key pair generation

/**
 * The trailing arguments of the key pair jobs. Usually the six encodings: pubFormat, pubType,
 * privFormat, privType, cipher, passphrase (undefined format: a KeyObjectHandle). In WebCrypto mode
 * (Node 24+): algorithm, publicUsagesMask, privateUsagesMask, extractable, and the job resolves to
 * a {publicKey, privateKey} pair of CryptoKeys.
 */
function keyPairEncoder(enc: any[]) {
  if (isWebCryptoJob()) {
    const [algorithm, pubUsages, privUsages, extractable] = enc;
    return (asym: Asym) => newCryptoKeyPair(handleFor({ type: 1, asym }), handleFor({ type: 2, asym }), algorithm, pubUsages >>> 0, privUsages >>> 0, extractable === true);
  }
  const [pubFormat, pubType, privFormat, privType, cipher, passphrase] = enc;
  if (typeof cipher === 'string' && !findCipher(cipher)) throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
  const pass = passphraseOf(passphrase);
  return (asym: Asym) => {
    const one = (type: 1 | 2, format: unknown, kt: unknown) => {
      const data: KeyData = { type, asym };
      if (format === undefined) return handleFor(data);
      if (format === kKeyFormatJWK) {
        const o = {};
        exportJwk(asym, type === 2, o, false);
        return o;
      }
      if (format === kKeyFormatRawPublic || format === kKeyFormatRawPrivate || format === kKeyFormatRawSeed) {
        return toBuffer(exportRaw(data, format, kt).slice());
      }
      const out = type === 1 ? writePublic(asym, format as number, kt as number) : writePrivate(asym, format as number, kt as number, cipher, pass);
      return asBuffer(out);
    };
    return [one(1, pubFormat, pubType), one(2, privFormat, privType)];
  };
}

// new NamedKeyPairGenJob(mode, name, ...encoding): the key types named by an algorithm name alone.
// ML-DSA / ML-KEM have no implementation here, so they are not a supported key type (as with an
// OpenSSL that lacks them).
export const NamedKeyPairGenJob = jobClass('NamedKeyPairGenJob', (_async, name: unknown, ...enc: any[]) => {
  // generateKeyPair() takes the lower-case key type; crypto.subtle the algorithm name (Ed25519)
  const kind = (isWebCryptoJob() ? String(name).toLowerCase() : String(name)) as OkpKind;
  if (typeof name === 'string' && isPqKind(kind)) {
    const encodePq = keyPairEncoder(enc);
    return () =>
      encodePq({
        kind: kind as unknown as PqKind,
        pq: pqGenerate(kind, (n) => {
          const r = new Uint8Array(n);
          fillRandom(r);
          return r;
        }),
      });
  }
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(OKP, kind)) {
    throw err('ERR_INVALID_ARG_VALUE', `The argument 'type' must be a supported key type. Received '${String(name)}'`);
  }
  const encode = keyPairEncoder(enc);
  return () => {
    const priv = new Uint8Array(OKP[kind].len);
    fillRandom(priv);
    return encode(okpFromPrivate(kind, priv));
  };
});

// new EcKeyPairGenJob(mode, namedCurve, paramEncoding, ...encoding)
const OPENSSL_EC_EXPLICIT_CURVE = 0;
export const EcKeyPairGenJob = jobClass('EcKeyPairGenJob', (_async, namedCurve: string, paramEncoding: number, ...enc: any[]) => {
  const curve = curveByName(namedCurve);
  if (!curve) throw err('ERR_CRYPTO_INVALID_CURVE');
  const encode = keyPairEncoder(enc);
  return () => {
    const a = ecFromPrivate(curve, randomScalar(curve)) as Extract<Asym, { kind: 'ec' }>;
    if (paramEncoding === OPENSSL_EC_EXPLICIT_CURVE) a.explicit = true;
    return encode(a);
  };
});

// new DsaKeyPairGenJob(mode, modulusLength, divisorLength, ...encoding)
export const DsaKeyPairGenJob = jobClass('DsaKeyPairGenJob', (_async, modulusLength: number, divisorLength: number, ...enc: any[]) => {
  const encode = keyPairEncoder(enc);
  return () => encode({ kind: 'dsa', dsa: generateDsa(modulusLength, divisorLength) });
});

const DH_GROUP_PRIMES = new Map(Object.entries(DH_GROUPS).map(([name, hex]) => [name, BigInt('0x' + hex)]));

// new DhKeyPairGenJob(mode, group, ...encoding) or (mode, prime | primeLength, generator, ...encoding)
export const DhKeyPairGenJob = jobClass('DhKeyPairGenJob', (_async, ...args: any[]) => {
  let params: () => { p: bigint; g: bigint };
  if (typeof args[0] === 'string') {
    const p = DH_GROUP_PRIMES.get(args.shift());
    if (!p) throw err('ERR_CRYPTO_UNKNOWN_DH_GROUP');
    params = () => ({ p, g: 2n });
  } else {
    const [primeOrLength, generator] = args.splice(0, 2);
    const g = BigInt(generator);
    if (typeof primeOrLength === 'number') {
      const bits = primeOrLength;
      params = () => {
        // DH_generate_parameters_ex: a safe prime suited to the generator
        if (bits < 512) throw osslError('1C8000A9', 'Provider routines', 'modulus too small', 'ERR_OSSL_MODULUS_TOO_SMALL');
        const [add, rem] = g === 2n ? [24n, 23n] : g === 5n ? [60n, 59n] : [12n, 11n];
        return { p: generatePrime(bits, true, add, rem), g };
      };
    } else {
      const p = bytesToBigInt(view(primeOrLength));
      params = () => ({ p, g });
    }
  }
  const encode = keyPairEncoder(args);
  return () => {
    const { p, g } = params();
    return encode({ kind: 'dh', dh: dhFromPrivate(p, g, dhPrivate(p)) });
  };
});

// new RsaKeyPairGenJob(mode, variant, bits, exponent, [hash, mgf1Hash, saltLength,] ...encoding)
export const RsaKeyPairGenJob = jobClass('RsaKeyPairGenJob', (_async, variant: number, bits: number, exponent: number, ...rest: any[]) => {
  let pss: { hash?: DigestAlgo; mgf1?: DigestAlgo; salt?: number } | null = null;
  if (variant === 1) {
    const [h, m, s] = rest.splice(0, 3);
    pss = {};
    if (h !== undefined) {
      pss.hash = getDigest(h);
      if (!pss.hash) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${h}`);
    }
    if (m !== undefined) {
      pss.mgf1 = getDigest(m);
      if (!pss.mgf1) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid MGF1 digest: ${m}`);
    }
    if (s !== undefined) {
      if (s < 0) throw err('ERR_OUT_OF_RANGE', 'salt length is out of range');
      pss.salt = s;
    }
  }
  const encode = keyPairEncoder(rest);
  return () => {
    const key = rsa.generateRsa(bits, exponent);
    if (!pss) return encode({ kind: 'rsa', rsa: key });
    const any = pss.hash || pss.mgf1 || pss.salt !== undefined;
    const sha1 = getDigest('sha1')!;
    const params = any
      ? { hash: pss.hash ?? sha1, mgf1: pss.mgf1 ?? pss.hash ?? sha1, saltLength: pss.salt ?? (pss.hash ? pss.hash.size : 20) }
      : null;
    return encode({ kind: 'rsa-pss', rsa: key, pss: params });
  };
});

// -----------------------------------------------------------------------------
// ECDH

const POINT_CONVERSION_COMPRESSED = 2;
const POINT_CONVERSION_UNCOMPRESSED = 4;
const POINT_CONVERSION_HYBRID = 6;

function encodePoint(curve: Curve, pub: Uint8Array, form: number): Uint8Array {
  const p = curve.impl.Point.fromBytes(pub);
  if (form === POINT_CONVERSION_COMPRESSED) return p.toBytes(true);
  const u = p.toBytes(false);
  if (form === POINT_CONVERSION_HYBRID) u[0] = 6 | (u[u.length - 1] & 1);
  return u;
}

export class ECDH {
  #curve: Curve;
  #d: bigint | undefined;
  #pub: Uint8Array | undefined;

  constructor(curve: unknown) {
    const c = CURVES.find((x) => x.name === curve);
    if (!c) throw err('ERR_CRYPTO_INVALID_CURVE');
    this.#curve = c;
  }

  generateKeys() {
    const a = ecFromPrivate(this.#curve, randomScalar(this.#curve)) as Extract<Asym, { kind: 'ec' }>;
    this.#d = a.d;
    this.#pub = a.pub;
  }

  #keyPairValid() {
    if (!this.#pub) return false;
    if (this.#d === undefined) return true;
    return equalArrays((ecFromPrivate(this.#curve, this.#d) as any).pub, this.#pub);
  }

  computeSecret(key: unknown) {
    if (!this.#keyPairValid() || this.#d === undefined) throw err('ERR_CRYPTO_INVALID_KEYPAIR');
    let point;
    try {
      point = ecPoint(this.#curve, view(key));
    } catch {
      return 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY';
    }
    const shared = point.multiply(this.#d).toBytes(false);
    return toBuffer(shared.slice(1, 1 + this.#curve.size));
  }

  getPublicKey(form: number) {
    if (!this.#pub) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to get ECDH public key');
    return toBuffer(encodePoint(this.#curve, this.#pub, form));
  }

  getPrivateKey() {
    if (this.#d === undefined) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to get ECDH private key');
    return toBuffer(bigIntToBytes(this.#d));
  }

  setPrivateKey(key: unknown) {
    const d = bytesToBigInt(view(key));
    if (d < 1n || d >= curveOrder(this.#curve)) throw err('ERR_CRYPTO_INVALID_KEYTYPE', 'Private key is not valid for specified curve.');
    const a = ecFromPrivate(this.#curve, d) as Extract<Asym, { kind: 'ec' }>;
    this.#d = d;
    this.#pub = a.pub;
  }

  setPublicKey(key: unknown) {
    try {
      this.#pub = ecPoint(this.#curve, view(key)).toBytes(false);
    } catch {
      throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to convert Buffer to EC_POINT');
    }
  }
}

// ECDHConvertKey(key, curve, form)
export function ECDHConvertKey(key: unknown, curveName: unknown, form: number) {
  const k = view(key);
  if (k.length === 0) return '';
  const curve = CURVES.find((x) => x.name === curveName);
  if (!curve) throw err('ERR_CRYPTO_INVALID_CURVE');
  let pub: Uint8Array;
  try {
    pub = ecPoint(curve, k).toBytes(false);
  } catch {
    throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to convert Buffer to EC_POINT');
  }
  return toBuffer(encodePoint(curve, pub, form));
}

/** The shared secret of two keys (crypto.diffieHellman, ECDH and X25519/X448 deriveBits). */
function deriveSecret(a: Asym, b: Asym): Uint8Array {
  const fail = () => osslError('1C800066', 'Provider routines', 'failed during derivation', 'ERR_OSSL_FAILED_DURING_DERIVATION');
  const mismatch = () => osslError('1C8000CB', 'Provider routines', 'mismatching domain parameters', 'ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS');
  if (a.kind === 'dh' && b.kind === 'dh') {
    if (a.dh.p !== b.dh.p || a.dh.g !== b.dh.g) throw mismatch();
    return dhSecret(a.dh, b.dh.y);
  }
  if (a.kind === 'ec' && b.kind === 'ec') {
    if (a.curve !== b.curve) throw mismatch();
    const shared = ecPoint(a.curve, b.pub).multiply(a.d!).toBytes(false);
    return shared.slice(1, 1 + a.curve.size);
  }
  if ((a.kind === 'x25519' || a.kind === 'x448') && a.kind === b.kind) {
    try {
      const fn = a.kind === 'x25519' ? x25519 : x448;
      return fn.getSharedSecret((a as any).priv, (b as any).pub).slice();
    } catch {
      throw fail();
    }
  }
  throw notSupportedForKeyType();
}

// new DHBitsJob(mode, publicKey, format, type, passphrase, namedCurve,
//               privateKey, format, type, passphrase, namedCurve) → ArrayBuffer (Node 24+; replaces
// statelessDH and ECDHBitsJob)
export const DHBitsJob = jobClass('DHBitsJob', (_async, ...args: any[]) => {
  const pub = asymOf(anyKeyArg(args, 0));
  const privData = privateKeyArg(args, 5);
  const priv = asymOf(privData);
  return () => toArrayBuffer(deriveSecret(priv, pub));
});

// -----------------------------------------------------------------------------
// RSA public-key ciphers: (key, format, type, passphrase, namedCurve, buffer, padding, oaepHash,
// oaepLabel, mgf1Hash)

function rsaKeyOf(data: KeyData) {
  const a = asymOf(data);
  if (a.kind !== 'rsa') throw notSupportedForKeyType();
  return a.rsa;
}

function oaepParams(args: any[]) {
  let algo = getDigest('sha1')!;
  if (typeof args[7] === 'string') {
    const d = getDigest(args[7]);
    if (!d) throw err('ERR_OSSL_EVP_INVALID_DIGEST');
    algo = d;
  }
  // the MGF1 digest defaults to the OAEP one
  let mgf = algo;
  if (typeof args[9] === 'string') {
    const d = getDigest(args[9]);
    if (!d) throw err('ERR_OSSL_EVP_INVALID_DIGEST');
    mgf = d;
  }
  const label = args[8] === undefined ? new Uint8Array(0) : view(args[8]);
  return { algo, mgf, label };
}

function publicEncrypt(...args: any[]) {
  const key = anyKeyArg(args, 0);
  const { algo, mgf, label } = oaepParams(args);
  const k = rsaKeyOf(key);
  const data = view(args[5]);
  const padding = args[6] >>> 0;
  if (padding === RSA_PKCS1_OAEP_PADDING) {
    return toBuffer(rsa.oaepEncrypt(k, algo, label, data, mgf));
  }
  if (padding === RSA_PKCS1_PADDING) return toBuffer(rsa.rawPublic(k, rsa.pkcs1Pad(k, data, 2)));
  if (padding === RSA_NO_PADDING) {
    if (data.length !== rsa.byteLen(k)) throw osslError('0200006E', 'rsa routines', 'data too large for key size', 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE');
    return toBuffer(rsa.rawPublic(k, data));
  }
  throw osslError('1C8000A5', 'Provider routines', 'illegal or unsupported padding mode', 'ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE');
}

function privateDecrypt(...args: any[]) {
  const data = anyKeyArg(args, 0);
  const { algo, mgf, label } = oaepParams(args);
  if (data.type !== 2) throw notSupportedForKeyType();
  const k = rsaKeyOf(data);
  const ct = view(args[5]);
  const padding = args[6] >>> 0;
  if (padding === RSA_PKCS1_OAEP_PADDING) {
    return toBuffer(rsa.oaepDecrypt(k, algo, label, ct, mgf));
  }
  if (padding === RSA_PKCS1_PADDING) {
    // OpenSSL 3.2+ answers a bad padding with a synthetic plaintext (implicit rejection); we throw.
    const m = rsa.pkcs1Unpad(rsa.rawPrivate(k, ct), 2);
    if (!m) throw rsa.rsaErr.invalidPadding();
    return toBuffer(m);
  }
  if (padding === RSA_NO_PADDING) return toBuffer(rsa.rawPrivate(k, ct));
  throw osslError('1C8000A5', 'Provider routines', 'illegal or unsupported padding mode', 'ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE');
}

function privateEncrypt(...args: any[]) {
  const data = anyKeyArg(args, 0);
  if (data.type !== 2) throw notSupportedForKeyType();
  const k = rsaKeyOf(data);
  const m = view(args[5]);
  const padding = args[6] >>> 0;
  if (padding === RSA_PKCS1_PADDING) return toBuffer(rsa.rawPrivate(k, rsa.pkcs1Pad(k, m, 1)));
  if (padding === RSA_NO_PADDING) {
    if (m.length !== rsa.byteLen(k)) throw osslError('0200006E', 'rsa routines', 'data too large for key size', 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE');
    return toBuffer(rsa.rawPrivate(k, m));
  }
  throw osslError('1C8000A5', 'Provider routines', 'illegal or unsupported padding mode', 'ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE');
}

function publicDecrypt(...args: any[]) {
  const k = rsaKeyOf(anyKeyArg(args, 0));
  const c = view(args[5]);
  const padding = args[6] >>> 0;
  if (padding === RSA_PKCS1_PADDING) {
    const m = rsa.pkcs1Unpad(rsa.rawPublic(k, c), 1);
    if (!m) throw rsa.rsaErr.invalidPadding();
    return toBuffer(m);
  }
  if (padding === RSA_NO_PADDING) return toBuffer(rsa.rawPublic(k, c));
  throw osslError('1C8000A5', 'Provider routines', 'illegal or unsupported padding mode', 'ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE');
}

// new KEMEncapsulateJob(mode, key ×5) → [sharedKey, ciphertext] (WebCrypto: {sharedKey, ciphertext})
// new KEMDecapsulateJob(mode, key ×5, ciphertext) → sharedKey: ML-KEM, and the DHKEM (RFC 9180) /
// RSASVE (SP 800-56B) KEMs OpenSSL 3 provides for EC, X25519/X448 and RSA keys
export const KEMEncapsulateJob = jobClass('KEMEncapsulateJob', (_async, ...args: any[]) => {
  const a = asymOf(anyKeyArg(args, 0));
  const webcrypto = isWebCryptoJob();
  return () => {
    let r: [Uint8Array, Uint8Array] | null;
    if ('pq' in a) r = PQ[a.kind].family === 'ml-kem' ? pqEncapsulate(a.pq) : null;
    else r = dhkemEncapsulate(a);
    if (!r) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Encapsulation failed');
    if (webcrypto) return { sharedKey: toArrayBuffer(r[0]), ciphertext: toArrayBuffer(r[1]) };
    return [toBuffer(r[0].slice()), toBuffer(r[1].slice())];
  };
});
export const KEMDecapsulateJob = jobClass('KEMDecapsulateJob', (async, ...args: any[]) => {
  const a = asymOf(privateKeyArg(args, 0));
  const ct = async ? view(args[5]).slice() : view(args[5]);
  const webcrypto = isWebCryptoJob();
  return () => {
    let secret: Uint8Array | null;
    if ('pq' in a) secret = PQ[a.kind].family === 'ml-kem' ? pqDecapsulate(a.pq, ct) : null;
    else secret = dhkemDecapsulate(a, ct);
    if (!secret) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Decapsulation failed');
    return webcrypto ? toArrayBuffer(secret) : toBuffer(secret.slice());
  };
});

/** isKeyAlgorithmAvailable(name): the key types this binding can create. */
function isKeyAlgorithmAvailable(name: unknown): boolean {
  return typeof name === 'string' && (Object.prototype.hasOwnProperty.call(OKP, name.toLowerCase()) || isPqKind(name.toLowerCase()));
}

export const asymmetric: Record<string, unknown> = {
  // the subset of OpenSSL's curve list implemented here, in OpenSSL's order
  getCurves: () => ['secp224r1', 'secp256k1', 'secp384r1', 'secp521r1', 'prime256v1'],
  Sign,
  Verify,
  SignJob,
  NamedKeyPairGenJob,
  EcKeyPairGenJob,
  RsaKeyPairGenJob,
  DsaKeyPairGenJob,
  DhKeyPairGenJob,
  DHBitsJob,
  KEMEncapsulateJob,
  KEMDecapsulateJob,
  ECDH,
  ECDHConvertKey,
  publicEncrypt,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  isKeyAlgorithmAvailable,
};