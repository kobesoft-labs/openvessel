import { Kernel } from '../../src/kernel/kernel.ts';
import { createPipe, type OpenFile } from '../../src/kernel/io.ts';
import { installCoreutils } from '../../src/kernel/coreutils.ts';
import { shProgram } from '../../src/kernel/sh/interp.ts';
import { exitCodeOf } from '../../src/kernel/proc.ts';

export function makeKernel() {
  const k = new Kernel({
    createWorker: () => {
      throw new Error('no workers in unit tests');
    },
  });
  k.registerProgram('sh', shProgram, ['/bin']);
  k.registerProgram('bash', shProgram, ['/bin']);
  installCoreutils(k);
  return k;
}

async function readAll(f: OpenFile) {
  const dec = new TextDecoder();
  let s = '';
  for (;;) {
    const d = await f.read(65536);
    if (!d.length) break;
    s += dec.decode(d, { stream: true });
  }
  return s;
}

export async function run(k: Kernel, script: string, cwd = '/home/user', argv?: string[]) {
  const out = createPipe();
  const err = createPipe();
  const inp = createPipe();
  inp.w.unref();
  const p = k.spawn({ argv: argv ?? ['sh', '-c', script], cwd, stdio: [inp.r, out.w, err.w] });
  inp.r.unref();
  out.w.unref();
  err.w.unref();
  const [stdout, stderr, st] = await Promise.all([readAll(out.r), readAll(err.r), p.exited]);
  return { stdout, stderr, code: exitCodeOf(st) };
}
