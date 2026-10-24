// Compat packages: stand-ins for npm packages that only ship native binaries. Each is packed as an
// npm tarball into dist/runtime/compat/, and the npm installer (src/kernel/npm/install.ts) installs
// it in place of the native package (keeping the requested name and version).
//
//   compat/<id>/package/   the files of the package (package.json is written here)
//   compat/<id>/build.mjs  optional: builds artifacts into vendor/compat/<id>/ (cached; git-ignored)
//
//   node scripts/build-compat.mjs            (also run by scripts/build.mjs)
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

/** name: the package it replaces; range: the versions it stands in for. */
const COMPAT = [
  {
    id: 'pagefind',
    names: ['@pagefind/linux-x64'], // process.arch is x64 here
    range: '^1.0.0',
    pkg: { name: '@openvessel/pagefind-wasi', version: '1.5.2', description: "Pagefind's indexer as wasm32-wasi (OpenVessel)", license: 'MIT' },
    artifacts: { 'pagefind.wasm': 'pagefind.wasm' },
  },
  {
    id: 'resvg-js',
    names: ['@resvg/resvg-js'],
    range: '^2.0.0',
    pkg: { name: '@openvessel/resvg-js-wasm', version: '2.6.2', description: '@resvg/resvg-js on @resvg/resvg-wasm (OpenVessel)', license: 'MPL-2.0', main: 'index.js', types: 'index.d.ts', dependencies: { '@resvg/resvg-wasm': '2.6.2' } },
  },
];

export async function buildCompat(outDir) {
  mkdirSync(outDir, { recursive: true });
  const index = {};
  for (const c of COMPAT) {
    const art = join(root, 'vendor/compat', c.id);
    const script = join(root, 'compat', c.id, 'build.mjs');
    const missing = Object.values(c.artifacts ?? {}).some((f) => !existsSync(join(art, f)));
    if (missing && existsSync(script)) {
      try {
        await (await import(script)).build(art);
      } catch (e) {
        console.warn(`compat ${c.id}: not built (${e.message}); ${c.names.join(', ')} will stay unavailable`);
        continue;
      }
    }
    const stage = mkdtempSync(join(tmpdir(), `ov-compat-${c.id}-`));
    const pkgDir = join(stage, 'package');
    cpSync(join(root, 'compat', c.id, 'package'), pkgDir, { recursive: true });
    for (const [from, to] of Object.entries(c.artifacts ?? {})) cpSync(join(art, from), join(pkgDir, to));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(c.pkg, null, 2) + '\n');
    const file = `${c.id}-${c.pkg.version}.tgz`;
    // ustar with a "package/" prefix, like `npm pack`
    execFileSync('tar', ['-czf', join(outDir, file), '--format', 'ustar', '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    rmSync(stage, { recursive: true, force: true });
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(join(outDir, file))).digest('base64');
    for (const name of c.names) index[name] = { range: c.range, file, integrity, pkg: c.pkg };
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = await buildCompat(join(root, 'dist/runtime/compat'));
  console.log(`compat: ${Object.keys(index).join(', ')}`);
}
