// Builds Pagefind's indexer for wasm32-wasip1: the published crate (it carries the web assets the
// binary embeds) with wasi.patch (single-threaded tokio, std::fs for output, a one-loop --service).
// Needs cargo and `rustup target add wasm32-wasip1`.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const VERSION = '1.5.2';
const here = new URL('.', import.meta.url).pathname;

export async function build(outDir) {
  const work = join(tmpdir(), `ov-pagefind-${VERSION}`);
  const src = join(work, `pagefind-${VERSION}`);
  if (!existsSync(join(src, 'src/wasi_fs.rs'))) {
    mkdirSync(work, { recursive: true });
    const res = await fetch(`https://crates.io/api/v1/crates/pagefind/${VERSION}/download`);
    if (!res.ok) throw new Error(`crates.io: ${res.status}`);
    const crate = join(mkdtempSync(join(tmpdir(), 'ov-crate-')), 'pagefind.crate');
    writeFileSync(crate, new Uint8Array(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', crate, '-C', work]);
    execFileSync('patch', ['-p1', '-i', join(here, 'wasi.patch')], { cwd: src, stdio: 'inherit' });
  }
  console.log(`compat pagefind: cargo build --target wasm32-wasip1 (pagefind ${VERSION})…`);
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-wasip1', '--no-default-features'], {
    cwd: src,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, CARGO_PROFILE_RELEASE_STRIP: 'true', CARGO_PROFILE_RELEASE_LTO: 'true', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1' },
  });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(src, 'target/wasm32-wasip1/release/pagefind.wasm'), join(outDir, 'pagefind.wasm'));
}
