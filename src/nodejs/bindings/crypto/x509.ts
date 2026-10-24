// crypto_x509.cc: parseX509() and the X509Certificate handle, over a DER reading of the
// certificate (RFC 5280). Names and extensions are formatted the way Node prints them with OpenSSL.

import { type Node, DerError, children, expect, fromPem, parse, read, readBitString, readOid, toPem } from './asn1.ts';
import { readSpki } from './asymkeys.ts';
import { verifyDigest } from './asym.ts';
import { digestOnce, getDigest } from './digests.ts';
import { KeyObjectHandle, keyDataOf } from './keys.ts';
import { err, osslError, toBuffer } from './util.ts';

// OBJ_nid2sn for the attribute types of names
const NAME_SN: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'street',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.13': 'description',
  '2.5.4.15': 'businessCategory',
  '2.5.4.17': 'postalCode',
  '2.5.4.41': 'name',
  '2.5.4.42': 'GN',
  '2.5.4.43': 'initials',
  '2.5.4.44': 'generationQualifier',
  '2.5.4.46': 'dnQualifier',
  '2.5.4.65': 'pseudonym',
  '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
  '1.3.6.1.4.1.311.60.2.1.1': 'jurisdictionL',
  '1.3.6.1.4.1.311.60.2.1.2': 'jurisdictionST',
  '1.3.6.1.4.1.311.60.2.1.3': 'jurisdictionC',
};

const SIG_DIGESTS: Record<string, { digest: string; pss?: boolean }> = {
  '1.2.840.113549.1.1.4': { digest: 'md5' },
  '1.2.840.113549.1.1.5': { digest: 'sha1' },
  '1.2.840.113549.1.1.14': { digest: 'sha224' },
  '1.2.840.113549.1.1.11': { digest: 'sha256' },
  '1.2.840.113549.1.1.12': { digest: 'sha384' },
  '1.2.840.113549.1.1.13': { digest: 'sha512' },
  '1.2.840.10045.4.1': { digest: 'sha1' },
  '1.2.840.10045.4.3.1': { digest: 'sha224' },
  '1.2.840.10045.4.3.2': { digest: 'sha256' },
  '1.2.840.10045.4.3.3': { digest: 'sha384' },
  '1.2.840.10045.4.3.4': { digest: 'sha512' },
};

interface NameEntry {
  oid: string;
  tag: number;
  value: Uint8Array;
  /** the AttributeValue's whole TLV */
  raw: Uint8Array;
}

interface Cert {
  der: Uint8Array;
  tbs: Uint8Array;
  serial: Uint8Array;
  sigOid: string;
  signature: Uint8Array;
  issuer: NameEntry[];
  issuerDer: Uint8Array;
  subject: NameEntry[];
  subjectDer: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  spki: Uint8Array;
  ext: Map<string, { critical: boolean; value: Uint8Array }>;
}

function readName(n: Node): NameEntry[] {
  const out: NameEntry[] = [];
  for (const rdn of children(expect(n, 0x30))) {
    for (const atv of children(expect(rdn, 0x31))) {
      const [type, value] = children(expect(atv, 0x30));
      out.push({ oid: readOid(type), tag: value.tag, value: value.body, raw: value.raw });
    }
  }
  return out;
}

