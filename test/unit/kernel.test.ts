import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kernel, envShebang } from '../../src/kernel/kernel.ts';
import type { EsmService } from '../../src/kernel/esm.ts';
import { NetRouter } from '../../src/kernel/net.ts';
import { installSyscalls } from '../../src/kernel/syscalls.ts';
import { installCoreutils } from '../../src/kernel/coreutils.ts';
import { shProgram } from '../../src/kernel/sh/interp.ts';
import { type NodeThread, type Proc, exitCodeOf, signalName, signalNumber } from '../../src/kernel/proc.ts';
import { run } from './helpers.ts';

/** A kernel with system calls; node processes get stand-in workers that record what they are sent. */
function makeKernel() {
  const sent: { name: string; runtime?: string; msgs: any[] }[] = [];
  let runtime = 'legacy';
  const k = new Kernel({
    createWorker: (name, rt) => {
      const rec = { name, runtime: rt, msgs: [] as any[] };
      sent.push(rec);
      return { postMessage: (m: any) => rec.msgs.push(m), terminate() {}, onmessage: null, onerror: null } as unknown as Worker;
    },
    runtime: () => runtime,
  });
  k.registerProgram('sh', shProgram, ['/bin']);
  installCoreutils(k);
  k.vfs.writeFile('/usr/bin/node', '#!/ov/builtin node\n', 0o755);
  const esm = {} as EsmService; // module resolution isn't tested here
  const net = new NetRouter(k);
  installSyscalls(k, esm, net);
  const node = (opts: { ppid?: number; pgid?: number; argv?: string[] } = {}) => k.spawn({ argv: opts.argv ?? ['node', '-e', ''], ppid: opts.ppid, pgid: opts.pgid });
  const sys = (p: Proc, op: string, args: any = {}, bin?: Uint8Array) => k.syscall(p, p.threads.values().next().value as NodeThread, op, args, bin);
  return { k, net, sent, node, sys, setRuntime: (r: string) => (runtime = r) };
}

const errCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e.code;
  }
  return 'no error';
};

test('signals: the whole Linux table, real-time signals included', () => {
  assert.equal(signalName(30), 'SIGPWR');
  assert.equal(signalName(23), 'SIGURG');
  assert.equal(signalName(16), 'SIGSTKFLT');
  assert.equal(signalName(34), 'SIGRTMIN');
  assert.equal(signalName(35), 'SIGRTMIN+1');
  assert.equal(signalName(50), 'SIGRTMAX-14');
  assert.equal(signalName(64), 'SIGRTMAX');
  assert.equal(signalNumber('SIGRTMIN+3'), 37);
  assert.equal(signalNumber('RTMAX-1'), 63);
  assert.equal(signalNumber('SIGIOT'), 6);
  assert.equal(signalNumber('SIGPOLL'), 29);
  assert.equal(signalNumber('SIGFOO'), -1);
  assert.equal(signalNumber(65), -1);
  assert.equal(exitCodeOf({ code: null, signal: 'SIGPWR' }), 158);
});

