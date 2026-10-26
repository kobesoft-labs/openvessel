// Drives the playground in headless Chrome. Usage:
//   node test/e2e/harness.mjs 'echo hi && node -v'      (runs a command line, prints output)
// OV_BROWSER=firefox uses Playwright's Firefox instead (`npx playwright-core install firefox` once).
import { chromium, firefox } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;

export async function startServer() {
  const srv = spawn(process.execPath, [root + 'scripts/serve.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));
  return srv;
}

// OV_PORT_BASE selects the dev server ports (see scripts/serve.mjs) and a matching browser profile
const PORT_BASE = Number(process.env.OV_PORT_BASE ?? 5170);
const FIREFOX = process.env.OV_BROWSER === 'firefox';

export async function openBrowser({ headless = true, profile = root + 'node_modules/.cache/ov-' + (FIREFOX ? 'firefox' : 'chrome') + (PORT_BASE === 5170 ? '' : `-${PORT_BASE}`) } = {}) {
  if (FIREFOX) mkdirSync(profile + '/appdata', { recursive: true }); // Firefox won't create the profile folder
  const ctx = FIREFOX
    ? // MOZ_APP_DATA: keeps Firefox out of ~/Library/Application Support/Firefox (a sandbox may not allow it)
      await firefox.launchPersistentContext(profile, { headless, env: { ...process.env, MOZ_APP_DATA: profile + '/appdata', MOZ_LOCAL_APP_DATA: profile + '/appdata' } })
    : await chromium.launchPersistentContext(profile, { channel: 'chrome', headless, args: ['--js-flags=--stack-size=4000'] });
  const browser = { close: () => ctx.close() };
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('console', (m) => {
    if (process.env.OV_CONSOLE) console.log(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT_BASE}/`);
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
