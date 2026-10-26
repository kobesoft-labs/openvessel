// Injected into preview pages: routes local WebSockets (e.g. Vite HMR) through the preview service
// worker to the virtual server, and lets other WebSockets connect only when the network policy allows.

import { isLoopbackHost } from '../shared/policy.ts';

(() => {
  // served under a path (e.g. /demo/preview/): root-relative fetches go under it too
  const scope = new URL('../', (document.currentScript as HTMLScriptElement | null)?.src ?? location.href).pathname;
  if (scope !== '/' && !(window.fetch as any).__openvessel) {
    const fix = (u: string) => (u.startsWith('/') && !u.startsWith('//') && !u.startsWith(scope) ? scope + u.slice(1) : u);
    const nativeFetch = window.fetch.bind(window);
    const patched = (input: RequestInfo | URL, init?: RequestInit) => nativeFetch(typeof input === 'string' ? fix(input) : input, init);
    (patched as any).__openvessel = true;
    window.fetch = patched as typeof fetch;
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
      return (open as any).call(this, method, typeof url === 'string' ? fix(url) : url, ...rest);
    } as typeof open;
  }

  const Native = window.WebSocket;
  if ((Native as any).__openvessel) return;

  const isLocal = (u: URL) => u.host === location.host || isLoopbackHost(u.hostname);

  /**
   * The page's WebSocket. Local URLs are tunnelled over a MessagePort to the service worker; other URLs
   * are a browser WebSocket opened once the service worker says the network policy allows the host.
   */
  class OvWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    url: string;
    protocol = '';
    extensions = '';
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private port: MessagePort | null = null;
    private native: WebSocket | null = null;
    private type: BinaryType = 'blob';

    constructor(u: URL, protocols: string | string[] | undefined, tunnel: boolean) {
      super();
      this.url = u.href;
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      const ctrl = navigator.serviceWorker?.controller;
      if (!ctrl) {
        setTimeout(() => this.finish(1006, 'no service worker'), 0);
        return;
      }
      const ch = new MessageChannel();
      if (tunnel) {
        this.port = ch.port1;
        this.port.onmessage = (e) => this.onPort(e.data);
        // an explicit port of a loopback URL names the server (a dev server's own HMR port); else the page's
        const vport = u.host === location.host ? 0 : Number(u.port) || 0;
        ctrl.postMessage({ t: 'ws-connect', port: ch.port2, path: u.pathname + u.search, protocols: list, vport, origin: location.origin }, [ch.port2]);
        return;
      }
      ch.port1.onmessage = (e) => {
        ch.port1.close();
        if (this.readyState !== 0) {
          // closed while waiting for the answer
          this.finish(1006, '');
        } else if (!e.data?.allow) {
          this.finish(1006, 'blocked by OpenVessel network policy');
        } else {
          this.connectNative(list);
        }
      };
      ctrl.postMessage({ t: 'ws-check', url: this.url, port: ch.port2 }, [ch.port2]);
    }

    get binaryType(): BinaryType {
      return this.type;
    }
    set binaryType(v: BinaryType) {
      if (v !== 'blob' && v !== 'arraybuffer') return;
      this.type = v;
      if (this.native) this.native.binaryType = v;
    }
    get bufferedAmount(): number {
      return this.native?.bufferedAmount ?? 0;
    }

    private connectNative(protocols: string[]) {
      let ws: WebSocket;
      try {
        ws = new Native(this.url, protocols);
      } catch {
        this.finish(1006, '');
        return;
      }
      this.native = ws;
      ws.binaryType = this.type;
      ws.onopen = () => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.protocol = ws.protocol;
        this.extensions = ws.extensions;
        this.fire('open', new Event('open'));
      };
      ws.onmessage = (e) => this.fire('message', new MessageEvent('message', { data: e.data, origin: e.origin }));
      ws.onerror = () => this.fire('error', new Event('error'));
      ws.onclose = (e) => {
        this.readyState = 3;
        this.fire('close', new CloseEvent('close', { code: e.code, reason: e.reason, wasClean: e.wasClean }));
      };
    }

    private fire(type: string, ev: Event) {
      const h = (this as any)['on' + type];
      if (typeof h === 'function') h.call(this, ev);
      this.dispatchEvent(ev);
    }

    private onPort(m: any) {
      if (m.t === 'open') {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.protocol = m.protocol ?? '';
        this.fire('open', new Event('open'));
      } else if (m.t === 'msg') {
        let data: any = m.data;
        if (m.binary) data = this.type === 'arraybuffer' ? (m.data as Uint8Array).slice().buffer : new Blob([m.data]);
        this.fire('message', new MessageEvent('message', { data, origin: new URL(this.url).origin }));
      } else if (m.t === 'close') {
        this.finish(m.code ?? 1005, m.reason ?? '');
      }
    }

    private finish(code: number, reason: string) {
      if (this.readyState === 3) return;
      const wasOpen = this.readyState === 1;
      this.readyState = 3;
      if (!wasOpen || code === 1006) this.fire('error', new Event('error'));
      this.fire('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
      this.port?.close();
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === 0) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      if (this.readyState !== 1) return;
      if (this.native) return this.native.send(data as any);
      const port = this.port!;
      if (typeof data === 'string') port.postMessage({ t: 'send', data, binary: false });
      else if (data instanceof Blob) data.arrayBuffer().then((b) => port.postMessage({ t: 'send', data: new Uint8Array(b), binary: true }));
      else if (ArrayBuffer.isView(data)) port.postMessage({ t: 'send', data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), binary: true });
      else port.postMessage({ t: 'send', data: new Uint8Array(data as ArrayBuffer).slice(), binary: true });
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      if (this.native) {
        this.readyState = 2;
        this.native.close(code, reason);
        return;
      }
      if (!this.port) {
        // still waiting for the policy: the answer ends it
        this.readyState = 2;
        return;
      }
      this.readyState = 2;
      this.port.postMessage({ t: 'close', code, reason });
      setTimeout(() => this.finish(code, reason), 0);
    }
  }

  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    let u: URL;
    try {
      u = new URL(String(url), location.href);
    } catch {
      return new Native(url, protocols);
    }
    // what the browser's WebSocket refuses (other schemes, fragments) it refuses with its own error
    if (!/^(wss?|https?):$/.test(u.protocol) || u.hash) return new Native(url, protocols);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol === 'https:') u.protocol = 'wss:';
    return new OvWebSocket(u, protocols, isLocal(u));
  } as unknown as typeof WebSocket;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, __openvessel: true });
  (Patched as any).prototype = Native.prototype;
  // `ws instanceof WebSocket` holds for these sockets too
  Object.defineProperty(Patched, Symbol.hasInstance, { value: (o: unknown) => o instanceof OvWebSocket || o instanceof Native });
  window.WebSocket = Patched;
})();

export {};
