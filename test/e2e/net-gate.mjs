// The network gate and the service workers: loopback goes to virtual ports, redirects are checked at
// the host they end at, the prompt's initiator comes from the kernel, two runtimes on one origin keep
// their own kernels, and the preview's decisions ("once", policy changes, WebSockets) hold.
//   OV_PORT_BASE=<base> node test/e2e/net-gate.mjs        (needs the internet: registry.npmjs.org, httpbin.org)
import { startServer, openBrowser } from './harness.mjs';

const server = String.raw`
const http = require('http');
http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/to-outside') {
    res.writeHead(302, { location: 'https://registry.npmjs.org/is-number' });
    return res.end();
  }
  // pages are HTML, so the preview injects its WebSocket into them
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><title>virtual ' + process.argv[2] + '</title>');
  }
  res.setHeader('content-type', 'text/plain');
  res.end('virtual ' + process.argv[2] + ' ' + req.url);
}).listen(Number(process.argv[2]), () => console.log('up'));
`;

const U = 'https://registry.npmjs.org/is-number';
// a host that allows CORS but is not in the policies below
const DENIED = 'https://cdn.jsdelivr.net/npm/is-number@7.0.0/package.json';
const redirectTo = (to) => 'https://httpbin.org/redirect-to?url=' + encodeURIComponent(to);

const srv = await startServer();
const { browser, page } = await openBrowser({ headless: !process.env.HEADED });
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
};

/** Opens a preview of `port` from vessel `name` (window[name]) and returns its frame. */
async function preview(name, port, id) {
  await page.evaluate(
    async ({ name, port, id }) => {
      const f = await window[name].createPreview(port, { container: document.body });
      f.id = id;
      await new Promise((r) => (f.onload = r));
    },
    { name, port, id },
  );
  return (await page.$(`#${id}`)).contentFrame();
}

