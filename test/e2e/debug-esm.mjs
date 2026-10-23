import { startServer, openBrowser, exec } from './harness.mjs';
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  await exec(page, 'npm install >/dev/null');
  for (const p of process.argv.slice(2)) {
    const r = await page.evaluate((p) => window.ov._call('debug.esm', { pathname: '/__ov/esm' + p }), p);
    console.log('=====', p, r.status);
    console.log(r.body.slice(0, 3000));
  }
} finally {
  await browser.close();
  srv.kill();
}
