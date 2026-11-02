// The CryptoJobs behind crypto.subtle's ciphers (lib/internal/crypto/aes.js, rsa.js,
// chacha20_poly1305.js): AESCipherJob, RSACipherJob and ChaCha20Poly1305CipherJob. Failures surface
// as job errors, which a WebCrypto-mode job turns into an OperationError DOMException.

import { aes } from './blockcipher.ts';
import { CipherBase } from './cipher.ts';
import { getDigest } from './digests.ts';
import { keyDataOf } from './keys.ts';
import * as rsa from './rsa.ts';
import { concat, copy, cryptoError, err, isAnyBufferSource, jobClass, toArrayBuffer, view } from './util.ts';

const kWebCryptoCipherEncrypt = 0;

const cipherJobFailed = () => cryptoError('Cipher job failed');

// kKeyVariantAES_* → [mode, key bits]
const AES_VARIANTS: [string, number][] = [
  ['ctr', 128], ['ctr', 192], ['ctr', 256],
  ['cbc', 128], ['cbc', 192], ['cbc', 256],
  ['gcm', 128], ['gcm', 192], ['gcm', 256],
  ['kw', 128], ['kw', 192], ['kw', 256],
  ['ocb', 128], ['ocb', 192], ['ocb', 256],
];

function runCipherBase(name: string, encrypt: boolean, key: Uint8Array, iv: Uint8Array | null, data: Uint8Array, authTagLength = -1, setup?: (c: CipherBase) => void) {
  const c = new CipherBase(encrypt, name, key, iv, authTagLength);
  setup?.(c);
  const out = concat([c.update(data) as Uint8Array, c.final() as Uint8Array]);
  return { c, out };
}

/**
 * An AEAD cipher the WebCrypto way: encryption appends the tag; decryption takes it off the end of
 * the data (Node 24+ hands the whole ciphertext to the job).
 */
function aead(name: string, encrypt: boolean, key: Uint8Array, iv: Uint8Array, input: Uint8Array, tagLen: number, aad: Uint8Array | null): ArrayBuffer {
  let data = input;
  let tag: Uint8Array | null = null;
  if (!encrypt) {
    if (input.length < tagLen) throw cipherJobFailed();
    data = input.subarray(0, input.length - tagLen);
    tag = input.subarray(input.length - tagLen);
  }
  try {
    const { c, out } = runCipherBase(name, encrypt, key, iv, data, tagLen, (c) => {
      if (tag) c.setAuthTag(tag);
      if (aad && aad.length) c.setAAD(aad, -1);
    });
    if (!encrypt) return toArrayBuffer(out);
    return toArrayBuffer(concat([out, (c.getAuthTag() as Uint8Array).subarray(0, tagLen)]));
  } catch {
    throw cipherJobFailed();
  }
}

/** AES-CTR with a counter of `length` bits that wraps without carrying into the nonce (as Chromium). */
function aesCtr(key: Uint8Array, iv: Uint8Array, length: number, data: Uint8Array): Uint8Array {
  const blocks = Math.ceil(data.length / 16);
  const bits = BigInt(length);
  const mask = (1n << bits) - 1n;
  let block = 0n;
  for (const b of iv) block = (block << 8n) | BigInt(b);
  const start = block & mask;
  if (BigInt(blocks) > 1n << bits) throw cipherJobFailed();
  const nonce = block & ~mask;
  const c = aes(key);
  const out = new Uint8Array(data.length);
  const ctr = new Uint8Array(16);
  const ks = new Uint8Array(16);
  for (let i = 0; i < blocks; i++) {
    let v = nonce | ((start + BigInt(i)) & mask);
    for (let j = 15; j >= 0; j--) {
      ctr[j] = Number(v & 0xffn);
      v >>= 8n;
    }
    c.encrypt(ctr, 0, ks, 0);
    for (let j = 0; j < 16 && i * 16 + j < data.length; j++) out[i * 16 + j] = data[i * 16 + j] ^ ks[j];
  }
  return out;
}

