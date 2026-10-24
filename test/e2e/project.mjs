// Mounts a local project directory into the VFS and runs commands.
//   node test/e2e/project.mjs <dir> ['npm install && npm run build']
import { readdirSync, readFileSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { startServer, openBrowser, exec } from './harness.mjs';

export function collectFiles(dir, { maxFileBytes = 64 * 1024 * 1024 } = {}) {
  const out = {};
  const skip = new Set(['node_modules', '.git', 'dist', '.astro', '.vercel', '.netlify', '.cache', '.turbo', '.output']);
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (skip.has(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(dir, p);
      if (st.isSymbolicLink()) {
        out[rel] = { symlink: readlinkSync(p) };
      } else if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size <= maxFileBytes) out[rel] = readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

export async function mountProject(page, dir, target = '/home/user/app') {
  const files = collectFiles(dir);
  await page.evaluate(
    async ({ files, target }) => {
      const ov = window.ov;
      await ov.fs.rm(target, { recursive: true, force: true });
      const decoded = {};
      for (const [k, v] of Object.entries(files)) decoded[k] = typeof v === 'string' ? Uint8Array.from(atob(v), (c) => c.charCodeAt(0)) : v;
      await ov.mount(decoded, { path: target });
    },
    { files, target },
  );
  return Object.keys(files).length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, cmd = 'npm install && npm run build'] = process.argv.slice(2);
  const srv = await startServer();
  const { browser, page } = await openBrowser({ headless: !process.env.HEADED });
  try {
    const n = await mountProject(page, dir);
    console.log(`mounted ${n} files`);
    const r = await exec(page, cmd, { timeout: 15 * 60 * 1000 });
    process.stdout.write(r.output);
    console.log(`\n[exit ${r.code} in ${r.ms}ms]`);
  } finally {
    await browser.close();
    srv.kill();
  }
}
