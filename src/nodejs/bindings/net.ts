// tcp_wrap and cares_wrap. TCP sockets are kernel socketpairs between processes on virtual ports
// (see src/kernel/tcp.ts): a listening TCP handle registers its port as a raw listener and gets a
// new fd per connection ('tcp-accept'); a connecting handle asks the kernel for one end.
// Name resolution: localhost and IP literals resolve locally; other names get stand-in addresses.

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { NativeURL } from '../web.ts';
import { fromShape } from './shape.ts';
import { type HandleDescriptor, LibuvStreamWrap, ReqWrap, handleFactories } from './stream.ts';
import { completeReq, emitAsyncInit, reqInit, withDefaultTrigger } from './process.ts';

function errno(code: string): number {
  return S.internalBinding('uv')[`UV_${code}`] ?? -1;
}

const servers = new Map<number, TCPWrap>();
// connects to a server of this same thread complete after its accept (the kernel has queued the
// 'tcp-accept' message by the time the connect syscall returns), as both sides of a loopback
// connection are ready in the same libuv poll
const connectsAwaitingAccept = new Map<number, (() => void)[]>();
let acceptInstalled = false;
function installAccept() {
  if (acceptInstalled) return;
  acceptInstalled = true;
  S.kernelHandlers.set('tcp-accept', (msg: { port: number; fd: number; remoteAddress: string; remotePort: number }) => {
    const waiting = connectsAwaitingAccept.get(msg.port);
    const connected = waiting?.shift();
    if (waiting && !waiting.length) connectsAwaitingAccept.delete(msg.port);
    const server = servers.get(msg.port);
    if (!server || typeof server.onconnection !== 'function') {
      try {
        sys('close', { fd: msg.fd });
      } catch {}
    } else {
      // the client handle is triggered by the server (ConnectionWrap::OnConnection)
      const client = withDefaultTrigger(server, () => new TCPWrap(0));
      client._attach(msg.fd, { address: server._address, port: msg.port }, { address: msg.remoteAddress, port: msg.remotePort });
      loop.scope(server.onconnection, server, 0, client);
    }
    connected?.();
  });
}

const isV6 = (a: string) => a.includes(':');
const family = (a: string) => (isV6(a) ? 'IPv6' : 'IPv4');
const isLoopback = (a: string) => a === 'localhost' || a.startsWith('127.') || a === '::1' || a === '0.0.0.0' || a === '::' || a === '' || a === '::ffff:127.0.0.1';

class TCPWrap extends LibuvStreamWrap {
  onconnection: ((err: number, client?: TCPWrap) => void) | null = null;
  _address = '0.0.0.0';
  #port = 0;
  #listening = false;
  #peer: { address: string; port: number } | null = null;

  constructor(public type = 0) {
    super(type === 1 ? 'TCPServerWrap' : 'TCPSocketWrap', false, type === 1 ? 'TCPSERVERWRAP' : 'TCPWRAP');
  }

  /** @internal an accepted or connected socket */
  _attach(fd: number, local: { address: string; port: number }, peer: { address: string; port: number }) {
    this._fd = fd;
    this._address = local.address;
    this.#port = local.port;
    this.#peer = peer;
  }

  open(fd: number) {
    this._fd = fd;
    return 0;
  }

  bind(address: string, port: number) {
    this._address = address || '0.0.0.0';
    this.#port = port;
    return 0;
  }
  bind6(address: string, port: number) {
    this._address = address || '::';
    this.#port = port;
    return 0;
  }

  /** @internal a listening socket received from another process: listen() joins it */
  _shared = false;

