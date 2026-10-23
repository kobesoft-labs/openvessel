// OpenVessel host API: embed the runtime, drive processes, show previews.

import type { NetworkPolicy } from '../shared/policy.ts';
export type { NetworkPolicy } from '../shared/policy.ts';
export { PRESETS } from '../shared/policy.ts';

export interface BootOptions {
  /** Base URL of the deployed runtime files (a separate origin), e.g. https://rt.example.com/ */
  runtimeUrl: string;
  /** Base URL of the deployed preview files (another origin), e.g. https://pv.example.com/ */
  previewUrl?: string;
  network?: Partial<NetworkPolicy>;
  /**
   * Called when a process or the preview wants to reach a host outside the policy.
   * Resolve with 'once' | 'session' | 'deny' | 'deny-session'. If omitted, a built-in dialog is shown.
   */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision;
  /** Language of the built-in dialog. */
  locale?: 'ja' | 'en';
  /** Milliseconds to wait for the runtime to come up. */
  timeout?: number;
}

export type PermissionDecision = 'once' | 'session' | 'deny' | 'deny-session';

export interface PermissionRequest {
  id: number;
  url: string;
  host: string;
  initiator: string;
  source: 'runtime' | 'preview';
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Run attached to a terminal (TTY) of this size. */
  terminal?: { cols: number; rows: number };
}

type Listener = (ev: any) => void;

export class VesselProcess {
  readonly output: ReadableStream<string>;
  readonly exit: Promise<number>;
  private ctrl!: ReadableStreamDefaultController<string>;
  private dec = new TextDecoder();
  private resolveExit!: (c: number) => void;
  private text = '';
  constructor(private vessel: OpenVessel, readonly pid: number) {
    this.output = new ReadableStream<string>({ start: (c) => (this.ctrl = c) });
    this.exit = new Promise((r) => (this.resolveExit = r));
  }
  /** @internal */
  _data(d: Uint8Array) {
    const s = this.dec.decode(d, { stream: true });
    this.text += s;
    if (this.text.length > 2_000_000) this.text = this.text.slice(-1_000_000);
    try {
      this.ctrl.enqueue(s);
    } catch {}
  }
  /** @internal */
  _exit(code: number) {
    try {
      this.ctrl.close();
    } catch {}
    this.resolveExit(code);
  }
  /** Everything written so far (bounded). */
  get collected() {
    return this.text;
  }
  write(data: string | Uint8Array) {
    return this.vessel._call('input', { pid: this.pid, data });
  }
  /** Closes stdin (non-terminal processes). */
  end() {
    return this.vessel._call('input', { pid: this.pid, data: null });
  }
  resize(cols: number, rows: number) {
    return this.vessel._call('resize', { pid: this.pid, cols, rows });
  }
  kill(signal = 'SIGTERM') {
    return this.vessel._call('kill', { pid: this.pid, signal });
  }
}

export class OpenVessel {
  private port!: MessagePort;
  private nextId = 1;
  private calls = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private procs = new Map<number, VesselProcess>();
  private earlyOutput = new Map<number, { data: Uint8Array[]; exit?: number }>();
  private runtimeFrame!: HTMLIFrameElement;
  private relayFrame: HTMLIFrameElement | null = null;
  private relayReady: Promise<void> | null = null;
  private previewOrigin: string | null = null;
  private opts!: BootOptions;
  private servers = new Map<number, { port: number; pid: number }>();
  private watchId = 1;
  private watchers = new Map<number, (ev: { type: string; path: string }) => void>();

  static async boot(opts: BootOptions): Promise<OpenVessel> {
    const v = new OpenVessel();
    await v._boot(opts);
    return v;
  }

