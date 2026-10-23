// Outbound TCP: a browser can't open sockets, so a connection to a non-local address ends here.
// The process gets one end of a socketpair; this side reads HTTP/1.1 requests from the other end,
// makes each one with fetch through the runtime's policy-checked proxy (/__ov/net), and writes the
// response back as HTTP/1.1 bytes. TLS is not done on the wire: the process's TLSWrap passes
// plaintext through and the connection says it wanted https. Anything that isn't HTTP is reset.

import { OpenFile, createSocketPair } from './io.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

const HOP = /^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade|te|trailer|host|content-length)$/i;

export interface OutboundTarget {
  host: string;
  port: number;
  tls: boolean;
}

const targets = new WeakMap<OpenFile, OutboundTarget>();

/** Opens an outbound connection; returns the process's end. */
export function connectOutbound(origin: string, target: OutboundTarget, by: string): OpenFile {
  const [processEnd, ours] = createSocketPair();
  targets.set(processEnd, target);
  void serve(origin, target, by, ours);
  return processEnd;
}

/** The process put TLS on the connection (before writing anything): requests go out as https. */
export function markOutboundTls(f: OpenFile, servername?: string): boolean {
  const t = targets.get(f);
  if (!t) return false;
  t.tls = true;
  if (servername) t.host = servername;
  return true;
}

class Reader {
  private buf = new Uint8Array(0);
  eof = false;
  constructor(private f: OpenFile) {}

  private async fill(): Promise<boolean> {
    if (this.eof) return false;
    const d = await this.f.read(65536);
    if (!d || !d.length) {
      this.eof = true;
      return false;
    }
    const b = new Uint8Array(this.buf.length + d.length);
    b.set(this.buf);
    b.set(d, this.buf.length);
    this.buf = b;
    return true;
  }

  /** Bytes up to (not including) the delimiter, or null at EOF. */
  async until(delim: string, limit = 1 << 20): Promise<Uint8Array | null> {
    for (;;) {
      const i = indexOf(this.buf, delim);
      if (i >= 0) {
        const out = this.buf.slice(0, i);
        this.buf = this.buf.subarray(i + delim.length);
        return out;
      }
      if (this.buf.length > limit || !(await this.fill())) return null;
    }
  }

  async take(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) if (!(await this.fill())) return null;
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Peeks at the first bytes without consuming them. */
  async peek(n: number): Promise<Uint8Array> {
    while (this.buf.length < n && (await this.fill()));
    return this.buf.subarray(0, n);
  }
}

