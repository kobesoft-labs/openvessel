// Emits dist/types/** (the type declarations of the host API) and points their imports at .js.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist/types');
rmSync(out, { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.types.json'], { cwd: root, stdio: 'inherit' });

(function fix(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) fix(p);
    else if (name.endsWith('.d.ts')) writeFileSync(p, readFileSync(p, 'utf8').replace(/(from\s+'\.[^']*)\.ts'/g, "$1.js'"));
  }
})(out);