  private async _boot(opts: BootOptions) {
    this.opts = opts;
    if (!crossOriginIsolated) throw new Error('OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).');
    const base = new URL(opts.runtimeUrl, location.href);
    const runtimeOrigin = base.origin;
    if (runtimeOrigin === location.origin) console.warn('OpenVessel: the runtime should be served from its own origin');
    const frame = document.createElement('iframe');
    frame.src = new URL('runtime.html', base).href;
    frame.allow = 'cross-origin-isolated';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    this.runtimeFrame = frame;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenVessel: runtime did not start in time')), opts.timeout ?? 30000);
      const onMsg = (ev: MessageEvent) => {
        if (ev.origin !== runtimeOrigin || ev.source !== frame.contentWindow) return;
        const d = ev.data;
        if (d?.t === 'openvessel-runtime-loaded') {
          const ch = new MessageChannel();
          this.port = ch.port1;
          this.port.onmessage = (e) => this.onMessage(e.data, () => {
            clearTimeout(timer);
            resolve();
          });
          frame.contentWindow!.postMessage({ t: 'openvessel-connect', port: ch.port2, init: { policy: opts.network } }, runtimeOrigin, [ch.port2]);
        } else if (d?.t === 'openvessel-error') {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          reject(new Error(`OpenVessel: ${d.message}`));
        }
      };
      window.addEventListener('message', onMsg);
    });
    document.body.appendChild(frame);
    await ready;
    if (opts.network) await this._call('network.setPolicy', { policy: opts.network });
    if (opts.previewUrl) this.previewOrigin = new URL(opts.previewUrl, location.href).origin;
  }

  /** @internal */
  _call(m: string, a: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.port.postMessage({ id, m, a }, transfer);
    });
  }

  private onMessage(msg: any, onReady: () => void) {
    if (msg?.id !== undefined && this.calls.has(msg.id)) {
      const c = this.calls.get(msg.id)!;
      this.calls.delete(msg.id);
      if (msg.e) c.reject(Object.assign(new Error(msg.e.message), { code: msg.e.code }));
      else c.resolve(msg.r);
      return;
    }
    switch (msg?.ev) {
      case 'ready':
        onReady();
        return;
      case 'output': {
        const p = this.procs.get(msg.pid);
        if (p) p._data(msg.data);
        else {
          let e = this.earlyOutput.get(msg.pid);
          if (!e) this.earlyOutput.set(msg.pid, (e = { data: [] }));
          e.data.push(msg.data);
        }
        return;
      }
      case 'exit': {
        const p = this.procs.get(msg.pid);
        if (p) {
          this.procs.delete(msg.pid);
          p._exit(msg.code);
        } else {
          const e = this.earlyOutput.get(msg.pid) ?? { data: [] };
          e.exit = msg.code;
          this.earlyOutput.set(msg.pid, e);
        }
        this.emit('process-exit', { pid: msg.pid, code: msg.code, signal: msg.signal });
        return;
      }
      case 'server-ready':
        this.servers.set(msg.port, { port: msg.port, pid: msg.pid });
        this.emit('server-ready', { port: msg.port, pid: msg.pid, url: this.previewOrigin ? this.previewUrlFor(msg.port) : null });
        return;
      case 'port-closed':
        this.servers.delete(msg.port);
        this.emit('port-closed', { port: msg.port });
        return;
      case 'fs-change':
        this.watchers.get(msg.id)?.({ type: msg.type, path: msg.path });
        return;
      case 'permission-request':
        this.handlePermission(msg as PermissionRequest);
        return;
      case 'permission-settled':
        this.emit('permission-settled', msg);
        return;
    }
  }

  private async handlePermission(req: PermissionRequest) {
    this.emit('permission-request', req);
    let decision: PermissionDecision;
    try {
      decision = this.opts.onPermissionRequest ? await this.opts.onPermissionRequest(req) : await builtinDialog(req, this.opts.locale ?? (navigator.language.startsWith('ja') ? 'ja' : 'en'));
    } catch {
      decision = 'deny';
    }
    await this._call('permission.respond', { id: req.id, decision });
  }

  on(event: 'server-ready' | 'port-closed' | 'permission-request' | 'permission-settled' | 'process-exit', fn: Listener): () => void {
    let s = this.listeners.get(event);
    if (!s) this.listeners.set(event, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  private emit(event: string, ev: unknown) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(ev);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // files

  fs = {
    readFile: (path: string, encoding?: 'utf8'): Promise<any> => this._call('fs.readFile', { path, encoding }),
    writeFile: (path: string, data: string | Uint8Array) => this._call('fs.writeFile', { path, data }),
    mkdir: (path: string, opts: { recursive?: boolean } = {}) => this._call('fs.mkdir', { path, recursive: opts.recursive ?? true }),
    readdir: (path: string, opts: { withFileTypes?: boolean } = {}) => this._call('fs.readdir', { path, withTypes: opts.withFileTypes }),
    rm: (path: string, opts: { recursive?: boolean; force?: boolean } = {}) => this._call('fs.rm', { path, ...opts }),
    stat: (path: string) => this._call('fs.stat', { path }),
    exists: (path: string): Promise<boolean> => this._call('fs.exists', { path }),
    rename: (from: string, to: string) => this._call('fs.rename', { from, to }),
    watch: async (path: string, fn: (ev: { type: string; path: string }) => void) => {
      const id = this.watchId++;
      this.watchers.set(id, fn);
      await this._call('watch', { path, id });
      return () => {
        this.watchers.delete(id);
        return this._call('unwatch', { id });
      };
    },
  };

  /** Writes many files at once: { "src/index.astro": "...", "public/a.png": Uint8Array }. */
  mount(files: Record<string, string | Uint8Array | null | { symlink: string }>, opts: { path?: string } = {}) {
    return this._call('mount', { files, path: opts.path ?? '/home/user/app' });
  }

  /** Reads a directory tree back as a flat map (node_modules and .git excluded by default). */
  export(path: string, opts: { exclude?: string[] } = {}): Promise<Record<string, Uint8Array>> {
    return this._call('export', { path, exclude: opts.exclude });
  }

  // ---------------------------------------------------------------------------
  // processes

  async spawn(command: string, args: string[] = [], opts: SpawnOptions = {}): Promise<VesselProcess> {
    const { pid } = await this._call('spawn', { argv: [command, ...args], cwd: opts.cwd, env: opts.env, terminal: opts.terminal });
    const p = new VesselProcess(this, pid);
    this.procs.set(pid, p);
    const early = this.earlyOutput.get(pid);
    if (early) {
      this.earlyOutput.delete(pid);
      for (const d of early.data) p._data(d);
      if (early.exit !== undefined) {
        this.procs.delete(pid);
        p._exit(early.exit);
      }
    }
    return p;
  }

  /** Runs a command line through /bin/sh and resolves with its output. */
  async exec(commandLine: string, opts: SpawnOptions = {}): Promise<{ code: number; output: string }> {
    const p = await this.spawn('/bin/sh', ['-c', commandLine], opts);
    const code = await p.exit;
    return { code, output: p.collected };
  }

  ps(): Promise<{ pid: number; ppid: number; argv: string[]; cwd: string }[]> {
    return this._call('ps');
  }

  ports(): Promise<{ port: number; pid: number }[]> {
    return this._call('ports');
  }

  // ---------------------------------------------------------------------------
  // network policy

  network = {
    setPolicy: (policy: Partial<NetworkPolicy>) => this._call('network.setPolicy', { policy }),
    getPolicy: (): Promise<NetworkPolicy> => this._call('network.getPolicy'),
    clearSession: () => this._call('network.clearSession'),
  };

  // ---------------------------------------------------------------------------
  // preview

  private ensureRelay(defaultPort: number): Promise<void> {
    if (!this.opts.previewUrl) return Promise.reject(new Error('OpenVessel: previewUrl was not configured'));
    if (this.relayReady) {
      this.relayFrame?.contentWindow?.postMessage({ t: 'openvessel-preview-default-port', port: defaultPort }, this.previewOrigin!);
      return this.relayReady;
    }
    const base = new URL(this.opts.previewUrl, location.href);
    const frame = document.createElement('iframe');
    frame.src = new URL('__ov/relay.html', base).href;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    this.relayFrame = frame;
    const origin = base.origin;
    const connect = () => {
      const ch = new MessageChannel();
      this.port.postMessage({ t: 'preview-port', port: ch.port1 }, [ch.port1]);
      frame.contentWindow!.postMessage({ t: 'openvessel-preview-connect', port: ch.port2, defaultPort }, origin, [ch.port2]);
    };
    this.relayReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenVessel: preview relay did not start')), 20000);
      window.addEventListener('message', (ev) => {
        if (ev.origin !== origin || ev.source !== frame.contentWindow) return;
        if (ev.data?.t === 'openvessel-preview-loaded') connect();
        else if (ev.data?.t === 'openvessel-preview-ready') {
          clearTimeout(timer);
          resolve();
        } else if (ev.data?.t === 'openvessel-preview-need-port') connect();
      });
    });
    document.body.appendChild(frame);
    return this.relayReady;
  }

  private previewUrlFor(port: number, path = '/') {
    return `${this.previewOrigin}/__ov/open?port=${port}&path=${encodeURIComponent(path)}`;
  }

  /** Returns a URL that shows `port` in an iframe (after the preview relay is ready). */
  async previewUrl(port: number, path = '/'): Promise<string> {
    await this.ensureRelay(port);
    return this.previewUrlFor(port, path);
  }

  /** Creates a sandboxed preview iframe for `port`. */
  async createPreview(port: number, opts: { path?: string; container?: HTMLElement } = {}): Promise<HTMLIFrameElement> {
    const url = await this.previewUrl(port, opts.path);
    const f = document.createElement('iframe');
    // no allow-top-navigation: the preview can't navigate the host away
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock');
    f.setAttribute('allow', 'clipboard-write; fullscreen');
    f.referrerPolicy = 'no-referrer';
    f.src = url;
    f.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
    opts.container?.appendChild(f);
    return f;
  }

  teardown() {
    this.runtimeFrame?.remove();
    this.relayFrame?.remove();
    this.port?.close();
  }
}

