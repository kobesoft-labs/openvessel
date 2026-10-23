// Runs a command line and prints its output as it arrives, giving up after N seconds.
//   node test/e2e/watch.mjs [--mount <dir>] 'cmd' [seconds=20]     (--mount: project copied to /home/user/app, cwd there)
import { startServer, openBrowser } from './harness.mjs';
import { mountProject } from './project.mjs';
const args = process.argv.slice(2);
let mountDir = null;
if (args[0] === '--mount') {
  mountDir = args[1];
  args.splice(0, 2);
}
const [cmd, secs = '20'] = args;
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  await page.evaluate(() => window.ov.network.setPolicy({ mode: 'allow-all' }));
  if (mountDir) await mountProject(page, mountDir);
  const pid = await page.evaluate(async ({ cmd, cwd }) => {
    const p = await window.ov.spawn('/bin/sh', ['-c', cmd], { cwd });
    window.__p = p;
    p.exit.then((c) => (window.__code = c));
    return p.pid;
  }, { cmd, cwd: mountDir ? '/home/user/app' : '/home/user' });
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
