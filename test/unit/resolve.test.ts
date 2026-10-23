import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver, type ResolveHost } from '../../src/shared/resolve.ts';

function host(files: Record<string, string>): ResolveHost {
  const dirs = new Set<string>();
  for (const f of Object.keys(files)) {
    let d = f;
    while ((d = d.slice(0, d.lastIndexOf('/')) || '/') !== '/') dirs.add(d);
    dirs.add('/');
  }
  return {
    kind: (p) => (p in files ? 'file' : dirs.has(p) ? 'dir' : null),
    readText: (p) => files[p] ?? null,
    realpath: (p) => p,
  };
}

const app = '/home/user/app';
const nm = `${app}/node_modules`;
const fs = host({
  [`${app}/package.json`]: JSON.stringify({ name: 'app', type: 'module', imports: { '#lib/*': './src/lib/*.js' } }),
  [`${app}/src/main.js`]: '',
  [`${app}/src/util.js`]: '',
  [`${app}/src/lib/a.js`]: '',
  [`${app}/src/dir/index.js`]: '',
  [`${nm}/dual/package.json`]: JSON.stringify({
    name: 'dual',
    exports: { '.': { import: './esm/index.mjs', require: './cjs/index.cjs' }, './feature/*': './dist/feature/*.js', './package.json': './package.json' },
  }),
  [`${nm}/dual/esm/index.mjs`]: '',
  [`${nm}/dual/cjs/index.cjs`]: '',
  [`${nm}/dual/dist/feature/x.js`]: '',
  [`${nm}/legacy/package.json`]: JSON.stringify({ name: 'legacy', main: 'lib/main' }),
  [`${nm}/legacy/lib/main.js`]: '',
  [`${nm}/@scope/pkg/package.json`]: JSON.stringify({ name: '@scope/pkg', exports: './index.js' }),
  [`${nm}/@scope/pkg/index.js`]: '',
});

test('CJS: relative, extensions, directory index, main', () => {
  const r = new Resolver(fs);
  assert.equal(r.resolveCjs('./util', `${app}/src`), `${app}/src/util.js`);
  assert.equal(r.resolveCjs('./dir', `${app}/src`), `${app}/src/dir/index.js`);
  assert.equal(r.resolveCjs('legacy', `${app}/src`), `${nm}/legacy/lib/main.js`);
});

test('exports: conditions, patterns, scoped packages', () => {
  const r = new Resolver(fs);
  assert.equal(r.resolveCjs('dual', `${app}/src`), `${nm}/dual/cjs/index.cjs`);
  assert.equal(r.resolveEsm('dual', `${app}/src/main.js`).path, `${nm}/dual/esm/index.mjs`);
  assert.equal(r.resolveEsm('dual/feature/x', `${app}/src/main.js`).path, `${nm}/dual/dist/feature/x.js`);
  assert.equal(r.resolveEsm('@scope/pkg', `${app}/src/main.js`).path, `${nm}/@scope/pkg/index.js`);
});

test('exports block unlisted subpaths', () => {
  const r = new Resolver(fs);
  assert.throws(() => r.resolveEsm('dual/esm/index.mjs', `${app}/src/main.js`), (e: any) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test('package imports (#)', () => {
  const r = new Resolver(fs);
  assert.equal(r.resolveEsm('#lib/a', `${app}/src/main.js`).path, `${app}/src/lib/a.js`);
});

test('ESM keeps the query string apart', () => {
  const r = new Resolver(fs);
  const res = r.resolveEsm('./util.js?raw', `${app}/src/main.js`);
  assert.equal(res.path, `${app}/src/util.js`);
  assert.equal(res.query, '?raw');
});

test('not found', () => {
  const r = new Resolver(fs);
  assert.throws(() => r.resolveCjs('nope', `${app}/src`), (e: any) => e.code === 'MODULE_NOT_FOUND');
});
