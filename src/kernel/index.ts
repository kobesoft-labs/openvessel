// Kernel worker entry. Talks to: the host (full control), the runtime service worker
// (module loading + network decisions) and preview relays (HTTP/WebSocket only).

import { type NetworkPolicy, decide, hostOf, isLoopbackHost, normalizePolicy } from '../shared/policy.ts';
import { RUNTIME_BASE } from './base.ts';
import { installCoreutils } from './coreutils.ts';
import { EsmService } from './esm.ts';
import { O_WRONLY, type OpenFile, createPipe } from './io.ts';
import { Kernel } from './kernel.ts';
import { NetRouter } from './net.ts';
import { installNpm, setNpmFetch } from './npm/cli.ts';
import { type FetchFn, proxiedFetch } from './npm/registry.ts';
import { exitCodeOf } from './proc.ts';
import { shProgram } from './sh/interp.ts';
import { installSyscalls } from './syscalls.ts';
import { installCurl } from './curl.ts';
import { isDir } from './vfs.ts';

declare const self: DedicatedWorkerGlobalScope;

const enc = new TextEncoder();
const dec = new TextDecoder();
const processUrl = new URL('./process.js', import.meta.url).href;
// the ported Node.js runtime (src/nodejs) is used when /etc/openvessel/node contains "port"
const nodePortUrl = new URL('./node-process.js', import.meta.url).href;
function processScript(): string {
  try {
    return dec.decode(kernel.vfs.readFile('/etc/openvessel/node')).trim() === 'port' ? nodePortUrl : processUrl;
  } catch {
    return processUrl;
  }
}

// Process workers are created ahead of time: loading and compiling the runtime scripts is most of
// a process's start-up cost, so a few already-loaded workers wait for their 'init' message.
const WARM = 2;
const warm = new Map<string, Worker[]>();
function topUp(url: string) {
  const list = warm.get(url) ?? [];
  warm.set(url, list);
  while (list.length < WARM) list.push(new Worker(url, { type: 'module', name: 'node (idle)' }));
}
function takeWorker(name: string, url = processScript()): Worker {
  const list = warm.get(url);
  const w = list?.shift();
  setTimeout(() => topUp(url), 0);
  return w ?? new Worker(url, { type: 'module', name });
}

const kernel = new Kernel({
  createWorker: (name, runtime) => takeWorker(name, runtime),
  runtime: processScript,
  onListen: (port, pid) => emit({ ev: 'server-ready', port, pid }),
  onUnlisten: (port) => emit({ ev: 'port-closed', port }),
  log: (m) => console.warn('[openvessel]', m),
});
const esm = new EsmService(kernel);
const net = new NetRouter(kernel);
installSyscalls(kernel, esm, net);
kernel.registerProgram('sh', shProgram, ['/bin']);
kernel.registerProgram('bash', shProgram, ['/bin']);
kernel.registerProgram('dash', shProgram, ['/bin']);
installCoreutils(kernel);
kernel.vfs.writeFile('/usr/bin/node', '#!/ov/builtin node\n', 0o755);
kernel.vfs.chmod('/usr/bin/node', 0o755);
kernel.vfs.symlink('/usr/bin/node', '/usr/bin/nodejs');
installNpm(kernel);
// proves to the network checks that a /__ov/net request comes from the kernel itself (npm, curl, wget):
// processes can't read it, so they can't pass themselves off as one of those
const KERNEL_TOKEN = crypto.randomUUID();
const netFetch: FetchFn = proxiedFetch(RUNTIME_BASE, { token: KERNEL_TOKEN, isLoopback: isLoopbackHost, loopback: (url, init) => loopbackFetch(url, init ?? {}) });
setNpmFetch(netFetch);
installCurl(kernel);
kernel.vfs.writeFile('/home/user/.shrc', "alias ll='ls -l'\nalias la='ls -la'\n");

// -----------------------------------------------------------------------------
// network policy

let policy: NetworkPolicy = normalizePolicy(undefined);
const sessionAllow = new Set<string>();
const sessionDeny = new Set<string>();
let nextPermId = 1;
const PERMISSION_TIMEOUT = 5 * 60_000;

/**
 * A network decision. `cache`: the answer follows from the policy or a "for this session" answer, so the
 * preview service worker may reuse it until told otherwise (`net-flush`); "allow once" is never cached.
 * `timeout`: nobody answered the permission request.
 */
