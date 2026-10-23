// node:os

let hostnameValue = 'openvessel';
let homeValue = '/home/user';
export function setOsInfo(info: { hostname?: string; home?: string }) {
  if (info.hostname) hostnameValue = info.hostname;
  if (info.home) homeValue = info.home;
}

export const EOL = '\n';
export const devNull = '/dev/null';
export const constants = {
  UV_UDP_REUSEADDR: 4,
  dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0 },
  errno: { E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EAGAIN: 11, EBADF: 9, EBUSY: 16, ECONNREFUSED: 111, ECONNRESET: 104, EEXIST: 17, EINTR: 4, EINVAL: 22, EIO: 5, EISDIR: 21, EMFILE: 24, ENOENT: 2, ENOMEM: 12, ENOSPC: 28, ENOTDIR: 20, ENOTEMPTY: 39, EPERM: 1, EPIPE: 32, ETIMEDOUT: 110 },
  signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31 },
  priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
};

export function hostname() {
  return hostnameValue;
}
export function homedir() {
  return (globalThis as any).process?.env?.HOME ?? homeValue;
}
export function tmpdir() {
  const t = (globalThis as any).process?.env?.TMPDIR;
  return t ? t.replace(/(.)\/$/, '$1') : '/tmp';
}
export function platform() {
  return 'linux';
}
export function type() {
  return 'Linux';
}
export function release() {
  return '6.1.0-openvessel';
}
export function version() {
  return '#1 SMP OpenVessel';
}
export function arch() {
  return 'x64';
}
export function machine() {
  return 'x86_64';
}
export function endianness() {
  return 'LE';
}
export function uptime() {
  return Math.floor(performance.now() / 1000);
}
export function loadavg() {
  return [0, 0, 0];
}
export function totalmem() {
  return 4 * 1024 ** 3;
}
export function freemem() {
  return 2 * 1024 ** 3;
}
export function availableParallelism() {
  return Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
}
export function cpus() {
  const n = availableParallelism();
  return Array.from({ length: n }, () => ({ model: 'OpenVessel virtual CPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
}
export function networkInterfaces() {
  return {
    lo: [
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
      { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 },
    ],
  };
}
export function userInfo(_opts?: unknown) {
  return { uid: 1000, gid: 1000, username: 'user', homedir: homedir(), shell: '/bin/sh' };
}
export function getPriority() {
  return 0;
}
export function setPriority() {}

export default { EOL, devNull, constants, hostname, homedir, tmpdir, platform, type, release, version, arch, machine, endianness, uptime, loadavg, totalmem, freemem, availableParallelism, cpus, networkInterfaces, userInfo, getPriority, setPriority };
