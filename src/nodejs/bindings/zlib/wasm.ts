// Loads the brotli / zstd WebAssembly modules built by wasm/build.mjs. They are embedded as
// raw-deflated base64 so the bundle stays smaller; decoding and compiling happen once, on first
// use, synchronously (new WebAssembly.Module). Each compression stream gets its own Instance; a
// closed stream gives it back for the next one (a browser only allows so many live wasm memories,
// and a loop of short streams would otherwise run out before GC frees them).

import { inflateRaw } from 'pako';

// Node's bootstrap replaces web globals such as atob with lib implementations that call back into
// bindings, so capture the native one while the worker script loads.
const nativeAtob = globalThis.atob;

export interface WasmExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  ov_io(): number;
  [name: string]: any;
}

function decode(b64: string, size: number): Uint8Array<ArrayBuffer> {
  const bin = nativeAtob(b64);
  const packed = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
  const raw = inflateRaw(packed) as Uint8Array;
  if (raw.length !== size) throw new Error('corrupt embedded wasm');
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  out.set(raw);
  return out;
}

const imports = { env: { log2: Math.log2, log: Math.log } };

const kPoolSize = 8;

export function wasmLoader(load: () => { WASM_SIZE: number; WASM_DEFLATED_B64: string }) {
  let mod: WebAssembly.Module | null = null;
  const idle: WasmExports[] = [];
  const acquire = (): WasmExports => {
    const w = idle.pop();
    if (w) return w;
    if (!mod) {
      const { WASM_SIZE, WASM_DEFLATED_B64 } = load();
      mod = new WebAssembly.Module(decode(WASM_DEFLATED_B64, WASM_SIZE));
    }
    return new WebAssembly.Instance(mod, imports).exports as unknown as WasmExports;
  };
  /** Takes back an instance whose stream freed everything it allocated. */
  const release = (w: WasmExports) => {
    if (idle.length < kPoolSize && !idle.includes(w)) idle.push(w);
  };
  return Object.assign(acquire, { release });
}

/** A grow-only scratch buffer inside an instance's heap. */
export class Scratch {
  ptr = 0;
  cap = 0;
  constructor(private w: WasmExports) {}
  release() {
    if (this.ptr) this.w.free(this.ptr);
    this.ptr = 0;
    this.cap = 0;
  }
  reserve(n: number): number {
    if (n > this.cap) {
      if (this.ptr) this.w.free(this.ptr);
      this.cap = Math.max(n, 1024);
      this.ptr = this.w.malloc(this.cap);
      if (!this.ptr) {
        this.cap = 0;
        throw new RangeError('wasm: out of memory');
      }
    }
    return this.ptr;
  }
}

export function cString(w: WasmExports, p: number): string {
  const m = new Uint8Array(w.memory.buffer);
  let e = p;
  while (m[e]) e++;
  let s = '';
  for (let i = p; i < e; i++) s += String.fromCharCode(m[i]);
  return s;
}
