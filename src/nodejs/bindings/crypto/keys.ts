// crypto_keys.cc: KeyObjectHandle (secret keys; asymmetric keys come from asym.ts), the native
// bases of KeyObject (NativeKeyObject) and CryptoKey (NativeCryptoKey), and SecretKeyGenJob.
//
// Node 24+ keeps a KeyObject's type and handle, and all of a CryptoKey's internal slots, on the C++
// object; lib reads them back with getKeyObjectSlots() / getCryptoKeySlots() and brand-checks with
// isKeyObject() / isCryptoKey(). Here the C++ object is a WeakMap entry keyed by the JS instance.

import { Enc, decode } from '../buffer.ts';
import { S } from '../../state.ts';
import type { Asym } from './asymkeys.ts';
import { copy, err, fillRandom, isAnyBufferSource, isWebCryptoJob, jobClass, stringOrBuffer, toBuffer, view } from './util.ts';

export const kKeyTypeSecret = 0;
export const kKeyTypePublic = 1;
export const kKeyTypePrivate = 2;

export const kKeyFormatDER = 0;
export const kKeyFormatPEM = 1;
export const kKeyFormatJWK = 2;
export const kKeyFormatRawPublic = 3;
export const kKeyFormatRawPrivate = 4;
export const kKeyFormatRawSeed = 5;
export const kKeyFormatStore = 6;

/** What a KeyObjectHandle holds (KeyObjectData). Asymmetric material is described in asymkeys.ts. */
export type KeyData = { type: 0; secret: Uint8Array } | { type: 1 | 2; asym: Asym };

/** Implemented by asym.ts and registered at load, keeping this module free of the curve code. */
export interface AsymOps {
  /** init(type, data, format, type, passphrase, namedCurve) for public and private keys */
  init(type: number, args: any[]): KeyData;
  export(data: KeyData, args: any[]): unknown;
  exportJwk(data: KeyData, target: any, handleRsaPss: boolean): void;
  keyDetail(data: KeyData, target: any): void;
  asymmetricKeyType(data: KeyData): string | undefined;
  checkEcKeyData(data: KeyData): boolean;
  equals(a: KeyData, b: KeyData): boolean;
  rawPublicKey(data: KeyData): Uint8Array;
  rawPrivateKey(data: KeyData): Uint8Array;
  rawSeed(data: KeyData): Uint8Array;
  exportECPublicRaw(data: KeyData, form: number): Uint8Array;
  exportECPrivateRaw(data: KeyData): Uint8Array;
  exportECPrivatePkcs8(data: KeyData): Uint8Array;
  /** SPKI (public) or PKCS#8 (private) DER, for carrying a key across threads */
  toDer(data: KeyData): Uint8Array;
  fromDer(type: 1 | 2, der: Uint8Array): KeyData;
}

let asymOps: AsymOps | null = null;
export function registerAsymOps(ops: AsymOps) {
  asymOps = ops;
}
function asym(): AsymOps {
  if (!asymOps) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Asymmetric keys are not supported in OpenVessel');
  return asymOps;
}

