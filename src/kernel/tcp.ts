// Byte-stream TCP between processes on virtual ports (for the ported Node, whose net/http run on
// real sockets). A connection is a socketpair: the listener's process receives one end as a new fd
// ('tcp-accept'), the connecting side gets the other. Requests that arrive as HTTP messages
// (from the preview iframe or the legacy runtime) are written to such a connection as HTTP/1.1
// bytes, and the server's response bytes are parsed back; WebSocket upgrades switch to frames.

import { FrameParser, encodeClientFrame } from '../node/wscodec.ts';
import { OpenFile, createSocketPair } from './io.ts';
import type { Kernel, ListenRecord } from './kernel.ts';
import type { HttpRequestInit, HttpResponder } from './net.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
let nextPeerPort = 40000;

export class TcpBridge {
  constructor(private kernel: Kernel) {}

  /** Opens a connection to a raw listener; returns the connecting side's end. */
  connect(rec: ListenRecord, from?: { address: string; port: number }, accept = 'tcp-accept'): OpenFile | null {
    // a listening socket shared by several processes: they take turns accepting
    let owner: { pid: number; tid: number } = rec;
    if (rec.acceptors?.length) {
      const all = [{ pid: rec.pid, tid: rec.tid }, ...rec.acceptors].filter((a) => this.kernel.procs.get(a.pid)?.state === 'running');
      if (all.length) owner = all[(rec.next = ((rec.next ?? -1) + 1) % all.length)];
    }
    const proc = this.kernel.procs.get(owner.pid);
    if (!proc || proc.state !== 'running') return null;
    const [serverEnd, clientEnd] = createSocketPair();
    const fd = proc.allocFd(serverEnd, 3);
    const thread = proc.threads.get(owner.tid) ?? proc.threads.values().next().value;
    const peerPort = from?.port ?? (nextPeerPort = nextPeerPort >= 60000 ? 40000 : nextPeerPort + 1);
    thread?.worker.postMessage({ t: accept, port: rec.port, fd, remoteAddress: from?.address ?? '127.0.0.1', remotePort: peerPort });
    this.lastAcceptor = { pid: proc.pid, tid: thread?.tid ?? 0 };
    return clientEnd;
  }

  /** Who was handed the last connection made by connect(). */
  lastAcceptor: { pid: number; tid: number } | null = null;

  /** NetRouter.request for raw listeners: HTTP message ⇄ HTTP/1.1 bytes. */
  request(rec: ListenRecord, init: HttpRequestInit, responder: HttpResponder) {
    const conn = this.connect(rec);
    if (!conn) {
      responder.error(`connect ECONNREFUSED 127.0.0.1:${rec.port}`);
      return null;
    }
    conn.bridged = true;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      conn.unref();
    };
    const write = (d: Uint8Array) => {
      if (closed) return;
      try {
        conn.write(d);
      } catch {
        close();
      }
    };

    // request head
    const headers = init.headers.filter(([k]) => !/^(connection|keep-alive|transfer-encoding|upgrade|sec-websocket-key|sec-websocket-version)$/i.test(k));
    if (!headers.some(([k]) => k.toLowerCase() === 'host')) headers.unshift(['Host', `localhost:${rec.port}`]);
    const chunked = init.hasBody && !headers.some(([k]) => k.toLowerCase() === 'content-length');
    if (init.upgrade) {
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      headers.push(['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Key', key]);
    } else {
      headers.push(['Connection', 'close']);
      if (chunked) headers.push(['Transfer-Encoding', 'chunked']);
    }
    let head = `${init.method} ${init.url} HTTP/1.1\r\n`;
    for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
    write(enc.encode(head + '\r\n'));

    // response
    const parser = new ResponseParser(responder, () => upgraded());
    let ws: FrameParser | null = null;
    const upgraded = () => {
      ws = new FrameParser((opcode, payload) => {
        if (opcode === 1) responder.wsMessage?.(dec.decode(payload), false);
        else if (opcode === 2) responder.wsMessage?.(payload, true);
        else if (opcode === 8) {
          const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
          responder.wsClose?.(code, dec.decode(payload.subarray(2)));
          close();
        } else if (opcode === 9) write(encodeClientFrame(payload, 10));
      });
      return ws;
    };
    (async () => {
      try {
        for (;;) {
          const d = await conn.read(65536);
          if (!d.length) break;
          const frames = ws as FrameParser | null;
          if (frames) frames.push(d);
          else {
            const rest = parser.push(d);
            const upgradedFrames = ws as FrameParser | null;
            if (rest && upgradedFrames) upgradedFrames.push(rest);
          }
        }
        if (ws as FrameParser | null) responder.wsClose?.(1006, '');
        else parser.finish();
      } catch (e: any) {
        if (!parser.done) responder.error(e?.message ?? 'connection reset');
      } finally {
        close();
      }
    })();

