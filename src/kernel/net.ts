// Virtual ports: routes HTTP requests and WebSocket sessions to the process that listens.

import type { Kernel } from './kernel.ts';
import type { Proc } from './proc.ts';
import { TcpBridge } from './tcp.ts';

export interface HttpResponder {
  head(status: number, statusText: string, headers: [string, string][]): void;
  data(chunk: Uint8Array): void;
  end(): void;
  error(msg: string): void;
  // websocket
  wsOpen?(protocol: string | null, headers: [string, string][]): void;
  wsMessage?(data: Uint8Array | string, binary: boolean): void;
  wsClose?(code: number, reason: string): void;
}

export interface HttpRequestInit {
  method: string;
  url: string;
  headers: [string, string][];
  hasBody: boolean;
  upgrade?: boolean;
}

interface Pending {
  proc: Proc;
  tid: number;
  responder: HttpResponder;
  port: number;
}

export class NetRouter {
  private nextRid = 1;
  private pending = new Map<number, Pending>();

  readonly tcp: TcpBridge;

  constructor(private kernel: Kernel) {
    this.tcp = new TcpBridge(kernel);
  }

  /** Starts a request; returns a handle to stream the body / ws messages, or null if nobody listens. */
  request(port: number, init: HttpRequestInit, responder: HttpResponder) {
    const rec = this.kernel.ports.get(port);
    // listeners of the ported Node take byte streams
    if (rec?.host === 'raw') return this.tcp.request(rec, init, responder);
    const proc = rec ? this.kernel.procs.get(rec.pid) : undefined;
    if (!rec || !proc || proc.state !== 'running' || rec.host === 'tcp-only') {
      responder.error(`connect ECONNREFUSED 127.0.0.1:${port}`);
      return null;
    }
    const rid = this.nextRid++;
    this.pending.set(rid, { proc, tid: rec.tid, responder, port });
    const thread = proc.threads.get(rec.tid) ?? proc.threads.values().next().value;
    const post = (m: unknown, t: Transferable[] = []) => thread?.worker.postMessage(m, t);
    post({ t: 'http-req', rid, port, method: init.method, url: init.url, headers: init.headers, hasBody: init.hasBody, upgrade: init.upgrade });
    const onExit = () => {
      if (this.pending.has(rid)) {
        this.pending.delete(rid);
        responder.error('server process exited');
      }
    };
    proc.onExit.add(onExit);
    return {
      rid,
      body: (d: Uint8Array) => post({ t: 'http-body', rid, data: d }),
      bodyEnd: () => post({ t: 'http-body-end', rid }),
      abort: () => {
        this.pending.delete(rid);
        proc.onExit.delete(onExit);
        post({ t: 'http-abort', rid });
      },
      wsSend: (data: Uint8Array | string, binary: boolean) => post({ t: 'ws-msg', rid, data, binary }),
      wsClose: (code: number, reason: string) => post({ t: 'ws-close', rid, code, reason }),
      done: () => proc.onExit.delete(onExit),
    };
  }

  /** Messages from the server process about a request. Returns true if handled. */
  fromProcess(msg: any): boolean {
    const p = this.pending.get(msg.rid);
    switch (msg.t) {
      case 'http-res':
        p?.responder.head(msg.status, msg.statusText, msg.headers);
        return true;
      case 'http-res-data':
        p?.responder.data(msg.data);
        return true;
      case 'http-res-end':
        if (p) {
          this.pending.delete(msg.rid);
          p.responder.end();
        }
        return true;
      case 'http-res-error':
        if (p) {
          this.pending.delete(msg.rid);
          p.responder.error(msg.msg);
        }
        return true;
      case 'ws-open':
        p?.responder.wsOpen?.(msg.protocol, msg.headers);
        return true;
      case 'ws-send':
        p?.responder.wsMessage?.(msg.data, msg.binary);
        return true;
      case 'ws-close':
        if (p) {
          this.pending.delete(msg.rid);
          p.responder.wsClose?.(msg.code, msg.reason);
        }
        return true;
    }
    return false;
  }
}
