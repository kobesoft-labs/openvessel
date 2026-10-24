// Syscalls from node processes (synchronous over SharedArrayBuffer) and their async messages.

import { KernelError, kerr } from '../shared/errno.ts';
import * as path from '../shared/path.ts';
import { CJS_CONDITIONS, ESM_CONDITIONS } from '../shared/resolve.ts';
import type { EsmService } from './esm.ts';
import { O_ACCMODE, O_RDONLY, O_WRONLY, OpenFile, type Pipe, type PipeAttachment, createPipe, createSocketPair } from './io.ts';
import { type Kernel, fdPathOf, leaveListener } from './kernel.ts';
import type { NetRouter } from './net.ts';
import { type NodeThread, type Proc, exitCodeOf, signalName } from './proc.ts';
import { RUNTIME_BASE } from './base.ts';
import { connectOutbound, markOutboundTls } from './outbound.ts';
import { S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFREG, S_IFSOCK, isDir } from './vfs.ts';

const enc = new TextEncoder();

export function installSyscalls(kernel: Kernel, esm: EsmService, net: NetRouter) {
  const vfs = kernel.vfs;
  const watchers = new Map<string, () => void>(); // `${pid}:${id}` → stop
  interface ReaderState {
    active: boolean;
    stop?: () => void;
    /** pipes/sockets: the pipe read, and who reads it */
    pipe?: Pipe;
    proc?: Proc;
    thread?: NodeThread;
  }
  const readers = new Map<string, ReaderState>(); // `${pid}:${fd}`
  // 'ping' sent to a thread → resolves on its 'pong' (it has handled everything posted before)
  const pings = new Map<number, () => void>();
  let nextPing = 1;
  /**
   * Node threads of other processes reading from sockets this process writes to. A process that
   * exits keeps its sockets open until they have handled what it sent (process teardown takes
   * longer than a peer's reaction to the last message, e.g. an IPC ack answered at once).
   */
  const socketPeersReading = (p: Proc) => {
    const out: ReaderState[] = [];
    for (const f of p.fds.values()) {
      const pipe = f.kind === 'socket' ? (f.opts.writer as { pipe?: Pipe } | undefined)?.pipe : undefined;
      if (!pipe) continue;
      for (const st of readers.values()) if (st.active && st.pipe === pipe && st.proc && st.proc !== p && st.thread && !out.includes(st)) out.push(st);
    }
    return out;
  };
  const reservedTids = new Set<number>();
  let nextTid = 100000;
  const BASE_FDS = 30;
  const FDS_PER_THREAD = 8;
  /** Node's threadId: per process, 1, 2, … (the main thread is 0) */
  const nodeThreadIds = new WeakMap<Proc, number>();
  /** threads waiting to hear that a thread is gone (MessagePorts whose other end lives there) */
  const threadWatchers = new Map<string, NodeThread[]>();
  const threadGone = (proc: Proc, tid: number) => {
    const key = `${proc.pid}:${tid}`;
    const ws = threadWatchers.get(key);
    threadWatchers.delete(key);
    for (const w of ws ?? []) if (proc.threads.get(w.tid) === w) w.worker.postMessage({ t: 'thread-gone', tid });
  };

  const abs = (proc: Proc, p: string) => {
    if (typeof p !== 'string' || p === '') throw kerr('ENOENT');
    return p.startsWith('/') ? path.normalize(p) : path.resolve(proc.cwd, p);
  };

  /**
   * EACCES unless a process (uid/gid 1000, not root) may add or remove entries in the directory
   * that holds `p`: write and search permission on it.
   */
  const checkDirWritable = (p: string) => {
    const d = vfs.lookup(path.dirname(p));
    const shift = d.uid === 1000 ? 6 : d.gid === 1000 ? 3 : 0;
    if (((d.mode >> shift) & 3) !== 3) throw kerr('EACCES');
  };

  /** The open file behind fd N of /proc/self/fd/N (ENOENT if it isn't open). */
  const fdFile = (proc: Proc, fd: number) => {
    const f = proc.fds.get(fd);
    if (!f) throw kerr('ENOENT');
    return f;
  };

  /**
   * /proc/self (a link to /proc/<pid>), /proc/<pid> and /proc/<pid>/fd of the calling process, which
   * the VFS doesn't hold; null for other paths.
   */
  const procDirStat = (proc: Proc, p: string, l: boolean) => {
    const m = /^\/proc\/(self|\d+)(\/fd)?$/.exec(p);
    if (!m || (m[1] !== 'self' && Number(m[1]) !== proc.pid)) return null;
    const st = vfs.lstat('/proc');
    if (m[1] === 'self' && !m[2] && l) return { ...st, ino: 0, mode: S_IFLNK | 0o777, nlink: 1, size: String(proc.pid).length };
    return { ...st, ino: 0, mode: S_IFDIR | (m[2] ? 0o500 : 0o555), nlink: 2 };
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
      if ((s === 'pipe' || s === 'overlapped') && i > 2) {
        // extra stdio pipes are duplex (libuv makes every stdio pipe with socketpair)
        const [mine, theirs] = createSocketPair();
        child.push(theirs);
        parentFds.push(proc.allocFd(mine, 3));
        toClose.push(theirs);
      } else if (s === 'pipe' || s === 'overlapped') {
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
    return kernel.spawn({ argv: a.argv, argv0: a.argv0, env, cwd, stdio, ppid: proc.pid });
  };

  // UDP on virtual ports: who receives on each port; datagrams wait while nobody is receiving
  interface UdpMember {
    proc: Proc;
    thread: NodeThread;
    receiving: boolean;
  }
  const udpPorts = new Map<number, { members: UdpMember[]; next: number; queue: { data: Uint8Array; from: { address: string; port: number } }[] }>();
  const udpLeave = (port: number, p: Proc) => {
    const rec = udpPorts.get(port);
    if (!rec) return;
    rec.members = rec.members.filter((m) => m.proc !== p);
    if (!rec.members.length) udpPorts.delete(port);
  };
  const udpJoin = (port: number, p: Proc, thread: NodeThread) => {
    let rec = udpPorts.get(port);
    if (!rec) udpPorts.set(port, (rec = { members: [], next: 0, queue: [] }));
    if (rec.members.some((m) => m.proc === p)) return;
    rec.members.push({ proc: p, thread, receiving: false });
    p.onExit.add(() => udpLeave(port, p));
  };
  const udpDeliver = (port: number) => {
    const rec = udpPorts.get(port);
    if (!rec) return;
    while (rec.queue.length) {
      const live = rec.members.filter((m) => m.receiving && m.proc.state === 'running');
      if (!live.length) return;
      const m = live[(rec.next = (rec.next + 1) % live.length)];
      const d = rec.queue.shift()!;
      kernel.postTo(m.proc, m.thread, { t: 'udp-msg', port, data: d.data, from: d.from });
    }
  };

  const registeredPids = new Set<number>();
  kernel.syscall = (proc: Proc, thread: NodeThread, op: string, a: any, bin: Uint8Array | undefined) => {
    switch (op) {
      // ---------------- files ----------------
      case 'stat': {
        const p = abs(proc, a.p);
        // /proc/self/fd/N is a link to the open file (/dev/stdin and the like link to it)
        const own = fdPathOf(p, proc.pid);
        if (a.l && own !== null) return { ...fstatOf(fdFile(proc, own)), mode: S_IFLNK | 0o700, size: 64 };
        const fd = a.l ? null : kernel.procFdOf(p, proc.pid);
        if (fd !== null) return fstatOf(fdFile(proc, fd));
        const dir = procDirStat(proc, p, !!a.l);
        if (dir) return dir;
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
        const p = abs(proc, a.p);
        if ((a.flags ?? 0) & 0o100 && !vfs.tryLookup(p)) checkDirWritable(p);
        const f = kernel.openFile(proc, p, a.flags ?? 0, a.mode ?? 0o666);
        return proc.allocFd(f, 3);
      }
      case 'close':
        if ((globalThis as any).__ovTrace && proc.fds.get(a.fd)?.kind === 'pipe') console.warn(`[trace] pid ${proc.pid} (${proc.argv.slice(0, 3).join(' ')}) close pipe fd ${a.fd}`, new Error().stack?.split('\n').slice(0, 1).join(''));
        // a reader started on this fd lets go of the file too (the other end must see EOF)
        readers.get(`${proc.pid}:${a.fd}`)?.stop?.();
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
        if (a.sendHandle) {
          // a handle sent over a socket (uv_write2): it travels with the first byte of this write
          const pipe = (f.opts.writer as { pipe?: Pipe } | undefined)?.pipe;
          if (!pipe || f.kind !== 'socket' || !data.length) throw kerr('EINVAL');
          const { fd: sendFd, ...meta } = a.sendHandle as { fd?: number } & Record<string, unknown>;
          const item: PipeAttachment = { meta };
          if (typeof sendFd === 'number') item.file = proc.getFd(sendFd).ref();
          try {
            return pipe.write(data, item);
          } catch (e) {
            item.file?.unref();
            throw e;
          }
        }
        // O_NONBLOCK on a pipe or socket: only what fits in its buffer (0 = EAGAIN)
        const pipe = a.nonblock ? (f.opts.writer as { pipe?: Pipe } | undefined)?.pipe : undefined;
        if (pipe && f.writable && pipe.readers > 0) {
          const n = Math.min(data.length, pipe.space);
          return n > 0 ? f.write(data.subarray(0, n)) : 0;
        }
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
        const fd = kernel.procFdOf(p, proc.pid);
        if (fd !== null) {
          const f = fdFile(proc, fd);
          if (f.kind === 'file' && f.opts.node) return vfs.contents(f.opts.node).slice();
          return (async () => {
            const parts: Uint8Array[] = [];
            for (let d; (d = await f.read(65536)).length; ) parts.push(d);
            const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
            let off = 0;
            for (const x of parts) {
              out.set(x, off);
              off += x.length;
            }
            return out;
          })();
        }
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
        if (!existing) checkDirWritable(p);
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
        // the directory that gets the first new entry must be writable
        let first = p;
        if (a.recursive) while (first !== '/' && !vfs.tryLookup(path.dirname(first))) first = path.dirname(first);
        if (!vfs.tryLookup(first)) checkDirWritable(first);
        const r = vfs.mkdir(p, a.mode ?? 0o777, !!a.recursive);
        return a.recursive ? (r ?? null) : null;
      }
      case 'mkdtemp': {
        for (let i = 0; i < 100; i++) {
          const suffix = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
          const p = abs(proc, a.prefix + suffix);
          if (vfs.exists(p)) continue;
          checkDirWritable(p);
          vfs.mkdir(p, 0o700);
          return p;
        }
        throw kerr('EEXIST');
      }
      case 'rmdir': {
        const p = abs(proc, a.p);
        if (vfs.tryLookup(p, false)) checkDirWritable(p);
        vfs.rmdir(p);
        return null;
      }
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
        checkDirWritable(p);
        vfs.unlink(p);
        return null;
      }
      case 'rename': {
        const from = abs(proc, a.from);
        const to = abs(proc, a.to);
        if (vfs.tryLookup(from, false)) {
          checkDirWritable(from);
          if (vfs.tryLookup(path.dirname(to))) checkDirWritable(to);
        }
        vfs.rename(from, to);
        return null;
      }
      case 'link': {
        const to = abs(proc, a.to);
        if (vfs.tryLookup(path.dirname(to)) && !vfs.tryLookup(to, false)) checkDirWritable(to);
        vfs.link(abs(proc, a.from), to);
        return null;
      }
      case 'symlink': {
        const p = abs(proc, a.p);
        if (vfs.tryLookup(path.dirname(p)) && !vfs.tryLookup(p, false)) checkDirWritable(p);
        vfs.symlink(a.target, p);
        return null;
      }
      case 'readlink': {
        const p = abs(proc, a.p);
        if (p === '/proc/self') return String(proc.pid);
        const own = fdPathOf(p, proc.pid);
        if (own !== null) {
          // what Linux shows: the file's path, or pipe:[id] / socket:[id]
          const f = fdFile(proc, own);
          if (f.opts.path) return f.opts.path;
          if (f.kind === 'tty') return '/dev/tty';
          const id = (f.opts.reader as { pipe?: { id: number } } | undefined)?.pipe?.id ?? (f.opts.writer as { pipe?: { id: number } } | undefined)?.pipe?.id ?? 0;
          return `${f.kind === 'socket' ? 'socket' : 'pipe'}:[${id}]`;
        }
        return vfs.readlink(p);
      }
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
      case 'exit': {
        const status = { code: (a.code ?? 0) & 0xff, signal: null };
        const peers = socketPeersReading(proc);
        if (!peers.length) {
          kernel.exitProcess(proc, status);
          return null;
        }
        // the exiting thread never runs again; the process ends once its peers have caught up
        const waits = peers.map(
          (st) =>
            new Promise<void>((resolve) => {
              const id = nextPing++;
              pings.set(id, resolve);
              kernel.postTo(st.proc!, st.thread!, { t: 'ping', id });
              setTimeout(() => {
                pings.delete(id);
                resolve();
              }, 250);
            }),
        );
        void Promise.all(waits).then(() => kernel.exitProcess(proc, status));
        return null;
      }
      case 'udpBind': {
        let port = Number(a.port) || 0;
        if (port === 0) {
          do port = 49152 + Math.floor(Math.random() * 16000);
          while (udpPorts.has(port));
        } else if (udpPorts.has(port) && !a.reuse) throw kerr('EADDRINUSE');
        udpJoin(port, proc, thread);
        return port;
      }
      case 'udpJoin': {
        if (!udpPorts.has(Number(a.port))) throw kerr('EINVAL');
        udpJoin(Number(a.port), proc, thread);
        return null;
      }
      case 'udpRecv': {
        const m = udpPorts.get(Number(a.port))?.members.find((x) => x.proc === proc);
        if (m) {
          m.receiving = !!a.on;
          m.thread = thread;
          if (m.receiving) udpDeliver(Number(a.port));
        }
        return null;
      }
      case 'udpClose':
        udpLeave(Number(a.port), proc);
        return null;
      case 'udpSend': {
        const rec = udpPorts.get(Number(a.port));
        // nobody bound there: the datagram is lost, as on a real network
        if (rec && rec.queue.length < 1024) {
          rec.queue.push({ data: (bin ?? new Uint8Array(0)).slice(), from: { address: a.fromAddress && a.fromAddress !== '0.0.0.0' ? a.fromAddress : '127.0.0.1', port: Number(a.from) || 0 } });
          udpDeliver(Number(a.port));
        }
        return null;
      }
      case 'execve': {
        // check that it can run before the old image is torn down
        kernel.planExec([...a.argv], a.env ?? proc.env, proc.cwd, true);
        for (const fd of [...proc.fds.keys()]) {
          if (fd <= 2) continue;
          readers.get(`${proc.pid}:${fd}`)?.stop?.();
          try {
            proc.closeFd(fd);
          } catch {}
        }
        for (const [key, stop] of watchers) {
          if (!key.startsWith(`${proc.pid}:`)) continue;
          stop();
          watchers.delete(key);
        }
        kernel.execImage(proc, [...a.argv], a.env ?? proc.env, a.argv0);
        // the calling thread is gone: no reply
        return new Promise(() => {});
      }
      case 'kill': {
        if (typeof a.sig === 'number' && (a.sig < 0 || a.sig > 64 || !Number.isInteger(a.sig))) throw kerr('EINVAL');
        const target = a.pid === 0 ? proc.pid : a.pid;
        if (target < 0) {
          kernel.killGroup(-target, signalName(a.sig));
          return null;
        }
        const t = kernel.get(target);
        // an exited process has been reaped as far as the caller can tell (libuv reaps on SIGCHLD)
        if (t.state !== 'running') throw kerr('ESRCH');
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
          for (const f of toClose) f.unref();
          // like libuv when exec fails: the parent's ends stay open (the child's are closed), so
          // stdio streams read EOF instead of failing
          const code = (e as KernelError)?.code;
          if (a.keepStdioOnError && (code === 'ENOENT' || code === 'EACCES')) return { pid: 0, fds: parentFds, error: code };
          for (const fd of parentFds) if (fd !== null) proc.closeFd(fd);
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
      case 'watchThread': {
        // tell the caller when thread a.tid of this process is gone (now, if it already is)
        if (!proc.threads.has(a.tid)) {
          thread.worker.postMessage({ t: 'thread-gone', tid: a.tid });
          return null;
        }
        const key = `${proc.pid}:${a.tid}`;
        const ws = threadWatchers.get(key) ?? [];
        if (!ws.includes(thread)) ws.push(thread);
        threadWatchers.set(key, ws);
        return null;
      }
      case 'threadExit': {
        const t = proc.threads.get(thread.tid);
        proc.threads.delete(thread.tid);
        threadGone(proc, thread.tid);
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
        if (rec && (rec.pid === proc.pid || rec.acceptors?.some((x) => x.pid === proc.pid)) && !leaveListener(rec, proc.pid)) {
          kernel.ports.delete(a.port);
          kernel.hooks.onUnlisten?.(a.port, proc.pid);
        }
        return null;
      }
      case 'listenShare': {
        // listen() on a listening socket received from another process
        const rec = kernel.ports.get(Number(a.port));
        if (!rec) throw kerr('EINVAL');
        if (rec.pid !== proc.pid && !rec.acceptors?.some((x) => x.pid === proc.pid)) (rec.acceptors ??= []).push({ pid: proc.pid, tid: thread.tid });
        return null;
      }
      case 'tcpConnect': {
        const rec = kernel.ports.get(Number(a.port));
        if (!rec || rec.host !== 'raw') throw kerr('ECONNREFUSED');
        const end = net.tcp.connect(rec, { address: '127.0.0.1', port: 0 });
        if (!end) throw kerr('ECONNREFUSED');
        const by = net.tcp.lastAcceptor;
        // and whether the caller's own thread is the one accepting it
        return { fd: proc.allocFd(end, 3), self: by?.pid === proc.pid && by?.tid === thread.tid };
      }
      case 'tcpConnectOut': {
        // not a virtual port: HTTP over the policy-checked proxy (see outbound.ts)
        const end = connectOutbound(RUNTIME_BASE, { host: String(a.host), port: Number(a.port), tls: !!a.tls }, `${proc.pid} ${proc.argv.slice(0, 3).join(' ')}`.slice(0, 200));
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
      case 'pong': {
        const done = pings.get(msg.id);
        pings.delete(msg.id);
        done?.();
        return;
      }
      case 'readStart': {
        const key = `${proc.pid}:${msg.fd}`;
        const existing = readers.get(key);
        if (existing?.active) return;
        const state: ReaderState = { active: true, proc, thread };
        readers.set(key, state);
        const f = proc.fds.get(msg.fd);
        if (!f) {
          kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: null });
          return;
        }
        f.ref();
        // drop our reference when the process exits or closes the fd, even while a read is still
        // pending, so the other end of a pipe/socketpair sees EOF
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          state.active = false;
          proc.onExit.delete(release);
          notifier?.delete(pump);
          f.unref();
          if (readers.get(key) === state) readers.delete(key);
        };
        proc.onExit.add(release);
        state.stop = release;
        // pipes and sockets are read only when data is there (no read left pending), so a
        // readStop() never swallows data that arrives afterwards
        const readPipe = (f.opts.reader as { pipe?: Pipe } | undefined)?.pipe;
        state.pipe = readPipe;
        const notifier = readPipe?.onReadable;
        let pumping = false;
        function pump() {
          if (pumping) return;
          pumping = true;
          try {
            while (state.active && proc.state === 'running') {
              let r: { data: Uint8Array; item?: PipeAttachment } | null | undefined;
              try {
                r = readPipe!.tryReadAttached(65536);
              } catch {
                r = null;
              }
              if (r === undefined) return;
              if (r === null || r.data.length === 0) {
                kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: null });
                release();
                return;
              }
              // a received file gets a descriptor in this process
              const handle = r.item ? { ...r.item.meta, ...(r.item.file ? { fd: proc.allocFd(r.item.file, 3) } : {}) } : undefined;
              kernel.postTo(proc, thread, { t: 'fd-data', fd: msg.fd, data: r.data, handle });
            }
          } finally {
            pumping = false;
          }
        }
        if (notifier) {
          notifier.add(pump);
          pump();
          return;
        }
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
            release();
          }
        })();
        return;
      }
      case 'writeWait': {
        // 'fd-writable' once a pipe/socket buffer has drained (or its reader is gone)
        const notify = () => kernel.postTo(proc, thread, { t: 'fd-writable', fd: msg.fd });
        const pipe = (proc.fds.get(msg.fd)?.opts.writer as { pipe?: Pipe } | undefined)?.pipe;
        if (pipe) pipe.onDrain(notify);
        else notify();
        return;
      }
      case 'readStop': {
        const st = readers.get(`${proc.pid}:${msg.fd}`);
        if (st) {
          st.active = false;
          // pipes: nothing is pending, let go now; others stop after the read in flight
          if (st.stop && (proc.fds.get(msg.fd)?.opts.reader as { pipe?: unknown } | undefined)?.pipe) st.stop();
        }
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
        // a Node thread holds descriptors of its own (its loop's, its ports'): with a small
        // RLIMIT_NOFILE (ulimit -n) only so many fit, and the next one fails to initialize
        if (proc.threads.size * FDS_PER_THREAD + BASE_FDS > proc.nofile) {
          thread.worker.postMessage({ t: 'thread-exit', tid, code: 1, initFailed: 'EMFILE' });
          return;
        }
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
            sharedEnv: msg.sharedEnv,
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
          threadGone(proc, msg.tid);
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
