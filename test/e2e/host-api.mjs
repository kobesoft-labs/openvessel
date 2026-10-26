// Host API behaviour: end() on pipes and terminals, server-ready URLs that work at once, the built-in
// dialog closing when the kernel settles a request, a lost kernel and teardown.
//   node test/e2e/host-api.mjs
import { startServer, openBrowser } from './harness.mjs';

const server = String.raw`
require('http').createServer((req, res) => res.end('<h1>ready-url</h1>')).listen(4100);
`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);

const srv = await startServer();
const { browser, page } = await openBrowser({ headless: !process.env.HEADED });
try {
  // end(): a pipe process sees end of file; on a terminal end() is ^D
  const ends = await timeout(
    page.evaluate(async () => {
      const ov = window.ov;
      const pipe = await ov.spawn('cat');
      await pipe.write('hi');
      await pipe.end();
      const tty = await ov.spawn('cat', [], { terminal: { cols: 80, rows: 24 } });
      await tty.write('abc\n');
      await tty.end();
      const partial = await ov.spawn('cat', [], { terminal: { cols: 80, rows: 24 } });
      await partial.write('xy');
      await partial.end(); // delivers the partial line
      await partial.end(); // end of file
      return {
        pipe: [await pipe.exit, pipe.collected],
        tty: [await tty.exit, tty.collected],
        partial: [await partial.exit, partial.collected],
      };
    }),
    20000,
    'end()',
  );
  check('end() closes a pipe process stdin', ends.pipe[0] === 0 && ends.pipe[1] === 'hi', JSON.stringify(ends.pipe));
  check('end() on a terminal is EOF', ends.tty[0] === 0 && ends.tty[1].includes('abc'), JSON.stringify(ends.tty));
  check('end() after a partial line, twice', ends.partial[0] === 0 && ends.partial[1].includes('xyxy'), JSON.stringify(ends.partial));

  // server-ready: the URL works as soon as the event fires (the relay is started first)
  const h1 = await timeout(
    page.evaluate(async (src) => {
      const ov = window.ov;
      window.ovNoAutoPreview = true;
      await ov.exec('mkdir -p /etc/openvessel && echo port > /etc/openvessel/node');
      await ov.fs.writeFile('/tmp/ready.js', src);
      const loaded = new Promise((resolve) => {
        const off = ov.on('server-ready', (ev) => {
          if (ev.port !== 4100) return;
          off();
          // used right away, before anything else has started the preview relay
          const f = document.createElement('iframe');
          f.id = 'ready-frame';
          f.src = ev.url;
          document.body.appendChild(f);
          resolve();
        });
      });
      window.__srv = await ov.spawn('node', ['/tmp/ready.js']);
      await loaded;
      return true;
    }, server),
    30000,
    'server-ready',
  );
  const frame = await (await page.waitForSelector('#ready-frame')).contentFrame();
  const text = await frame.waitForSelector('h1', { timeout: 10000 }).then((h) => h.textContent()).catch((e) => e.message);
  check('server-ready url loads at once', h1 && text === 'ready-url', text);
  await page.evaluate(() => window.__srv.kill());

  // the built-in dialog closes when the kernel settles its request elsewhere (as on its 5-minute timeout)
  const perm = await timeout(
    page.evaluate(async () => {
      const ov = window.ov;
      await ov.network.setPolicy({ mode: 'ask' });
      const ids = [];
      ov.on('permission-request', (r) => ids.push(r.id));
      const settled = [];
      ov.on('permission-settled', (r) => settled.push(r.id));
      const a = ov.exec('curl -s https://a.invalid/');
      const b = ov.exec('curl -s https://b.invalid/');
      while (ids.length < 2) await new Promise((r) => setTimeout(r, 50));
      const openBefore = document.querySelectorAll('dialog').length;
      // settle the queued one first, then the shown one, without answering the dialogs
      await ov._call('permission.respond', { id: ids[1], decision: 'deny' });
      await ov._call('permission.respond', { id: ids[0], decision: 'deny' });
      await new Promise((r) => setTimeout(r, 200));
      const openAfter = document.querySelectorAll('dialog').length;
      const codes = [(await a).code, (await b).code];
      await ov.network.setPolicy({ mode: 'allow-all' });
      return { openBefore, openAfter, settled: settled.length, codes };
    }),
    30000,
    'permission',
  );
  check('dialog closed after permission-settled', perm.openBefore === 1 && perm.openAfter === 0 && perm.settled === 2, JSON.stringify(perm));

  // a reloaded runtime frame: fatal 'error', running processes end, calls reject
  const lost = await timeout(
    page.evaluate(async () => {
      const ov = window.ov;
      const errors = [];
      ov.on('error', (e) => errors.push({ message: e.message, fatal: e.fatal }));
      const exits = [];
      ov.on('process-exit', (e) => exits.push(e));
      const run = ov.exec('sleep 100');
      await new Promise((r) => setTimeout(r, 300));
      const frame = [...document.querySelectorAll('iframe')].find((f) => f.src.endsWith('/runtime.html'));
      frame.src = frame.src;
      const r = await run;
      const after = await ov.ps().then(
        () => 'resolved',
        (e) => e.message,
      );
      return { code: r.code, errors, exits: exits.map((e) => e.signal), after, frames: document.querySelectorAll('iframe[src$="/runtime.html"]').length };
    }),
    30000,
    'lost kernel',
  );
  check('reloaded runtime frame is a fatal error', lost.errors.length === 1 && lost.errors[0].fatal && lost.code === 137 && lost.exits.includes('SIGKILL') && /reloaded/.test(lost.after) && lost.frames === 0, JSON.stringify(lost));

  // teardown: a new instance (URLs without a trailing slash / naming runtime.html), then torn down
  const td = await timeout(
    page.evaluate(async () => {
      const OV = window.ov.constructor;
      const port = Number(location.port);
      const v = await OV.boot({ runtimeUrl: `http://localhost:${port + 1}/runtime.html`, previewUrl: `http://localhost:${port + 2}` });
      const p = await v.spawn('sleep', ['100']);
      const pending = v._call('fs.stat', { path: '/' }).catch((e) => e.message);
      v.teardown();
      return { code: await p.exit, pending: await pending, later: await v.ps().catch((e) => e.message), frames: document.querySelectorAll('iframe[src*="runtime.html"], iframe[src*="relay.html"]').length };
    }),
    30000,
    'teardown',
  );
  check('teardown ends processes and rejects calls', td.code === 137 && /torn down/.test(td.pending) && /torn down/.test(td.later) && td.frames === 0, JSON.stringify(td));
} catch (e) {
  check('run', false, e.message);
} finally {
  await browser.close();
  srv.kill();
}
const failed = checks.includes(false);
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
