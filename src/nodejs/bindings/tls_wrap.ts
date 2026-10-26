// tls_wrap and crypto's SecureContext, without TLS on the wire. Outside connections are made with
// fetch by the kernel (kernel/outbound.ts), and the browser does — and verifies — the real TLS, so
// the process's TLSWrap passes plaintext through and reports the handshake as done. Both ends of a
// TLS connection inside the runtime are pass-through too, so they still talk to each other; their
// handshake is an exchange of certificates through the kernel (syscall tlsHello), so each end sees
// the other's (getPeerCertificate, getPeerX509Certificate).

import { sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { fromShape } from './shape.ts';
import { Enc, decode, encode } from './buffer.ts';
import { LibuvStreamWrap } from './stream.ts';
import { fromPem } from './crypto/asn1.ts';
import { verifyPkcs12 } from './crypto/pkcs12.ts';
import { type Cert, certFromBytes, legacyObject, x509Handle } from './crypto/x509.ts';

const kVersions = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
const alloc = (n: number) => S.requireBuiltin('buffer').Buffer.alloc(n);

/** Every certificate in PEM text or DER bytes (a chain can hold several). */
function certsOf(v: unknown): Uint8Array[] {
  const bytes = ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
  if (bytes && bytes[0] === 0x30) return [bytes.slice()];
  let text = bytes ? '' : String(v);
  if (bytes) for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return fromPem(text)
    .filter((b) => b.label === 'CERTIFICATE' || b.label === 'TRUSTED CERTIFICATE' || b.label === 'X509 CERTIFICATE')
    .map((b) => b.der);
}

/** crypto.SecureContext: keeps the settings; there is no OpenSSL context behind it. */
export class SecureContext {
  /** this end's certificate chain (setCert) */
  certs: Uint8Array[] = [];
  #minProto = 0x0303; // TLS1_2_VERSION
  #maxProto = 0x0304; // TLS1_3_VERSION
  init(_secureProtocol?: string, minVersion?: number, maxVersion?: number) {
    if (minVersion) this.#minProto = minVersion;
    if (maxVersion) this.#maxProto = maxVersion;
  }
  setMinProto(v: number) {
    this.#minProto = v;
  }
  setMaxProto(v: number) {
    this.#maxProto = v;
  }
  getMinProto() {
    return this.#minProto;
  }
  getMaxProto() {
    return this.#maxProto;
  }
  getCertificate() {
    return this.certs.length ? alloc(0).constructor.from(this.certs[0]) : null;
  }
  getIssuer() {
    return this.certs.length > 1 ? alloc(0).constructor.from(this.certs[1]) : null;
  }
  getTicketKeys() {
    return alloc(48);
  }
}
// (lib hands these over as Buffers: toBuf() in internal/tls/secure-context)
const viewBytes = (v: unknown) => (ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : undefined);
const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
Object.assign(SecureContext.prototype, {
  setCert(this: SecureContext, cert: unknown) {
    this.certs = certsOf(cert);
  },
  /** PKCS12_parse: a malformed archive or a failed MAC (wrong passphrase) is an error */
  loadPKCS12(pfx: unknown, passphrase?: unknown) {
    const der = viewBytes(pfx) ?? latin1Bytes(String(pfx));
    verifyPkcs12(der, passphrase === undefined ? undefined : (viewBytes(passphrase) ?? latin1Bytes(String(passphrase))));
  },
  /** a CRL must at least be one (PEM "X509 CRL" or a DER sequence) */
  addCRL(crl: unknown) {
    const bytes = viewBytes(crl);
    let text = bytes ? '' : String(crl);
    if (bytes) for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    const pem = fromPem(text).some((b) => b.label === 'X509 CRL');
    if (!pem && !(bytes && bytes[0] === 0x30)) throw new Error('Failed to parse CRL');
  },
});
// every other method only records configuration (keys, certificates, ciphers, options…)
for (const m of [
  'setKey',
  'addCACert',
  'setAllowPartialTrustChain',
  'addRootCerts',
  'setCipherSuites',
  'setCiphers',
  'setSigalgs',
  'setECDHCurve',
  'setDHParam',
  'setOptions',
  'setSessionIdContext',
  'setSessionTimeout',
  'close',
  'setTicketKeys',
  'enableTicketKeyCallback',
  'setEngineKey',
  'setClientCertEngine',
]) {
  (SecureContext.prototype as any)[m] = function () {};
}
// like methods of a native object: called on anything else, they throw
for (const m of Object.getOwnPropertyNames(SecureContext.prototype)) {
  const fn = (SecureContext.prototype as any)[m];
  if (m === 'constructor' || typeof fn !== 'function') continue;
  (SecureContext.prototype as any)[m] = {
    [m](this: unknown, ...args: unknown[]) {
      if (!(this instanceof SecureContext)) throw new TypeError('Illegal invocation');
      return fn.apply(this, args);
    },
  }[m];
}
Object.assign(SecureContext, { kTicketKeyReturnIndex: 0, kTicketKeyHMACIndex: 1, kTicketKeyAESIndex: 2, kTicketKeyNameIndex: 3, kTicketKeyIVIndex: 4 });

/** TLSWraps waiting for the other end's hello, by fd */
const waiting = new Map<number, (certs: string[]) => void>();
let peerHandler = false;

function parseChain(ders: Uint8Array[]): Cert[] {
  const out: Cert[] = [];
  for (const d of ders) {
    try {
      out.push(certFromBytes(d));
    } catch {}
  }
  return out;
}
// certificates cross the syscall as base64 (its arguments are JSON)
const toB64 = (ders: Uint8Array[]) => ders.map((d) => decode(d, Enc.BASE64));
const fromB64 = (b64: string[]) => b64.map((s) => encode(s, Enc.BASE64));

/** X509ToObject with issuerCertificate links (getPeerCertificate(true)); a self-signed one points at itself. */
function detailedLegacy(chain: Cert[]): Record<string, unknown> {
  const objs = chain.map((c) => legacyObject(c));
  for (let i = 0; i < objs.length; i++) {
    const issuer = chain.findIndex((c) => sameName(c.subjectDer, chain[i].issuerDer));
    objs[i].issuerCertificate = issuer >= 0 ? objs[issuer] : objs[i];
  }
  return objs[0];
}
function sameName(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

class TLSWrap extends LibuvStreamWrap {
  _parent: LibuvStreamWrap;
  #context: SecureContext | null;
  /** the other end's chain, once it said hello (null: an outside peer, verified by the browser) */
  #peer: Cert[] | null = null;
  #helloSent = false;
  #isServer: boolean;
  #servername: string | false = false;
  #started = false;
  #marked = false;
  onhandshakestart: ((now: number) => void) | null = null;
  onhandshakedone: (() => void) | null = null;
  onerror: unknown = null;

  constructor(parent: LibuvStreamWrap, context: SecureContext | null, isServer: boolean) {
    super('TLSWrap');
    this._parent = parent;
    this.#context = context;
    this.#isServer = isServer;
    // the wrapped TCP/Pipe handle owns the fd (it may connect only later)
    Object.defineProperty(this, '_fd', { get: () => parent.fd, set: () => {}, configurable: true });
    // reads of the fd may go through this wrap: stop them when the parent closes it, or the kernel
    // keeps reading the fd and the peer never sees EOF
    const parentClose = parent.close;
    parent.close = (cb?: () => void) => {
      this.readStop();
      if (waiting.get(this.fd) === this.#peerHello) waiting.delete(this.fd);
      return parentClose.call(parent, cb);
    };
    // the wrapped stream's reads come here from now on (TLSWrap makes itself the stream's
    // listener): a server's socket is already reading when lib wraps it, and lib then takes this
    // wrap's `reading` from it
    if (parent.reading) {
      parent.readStop();
      this.readStart();
    }
    if (isServer) this.#hello();
  }

  /** The handshake: certificates to and from the other end (through the kernel), then done. */
  #hello() {
    if (this.#helloSent) return;
    this.#helloSent = true;
    let r: { wait: boolean; certs: string[] | null } = { wait: false, certs: null };
    if (this.fd >= 0) {
      try {
        r = sys('tlsHello', { fd: this.fd, certs: toB64(this.#context?.certs ?? []) });
      } catch {}
    }
    if (!r.wait) {
      if (r.certs) this.#peer = parseChain(fromB64(r.certs));
      loop.macrotask(() => this.#handshake());
      return;
    }
    if (!peerHandler) {
      peerHandler = true;
      S.kernelHandlers.set('tls-peer', (msg: { fd: number; certs: string[] }) => {
        const fn = waiting.get(msg.fd);
        waiting.delete(msg.fd);
        fn?.(msg.certs);
      });
    }
    waiting.set(this.fd, this.#peerHello);
  }

  #peerHello = (certs: string[]) => {
    this.#peer = parseChain(fromB64(certs));
    this.#handshake();
  };

  #handshake() {
    if (this.#started || this._closed) return;
    this.#started = true;
    if (typeof this.onhandshakestart === 'function') loop.scope(this.onhandshakestart, this, Date.now());
    if (typeof this.onhandshakedone === 'function') loop.scope(this.onhandshakedone, this);
  }

  /** Tells the kernel this outside connection is https (no-op for connections inside). */
  #mark() {
    if (this.#marked || this.#isServer || this.fd < 0) return;
    this.#marked = true;
    try {
      sys('tcpSetTls', { fd: this.fd, servername: this.#servername || undefined });
    } catch {}
  }

  start() {
    this.#mark();
    this.#hello();
    return 0;
  }
  override readStart() {
    this.#mark();
    return super.readStart();
  }
  override writeBuffer(req: unknown, buf: ArrayBufferView) {
    this.#mark();
    return super.writeBuffer(req, buf);
  }
  override writev(req: unknown, chunks: unknown[], allBuffers: boolean) {
    this.#mark();
    return super.writev(req, chunks, allBuffers);
  }
  override writeUtf8String(req: unknown, s: string) {
    this.#mark();
    return super.writeUtf8String(req, s);
  }
  override writeAsciiString(req: unknown, s: string) {
    this.#mark();
    return super.writeAsciiString(req, s);
  }
  override writeLatin1String(req: unknown, s: string) {
    this.#mark();
    return super.writeLatin1String(req, s);
  }
  override writeUcs2String(req: unknown, s: string) {
    this.#mark();
    return super.writeUcs2String(req, s);
  }
  /** data the previous owner already read */
  receive(buf: ArrayBufferView) {
    this._onData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice());
  }
  protected override _onClose() {
    // the parent handle owns the fd and closes it
  }

  setServername(name: string) {
    this.#servername = name;
  }
  getServername() {
    return this.#servername;
  }
  verifyError() {
    // the browser verified the certificate (or the connection stays inside the runtime)
    return null;
  }
  getPeerCertificate(detailed?: boolean) {
    // the other end inside the runtime: its own certificate (none presented: undefined)
    if (this.#peer) return this.#peer.length ? (detailed ? detailedLegacy(this.#peer) : legacyObject(this.#peer[0])) : undefined;
    const host = this.#servername || 'localhost';
    const now = Date.now();
    return {
      subject: { CN: host },
      issuer: { O: 'OpenVessel', CN: 'verified by the browser' },
      subjectaltname: `DNS:${host}`,
      valid_from: new Date(now - 864e5).toUTCString(),
      valid_to: new Date(now + 864e5 * 90).toUTCString(),
      serialNumber: '00',
      fingerprint: '',
      fingerprint256: '',
      fingerprint512: '',
      ca: false,
    };
  }
  getPeerX509Certificate() {
    return this.#peer?.length ? x509Handle(this.#peer[0]) : undefined;
  }
  getX509Certificate() {
    const own = parseChain(this.#context?.certs ?? []);
    return own.length ? x509Handle(own[0]) : undefined;
  }
  getCertificate() {
    const own = parseChain(this.#context?.certs ?? []);
    return own.length ? legacyObject(own[0]) : {};
  }
  getCipher() {
    return { name: 'TLS_AES_128_GCM_SHA256', standardName: 'TLS_AES_128_GCM_SHA256', version: 'TLSv1.3' };
  }
  getProtocol() {
    return kVersions[3];
  }
  getALPNNegotiatedProtocol() {
    // only HTTP/1.1 goes out (kernel/outbound.ts)
    return false;
  }
  getEphemeralKeyInfo() {
    return {};
  }
  isSessionReused() {
    return false;
  }
  getSession() {
    return undefined;
  }
  getTLSTicket() {
    return undefined;
  }
  getFinished() {
    return undefined;
  }
  getPeerFinished() {
    return undefined;
  }
  getSharedSigalgs() {
    return [];
  }
  exportKeyingMaterial(length: number) {
    return alloc(length);
  }
}
for (const m of [
  'setVerifyMode',
  'enableSessionCallbacks',
  'enableCertCb',
  'enableALPNCb',
  'enableKeylogCallback',
  'enableTrace',
  'enablePskCallback',
  'setPskIdentityHint',
  'setALPNProtocols',
  'setSession',
  'loadSession',
  'newSessionDone',
  'certCbDone',
  'requestOCSP',
  'setOCSPResponse',
  'setKeyCert',
  'setMaxSendFragment',
  'renegotiate',
  'destroySSL',
  'endParser',
  'writesIssuedByPrevListenerDone',
]) {
  (TLSWrap.prototype as any)[m] = function () {};
}
Object.defineProperty(TLSWrap.prototype, 'writeQueueSize', { get: () => 0, configurable: true });

export function createTlsWrap() {
  return Object.assign(fromShape('tls_wrap'), {
    TLSWrap,
    wrap(handle: LibuvStreamWrap, context: SecureContext, isServer: boolean) {
      return new TLSWrap(handle, context instanceof SecureContext ? context : null, isServer);
    },
  });
}