  override _sendDescriptor(): HandleDescriptor | null {
    if (this.#listening) return { type: 'tcp-listen', port: this.#port, address: this._address };
    if (this._fd < 0) return null;
    return { type: 'tcp', fd: this._fd, address: this._address, port: this.#port, peer: this.#peer };
  }

  listen(_backlog: number) {
    try {
      if (this._shared) sys('listenShare', { port: this.#port });
      else this.#port = sys<number>('listen', { port: this.#port, kind: 'raw', host: this._address });
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('EADDRINUSE');
    }
    installAccept();
    servers.set(this.#port, this);
    this.#listening = true;
    this.setActive(true);
    return 0;
  }

  connect(req: { oncomplete?: (status: number, handle: TCPWrap, req: unknown, readable: boolean, writable: boolean) => void }, address: string, port: number) {
    reqInit(req, 'TCPCONNECTWRAP', this);
    if (!isLoopback(address)) {
      // no sockets in a browser: the kernel speaks HTTP for us through the network policy (kernel/outbound.ts)
      try {
        const fd = sys<number>('tcpConnectOut', { host: hostnameForAddress(address) ?? address, port });
        this._attach(fd, { address: isV6(address) ? '::' : '0.0.0.0', port: 0 }, { address, port });
      } catch (e) {
        return this.#completeConnect(req, e instanceof SysError ? errno(e.code) : errno('ECONNREFUSED'));
      }
      return this.#completeConnect(req, 0);
    }
    let conn: { fd: number; self: boolean; localAddress: string; localPort: number };
    try {
      conn = sys('tcpConnect', { port, host: address });
    } catch (e) {
      return this.#completeConnect(req, e instanceof SysError ? errno(e.code) : errno('ECONNREFUSED'));
    }
    const { fd, self: acceptedHere } = conn;
    // the kernel gave this end an ephemeral port: the server sees it as remotePort
    this._attach(fd, { address: conn.localAddress, port: conn.localPort }, { address: conn.localAddress, port });
    if (acceptedHere && servers.has(port)) {
      const done = loop.startReq('TCPConnectWrap');
      let list = connectsAwaitingAccept.get(port);
      if (!list) connectsAwaitingAccept.set(port, (list = []));
      list.push(() => {
        done();
        this.#completeConnect(req, 0);
      });
      return 0;
    }
    return this.#completeConnect(req, 0);
  }
  connect6(req: any, address: string, port: number) {
    return this.connect(req, address, port);
  }

  #completeConnect(req: { oncomplete?: (...a: any[]) => void }, status: number) {
    // libuv reports connection results asynchronously, even failures
    const done = loop.startReq('TCPConnectWrap');
    loop.macrotask(() => {
      done();
      completeReq(req, status, this, req, true, true);
    });
    return 0;
  }

  getsockname(out: Record<string, unknown>) {
    out.address = this._address === '0.0.0.0' || this._address === '' ? (this.#listening ? '::' : '127.0.0.1') : this._address;
    out.family = family(String(out.address));
    out.port = this.#port;
    return 0;
  }

  getpeername(out: Record<string, unknown>) {
    if (!this.#peer) return errno('ENOTCONN');
    out.address = this.#peer.address;
    out.family = family(this.#peer.address);
    out.port = this.#peer.port;
    return 0;
  }

  setNoDelay() {
    return 0;
  }
  setKeepAlive() {
    return 0;
  }
  setSimultaneousAccepts() {
    return 0;
  }
  reset(cb?: () => void) {
    this.close(cb);
    return 0;
  }

  protected override _onClose() {
    // stop the kernel's reads of the fd, or the peer never sees EOF once it is closed (lib also
    // writes handle.reading itself, so that flag doesn't say whether a read is running)
    this.readStop();
    if (this.#listening) {
      servers.delete(this.#port);
      try {
        sys('unlisten', { port: this.#port });
      } catch {}
      this.#listening = false;
    }
    super._onClose();
  }
}

handleFactories.tcp = (d) => {
  const t = new TCPWrap(0);
  t._attach(d.fd as number, { address: String(d.address ?? '127.0.0.1'), port: Number(d.port ?? 0) }, (d.peer as { address: string; port: number } | null) ?? { address: '127.0.0.1', port: 0 });
  return t;
};
handleFactories['tcp-listen'] = (d) => {
  const t = new TCPWrap(1);
  t.bind(String(d.address ?? ''), Number(d.port));
  t._shared = true;
  return t;
};

export function createTcpWrap() {
  return Object.assign(fromShape('tcp_wrap'), {
    TCP: TCPWrap,
    TCPConnectWrap: class TCPConnectWrap extends ReqWrap {
      oncomplete: unknown = null;
      address = '';
      port = 0;
      localAddress = '';
      localPort = 0;
    },
  });
}

// -----------------------------------------------------------------------------
// DNS

/** Stand-in addresses for names that can't be resolved in a browser (198.18.0.0/15). */
const fakeByName = new Map<string, string>();
const nameByFake = new Map<string, string>();
function fakeAddress(name: string): string {
  let a = fakeByName.get(name);
  if (!a) {
    const n = fakeByName.size + 1;
    a = `198.18.${(n >> 8) & 255}.${n & 255}`;
    fakeByName.set(name, a);
    nameByFake.set(a, name);
  }
  return a;
}
export function hostnameForAddress(addr: string): string | undefined {
  return nameByFake.get(addr);
}

function canonicalizeIP(ip: string): string | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split('.').every((p) => Number(p) <= 255) ? ip.split('.').map(Number).join('.') : undefined;
  if (ip.includes(':')) {
    try {
      return new NativeURL(`http://[${ip}]/`).hostname.slice(1, -1);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function resolve(hostname: string, fam: number): string[] {
  const ip = canonicalizeIP(hostname);
  if (ip) return [ip];
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return fam === 6 ? ['::1'] : fam === 4 ? ['127.0.0.1'] : ['127.0.0.1', '::1'];
  if (fam === 6) return [];
  return [fakeAddress(hostname.toLowerCase())];
}

export function createCaresWrap() {
  const b = fromShape('cares_wrap');
  class GetAddrInfoReqWrap extends ReqWrap {
    oncomplete: ((err: number, addresses?: string[]) => void) | null = null;
    family = 0;
    hostname = '';
    callback: unknown = null;
  }
  class GetNameInfoReqWrap extends ReqWrap {
    oncomplete: ((err: number, hostname?: string, service?: string) => void) | null = null;
  }
  class QueryReqWrap extends ReqWrap {
    oncomplete: ((...a: unknown[]) => void) | null = null;
  }
  const later = (fn: () => void) => {
    const done = loop.startReq('GetAddrInfoReqWrap');
    loop.macrotask(() => {
      done();
      fn();
    });
  };
  class ChannelWrap {
    #servers: [string, number][] = [['127.0.0.53', 53]];
    constructor(_timeout?: number, _tries?: number) {
      emitAsyncInit(this, 'DNSCHANNEL');
    }
    getServers() {
      return this.#servers.map(([a, p]) => [a, p]);
    }
    setServers(servers: [number, string, number][]) {
      this.#servers = servers.map(([, a, p]) => [a, p || 53]);
      return 0;
    }
    setLocalAddress() {}
    cancel() {}
  }
  const query = (kind: string) =>
    function (this: ChannelWrap, req: QueryReqWrap, name: string) {
      reqInit(req, 'QUERYWRAP');
      later(() => {
        if (kind === 'queryA' || kind === 'queryAny') {
          const addrs = resolve(name, 4);
          completeReq(req, 0, addrs, addrs.map(() => 0));
          return;
        }
        if (kind === 'queryAaaa' && (name === 'localhost' || name.endsWith('.localhost'))) {
          completeReq(req, 0, ['::1'], [0]);
          return;
        }
        completeReq(req, errno('ENODATA') ?? -61);
      });
      return 0;
    };
  for (const m of ['getHostByAddr', 'queryA', 'queryAny', 'queryAaaa', 'queryCaa', 'queryCname', 'queryMx', 'queryNaptr', 'queryNs', 'queryPtr', 'querySrv', 'querySoa', 'queryTlsa', 'queryTxt']) (ChannelWrap.prototype as any)[m] = query(m);
  return Object.assign(b, {
    GetAddrInfoReqWrap,
    GetNameInfoReqWrap,
    QueryReqWrap,
    ChannelWrap,
    getaddrinfo(req: GetAddrInfoReqWrap, hostname: string, fam: number, _hints: number, order: number) {
      reqInit(req, 'GETADDRINFOREQWRAP');
      later(() => {
        let addrs = resolve(hostname, fam);
        if (order === 2) addrs = [...addrs.filter(isV6), ...addrs.filter((a) => !isV6(a))];
        else if (order === 1) addrs = [...addrs.filter((a) => !isV6(a)), ...addrs.filter(isV6)];
        if (addrs.length) completeReq(req, 0, addrs);
        else completeReq(req, -3008 /* UV_EAI_NODATA */);
      });
      return 0;
    },
    getnameinfo(req: GetNameInfoReqWrap, address: string, port: number) {
      reqInit(req, 'GETNAMEINFOREQWRAP');
      later(() => {
        const name = isLoopback(address) ? 'localhost' : (nameByFake.get(address) ?? address);
        completeReq(req, 0, name, String(port));
      });
      return 0;
    },
    canonicalizeIP,
    convertIpv6StringToBuffer(ip: string) {
      const c = canonicalizeIP(ip);
      if (!c || !c.includes(':')) return undefined;
      const parts = c.split('::');
      const head = parts[0] ? parts[0].split(':') : [];
      const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
      const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
      const out = new Uint8Array(16);
      groups.forEach((g, i) => {
        const v = parseInt(g, 16);
        out[2 * i] = v >> 8;
        out[2 * i + 1] = v & 255;
      });
      return out;
    },
    strerror: (code: number) => S.internalBinding('uv').getErrorMessage?.(code) ?? `DNS error ${code}`,
  });
}