test('kill: default actions, pid 0, -pgid, -1 and signal 0', () => {
  const { k, node, sys } = makeKernel();
  const a = node({ pgid: 0 });
  const b = node({ ppid: a.pid });
  const c = node({ pgid: 0 });
  // ignored by default
  for (const sig of [17, 23, 28, 18]) sys(a, 'kill', { pid: b.pid, sig });
  assert.equal(b.state, 'running');
  // signal 0 checks only
  sys(a, 'kill', { pid: b.pid, sig: 0 });
  sys(a, 'kill', { pid: 0, sig: 0 });
  assert.equal(b.state, 'running');
  assert.equal(errCode(() => sys(a, 'kill', { pid: 99, sig: 0 })), 'ESRCH');
  assert.equal(errCode(() => sys(a, 'kill', { pid: b.pid, sig: 65 })), 'EINVAL');
  assert.equal(errCode(() => sys(a, 'kill', { pid: -999, sig: 15 })), 'ESRCH');
  // SIGPWR is SIGPWR, not SIGTERM
  sys(c, 'kill', { pid: -a.pgid, sig: 30 });
  assert.deepEqual(b.status, { code: null, signal: 'SIGPWR' });
  assert.deepEqual(a.status, { code: null, signal: 'SIGPWR' });
  assert.equal(c.state, 'running');
  // pid 0: the caller's group
  const d = node({ ppid: c.pid });
  const e = node({ pgid: 0 });
  sys(c, 'kill', { pid: 0, sig: 'SIGUSR1' });
  assert.equal(d.status?.signal, 'SIGUSR1');
  assert.equal(c.status?.signal, 'SIGUSR1');
  assert.equal(e.state, 'running');
  // -1: everybody but the caller
  const f = node({ pgid: 0 });
  sys(e, 'kill', { pid: -1, sig: 'SIGRTMIN' });
  assert.equal(f.status?.signal, 'SIGRTMIN');
  assert.equal(e.state, 'running');
  // a handler gets it
  sys(e, 'sigaction', { sig: 'SIGPWR', on: true });
  k.kill(e.pid, 30);
  assert.equal(e.state, 'running');
});

test('umask: inherited, applied by open(O_CREAT), mkdir and bind, nowhere else', async () => {
  const { k, node, sys } = makeKernel();
  const p = node();
  assert.equal(sys(p, 'umask', { mask: 0 }), 0o022);
  const child = node({ ppid: p.pid });
  assert.equal(child.umask, 0);
  sys(child, 'mkdir', { p: '/tmp/d', mode: 0o777 });
  assert.equal(k.vfs.stat('/tmp/d').mode & 0o7777, 0o777);
  const fd = sys(child, 'open', { p: '/tmp/f', flags: 0o101, mode: 0o666 }) as number;
  sys(child, 'close', { fd });
  assert.equal(k.vfs.stat('/tmp/f').mode & 0o7777, 0o666);
  sys(child, 'umask', { mask: 0o077 });
  sys(child, 'writeFile', { p: '/tmp/g', mode: 0o666 }, new Uint8Array(1));
  assert.equal(k.vfs.stat('/tmp/g').mode & 0o7777, 0o600);
  sys(child, 'mkdir', { p: '/tmp/e/f', recursive: true });
  assert.equal(k.vfs.stat('/tmp/e/f').mode & 0o7777, 0o700);
  sys(child, 'chmod', { p: '/tmp/g', mode: 0o666 });
  assert.equal(k.vfs.stat('/tmp/g').mode & 0o7777, 0o666);
  // builtin programs and the shell's redirections use the umask of their process
  const r = await run(k, 'umask 077; mkdir /tmp/sd; echo > /tmp/sf; touch /tmp/st');
  assert.equal(r.stderr, '');
  assert.equal(k.vfs.stat('/tmp/sd').mode & 0o7777, 0o700);
  assert.equal(k.vfs.stat('/tmp/sf').mode & 0o7777, 0o600);
  assert.equal(k.vfs.stat('/tmp/st').mode & 0o7777, 0o600);
});

test('lutimes, O_NOFOLLOW, rmdir and rm of the root', () => {
  const { k, node, sys } = makeKernel();
  const p = node();
  k.vfs.writeFile('/tmp/t', 'x');
  k.vfs.symlink('/tmp/t', '/tmp/l');
  sys(p, 'utimes', { p: '/tmp/l', atime: 1000, mtime: 2000, l: true });
  assert.equal(k.vfs.lstat('/tmp/l').mtimeMs, 2000);
  assert.notEqual(k.vfs.stat('/tmp/t').mtimeMs, 2000);
  assert.equal(errCode(() => sys(p, 'open', { p: '/tmp/l', flags: 0o400000 })), 'ELOOP');
  assert.equal(errCode(() => sys(p, 'open', { p: '/tmp/l', flags: 0o400001 })), 'ELOOP');
  assert.equal(errCode(() => sys(p, 'rmdir', { p: '/' })), 'EBUSY');
  assert.equal(errCode(() => k.vfs.rmrf('/')), 'EBUSY');
  assert.ok(k.vfs.exists('/tmp/t'));
  assert.equal(errCode(() => k.vfs.unlink('/')), 'EISDIR');
});

