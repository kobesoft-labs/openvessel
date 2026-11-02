// crypto_mac.cc (Node 26: crypto.createMac over OpenSSL's EVP_MAC). Of the MACs OpenSSL provides,
// HMAC and KMAC are implemented here; getMacs() lists only those, so callers (and Node's tests)
// treat the others as unavailable, as with an OpenSSL built without them.

import { kmac128, kmac256 } from '@noble/hashes/sha3-addons.js';
import { Enc } from '../buffer.ts';
import { HmacCtx, getDigest } from './digests.ts';
import { secretKeyBytes } from './keys.ts';
import { concat, cryptoError, decodeInput, encodeOutput, err, isAnyBufferSource, osslError, parseEncoding, view } from './util.ts';

type MacKind = 'hmac' | 'kmac128' | 'kmac256';

// EVP_MAC names and aliases → the ids getCachedMacAliases() hands out (OpenSSL's order)
const MAC_IDS: Record<string, number> = { HMAC: 0, 'KMAC-128': 7, KMAC128: 7, '2.16.840.1.101.3.4.2.19': 7, 'KMAC-256': 8, KMAC256: 8, '2.16.840.1.101.3.4.2.20': 8 };
const KINDS: Record<number, MacKind> = { 0: 'hmac', 7: 'kmac128', 8: 'kmac256' };

export function getMacs() {
  return ['hmac', 'kmac-128', 'kmac-256', 'kmac128', 'kmac256'];
}

let aliasCache: Record<string, number> | null = null;
export function getCachedMacAliases() {
  if (!aliasCache) aliasCache = Object.assign(Object.create(null), MAC_IDS);
  return aliasCache!;
}

const OPTION_NAMES = ['digest', 'cipher', 'iv', 'customization', 'salt', 'outputLength'];

function notSupported(option: string, name: string) {
  return err('ERR_INVALID_ARG_VALUE', `The property 'options.${option}' is not supported by MAC ${name}`);
}

// new Mac(name, id, cache, key, digest[, cipher, iv, customization, salt, outputLength])
export class Mac {
  #kind: MacKind;
  #hmac: HmacCtx | null = null;
  #key: Uint8Array = new Uint8Array(0);
  #custom: Uint8Array | undefined;
  #outLen = 0;
  #chunks: Uint8Array[] = [];
  #done = false;

  constructor(name: string, id: number, _cache: unknown, key: unknown, ...opts: unknown[]) {
    const kind = KINDS[typeof id === 'number' && id >= 0 ? id : (MAC_IDS[String(name).toUpperCase()] ?? -1)];
    if (!kind) throw err('ERR_CRYPTO_INVALID_MAC', `Invalid MAC: ${name}`);
    this.#kind = kind;
    const given: Record<string, unknown> = {};
    OPTION_NAMES.forEach((o, i) => {
      if (opts[i] !== undefined) given[o] = opts[i];
    });
    const allowed = kind === 'hmac' ? ['digest'] : ['customization', 'outputLength'];
    for (const o of OPTION_NAMES) if (o in given && !allowed.includes(o)) throw notSupported(o, name);
    const k = secretKeyBytes(key);
    if (kind === 'hmac') {
      if (given.digest === undefined) throw err('ERR_INVALID_ARG_VALUE', "The property 'options.digest' is required for HMAC");
      const digest = String(given.digest);
      // EVP_MD_fetch knows the digest names and OIDs, not the RSA-* signature aliases
      const algo = /^rsa-/i.test(digest) ? undefined : getDigest(digest);
      if (!algo) throw osslError('0308010C', 'digital envelope routines', 'unsupported', 'ERR_OSSL_EVP_UNSUPPORTED');
      if (algo.xof) throw err('ERR_CRYPTO_OPERATION_FAILED', 'Failed to initialize MAC');
      this.#hmac = new HmacCtx(algo, k);
      return;
    }
    // KMAC keys are 4..512 bytes; the default output is twice the security strength
    if (k.length < 4 || k.length > 512) throw osslError('1C800069', 'Provider routines', 'invalid key length', 'ERR_OSSL_INVALID_KEY_LENGTH');
    this.#key = k.slice();
    this.#custom = isAnyBufferSource(given.customization) ? view(given.customization).slice() : undefined;
    this.#outLen = typeof given.outputLength === 'number' ? given.outputLength : kind === 'kmac128' ? 32 : 64;
  }

  update(data: unknown, encoding?: unknown): boolean {
    if (this.#done) throw err('ERR_CRYPTO_OPERATION_FAILED', 'MAC context is not initialized');
    const bytes = decodeInput(data, encoding);
    if (this.#hmac) this.#hmac.update(bytes);
    else this.#chunks.push(bytes.slice());
    return true;
  }

  final(encoding?: unknown) {
    if (this.#done) throw err('ERR_CRYPTO_OPERATION_FAILED', 'MAC context is not initialized');
    this.#done = true;
    let out: Uint8Array;
    if (this.#hmac) {
      out = this.#hmac.final();
    } else if (this.#outLen === 0) {
      out = new Uint8Array(0);
    } else {
      const fn = this.#kind === 'kmac128' ? kmac128 : kmac256;
      out = fn(this.#key, concat(this.#chunks), { dkLen: this.#outLen, ...(this.#custom ? { personalization: this.#custom } : {}) });
    }
    if (!out) throw cryptoError('Failed to finalize MAC');
    return encodeOutput(out.slice(), parseEncoding(encoding, Enc.BUFFER));
  }
}
