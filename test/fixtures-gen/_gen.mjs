// Runs a case module against the real Node's internalBinding(name) and writes the expected results
// to test/unit/fixtures/<name>.json. Must run under the Node version OpenVessel ports:
//
//   node scripts/regen-fixtures.mjs   (runs every generator under node@<src/node/version.ts>)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

/** The Node version OpenVessel ports (src/node/version.ts). */
export const NODE_VERSION = /NODE_VERSION = '([^']+)'/.exec(readFileSync(new URL('../../src/node/version.ts', import.meta.url), 'utf8'))[1];

const require = createRequire(import.meta.url);

export function generate(name, run) {
  if (process.version !== `v${NODE_VERSION}`) throw new Error(`run with node@${NODE_VERSION} (got ${process.version})`);
  const { internalBinding } = require('internal/test/binding');
  const results = run(internalBinding(name));
  const file = new URL(`../unit/fixtures/${name}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ node: process.version, results }) + '\n');
  console.log(`wrote ${file.pathname}`);
}
