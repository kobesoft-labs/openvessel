// PKCS#12 (PFX) for SecureContext.loadPKCS12: the archive is parsed and its MAC verified with the
// passphrase (RFC 7292), so a wrong or missing passphrase fails as with OpenSSL. TLS itself runs in
// the browser (tls_wrap.ts), so the key and certificates inside are not used further.

import { DerError, children, expect, parse, readInt, readOid } from './asn1.ts';
import { type DigestAlgo, digestOnce, getDigest, hmac } from './digests.ts';
import { equalBytes } from './util.ts';

const DIGEST_OIDS: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

/** RFC 7292 B.2: the PKCS#12 key derivation (ID 3: MAC key). */
function pkcs12Kdf(algo: DigestAlgo, password: Uint8Array, salt: Uint8Array, id: number, iterations: number, n: number): Uint8Array {
  const u = algo.size;
  const v = algo.block;
  const fill = (src: Uint8Array) => {
    const out = new Uint8Array(src.length ? v * Math.ceil(src.length / v) : 0);
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
    return out;
  };
  const D = new Uint8Array(v).fill(id);
  const S = fill(salt);
  const P = fill(password);
  const I = new Uint8Array(S.length + P.length);
  I.set(S);
  I.set(P, S.length);
  const out = new Uint8Array(Math.ceil(n / u) * u);
  for (let i = 0; i * u < n; i++) {
    const di = new Uint8Array(v + I.length);
    di.set(D);
    di.set(I, v);
    let A = digestOnce(algo, di);
    for (let r = 1; r < iterations; r++) A = digestOnce(algo, A);
    out.set(A, i * u);
    // I_j = (I_j + B + 1) mod 2^(8v), B = A repeated to v bytes
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + A[k % u] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return out.subarray(0, n);
}

/** The passphrase bytes as a null-terminated BMPString (OPENSSL_asc2uni); none: empty. */
function bmpPassword(pass: Uint8Array | null): Uint8Array {
  if (pass === null) return new Uint8Array(0);
  const out = new Uint8Array((pass.length + 1) * 2);
  for (let i = 0; i < pass.length; i++) out[i * 2 + 1] = pass[i];
  return out;
}

/** PKCS12_parse's checks: an error like OpenSSL's when the archive is malformed or the MAC fails. */
export function verifyPkcs12(der: Uint8Array, passphrase: Uint8Array | undefined) {
  let authSafe: Uint8Array;
  let mac: { algo: DigestAlgo; digest: Uint8Array; salt: Uint8Array; iterations: number } | null = null;
  try {
    const pfx = children(parse(der));
    const contentInfo = children(expect(pfx[1], 0x30));
    if (readOid(contentInfo[0]) !== '1.2.840.113549.1.7.1') throw new Error('unsupported type');
    authSafe = expect(children(expect(contentInfo[1], 0xa0))[0], 0x04).body;
    if (pfx[2]) {
      const macData = children(expect(pfx[2], 0x30));
      const digestInfo = children(expect(macData[0], 0x30));
      const algOid = readOid(children(expect(digestInfo[0], 0x30))[0]);
      const algo = getDigest(DIGEST_OIDS[algOid] ?? '');
      if (!algo) throw new Error('unknown digest algorithm');
      mac = {
        algo,
        digest: expect(digestInfo[1], 0x04).body,
        salt: expect(macData[1], 0x04).body,
        iterations: macData[2] ? Number(readInt(macData[2])) : 1,
      };
    }
  } catch (e) {
    throw new Error(e instanceof DerError && /truncated/.test(e.message) ? 'not enough data' : 'wrong tag');
  }
  if (!mac) return;
  // OpenSSL tries an absent passphrase both as "" and as no password at all
  const candidates = passphrase === undefined ? [new Uint8Array(0), null] : [passphrase];
  for (const pass of candidates) {
    const key = pkcs12Kdf(mac.algo, bmpPassword(pass), mac.salt, 3, mac.iterations, mac.algo.size);
    if (equalBytes(hmac(mac.algo, key, authSafe), mac.digest)) return;
  }
  throw new Error('mac verify failure');
}