test('exited processes are dropped, also when they had children', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { k, node, sys } = makeKernel();
  const parent = node();
  const child = node({ ppid: parent.pid });
  sys(parent, 'exit', { code: 0 });
  assert.equal(child.ppid, 0);
  t.mock.timers.tick(60_000);
  assert.equal(k.procs.has(parent.pid), false);
  assert.equal(k.procs.has(child.pid), true);
  sys(child, 'exit', { code: 0 });
  t.mock.timers.tick(60_000);
  assert.equal(k.procs.has(child.pid), false);
});

test('TCP: the connecting side has an ephemeral port the server sees', () => {
  const { k, node, sys, sent } = makeKernel();
  const server = node();
  const client = node();
  const port = sys(server, 'listen', { port: 0, kind: 'raw' }) as number;
  const r = sys(client, 'tcpConnect', { port, host: '127.0.0.1' }) as any;
  assert.ok(r.localPort >= 32768 && r.localPort <= 60999);
  assert.equal(r.localAddress, '127.0.0.1');
  const accept = sent.find((s) => s.name.startsWith(`node:${server.pid}:`))!.msgs.find((m) => m.t === 'tcp-accept');
  assert.equal(accept.remotePort, r.localPort);
  const r2 = sys(client, 'tcpConnect', { port, host: '::1' }) as any;
  assert.notEqual(r2.localPort, r.localPort);
  assert.equal(r2.localAddress, '::1');
  void k;
});

test('RLIMIT_NOFILE limits descriptors', () => {
  const { node, sys } = makeKernel();
  const p = node();
  p.nofile = 16;
  const fds: number[] = [];
  for (let i = 0; i < 13; i++) fds.push(sys(p, 'open', { p: '/dev/null' }) as number);
  assert.equal(fds.at(-1), 15);
  assert.equal(errCode(() => sys(p, 'open', { p: '/tmp/new', flags: 0o101 })), 'EMFILE');
  assert.equal(errCode(() => sys(p, 'stat', { p: '/tmp/new' })), 'ENOENT');
  assert.equal(errCode(() => sys(p, 'spawn', { argv: ['true'] })), 'EMFILE');
  assert.equal(p.fds.size, 13);
});

test('a recursive watch on / sees everything', () => {
  const { k, node, sys, sent } = makeKernel();
  const p = node();
  sys(p, 'watch', { id: 1, p: '/', recursive: true });
  k.vfs.writeFile('/tmp/w', 'x');
  const msgs = sent.find((s) => s.name.startsWith(`node:${p.pid}:`))!.msgs.filter((m) => m.t === 'watch');
  assert.ok(msgs.some((m) => m.path === '/tmp/w'));
});

test('PATH: an empty entry is the working directory', async () => {
  const { k } = makeKernel();
  k.vfs.mkdir('/tmp/bin', 0o755);
  k.vfs.writeFile('/tmp/bin/hello', 'echo hi\n', 0o755);
  const r = await run(k, 'PATH=/bin: ; cd /tmp/bin && hello');
  assert.equal(r.stdout, 'hi\n');
});

