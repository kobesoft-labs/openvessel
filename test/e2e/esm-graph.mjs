// Walks the ESM graph served by the runtime SW and reports modules that don't load.
//   node test/e2e/esm-graph.mjs <project dir> <entry path in VFS> [install command]
import { startServer, openBrowser, exec } from './harness.mjs';
import { mountProject } from './project.mjs';

const [dir, entry, install = 'npm install'] = process.argv.slice(2);
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  await page.evaluate(() => window.ovReady);
  await mountProject(page, dir);
  const inst = await exec(page, `${install} >/dev/null 2>&1; echo $?`);
  console.log('install exit', inst.output.trim());
  const seen = new Set();
  const queue = [entry];
  let bad = 0;
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const r = await page.evaluate((p) => window.ov._call('debug.esm', { pathname: '/__ov/esm' + p }).catch((e) => ({ status: 'throw', body: String(e?.message ?? e) })), p);
    if (r.status !== 200) {
      bad++;
      console.log(`[${r.status}] ${p}\n    ${String(r.body).slice(0, 400).replace(/\n/g, '\n    ')}`);
      continue;
    }
    for (const m of String(r.body).matchAll(/["'](\/__ov\/esm(\/[^"'?]+))/g)) {
      const next = decodeURIComponent(m[2]);
      if (!seen.has(next)) queue.push(next);
    }
  }
  console.log(`${seen.size} modules, ${bad} failed`);
} finally {
  await browser.close();
  srv.kill();
}
