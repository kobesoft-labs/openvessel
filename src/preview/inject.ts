// Injected into preview pages: routes same-host WebSockets (e.g. Vite HMR)
// through the preview service worker to the virtual server.

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

  const isLocal = (u: URL) => u.host === location.host || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';

  class TunneledWebSocket extends EventTarget {
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
    bufferedAmount = 0;
    binaryType: BinaryType = 'blob';
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private port: MessagePort;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const u = new URL(String(url), location.href);
      this.url = u.href;
      const ch = new MessageChannel();
      this.port = ch.port1;
      this.port.onmessage = (e) => this.onPort(e.data);
      const ctrl = navigator.serviceWorker?.controller;
      const vport = u.hostname === location.hostname ? 0 : Number(u.port) || 0;
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      if (!ctrl) {
        setTimeout(() => this.finish(1006, 'no service worker'), 0);
        return;
      }
      ctrl.postMessage({ t: 'ws-connect', port: ch.port2, path: u.pathname + u.search, protocols: list, vport, origin: location.origin }, [ch.port2]);
    }

    private fire(type: string, ev: Event) {
      const h = (this as any)['on' + type];
      if (typeof h === 'function') h.call(this, ev);
      this.dispatchEvent(ev);
    }

    private onPort(m: any) {
      if (m.t === 'open') {
        this.readyState = 1;
        this.protocol = m.protocol ?? '';
        this.fire('open', new Event('open'));
      } else if (m.t === 'msg') {
        let data: any = m.data;
        if (m.binary) data = this.binaryType === 'arraybuffer' ? (m.data as Uint8Array).slice().buffer : new Blob([m.data]);
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
      this.port.close();
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      if (typeof data === 'string') this.port.postMessage({ t: 'send', data, binary: false });
      else if (data instanceof Blob) data.arrayBuffer().then((b) => this.port.postMessage({ t: 'send', data: new Uint8Array(b), binary: true }));
      else if (ArrayBuffer.isView(data)) this.port.postMessage({ t: 'send', data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), binary: true });
      else this.port.postMessage({ t: 'send', data: new Uint8Array(data as ArrayBuffer).slice(), binary: true });
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
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
    if (isLocal(u)) return new TunneledWebSocket(u, protocols);
    return new Native(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, __openvessel: true });
  (Patched as any).prototype = Native.prototype;
  window.WebSocket = Patched;
})();

export {};