    return {
      body: (d: Uint8Array) => {
        if (!chunked) return write(d);
        write(enc.encode(d.length.toString(16) + '\r\n'));
        write(d);
        write(enc.encode('\r\n'));
      },
      bodyEnd: () => {
        if (chunked) write(enc.encode('0\r\n\r\n'));
      },
      abort: close,
      wsSend: (data: Uint8Array | string, binary: boolean) => write(encodeClientFrame(typeof data === 'string' ? enc.encode(data) : data, binary ? 2 : 1)),
      wsClose: (code: number, reason: string) => {
        const r = enc.encode(reason);
        const p = new Uint8Array(2 + r.length);
        p[0] = code >> 8;
        p[1] = code & 0xff;
        p.set(r, 2);
        write(encodeClientFrame(p, 8));
      },
      done: () => {},
    };
  }
}

/** HTTP/1.1 response parser: status line and headers, then content-length, chunked or close-delimited body. */
class ResponseParser {
  done = false;
  private buf = new Uint8Array(0);
  private state: 'head' | 'length' | 'chunk-size' | 'chunk-data' | 'chunk-crlf' | 'trailers' | 'close' | 'end' = 'head';
  private remaining = 0;
  constructor(
    private responder: HttpResponder,
    private onUpgrade: () => unknown,
  ) {}

  /** Feeds bytes; returns bytes left over after a 101 Switching Protocols. */
  push(chunk: Uint8Array): Uint8Array | null {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    this.buf = b;
    for (;;) {
      switch (this.state) {
        case 'head': {
          const end = indexOf(this.buf, '\r\n\r\n');
          if (end < 0) return null;
          const text = dec.decode(this.buf.subarray(0, end));
          this.buf = this.buf.subarray(end + 4);
          const [statusLine, ...lines] = text.split('\r\n');
          const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(statusLine);
          const status = m ? Number(m[1]) : 502;
          const headers: [string, string][] = [];
          for (const l of lines) {
            const i = l.indexOf(':');
            if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
          }
          const get = (n: string) => headers.find(([k]) => k.toLowerCase() === n)?.[1];
          if (status === 101) {
            this.responder.wsOpen?.(get('sec-websocket-protocol') ?? null, headers);
            this.state = 'end';
            this.done = true;
            this.onUpgrade();
            return this.buf.length ? this.buf : null;
          }
          if (status >= 100 && status < 200) continue;
          this.responder.head(status, m?.[2] ?? '', headers.filter(([k]) => !/^(transfer-encoding|connection|keep-alive)$/i.test(k)));
          const te = get('transfer-encoding');
          const cl = get('content-length');
          if (te && /chunked/i.test(te)) this.state = 'chunk-size';
          else if (cl !== undefined) {
            this.remaining = Number(cl);
            this.state = this.remaining > 0 ? 'length' : 'end';
          } else if (status === 204 || status === 304) this.state = 'end';
          else this.state = 'close';
          if (this.state === 'end') this.finishOk();
          break;
        }
        case 'length': {
          if (!this.buf.length) return null;
          const n = Math.min(this.remaining, this.buf.length);
          this.responder.data(this.buf.slice(0, n));
          this.buf = this.buf.subarray(n);
          this.remaining -= n;
          if (this.remaining === 0) {
            this.state = 'end';
            this.finishOk();
          }
          break;
        }
        case 'chunk-size': {
          const end = indexOf(this.buf, '\r\n');
          if (end < 0) return null;
          const size = parseInt(dec.decode(this.buf.subarray(0, end)).split(';')[0], 16);
          this.buf = this.buf.subarray(end + 2);
          if (!size) this.state = 'trailers';
          else {
            this.remaining = size;
            this.state = 'chunk-data';
          }
          break;
        }
        case 'chunk-data': {
          if (!this.buf.length) return null;
          const n = Math.min(this.remaining, this.buf.length);
          this.responder.data(this.buf.slice(0, n));
          this.buf = this.buf.subarray(n);
          this.remaining -= n;
          if (this.remaining === 0) this.state = 'chunk-crlf';
          break;
        }
        case 'chunk-crlf':
          if (this.buf.length < 2) return null;
          this.buf = this.buf.subarray(2);
          this.state = 'chunk-size';
          break;
        case 'trailers': {
          const end = indexOf(this.buf, '\r\n');
          if (end < 0) return null;
          this.buf = this.buf.subarray(end + 2);
          if (end === 0) {
            this.state = 'end';
            this.finishOk();
          }
          break;
        }
        case 'close':
          if (this.buf.length) this.responder.data(this.buf.slice());
          this.buf = new Uint8Array(0);
          return null;
        case 'end':
          return null;
      }
    }
  }

  private finishOk() {
    if (this.done) return;
    this.done = true;
    this.responder.end();
  }

  /** The connection closed. */
  finish() {
    if (this.done) return;
    if (this.state === 'close') this.finishOk();
    else {
      this.done = true;
      this.responder.error(this.state === 'head' ? 'socket hang up' : 'incomplete response');
    }
  }
}

function indexOf(b: Uint8Array, s: string): number {
  const n = s.length;
  outer: for (let i = 0; i + n <= b.length; i++) {
    for (let j = 0; j < n; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