try {
  // --- one runtime ---------------------------------------------------------
  const a = await page.evaluate(
    async ({ src, U, r, r2 }) => {
      const ov = window.ov;
      window.ovNoAutoPreview = true;
      const out = {};
      await ov.exec('mkdir -p /etc/openvessel && echo port > /etc/openvessel/node');
      await ov.fs.writeFile('/tmp/server.js', src);
      window.__srv = await ov.spawn('node', ['/tmp/server.js', '4321'], { cwd: '/tmp' });
      for (let i = 0; i < 100 && !(await ov._call('ports')).some((p) => p.port === 4321); i++) await new Promise((res) => setTimeout(res, 100));
      await ov.network.setPolicy({ mode: 'allowlist', presets: ['npm'], allow: ['httpbin.org'] });
      out.curlLocal = await ov.exec('curl -s http://localhost:4321/x && echo && curl -s http://127.0.0.1:4321/y');
      out.curlLocalRedirect = await ov.exec('curl -s http://localhost:4321/to-outside | head -c 20');
      // redirects: the host the request ended at is checked too
      out.redirectAllowed = await ov.exec(`node -e "fetch('${r}').then(r=>console.log(r.status, r.url)).catch(e=>console.log('ERR', e.cause?.code))"`);
      out.redirectDenied = await ov.exec(`node -e "fetch('${r2}').then(r=>console.log(r.status, r.url)).catch(e=>console.log('ERR', e.cause?.code))"`);
      out.curlRedirectDenied = await ov.exec(`curl -sS '${r2}'; echo " exit=$?"`);
      // initiators come from the kernel: curl is named by its pid and command line, node by its own
      await ov.network.setPolicy({ mode: 'ask', presets: [] });
      const asked = [];
      const off = ov.on('permission-request', (req) => asked.push(req.initiator));
      const answer = setInterval(() => {
        const d = document.querySelector('dialog[open]');
        if (d) [...d.querySelectorAll('button')].find((b) => /^(Deny|拒否)$/.test(b.textContent))?.click();
      }, 50);
      await ov.exec(`curl -s ${U} > /dev/null; node -e "fetch('${U}').catch(()=>{})"`);
      clearInterval(answer);
      off();
      out.initiators = asked;
      await ov.network.setPolicy({ mode: 'allow-all' });
      return out;
    },
    { src: server, U, r: redirectTo(U), r2: redirectTo(DENIED) },
  );
  check('curl to localhost reaches the virtual server', a.curlLocal.output.trim() === 'virtual 4321 /x\nvirtual 4321 /y', a.curlLocal.output);
  check('curl follows a loopback redirect out through the gate', a.curlLocalRedirect.output.startsWith('{"_id":"is-number"'), a.curlLocalRedirect.output);
  check('a redirect to an allowed host is followed', /^200 https:\/\/registry\.npmjs\.org\/is-number/.test(a.redirectAllowed.output), a.redirectAllowed.output);
  check('a redirect to a denied host is refused (fetch)', a.redirectDenied.output.trim() === 'ERR EACCES', a.redirectDenied.output);
  check('a redirect to a denied host is refused (curl)', /denied by the network policy.*exit=7/s.test(a.curlRedirectDenied.output), a.curlRedirectDenied.output);
  check('initiators are named by the kernel', a.initiators.length === 2 && /^\d+ curl -s https:/.test(a.initiators[0]) && /^\d+ node -e/.test(a.initiators[1]), a.initiators);

  const pa = await preview('ov', 4321, 'pa');
  const pr = await pa.evaluate(async () => ({
    patched: !!WebSocket.__openvessel,
    local: await fetch('http://localhost:4321/from-preview').then((r) => r.text(), (e) => 'ERR ' + e.message),
    wsInstance: new WebSocket('ws://localhost:4321/') instanceof WebSocket,
    // a server answering the upgrade with an ordinary response: the socket fails
    wsRefused: await new Promise((resolve) => {
      const ws = new WebSocket('/plain');
      const ev = [];
      ws.onerror = () => ev.push('error');
      ws.onclose = (e) => (ev.push('close ' + e.code), resolve(ev.join(',')));
      setTimeout(() => resolve(ev.join(',') || 'hangs'), 5000);
    }),
  }));
  check('the preview page has the injected WebSocket', pr.patched === true, pr.patched);
  check('the preview reaches http://localhost:<port> as a virtual port', pr.local === 'virtual 4321 /from-preview', pr.local);
  check('tunnelled sockets are instanceof WebSocket', pr.wsInstance === true, pr.wsInstance);
  check('a non-101 answer to an upgrade fails the socket', pr.wsRefused === 'error,close 1006', pr.wsRefused);
  await page.evaluate(() => document.getElementById('pa').remove());

  // --- a second runtime on the same origin ---------------------------------
  const b = await page.evaluate(async () => {
    const A = window.ov;
    const runtimeUrl = document.querySelector('iframe[src*="runtime.html"]').src.replace(/runtime\.html$/, '');
    const previewUrl = `${location.protocol}//${location.hostname}:${Number(location.port) + 2}/`;
    window.__asked = [];
    window.__answer = 'once';
    const B = await A.constructor.boot({ runtimeUrl, previewUrl, network: { mode: 'ask', presets: [] }, onPermissionRequest: (req) => (window.__asked.push(req.host), window.__answer) });
    window.ovB = B;
    const out = {};
    await B.exec('mkdir -p /etc/openvessel && echo port > /etc/openvessel/node');
    // module loads (registered sources) and network checks of both kernels at once
    await A.network.setPolicy({ mode: 'allow-all' });
    await B.network.setPolicy({ mode: 'allow-all' });
    const esm = 'echo "export default 7" > /tmp/m.mjs && for i in 1 2 3; do node --input-type=module -e "import m from \'/tmp/m.mjs\'; const r = await fetch(\'https://registry.npmjs.org/is-number\'); console.log(m, r.status)"; done';
    const [ra, rb] = await Promise.all([A.exec(esm), B.exec(esm)]);
    out.esmA = ra.output;
    out.esmB = rb.output;
    await B.fs.writeFile('/tmp/server.js', await A.fs.readFile('/tmp/server.js', 'utf8'));
    await B.spawn('node', ['/tmp/server.js', '4400'], { cwd: '/tmp' });
    for (let i = 0; i < 100 && !(await B._call('ports')).some((p) => p.port === 4400); i++) await new Promise((r) => setTimeout(r, 100));
    await B.network.setPolicy({ mode: 'ask', presets: [] });
    return out;
  });
  check('two runtimes: first kernel loads modules and fetches', b.esmA.trim() === '7 200\n7 200\n7 200', b.esmA);
  check('two runtimes: second kernel loads modules and fetches', b.esmB.trim() === '7 200\n7 200\n7 200', b.esmB);

  // the preview: "once" is one request, policy changes take back cached allows
  const pb = await preview('ovB', 4400, 'pb');
  const get = (u, init) => pb.evaluate(({ u, init }) => fetch(u, init).then((r) => r.status + (r.type === 'opaque' ? ' opaque' : ''), () => 'neterr'), { u, init });
  const asked = () => page.evaluate(() => window.__asked.length);
  const servedPage = await pb.evaluate(() => fetch('/p').then((r) => r.text()));
  check('preview page served by the second kernel', servedPage === 'virtual 4400 /p', servedPage);
  const once = [await get(U), await get(U)];
  const onceAsked = await asked();
  check('"allow once" is one request', once.join() === '200,200' && onceAsked === 2, { once, onceAsked });
  await page.evaluate(() => (window.__answer = 'session'));
  const session = [await get(U), await get(U)];
  const sessionAsked = await asked();
  check('"for this session" is remembered', session.join() === '200,200' && sessionAsked === 3, { session, sessionAsked });
  await page.evaluate(async () => {
    await window.ovB.network.clearSession();
    await window.ovB.network.setPolicy({ mode: 'allowlist', presets: [] });
  });
  const afterClear = await get(U);
  check('clearSession + setPolicy take back cached allows', afterClear === '403', afterClear);
  // outside WebSockets ask the policy first
  const ws = await pb.evaluate(
    () =>
      new Promise((resolve) => {
        const ws = new WebSocket('wss://ws.example.invalid/');
        const ev = [];
        ws.onerror = () => ev.push('error');
        ws.onclose = (e) => (ev.push('close ' + e.code + ' ' + e.reason), resolve(ev.join(',')));
      }),
  );
  check('an outside WebSocket is checked by the policy', ws === 'error,close 1006 blocked by OpenVessel network policy', ws);
  // redirects in the preview are checked at the host they end at
  await page.evaluate(() => window.ovB.network.setPolicy({ mode: 'allowlist', presets: [], allow: ['httpbin.org', 'example.com'] }));
  const redirectCors = await get(redirectTo(U));
  const redirectNoCors = await get(redirectTo(U), { mode: 'no-cors' });
  const plainNoCors = await get('https://httpbin.org/get', { mode: 'no-cors' });
  const nonCors = await get('https://example.com/', { mode: 'no-cors' });
  const deniedNoCors = await get(DENIED, { mode: 'no-cors' });
  check('a no-cors load from a server without CORS works', nonCors === '0 opaque', nonCors);
  check('a no-cors load from a denied host is refused', deniedNoCors === '403', deniedNoCors);
  check('a preview redirect to a denied host is refused', redirectCors === '403', redirectCors);
  // opaque responses don't show where a redirect ended: a no-cors load is only checked at its first URL
  check('a no-cors preview redirect is checked at its first URL only', redirectNoCors === '0 opaque', redirectNoCors);
  check('a no-cors load from an allowed host works', plainNoCors === '0 opaque', plainNoCors);
  await page.evaluate(() => window.ovB.network.setPolicy({ mode: 'allowlist', presets: ['npm'], allow: ['httpbin.org'] }));
  const redirectOk = await get(redirectTo(U), { mode: 'no-cors' });
  check('a no-cors preview redirect to an allowed host works', redirectOk === '0 opaque', redirectOk);
} catch (e) {
  results.push(false);
  console.log('error:', e.message);
} finally {
  await browser.close();
  srv.kill();
}
const failed = results.includes(false);
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