test('shebang: one argument after the interpreter; env -S splits it and applies NAME=value', () => {
  const { k } = makeKernel();
  k.vfs.writeFile('/tmp/a', '#!/usr/bin/env -S FOO=1 BAR="x y" node --a --b\n', 0o755);
  const plan = k.planExec(['/tmp/a', 'z'], { PATH: '/usr/bin:/bin' }, '/');
  assert.deepEqual(plan.argv, ['node', '--a', '--b', '/tmp/a', 'z']);
  assert.equal(plan.env?.FOO, '1');
  assert.equal(plan.env?.BAR, 'x y');
  k.vfs.writeFile('/tmp/b', '#!/usr/bin/node  --a --b  \n', 0o755);
  assert.deepEqual(k.planExec(['/tmp/b'], {}, '/').argv, ['node', '--a --b', '/tmp/b']);
  k.vfs.writeFile('/tmp/c', '#!/bin/sh -e -x\n', 0o755);
  assert.deepEqual(k.planExec(['/tmp/c'], {}, '/').argv, ['/bin/sh', '-e -x', '/tmp/c']);
  assert.equal(errCode(() => k.planExec(['/tmp/d'], {}, '/')), 'ENOENT');
  k.vfs.writeFile('/tmp/d', '#!/usr/bin/env node --flag\n', 0o755);
  assert.equal(errCode(() => k.planExec(['/tmp/d'], { PATH: '/usr/bin' }, '/')), 'ENOENT');
  assert.deepEqual(envShebang("-S -i A=${HOME}x 'q r' s\\_t # comment", { HOME: '/h', X: '1' }), { argv: ['q r', 's t'], env: { A: '/hx' } });
});

test('a process keeps the runtime it started with for its threads', () => {
  const { node, sent, setRuntime, k } = makeKernel();
  setRuntime('port');
  const p = node();
  setRuntime('legacy');
  k.startThread(p, { kind: 'thread' });
  const mine = sent.filter((s) => s.name.startsWith(`node:${p.pid}:`));
  assert.deepEqual(mine.map((s) => s.runtime), ['port', 'port']);
});

test('permission bits apply to processes (uid 1000 is not root)', () => {
  const { k, node, sys } = makeKernel();
  const p = node();
  k.vfs.writeFile('/tmp/ro', 'x', 0o444);
  k.vfs.writeFile('/tmp/wo', 'x', 0o200);
  assert.equal(errCode(() => sys(p, 'open', { p: '/tmp/ro', flags: 1 })), 'EACCES');
  assert.equal(errCode(() => sys(p, 'open', { p: '/tmp/ro', flags: 0o1000 })), 'EACCES');
  assert.equal(errCode(() => sys(p, 'writeFile', { p: '/tmp/ro' }, new Uint8Array(1))), 'EACCES');
  assert.equal(errCode(() => sys(p, 'readFile', { p: '/tmp/wo' })), 'EACCES');
  assert.equal(errCode(() => sys(p, 'access', { p: '/tmp/ro', mode: 2 })), 'EACCES');
  assert.equal(sys(p, 'access', { p: '/tmp/ro', mode: 4 }), null);
  assert.equal(typeof sys(p, 'open', { p: '/tmp/ro', flags: 0 }), 'number');
  // a file created read-only can be written through the descriptor that created it
  const fd = sys(p, 'open', { p: '/tmp/new', flags: 0o101, mode: 0o444 }) as number;
  assert.equal(sys(p, 'write', { fd }, new Uint8Array(3)), 3);
  assert.equal(errCode(() => sys(p, 'ftruncate', { fd: sys(p, 'open', { p: '/tmp/ro', flags: 0 }) })), 'EINVAL');
});

test('/proc agrees with the ported runtime\'s os module', () => {
  const { k } = makeKernel();
  const dec = new TextDecoder();
  assert.match(dec.decode(k.vfs.readFile('/proc/meminfo')), /MemTotal:\s+8388608 kB/);
  const cpus = dec.decode(k.vfs.readFile('/proc/cpuinfo')).match(/^processor/gm)!.length;
  assert.equal(cpus, navigator.hardwareConcurrency || 4);
});
