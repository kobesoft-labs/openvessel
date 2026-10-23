// crypto_pbkdf2.cc / crypto_scrypt.cc / crypto_hkdf.cc

import { scrypt } from '@noble/hashes/scrypt.js';
import { getDigest, hkdf, pbkdf2 } from './digests.ts';
import { symmetricKeyOf } from './keys.ts';
import { copy, derivingBitsFailed, err, jobClass, toArrayBuffer, view } from './util.ts';

const INT_MAX = 2147483647;

// new PBKDF2Job(mode, password, salt, iterations, keylen, digest)
export const PBKDF2Job = jobClass('PBKDF2Job', (async, password: unknown, salt: unknown, iterations: number, keylen: number, digest: string) => {
  const pass = async ? copy(view(password)) : view(password);
  const s = async ? copy(view(salt)) : view(salt);
  if (iterations < 0) throw err('ERR_OUT_OF_RANGE', `iterations must be <= ${INT_MAX}`);
  if (keylen < 0) throw err('ERR_OUT_OF_RANGE', `length must be <= ${INT_MAX}`);
  const algo = getDigest(String(digest));
  if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${String(digest)}`);
  return () => {
    if (algo.xof || iterations < 1 || keylen === 0) throw derivingBitsFailed();
    return toArrayBuffer(pbkdf2(algo, pass, s, iterations, keylen));
  };
});

const SCRYPT_PR_MAX = (1 << 30) - 1;
const SCRYPT_MAX_MEM = 1024 * 1024 * 32;

/** EVP_PBE_scrypt_ex's parameter checks; returns false with or without a queued "memory limit exceeded". */
function checkScryptParams(N: number, r: number, p: number, maxmem: number): 'ok' | 'invalid' | 'memory' {
  if (r === 0 || p === 0 || N < 2 || N & (N - 1)) return 'invalid';
  if (p > Math.floor(SCRYPT_PR_MAX / r)) return 'memory';
  if (16 * r <= 63 && N >= 2 ** (16 * r)) return 'memory';
  const Blen = p * 128 * r;
  if (Blen > INT_MAX) return 'memory';
  const Vlen = 32 * r * (N + 2) * 4;
  if (maxmem === 0) maxmem = SCRYPT_MAX_MEM;
  if (Blen + Vlen > maxmem) return 'memory';
  return 'ok';
}

// new ScryptJob(mode, password, salt, N, r, p, maxmem, keylen)
export const ScryptJob = jobClass('ScryptJob', (async, password: unknown, salt: unknown, N: number, r: number, p: number, maxmem: number, keylen: number) => {
  const pass = async ? copy(view(password)) : view(password);
  const s = async ? copy(view(salt)) : view(salt);
  const check = checkScryptParams(N, r, p, Math.trunc(maxmem));
  if (check === 'memory') throw err('ERR_CRYPTO_INVALID_SCRYPT_PARAMS', 'Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded');
  if (check === 'invalid') throw err('ERR_CRYPTO_INVALID_SCRYPT_PARAMS');
  return () => {
    if (keylen === 0) return new ArrayBuffer(0);
    return toArrayBuffer(scrypt(pass, s, { N, r, p, dkLen: keylen, maxmem: 2 ** 52 }));
  };
});

// new HKDFJob(mode, hash, keyHandle, salt, info, length)
export const HKDFJob = jobClass('HKDFJob', (async, hash: string, key: unknown, salt: unknown, info: unknown, length: number) => {
  const algo = getDigest(String(hash));
  if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${String(hash)}`);
  const k = symmetricKeyOf(key);
  const s = async ? copy(view(salt)) : view(salt);
  const i = async ? copy(view(info)) : view(info);
  if (length > algo.size * 255) throw err('ERR_CRYPTO_INVALID_KEYLEN');
  return () => {
    if (length === 0 || algo.xof) throw derivingBitsFailed();
    return toArrayBuffer(hkdf(algo, k, s, i, length));
  };
});
