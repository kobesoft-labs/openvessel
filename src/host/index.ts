// OpenVessel host API: embed the runtime, drive processes, show previews.

import type { NetworkPolicy } from '../shared/policy.ts';
import { directoryUrl } from './url.ts';
export type { NetworkPolicy } from '../shared/policy.ts';
export { PRESETS } from '../shared/policy.ts';

export interface BootOptions {
  /**
   * Base URL of the deployed runtime files (a separate origin), e.g. https://rt.example.com/, or the
   * runtime.html URL itself. A last segment without an extension is a directory.
   */
  runtimeUrl: string;
  /** Base URL of the deployed preview files (another origin), e.g. https://pv.example.com/. A last segment without an extension is a directory. */
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

/** Payload of the 'error' event. */
export interface RuntimeErrorEvent {
  /** `OpenVessel: <message>`, as an Error. */
  error: Error;
  message: string;
  /** The kernel is gone: waiting and later calls reject, and running processes have ended. */
  fatal: boolean;
}

type Listener = (ev: any) => void;

/** A process started with {@link OpenVessel.spawn}. */
export class Process {
  readonly output: ReadableStream<string>;
  readonly exit: Promise<number>;
  private ctrl!: ReadableStreamDefaultController<string>;
  private dec = new TextDecoder();
  private resolveExit!: (c: number) => void;
  private text = '';
  constructor(private vessel: OpenVessel, readonly pid: number, private terminal = false) {
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
    // an incomplete UTF-8 sequence at the end becomes U+FFFD instead of being lost
    const tail = this.dec.decode();
    if (tail) {
      this.text += tail;
      try {
        this.ctrl.enqueue(tail);
      } catch {}
    }
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
  /**
   * Ends the input. A pipe process's stdin is closed; on a terminal this sends the EOF character
   * (^D) through the line discipline, like pressing Ctrl+D.
   */
  end() {
    return this.vessel._call('input', { pid: this.pid, data: this.terminal ? '\x04' : null });
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
  private procs = new Map<number, Process>();
  private earlyOutput = new Map<number, { data: Uint8Array[]; exit?: number }>();
  private runtimeFrame!: HTMLIFrameElement;
  /** Listens to the runtime frame, during boot and after it. */
  private runtimeListener: ((ev: MessageEvent) => void) | null = null;
  /** Set once the kernel is gone (teardown, a reloaded runtime frame, a kernel that stopped answering). */
  private dead: Error | null = null;
  private probing = false;
  private relayFrame: HTMLIFrameElement | null = null;
  private relayListener: ((ev: MessageEvent) => void) | null = null;
  private relayReady: Promise<void> | null = null;
  private relayUp = false;
  /** The port the relay sends unattributed requests to (the latest previewUrl() call). */
  private relayDefaultPort = 0;
  private relayErrorShown: unknown = null;
  /** server-ready / port-closed events still waiting for the relay, in order. */
  private portEvents: Promise<void> | null = null;
  private previewOrigin: string | null = null;
  /** The preview's base URL with a trailing slash (it may be served under a path). */
  private previewBase = '';
  private opts!: BootOptions;
  private servers = new Map<number, { port: number; pid: number }>();
  private watchId = 1;
  private watchers = new Map<number, (ev: { type: string; path: string }) => void>();
  /** Closes the built-in dialog (shown or queued) of a permission request. */
  private dialogs = new Map<number, () => void>();

  static async boot(opts: BootOptions): Promise<OpenVessel> {
    const v = new OpenVessel();
    await v._boot(opts);
    return v;
  }

  private async _boot(opts: BootOptions) {
    this.opts = opts;
    if (!crossOriginIsolated) throw new Error('OpenVessel: the host page must be cross-origin isolated (COOP: same-origin, COEP: require-corp or credentialless).');
    const base = directoryUrl(opts.runtimeUrl, location.href);
    const runtimeOrigin = base.origin;
    if (runtimeOrigin === location.origin) console.warn('OpenVessel: the runtime should be served from its own origin');
    if (opts.previewUrl) {
      const u = directoryUrl(opts.previewUrl, location.href);
      this.previewOrigin = u.origin;
      this.previewBase = u.href;
    }
    const frame = document.createElement('iframe');
    frame.src = new URL('runtime.html', base).href;
    frame.allow = 'cross-origin-isolated';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    this.runtimeFrame = frame;
    let booted = false;
    const ready = new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('OpenVessel: runtime did not start in time')), opts.timeout ?? 30000);
      this.runtimeListener = (ev: MessageEvent) => {
        if (ev.origin !== runtimeOrigin || ev.source !== frame.contentWindow) return;
        const d = ev.data;
        if (d?.t === 'openvessel-runtime-loaded') {
          if (this.port) {
            // the frame loaded again (reloaded, or moved in the document): its kernel is gone
            const e = new Error('OpenVessel: the runtime frame was reloaded; the kernel is gone');
            if (booted) this.lost(e);
            else fail(e);
            return;
          }
          const ch = new MessageChannel();
          this.port = ch.port1;
          this.port.onmessage = (e) =>
            this.onMessage(e.data, () => {
              booted = true;
              clearTimeout(timer);
              resolve();
            });
          frame.contentWindow!.postMessage({ t: 'openvessel-connect', port: ch.port2, init: { policy: opts.network } }, runtimeOrigin, [ch.port2]);
        } else if (d?.t === 'openvessel-error') {
          const e = new Error(`OpenVessel: ${d.message}`);
          if (booted) this.runtimeError(e);
          else fail(e);
        }
      };
      window.addEventListener('message', this.runtimeListener);
    });
    document.body.appendChild(frame);
    try {
      await ready;
      if (opts.network) await this._call('network.setPolicy', { policy: opts.network });
    } catch (e) {
      this.shutdown(e as Error);
      throw e;
    }
  }

  /** @internal */
  _call(m: string, a: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.port.postMessage({ id, m, a }, transfer);
    });
  }

  /** An error the runtime frame reported after boot. */
  private runtimeError(e: Error) {
    this.reportError(e, false);
    // a worker survives an uncaught error: the kernel is gone only if it no longer answers
    if (this.probing || this.dead) return;
    this.probing = true;
    const timer = setTimeout(() => this.lost(e), 10000);
    this._call('ports')
      .then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      )
      .finally(() => (this.probing = false));
  }

  /** The kernel is gone: everything ends, and listeners hear a fatal 'error'. */
  private lost(e: Error) {
    if (this.dead) return;
    this.shutdown(e);
    this.reportError(e, true);
  }

  private reportError(error: Error, fatal: boolean) {
    if (!this.listeners.get('error')?.size) console.error(error);
    this.emit('error', { error, message: error.message, fatal } satisfies RuntimeErrorEvent);
  }

  /** Ends the instance: frames and listeners removed, waiting calls rejected, processes ended. */
  private shutdown(err: Error) {
    if (this.dead) return;
    this.dead = err;
    if (this.runtimeListener) window.removeEventListener('message', this.runtimeListener);
    if (this.relayListener) window.removeEventListener('message', this.relayListener);
    this.runtimeListener = this.relayListener = null;
    this.runtimeFrame?.remove();
    this.relayFrame?.remove();
    this.port?.close();
    const calls = [...this.calls.values()];
    this.calls.clear();
    for (const c of calls) c.reject(err);
    for (const close of [...this.dialogs.values()]) close();
    this.watchers.clear();
    this.earlyOutput.clear();
    // the processes went with the kernel: end them as if killed
    const procs = [...this.procs.values()];
    this.procs.clear();
    for (const p of procs) {
      p._exit(137);
      this.emit('process-exit', { pid: p.pid, code: 137, signal: 'SIGKILL' });
    }
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
      case 'server-ready': {
        this.servers.set(msg.port, { port: msg.port, pid: msg.pid });
        const ev = { port: msg.port, pid: msg.pid, url: this.previewOrigin ? this.previewUrlFor(msg.port) : null };
        // the URL works once the preview relay is up: start it and hold the event until it is up
        // (or has failed — then the event still goes out, and the next previewUrl() tries again)
        let wait: Promise<unknown> | null = null;
        if (this.previewOrigin && !this.relayUp) {
          wait = this.startRelay(msg.port).catch((e) => {
            if (this.relayErrorShown === e) return;
            this.relayErrorShown = e;
            this.reportError(e, false);
          });
        }
        this.portEvent(wait, 'server-ready', ev);
        return;
      }
      case 'port-closed':
        this.servers.delete(msg.port);
        this.portEvent(null, 'port-closed', { port: msg.port });
        return;
      case 'fs-change':
        this.watchers.get(msg.id)?.({ type: msg.type, path: msg.path });
        return;
      case 'permission-request':
        this.handlePermission(msg as PermissionRequest);
        return;
      case 'permission-settled':
        // decided without the dialog (the kernel's timeout): its answer would no longer count
        this.dialogs.get(msg.id)?.();
        this.emit('permission-settled', msg);
        return;
    }
  }

  /** Emits server-ready / port-closed in the order they came, after `wait`. */
  private portEvent(wait: Promise<unknown> | null, event: string, ev: unknown) {
    if (!wait && !this.portEvents) return this.emit(event, ev);
    const p: Promise<void> = (this.portEvents ?? Promise.resolve())
      .then(() => wait)
      .then(() => {
        if (this.portEvents === p) this.portEvents = null;
        if (!this.dead) this.emit(event, ev);
      });
    this.portEvents = p;
  }

  private async handlePermission(req: PermissionRequest) {
    this.emit('permission-request', req);
    let decision: PermissionDecision | null;
    try {
      if (this.opts.onPermissionRequest) decision = await this.opts.onPermissionRequest(req);
      else {
        const dlg = builtinDialog(req, this.opts.locale ?? (navigator.language.startsWith('ja') ? 'ja' : 'en'));
        this.dialogs.set(req.id, dlg.close);
        try {
          decision = await dlg.decision;
        } finally {
          this.dialogs.delete(req.id);
        }
      }
    } catch {
      decision = 'deny';
    }
    // null: the dialog was closed because the request was settled or the instance ended
    if (decision === null || this.dead) return;
    await this._call('permission.respond', { id: req.id, decision }).catch(() => {});
  }

  on(event: 'error', fn: (ev: RuntimeErrorEvent) => void): () => void;
  on(event: 'server-ready' | 'port-closed' | 'permission-request' | 'permission-settled' | 'process-exit' | 'error', fn: Listener): () => void;
  on(event: string, fn: Listener): () => void {
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
      try {
        await this._call('watch', { path, id });
      } catch (e) {
        this.watchers.delete(id);
        throw e;
      }
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

  async spawn(command: string, args: string[] = [], opts: SpawnOptions = {}): Promise<Process> {
    const { pid } = await this._call('spawn', { argv: [command, ...args], cwd: opts.cwd, env: opts.env, terminal: opts.terminal });
    const p = new Process(this, pid, !!opts.terminal);
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

  /** Starts the preview relay if it isn't running or starting; resolves when it is up. */
  private startRelay(defaultPort: number): Promise<void> {
    if (!this.opts.previewUrl) return Promise.reject(new Error('OpenVessel: previewUrl was not configured'));
    if (this.dead) return Promise.reject(this.dead);
    if (this.relayReady) return this.relayReady;
    this.relayDefaultPort = defaultPort;
    const origin = this.previewOrigin!;
    const frame = document.createElement('iframe');
    frame.src = new URL('__ov/relay.html', this.previewBase).href;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    this.relayFrame = frame;
    let sentPort = 0;
    const connect = () => {
      const ch = new MessageChannel();
      sentPort = this.relayDefaultPort;
      this.port.postMessage({ t: 'preview-port', port: ch.port1 }, [ch.port1]);
      frame.contentWindow!.postMessage({ t: 'openvessel-preview-connect', port: ch.port2, defaultPort: sentPort }, origin, [ch.port2]);
    };
    const listener = (ev: MessageEvent) => {
      if (ev.origin !== origin || ev.source !== frame.contentWindow) return;
      if (ev.data?.t === 'openvessel-preview-loaded') connect();
      else if (ev.data?.t === 'openvessel-preview-ready') {
        clearTimeout(timer);
        this.relayUp = true;
        // previewUrl() called for another port while the relay was starting
        if (this.relayDefaultPort !== sentPort) frame.contentWindow?.postMessage({ t: 'openvessel-preview-default-port', port: this.relayDefaultPort }, origin);
        resolve();
      } else if (ev.data?.t === 'openvessel-preview-need-port') connect();
    };
    let resolve!: () => void;
    let timer!: ReturnType<typeof setTimeout>;
    const ready = new Promise<void>((res, rej) => {
      resolve = res;
      timer = setTimeout(() => rej(new Error('OpenVessel: preview relay did not start')), 20000);
    });
    this.relayListener = listener;
    window.addEventListener('message', listener);
    const p = ready.catch((e) => {
      // forget the failed start: the next previewUrl() / createPreview() starts it again
      if (this.relayReady === p) {
        window.removeEventListener('message', listener);
        if (this.relayListener === listener) this.relayListener = null;
        frame.remove();
        if (this.relayFrame === frame) this.relayFrame = null;
        this.relayReady = null;
      }
      throw e;
    });
    this.relayReady = p;
    document.body.appendChild(frame);
    return p;
  }

  /** Starts the relay if needed and makes `defaultPort` its default port. */
  private ensureRelay(defaultPort: number): Promise<void> {
    if (!this.relayReady || this.dead) return this.startRelay(defaultPort);
    this.relayDefaultPort = defaultPort;
    if (this.relayUp) this.relayFrame?.contentWindow?.postMessage({ t: 'openvessel-preview-default-port', port: defaultPort }, this.previewOrigin!);
    return this.relayReady;
  }

  private previewUrlFor(port: number, path = '/') {
    return `${this.previewBase}__ov/open?port=${port}&path=${encodeURIComponent(path)}`;
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

  /**
   * Removes the runtime and relay frames (the kernel and its processes end with them). Waiting calls
   * reject, running processes' `exit` resolves with 137, and an open built-in dialog closes.
   */
  teardown() {
    this.shutdown(new Error('OpenVessel: the instance was torn down'));
    this.listeners.clear();
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

/** Shows the dialog (or queues it); `close()` takes it away unanswered, and `decision` resolves with null. */
function builtinDialog(req: PermissionRequest, locale: 'ja' | 'en'): { decision: Promise<PermissionDecision | null>; close: () => void } {
  let close!: () => void;
  const decision = new Promise<PermissionDecision | null>((resolve) => {
    let finished = false;
    let shown: HTMLDialogElement | null = null;
    const finish = (d: PermissionDecision | null) => {
      if (finished) return;
      finished = true;
      if (!shown) {
        const i = queue.indexOf(run);
        if (i >= 0) queue.splice(i, 1);
        resolve(d);
        return;
      }
      shown.close();
      shown.remove();
      showing = false;
      resolve(d);
      queue.shift()?.();
    };
    close = () => finish(null);
    const run = () => {
      showing = true;
      const t = TEXT[locale];
      const dlg = document.createElement('dialog');
      shown = dlg;
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
      const btn = (label: string, d: PermissionDecision, primary = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = `padding:6px 12px;border-radius:6px;border:1px solid ${primary ? '#2563eb' : '#bbb'};background:${primary ? '#2563eb' : '#fff'};color:${primary ? '#fff' : '#222'};cursor:pointer`;
        b.onclick = () => finish(d);
        return b;
      };
      row.append(btn(t.denyAll, 'deny-session'), btn(t.deny, 'deny'), btn(t.once, 'once'), btn(t.session, 'session', true));
      dlg.append(h, p, host, url, row);
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish('deny');
      });
      document.body.appendChild(dlg);
      dlg.showModal();
    };
    if (showing) queue.push(run);
    else run();
  });
  return { decision, close };
}

/** @deprecated Renamed to {@link Process}. */
export { Process as VesselProcess };

export default OpenVessel;
