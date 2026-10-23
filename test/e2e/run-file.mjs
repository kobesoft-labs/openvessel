// node test/e2e/run-file.mjs <local file> <vfs path> '<command>'
import { readFileSync } from 'node:fs';
import { startServer, openBrowser, exec } from './harness.mjs';
const [local, vpath, cmd] = process.argv.slice(2);
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  if (process.env.SETUP) await exec(page, process.env.SETUP);
  const content = readFileSync(local, 'utf8');
  await page.evaluate(([p, c]) => window.ov.fs.writeFile(p, c), [vpath, content]);
  const r = await exec(page, cmd);
  process.stdout.write(r.output);
  console.log(`\n[exit ${r.code} in ${r.ms}ms]`);
} finally {
  await browser.close();
  srv.kill();
}