// -----------------------------------------------------------------------------
// built-in permission dialog

const TEXT = {
  ja: {
    title: '外部への接続の確認',
    body: (r: PermissionRequest) => `${r.source === 'preview' ? 'プレビューのページ' : r.initiator || 'プロセス'} が次のサイトへ接続しようとしています。`,
    once: '今回だけ許可',
    session: 'このセッション中は許可',
    deny: '拒否',
    denyAll: 'このセッション中は拒否',
  },
  en: {
    title: 'Allow network access?',
    body: (r: PermissionRequest) => `${r.source === 'preview' ? 'The preview page' : r.initiator || 'A process'} wants to connect to:`,
    once: 'Allow once',
    session: 'Allow for this session',
    deny: 'Deny',
    denyAll: 'Deny for this session',
  },
};

const queue: (() => void)[] = [];
let showing = false;

function builtinDialog(req: PermissionRequest, locale: 'ja' | 'en'): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    const run = () => {
      showing = true;
      const t = TEXT[locale];
      const dlg = document.createElement('dialog');
      dlg.style.cssText = 'max-width:440px;border:1px solid #ccc;border-radius:10px;padding:20px;font:14px/1.5 system-ui,sans-serif;color:#222;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.2)';
      const h = document.createElement('h3');
      h.textContent = t.title;
      h.style.margin = '0 0 8px';
      const p = document.createElement('p');
      p.textContent = t.body(req);
      p.style.margin = '0 0 8px';
      const host = document.createElement('code');
      host.textContent = req.host;
      host.style.cssText = 'display:block;padding:8px;background:#f4f4f4;border-radius:6px;word-break:break-all;margin-bottom:6px';
      const url = document.createElement('div');
      url.textContent = req.url.length > 120 ? req.url.slice(0, 117) + '…' : req.url;
      url.style.cssText = 'font-size:12px;color:#666;word-break:break-all;margin-bottom:14px';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end';
      const done = (d: PermissionDecision) => {
        dlg.close();
        dlg.remove();
        showing = false;
        resolve(d);
        queue.shift()?.();
      };
      const btn = (label: string, d: PermissionDecision, primary = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = `padding:6px 12px;border-radius:6px;border:1px solid ${primary ? '#2563eb' : '#bbb'};background:${primary ? '#2563eb' : '#fff'};color:${primary ? '#fff' : '#222'};cursor:pointer`;
        b.onclick = () => done(d);
        return b;
      };
      row.append(btn(t.denyAll, 'deny-session'), btn(t.deny, 'deny'), btn(t.once, 'once'), btn(t.session, 'session', true));
      dlg.append(h, p, host, url, row);
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        done('deny');
      });
      document.body.appendChild(dlg);
      dlg.showModal();
    };
    if (showing) queue.push(run);
    else run();
  });
}

export default OpenVessel;