function readTime(n: Node): Date {
  const s = String.fromCharCode(...n.body);
  // UTCTime YYMMDDhhmm[ss]Z, GeneralizedTime YYYYMMDDhhmm[ss]Z
  const m = (n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/).exec(s);
  if (!m) throw new DerError('bad time');
  let year = Number(m[1]);
  if (n.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

function parseCert(der: Uint8Array): Cert {
  const [tbsNode, sigAlg, sig] = children(expect(parse(der), 0x30));
  const tbs = children(expect(tbsNode, 0x30));
  let i = 0;
  if (tbs[0].tag === 0xa0) i++; // version
  const serial = expect(tbs[i++], 0x02).body;
  i++; // signature algorithm (again)
  const issuerNode = tbs[i++];
  const [nb, na] = children(expect(tbs[i++], 0x30));
  const subjectNode = tbs[i++];
  const spki = expect(tbs[i++], 0x30).raw;
  const ext = new Map<string, { critical: boolean; value: Uint8Array }>();
  for (; i < tbs.length; i++) {
    if (tbs[i].tag !== 0xa3) continue;
    for (const e of children(expect(children(tbs[i])[0], 0x30))) {
      const parts = children(expect(e, 0x30));
      const critical = parts.length === 3 && parts[1].tag === 0x01 && parts[1].body[0] !== 0;
      ext.set(readOid(parts[0]), { critical, value: expect(parts[parts.length - 1], 0x04).body });
    }
  }
  return {
    der,
    tbs: tbsNode.raw,
    serial,
    sigOid: readOid(children(expect(sigAlg, 0x30))[0]),
    signature: readBitString(sig),
    issuer: readName(issuerNode),
    issuerDer: issuerNode.raw,
    subject: readName(subjectNode),
    subjectDer: subjectNode.raw,
    notBefore: readTime(nb),
    notAfter: readTime(na),
    spki,
    ext,
  };
}

// --- strings

/** ASN1_STRING_to_UTF8: the value of a string type, or null for anything else (BIT STRING…). */
function stringValue(e: { tag: number; value: Uint8Array }): string | null {
  const b = e.value;
  switch (e.tag) {
    case 0x0c: // UTF8String
      try {
        return new TextDecoderNative('utf-8', { fatal: true }).decode(b);
      } catch {
        return null;
      }
    case 0x12: // NumericString
    case 0x13: // PrintableString
    case 0x14: // T61String
    case 0x16: // IA5String
    case 0x1a: // VisibleString
    case 0x19: // GraphicString
    case 0x1b: // GeneralString
      return String.fromCharCode(...b);
    case 0x1e: {
      // BMPString
      let s = '';
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    case 0x1c: {
      // UniversalString
      let s = '';
      for (let i = 0; i + 3 < b.length; i += 4) s += String.fromCodePoint(((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
      return s;
    }
    default:
      return null;
  }
}

// captured before Node's bootstrap swaps TextDecoder for its own (which calls into bindings)
const TextDecoderNative = globalThis.TextDecoder;

const hex = (b: Uint8Array, sep = '') => Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(sep);
const shortName = (oid: string) => NAME_SN[oid] ?? oid;

/** X509_NAME_print_ex, multi-line with RFC 2253 escaping (as X509Certificate.subject shows it). */
function nameString(entries: NameEntry[]): string {
  return entries
    .map((e) => {
      // a value that isn't a string type: its bytes as they are (a BIT STRING's without the unused-bits byte)
      const bytes = e.tag === 0x03 ? e.value.subarray(1) : e.raw;
      const s = stringValue(e) ?? String.fromCharCode(...bytes);
      let v = s.replace(/[\\,+"<>;]/g, (c) => `\\${c}`);
      v = v.replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
      if (v.startsWith('#') || v.startsWith(' ')) v = `\\${v}`;
      if (v.endsWith(' ') && v.length > 1) v = `${v.slice(0, -1)}\\ `;
      return `${shortName(e.oid)}=${v}`;
    })
    .join('\n');
}

/** GetX509NameObject: short name → value (an array when repeated); values that aren't strings are left out. */
function nameObject(entries: NameEntry[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const e of entries) {
    const v = stringValue(e);
    if (v === null) continue;
    const k = shortName(e.oid);
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[k] = [prev, v];
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** ASN1_TIME_print: "Aug 18 23:53:29 2026 GMT" */
function timeString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

function ipString(b: Uint8Array): string {
  if (b.length === 4) return Array.from(b).join('.');
  if (b.length === 16) {
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(((b[i] << 8) | b[i + 1]).toString(16).toUpperCase());
    return parts.join(':');
  }
  return '<invalid>';
}

/** Node's SAN printing: a name with characters that could confuse a reader is quoted (JSON). */
function sanValue(s: string): string {
  return /[,"\\\x00-\x1f\x7f]|[^\x00-\x7f]/.test(s) ? JSON.stringify(s) : s;
}

function generalNames(der: Uint8Array): string[] {
  const out: string[] = [];
  for (const g of children(expect(parse(der), 0x30))) {
    const s = String.fromCharCode(...g.body);
    switch (g.tag) {
      case 0x82:
        out.push(`DNS:${sanValue(s)}`);
        break;
      case 0x81:
        out.push(`email:${sanValue(s)}`);
        break;
      case 0x86:
        out.push(`URI:${sanValue(s)}`);
        break;
      case 0x87:
        out.push(`IP Address:${ipString(g.body)}`);
        break;
      case 0x88:
        out.push(`Registered ID:${readOid({ tag: 0x06, body: g.body, raw: g.raw })}`);
        break;
      case 0xa4:
        out.push(`DirName:${nameString(readName(read(g.body))).replace(/\n/g, '/')}`);
        break;
      default:
        out.push('othername:<unsupported>');
    }
  }
  return out;
}

const AIA_METHODS: Record<string, string> = { '1.3.6.1.5.5.7.48.1': 'OCSP', '1.3.6.1.5.5.7.48.2': 'CA Issuers' };

function infoAccessString(der: Uint8Array): string {
  const out: string[] = [];
  for (const ad of children(expect(parse(der), 0x30))) {
    const [method, loc] = children(expect(ad, 0x30));
    const m = readOid(method);
    out.push(`${AIA_METHODS[m] ?? m} - ${generalNames(Uint8Array.of(0x30, loc.raw.length, ...loc.raw))[0]}`);
  }
  return out.join('\n');
}

function isCA(c: Cert): boolean {
  const bc = c.ext.get('2.5.29.19');
  if (!bc) return false;
  const parts = children(expect(parse(bc.value), 0x30));
  return parts.length > 0 && parts[0].tag === 0x01 && parts[0].body[0] !== 0;
}

function extKeyUsage(c: Cert): string[] | undefined {
  const e = c.ext.get('2.5.29.37');
  if (!e) return undefined;
  return children(expect(parse(e.value), 0x30)).map(readOid);
}

function fingerprint(c: Cert, algo: string): string {
  return hex(digestOnce(getDigest(algo)!, c.der), ':');
}

function publicKeyHandle(c: Cert): KeyObjectHandle {
  const h = new KeyObjectHandle();
  h.data = { type: 1, asym: readSpki(c.spki) };
  return h;
}

// --- hostname / IP / email checks (X509_check_host and friends, as Node calls them)

function sanEntries(c: Cert): { tag: number; value: Uint8Array }[] {
  const e = c.ext.get('2.5.29.17');
  if (!e) return [];
  return children(expect(parse(e.value), 0x30)).map((g) => ({ tag: g.tag, value: g.body }));
}

function wildcardMatch(pattern: string, host: string, flags: number): boolean {
  pattern = pattern.toLowerCase();
  host = host.toLowerCase();
  if (pattern === host) return true;
  const kNoWildcards = 2;
  if (flags & kNoWildcards || !pattern.startsWith('*.')) return false;
  const rest = pattern.slice(1);
  const dot = host.indexOf('.');
  return dot > 0 && host.slice(dot) === rest && rest.split('.').length > 2;
}

const kAlwaysCheckSubject = 1;
const kNeverCheckSubject = 32;

class X509Handle {
  #c: Cert;
  constructor(c: Cert) {
    this.#c = c;
  }
  subject() {
    return nameString(this.#c.subject);
  }
  issuer() {
    return nameString(this.#c.issuer);
  }
  subjectAltName() {
    const e = this.#c.ext.get('2.5.29.17');
    return e ? generalNames(e.value).join(', ') : undefined;
  }
  infoAccess() {
    const e = this.#c.ext.get('1.3.6.1.5.5.7.1.1');
    return e ? infoAccessString(e.value) : undefined;
  }
  validFrom() {
    return timeString(this.#c.notBefore);
  }
  validTo() {
    return timeString(this.#c.notAfter);
  }
  validFromDate() {
    return new Date(this.#c.notBefore.getTime());
  }
  validToDate() {
    return new Date(this.#c.notAfter.getTime());
  }
  fingerprint() {
    return fingerprint(this.#c, 'sha1');
  }
  fingerprint256() {
    return fingerprint(this.#c, 'sha256');
  }
  fingerprint512() {
    return fingerprint(this.#c, 'sha512');
  }
  keyUsage() {
    return extKeyUsage(this.#c);
  }
  serialNumber() {
    return hex(this.#c.serial.length > 1 && this.#c.serial[0] === 0 ? this.#c.serial.subarray(1) : this.#c.serial);
  }
  raw() {
    return toBuffer(this.#c.der.slice());
  }
  pem() {
    return toPem('CERTIFICATE', this.#c.der);
  }
  publicKey() {
    return publicKeyHandle(this.#c);
  }
  checkCA() {
    return isCA(this.#c);
  }
  checkHost(name: string, flags: number) {
    const sans = sanEntries(this.#c).filter((g) => g.tag === 0x82);
    for (const g of sans) {
      const dns = String.fromCharCode(...g.value);
      if (wildcardMatch(dns, name, flags)) return dns;
    }
    if (flags & kNeverCheckSubject || (sans.length && !(flags & kAlwaysCheckSubject))) return undefined;
    for (const e of this.#c.subject) {
      if (e.oid !== '2.5.4.3') continue;
      const cn = stringValue(e);
      if (cn !== null && wildcardMatch(cn, name, flags)) return cn;
    }
    return undefined;
  }
  checkEmail(email: string, flags: number) {
    const sans = sanEntries(this.#c).filter((g) => g.tag === 0x81);
    for (const g of sans) if (String.fromCharCode(...g.value).toLowerCase() === email.toLowerCase()) return email;
    if (flags & kNeverCheckSubject || (sans.length && !(flags & kAlwaysCheckSubject))) return undefined;
    for (const e of this.#c.subject) if (e.oid === '1.2.840.113549.1.9.1' && stringValue(e)?.toLowerCase() === email.toLowerCase()) return email;
    return undefined;
  }
  checkIP(ip: string) {
    for (const g of sanEntries(this.#c)) if (g.tag === 0x87 && ipString(g.value).toLowerCase() === canonicalIP(ip)) return ip;
    return undefined;
  }
  checkIssued(other: X509Handle) {
    return equalBytes(this.#c.issuerDer, other.#c.subjectDer);
  }
  checkPrivateKey(key: unknown) {
    const d = keyDataOf(key);
    if (!d || d.type !== 2) return false;
    try {
      const pub = readSpki(this.#c.spki);
      return JSON.stringify(pubParts(pub)) === JSON.stringify(pubParts(d.asym));
    } catch {
      return false;
    }
  }
  verify(key: unknown) {
    const d = keyDataOf(key);
    if (!d || d.type === 0) return false;
    const alg = SIG_DIGESTS[this.#c.sigOid];
    if (!alg) return false;
    const md = getDigest(alg.digest)!;
    return verifyDigest(d.asym, md, digestOnce(md, this.#c.tbs), this.#c.signature, undefined, undefined);
  }
  getIssuerCert() {
    return undefined;
  }
  toLegacy() {
    return legacyObject(this.#c);
  }
}

function pubParts(a: any): unknown {
  if (a.rsa) return [a.rsa.n.toString(16), a.rsa.e.toString(16)];
  if (a.pub) return Array.from(a.pub);
  if (a.dsa) return a.dsa.y.toString(16);
  return null;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function canonicalIP(ip: string): string {
  if (!ip.includes(':')) return ip;
  // expand to eight groups, as ipString prints them
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.map((g) => parseInt(g, 16).toString(16)).join(':');
}

/** X509ToObject: the legacy certificate object (tls getPeerCertificate, X509Certificate.toLegacyObject). */
export function legacyObject(c: Cert): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  o.subject = nameObject(c.subject);
  o.issuer = nameObject(c.issuer);
  const san = c.ext.get('2.5.29.17');
  if (san) o.subjectaltname = generalNames(san.value).join(', ');
  const aia = c.ext.get('1.3.6.1.5.5.7.1.1');
  if (aia) o.infoAccess = infoAccessString(aia.value);
  o.ca = isCA(c);
  try {
    const a: any = readSpki(c.spki);
    if (a.rsa) {
      o.modulus = a.rsa.n.toString(16).toUpperCase();
      o.bits = a.rsa.n.toString(2).length;
      o.exponent = `0x${a.rsa.e.toString(16)}`;
      o.pubkey = toBuffer(c.spki.slice());
    } else if (a.kind === 'ec') {
      o.bits = a.curve.size * 8;
      o.pubkey = toBuffer(a.pub.slice());
      o.asn1Curve = a.curve.name;
      const nist: Record<string, string> = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521', secp224r1: 'P-224', prime192v1: 'P-192' };
      if (nist[a.curve.name]) o.nistCurve = nist[a.curve.name];
    }
  } catch {}
  o.valid_from = timeString(c.notBefore);
  o.valid_to = timeString(c.notAfter);
  o.fingerprint = fingerprint(c, 'sha1');
  o.fingerprint256 = fingerprint(c, 'sha256');
  o.fingerprint512 = fingerprint(c, 'sha512');
  const eku = extKeyUsage(c);
  if (eku) o.ext_key_usage = eku;
  o.serialNumber = hex(c.serial.length > 1 && c.serial[0] === 0 ? c.serial.subarray(1) : c.serial);
  o.raw = toBuffer(c.der.slice());
  return o;
}

/** A certificate from PEM or DER bytes; the OpenSSL-style error when it isn't one. */
export function certFromBytes(bytes: Uint8Array): Cert {
  let der = bytes;
  if (bytes[0] !== 0x30) {
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    const block = fromPem(text).find((b) => b.label === 'CERTIFICATE' || b.label === 'X509 CERTIFICATE' || b.label === 'TRUSTED CERTIFICATE');
    if (!block) throw osslError('0480006C', 'PEM routines', 'no start line', 'ERR_OSSL_PEM_NO_START_LINE');
    der = block.der;
  }
  try {
    return parseCert(der);
  } catch {
    throw osslError('0680007B', 'asn1 encoding routines', 'header too long', 'ERR_OSSL_ASN1_HEADER_TOO_LONG');
  }
}

export function x509Handle(c: Cert): X509Handle {
  return new X509Handle(c);
}

/** internalBinding('crypto').parseX509 */
export function parseX509(buffer: unknown) {
  if (!ArrayBuffer.isView(buffer)) throw err('ERR_INVALID_ARG_TYPE', 'The "buffer" argument must be an instance of ArrayBufferView.');
  return new X509Handle(certFromBytes(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)));
}

export type { Cert };