// new AESCipherJob(mode, cipherMode, keyHandle, data, variant, iv | counter..., ...)
export const AESCipherJob = jobClass('AESCipherJob', (async, cipherMode: number, keyHandle: unknown, data: unknown, variant: number, ...rest: any[]) => {
  const key = keyDataOf(keyHandle);
  if (!key || key.type !== 0) throw err('ERR_INVALID_ARG_TYPE', 'Invalid key object');
  const [mode, bits] = AES_VARIANTS[variant] ?? [];
  if (!mode) throw err('ERR_CRYPTO_UNKNOWN_CIPHER');
  const input = async ? copy(view(data)) : view(data);
  const encrypt = cipherMode === kWebCryptoCipherEncrypt;
  const secret = key.secret;
  if (mode === 'kw') {
    return () => {
      if (secret.length * 8 !== bits) throw cipherJobFailed();
      try {
        return toArrayBuffer(runCipherBase(`id-aes${bits}-wrap`, encrypt, secret, Uint8Array.of(0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6), input).out);
      } catch {
        throw cipherJobFailed();
      }
    };
  }
  const iv = copy(view(rest[0]));
  if (mode === 'ctr') {
    const length = rest[1] >>> 0;
    if (iv.length !== 16 || length === 0 || length > 128) throw err('ERR_CRYPTO_INVALID_COUNTER');
    return () => {
      if (secret.length * 8 !== bits) throw cipherJobFailed();
      return toArrayBuffer(aesCtr(secret, iv, length, input));
    };
  }
  if (mode === 'cbc') {
    if (iv.length < 16) throw err('ERR_CRYPTO_INVALID_IV');
    return () => {
      if (secret.length * 8 !== bits || iv.length !== 16) throw cipherJobFailed();
      try {
        return toArrayBuffer(runCipherBase(`aes-${bits}-cbc`, encrypt, secret, iv, input).out);
      } catch {
        throw cipherJobFailed();
      }
    };
  }
  // gcm / ocb: (iv, tag length in bytes, additional data)
  if (typeof rest[1] !== 'number' || rest[1] > 16) throw err('ERR_CRYPTO_INVALID_TAG_LENGTH');
  const tagLen = rest[1];
  const aad = isAnyBufferSource(rest[2]) ? copy(view(rest[2])) : null;
  return () => {
    if (secret.length * 8 !== bits) throw cipherJobFailed();
    return aead(`aes-${bits}-${mode}`, encrypt, secret, iv, input, tagLen, aad);
  };
});

// new ChaCha20Poly1305CipherJob(mode, cipherMode, keyHandle, data, iv, additionalData)
export const ChaCha20Poly1305CipherJob = jobClass('ChaCha20Poly1305CipherJob', (async, cipherMode: number, keyHandle: unknown, data: unknown, ivArg: unknown, aadArg: unknown) => {
  const key = keyDataOf(keyHandle);
  if (!key || key.type !== 0) throw err('ERR_INVALID_ARG_TYPE', 'Invalid key object');
  const input = async ? copy(view(data)) : view(data);
  const iv = copy(view(ivArg));
  if (iv.length !== 12) throw err('ERR_CRYPTO_INVALID_IV');
  const aad = isAnyBufferSource(aadArg) ? copy(view(aadArg)) : null;
  const encrypt = cipherMode === kWebCryptoCipherEncrypt;
  const secret = key.secret;
  return () => {
    if (secret.length !== 32) throw cipherJobFailed();
    return aead('chacha20-poly1305', encrypt, secret, iv, input, 16, aad);
  };
});

// new RSACipherJob(mode, cipherMode, keyHandle, data, variant, hash, label)
export const RSACipherJob = jobClass('RSACipherJob', (async, cipherMode: number, handle: unknown, data: unknown, _variant: number, hash: string, label: unknown) => {
  const key = keyDataOf(handle);
  if (!key || key.type === 0 || !('rsa' in key.asym)) throw err('ERR_CRYPTO_INVALID_KEYTYPE');
  const algo = getDigest(hash);
  if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${hash}`);
  const input = async ? copy(view(data)) : view(data);
  const l = label === undefined || label === null ? new Uint8Array(0) : copy(view(label));
  const k = key.asym.rsa;
  return () => {
    try {
      if (cipherMode === kWebCryptoCipherEncrypt) return toArrayBuffer(rsa.oaepEncrypt(k, algo, l, input));
      if (key.type !== 2) throw cipherJobFailed();
      return toArrayBuffer(rsa.oaepDecrypt(k, algo, l, input));
    } catch {
      throw cipherJobFailed();
    }
  };
});