export function base64Decode(s: string): Uint8Array {
  // ByteSource::FromEncodedString: base64 decoding that also accepts base64url characters
  const bin = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((bin.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < bin.length; i++) {
    acc = (acc << 6) | A.indexOf(bin[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** ImportJWKSecretKey */
function jwkSecret(jwk: any): Uint8Array {
  if (!jwk || typeof jwk !== 'object' || typeof jwk.k !== 'string') throw err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK secret key format');
  return copy(base64Decode(jwk.k));
}

export class KeyObjectHandle {
  data!: KeyData;

  // init(kKeyTypeSecret, bytes | jwk[, format]) or init(type, data, format, type, passphrase, namedCurve)
  init(type: number, ...args: any[]) {
    if (type === kKeyTypeSecret) {
      if (args[1] === kKeyFormatJWK) {
        this.data = { type: 0, secret: jwkSecret(args[0]) };
        return kKeyTypeSecret;
      }
      const d = keyDataOf(args[0]);
      this.data = { type: 0, secret: d?.type === 0 ? d.secret : copy(view(args[0])) };
      return undefined;
    }
    this.data = asym().init(type, args);
    // a JWK import reports the type it found (KeyObjectHandle::Init returns it for kKeyFormatJWK)
    return args[1] === kKeyFormatJWK ? this.data.type : undefined;
  }

  getKeyType() {
    return this.data.type;
  }

  getSymmetricKeySize() {
    return this.data.type === 0 ? this.data.secret.length : 0;
  }

  getAsymmetricKeyType() {
    return this.data.type === 0 ? undefined : asym().asymmetricKeyType(this.data);
  }

  checkEcKeyData() {
    return asym().checkEcKeyData(this.data);
  }

  export(...args: any[]) {
    if (this.data.type === 0) return toBuffer(copy(this.data.secret));
    return asym().export(this.data, args);
  }

  exportJwk(target: any, handleRsaPss: boolean) {
    if (this.data.type === 0) {
      target.kty = 'oct';
      target.k = decode(this.data.secret, Enc.BASE64URL);
    } else {
      asym().exportJwk(this.data, target, !!handleRsaPss);
    }
    return target;
  }

  rawPublicKey() {
    return toBuffer(copy(asym().rawPublicKey(this.data)));
  }

  rawPrivateKey() {
    return toBuffer(copy(asym().rawPrivateKey(this.data)));
  }

  rawSeed() {
    return toBuffer(copy(asym().rawSeed(this.data)));
  }

  exportECPublicRaw(form: number) {
    return toBuffer(copy(asym().exportECPublicRaw(this.data, form)));
  }

  exportECPrivateRaw() {
    return toBuffer(copy(asym().exportECPrivateRaw(this.data)));
  }

  exportECPrivatePkcs8() {
    return toBuffer(copy(asym().exportECPrivatePkcs8(this.data)));
  }

  keyDetail(target: any) {
    if (this.data.type === 0) target.length = this.data.secret.length * 8;
    else asym().keyDetail(this.data, target);
    return target;
  }

  equals(other: KeyObjectHandle) {
    const a = this.data;
    const b = other.data;
    if (a.type === 0 && b.type === 0) {
      if (a.secret.length !== b.secret.length) return false;
      let d = 0;
      for (let i = 0; i < a.secret.length; i++) d |= a.secret[i] ^ b.secret[i];
      return d === 0;
    }
    if (a.type === 0 || b.type === 0) return false;
    return asym().equals(a, b);
  }
}

/** A KeyObjectHandle wrapping these bytes as a secret key. */
export function secretHandle(bytes: Uint8Array): KeyObjectHandle {
  return handleFor({ type: 0, secret: bytes });
}

export function handleFor(data: KeyData): KeyObjectHandle {
  const h = new KeyObjectHandle();
  h.data = data;
  return h;
}

// -----------------------------------------------------------------------------
// NativeKeyObject (the base of KeyObject) and NativeCryptoKey (the storage of CryptoKey)

/** NativeKeyObject instances → their handle. */
const nativeKeys = new WeakMap<object, KeyObjectHandle>();

interface CryptoKeySlots {
  handle: KeyObjectHandle;
  algorithm: any;
  usagesMask: number;
  extractable: boolean;
  secondaryHandle: KeyObjectHandle | undefined;
  seedData: Uint8Array | undefined;
}
/** NativeCryptoKey instances → their internal slots. */
const nativeCryptoKeys = new WeakMap<object, CryptoKeySlots>();

/** The KeyObjectData of a KeyObjectHandle, a KeyObject or a CryptoKey. */
export function keyDataOf(v: unknown): KeyData | undefined {
  if (v instanceof KeyObjectHandle) return v.data;
  if (v && typeof v === 'object') return nativeKeys.get(v)?.data ?? nativeCryptoKeys.get(v)?.handle.data;
  return undefined;
}

/** ByteSource::FromSymmetricKeyObjectHandle */
export function symmetricKeyOf(handle: unknown): Uint8Array {
  const d = keyDataOf(handle);
  if (d?.type === 0) return d.secret;
  throw err('ERR_INVALID_ARG_TYPE', 'Invalid key object');
}

/** ByteSource::FromSecretKeyBytes: a string, a buffer source or a secret KeyObjectHandle. */
export function secretKeyBytes(v: unknown): Uint8Array {
  if (typeof v === 'string' || isAnyBufferSource(v)) return stringOrBuffer(v);
  return symmetricKeyOf(v);
}

/** [KeyObject, SecretKeyObject, PublicKeyObject, PrivateKeyObject] as lib/internal/crypto/keys returned them. */
let keyObjectClasses: (new (handle: KeyObjectHandle) => object)[] | null = null;

/** createNativeKeyObjectClass(callback): the base class for KeyObject. */
export function createNativeKeyObjectClass(callback: (base: Function) => unknown) {
  class NativeKeyObject {
    constructor(handle: unknown) {
      if (!(handle instanceof KeyObjectHandle)) throw err('ERR_INVALID_ARG_TYPE', 'Invalid key object handle');
      nativeKeys.set(this, handle);
    }
  }
  const classes = callback(NativeKeyObject);
  if (Array.isArray(classes)) keyObjectClasses = classes as typeof keyObjectClasses;
  return classes;
}

function invalidThis(type: string) {
  return err('ERR_INVALID_THIS', `Value of "this" must be of type ${type}`);
}

/** getKeyObjectSlots(key) → [type, handle] */
export function getKeyObjectSlots(key: unknown) {
  const h = key && typeof key === 'object' ? nativeKeys.get(key) : undefined;
  if (!h) throw invalidThis('KeyObject');
  return [h.data.type, h];
}

export function isKeyObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && nativeKeys.has(v);
}

/** [CryptoKey, InternalCryptoKey] as lib/internal/crypto/keys returned them. */
let cryptoKeyClasses: [Function, new (...args: any[]) => object] | null = null;

/** createCryptoKeyClass(callback): the storage base of InternalCryptoKey. */
export function createCryptoKeyClass(callback: (base: Function) => unknown) {
  class NativeCryptoKey {
    constructor(handle: unknown, algorithm: unknown, usagesMask: unknown, extractable: unknown, secondaryHandle?: unknown, seedData?: unknown) {
      if (!(handle instanceof KeyObjectHandle)) throw err('ERR_INVALID_ARG_TYPE', 'Invalid key object handle');
      nativeCryptoKeys.set(this, {
        handle,
        algorithm,
        usagesMask: (usagesMask as number) >>> 0,
        extractable: extractable === true,
        secondaryHandle: secondaryHandle instanceof KeyObjectHandle ? secondaryHandle : undefined,
        seedData: isAnyBufferSource(seedData) ? copy(view(seedData)) : undefined,
      });
    }
  }
  const classes = callback(NativeCryptoKey);
  if (Array.isArray(classes)) cryptoKeyClasses = classes as typeof cryptoKeyClasses;
  return classes;
}

/** getCryptoKeySlots(key) → [type, extractable, algorithm, usagesMask, handle, secondaryHandle, seedData] */
export function getCryptoKeySlots(key: unknown) {
  const s = key && typeof key === 'object' ? nativeCryptoKeys.get(key) : undefined;
  if (!s) throw invalidThis('CryptoKey');
  return [s.handle.data.type, s.extractable, s.algorithm, s.usagesMask, s.handle, s.secondaryHandle, (s.seedData && copy(s.seedData).buffer)];
}

export function isCryptoKey(v: unknown): boolean {
  return !!v && typeof v === 'object' && nativeCryptoKeys.has(v);
}

function internalCryptoKey(): new (...args: any[]) => object {
  if (!cryptoKeyClasses) S.requireBuiltin?.('internal/crypto/keys');
  if (!cryptoKeyClasses) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'CryptoKey is not set up in this thread');
  return cryptoKeyClasses[1];
}

/** A CryptoKey (InternalCryptoKey) over a handle, as the WebCrypto key generation jobs return them. */
export function newCryptoKey(handle: KeyObjectHandle, algorithm: unknown, usagesMask: number, extractable: boolean): object {
  const C = internalCryptoKey();
  return new C(handle, algorithm, usagesMask, extractable);
}

/** WebCrypto key pair generation: {publicKey, privateKey} (the public key is always extractable). */
export function newCryptoKeyPair(pub: KeyObjectHandle, priv: KeyObjectHandle, algorithm: unknown, pubUsages: number, privUsages: number, extractable: boolean) {
  return {
    publicKey: newCryptoKey(pub, algorithm, pubUsages, true),
    privateKey: newCryptoKey(priv, algorithm, privUsages, extractable),
  };
}

// -----------------------------------------------------------------------------
// MessagePort transfer: NativeKeyObject, NativeCryptoKey and (registered by x509.ts)
// X509Certificate are cloneable BaseObjects in C++. They travel as plain data under one marker key.

/** The marker a cloned native object travels as: plain data that structured clone carries. */
export const KEY_OBJECT_CLONE = '__ovKeyObject';

export interface KeyObjectClone {
  [KEY_OBJECT_CLONE]: { kind?: string; type: 0 | 1 | 2; data: Uint8Array; [k: string]: unknown };
}

/** Other cloneable natives (X509Certificate): their plain form, and how to make them again. */
interface CloneHook {
  clone(v: object): Record<string, unknown> | undefined;
  revive(data: any): object;
}
const cloneHooks = new Map<string, CloneHook>();
export function registerCloneHook(kind: string, hook: CloneHook) {
  cloneHooks.set(kind, hook);
}

function keyBytes(d: KeyData): Uint8Array {
  return d.type === 0 ? copy(d.secret) : asym().toDer(d);
}

function keyFromBytes(type: 0 | 1 | 2, data: Uint8Array): KeyObjectHandle {
  return handleFor(type === 0 ? { type: 0, secret: new Uint8Array(data) } : asym().fromDer(type, new Uint8Array(data)));
}

/** CloneForMessaging: the plain form of a KeyObject, CryptoKey or X509Certificate, or undefined for anything else. */
export function cloneKeyObject(v: unknown): KeyObjectClone | undefined {
  if (!v || typeof v !== 'object' || v instanceof KeyObjectHandle) return undefined;
  const h = nativeKeys.get(v);
  if (h) return { [KEY_OBJECT_CLONE]: { type: h.data.type, data: keyBytes(h.data) } };
  const ck = nativeCryptoKeys.get(v);
  if (ck) {
    // the algorithm dictionary is a null-prototype object; structured clone makes it a plain one
    // (own properties only: a polluted Object.prototype must not leak in or block the copy)
    const algorithm: Record<string, unknown> = {};
    for (const k of Object.keys(ck.algorithm)) Object.defineProperty(algorithm, k, { value: ck.algorithm[k], enumerable: true, writable: true, configurable: true });
    if (Object.hasOwn(algorithm, 'hash') && algorithm.hash) Object.defineProperty(algorithm, 'hash', { value: { ...(algorithm.hash as object) }, enumerable: true, writable: true, configurable: true });
    return {
      [KEY_OBJECT_CLONE]: {
        kind: 'cryptokey',
        type: ck.handle.data.type,
        data: keyBytes(ck.handle.data),
        algorithm,
        usagesMask: ck.usagesMask,
        extractable: ck.extractable,
        secondary: ck.secondaryHandle ? { type: ck.secondaryHandle.data.type, data: keyBytes(ck.secondaryHandle.data) } : undefined,
        seedData: ck.seedData && copy(ck.seedData),
      },
    };
  }
  for (const [kind, hook] of cloneHooks) {
    const data = hook.clone(v);
    if (data) return { [KEY_OBJECT_CLONE]: { kind, type: 0, data: new Uint8Array(0), ...data } };
  }
  return undefined;
}

export function isKeyObjectClone(v: unknown): v is KeyObjectClone {
  return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && KEY_OBJECT_CLONE in (v as object);
}

/** Deserialize: a new SecretKeyObject / PublicKeyObject / PrivateKeyObject, CryptoKey or X509Certificate. */
export function deserializeKeyObject(v: KeyObjectClone): object {
  const rec = v[KEY_OBJECT_CLONE];
  const { type, data } = rec;
  if (rec.kind === 'cryptokey') {
    const C = internalCryptoKey();
    const sec = rec.secondary as { type: 0 | 1 | 2; data: Uint8Array } | undefined;
    return new C(keyFromBytes(type, data), rec.algorithm, rec.usagesMask, rec.extractable, sec ? keyFromBytes(sec.type, sec.data) : undefined, rec.seedData);
  }
  if (rec.kind) {
    const hook = cloneHooks.get(rec.kind);
    if (!hook) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION', `Cannot deserialize ${rec.kind}`);
    return hook.revive(rec);
  }
  // a thread that has not touched crypto yet: loading the module creates the classes
  if (!keyObjectClasses) S.requireBuiltin?.('internal/crypto/keys');
  if (!keyObjectClasses) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'KeyObject is not set up in this thread');
  return new keyObjectClasses[1 + type](keyFromBytes(type, data));
}

// new SecretKeyGenJob(mode, lengthInBits) → KeyObjectHandle
// new SecretKeyGenJob(kCryptoJobWebCrypto, lengthInBits, algorithm, usagesMask, extractable) → CryptoKey
export const SecretKeyGenJob = jobClass('SecretKeyGenJob', (_async, length: number, algorithm?: unknown, usagesMask?: number, extractable?: boolean) => {
  // generateKey() drops a partial byte; WebCrypto keeps it (with the unused bits zero)
  const webcrypto = isWebCryptoJob();
  const bytes = webcrypto ? Math.ceil(length / 8) : Math.floor(length / 8);
  return () => {
    const out = new Uint8Array(bytes);
    fillRandom(out);
    // the bits past `length` are zero
    if (webcrypto && length % 8) out[bytes - 1] &= 0xff << (8 - (length % 8));
    const h = secretHandle(out);
    return webcrypto ? newCryptoKey(h, algorithm, usagesMask ?? 0, extractable === true) : h;
  };
});
