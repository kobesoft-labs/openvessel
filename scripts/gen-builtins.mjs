// Generates the named-export lists for builtin ESM facades (src/shared/builtin-exports.json) from the
// Node.js of the pinned version (src/node/version.ts), run in the official linux/amd64 image like
// scripts/gen-node-data.mjs. Needs Docker.
//   node scripts/gen-builtins.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const version = /NODE_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/node/version.ts'), 'utf8'))[1];

const lister = String.raw`
import { builtinModules } from 'node:module';
const out = {};
const ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// node:-only modules (node:test, node:sqlite, ...) are not in builtinModules
for (const name of [...builtinModules, 'sea', 'sqlite', 'test', 'test/reporters']) {
  if (name.startsWith('_') || name.startsWith('node:')) continue;
  try {
    const ns = await import('node:' + name);
    out[name] = Object.keys(ns).filter((k) => k !== 'default' && ID.test(k)).sort();
  } catch {}
}
process.stdout.write(JSON.stringify(out));
`;
// the lister comes in on stdin as an ES module
const raw = execFileSync('docker', ['run', '--rm', '-i', '--platform', 'linux/amd64', `node:${version}-bookworm-slim`, 'node', '--no-warnings', '--input-type=module', '-'], { input: lister, maxBuffer: 1 << 26, encoding: 'utf8' });
const out = JSON.parse(raw);
writeFileSync(join(root, 'src/shared/builtin-exports.json'), JSON.stringify(out, null, 0));
console.log(`node v${version}: ${Object.keys(out).length} builtins`);
