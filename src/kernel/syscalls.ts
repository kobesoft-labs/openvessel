// Syscalls from node processes (synchronous over SharedArrayBuffer) and their async messages.

import { KernelError, kerr } from '../shared/errno.ts';
import * as path from '../shared/path.ts';
import { CJS_CONDITIONS, ESM_CONDITIONS } from '../shared/resolve.ts';
import type { EsmService } from './esm.ts';
import { O_ACCMODE, O_RDONLY, O_WRONLY, OpenFile, createPipe, createSocketPair } from './io.ts';
import type { Kernel } from './kernel.ts';
import type { NetRouter } from './net.ts';
import { type NodeThread, type Proc, exitCodeOf, signalName } from './proc.ts';
import { connectOutbound, markOutboundTls } from './outbound.ts';
import { S_IFCHR, S_IFIFO, S_IFREG, S_IFSOCK, isDir } from './vfs.ts';

const enc = new TextEncoder();

export function installSyscalls(kernel: Kernel, esm: EsmService, net: NetRouter) {
  const vfs = kernel.vfs;
  const watchers = new Map<string, () => void>(); // `${pid}:${id}` → stop
  const readers = new Map<string, { active: boolean }>(); // `${pid}:${fd}`
  const reservedTids = new Set<number>();
  let nextTid = 100000;
  /** Node's threadId: per process, 1, 2, … (the main thread is 0) */
  const nodeThreadIds = new WeakMap<Proc, number>();

  const abs = (proc: Proc, p: string) => {
    if (typeof p !== 'string' || p === '') throw kerr('ENOENT');
    return p.startsWith('/') ? path.normalize(p) : path.resolve(proc.cwd, p);
  };

  const fstatOf = (f: OpenFile) => {
    if (f.opts.node) return vfs.statOf(f.opts.node);
    const now = Date.now();
    const mode = f.kind === 'tty' ? S_IFCHR | 0o620 : f.kind === 'pipe' ? S_IFIFO | 0o600 : f.kind === 'socket' ? S_IFSOCK | 0o600 : S_IFCHR | 0o666;
    return { dev: 0, ino: 0, mode, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now };
  };

  /** Resolves stdio specs for spawn into child fds; returns parent-side fds for pipes. */
  const buildStdio = (proc: Proc, specs: any[]): { child: (OpenFile | null)[]; parentFds: (number | null)[]; toClose: OpenFile[] } => {
    const child: (OpenFile | null)[] = [];
    const parentFds: (number | null)[] = [];
    const toClose: OpenFile[] = [];
    specs.forEach((s, i) => {
      if (s === 'pipe' || s === 'overlapped') {
        const { r, w } = createPipe();
        if (i === 0) {
          child.push(r);
          parentFds.push(proc.allocFd(w, 3));
          toClose.push(r);
        } else {
          child.push(w);
          parentFds.push(proc.allocFd(r, 3));
          toClose.push(w);
        }
      } else if (s === 'inherit') {
        child.push(proc.fds.get(i) ?? null);
        parentFds.push(null);
      } else if (s === 'ipc') {
        const [mine, theirs] = createSocketPair();
        child.push(theirs);
        parentFds.push(proc.allocFd(mine, 3));
        toClose.push(theirs);
      } else if (s === 'ignore' || s === null || s === undefined) {
        const f = kernel.openFile(proc, '/dev/null', i === 0 ? O_RDONLY : O_WRONLY);
        child.push(f);
        toClose.push(f);
        parentFds.push(null);
      } else if (typeof s === 'number') {
        child.push(proc.fds.get(s) ?? null);
        parentFds.push(null);
      } else {
        child.push(null);
        parentFds.push(null);
      }
    });
    return { child, parentFds, toClose };
  };

  const spawnChild = (proc: Proc, a: any, stdio: (OpenFile | null)[]) => {
    const env = a.env ?? proc.env;
    const cwd = a.cwd ? abs(proc, a.cwd) : proc.cwd;
    if (a.cwd) {
      const n = vfs.tryLookup(cwd);
      if (!n || !isDir(n)) throw new KernelError('ENOENT', `spawn: cwd ${cwd} does not exist`);
    }
    return kernel.spawn({ argv: a.argv, env, cwd, stdio, ppid: proc.pid });
  };

  const registeredPids = new Set<number>();
  kernel.syscall = (proc: Proc, thread: NodeThread, op: string, a: any, bin: Uint8Array | undefined) => {
    switch (op) {
      // ---------------- files ----------------
      case 'stat': {
        const p = abs(proc, a.p);
        return a.l ? vfs.lstat(p) : vfs.stat(p);
      }
      case 'fstat':
        return fstatOf(proc.getFd(a.fd));
      case 'fdKind':
        return proc.fds.get(a.fd)?.kind ?? null;
      case 'access': {
        const n = vfs.lookup(abs(proc, a.p));
        if (a.mode & 1 && !(n.mode & 0o111) && !isDir(n)) throw kerr('EACCES');
        return null;
      }
      case 'open': {
        const f = kernel.openFile(proc, abs(proc, a.p), a.flags ?? 0, a.mode ?? 0o666);
        return proc.allocFd(f, 3);
      }
      case 'close':
        if ((globalThis as any).__ovTrace && proc.fds.get(a.fd)?.kind === 'pipe') console.warn(`[trace] pid ${proc.pid} (${proc.argv.slice(0, 3).join(' ')}) close pipe fd ${a.fd}`, new Error().stack?.split('\n').slice(0, 1).join(''));
        proc.closeFd(a.fd);
        return null;
      case 'read': {
        const f = proc.getFd(a.fd);
        if ((globalThis as any).__ovTrace && a.fd === 0) console.warn(`[trace] pid ${proc.pid} sync read fd 0 kind=${f.kind}`);
        const len = Math.min(a.len ?? 65536, 16 * 1024 * 1024);
        if (f.kind === 'file' || f.kind === 'null' || f.kind === 'dir') {
          if (f.kind === 'dir') throw kerr('EISDIR');
          const buf = new Uint8Array(len);
          if (f.kind === 'null') return buf.subarray(0, 0);
          const n = f.readFileAt(buf, a.pos ?? null);
          return buf.subarray(0, n);
        }
        const d = f.tryRead(len, null);
        if (d !== undefined) return d;
        return f.read(len).then((x) => x);
      }
      case 'write': {
        const f = proc.getFd(a.fd);
        const data = bin ?? new Uint8Array(0);
        return f.write(data, a.pos ?? null);
      }
      case 'lseek': {
        const f = proc.getFd(a.fd);
        if (f.kind !== 'file' || !f.opts.node) throw kerr('ESPIPE');
        const size = f.opts.node.size;
        const pos = a.whence === 0 ? a.offset : a.whence === 1 ? f.pos + a.offset : size + a.offset;
        if (pos < 0) throw kerr('EINVAL');
        f.pos = pos;
        return pos;
      }
      case 'readFile': {
        const p = abs(proc, a.p);
        const n = vfs.lookup(p);
        if (isDir(n)) throw kerr('EISDIR');
        if (n.device) return n.device.read(65536) ?? new Uint8Array(0);
        return vfs.readFile(p);
      }
      case 'writeFile': {
        const p = abs(proc, a.p);
        const flags = a.flags ?? 0o1101;
        const data = bin ?? new Uint8Array(0);
        if (flags & 0o2000) {
          const f = kernel.openFile(proc, p, flags, a.mode ?? 0o666);
          try {
            f.write(data);
          } finally {
            f.unref();
          }
          return null;
        }
        const existing = vfs.tryLookup(p);
        if (existing && flags & 0o200) throw kerr('EEXIST');
        if (existing && isDir(existing)) throw kerr('EISDIR');
        if (existing?.device) {
          existing.device.write(data);
          return null;
        }
        vfs.lookupParent(p); // ENOENT if parent is missing
        vfs.writeFile(p, data, (a.mode ?? 0o666) & ~proc.umask);
        return null;
      }
      case 'readdir': {
        const p = abs(proc, a.p);
        if (a.types) {
          // resolve symlink entry types like readdir(3) d_type (links stay links)
          return vfs.readdirTypes(p);
        }
        return vfs.readdir(p);
      }
      case 'mkdir': {
        const p = abs(proc, a.p);
        const r = vfs.mkdir(p, a.mode ?? 0o777, !!a.recursive);
        return a.recursive ? (r ?? null) : null;
      }
      case 'mkdtemp': {
        for (let i = 0; i < 100; i++) {
          const suffix = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
          const p = abs(proc, a.prefix + suffix);
          if (vfs.exists(p)) continue;
          vfs.mkdir(p, 0o700);
          return p;
        }
        throw kerr('EEXIST');
      }
      case 'rmdir':
        vfs.rmdir(abs(proc, a.p));
        return null;
      case 'rm': {
        const p = abs(proc, a.p);
        const n = vfs.tryLookup(p, false);
        if (!n) {
          if (a.force) return null;
          throw kerr('ENOENT');
        }
        if (isDir(n)) {
          if (!a.recursive) throw new KernelError('ERR_FS_EISDIR', `Path is a directory: rm returned EISDIR (is a directory) ${p}`);
          vfs.rmrf(p);
        } else vfs.unlink(p);
        return null;
      }
      case 'unlink': {
        const p = abs(proc, a.p);
        const n = vfs.lookup(p, false);
        if (isDir(n)) throw kerr('EISDIR');
        vfs.unlink(p);
        return null;
      }
      case 'rename':
        vfs.rename(abs(proc, a.from), abs(proc, a.to));
        return null;
      case 'link':
        vfs.link(abs(proc, a.from), abs(proc, a.to));
        return null;
      case 'symlink':
        vfs.symlink(a.target, abs(proc, a.p));
        return null;
      case 'readlink':
        return vfs.readlink(abs(proc, a.p));
      case 'realpath':
        return vfs.realpath(abs(proc, a.p));
      case 'chmod':
        vfs.chmod(abs(proc, a.p), a.mode);
        return null;
      case 'fchmod': {
        const f = proc.getFd(a.fd);
        if (f.opts.node) f.opts.node.mode = (f.opts.node.mode & ~0o7777) | (a.mode & 0o7777);
        return null;
      }
      case 'utimes':
        vfs.utimes(abs(proc, a.p), a.atime, a.mtime);
        return null;
      case 'futimes': {
        const f = proc.getFd(a.fd);
        if (f.opts.node) {
          f.opts.node.atimeMs = a.atime;
          f.opts.node.mtimeMs = a.mtime;
        }
        return null;
      }
      case 'truncate':
        vfs.truncate(abs(proc, a.p), a.len ?? 0);
        return null;
      case 'ftruncate': {
        const f = proc.getFd(a.fd);
        if (!f.opts.node) throw kerr('EINVAL');
        vfs.truncateNode(f.opts.node, a.len ?? 0, f.opts.path);
        return null;
      }
      case 'copyFile': {
        const from = abs(proc, a.from);
        const to = abs(proc, a.to);
        const n = vfs.lookup(from);
        if (isDir(n)) throw kerr('EISDIR');
        if (a.excl && vfs.exists(to)) throw kerr('EEXIST');
        vfs.lookupParent(to);
        const data = vfs.readFile(from);
        const out = vfs.writeFile(to, data, n.mode & 0o7777);
        out.mode = (out.mode & ~0o7777) | (n.mode & 0o7777);
        return null;
      }
      case 'cp': {
        const from = abs(proc, a.from);
        const to = abs(proc, a.to);
        const parent = path.dirname(to);
        if (!vfs.exists(parent)) vfs.mkdir(parent, 0o777, true);
        vfs.copy(from, to, { force: a.force, errorOnExist: a.errorOnExist, dereference: a.dereference });
        return null;
      }
      case 'watch': {
        const base = abs(proc, a.p);
        const key = `${proc.pid}:${a.id}`;
        const stop = vfs.onChange((ev) => {
          const inside = ev.path === base || (a.recursive ? ev.path.startsWith(base + '/') : path.dirname(ev.path) === base);
          if (!inside) return;
          kernel.postTo(proc, thread, { t: 'watch', id: a.id, type: ev.type, path: ev.path });
        });
        watchers.set(key, stop);
        proc.onExit.add(() => {
          watchers.get(key)?.();
          watchers.delete(key);
        });
        return null;
      }
      case 'unwatch': {
        const key = `${proc.pid}:${a.id}`;
        watchers.get(key)?.();
        watchers.delete(key);
        return null;
      }

      // ---------------- modules ----------------
      case 'resolve': {
        const extra: string[] = a.conditions ?? [];
        if (a.kind === 'esm') {
          const from = a.from.endsWith('/') ? a.from + '[importer]' : a.from;
          const r = esm.resolver.resolveEsm(a.spec, from, extra.length ? [...ESM_CONDITIONS, ...extra] : ESM_CONDITIONS);
          return r;
        }
        return esm.resolver.resolveCjs(a.spec, a.from, { extensions: a.exts, conditions: extra.length ? [...CJS_CONDITIONS, ...extra] : CJS_CONDITIONS, paths: a.paths });
      }
      case 'moduleFormat':
        return esm.resolver.formatOf(abs(proc, a.p));

      // ---------------- process ----------------
      case 'esmRegister':
        esm.register(proc.pid, a.id, a.source);
        if (!registeredPids.has(proc.pid)) {
          registeredPids.add(proc.pid);
          proc.onExit.add(() => {
            esm.dropProcess(proc.pid);
            registeredPids.delete(proc.pid);
          });
        }
        return null;
      case 'getcwd':
        return proc.cwd;
      case 'umask': {
        const old = proc.umask;
        if (typeof a.mask === 'number') proc.umask = a.mask & 0o777;
        return old;
      }
      case 'chdir': {
        const p = abs(proc, a.p);
        const n = vfs.lookup(p);
        if (!isDir(n)) throw kerr('ENOTDIR');
        const real = vfs.realpath(p);
        proc.cwd = real;
        return real;
      }
      case 'exit':
        kernel.exitProcess(proc, { code: (a.code ?? 0) & 0xff, signal: null });
        return null;
      case 'kill': {
        const target = a.pid === 0 ? proc.pid : a.pid;
        if (target < 0) {
          kernel.killGroup(-target, signalName(a.sig));
          return null;
        }
        const t = kernel.get(target);
        if (a.sig === 0) return null;
        kernel.kill(t.pid, a.sig);
        return null;
      }
      case 'sigaction':
        if (a.on) proc.handledSignals.add(signalName(a.sig));
        else proc.handledSignals.delete(signalName(a.sig));
        return null;
      case 'spawn': {
        if ((globalThis as any).__ovTrace) console.warn(`[trace] pid ${proc.pid} spawn ${a.argv.join(' ')}`);
        const { child, parentFds, toClose } = buildStdio(proc, a.stdio ?? ['pipe', 'pipe', 'pipe']);
        let c: Proc;
        try {
          c = spawnChild(proc, a, child);
        } catch (e) {
          for (const fd of parentFds) if (fd !== null) proc.closeFd(fd);
          for (const f of toClose) f.unref();
          throw e;
        }
        for (const f of toClose) f.unref();
        c.onExit.add((st) => kernel.postTo(proc, thread, { t: 'child-exit', pid: c.pid, code: st.code, signal: st.signal }));
        return { pid: c.pid, fds: parentFds };
      }
      case 'spawnSync': {
        const specs: any[] = a.stdio ?? ['pipe', 'pipe', 'pipe'];
        const child: (OpenFile | null)[] = [];
        const toClose: OpenFile[] = [];
        let stdinW: OpenFile | null = null;
        let outR: OpenFile | null = null;
        let errR: OpenFile | null = null;
        specs.forEach((s, i) => {
          if (s === 'pipe' || s === 'overlapped') {
            const { r, w } = createPipe();
            if (i === 0) {
              child.push(r);
              toClose.push(r);
              stdinW = w;
            } else {
              child.push(w);
              toClose.push(w);
              if (i === 1) outR = r;
              else if (i === 2) errR = r;
              else r.unref();
            }
          } else if (s === 'inherit') child.push(proc.fds.get(i) ?? null);
          else if (typeof s === 'number') child.push(proc.fds.get(s) ?? null);
          else {
            const f = kernel.openFile(proc, '/dev/null', i === 0 ? O_RDONLY : O_WRONLY);
            child.push(f);
            toClose.push(f);
          }
        });
        let c: Proc;
        try {
          c = spawnChild(proc, a, child);
        } finally {
          for (const f of toClose) f.unref();
        }
        if (stdinW) {
          const w = stdinW as OpenFile;
          try {
            if (bin && bin.length) w.write(bin);
          } catch {}
          w.unref();
        }
        const drain = async (f: OpenFile | null) => {
          if (!f) return new Uint8Array(0);
          const chunks: Uint8Array[] = [];
          for (;;) {
            const d = await f.read(65536);
            if (!d.length) break;
            chunks.push(d);
          }
          f.unref();
          let n = 0;
          for (const x of chunks) n += x.length;
          const out = new Uint8Array(n);
          let o = 0;
          for (const x of chunks) {
            out.set(x, o);
            o += x.length;
          }
          return out;
        };
        let timedOut = false;
        let timer: any;
        if (a.timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              kernel.kill(c.pid, a.killSignal ?? 'SIGTERM');
            } catch {}
          }, a.timeout);
        }
        return Promise.all([drain(outR), drain(errR), c.exited]).then(([out, err, st]) => {
          clearTimeout(timer);
          const bin2 = new Uint8Array(out.length + err.length);
          bin2.set(out, 0);
          bin2.set(err, out.length);
          return { __bin: bin2, pid: c.pid, status: st.code, signal: st.signal, outLen: out.length, error: timedOut ? 'ETIMEDOUT' : undefined };
        });
      }
      case 'isatty': {
        const f = proc.fds.get(a.fd);
        return f?.kind === 'tty';
      }
      case 'ttySize': {
        const f = proc.fds.get(a.fd);
        const t = f?.opts.tty;
        return t ? { cols: t.cols, rows: t.rows } : null;
      }
      case 'setRawMode': {
        const t = proc.fds.get(a.fd)?.opts.tty;
        if (!t) throw kerr('ENOTTY');
        t.raw = !!a.raw;
        t.echo = !a.raw;
        return null;
      }
      case 'threadReserve': {
        const tid = nextTid++;
        reservedTids.add(tid);
        if (!a.nodeId) return tid;
        const threadId = (nodeThreadIds.get(proc) ?? 0) + 1;
        nodeThreadIds.set(proc, threadId);
        return { tid, threadId };
      }
      case 'threadExit': {
        const t = proc.threads.get(thread.tid);
        proc.threads.delete(thread.tid);
        setTimeout(() => t?.worker.terminate(), 0);
        if (t?.parentTid !== undefined) proc.threads.get(t.parentTid)?.worker.postMessage({ t: 'thread-exit', tid: thread.tid, code: a.code ?? 0 });
        return null;
      }

      // ---------------- network ----------------
      case 'listen': {
        let port = Number(a.port) || 0;
        if (port === 0) {
          do port = 49152 + Math.floor(Math.random() * 16000);
          while (kernel.ports.has(port));
        }
        const existing = kernel.ports.get(port);
        if (existing && existing.pid !== proc.pid) throw kerr('EADDRINUSE');
        if (existing) throw kerr('EADDRINUSE');
        kernel.ports.set(port, { port, pid: proc.pid, tid: thread.tid, host: a.kind === 'http' ? (a.host || '') : a.kind === 'raw' ? 'raw' : 'tcp-only' });
        if (a.kind === 'http' || a.kind === 'raw') kernel.hooks.onListen?.(port, proc.pid);
        return port;
      }
      case 'unlisten': {
        const rec = kernel.ports.get(a.port);
        if (rec && rec.pid === proc.pid) {
          kernel.ports.delete(a.port);
          kernel.hooks.onUnlisten?.(a.port, proc.pid);
        }
        return null;
      }
      case 'tcpConnect': {
        const rec = kernel.ports.get(Number(a.port));
        if (!rec || rec.host !== 'raw') throw kerr('ECONNREFUSED');
        const end = net.tcp.connect(rec, { address: '127.0.0.1', port: 0 });
        if (!end) throw kerr('ECONNREFUSED');
        return proc.allocFd(end, 3);
      }
      case 'tcpConnectOut': {
        // not a virtual port: HTTP over the policy-checked proxy (see outbound.ts)
        const end = connectOutbound(self.location.origin, { host: String(a.host), port: Number(a.port), tls: !!a.tls }, `${proc.pid} ${proc.argv.slice(0, 3).join(' ')}`.slice(0, 200));
        return proc.allocFd(end, 3);
      }
      case 'tcpSetTls': {
        const f = proc.fds.get(a.fd);
        return f ? markOutboundTls(f, a.servername) : false;
      }
      case 'shutdown': {
        const f = proc.fds.get(a.fd);
        if (!f) throw kerr('EBADF');
        if (!f.shutdownWrite) throw kerr('ENOTSOCK');
        f.shutdownWrite();
        return null;
      }
      case 'unixListen': {
        // the socket inode is made by bind(); listen() registers it
        const node = kernel.vfs.mknodSock(abs(proc, a.p));
        kernel.unixSockets.set(node.ino, { port: node.ino, pid: proc.pid, tid: thread.tid, host: 'unix', path: abs(proc, a.p) });
        return node.ino;
      }
      case 'unixUnlisten': {
        const rec = kernel.unixSockets.get(a.ino);
        if (rec && rec.pid === proc.pid) {
          kernel.unixSockets.delete(a.ino);
          // libuv unlinks the name when the server closes
          try {
            if (kernel.vfs.lookup(rec.path, false).ino === a.ino) kernel.vfs.unlink(rec.path);
          } catch {}
        }
        return null;
      }
      case 'unixConnect': {
        const node = kernel.vfs.lookup(abs(proc, a.p), true);
        const rec = kernel.unixSockets.get(node.ino);
        if (!rec || (node.mode & 0o170000) !== S_IFSOCK) throw kerr('ECONNREFUSED');
        const end = net.tcp.connect(rec, { address: '', port: 0 }, 'pipe-accept');
        if (!end) throw kerr('ECONNREFUSED');
        return proc.allocFd(end, 3);
      }
      case 'portInfo':
        return kernel.ports.has(a.port);
    }
    throw new KernelError('ENOSYS', `unknown syscall ${op}`);
  };

  // ---------------------------------------------------------------------------
  // async messages from processes

  const loopReqs = new Map<string, ReturnType<NetRouter['request']>>();

  kernel.asyncMessage = (proc: Proc, thread: NodeThread, msg: any) => {
    if (net.fromProcess(msg)) return;
    switch (msg?.t) {
      case 'readStart': {
        const key = `${proc.pid}:${msg.fd}`;
        const existing = readers.get(key);
        if (existing?.active) return;
        const state = { active: true };
        readers.set(key, state);
        const f = proc.fds.get(msg.fd);
        if (!f) {
          kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: null });
          return;
        }
        f.ref();
        // drop our reference when the process exits, even while a read is still pending, so
        // the other end of a pipe/socketpair sees EOF
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          state.active = false;
          f.unref();
        };
        proc.onExit.add(release);
        (async () => {
          try {
            while (state.active && proc.state === 'running') {
              const d = await f.read(65536);
              if (proc.state !== 'running') break;
              if (d.length === 0) {
                kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: null });
                state.active = false;
                break;
              }
              kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: d });
            }
          } catch (e) {
            kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: null });
          } finally {
            proc.onExit.delete(release);
            release();
            if (readers.get(key) === state) readers.delete(key);
          }
        })();
        return;
      }
      case 'readStop': {
        const st = readers.get(`${proc.pid}:${msg.fd}`);
        if (st) st.active = false;
        return;
      }
      case 'readOnce': {
        const f = proc.fds.get(msg.fd);
        if (!f) {
          kernel.postTo(proc, thread, { t: 'fd-data', id: msg.id, data: null, err: 'EBADF' });
          return;
        }
        f.read(msg.len ?? 65536).then(
          (d) => {
            if ((globalThis as any).__ovTrace && d.length === 0) console.warn(`[trace] pid ${proc.pid} (${proc.argv.slice(0, 3).join(' ')}) readOnce fd ${msg.fd} EOF kind=${f.kind}`);
            kernel.postTo(proc, thread, { t: 'fd-data', id: msg.id, data: d });
          },
          (e) => kernel.postTo(proc, thread, { t: 'fd-data', id: msg.id, data: null, err: e?.code ?? 'EIO' }),
        );
        return;
      }
      case 'threadSpawn': {
        const tid = msg.tid;
        reservedTids.delete(tid);
        const t = kernel.startThread(
          proc,
          {
            kind: 'thread',
            tid,
            file: msg.file,
            eval: msg.eval,
            evalType: msg.evalType,
            argv: ['node', ...(msg.argv ?? [])],
            execArgv: msg.execArgv,
            env: msg.env,
            workerData: msg.workerData,
            envData: msg.envData,
            port: msg.port,
            name: msg.name,
            threadId: msg.threadId,
            resourceLimits: msg.resourceLimits,
            envRings: msg.envRings,
            trackUnmanagedFds: msg.trackUnmanagedFds,
          },
          [msg.port, ...(msg.transfer ?? [])],
          thread.tid,
          tid,
        );
        void t;
        return;
      }
      case 'threadKill': {
        const t = proc.threads.get(msg.tid);
        if (t) {
          t.worker.terminate();
          proc.threads.delete(msg.tid);
          thread.worker.postMessage({ t: 'thread-exit', tid: msg.tid, code: 1, terminated: true });
        }
        return;
      }
      case 'loop-req': {
        const key = `${proc.pid}:${msg.crid}`;
        const reply = (m: any, tr: Transferable[] = []) => thread.worker.postMessage({ ...m, crid: msg.crid }, tr);
        const h = net.request(msg.port, { method: msg.method, url: msg.url, headers: msg.headers, hasBody: true }, {
          head: (status, statusText, headers) => reply({ t: 'loop-res', status, statusText, headers }),
          data: (d) => reply({ t: 'loop-res-data', data: d }),
          end: () => {
            loopReqs.delete(key);
            reply({ t: 'loop-res-end' });
          },
          error: (m) => {
            loopReqs.delete(key);
            reply({ t: 'loop-res-error', msg: m });
          },
        });
        if (h) loopReqs.set(key, h);
        return;
      }
      case 'loop-body':
        loopReqs.get(`${proc.pid}:${msg.crid}`)?.body(msg.data);
        return;
      case 'loop-body-end':
        loopReqs.get(`${proc.pid}:${msg.crid}`)?.bodyEnd();
        return;
      case 'loop-abort': {
        const key = `${proc.pid}:${msg.crid}`;
        loopReqs.get(key)?.abort();
        loopReqs.delete(key);
        return;
      }
    }
  };

  void S_IFREG;
  void O_ACCMODE;
  void exitCodeOf;
  void enc;
}
