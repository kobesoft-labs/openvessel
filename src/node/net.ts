// node:net — virtual sockets and servers (nothing listens on a real port).

import { EventEmitter } from './events.ts';
import { Handle, nextTick } from './loop.ts';
import { Duplex } from './stream.ts';
import { SysError, sys } from './sys.ts';

export function isIPv4(s: string) {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
}
export function isIPv6(s: string) {
  return s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s.replace(/%.*$/, '').replace(/^\[|\]$/g, ''));
}
export function isIP(s: string) {
  return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0;
}

let autoSelect = true;
export function getDefaultAutoSelectFamily() {
  return autoSelect;
}
export function setDefaultAutoSelectFamily(v: boolean) {
  autoSelect = v;
}
export function getDefaultAutoSelectFamilyAttemptTimeout() {
  return 250;
}
export function setDefaultAutoSelectFamilyAttemptTimeout() {}

/** A socket backed by callbacks (used for upgraded HTTP connections). */
export class Socket extends Duplex {
  remoteAddress = '127.0.0.1';
  remotePort = 50000 + Math.floor(Math.random() * 10000);
  remoteFamily = 'IPv4';
  localAddress = '127.0.0.1';
  localPort = 0;
  bytesRead = 0;
  bytesWritten = 0;
  connecting = false;
  pending = false;
  readyState = 'open';
  encrypted?: boolean;
  timeout?: number;
  _sink?: (d: Uint8Array) => void;
  _onEnd?: () => void;
  private handle = new Handle();

  constructor(opts: any = {}) {
    super({ allowHalfOpen: opts.allowHalfOpen ?? false });
    if (opts._sink) {
      this._sink = opts._sink;
      this._onEnd = opts._onEnd;
      this.handle.activate();
      this.once('close', () => this.handle.deactivate());
    }
  }
  /** Data arriving from the peer. */
  _feed(d: Uint8Array | null) {
    if (d === null) {
      this.push(null);
      return;
    }
    this.bytesRead += d.length;
    this.push((globalThis as any).Buffer.from(d));
  }
  _read() {}
  _write(chunk: any, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    const b = typeof chunk === 'string' ? (globalThis as any).Buffer.from(chunk, enc) : chunk;
    this.bytesWritten += b.length;
    if (!this._sink) {
      cb(Object.assign(new Error('This socket is not connected'), { code: 'ENOTCONN' }));
      return;
    }
    this._sink(b);
    cb();
  }
  _final(cb: () => void) {
    this._onEnd?.();
    cb();
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.readyState = 'closed';
    this._onEnd?.();
    this._onEnd = undefined;
    cb(err);
  }
  connect(...args: any[]): this {
    const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    const cb = args.find((a) => typeof a === 'function');
    if (cb) this.once('connect', cb);
    this.connecting = true;
    nextTick(() => {
      this.connecting = false;
      const err = Object.assign(new Error(`connect ECONNREFUSED ${opts.host ?? '127.0.0.1'}:${opts.port}`), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: opts.host ?? '127.0.0.1', port: opts.port });
      this.destroy(err);
    });
    return this;
  }
  setEncoding(enc?: BufferEncoding) {
    return super.setEncoding(enc);
  }
  setKeepAlive() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setTimeout(ms: number, cb?: () => void) {
    this.timeout = ms;
    if (cb) this.once('timeout', cb);
    return this;
  }
  address() {
    return { address: this.localAddress, family: 'IPv4', port: this.localPort };
  }
  ref() {
    this.handle.ref();
    return this;
  }
  unref() {
    this.handle.unref();
    return this;
  }
  resetAndDestroy() {
    this.destroy();
    return this;
  }
  get bufferSize() {
    return 0;
  }
}
export const Stream = Socket;

export class Server extends EventEmitter {
  listening = false;
  maxConnections?: number;
  protected _port = 0;
  protected _host = '';
  private handle = new Handle();

  constructor(opts?: any, listener?: (s: Socket) => void) {
    super();
    if (typeof opts === 'function') listener = opts;
    if (listener) this.on('connection', listener);
  }

  listen(...args: any[]): this {
    let port = 0;
    let host = '';
    const cb = args.find((a) => typeof a === 'function');
    if (typeof args[0] === 'object' && args[0] !== null) {
      port = Number(args[0].port ?? 0);
      host = args[0].host ?? '';
    } else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) {
      // unix socket path: treat as a random port
      port = 0;
    } else {
      port = Number(args[0] ?? 0);
      if (typeof args[1] === 'string') host = args[1];
    }
    if (cb) this.once('listening', cb);
    try {
      this._port = sys<number>('listen', { port, host, kind: this._kind() });
    } catch (e) {
      const code = e instanceof SysError ? e.code : 'EADDRINUSE';
      const err = Object.assign(new Error(`listen ${code}: address already in use ${host || '::'}:${port}`), { code, errno: code === 'EADDRINUSE' ? -98 : -13, syscall: 'listen', address: host || '::', port });
      nextTick(() => this.emit('error', err));
      return this;
    }
    this._host = host;
    this.listening = true;
    this.handle.activate();
    this._onListen(this._port);
    nextTick(() => this.emit('listening'));
    return this;
  }

  protected _kind() {
    return 'tcp';
  }
  protected _onListen(_port: number) {}
  protected _onClose(_port: number) {}

  address() {
    if (!this.listening) return null;
    const h = this._host;
    const family = h && isIPv4(h) ? 'IPv4' : h === 'localhost' ? 'IPv4' : 'IPv6';
    const address = h === 'localhost' ? '127.0.0.1' : h || '::';
    return { address, family, port: this._port };
  }

  close(cb?: (err?: Error) => void) {
    if (!this.listening) {
      if (cb) nextTick(() => cb(Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })));
      return this;
    }
    this.listening = false;
    try {
      sys('unlisten', { port: this._port });
    } catch {}
    this._onClose(this._port);
    this.handle.deactivate();
    nextTick(() => {
      this.emit('close');
      cb?.();
    });
    return this;
  }

  getConnections(cb: (e: Error | null, n: number) => void) {
    nextTick(() => cb(null, 0));
    return this;
  }
  ref() {
    this.handle.ref();
    return this;
  }
  unref() {
    this.handle.unref();
    return this;
  }
  [Symbol.asyncDispose ?? Symbol.for('asyncDispose')]() {
    return new Promise<void>((r) => this.close(() => r()));
  }
}

export function createServer(opts?: any, listener?: (s: Socket) => void) {
  return new Server(opts, listener);
}

export function connect(...args: any[]) {
  const s = new Socket();
  return s.connect(...args);
}
export const createConnection = connect;

export class BlockList {
  private rules: string[] = [];
  addAddress(a: string) {
    this.rules.push(a);
  }
  addRange(a: string, b: string) {
    this.rules.push(`${a}-${b}`);
  }
  addSubnet(a: string, p: number) {
    this.rules.push(`${a}/${p}`);
  }
  check(a: string) {
    return this.rules.includes(a);
  }
}

export class SocketAddress {
  address: string;
  port: number;
  family: string;
  flowlabel = 0;
  constructor(o: { address?: string; port?: number; family?: string } = {}) {
    this.address = o.address ?? '127.0.0.1';
    this.port = o.port ?? 0;
    this.family = o.family ?? 'ipv4';
  }
}

export default { isIP, isIPv4, isIPv6, Socket, Stream, Server, createServer, connect, createConnection, BlockList, SocketAddress, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout };
