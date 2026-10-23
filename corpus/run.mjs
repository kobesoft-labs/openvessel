// Runs `npm install && npm run build` for each corpus site in headless Chrome.
//   node corpus/run.mjs [--port] [filter...]      results → corpus/results/ (--port: the ported Node runtime, results/port/)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, openBrowser, exec } from '../test/e2e/harness.mjs';
import { mountProject } from '../test/e2e/project.mjs';

const root = new URL('.', import.meta.url).pathname;
const port = process.argv.includes('--port');
const outDir = join(root, port ? 'results/port' : 'results');
mkdirSync(join(outDir, 'logs'), { recursive: true });
const sites = JSON.parse(readFileSync(join(root, 'sites.json'), 'utf8'));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const todo = sites.filter((s) => !filters.length || filters.some((f) => s.id.includes(f)));
const resultsPath = join(outDir, 'results.json');
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};
const env = (port ? 'mkdir -p /etc/openvessel && echo port > /etc/openvessel/node; ' : '') + 'export CI=1 ASTRO_TELEMETRY_DISABLED=1;';

/** The package manager the project asks for (packageManager field, then lockfile). */
function packageManagerOf(dir) {
  try {
    const m = /^(npm|pnpm|yarn|bun)@/.exec(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager ?? '');
    if (m) return m[1];
  } catch {}
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

const srv = await startServer();
let session = await openBrowser();
try {
  for (const [i, s] of todo.entries()) {
    const t0 = Date.now();
    const r = { id: s.id, astro: s.astro, install: null, build: null, ms: 0, error: '' };
    let log = '';
    try {
      await session.page.reload();
      await session.page.evaluate(() => window.ovReady);
      await mountProject(session.page, join(root, 'sites', s.id));
      const pm = packageManagerOf(join(root, 'sites', s.id));
      const inst = await exec(session.page, `${env} ${pm} install 2>&1`, { timeout: 15 * 60e3 });
      r.install = inst.code === 0;
      log += `$ ${pm} install\n${inst.output}\n[exit ${inst.code} ${inst.ms}ms]\n`;
      if (r.install) {
        const b = await exec(session.page, `${env} ${pm} run build 2>&1`, { timeout: 15 * 60e3 });
        r.build = b.code === 0;
        log += `$ ${pm} run build\n${b.output}\n[exit ${b.code} ${b.ms}ms]\n`;
        if (!r.build) r.error = b.output.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
      } else r.error = inst.output.split('\n').filter((l) => l.trim()).slice(-8).join('\n');
    } catch (e) {
      r.error = `harness: ${e.message}`.slice(0, 2000);
      log += r.error;
      try {
        await session.browser.close();
      } catch {}
      session = await openBrowser();
    }
    r.ms = Date.now() - t0;
    results[s.id] = r;
    writeFileSync(join(outDir, 'logs', s.id + '.log'), log);
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`[${i + 1}/${todo.length}] ${r.build ? 'OK  ' : r.install ? 'FAIL' : 'INST'} ${s.id} (${Math.round(r.ms / 1000)}s)${r.build ? '' : '\n      ' + r.error.split('\n').slice(-3).join('\n      ')}`);
  }
} finally {
  await session.browser.close();
  srv.kill();
}
const all = Object.values(results);
console.log(`\nbuild ok: ${all.filter((r) => r.build).length}/${all.length}, install ok: ${all.filter((r) => r.install).length}`);
