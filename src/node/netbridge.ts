// Message plumbing between node's http/net modules and the kernel's virtual ports.

import { post } from './sys.ts';

export type HttpReqMsg = { t: 'http-req'; rid: number; port: number; method: string; url: string; headers: [string, string][]; hasBody: boolean; upgrade?: boolean; remote?: string };

type Listener = {
  onRequest(msg: HttpReqMsg): void;
};

const listeners = new Map<number, Listener>();
const reqBodies = new Map<number, { onData(d: Uint8Array): void; onEnd(): void; onAbort?(): void }>();
const wsSessions = new Map<number, { onMessage(d: Uint8Array | string, binary: boolean): void; onClose(code: number, reason: string): void }>();

// client side (loopback requests made by this process)
const clientReqs = new Map<number, { onHead(status: number, statusText: string, headers: [string, string][]): void; onData(d: Uint8Array): void; onEnd(): void; onError(msg: string): void }>();
let nextClientRid = 1;

export function registerListener(port: number, l: Listener) {
  listeners.set(port, l);
}
export function unregisterListener(port: number) {
  listeners.delete(port);
}

export function onReqBody(rid: number, h: { onData(d: Uint8Array): void; onEnd(): void; onAbort?(): void }) {
  reqBodies.set(rid, h);
}

export function onWs(rid: number, h: { onMessage(d: Uint8Array | string, binary: boolean): void; onClose(code: number, reason: string): void }) {
  wsSessions.set(rid, h);
}

export function sendResponseHead(rid: number, status: number, statusText: string, headers: [string, string][]) {
  post({ t: 'http-res', rid, status, statusText, headers });
}
export function sendResponseData(rid: number, data: Uint8Array) {
  if (data.length) post({ t: 'http-res-data', rid, data }, []);
}
export function sendResponseEnd(rid: number) {
  post({ t: 'http-res-end', rid });
}
export function sendResponseError(rid: number, msg: string) {
  post({ t: 'http-res-error', rid, msg });
}
export function wsAccept(rid: number, protocol: string | null, headers: [string, string][]) {
  post({ t: 'ws-open', rid, protocol, headers });
}
export function wsSend(rid: number, data: Uint8Array | string, binary: boolean) {
  post({ t: 'ws-send', rid, data, binary });
}
export function wsClose(rid: number, code: number, reason: string) {
  wsSessions.delete(rid);
  post({ t: 'ws-close', rid, code, reason });
}

/** Starts a loopback HTTP request to a virtual port owned by some process. */
export function loopbackRequest(
  port: number,
  method: string,
  url: string,
  headers: [string, string][],
  h: { onHead(status: number, statusText: string, headers: [string, string][]): void; onData(d: Uint8Array): void; onEnd(): void; onError(msg: string): void },
) {
  const crid = nextClientRid++;
  clientReqs.set(crid, h);
  post({ t: 'loop-req', crid, port, method, url, headers });
  return {
    write(d: Uint8Array) {
      post({ t: 'loop-body', crid, data: d });
    },
    end() {
      post({ t: 'loop-body-end', crid });
    },
    abort() {
      clientReqs.delete(crid);
      post({ t: 'loop-abort', crid });
    },
  };
}

/** Dispatches kernel → process network messages. Returns true if handled. */
export function onNetMessage(msg: any): boolean {
  switch (msg.t) {
    case 'http-req': {
      const l = listeners.get(msg.port);
      if (!l) {
        sendResponseHead(msg.rid, 503, 'Service Unavailable', [['content-type', 'text/plain']]);
        sendResponseData(msg.rid, new TextEncoder().encode('no server'));
        sendResponseEnd(msg.rid);
        return true;
      }
      l.onRequest(msg);
      return true;
    }
    case 'http-body':
      reqBodies.get(msg.rid)?.onData(msg.data);
      return true;
    case 'http-body-end': {
      const b = reqBodies.get(msg.rid);
      reqBodies.delete(msg.rid);
      b?.onEnd();
      return true;
    }
    case 'http-abort': {
      const b = reqBodies.get(msg.rid);
      reqBodies.delete(msg.rid);
      b?.onAbort?.();
      const w = wsSessions.get(msg.rid);
      wsSessions.delete(msg.rid);
      w?.onClose(1006, '');
      return true;
    }
    case 'ws-msg':
      wsSessions.get(msg.rid)?.onMessage(msg.data, msg.binary);
      return true;
    case 'ws-close': {
      const w = wsSessions.get(msg.rid);
      wsSessions.delete(msg.rid);
      w?.onClose(msg.code ?? 1005, msg.reason ?? '');
      return true;
    }
    case 'loop-res':
      clientReqs.get(msg.crid)?.onHead(msg.status, msg.statusText, msg.headers);
      return true;
    case 'loop-res-data':
      clientReqs.get(msg.crid)?.onData(msg.data);
      return true;
    case 'loop-res-end': {
      const c = clientReqs.get(msg.crid);
      clientReqs.delete(msg.crid);
      c?.onEnd();
      return true;
    }
    case 'loop-res-error': {
      const c = clientReqs.get(msg.crid);
      clientReqs.delete(msg.crid);
      c?.onError(msg.msg);
      return true;
    }
  }
  return false;
}