export interface NetVerdict {
  allow: boolean;
  cache: boolean;
  timeout?: boolean;
}
type PermDecision = 'once' | 'session' | 'deny' | 'deny-session' | 'timeout';
const pendingPerms = new Map<number, { host: string; waiters: ((v: NetVerdict) => void)[]; timer: any }>();
const permByHost = new Map<string, number>();

/** Decides whether a request may go out; asks the host when needed. */
export function checkNetwork(url: string, initiator: string, source: 'runtime' | 'preview'): Promise<NetVerdict> {
  const d = decide(policy, url, sessionAllow, sessionDeny);
  if (d === 'allow') return Promise.resolve({ allow: true, cache: true });
  if (d === 'deny') return Promise.resolve({ allow: false, cache: false });
  if (!hostPort) return Promise.resolve({ allow: false, cache: false });
  const { host } = hostOf(url);
  const existing = permByHost.get(host);
  if (existing !== undefined) {
    return new Promise((r) => pendingPerms.get(existing)!.waiters.push(r));
  }
  const id = nextPermId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settlePerm(id, 'timeout'), PERMISSION_TIMEOUT);
    pendingPerms.set(id, { host, waiters: [resolve], timer });
    permByHost.set(host, id);
    emit({ ev: 'permission-request', id, url, host, initiator, source });
  });
}

function settlePerm(id: number, decision: PermDecision) {
  const p = pendingPerms.get(id);
  if (!p) return;
  pendingPerms.delete(id);
  permByHost.delete(p.host);
  clearTimeout(p.timer);
  if (decision === 'session') sessionAllow.add(p.host);
  else if (decision === 'deny-session') sessionDeny.add(p.host);
  const allow = decision === 'once' || decision === 'session';
  const verdict: NetVerdict = { allow, cache: decision === 'session', timeout: decision === 'timeout' || undefined };
  for (const w of p.waiters) w(verdict);
  // also after a timeout, so the host can take down its dialog
  emit({ ev: 'permission-settled', id, host: p.host, allowed: allow, decision });
}

/** What the permission prompt says made the request. Only the kernel's own requests (npm, curl…) name themselves; a process is named from the process table. */
function initiatorOf(claimed: unknown, token: unknown): string {
  const label = typeof claimed === 'string' ? claimed.slice(0, 200) : '';
  if (token === KERNEL_TOKEN && label) return label;
  const pid = /^(\d+)(?:\s|$)/.exec(label)?.[1];
  const proc = pid ? kernel.procs.get(Number(pid)) : undefined;
  if (proc && proc.state === 'running') return `${proc.pid} ${proc.argv.slice(0, 3).join(' ')}`.slice(0, 200);
  return 'process';
}

/** Ports of the preview service workers: told to forget cached decisions when the policy changes. */
const previewPorts = new Set<MessagePort>();
function policyChanged() {
  for (const p of previewPorts) p.postMessage({ k: 'net-flush' });
}

/**
 * fetch() for loopback URLs from the kernel's own clients (curl, wget, npm): they go to the virtual port,
 * as a process's request would, never to the user's machine. Redirects are followed like fetch does.
 */
async function loopbackFetch(url: string, init: RequestInit, hops = 0): Promise<Response> {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: [string, string][] = [...new Headers(init.headers)];
  if (!headers.some(([k]) => k === 'host')) headers.unshift(['host', u.host]);
  const body = init.body == null || method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await new Response(init.body).arrayBuffer());
  const signal = init.signal;
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  const res = await new Promise<Response>((resolve, reject) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let headSeen = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
      cancel() {
        h?.abort();
      },
    });
    const h = net.request(port, { method, url: u.pathname + u.search, headers, hasBody: !!body }, {
      head: (status, statusText, hs) => {
        headSeen = true;
        const out = new Headers();
        for (const [k, v] of hs) {
          try {
            out.append(k, v);
          } catch {}
        }
        const nullBody = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        const r = new Response(nullBody ? null : stream, { status: status >= 200 && status <= 599 ? status : 502, statusText, headers: out });
        Object.defineProperty(r, 'url', { value: u.href });
        resolve(r);
      },
      data: (d) => {
        try {
          ctrl.enqueue(d);
        } catch {}
      },
      end: () => {
        try {
          ctrl.close();
        } catch {}
      },
      error: (msg) => {
        if (!headSeen) reject(Object.assign(new Error(msg), { code: /ECONNREFUSED/.test(msg) ? 'ECONNREFUSED' : 'ECONNRESET' }));
        else
          try {
            ctrl.error(new Error(msg));
          } catch {}
      },
    });
    if (h && body) {
      if (body.length) h.body(body);
      h.bodyEnd();
    }
    signal?.addEventListener('abort', () => {
      h?.abort();
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location && init.redirect !== 'manual') {
    void res.body?.cancel();
    if (init.redirect === 'error' || hops >= 20) throw Object.assign(new Error(`redirect from ${url} was not followed`), { code: 'ECONNREFUSED' });
    const next = new URL(location, u).href;
    const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST');
    const nextInit: RequestInit = toGet ? { ...init, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined } : init;
    // a redirect out of the box goes through the gate like any other outside URL
    return isLoopbackHost(new URL(next).hostname) ? loopbackFetch(next, nextInit, hops + 1) : netFetch(next, nextInit);
  }
  return res;
}

