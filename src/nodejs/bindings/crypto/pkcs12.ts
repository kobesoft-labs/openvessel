// PKCS#12 (PFX, RFC 7292): SecureContext.loadPKCS12 verifies the archive's MAC with the passphrase,
// so a wrong or missing passphrase fails as with OpenSSL (TLS itself runs in the browser, see
// tls_wrap.ts); crypto.parsePKCS12 (Node 26) opens it: PKCS12_parse's key, its certificate and the
// other certificates.

import { DerError, children, expect, parse, readInt, readOid } from './asn1.ts';
import { type DigestAlgo, digestOnce, getDigest, hmac } from './digests.ts';
import { concat, equalBytes, err, osslError, view } from './util.ts';
import { CipherBase } from './cipher.ts';
import { decryptPkcs8, readPkcs8 } from './asymkeys.ts';
import { handleFor, type KeyObjectHandle } from './keys.ts';
import { certFromBytes, x509Handle } from './x509.ts';

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

/**
 * PKCS12_parse's checks: an error like OpenSSL's when the archive is malformed or the MAC fails.
 * Returns the password that opened it (null: none at all).
 */
export function verifyPkcs12(der: Uint8Array, passphrase: Uint8Array | undefined): Uint8Array | null {
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
  if (!mac) return passphrase ?? new Uint8Array(0);
  // OpenSSL tries an absent passphrase both as "" and as no password at all
  const candidates = passphrase === undefined ? [new Uint8Array(0), null] : [passphrase];
  for (const pass of candidates) {
    const key = pkcs12Kdf(mac.algo, bmpPassword(pass), mac.salt, 3, mac.iterations, mac.algo.size);
    if (equalBytes(hmac(mac.algo, key, authSafe), mac.digest)) return pass;
  }
  throw new Error('mac verify failure');
}

// -----------------------------------------------------------------------------
// crypto.parsePKCS12

const OIDS = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  pbeSha1TripleDes: '1.2.840.113549.1.12.1.3',
  pbeSha1TwoKeyDes: '1.2.840.113549.1.12.1.4',
  pbes2: '1.2.840.113549.1.5.13',
};

const unsupportedAlgorithm = () =>
  err('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'The PKCS#12 bundle uses an unsupported legacy algorithm (such as RC2-40-CBC)');

function derLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const b: number[] = [];
  for (; n > 0; n = Math.floor(n / 256)) b.unshift(n & 0xff);
  return Uint8Array.of(0x80 | b.length, ...b);
}
const tlv = (tag: number, body: Uint8Array) => concat([Uint8Array.of(tag), derLen(body.length), body]);

/** PKCS#12 PBE (appendix B, SHA-1 with 3DES) or PBES2 (PKCS#5) decryption. */
function pbeDecrypt(alg: Uint8Array, ct: Uint8Array, pass: Uint8Array | null): Uint8Array {
  const [oidNode, params] = children(parse(alg));
  const oid = readOid(oidNode);
  // PBES2 takes the password as it is (an EncryptedPrivateKeyInfo for asymkeys' decoder)
  if (oid === OIDS.pbes2) {
    try {
      return decryptPkcs8(tlv(0x30, concat([alg, tlv(0x04, ct)])), pass ?? new Uint8Array(0));
    } catch (e) {
      // a cipher OpenSSL 3 keeps in its legacy provider (RC2)
      if ((e as any)?.code === 'ERR_OSSL_UNSUPPORTED') throw unsupportedAlgorithm();
      throw e;
    }
  }
  if (oid !== OIDS.pbeSha1TripleDes && oid !== OIDS.pbeSha1TwoKeyDes) throw unsupportedAlgorithm();
  const [salt, iter] = children(params);
  const sha1 = getDigest('sha1')!;
  const it = Number(readInt(iter));
  const pw = bmpPassword(pass);
  let key = pkcs12Kdf(sha1, pw, expect(salt, 0x04).body, 1, it, oid === OIDS.pbeSha1TripleDes ? 24 : 16);
  if (key.length === 16) key = concat([key, key.subarray(0, 8)]);
  const iv = pkcs12Kdf(sha1, pw, expect(salt, 0x04).body, 2, it, 8);
  const c = new CipherBase(false, 'des-ede3-cbc', key, iv, -1);
  return concat([c.update(ct) as Uint8Array, c.final() as Uint8Array]);
}

