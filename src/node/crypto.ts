// node:crypto — synchronous hashing via @noble/hashes, randomness and WebCrypto from the browser.

import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { pbkdf2 as nPbkdf2 } from '@noble/hashes/pbkdf2.js';
import { scrypt as nScrypt } from '@noble/hashes/scrypt.js';
import { sha224, sha256, sha384, sha512, sha512_256 } from '@noble/hashes/sha2.js';
import { sha3_256, sha3_512, sha3_224, sha3_384, shake128, shake256 } from '@noble/hashes/sha3.js';
import { blake2b, blake2s } from '@noble/hashes/blake2.js';
import { Transform } from './stream.ts';

type NobleHash = { create(opts?: any): any; outputLen: number; blockLen: number };

const HASHES: Record<string, NobleHash> = {
  md5: md5 as any,
  sha1: sha1 as any,
  'sha-1': sha1 as any,
  ripemd160: ripemd160 as any,
  rmd160: ripemd160 as any,
  sha224: sha224 as any,
  sha256: sha256 as any,
  'sha-256': sha256 as any,
  sha384: sha384 as any,
  'sha-384': sha384 as any,
  sha512: sha512 as any,
  'sha-512': sha512 as any,
  'sha512-256': sha512_256 as any,
  'sha3-224': sha3_224 as any,
  'sha3-256': sha3_256 as any,
  'sha3-384': sha3_384 as any,
  'sha3-512': sha3_512 as any,
  shake128: shake128 as any,
  shake256: shake256 as any,
  blake2b512: blake2b as any,
  blake2s256: blake2s as any,
};

function algo(name: string): NobleHash {
  const h = HASHES[String(name).toLowerCase()];
  if (!h) {
    const e = new Error(`Digest method not supported: ${name}`) as Error & { code: string };
    e.code = 'ERR_CRYPTO_INVALID_DIGEST';
    throw e;
  }
  return h;
}