async function serve(origin: string, target: OutboundTarget, by: string, conn: OpenFile) {
  const r = new Reader(conn);
  const write = (d: Uint8Array | string) => conn.write(typeof d === 'string' ? enc.encode(d) : d);
  try {
    // a request line looks like "GET /path HTTP/1.1"; anything else (a database protocol, real TLS) can't go out
    const first = dec.decode(await r.peek(8));
    if (first && !/^[A-Z]{3,10} /.test(first)) return;
    for (;;) {
      const head = await r.until('\r\n\r\n');
      if (!head) return;
      const [line, ...lines] = dec.decode(head).split('\r\n');
      const m = /^([A-Z]+) (\S+) HTTP\/1\.([01])$/.exec(line);
      if (!m) {
        write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const [, method, path, minor] = m;
      const headers: [string, string][] = [];
      for (const l of lines) {
        const i = l.indexOf(':');
        if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
      }
      const get = (n: string) => headers.find(([k]) => k.toLowerCase() === n)?.[1];
      const body = await readBody(r, get('transfer-encoding'), get('content-length'));
      if (body === null) return;
      const keepAlive = minor === '1' ? !/close/i.test(get('connection') ?? '') : /keep-alive/i.test(get('connection') ?? '');

      if (/websocket/i.test(get('upgrade') ?? '')) {
        write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nOpenVessel: WebSocket upgrades to outside hosts are not supported over raw sockets\n');
        return;
      }

      // the Host header names the site (the address may be a stand-in for an unresolved name)
      const host = get('host') ?? (target.port === (target.tls ? 443 : 80) ? target.host : `${target.host}:${target.port}`);
      const url = /^https?:\/\//i.test(path) ? path : `${target.tls ? 'https' : 'http'}://${host}${path}`;
      const ok = await forward(origin, by, url, method, headers, body, write);
      if (!ok || !keepAlive) return;
    }
  } catch {
    // the process closed its end
  } finally {
    conn.unref();
  }
}

async function readBody(r: Reader, te: string | undefined, cl: string | undefined): Promise<Uint8Array | null> {
  if (te && /chunked/i.test(te)) {
    const parts: Uint8Array[] = [];
    for (;;) {
      const sizeLine = await r.until('\r\n');
      if (sizeLine === null) return null;
      const size = parseInt(dec.decode(sizeLine).split(';')[0], 16);
      if (!size) {
        // trailers
        for (;;) {
          const t = await r.until('\r\n');
          if (t === null || t.length === 0) break;
        }
        break;
      }
      const d = await r.take(size);
      if (!d || (await r.take(2)) === null) return null;
      parts.push(d);
    }
    return concat(parts);
  }
  const n = Number(cl ?? 0);
  if (!n) return new Uint8Array(0);
  return r.take(n);
}

async function forward(origin: string, by: string, url: string, method: string, headers: [string, string][], body: Uint8Array, write: (d: Uint8Array | string) => number): Promise<boolean> {
  const pass = headers.filter(([k]) => !HOP.test(k));
  let res: Response;
  try {
    res = await fetch(`${origin}/__ov/net?url=${encodeURIComponent(url)}`, {
      method: method === 'GET' || method === 'HEAD' ? method : 'POST',
      headers: { 'x-ov-h': encodeURIComponent(JSON.stringify(pass)), 'x-ov-by': encodeURIComponent(by), 'x-ov-method': method },
      body: method === 'GET' || method === 'HEAD' ? undefined : (body as BodyInit),
    });
  } catch (e) {
    return fail(write, 502, `request to ${url} failed: ${(e as Error).message}`);
  }
  const err = res.headers.get('x-ov-error');
  if (err) return fail(write, err === 'denied' ? 403 : 502, decodeURIComponent(res.headers.get('x-ov-message') ?? err));
  const status = Number(res.headers.get('x-ov-status') ?? 200);
  const statusText = decodeURIComponent(res.headers.get('x-ov-status-text') ?? '') || 'OK';
  let rh: [string, string][] = [];
  try {
    rh = JSON.parse(decodeURIComponent(res.headers.get('x-ov-rh') ?? '[]'));
  } catch {}
  // fetch already decoded the body, and the length may differ: re-frame it as chunked
  const out = rh.filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i.test(k));
  const nullBody = status === 204 || status === 304 || method === 'HEAD' || (status >= 100 && status < 200);
  let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [k, v] of out) head += `${k}: ${v}\r\n`;
  if (!nullBody) head += 'Transfer-Encoding: chunked\r\n';
  write(head + '\r\n');
  if (nullBody) {
    await res.body?.cancel();
    return true;
  }
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.length) continue;
      write(value.length.toString(16) + '\r\n');
      write(value);
      write('\r\n');
    }
  }
  write('0\r\n\r\n');
  return true;
}

function fail(write: (d: Uint8Array | string) => number, status: number, message: string): boolean {
  const b = enc.encode(message + '\n');
  write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Type: text/plain\r\nContent-Length: ${b.length}\r\nConnection: close\r\nX-OpenVessel-Error: 1\r\n\r\n`);
  write(b);
  return false;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function indexOf(b: Uint8Array, s: string): number {
  const n = s.length;
  outer: for (let i = 0; i + n <= b.length; i++) {
    for (let j = 0; j < n; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
