// internalBinding('wasi') — node_wasi.cc's WASI wrap. The preview1 calls themselves come from the
// kernel-backed implementation in src/node/wasi.ts; this only gives them the binding's shape.

import { Preview1 } from '../../node/wasi.ts';
import { S } from '../state.ts';

class WASI {
  constructor(args: string[], env: string[], preopens: string[], stdio: number[]) {
    const pre: Record<string, string> = {};
    for (let i = 0; i < preopens.length; i += 2) pre[preopens[i]] = preopens[i + 1];
    // lib/wasi.js has already turned env into KEY=value strings (leaving out undefined values)
    const impl = new Preview1({ args, env, preopens: pre, stdin: stdio[0], stdout: stdio[1], stderr: stdio[2] });
    // lib/wasi.js binds every enumerable member and hands them to WebAssembly as the import object
    Object.assign(this, impl.wasiImport);
    (this as any).proc_exit = (code: number) => S.process.reallyExit(code >>> 0);
    (this as any)._setMemory = (memory: WebAssembly.Memory) => impl.setMemory(memory);
  }
}

export function createWasiBinding() {
  return { WASI };
}
