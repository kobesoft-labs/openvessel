// crypto_spkac.cc: certVerifySpkac, certExportPublicKey, certExportChallenge — Netscape SPKI
// (SignedPublicKeyAndChallenge, base64 DER) as ncrypto reads it.

import { Enc, encode } from '../buffer.ts';
import * as der from './asn1.ts';
import { getDigest } from './digests.ts';
import { kKeyEncodingSPKI, kKeyFormatPEM, readSpki, writePublic, type Asym } from './asymkeys.ts';
import { verifyDigest } from './asym.ts';
import { err, toBuffer, view } from './util.ts';

/** signatureAlgorithm OID → [digest, kind of key] */
const SIG_ALGS: Record<string, [string, 'rsa' | 'ec' | 'dsa']> = {
  '1.2.840.113549.1.1.4': ['md5', 'rsa'],
  '1.2.840.113549.1.1.5': ['sha1', 'rsa'],
  '1.2.840.113549.1.1.14': ['sha224', 'rsa'],
  '1.2.840.113549.1.1.11': ['sha256', 'rsa'],
  '1.2.840.113549.1.1.12': ['sha384', 'rsa'],
  '1.2.840.113549.1.1.13': ['sha512', 'rsa'],
  '1.2.840.10045.4.1': ['sha1', 'ec'],
  '1.2.840.10045.4.3.1': ['sha224', 'ec'],
  '1.2.840.10045.4.3.2': ['sha256', 'ec'],
  '1.2.840.10045.4.3.3': ['sha384', 'ec'],
  '1.2.840.10045.4.3.4': ['sha512', 'ec'],
  '1.2.840.10040.4.3': ['sha1', 'dsa'],
  '2.16.840.1.101.3.4.3.1': ['sha224', 'dsa'],
  '2.16.840.1.101.3.4.3.2': ['sha256', 'dsa'],
};

interface Spkac {
  /** DER of PublicKeyAndChallenge, what the signature covers */
  signed: Uint8Array;
  key: Asym;
  challenge: Uint8Array;
  sigOid: string;
  signature: Uint8Array;
}

function input(v: unknown): Uint8Array {
  const b = view(v);
  if (b.length > 2147483647) throw err('ERR_OUT_OF_RANGE', 'spkac is too large');
  return b;
}

/** NETSCAPE_SPKI_b64_decode after ncrypto trims trailing whitespace (EVP_DecodeBlock is strict). */
function decodeSpkac(bytes: Uint8Array): Spkac | null {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || (bytes[end - 1] >= 0x09 && bytes[end - 1] <= 0x0d))) end--;
  let text = '';
  for (let i = 0; i < end; i++) text += String.fromCharCode(bytes[i]);
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4) return null;
  try {
    const top = der.children(der.expect(der.parse(encode(text, Enc.BASE64)), 0x30));
    const [pkac, alg, sig] = top;
    const [spkiNode, challenge] = der.children(der.expect(pkac, 0x30));
    const sigOid = der.readOid(der.children(der.expect(alg, 0x30))[0]);
    return {
      signed: pkac.raw,
      key: readSpki(spkiNode.raw),
      challenge: der.expect(challenge, 0x16).body,
      sigOid,
      signature: der.readBitString(sig),
    };
  } catch {
    return null;
  }
}

export function certVerifySpkac(v: unknown): boolean {
  const s = decodeSpkac(input(v));
  if (!s) return false;
  const alg = SIG_ALGS[s.sigOid];
  if (!alg) return false;
  const kind = s.key.kind === 'rsa-pss' ? 'rsa' : s.key.kind;
  if (kind !== alg[1]) return false;
  const md = getDigest(alg[0])!;
  const h = md.create();
  h.update(s.signed);
  return verifyDigest(s.key, md, h.final(), s.signature, undefined, undefined);
}

export function certExportPublicKey(v: unknown) {
  const s = decodeSpkac(input(v));
  if (!s) return '';
  return toBuffer(encode(writePublic(s.key, kKeyFormatPEM, kKeyEncodingSPKI) as string, Enc.LATIN1).slice());
}

export function certExportChallenge(v: unknown) {
  const s = decodeSpkac(input(v));
  if (!s) return '';
  return toBuffer(s.challenge.slice());
}
