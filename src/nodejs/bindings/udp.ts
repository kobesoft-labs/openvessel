// udp_wrap: UDP between processes on virtual ports. The kernel keeps who receives on a port and
// hands each datagram to one of them ('udp-msg'); there is no way out of the browser for UDP, so
// only loopback traffic exists. A socket sent over IPC is shared: the receiving process joins the
// port and the datagrams are spread over the processes, like a socket two processes read from.

import { SysError, sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S } from '../state.ts';
import { asBuffer } from './buffer.ts';
import { fromShape } from './shape.ts';
import { type HandleDescriptor, HandleWrap, handleFactories } from './stream.ts';

function errno(code: string): number {
  return S.internalBinding('uv')[`UV_${code}`] ?? -1;
}

// port → the handle of this thread receiving on it
const receivers = new Map<number, UDPWrap>();
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  S.kernelHandlers.set('udp-msg', (msg: { port: number; data: Uint8Array; from: { address: string; port: number } }) => {
    const h = receivers.get(msg.port);
    if (!h || typeof h.onmessage !== 'function') return;
    const rinfo = { address: msg.from.address, family: msg.from.address.includes(':') ? 'IPv6' : 'IPv4', port: msg.from.port };
    loop.scope(h.onmessage, h, msg.data.length, h, asBuffer(msg.data), rinfo);
  });
}

const concat = (list: ArrayBufferView[], count: number) => {
  let n = 0;
  for (let i = 0; i < count; i++) n += list[i].byteLength;
  const out = new Uint8Array(n);
  n = 0;
  for (let i = 0; i < count; i++) {
    out.set(new Uint8Array(list[i].buffer, list[i].byteOffset, list[i].byteLength), n);
    n += list[i].byteLength;
  }
  return out;
};

class UDPWrap extends HandleWrap {
  onmessage: ((nread: number, handle: UDPWrap, buf?: Uint8Array, rinfo?: unknown) => void) | null = null;
  onerror: unknown = null;
  lookup: unknown;
  #address = '';
  #port = 0;
  #peer: { address: string; port: number } | null = null;
  /** @internal a socket received from another process: recvStart() joins its port */
  _shared = false;
  #joined = false;

  constructor() {
    super('UDPWrap', false, 'UDPWRAP');
  }

  get fd() {
    return -1;
  }

  open(_fd: number) {
    return errno('EINVAL');
  }

  bind(address: string, port: number, flags = 0) {
    try {
      this.#port = sys<number>('udpBind', { port, address, reuse: !!(flags & 4) });
      this.#address = address || '0.0.0.0';
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('EADDRINUSE');
    }
    this.#joined = true;
    return 0;
  }
  bind6(address: string, port: number, flags = 0) {
    return this.bind(address || '::', port, flags);
  }

  connect(address: string, port: number) {
    this.#peer = { address, port };
    return 0;
  }
  connect6(address: string, port: number) {
    return this.connect(address, port);
  }
  disconnect() {
    if (!this.#peer) return errno('ENOTCONN');
    this.#peer = null;
    return 0;
  }

  send(req: unknown, list: ArrayBufferView[], count: number, ...rest: unknown[]) {
    // (req, list, count, port, address, hasCallback) or, connected, (req, list, count, hasCallback)
    let port: number;
    let address: string;
    if (rest.length >= 3) {
      port = rest[0] as number;
      address = rest[1] as string;
    } else if (this.#peer) {
      ({ port, address } = this.#peer);
    } else return errno('EDESTADDRREQ');
    void req;
    const data = concat(list, count);
    try {
      sys('udpSend', { port, address, from: this.#port, fromAddress: this.#address }, data);
    } catch (e) {
      return e instanceof SysError ? errno(e.code) : errno('EIO');
    }
    // synchronous finish: message length + 1
    return data.length + 1;
  }
  send6(req: unknown, list: ArrayBufferView[], count: number, ...rest: unknown[]) {
    return this.send(req, list, count, ...rest);
  }

  recvStart() {
    install();
    if (this._shared && !this.#joined) {
      try {
        sys('udpJoin', { port: this.#port });
      } catch (e) {
        return e instanceof SysError ? errno(e.code) : errno('EINVAL');
      }
      this.#joined = true;
    }
    receivers.set(this.#port, this);
    try {
      sys('udpRecv', { port: this.#port, on: true });
    } catch {}
    this.setActive(true);
    return 0;
  }
  recvStop() {
    if (receivers.get(this.#port) === this) receivers.delete(this.#port);
    try {
      sys('udpRecv', { port: this.#port, on: false });
    } catch {}
    this.setActive(false);
    return 0;
  }

  getsockname(out: Record<string, unknown>) {
    if (!this.#port) return errno('EBADF');
    out.address = this.#address;
    out.family = this.#address.includes(':') ? 'IPv6' : 'IPv4';
    out.port = this.#port;
    return 0;
  }
  getpeername(out: Record<string, unknown>) {
    if (!this.#peer) return errno('ENOTCONN');
    out.address = this.#peer.address;
    out.family = this.#peer.address.includes(':') ? 'IPv6' : 'IPv4';
    out.port = this.#peer.port;
    return 0;
  }

  addMembership() {
    return 0;
  }
  dropMembership() {
    return 0;
  }
  addSourceSpecificMembership() {
    return 0;
  }
  dropSourceSpecificMembership() {
    return 0;
  }
  setMulticastInterface() {
    return 0;
  }
  setMulticastTTL() {
    return 0;
  }
  setMulticastLoopback() {
    return 0;
  }
  setBroadcast() {
    return 0;
  }
  setTTL() {
    return 0;
  }
  bufferSize() {
    return 212992;
  }
  getSendQueueSize() {
    return 0;
  }
  getSendQueueCount() {
    return 0;
  }

  /** What the kernel needs to share this socket with another process. */
  _sendDescriptor(): HandleDescriptor | null {
    return this.#port ? { type: 'udp', port: this.#port, address: this.#address } : null;
  }
  /** @internal */
  _adopt(port: number, address: string) {
    this.#port = port;
    this.#address = address;
    this._shared = true;
  }

  protected override _onClose() {
    if (receivers.get(this.#port) === this) receivers.delete(this.#port);
    if (this.#joined) {
      try {
        sys('udpClose', { port: this.#port });
      } catch {}
      this.#joined = false;
    }
  }
}

handleFactories.udp = (d) => {
  const u = new UDPWrap();
  u._adopt(Number(d.port), String(d.address ?? '0.0.0.0'));
  return u;
};

export function createUdpWrap() {
  return Object.assign(fromShape('udp_wrap'), {
    UDP: UDPWrap,
    SendWrap: class SendWrap {
      list: unknown = null;
      address = '';
      port = 0;
      callback: unknown = null;
      oncomplete: unknown = null;
    },
  });
}
