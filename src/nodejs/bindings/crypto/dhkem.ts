// The KEMs OpenSSL 3 provides for classical keys (crypto.encapsulate / decapsulate on Node 24+):
// DHKEM (RFC 9180 4.1) for P-256/P-384/P-521, X25519 and X448, and RSASVE (NIST SP 800-56B) for RSA.

import { x25519 } from '@noble/curves/ed25519.js';
import { x448 } from '@noble/curves/ed448.js';
import { curveOrder, ecFromPrivate, ecPoint, randomScalar, type Asym } from './asymkeys.ts';
import { getDigest, hmac, type DigestAlgo } from './digests.ts';
import * as rsa from './rsa.ts';
import { bigIntToBytes, bytesToBigInt, modPow } from './random.ts';
import { concat, fillRandom } from './util.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const i2osp = (n: number, len: number) => {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n = Math.floor(n / 256)) out[i] = n & 0xff;
  return out;
};

interface Suite {
  id: number;
  hash: string;
  secretLen: number;
}
const SUITES: Record<string, Suite> = {
  prime256v1: { id: 0x10, hash: 'sha256', secretLen: 32 },
  secp384r1: { id: 0x11, hash: 'sha384', secretLen: 48 },
  secp521r1: { id: 0x12, hash: 'sha512', secretLen: 64 },
  x25519: { id: 0x20, hash: 'sha256', secretLen: 32 },
  x448: { id: 0x21, hash: 'sha512', secretLen: 64 },
};

/** ExtractAndExpand(dh, kem_context) with the labeled HKDF of RFC 9180 4 */
function extractAndExpand(s: Suite, dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const md = getDigest(s.hash) as DigestAlgo;
  const suiteId = concat([utf8('KEM'), i2osp(s.id, 2)]);
  const prk = hmac(md, new Uint8Array(md.size), concat([utf8('HPKE-v1'), suiteId, utf8('eae_prk'), dh]));
  const info = concat([i2osp(s.secretLen, 2), utf8('HPKE-v1'), suiteId, utf8('shared_secret'), kemContext]);
  const out: Uint8Array[] = [];
  let t = new Uint8Array(0);
  for (let i = 1, have = 0; have < s.secretLen; i++) {
    t = hmac(md, prk, concat([t, info, Uint8Array.of(i)])) as Uint8Array<ArrayBuffer>;
    out.push(t);
    have += t.length;
  }
  return concat(out).slice(0, s.secretLen);
}

function suiteOf(a: Asym): Suite | undefined {
  if (a.kind === 'ec') return SUITES[a.curve.name];
  if (a.kind === 'x25519' || a.kind === 'x448') return SUITES[a.kind];
  return undefined;
}

/** [sharedSecret, ciphertext], or null when the key has no KEM */
export function dhkemEncapsulate(a: Asym): [Uint8Array, Uint8Array] | null {
  if (a.kind === 'rsa') {
    const k = a.rsa;
    const len = rsa.byteLen(k);
    // a random z in [2, n - 2], sent as z^e mod n
    let z: bigint;
    do {
      const r = new Uint8Array(len);
      fillRandom(r);
      z = bytesToBigInt(r) % k.n;
    } while (z < 2n || z > k.n - 2n);
    return [bigIntToBytes(z, len), bigIntToBytes(modPow(z, k.e, k.n), len)];
  }
  const s = suiteOf(a);
  if (!s) return null;
  if (a.kind === 'ec') {
    const eph = ecFromPrivate(a.curve, randomScalar(a.curve)) as Extract<Asym, { kind: 'ec' }>;
    const dh = ecPoint(a.curve, a.pub).multiply(eph.d!).toBytes(false).slice(1, 1 + a.curve.size);
    return [extractAndExpand(s, dh, concat([eph.pub, a.pub])), eph.pub];
  }
  const fn = a.kind === 'x25519' ? x25519 : x448;
  const sk = fn.utils.randomSecretKey();
  const enc = fn.getPublicKey(sk);
  const pub = (a as any).pub as Uint8Array;
  return [extractAndExpand(s, fn.getSharedSecret(sk, pub), concat([enc, pub])), enc];
}

/** the shared secret, or null when the key has no KEM or the ciphertext is not one */
export function dhkemDecapsulate(a: Asym, ct: Uint8Array): Uint8Array | null {
  if (a.kind === 'rsa') {
    const k = a.rsa;
    const len = rsa.byteLen(k);
    if (ct.length !== len || k.d === undefined) return null;
    const c = bytesToBigInt(ct);
    if (c >= k.n) return null;
    return bigIntToBytes(modPow(c, k.d, k.n), len);
  }
  const s = suiteOf(a);
  if (!s) return null;
  try {
    if (a.kind === 'ec') {
      if (a.d === undefined || a.d <= 0n || a.d >= curveOrder(a.curve)) return null;
      const dh = ecPoint(a.curve, ct).multiply(a.d).toBytes(false).slice(1, 1 + a.curve.size);
      return extractAndExpand(s, dh, concat([ct, a.pub]));
    }
    const fn = a.kind === 'x25519' ? x25519 : x448;
    const priv = (a as any).priv as Uint8Array;
    return extractAndExpand(s, fn.getSharedSecret(priv, ct), concat([ct, (a as any).pub]));
  } catch {
    return null;
  }
}