// -----------------------------------------------------------------------------
// host API

let hostPort: MessagePort | null = null;

function emit(ev: Record<string, unknown>, transfer: Transferable[] = []) {
  hostPort?.postMessage(ev, transfer);
}

interface HostProc {
  pid: number;
  stdin?: OpenFile;
  tty?: ReturnType<Kernel['createTty']>;
}
const hostProcs = new Map<number, HostProc>();

function toBytes(d: unknown): Uint8Array {
  if (typeof d === 'string') return enc.encode(d);
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  throw new TypeError('data must be a string or Uint8Array');
}

async function pump(f: OpenFile, onData: (d: Uint8Array) => void) {
  for (;;) {
    const d = await f.read(65536);
    if (!d.length) break;
    onData(d);
  }
  f.unref();
}

const methods: Record<string, (a: any) => unknown> = {
  ping: () => 'pong',
  'debug.trace': (a) => ((globalThis as any).__ovTrace = !!a.on),
  'debug.esm': (a) => esm.load(a.pathname, a.search ?? ''),
  'fs.readFile': (a) => {
    const data = kernel.vfs.readFile(a.path);
    return a.encoding ? dec.decode(data) : data.slice();
  },
  'fs.writeFile': (a) => {
    if (a.mkdirs !== false) kernel.vfs.writeFileP(a.path, toBytes(a.data), a.mode ?? 0o644);
    else kernel.vfs.writeFile(a.path, toBytes(a.data), a.mode ?? 0o644);
    return null;
  },
  'fs.mkdir': (a) => kernel.vfs.mkdir(a.path, 0o755, a.recursive ?? true) ?? null,
  'fs.readdir': (a) => (a.withTypes ? kernel.vfs.readdirTypes(a.path).map(([name, t]) => ({ name, type: t === 0o040000 ? 'dir' : t === 0o120000 ? 'symlink' : 'file' })) : kernel.vfs.readdir(a.path)),
  'fs.rm': (a) => {
    if (a.recursive) kernel.vfs.rmrf(a.path, a.force ?? true);
    else {
      const n = kernel.vfs.lookup(a.path, false);
      if (isDir(n)) kernel.vfs.rmdir(a.path);
      else kernel.vfs.unlink(a.path);
    }
    return null;
  },
  'fs.stat': (a) => {
    const s = kernel.vfs.stat(a.path);
    return { ...s, isDirectory: (s.mode & 0o170000) === 0o040000, isFile: (s.mode & 0o170000) === 0o100000 };
  },
  'fs.exists': (a) => kernel.vfs.exists(a.path),
  'fs.rename': (a) => {
    kernel.vfs.rename(a.from, a.to);
    return null;
  },
  mount: (a) => {
    const base: string = a.path ?? '/home/user/app';
    kernel.vfs.mkdir(base, 0o755, true);
    let n = 0;
    for (const [rel, data] of Object.entries(a.files as Record<string, unknown>)) {
      const p = `${base}/${rel}`.replace(/\/+/g, '/');
      if (data === null || (typeof data === 'object' && (data as any).dir)) kernel.vfs.mkdir(p, 0o755, true);
      else if (typeof data === 'object' && typeof (data as any).symlink === 'string') {
        kernel.vfs.mkdir(p.slice(0, p.lastIndexOf('/')) || '/', 0o755, true);
        kernel.vfs.symlink((data as any).symlink, p);
      } else {
        const node = kernel.vfs.writeFileP(p, toBytes(data), 0o644);
        if (/\.(sh|bash)$/.test(p) || (typeof data === 'string' && data.startsWith('#!'))) node.mode |= 0o111;
      }
      n++;
    }
    return n;
  },
  export: (a) => {
    const out: Record<string, Uint8Array> = {};
    const skip = new Set<string>(a.exclude ?? ['node_modules', '.git']);
    const walk = (dir: string, rel: string) => {
      for (const [name, t] of kernel.vfs.readdirTypes(dir)) {
        if (skip.has(name)) continue;
        const p = `${dir}/${name}`;
        const r = rel ? `${rel}/${name}` : name;
        if (t === 0o040000) walk(p, r);
        else if (t === 0o100000) out[r] = kernel.vfs.readFile(p).slice();
      }
    };
    walk(a.path, '');
    return out;
  },
  spawn: (a) => {
    const env = { ...kernel.defaultEnv(), ...(a.env ?? {}) };
    const cwd = a.cwd ?? '/home/user';
    kernel.vfs.mkdir(cwd, 0o755, true);
    if (a.terminal) {
      let pid = 0;
      const tty = kernel.createTty((d) => emit({ ev: 'output', pid, data: d }));
      tty.cols = a.terminal.cols ?? 80;
      tty.rows = a.terminal.rows ?? 24;
      const f = kernel.openFile({ cwd, tty } as any, '/dev/tty', 2);
      const p = kernel.spawn({ argv: a.argv, env, cwd, stdio: [f, f, f], pgid: 0, tty });
      f.unref();
      pid = p.pid;
      tty.foregroundPgid = p.pgid;
      hostProcs.set(pid, { pid, tty });
      p.exited.then((st) => {
        hostProcs.delete(pid);
        emit({ ev: 'exit', pid, code: exitCodeOf(st), signal: st.signal });
      });
      return { pid };
    }
    const inp = createPipe();
    const out = createPipe();
    const err = createPipe();
    const p = kernel.spawn({ argv: a.argv, env, cwd, stdio: [inp.r, out.w, err.w], pgid: 0 });
    inp.r.unref();
    out.w.unref();
    err.w.unref();
    const pid = p.pid;
    hostProcs.set(pid, { pid, stdin: inp.w });
    const done = Promise.all([
      pump(out.r, (d) => emit({ ev: 'output', pid, data: d, stream: 'stdout' })),
      pump(err.r, (d) => emit({ ev: 'output', pid, data: d, stream: 'stderr' })),
      p.exited,
    ]);
    done.then(([, , st]) => {
      const hp = hostProcs.get(pid);
      hp?.stdin?.unref();
      hostProcs.delete(pid);
      emit({ ev: 'exit', pid, code: exitCodeOf(st), signal: st.signal });
    });
    return { pid };
  },
  input: (a) => {
    const hp = hostProcs.get(a.pid);
    if (!hp) return false;
    if (hp.tty) {
      hp.tty.input(toBytes(a.data));
      return true;
    }
    if (a.data === null) {
      hp.stdin?.unref();
      hp.stdin = undefined;
      return true;
    }
    try {
      hp.stdin?.write(toBytes(a.data));
    } catch {}
    return true;
  },
  resize: (a) => {
    hostProcs.get(a.pid)?.tty?.resize(a.cols, a.rows);
    return null;
  },
  kill: (a) => {
    try {
      kernel.killGroup(kernel.get(a.pid).pgid, a.signal ?? 'SIGTERM');
    } catch {}
    return null;
  },
  ps: () => [...kernel.procs.values()].filter((p) => p.state === 'running').map((p) => ({ pid: p.pid, ppid: p.ppid, argv: p.argv, cwd: p.cwd })),
  ports: () => [...kernel.ports.values()].filter((r) => r.host !== 'tcp-only').map((r) => ({ port: r.port, pid: r.pid })),
  'network.setPolicy': (a) => {
    policy = normalizePolicy(a.policy);
    policyChanged();
    return policy;
  },
  'network.getPolicy': () => policy,
  'network.clearSession': () => {
    sessionAllow.clear();
    sessionDeny.clear();
    policyChanged();
    return null;
  },
  'permission.respond': (a) => {
    if (!pendingPerms.has(a.id)) return false;
    const d = a.decision;
    settlePerm(a.id, d === 'once' || d === 'session' || d === 'deny-session' ? d : 'deny');
    return true;
  },
  watch: (a) => {
    const base: string = a.path;
    const id = a.id;
    const stop = kernel.vfs.onChange((ev) => {
      if (ev.path === base || ev.path.startsWith(base.endsWith('/') ? base : base + '/')) emit({ ev: 'fs-change', id, type: ev.type, path: ev.path });
    });
    watches.set(id, stop);
    return null;
  },
  unwatch: (a) => {
    watches.get(a.id)?.();
    watches.delete(a.id);
    return null;
  },
};
const watches = new Map<number, () => void>();

