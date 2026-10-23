// Linux errno values (as Node reports them, negated in `err.errno`).

export const errnoCodes = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  ERANGE: 34,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENOTSUP: 95,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETUNREACH: 101,
  ECONNRESET: 104,
  ENOTCONN: 107,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EHOSTUNREACH: 113,
  ECANCELED: 125,
} as const;

export type ErrnoCode = keyof typeof errnoCodes;

const messages: Partial<Record<ErrnoCode, string>> = {
  EPERM: 'operation not permitted',
  ENOENT: 'no such file or directory',
  ESRCH: 'no such process',
  EBADF: 'bad file descriptor',
  ECHILD: 'no child processes',
  EAGAIN: 'resource temporarily unavailable',
  EACCES: 'permission denied',
  EBUSY: 'resource busy or locked',
  EEXIST: 'file already exists',
  EXDEV: 'cross-device link not permitted',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  EINVAL: 'invalid argument',
  EMFILE: 'too many open files',
  ENOTTY: 'inappropriate ioctl for device',
  ENOSPC: 'no space left on device',
  ESPIPE: 'invalid seek',
  EROFS: 'read-only file system',
  EPIPE: 'broken pipe',
  ENAMETOOLONG: 'name too long',
  ENOSYS: 'function not implemented',
  ENOTEMPTY: 'directory not empty',
  ELOOP: 'too many symbolic links encountered',
  ENOTSUP: 'operation not supported on socket',
  EADDRINUSE: 'address already in use',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset by peer',
  ENOEXEC: 'exec format error',
  ETIMEDOUT: 'connection timed out',
  ENOTCONN: 'socket is not connected',
};

export function errnoMessage(code: string): string {
  return messages[code as ErrnoCode] ?? code.toLowerCase();
}

/** Error thrown inside the kernel; carries a POSIX code. */
export class KernelError extends Error {
  code: string;
  constructor(code: ErrnoCode | string, message?: string) {
    super(message ?? errnoMessage(code));
    this.code = code;
  }
}

export function kerr(code: ErrnoCode): KernelError {
  return new KernelError(code);
}

/** Builds a Node-style system error (`ENOENT: no such file or directory, open '/x'`). */
export function nodeSystemError(code: string, syscall?: string, path?: string, dest?: string): NodeJS.ErrnoException {
  let msg = `${code}: ${errnoMessage(code)}`;
  if (syscall) msg += `, ${syscall}`;
  if (path !== undefined) msg += ` '${path}'`;
  if (dest !== undefined) msg += ` -> '${dest}'`;
  const err = new Error(msg) as NodeJS.ErrnoException;
  err.code = code;
  const n = errnoCodes[code as ErrnoCode];
  if (n !== undefined) err.errno = -n;
  if (syscall) err.syscall = syscall;
  if (path !== undefined) err.path = path;
  if (dest !== undefined) (err as NodeJS.ErrnoException & { dest?: string }).dest = dest;
  return err;
}
