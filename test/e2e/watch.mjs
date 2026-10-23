// Runs a command line and prints its output as it arrives, giving up after N seconds.
//   node test/e2e/watch.mjs 'cmd' [seconds=20]
import { startServer, openBrowser } from './harness.mjs';
const [cmd, secs = '20'] = process.argv.slice(2);
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  await page.evaluate(() => window.ov.network.setPolicy({ mode: 'allow-all' }));
  const pid = await page.evaluate(async (cmd) => {
    const p = await window.ov.spawn('/bin/sh', ['-c', cmd], { cwd: '/home/user' });
    window.__p = p;
    p.exit.then((c) => (window.__code = c));
    return p.pid;
  }, cmd);
  let seen = 0;
  const end = Date.now() + Number(secs) * 1000;
  while (Date.now() < end) {
    const { text, code } = await page.evaluate(() => ({ text: window.__p.collected, code: window.__code }));
    process.stdout.write(text.slice(seen));
    seen = text.length;
    if (code !== undefined) {
      console.log(`\n[exit ${code}]`);
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (Date.now() >= end) {
    console.log(`\n[still running after ${secs}s] ps:`);
    console.log(await page.evaluate(() => window.ov.ps()));
  }
} finally {
  await browser.close();
  srv.kill();
}
