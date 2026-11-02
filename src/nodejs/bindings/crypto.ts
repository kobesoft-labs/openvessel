// internalBinding('crypto') — src/crypto/*.cc in JS, on @noble/hashes, @noble/ciphers and @noble/curves.
// Everything Node does synchronously stays synchronous; async CryptoJobs complete on a later macrotask
// through the event loop (WebCrypto-mode jobs settle a promise there instead of calling ondone).
// Members not listed here keep the recorded shape's ERR_NOT_IMPLEMENTED stubs; the ones lib
// feature-detects by presence are deleted instead (see below).

import { fromShape } from './shape.ts';
import { SecureContext } from './tls_wrap.ts';
import { CipherBase, getCipherInfo, getCiphers, getSSLCiphers } from './crypto/cipher.ts';
import { Hash, HashJob, Hmac, HmacJob, getCachedAliases, getHashes, oneShotDigest } from './crypto/hash.ts';
import { Argon2Job, HKDFJob, PBKDF2Job, ScryptJob } from './crypto/kdf.ts';
import { KangarooTwelveJob, KmacJob, TurboShakeJob } from './crypto/keccak.ts';
import { Mac, getCachedMacAliases, getMacs } from './crypto/mac.ts';
import {
  KeyObjectHandle,
  SecretKeyGenJob,
  createCryptoKeyClass,
  createNativeKeyObjectClass,
  getCryptoKeySlots,
  getKeyObjectSlots,
  isCryptoKey,
  isKeyObject,
} from './crypto/keys.ts';
import { CheckPrimeJob, RandomBytesJob, RandomPrimeJob, randomFillSync, secureBuffer, secureHeapUsed } from './crypto/random.ts';
import { asymmetric } from './crypto/asym.ts';
import { DiffieHellman, DiffieHellmanGroup } from './crypto/dh.ts';
import { AESCipherJob, ChaCha20Poly1305CipherJob, RSACipherJob } from './crypto/webcrypto.ts';
import { err, isAnyBufferSource, nativeRealm, view } from './crypto/util.ts';
import { certExportChallenge, certExportPublicKey, certVerifySpkac } from './crypto/spkac.ts';
import { createX509CertificateClass, isX509Certificate } from './crypto/x509.ts';
import { parsePKCS12 } from './crypto/pkcs12.ts';

export { setBufferPrototype as setCryptoBufferPrototype } from './crypto/util.ts';

function timingSafeEqual(a: unknown, b: unknown) {
  if (!isAnyBufferSource(a)) throw err('ERR_INVALID_ARG_TYPE', 'The "buf1" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.');
  if (!isAnyBufferSource(b)) throw err('ERR_INVALID_ARG_TYPE', 'The "buf2" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.');
  const x = view(a);
  const y = view(b);
  if (x.length !== y.length) throw err('ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH');
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Without a FIPS provider, real Node's setFipsCrypto(true) returns without throwing (and leaves
// OpenSSL in a broken state); here it is a no-op either way.
function setFipsCrypto(_enable: unknown) {}

export function createCrypto() {
  const binding = Object.assign(fromShape('crypto'), {
    // certificate stores: TLS runs in the browser (fetch), so the process holds none
    getBundledRootCertificates: () => [],
    SecureContext,
    getSystemCACertificates: () => [],
    getExtraCACertificates: () => [],
    getUserRootCertificates: () => [],
    resetRootCertStore: () => {},
    startLoadingCertificatesOffThread: () => {},
    addBlockedSPKIForTesting: () => {},
    clearBlockedSPKIsForTesting: () => {},
    // the TLS certificate compression algorithms OpenSSL was built with (RFC 8879)
    getCertificateCompressionAlgorithms: () => ['zlib', 'brotli', 'zstd'],
    // hashes and MACs
    Hash,
    Hmac,
    HashJob,
    HmacJob,
    KmacJob,
    TurboShakeJob,
    KangarooTwelveJob,
    Mac,
    oneShotDigest,
    getHashes,
    getCachedAliases,
    getMacs,
    getCachedMacAliases,
    // ciphers
    CipherBase,
    getCiphers,
    getSSLCiphers,
    getCipherInfo,
    // KDFs
    PBKDF2Job,
    ScryptJob,
    HKDFJob,
    Argon2Job,
    // randomness and primes
    RandomBytesJob,
    RandomPrimeJob,
    CheckPrimeJob,
    randomFillSync,
    secureBuffer,
    secureHeapUsed,
    // keys
    KeyObjectHandle,
    createNativeKeyObjectClass,
    getKeyObjectSlots,
    isKeyObject,
    createCryptoKeyClass,
    getCryptoKeySlots,
    isCryptoKey,
    SecretKeyGenJob,
    ...asymmetric,
    DiffieHellman,
    DiffieHellmanGroup,
    // WebCrypto (crypto.subtle)
    AESCipherJob,
    ChaCha20Poly1305CipherJob,
    RSACipherJob,
    // X509Certificate
    createX509CertificateClass,
    isX509Certificate,
    parsePKCS12,
    // SPKAC (crypto.Certificate)
    certVerifySpkac,
    certExportPublicKey,
    certExportChallenge,
    // misc
    timingSafeEqual,
    getFipsCrypto: () => 0,
    setFipsCrypto,
    testFipsCrypto: () => 0,
    // bumped when the FIPS mode changes, which never happens here
    getFipsCryptoGeneration: () => 0n,
    setupFipsIndicatorChannel: () => {},
    getOpenSSLSecLevelCrypto: () => 1,
    setEngine: () => false,
  });
  // C++ never sees a script's Uint8Array[Symbol.species]: keep it away from the binding's functions
  // and its classes' methods (jobs and KeyObjectHandle do the same themselves)
  for (const [k, v] of Object.entries(binding)) {
    if (typeof v !== 'function' || /^[A-Z]/.test(k) || /^create|Job$/.test(k)) continue;
    binding[k] = Object.defineProperty((...args: unknown[]) => nativeRealm(() => (v as Function)(...args)), 'name', { value: k });
  }
  for (const C of [Hash, Hmac, CipherBase, Mac, DiffieHellman, DiffieHellmanGroup, asymmetric.Sign, asymmetric.Verify, asymmetric.ECDH] as any[]) {
    for (const m of Object.getOwnPropertyNames(C.prototype)) {
      const fn = Object.getOwnPropertyDescriptor(C.prototype, m)?.value;
      if (m === 'constructor' || typeof fn !== 'function' || fn.__nativeRealm) continue;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        return nativeRealm(() => fn.apply(this, args));
      };
      (wrapped as any).__nativeRealm = true;
      Object.defineProperty(C.prototype, m, { value: wrapped, writable: true, configurable: true });
    }
  }
  return binding;
}
