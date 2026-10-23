// crypto_keys.cc: KeyObjectHandle (secret keys; asymmetric keys come from asym.ts),
// NativeKeyObject and SecretKeyGenJob.

import { Enc, decode } from '../buffer.ts';
import type { Asym } from './asymkeys.ts';
import { err, fillRandom, isAnyBufferSource, jobClass, stringOrBuffer, toBuffer, view } from './util.ts';

export const kKeyTypeSecret = 0;
export const kKeyTypePublic = 1;
export const kKeyTypePrivate = 2;

/** What a KeyObjectHandle holds (KeyObjectData). Asymmetric material is described in asymkeys.ts. */
export type KeyData = { type: 0; secret: Uint8Array } | { type: 1 | 2; asym: Asym };

/** Implemented by asym.ts and registered at load, keeping this module free of the curve code. */
export interface AsymOps {
  init(type: number, args: any[]): KeyData;
  initJwk(jwk: any, kty: string, namedCurve: unknown): KeyData;
  initECRaw(curve: string, data: Uint8Array): KeyData | null;
  initEDRaw(name: string, data: Uint8Array, type: number): KeyData | null;
  export(data: KeyData, args: any[]): unknown;
  exportJwk(data: KeyData, target: any, handleRsaPss: boolean): void;
  keyDetail(data: KeyData, target: any): void;
  asymmetricKeyType(data: KeyData): string | undefined;
  checkEcKeyData(data: KeyData): boolean;
  equals(a: KeyData, b: KeyData): boolean;
}

let asymOps: AsymOps | null = null;
export function registerAsymOps(ops: AsymOps) {
  asymOps = ops;
}
function asym(): AsymOps {
  if (!asymOps) throw err('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Asymmetric keys are not supported in OpenVessel');
  return asymOps;
}

function base64Decode(s: string): Uint8Array {
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

export class KeyObjectHandle {
  data!: KeyData;

  init(type: number, ...args: any[]) {
    if (type === kKeyTypeSecret) {
      this.data = { type: 0, secret: view(args[0]).slice() };
      return;
    }
    this.data = asym().init(type, args);
  }

  initJwk(jwk: any, namedCurve?: unknown) {
    const kty = jwk?.kty;
    if (typeof kty !== 'string') throw err('ERR_CRYPTO_INVALID_JWK');
    if (kty === 'oct') {
      if (typeof jwk.k !== 'string') throw err('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK secret key format');
      this.data = { type: 0, secret: base64Decode(jwk.k) };
      return kKeyTypeSecret;
    }
    this.data = asym().initJwk(jwk, kty, namedCurve);
    return this.data.type;
  }

  initECRaw(curve: string, data: unknown) {
    const d = asym().initECRaw(curve, view(data));
    if (!d) return false;
    this.data = d;
    return true;
  }

  initEDRaw(name: string, data: unknown, type: number) {
    const d = asym().initEDRaw(name, view(data), type);
    if (!d) return false;
    this.data = d;
    return true;
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
    if (this.data.type === 0) return toBuffer(this.data.secret.slice());
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
    return asym().equals(a, b);
  }
}

/** A KeyObjectHandle wrapping these bytes as a secret key. */
export function secretHandle(bytes: Uint8Array): KeyObjectHandle {
  const h = new KeyObjectHandle();
  h.data = { type: 0, secret: bytes };
  return h;
}

/** Key data behind NativeKeyObject instances (KeyObject and subclasses), which some jobs receive. */
const nativeKeyData = new WeakMap<object, KeyData>();

/** The KeyObjectData of a KeyObjectHandle or a KeyObject. */
export function keyDataOf(v: unknown): KeyData | undefined {
  if (v instanceof KeyObjectHandle) return v.data;
  if (v && typeof v === 'object') return nativeKeyData.get(v);
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

/** createNativeKeyObjectClass(callback): the base class for KeyObject. */
export function createNativeKeyObjectClass(callback: (base: Function) => unknown) {
  class NativeKeyObject {
    constructor(handle: unknown) {
      if (!(handle instanceof KeyObjectHandle)) throw err('ERR_INVALID_ARG_TYPE', 'Invalid key object handle');
      nativeKeyData.set(this, handle.data);
    }
  }
  return callback(NativeKeyObject);
}

// new SecretKeyGenJob(mode, lengthInBits) → KeyObjectHandle
export const SecretKeyGenJob = jobClass('SecretKeyGenJob', (_async, length: number) => {
  const bytes = Math.floor(length / 8);
  return () => {
    const out = new Uint8Array(bytes);
    fillRandom(out);
    return secretHandle(out);
  };
});
