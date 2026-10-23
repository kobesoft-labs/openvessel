// tls_wrap and crypto's SecureContext, without TLS on the wire. Outside connections are made with
// fetch by the kernel (kernel/outbound.ts), and the browser does — and verifies — the real TLS, so
// the process's TLSWrap passes plaintext through and reports the handshake as done. Both ends of a
// TLS connection inside the runtime are pass-through too, so they still talk to each other.

import { sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { fromShape } from './shape.ts';
import { LibuvStreamWrap } from './stream.ts';

const kVersions = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
const alloc = (n: number) => S.requireBuiltin('buffer').Buffer.alloc(n);

/** crypto.SecureContext: keeps the settings; there is no OpenSSL context behind it. */
export class SecureContext {
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
    return null;
  }
  getIssuer() {
    return null;
  }
  getTicketKeys() {
    return alloc(48);
  }
}
// every other method only records configuration (keys, certificates, ciphers, options…)
for (const m of [
  'setKey',
  'setCert',
  'addCACert',
  'setAllowPartialTrustChain',
  'addCRL',
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
  'loadPKCS12',
  'setTicketKeys',
  'enableTicketKeyCallback',
  'setEngineKey',
  'setClientCertEngine',
]) {
  (SecureContext.prototype as any)[m] = function () {};
}
Object.assign(SecureContext, { kTicketKeyReturnIndex: 0, kTicketKeyHMACIndex: 1, kTicketKeyAESIndex: 2, kTicketKeyNameIndex: 3, kTicketKeyIVIndex: 4 });

class TLSWrap extends LibuvStreamWrap {
  _parent: LibuvStreamWrap;
  #isServer: boolean;
  #servername: string | false = false;
  #started = false;
  #marked = false;
  onhandshakestart: ((now: number) => void) | null = null;
  onhandshakedone: (() => void) | null = null;
  onerror: unknown = null;

  constructor(parent: LibuvStreamWrap, isServer: boolean) {
    super('TLSWrap');
    this._parent = parent;
    this.#isServer = isServer;
    // the wrapped TCP/Pipe handle owns the fd (it may connect only later)
    Object.defineProperty(this, '_fd', { get: () => parent.fd, set: () => {}, configurable: true });
    // a server's handshake starts when the client's hello arrives: here, right away
    if (isServer) loop.macrotask(() => this.#handshake());
  }

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
    loop.macrotask(() => this.#handshake());
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
  getPeerCertificate(_detailed?: boolean) {
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
    return undefined;
  }
  getX509Certificate() {
    return undefined;
  }
  getCertificate() {
    return {};
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
    wrap(handle: LibuvStreamWrap, _context: SecureContext, isServer: boolean) {
      return new TLSWrap(handle, isServer);
    },
  });
}
