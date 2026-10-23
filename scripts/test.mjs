// Bundles unit tests with esbuild and runs them with node:test.
import { build } from 'esbuild';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const outdir = join(root, 'node_modules/.cache/ov-tests');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
const filter = process.argv[2];
const entries = readdirSync(join(root, 'test/unit'))
  .filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)))
  .map((f) => join(root, 'test/unit', f));
await build({
  entryPoints: entries,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  packages: 'external',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});
const files = readdirSync(outdir).filter((f) => f.endsWith('.mjs')).map((f) => join(outdir, f));
const r = spawnSync(process.execPath, ['--enable-source-maps', '--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