function toBytes(data: any, enc?: BufferEncoding): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, enc ?? 'utf8');
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const e = new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${data === null ? 'null' : typeof data}`) as TypeError & { code: string };
  e.code = 'ERR_INVALID_ARG_TYPE';
  throw e;
}

function out(bytes: Uint8Array, enc?: string): any {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return enc && enc !== 'buffer' ? b.toString(enc as BufferEncoding) : b;
}

export class Hash extends (Transform as any) {
  private h: any;
  private done = false;
  algorithm: string;
  constructor(algorithm: string, opts?: any, state?: any) {
    super(opts);
    this.algorithm = algorithm;
    this.h = state ?? algo(algorithm).create(opts?.outputLength ? { dkLen: opts.outputLength } : undefined);
  }
  update(data: any, enc?: BufferEncoding) {
    if (this.done) {
      const e = new Error('Digest already called') as Error & { code: string };
      e.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw e;
    }
    this.h.update(toBytes(data, enc));
    return this;
  }
  digest(enc?: string) {
    if (this.done) {
      const e = new Error('Digest already called') as Error & { code: string };
      e.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw e;
    }
    this.done = true;
    return out(this.h.digest(), enc);
  }
  copy() {
    return new Hash(this.algorithm, undefined, this.h.clone());
  }
  _transform(chunk: any, enc: BufferEncoding, cb: () => void) {
    this.update(chunk, enc);
    cb();
  }
  _flush(cb: () => void) {
    (this as any).push(this.digest());
    cb();
  }
}

export class Hmac extends (Transform as any) {
  private h: any;
  private done = false;
  constructor(algorithm: string, key: any, opts?: any) {
    super(opts);
    const k = key && typeof key === 'object' && key.export ? key.export() : toBytes(key);
    this.h = hmac.create(algo(algorithm) as any, k);
  }
  update(data: any, enc?: BufferEncoding) {
    this.h.update(toBytes(data, enc));
    return this;
  }
  digest(enc?: string) {
    if (this.done) return out(new Uint8Array(0), enc);
    this.done = true;
    return out(this.h.digest(), enc);
  }
  _transform(chunk: any, enc: BufferEncoding, cb: () => void) {
    this.update(chunk, enc);
    cb();
  }
  _flush(cb: () => void) {
    (this as any).push(this.digest());
    cb();
  }
}

export function createHash(algorithm: string, opts?: any) {
  return new Hash(algorithm, opts);
}

export function createHmac(algorithm: string, key: any, opts?: any) {
  return new Hmac(algorithm, key, opts);
}

/** crypto.hash(algorithm, data[, outputEncoding]) — one-shot (Node 21.7+). */
export function hash(algorithm: string, data: any, outputEncoding: string = 'hex') {
  const h = algo(algorithm).create();
  h.update(toBytes(data));
  return out(h.digest(), outputEncoding);
}

export function getHashes() {
  return Object.keys(HASHES).filter((k) => !k.includes('-') || k.startsWith('sha3') || k === 'sha512-256');
}

export function getCiphers() {
  return ['aes-128-cbc', 'aes-256-cbc', 'aes-128-gcm', 'aes-256-gcm'];
}

export function getCurves() {
  return ['prime256v1', 'secp384r1', 'secp521r1'];
}

export function randomBytes(n: number, cb?: (e: Error | null, b: Buffer) => void): any {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  if (cb) {
    queueMicrotask(() => cb(null, b));
    return;
  }
  return b;
}
export const pseudoRandomBytes = randomBytes;
export const prng = randomBytes;
export const rng = randomBytes;

export function randomFillSync<T extends ArrayBufferView>(buf: T, offset = 0, size?: number): T {
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = size === undefined ? view.length : offset + size;
  for (let i = offset; i < end; i += 65536) crypto.getRandomValues(view.subarray(i, Math.min(end, i + 65536)));
  return buf;
}

export function randomFill(buf: ArrayBufferView, ...args: any[]) {
  const cb = args.pop();
  randomFillSync(buf, args[0], args[1]);
  queueMicrotask(() => cb(null, buf));
}

export function randomUUID() {
  return crypto.randomUUID();
}

export function randomInt(min: number, max?: number, cb?: (e: Error | null, n: number) => void): any {
  if (typeof max === 'function') {
    cb = max as any;
    max = undefined;
  }
  if (max === undefined) {
    max = min;
    min = 0;
  }
  const range = max - min;
  const v = new Uint32Array(2);
  crypto.getRandomValues(v);
  const n = min + Math.floor(((v[0] * 2 ** 21 + (v[1] >>> 11)) / 2 ** 53) * range);
  if (cb) {
    queueMicrotask(() => cb!(null, n));
    return;
  }
  return n;
}

export const getRandomValues = (a: any) => crypto.getRandomValues(a);
export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView) {
  if (a.byteLength !== b.byteLength) {
    const e = new RangeError('Input buffers must have the same byte length') as RangeError & { code: string };
    e.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
    throw e;
  }
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function pbkdf2Sync(password: any, salt: any, iterations: number, keylen: number, digest: string) {
  return Buffer.from(nPbkdf2(algo(digest) as any, toBytes(password), toBytes(salt), { c: iterations, dkLen: keylen }));
}

export function pbkdf2(password: any, salt: any, iterations: number, keylen: number, digest: string, cb: (e: Error | null, k?: Buffer) => void) {
  try {
    const k = pbkdf2Sync(password, salt, iterations, keylen, digest);
    queueMicrotask(() => cb(null, k));
  } catch (e) {
    queueMicrotask(() => cb(e as Error));
  }
}

export function scryptSync(password: any, salt: any, keylen: number, opts: any = {}) {
  return Buffer.from(nScrypt(toBytes(password), toBytes(salt), { N: opts.N ?? opts.cost ?? 16384, r: opts.r ?? opts.blockSize ?? 8, p: opts.p ?? opts.parallelization ?? 1, dkLen: keylen }));
}

export function scrypt(password: any, salt: any, keylen: number, opts: any, cb?: any) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  try {
    const k = scryptSync(password, salt, keylen, opts);
    queueMicrotask(() => cb(null, k));
  } catch (e) {
    queueMicrotask(() => cb(e));
  }
}

export function hkdfSync(digest: string, ikm: any, salt: any, info: any, keylen: number) {
  // HKDF (RFC 5869)
  const h = algo(digest);
  const prk = hmac(h as any, toBytes(salt), toBytes(ikm));
  const n = Math.ceil(keylen / h.outputLen);
  const okm = new Uint8Array(n * h.outputLen);
  let prev = new Uint8Array(0);
  for (let i = 0; i < n; i++) {
    const input = new Uint8Array(prev.length + toBytes(info).length + 1);
    input.set(prev);
    input.set(toBytes(info), prev.length);
    input[input.length - 1] = i + 1;
    prev = hmac(h as any, prk, input);
    okm.set(prev, i * h.outputLen);
  }
  return okm.buffer.slice(0, keylen);
}

class KeyObject {
  constructor(public type: string, private data: Uint8Array) {}
  export() {
    return Buffer.from(this.data);
  }
  get symmetricKeySize() {
    return this.data.length;
  }
  equals(o: KeyObject) {
    return timingSafeEqual(this.data, o.data);
  }
  get [Symbol.toStringTag]() {
    return 'KeyObject';
  }
}
export { KeyObject };

export function createSecretKey(key: any, enc?: BufferEncoding) {
  return new KeyObject('secret', toBytes(key, enc));
}

function unsupported(name: string) {
  return () => {
    const e = new Error(`crypto.${name} is not supported in OpenVessel`) as Error & { code: string };
    e.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
    throw e;
  };
}

export const createCipheriv = unsupported('createCipheriv');
export const createDecipheriv = unsupported('createDecipheriv');
export const createSign = unsupported('createSign');
export const createVerify = unsupported('createVerify');
export const createPublicKey = unsupported('createPublicKey');
export const createPrivateKey = unsupported('createPrivateKey');
export const generateKeyPairSync = unsupported('generateKeyPairSync');
export const generateKeyPair = unsupported('generateKeyPair');
export const createDiffieHellman = unsupported('createDiffieHellman');
export const createECDH = unsupported('createECDH');
export const publicEncrypt = unsupported('publicEncrypt');
export const privateDecrypt = unsupported('privateDecrypt');
export const sign = unsupported('sign');
export const verify = unsupported('verify');

export const constants = { RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6, POINT_CONVERSION_COMPRESSED: 2, POINT_CONVERSION_UNCOMPRESSED: 4 };

export function getFips() {
  return 0;
}
export function setFips() {}
export function secureHeapUsed() {
  return { total: 0, min: 0, used: 0, utilization: 0 };
}

export default {
  createHash, createHmac, hash, getHashes, getCiphers, getCurves, randomBytes, pseudoRandomBytes, prng, rng, randomFillSync, randomFill, randomUUID, randomInt, getRandomValues, webcrypto, subtle,
  timingSafeEqual, pbkdf2Sync, pbkdf2, scryptSync, scrypt, hkdfSync, KeyObject, createSecretKey, createCipheriv, createDecipheriv, createSign, createVerify, createPublicKey, createPrivateKey,
  generateKeyPairSync, generateKeyPair, createDiffieHellman, createECDH, publicEncrypt, privateDecrypt, sign, verify, constants, getFips, setFips, secureHeapUsed, Hash, Hmac,
};
