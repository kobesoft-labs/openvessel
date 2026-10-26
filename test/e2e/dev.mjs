// Starts `npm run dev`, opens the preview and checks HMR.
//   node test/e2e/dev.mjs [--legacy]     (--legacy: on the legacy runtime instead of the ported one)
import { startServer, openBrowser, exec, useLegacyRuntime } from './harness.mjs';
const srv = await startServer();
const { browser, page } = await openBrowser({ headless: !process.env.HEADED });
try {
  if (process.argv.includes('--legacy')) await useLegacyRuntime(page);
  await exec(page, 'npm install >/dev/null 2>&1');
  const port = await page.evaluate(async () => {
    const ov = window.ov;
    const p = await ov.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });
    window.__dev = p;
    return new Promise((resolve) => ov.on('server-ready', ({ port }) => resolve(port)));
  });
  console.log('server-ready on', port);
  await page.waitForTimeout(1500);
  const frameEl = await page.waitForSelector('#preview iframe', { timeout: 20000 });
  const frame = await frameEl.contentFrame();
  try {
    await frame.waitForSelector('h1', { timeout: 30000 });
  } catch (e) {
    console.log('frame url:', frame.url());
    console.log('frame text:', (await frame.evaluate(() => document.body.innerText).catch((x) => String(x))).slice(0, 600));
    console.log('--- dev output ---\n' + (await page.evaluate(() => window.__dev.collected)).slice(-3000));
    throw e;
  }
  console.log('h1:', await frame.textContent('h1'));
  console.log('body:', (await frame.evaluate(() => document.body.innerText)).slice(0, 1500));
  console.log('items:', await frame.$$eval('li', (els) => els.map((e) => e.textContent)));
  // HMR: edit the page and wait for the update
  await page.evaluate(async () => {
    const src = await window.ov.fs.readFile('/home/user/app/src/pages/index.astro', 'utf8');
    await window.ov.fs.writeFile('/home/user/app/src/pages/index.astro', src.replace('Hello from OpenVessel', 'Hello again (HMR)'));
  });
  await frame.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('HMR'), null, { timeout: 30000 }).then(
    () => console.log('HMR ok:', 'updated'),
    async () => console.log('HMR failed; h1 =', await frame.textContent('h1').catch(() => '?')),
  );
  console.log('--- dev output ---\n' + (await page.evaluate(() => window.__dev.collected)).slice(-3000));
} finally {
  await browser.close();
  srv.kill();
}
