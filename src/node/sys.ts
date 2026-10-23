// Syscall client used by the node runtime inside a process worker.

import { nodeSystemError } from '../shared/errno.ts';
import { SyncClient } from '../shared/syncchan.ts';

export class SysError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let client: SyncClient | null = null;
let postToKernel: (msg: unknown, transfer?: Transferable[]) => void = () => {};

export function initSys(sab: SharedArrayBuffer, post: (msg: unknown, transfer?: Transferable[]) => void) {
  postToKernel = post;
  client = new SyncClient(sab, () => post({ t: 'sys' }));
}

/** Synchronous syscall. Returns the value (or Uint8Array / {..., bin}). Throws SysError. */
export function sys<T = any>(op: string, args: Record<string, unknown> = {}, bin?: Uint8Array): T {
  if (!client) throw new Error('syscalls not initialised');
  const r = client.call({ json: { op, ...args }, bin });
  const j = r.json as { ok?: any; err?: string; msg?: string; bin?: boolean };
  if (j.err) throw new SysError(j.err, j.msg ?? j.err);
  if (j.bin) {
    if (j.ok === null || j.ok === undefined) return r.bin ?? (new Uint8Array(0) as any);
    return { ...j.ok, bin: r.bin ?? new Uint8Array(0) } as T;
  }
  return j.ok as T;
}

/** Fire-and-forget message to the kernel. */
export function post(msg: unknown, transfer: Transferable[] = []) {
  postToKernel(msg, transfer);
}

/** Wraps a syscall so failures become Node-style errors (`ENOENT: ..., open '/x'`). */
export function fsCall<T>(syscall: string, pathArg: string | undefined, fn: () => T, dest?: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SysError) {
      const err = nodeSystemError(e.code, syscall, pathArg, dest);
      Error.captureStackTrace?.(err, fsCall);
      throw err;
    }
    throw e;
  }
}
