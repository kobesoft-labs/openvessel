// cn-font-split: the published package (its dist/) plus the wasm32-wasip1 build of its library,
// which the project releases next to the native ones (the npm postinstall downloads "latest").
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const NPM_VERSION = '7.4.3';
export const LIB_VERSION = '7.6.8';

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function build(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const tgz = join(outDir, 'pkg.tgz');
  writeFileSync(tgz, await download(`https://registry.npmjs.org/cn-font-split/-/cn-font-split-${NPM_VERSION}.tgz`));
  execFileSync('tar', ['-xzf', tgz, '-C', outDir]);
  rmSync(tgz);
  writeFileSync(join(outDir, 'package/dist/libffi-wasm32-wasip1.wasm'), await download(`https://github.com/KonghaYao/cn-font-split/releases/download/${LIB_VERSION}/libffi-wasm32-wasip1.wasm`));
}
