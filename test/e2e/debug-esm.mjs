// Prints what the kernel's ESM service (the legacy runtime's module loader) serves for VFS paths.
//   node test/e2e/debug-esm.mjs [--port] <vfs path…>     (--port: the install runs on the ported runtime)
import { startServer, openBrowser, exec, usePortedRuntime } from './harness.mjs';
const srv = await startServer();
const { browser, page } = await openBrowser();
try {
  if (process.argv.includes('--port')) await usePortedRuntime(page);
  await exec(page, 'npm install >/dev/null');
  for (const p of process.argv.slice(2).filter((a) => a !== '--port')) {
    const r = await page.evaluate((p) => window.ov._call('debug.esm', { pathname: '/__ov/esm' + p }), p);
    console.log('=====', p, r.status);
    console.log(r.body.slice(0, 3000));
  }
} finally {
  await browser.close();
  srv.kill();
}
