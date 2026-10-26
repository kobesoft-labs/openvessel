// Walks the ESM graph served by the runtime SW and reports modules that don't load.
//   node test/e2e/esm-graph.mjs [--port] <project dir> <entry path in VFS> [install command]
// The graph is the kernel's ESM service, which only the legacy runtime loads modules from; --port runs
// the install on the ported runtime.
import { startServer, openBrowser, exec, usePortedRuntime } from './harness.mjs';
import { mountProject } from './project.mjs';

const [dir, entry, install = 'npm install'] = process.argv.slice(2).filter((a) => a !== '--port');
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  await page.evaluate(() => window.ovReady);
  if (process.argv.includes('--port')) await usePortedRuntime(page);
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
    // import specifiers are absolute URLs under the runtime's base (…/__ov/esm/<path>)
    for (const m of String(r.body).matchAll(/["'][^"'\s]*?\/__ov\/esm(\/[^"'?]+)/g)) {
      const next = decodeURIComponent(m[1]);
      if (!seen.has(next)) queue.push(next);
    }
  }
  console.log(`${seen.size} modules, ${bad} failed`);
} finally {
  await browser.close();
  srv.kill();
}
