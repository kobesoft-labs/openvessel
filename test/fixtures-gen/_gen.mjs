// Runs a case module against the real Node's internalBinding(name) and writes the expected results
// to test/unit/fixtures/<name>.json. Must run under the Node version OpenVessel ports:
//
//   npx -y node@22.20.0 --expose-internals --no-warnings test/fixtures-gen/<name>.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

export function generate(name, run) {
  if (process.version !== 'v22.20.0') throw new Error(`run with node@22.20.0 (got ${process.version})`);
  const { internalBinding } = require('internal/test/binding');
  const results = run(internalBinding(name));
  const file = new URL(`../unit/fixtures/${name}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ node: process.version, results }) + '\n');
  console.log(`wrote ${file.pathname}`);
}
