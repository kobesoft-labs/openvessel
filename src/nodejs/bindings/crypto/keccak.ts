// crypto_turboshake.cc / crypto_kmac.cc (Node 24+, crypto.subtle only): TurboShakeJob,
// KangarooTwelveJob and KmacJob, on @noble/hashes' Keccak family (sha3-addons).

import { kmac128, kmac256, kt128, kt256, turboshake128, turboshake256 } from '@noble/hashes/sha3-addons.js';
import { symmetricKeyOf } from './keys.ts';
import { copy, equalBytes, isAnyBufferSource, jobClass, toArrayBuffer, view } from './util.ts';

const TURBOSHAKE: Record<string, typeof turboshake128> = { TurboSHAKE128: turboshake128, TurboSHAKE256: turboshake256 };
const KT: Record<string, typeof kt128> = { KT128: kt128, KT256: kt256 };
const KMAC: Record<string, typeof kmac128> = { KMAC128: kmac128, KMAC256: kmac256 };

// new TurboShakeJob(mode, name, domainSeparation, outputLengthInBytes, data)
export const TurboShakeJob = jobClass('TurboShakeJob', (async, name: string, domain: number, length: number, data: unknown) => {
  const fn = TURBOSHAKE[name];
  const input = async ? copy(view(data)) : view(data);
  return () => toArrayBuffer(fn(input, { dkLen: length, D: domain }));
});

// new KangarooTwelveJob(mode, name, customization | undefined, outputLengthInBytes, data)
export const KangarooTwelveJob = jobClass('KangarooTwelveJob', (async, name: string, customization: unknown, length: number, data: unknown) => {
  const fn = KT[name];
  const input = async ? copy(view(data)) : view(data);
  const personalization = isAnyBufferSource(customization) ? copy(view(customization)) : undefined;
  return () => toArrayBuffer(fn(input, { dkLen: length, ...(personalization ? { personalization } : {}) }));
});

// new KmacJob(mode, signMode, keyHandle, name, customization | undefined, outputLengthInBits, data[, signature])
export const KmacJob = jobClass('KmacJob', (async, signMode: number, keyHandle: unknown, name: string, customization: unknown, length: number, data: unknown, signature?: unknown) => {
  const fn = KMAC[name];
  const key = symmetricKeyOf(keyHandle);
  const input = async ? copy(view(data)) : view(data);
  const personalization = isAnyBufferSource(customization) ? copy(view(customization)) : undefined;
  const sig = signature === undefined ? undefined : copy(view(signature));
  return () => {
    const bytes = Math.floor(length / 8);
    const mac = bytes === 0 ? new Uint8Array(0) : fn(key, input, { dkLen: bytes, ...(personalization ? { personalization } : {}) });
    if (signMode === 0) return toArrayBuffer(mac);
    return !!sig && mac.length > 0 && equalBytes(mac, sig);
  };
});
