// Kernel worker entry. Talks to: the host (full control), the runtime service worker
// (module loading + network decisions) and preview relays (HTTP/WebSocket only).

import { type NetworkPolicy, decide, hostOf, normalizePolicy } from '../shared/policy.ts';
import { RUNTIME_BASE } from './base.ts';
import { installCoreutils } from './coreutils.ts';
import { EsmService } from './esm.ts';
import { O_WRONLY, type OpenFile, createPipe } from './io.ts';
import { Kernel } from './kernel.ts';
import { NetRouter } from './net.ts';
import { installNpm, setNpmFetch } from './npm/cli.ts';
import { proxiedFetch } from './npm/registry.ts';
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
function takeWorker(name: string): Worker {
  const url = processScript();
  const list = warm.get(url);
  const w = list?.shift();
  setTimeout(() => topUp(url), 0);
  return w ?? new Worker(url, { type: 'module', name });
}

const kernel = new Kernel({
  createWorker: (name) => takeWorker(name),
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
setNpmFetch(proxiedFetch(RUNTIME_BASE));
installCurl(kernel);
kernel.vfs.writeFile('/home/user/.shrc', "alias ll='ls -l'\nalias la='ls -la'\n");

// -----------------------------------------------------------------------------
// network policy

let policy: NetworkPolicy = normalizePolicy(undefined);
const sessionAllow = new Set<string>();
const sessionDeny = new Set<string>();
let nextPermId = 1;
const pendingPerms = new Map<number, { host: string; waiters: ((ok: boolean) => void)[]; timer: any }>();
const permByHost = new Map<string, number>();

/** Decides whether a request may go out; asks the host when needed. */
export function checkNetwork(url: string, initiator: string, source: 'runtime' | 'preview'): Promise<boolean> {
  const d = decide(policy, url, sessionAllow, sessionDeny);
  if (d === 'allow') return Promise.resolve(true);
  if (d === 'deny') return Promise.resolve(false);
  if (!hostPort) return Promise.resolve(false);
  const { host } = hostOf(url);
  const existing = permByHost.get(host);
  if (existing !== undefined) {
    return new Promise((r) => pendingPerms.get(existing)!.waiters.push(r));
  }
  const id = nextPermId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settlePerm(id, false), 5 * 60_000);
    pendingPerms.set(id, { host, waiters: [resolve], timer });
    permByHost.set(host, id);
    emit({ ev: 'permission-request', id, url, host, initiator, source });
  });
}

function settlePerm(id: number, ok: boolean) {
  const p = pendingPerms.get(id);
  if (!p) return;
  pendingPerms.delete(id);
  permByHost.delete(p.host);
  clearTimeout(p.timer);
  for (const w of p.waiters) w(ok);
  emit({ ev: 'permission-settled', id, host: p.host, allowed: ok });
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
    return policy;
  },
  'network.getPolicy': () => policy,
  'network.clearSession': () => {
    sessionAllow.clear();
    sessionDeny.clear();
    return null;
  },
  'permission.respond': (a) => {
    const p = pendingPerms.get(a.id);
    if (!p) return false;
    switch (a.decision) {
      case 'session':
        sessionAllow.add(p.host);
        settlePerm(a.id, true);
        break;
      case 'once':
        settlePerm(a.id, true);
        break;
      case 'deny-session':
        sessionDeny.add(p.host);
        settlePerm(a.id, false);
        break;
      default:
        settlePerm(a.id, false);
    }
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

function attachHost(port: MessagePort) {
  hostPort = port;
  port.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg?.t === 'preview-port') {
      attachPreview(msg.port as MessagePort);
      return;
    }
    const { id, m, a } = msg ?? {};
    const fn = methods[m];
    if (!fn) {
      port.postMessage({ id, e: { message: `unknown method ${m}`, code: 'ENOSYS' } });
      return;
    }
    try {
      const r = await fn(a ?? {});
      const transfer = r instanceof Uint8Array ? [r.buffer] : [];
      port.postMessage({ id, r }, transfer as Transferable[]);
    } catch (e: any) {
      port.postMessage({ id, e: { message: e?.message ?? String(e), code: e?.code } });
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
      const ok = await checkNetwork(msg.url, msg.initiator ?? 'process', 'runtime');
      port.postMessage({ id: msg.id, allow: ok });
    }
  };
}

// -----------------------------------------------------------------------------
// preview channel: only HTTP/WebSocket to virtual ports and network checks

function attachPreview(port: MessagePort) {
  const handles = new Map<number, ReturnType<NetRouter['request']>>();
  const send = (m: any, t: Transferable[] = []) => port.postMessage(m, t);
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
        const h = net.request(Number(m.port), { method: 'GET', url: String(m.url), headers: m.headers ?? [], hasBody: false, upgrade: true }, {
          head: () => {},
          data: () => {},
          end: () => {},
          error: (msg) => {
            handles.delete(m.id);
            send({ k: 'ws-closed', id: m.id, code: 1006, reason: msg });
          },
          wsOpen: (protocol) => send({ k: 'ws-opened', id: m.id, protocol }),
          wsMessage: (data, binary) => send({ k: 'ws-msg', id: m.id, data, binary }),
          wsClose: (code, reason) => {
            handles.delete(m.id);
            send({ k: 'ws-closed', id: m.id, code, reason });
          },
        });
        if (h) handles.set(m.id, h);
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
        const ok = await checkNetwork(String(m.url), 'preview', 'preview');
        send({ k: 'net-result', id: m.id, allow: ok });
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
  else if (msg?.t === 'policy') policy = normalizePolicy(msg.policy);
};

void O_WRONLY;
