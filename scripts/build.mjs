// Builds dist/{runtime,preview,host,playground}.
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { genNodeLib } from './gen-nodelib.mjs';
import { buildCompat } from './build-compat.mjs';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const alias = {
  events: join(root, 'src/node/events.ts'),
  process: join(root, 'src/node/shims/process.ts'),
  string_decoder: join(root, 'src/node/string_decoder.ts'),
  'abort-controller': join(root, 'src/node/shims/abort-controller.ts'),
};

const slashAliases = {
  name: 'slash-aliases',
  setup(b) {
    b.onResolve({ filter: /^(process|string_decoder)\/$/ }, (a) => ({ path: alias[a.path.slice(0, -1)] }));
    b.onResolve({ filter: /^cjs-module-lexer\/lexer\.js$/ }, () => ({ path: join(root, 'node_modules/cjs-module-lexer/lexer.js') }));
  },
};

const nodelibExternal = {
  name: 'nodelib-external',
  setup(b) {
    b.onResolve({ filter: /^\.\/nodelib\.js$/ }, () => ({ path: './nodelib.js', external: true }));
  },
};

const common = { plugins: [slashAliases], bundle: true, sourcemap: 'linked', target: 'es2022', logLevel: 'warning', legalComments: 'none', minify, platform: 'browser', alias, define: { global: 'globalThis' } };

const configs = [
  { ...common, entryPoints: { kernel: 'src/kernel/index.ts', process: 'src/node/worker.ts' }, outdir: join(dist, 'runtime'), format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]' },
  { ...common, entryPoints: { runtime: 'src/runtime/runtime.ts', sw: 'src/runtime/sw.ts' }, outdir: join(dist, 'runtime'), format: 'iife' },
  // the ported Node.js (src/nodejs); nodelib.js is generated next to it
  { ...common, plugins: [...common.plugins, nodelibExternal], entryPoints: { 'node-process': 'src/nodejs/boot.ts' }, outdir: join(dist, 'runtime'), format: 'esm', alias: {} },
  { ...common, entryPoints: { 'ts-strip': 'src/nodejs/ts-strip.ts' }, outdir: join(dist, 'runtime'), format: 'iife', alias: {} },
  { ...common, entryPoints: { sw: 'src/preview/sw.ts', relay: 'src/preview/relay.ts', inject: 'src/preview/inject.ts' }, outdir: join(dist, 'preview/__ov'), format: 'iife' },
  { ...common, entryPoints: { index: 'src/host/index.ts' }, outdir: join(dist, 'host'), format: 'esm' },
  { ...common, entryPoints: { app: 'playground/app.ts' }, outdir: join(dist, 'playground'), format: 'esm', loader: { '.css': 'css' } },
];

function copyStatic() {
  mkdirSync(join(dist, 'runtime'), { recursive: true });
  mkdirSync(join(dist, 'preview/__ov'), { recursive: true });
  mkdirSync(join(dist, 'playground'), { recursive: true });
  cpSync(join(root, 'src/runtime/runtime.html'), join(dist, 'runtime/runtime.html'));
  cpSync(join(root, 'src/preview/relay.html'), join(dist, 'preview/__ov/relay.html'));
  cpSync(join(root, 'playground/index.html'), join(dist, 'playground/index.html'));
  cpSync(join(root, 'playground/app.css'), join(dist, 'playground/app.css'));
  cpSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(dist, 'playground/xterm.css'));
}

if (!watch) rmSync(dist, { recursive: true, force: true });
copyStatic();
if (watch) {
  for (const c of configs) {
    const ctx = await context(c);
    await ctx.watch();
  }
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => build(c)));
  if (existsSync(join(root, 'vendor/node/natives.json'))) {
    genNodeLib(join(dist, 'runtime/nodelib.js'));
    // nodelib.js is Node.js's lib/ and deps/: its license (with the bundled deps' notices) ships with it
    cpSync(join(root, 'vendor/node/LICENSE'), join(dist, 'runtime/NODE-LICENSE.txt'));
  }
  else console.warn('vendor/node missing: run node scripts/gen-node-data.mjs to build the ported Node runtime');
  await buildCompat(join(dist, 'runtime/compat'));
  console.log('built dist/');
}
