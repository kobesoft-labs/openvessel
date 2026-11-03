// Runs `npm install && npm run build` for each corpus site in headless Chrome.
//   node corpus/run.mjs [--legacy] [--shard=i/n] [filter...]   results → corpus/results/port/ (the default, ported runtime) or corpus/results/ (--legacy)
//   --shard=i/n runs every n-th site from the i-th (1-based), so n runs with different OV_PORT_BASE values share the work
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, openBrowser, exec } from '../test/e2e/harness.mjs';
import { mountProject } from '../test/e2e/project.mjs';

const root = new URL('.', import.meta.url).pathname;
const port = !process.argv.includes('--legacy');
const outDir = join(root, port ? 'results/port' : 'results');
mkdirSync(join(outDir, 'logs'), { recursive: true });
const sites = JSON.parse(readFileSync(join(root, 'sites.json'), 'utf8'));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const shard = /^--shard=(\d+)\/(\d+)$/.exec(process.argv.find((a) => a.startsWith('--shard=')) ?? '');
const todo = sites.filter((s) => !filters.length || filters.some((f) => s.id.includes(f))).filter((_, i) => !shard || i % Number(shard[2]) === Number(shard[1]) - 1);
const resultsPath = join(outDir, 'results.json');
const readResults = () => (existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {});
let results = readResults();
/** Records one site; re-reads the file first, so shards running side by side keep each other's results. */
function saveResult(r) {
  results = { ...readResults(), [r.id]: r };
  const tmp = `${resultsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(results, null, 2));
  renameSync(tmp, resultsPath);
}
// OV_CORPUS_MINUTES: how long install and build may each take (default 15)
const STEP_MS = Number(process.env.OV_CORPUS_MINUTES ?? 15) * 60e3;
const env = (port ? '' : 'mkdir -p /etc/openvessel && echo legacy > /etc/openvessel/node; ') + 'export CI=1 ASTRO_TELEMETRY_DISABLED=1;';

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
      await Promise.race([session.page.evaluate(() => window.ovReady), new Promise((_, j) => setTimeout(() => j(new Error('runtime did not boot in 60 s')), 60000))]);
      await mountProject(session.page, join(root, 'sites', s.id));
      const pm = packageManagerOf(join(root, 'sites', s.id));
      const inst = await exec(session.page, `${env} ${pm} install 2>&1`, { timeout: STEP_MS });
      r.install = inst.code === 0;
      log += `$ ${pm} install\n${inst.output}\n[exit ${inst.code} ${inst.ms}ms]\n`;
      if (r.install) {
        const b = await exec(session.page, `${env} ${pm} run build 2>&1`, { timeout: STEP_MS });
        r.build = b.code === 0;
        log += `$ ${pm} run build\n${b.output}\n[exit ${b.code} ${b.ms}ms]\n`;
        if (!r.build) r.error = b.output.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
      } else r.error = inst.output.split('\n').filter((l) => l.trim()).slice(-8).join('\n');
    } catch (e) {
      r.error = `harness: ${e.message}`.slice(0, 2000);
      log += r.error;
      // a browser stuck on a hung page may never finish closing: give up on it after 30 s
      await Promise.race([session.browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 30000))]);
      session = await openBrowser();
    }
    r.ms = Date.now() - t0;
    writeFileSync(join(outDir, 'logs', s.id + '.log'), log);
    saveResult(r);
    console.log(`[${i + 1}/${todo.length}] ${r.build ? 'OK  ' : r.install ? 'FAIL' : 'INST'} ${s.id} (${Math.round(r.ms / 1000)}s)${r.build ? '' : '\n      ' + r.error.split('\n').slice(-3).join('\n      ')}`);
  }
} finally {
  await session.browser.close();
  srv.kill();
}
const all = Object.values(results);
console.log(`\nbuild ok: ${all.filter((r) => r.build).length}/${all.length}, install ok: ${all.filter((r) => r.install).length}`);
