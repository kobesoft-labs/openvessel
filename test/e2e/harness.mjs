// Drives the playground in headless Chrome. Usage:
//   node test/e2e/harness.mjs 'echo hi && node -v'      (runs a command line, prints output)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const root = new URL('../..', import.meta.url).pathname;

export async function startServer() {
  const srv = spawn(process.execPath, [root + 'scripts/serve.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));
  return srv;
}

export async function openBrowser({ headless = true } = {}) {
  const profile = root + 'node_modules/.cache/ov-chrome';
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless, args: ['--js-flags=--stack-size=4000'] });
  const browser = { close: () => ctx.close() };
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('console', (m) => {
    if (process.env.OV_CONSOLE) console.log(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5170/');
  await page.evaluate(() => window.ovReady);
  if (process.env.OV_TRACE) await page.evaluate(() => (window.__trace = true));
  return { browser, page };
}

export async function exec(page, cmd, { cwd = '/home/user/app', timeout = 600000, allowAll = true } = {}) {
  return page.evaluate(
    async ({ cmd, cwd, allowAll }) => {
      const ov = window.ov;
      if (allowAll) await ov.network.setPolicy({ mode: 'allow-all' });
      if (window.__trace) await ov._call('debug.trace', { on: true });
      const t0 = performance.now();
      const r = await ov.exec(cmd, { cwd });
      return { ...r, ms: Math.round(performance.now() - t0) };
    },
    { cmd, cwd, allowAll },
    { timeout },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? 'echo hello; node -e "console.log(process.version)"';
  const srv = await startServer();
  let browser;
  try {
    const o = await openBrowser({ headless: !process.env.HEADED });
    browser = o.browser;
    const r = await exec(o.page, cmd);
    process.stdout.write(r.output);
    console.log(`\n[exit ${r.code} in ${r.ms}ms]`);
  } finally {
    await browser?.close();
    srv.kill();
  }
}