interface Bag {
  kind: 'key' | 'cert';
  der: Uint8Array;
  localKeyId?: string;
}

function readSafeContents(bytes: Uint8Array, pass: Uint8Array | null, out: Bag[]) {
  for (const bag of children(parse(bytes))) {
    const [idNode, valueNode, attrs] = children(bag);
    const id = readOid(idNode);
    const value = children(expect(valueNode, 0xa0))[0];
    let localKeyId: string | undefined;
    if (attrs) {
      for (const attr of children(attrs)) {
        const [aid, set] = children(attr);
        if (readOid(aid) === OIDS.localKeyId) localKeyId = Array.from(expect(children(set)[0], 0x04).body).join(',');
      }
    }
    if (id === OIDS.keyBag) out.push({ kind: 'key', der: value.raw, localKeyId });
    else if (id === OIDS.shroudedKeyBag) {
      const [alg, data] = children(value);
      out.push({ kind: 'key', der: pbeDecrypt(alg.raw, expect(data, 0x04).body, pass), localKeyId });
    } else if (id === OIDS.certBag) {
      const [certId, certValue] = children(value);
      if (readOid(certId) !== OIDS.x509Certificate) continue;
      out.push({ kind: 'cert', der: expect(children(expect(certValue, 0xa0))[0], 0x04).body, localKeyId });
    }
  }
}

/** parsePKCS12(bundle, passphrase) → [keyHandle | null, certificate | null, otherCertificates] */
export function parsePKCS12(bundle: unknown, passphrase: unknown): [KeyObjectHandle | null, object | null, object[]] {
  const der = view(bundle);
  const given = passphrase === undefined ? undefined : view(passphrase);
  const invalid = () => err('ERR_CRYPTO_OPERATION_FAILED', 'The input is not a valid PKCS#12 bundle');
  let pass: Uint8Array | null;
  try {
    pass = verifyPkcs12(der, given);
  } catch (e) {
    if ((e as Error).message === 'mac verify failure') throw osslError('11800071', 'PKCS12 routines', 'mac verify failure', 'ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE');
    throw invalid();
  }
  const bags: Bag[] = [];
  try {
    const authSafe = expect(children(expect(children(children(parse(der))[1])[1], 0xa0))[0], 0x04).body;
    for (const ci of children(parse(authSafe))) {
      const [typeNode, content] = children(ci);
      const type = readOid(typeNode);
      if (type === OIDS.data) readSafeContents(expect(children(expect(content, 0xa0))[0], 0x04).body, pass, bags);
      else if (type === OIDS.encryptedData) {
        const [, eci] = children(children(expect(content, 0xa0))[0]);
        const [, alg, enc] = children(eci);
        readSafeContents(pbeDecrypt(alg.raw, expect(enc, 0x80).body, pass), pass, bags);
      }
    }
  } catch (e) {
    if ((e as any)?.code === 'ERR_CRYPTO_UNSUPPORTED_OPERATION') throw e;
    throw invalid();
  }
  // PKCS12_parse: the first key, the certificate sharing its localKeyId, and every other certificate
  const keyBag = bags.find((b) => b.kind === 'key');
  const key = keyBag ? handleFor({ type: 2, asym: readPkcs8(keyBag.der) }) : null;
  let cert: object | null = null;
  const others: object[] = [];
  for (const b of bags) {
    if (b.kind !== 'cert') continue;
    const ref = x509Handle(certFromBytes(b.der));
    if (keyBag && !cert && (keyBag.localKeyId === undefined || b.localKeyId === keyBag.localKeyId)) cert = ref;
    else others.push(ref);
  }
  return [key, cert, others];
}
