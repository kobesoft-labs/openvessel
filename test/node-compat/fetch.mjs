// Sparse-clones nodejs/node at the version OpenVessel reports (test/common, test/parallel, test/fixtures).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const version = /NODE_VERSION = '([^']+)'/.exec(readFileSync(join(here, '../../src/node/version.ts'), 'utf8'))[1];
const dest = join(here, '.node');
const git = (...a) => execFileSync('git', a, { cwd: existsSync(dest) ? dest : here, stdio: 'inherit' });
if (!existsSync(dest)) git('clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', `v${version}`, 'https://github.com/nodejs/node.git', dest);
else {
  // move an existing checkout to the pinned version
  git('fetch', '--depth', '1', 'origin', 'tag', `v${version}`);
  git('checkout', '-q', `v${version}`);
}
git('sparse-checkout', 'set', 'test/common', 'test/parallel', 'test/fixtures');
// keep the parent repo's "type": "module" from applying to Node's CommonJS tests
writeFileSync(join(dest, 'package.json'), '{ "private": true, "type": "commonjs" }\n');
console.log(`node v${version} tests in ${dest}`);
