// crypto_hash.cc / crypto_hmac.cc: Hash, Hmac, oneShotDigest, HashJob, HmacJob.

import { Enc } from '../buffer.ts';
import { ALGOS, HASH_NAMES, HmacCtx, digestOnce, getDigest, hmac, type Ctx, type DigestAlgo } from './digests.ts';
import { HASH_ALIASES } from './tables.ts';
import { OSSL, copy, cryptoError, decodeInput, encodeOutput, err, jobClass, parseEncoding, stringOrBuffer, toArrayBuffer, view } from './util.ts';
import { secretKeyBytes, symmetricKeyOf } from './keys.ts';

let aliasCache: Record<string, number> | null = null;

/**
 * getCachedAliases(): a null-prototype object of alias → id. Like Node's, it starts empty and fills
 * as names get resolved (Node fills it wholesale on getHashes(); we do the same).
 */
export function getCachedAliases() {
  if (!aliasCache) aliasCache = Object.create(null);
  return aliasCache!;
}

function lookup(algorithm: unknown, id: unknown, cache: any): DigestAlgo | undefined {
  if (typeof id === 'number' && id >= 0 && ALGOS[id]) return ALGOS[id];
  const algo = getDigest(algorithm);
  if (algo && typeof algorithm === 'string' && cache && typeof cache === 'object') cache[algorithm] = algo.id;
  return algo;
}

export class Hash {
  #algo: DigestAlgo;
  #ctx: Ctx;
  #len: number;
  #digest: Uint8Array | null = null;

  // new Hash(algorithm | Hash, xofLen, algorithmId, algorithmCache)
  constructor(algorithm: unknown, xofLen?: number, algorithmId?: number, cache?: object) {
    let algo: DigestAlgo | undefined;
    let ctx: Ctx | undefined;
    if (algorithm instanceof Hash) {
      algo = algorithm.#algo;
      ctx = algorithm.#ctx.clone();
    } else {
      algo = lookup(algorithm, algorithmId, cache);
    }
    if (!algo) throw cryptoError('Digest method not supported');
    let len = algo.size;
    if (xofLen !== undefined && xofLen !== len) {
      // createHash with outputLength on a fixed-size digest fails inside OpenSSL
      if (!algo.xof) throw OSSL.notXof();
      len = xofLen;
    }
    this.#algo = algo;
    this.#ctx = ctx ?? algo.create();
    this.#len = len;
  }

  update(data: unknown, encoding?: unknown): boolean {
    this.#ctx.update(decodeInput(data, encoding));
    return true;
  }

  digest(encoding?: unknown) {
    const enc = parseEncoding(encoding, Enc.BUFFER);
    if (!this.#digest) this.#digest = this.#len > 0 ? this.#ctx.final(this.#len) : new Uint8Array(0);
    return encodeOutput(this.#digest.slice(), enc);
  }
}

export class Hmac {
  #ctx: HmacCtx | null = null;

  init(hashType: unknown, key: unknown) {
    const algo = getDigest(String(hashType));
    if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${String(hashType)}`);
    if (algo.xof) throw cryptoError('error:00000000:lib(0)::reason(0)');
    this.#ctx = new HmacCtx(algo, secretKeyBytes(key));
  }

  update(data: unknown, encoding?: unknown): boolean {
    if (!this.#ctx) return false;
    this.#ctx.update(decodeInput(data, encoding));
    return true;
  }

  digest(encoding?: unknown) {
    const enc = parseEncoding(encoding, Enc.BUFFER);
    let out = new Uint8Array(0);
    if (this.#ctx) {
      out = this.#ctx.final() as Uint8Array<ArrayBuffer>;
      this.#ctx = null;
    }
    return encodeOutput(out, enc);
  }
}

// crypto.digest(algorithm, algorithmId, algorithmCache, input, outputEncoding, outputEncodingId)
export function oneShotDigest(algorithm: string, algorithmId: number, cache: object, input: unknown, outputEncoding: string, outputEncodingId?: number) {
  const algo = lookup(algorithm, algorithmId, cache);
  if (!algo) throw cryptoError(`Digest method ${algorithm} is not supported`);
  const enc = typeof outputEncodingId === 'number' ? (outputEncodingId as Enc) : parseEncoding(outputEncoding, Enc.HEX);
  return encodeOutput(digestOnce(algo, stringOrBuffer(input)), enc);
}

export function getHashes() {
  Object.assign(getCachedAliases(), HASH_ALIASES);
  return HASH_NAMES.slice();
}

// new HashJob(mode, algorithm, data[, lengthInBits])
export const HashJob = jobClass('HashJob', (async, algorithm: string, data: unknown, length?: number) => {
  const algo = getDigest(algorithm);
  if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${algorithm}`);
  const input = async ? copy(view(data)) : view(data);
  let len = algo.size;
  if (typeof length === 'number' && length >= 0 && Number.isInteger(length)) {
    len = Math.floor(length / 8);
    if (len !== algo.size && !algo.xof) throw err('ERR_CRYPTO_INVALID_DIGEST', 'Digest method not supported');
  }
  return () => toArrayBuffer(len > 0 ? digestOnce(algo, input, len) : new Uint8Array(0));
});

// new HmacJob(mode, signMode, hash, keyHandle, data[, signature])
export const HmacJob = jobClass('HmacJob', (async, signMode: number, hash: string, key: unknown, data: unknown, signature?: unknown) => {
  const algo = getDigest(hash);
  if (!algo) throw err('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${hash}`);
  const k = symmetricKeyOf(key);
  const input = async ? copy(view(data)) : view(data);
  const sig = signature === undefined ? undefined : async ? copy(view(signature)) : view(signature);
  return () => {
    const mac = hmac(algo, k, input);
    if (signMode === 0) return toArrayBuffer(mac);
    if (!sig || mac.length === 0 || mac.length !== sig.length) return false;
    let d = 0;
    for (let i = 0; i < mac.length; i++) d |= mac[i] ^ sig[i];
    return d === 0;
  };
});
