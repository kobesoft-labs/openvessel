// crypto_pbkdf2.cc / crypto_scrypt.cc / crypto_hkdf.cc / crypto_argon2.cc

import { scrypt } from '@noble/hashes/scrypt.js';
import { argon2d, argon2i, argon2id } from '@noble/hashes/argon2.js';
import { getDigest, hkdf, pbkdf2 } from './digests.ts';
import { secretKeyBytes } from './keys.ts';
import { copy, cryptoError, err, jobClass, osslError, toArrayBuffer, view } from './util.ts';

const INT_MAX = 2147483647;

// new PBKDF2Job(mode, password, salt, iterations, keylen, digest)
export const PBKDF2Job = jobClass('PBKDF2Job', (async, password: unknown, salt: unknown, iterations: number, keylen: number, digest: string) => {
  // a buffer, or (crypto.subtle, Node 24+) the base key's KeyObjectHandle
  const pass = async ? copy(secretKeyBytes(password)) : secretKeyBytes(password);
  const s = async ? copy(view(salt)) : view(salt);
  if (iterations < 0) throw err('ERR_OUT_OF_RANGE', `iterations must be <= ${INT_MAX}`);
  if (keylen < 0) throw err('ERR_OUT_OF_RANGE', `length must be <= ${INT_MAX}`);
  const algo = getDigest(String(digest));
  if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${String(digest)}`);
  return () => {
    // Node 24+ names the KDF, and carries the provider's error when there is one
    if (algo.xof) throw Object.assign(cryptoError('PBKDF2 derivation failed'), { code: 'ERR_OSSL_XOF_DIGESTS_NOT_ALLOWED', library: 'Provider routines', reason: 'xof digests not allowed' });
    if (iterations < 1 || keylen === 0) throw cryptoError('PBKDF2 derivation failed');
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
  // a KeyObjectHandle, or (Node 24+) the key bytes themselves
  const k = async ? copy(secretKeyBytes(key)) : secretKeyBytes(key);
  const s = async ? copy(view(salt)) : view(salt);
  const i = async ? copy(view(info)) : view(info);
  if (length > algo.size * 255) throw err('ERR_CRYPTO_INVALID_KEYLEN');
  return () => {
    if (length === 0 || algo.xof) throw cryptoError('HKDF derivation failed');
    return toArrayBuffer(hkdf(algo, k, s, i, length));
  };
});

const ARGON2 = [argon2d, argon2i, argon2id];

/** "Argon2 derivation failed", carrying the provider error OpenSSL queued. */
function argon2Failed(cause: Error): Error {
  const e = cryptoError('Argon2 derivation failed') as Error & Record<string, unknown>;
  e.opensslErrorStack = [cause.message];
  for (const k of ['library', 'reason', 'code']) e[k] = (cause as any)[k];
  return e;
}

// new Argon2Job(mode, message | keyHandle, nonce, parallelism, tagLength, memory, passes, secret,
//               associatedData, type)
export const Argon2Job = jobClass('Argon2Job', (async, message: unknown, nonce: unknown, parallelism: number, tagLength: number, memory: number, passes: number, secret: unknown, ad: unknown, type: number) => {
  const fn = ARGON2[type];
  if (!fn) throw err('ERR_INVALID_ARG_VALUE', 'Invalid Argon2 type');
  const msg = async ? copy(secretKeyBytes(message)) : secretKeyBytes(message);
  const salt = async ? copy(view(nonce)) : view(nonce);
  const key = copy(view(secret));
  const personalization = copy(view(ad));
  return () => {
    if (passes < 1) throw argon2Failed(osslError('1C80007B', 'Provider routines', 'invalid iteration count', 'ERR_OSSL_INVALID_ITERATION_COUNT'));
    // OpenSSL's provider refuses memory it cannot allocate; a tab cannot either
    if (memory * 1024 > 2 ** 32) throw argon2Failed(osslError('078C0100', 'common libcrypto routines', 'malloc failure', 'ERR_OSSL_CRYPTO_MALLOC_FAILURE'));
    return toArrayBuffer(fn(msg, salt, { t: passes, m: memory, p: parallelism, dkLen: tagLength, key, personalization, maxmem: 2 ** 32 - 1 }));
  };
});