// required arguments of the host methods, checked before the call (Node's wording and codes)
type ArgType = 'string' | 'number' | 'object' | 'string[]';
const ARGS: Record<string, Record<string, ArgType>> = {
  'fs.readFile': { path: 'string' },
  'fs.writeFile': { path: 'string' },
  'fs.mkdir': { path: 'string' },
  'fs.readdir': { path: 'string' },
  'fs.rm': { path: 'string' },
  'fs.stat': { path: 'string' },
  'fs.exists': { path: 'string' },
  'fs.rename': { from: 'string', to: 'string' },
  mount: { files: 'object' },
  export: { path: 'string' },
  spawn: { argv: 'string[]' },
  input: { pid: 'number' },
  resize: { pid: 'number', cols: 'number', rows: 'number' },
  kill: { pid: 'number' },
  'permission.respond': { id: 'number' },
  watch: { path: 'string' },
  unwatch: {},
};

function received(v: unknown): string {
  if (v === null || v === undefined) return `Received ${v}`;
  if (typeof v === 'object') return Array.isArray(v) ? 'Received an instance of Array' : `Received an instance of ${(v as object).constructor?.name ?? 'Object'}`;
  return `Received type ${typeof v} (${String(v).slice(0, 25)})`;
}

function checkArgs(m: string, a: Record<string, unknown>) {
  for (const [name, type] of Object.entries(Object.prototype.hasOwnProperty.call(ARGS, m) ? ARGS[m] : {})) {
    const v = a[name];
    const ok = type === 'string[]' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : type === 'object' ? typeof v === 'object' && v !== null : typeof v === type;
    if (!ok) {
      const what = type === 'string[]' ? 'an instance of Array of strings' : type === 'object' ? 'of type object' : `of type ${type}`;
      throw Object.assign(new TypeError(`The "${name}" argument must be ${what}. ${received(v)}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    if (type === 'string[]' && !(v as string[]).length) throw Object.assign(new TypeError(`The argument '${name}' must not be empty. Received []`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
}

/** Every error reaches the host with a code: errno codes from the kernel, else one from the error's kind. */
function errorCode(e: any): string {
  if (typeof e?.code === 'string' && e.code) return e.code;
  if (e instanceof TypeError) return 'ERR_INVALID_ARG_TYPE';
  if (e instanceof RangeError) return 'ERR_OUT_OF_RANGE';
  return 'ERR_INVALID_ARG_VALUE';
}

function attachHost(port: MessagePort) {
  hostPort = port;
  port.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg?.t === 'preview-port') {
      attachPreview(msg.port as MessagePort);
      return;
    }
    const { id, m, a } = msg ?? {};
    // own properties only: "toString", "constructor"… are not methods
    const fn = typeof m === 'string' && Object.prototype.hasOwnProperty.call(methods, m) ? methods[m] : undefined;
    if (!fn) {
      port.postMessage({ id, e: { message: `unknown method ${m}`, code: 'ENOSYS' } });
      return;
    }
    try {
      const args = a && typeof a === 'object' ? a : {};
      checkArgs(m, args);
      const r = await fn(args);
      const transfer = r instanceof Uint8Array ? [r.buffer] : [];
      port.postMessage({ id, r }, transfer as Transferable[]);
    } catch (e: any) {
      port.postMessage({ id, e: { message: e?.message ?? String(e), code: errorCode(e) } });
    }
  };
  port.postMessage({ ev: 'ready' });
}

// -----------------------------------------------------------------------------
// runtime service worker channel

function attachSw(port: MessagePort) {
  port.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.id !== 'number') return;
    if (msg.k === 'esm') {
      const r = await esm.load(msg.pathname, msg.search ?? '');
      port.postMessage({ id: msg.id, ...r });
      return;
    }
    if (msg.k === 'net') {
      const v = await checkNetwork(String(msg.url), initiatorOf(msg.initiator, msg.token), 'runtime');
      port.postMessage({ id: msg.id, allow: v.allow, timeout: !!v.timeout });
    }
  };
}

// -----------------------------------------------------------------------------
// preview channel: only HTTP/WebSocket to virtual ports and network checks

function attachPreview(port: MessagePort) {
  const handles = new Map<number, ReturnType<NetRouter['request']>>();
  const send = (m: any, t: Transferable[] = []) => port.postMessage(m, t);
  previewPorts.add(port);
  // the service worker went away (or replaced this channel): end what it had open
  port.addEventListener('close', () => {
    previewPorts.delete(port);
    for (const h of handles.values()) h?.abort();
    handles.clear();
  });
  port.onmessage = async (ev) => {
    const m = ev.data;
    if (!m || typeof m.id !== 'number' || typeof m.k !== 'string') return;
    switch (m.k) {
      case 'req': {
        const h = net.request(Number(m.port), { method: String(m.method), url: String(m.url), headers: m.headers ?? [], hasBody: !!m.hasBody }, {
          head: (status, statusText, headers) => send({ k: 'head', id: m.id, status, statusText, headers }),
          data: (d) => send({ k: 'data', id: m.id, data: d }),
          end: () => {
            handles.delete(m.id);
            send({ k: 'end', id: m.id });
          },
          error: (msg) => {
            handles.delete(m.id);
            send({ k: 'error', id: m.id, msg });
          },
        });
        if (h) handles.set(m.id, h);
        return;
      }
      case 'body':
        if (m.data instanceof Uint8Array) handles.get(m.id)?.body(m.data);
        return;
      case 'body-end':
        handles.get(m.id)?.bodyEnd();
        return;
      case 'abort':
        handles.get(m.id)?.abort();
        handles.delete(m.id);
        return;
      case 'ws-open': {
        let opened = false;
        let closed = false;
        const fail = (reason: string) => {
          if (closed) return;
          closed = true;
          handles.get(m.id)?.abort();
          handles.delete(m.id);
          send({ k: 'ws-closed', id: m.id, code: 1006, reason });
        };
        const h = net.request(Number(m.port), { method: 'GET', url: String(m.url), headers: m.headers ?? [], hasBody: false, upgrade: true }, {
          // an ordinary response instead of 101: the upgrade failed (the browser's WebSocket does the same)
          head: (status) => fail(`Unexpected server response: ${status}`),
          data: () => {},
          end: () => {
            if (!opened) fail('Unexpected server response');
          },
          error: (msg) => fail(msg),
          wsOpen: (protocol) => {
            opened = true;
            send({ k: 'ws-opened', id: m.id, protocol });
          },
          wsMessage: (data, binary) => send({ k: 'ws-msg', id: m.id, data, binary }),
          wsClose: (code, reason) => {
            if (closed) return;
            closed = true;
            handles.delete(m.id);
            send({ k: 'ws-closed', id: m.id, code, reason });
          },
        });
        if (h && !closed) handles.set(m.id, h);
        else if (h) h.abort();
        return;
      }
      case 'ws-msg':
        if (typeof m.data === 'string' || m.data instanceof Uint8Array) handles.get(m.id)?.wsSend(m.data, !!m.binary);
        return;
      case 'ws-close':
        handles.get(m.id)?.wsClose(Number(m.code) || 1000, String(m.reason ?? ''));
        handles.delete(m.id);
        return;
      case 'net': {
        const v = await checkNetwork(String(m.url), 'preview', 'preview');
        send({ k: 'net-result', id: m.id, allow: v.allow, cache: v.cache, timeout: !!v.timeout });
        return;
      }
    }
  };
}

// -----------------------------------------------------------------------------

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg?.t === 'host-port') attachHost(msg.port);
  else if (msg?.t === 'sw-port') attachSw(msg.port);
  else if (msg?.t === 'policy') {
    policy = normalizePolicy(msg.policy);
    policyChanged();
  }
};

void O_WRONLY;
