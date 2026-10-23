// Generates the named-export lists for builtin ESM facades from the host Node.
import { writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
const out = {};
const ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
for (const name of builtinModules) {
  if (name.startsWith('_')) continue;
  try {
    const ns = await import('node:' + name);
    out[name] = Object.keys(ns).filter((k) => k !== 'default' && ID.test(k)).sort();
  } catch {}
}
writeFileSync(new URL('../src/shared/builtin-exports.json', import.meta.url), JSON.stringify(out, null, 0));
console.log(Object.keys(out).length, 'builtins');
