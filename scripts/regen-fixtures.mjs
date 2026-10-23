// Re-records the expected results of the binding tests from the real Node of the pinned version
// (src/node/version.ts), after an upgrade: test/unit/fixtures/*.json and the generated tables.
//   node scripts/regen-fixtures.mjs [name…]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const version = /NODE_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/node/version.ts'), 'utf8'))[1];
const node = execFileSync('npx', ['-y', `node@${version}`, '-p', 'process.execPath'], { encoding: 'utf8' }).trim();
const jobs = [
  ['encoding', ['test/fixtures-gen/encoding.mjs']],
  ['string_decoder', ['test/fixtures-gen/string_decoder.mjs']],
  ['url', ['test/fixtures-gen/url.mjs']],
  ['icu', ['test/fixtures-gen/icu.mjs']],
  ['icu-width-table', ['test/fixtures-gen/icu-width-table.mjs']],
  ['http_parser', ['test/fixtures-gen/http_parser.mjs']],
  ['zlib', ['test/fixtures-gen/zlib.mjs']],
  ['serdes', ['test/fixtures-gen/serdes.mjs']],
  ['histogram', ['test/fixtures-gen/histogram.mjs']],
  ['crypto', ['test/fixtures-gen/crypto.mjs']],
  ['crypto-asym', ['test/fixtures-gen/crypto-asym.mjs']],
  ['crypto-tables', ['test/fixtures-gen/crypto-tables.cjs', 'src/nodejs/bindings/crypto/tables.ts']],
];
const only = process.argv.slice(2);
for (const [name, args] of jobs) {
  if (only.length && !only.includes(name)) continue;
  process.stdout.write(`${name}… `);
  execFileSync(node, ['--expose-internals', '--no-warnings', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
  console.log('ok');
}
console.log(`fixtures recorded from node v${version}`);
