// The ported runtime's http server, reached from the preview iframe (kernel HTTP ⇄ TCP bridge).
//   node test/e2e/preview-port.mjs
import { startServer, openBrowser } from './harness.mjs';

const server = String.raw`
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json', 'x-ov': 'yes' });
      return res.end(JSON.stringify({ got: body, len: req.headers['content-length'] ?? null }));
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.write('<!doctype html><title>t</title><h1>Hello from ported Node</h1>');
    res.end('<p id="chunk">' + 'x'.repeat(70000).length + '</p>');
  });
}).listen(4000, () => console.log('up'));
`;

const srv = await startServer();
const { browser, page } = await openBrowser({ headless: !process.env.HEADED });
let failed = false;
try {
  await page.evaluate(async (src) => {
    const ov = window.ov;
    await ov.exec('mkdir -p /etc/openvessel && echo port > /etc/openvessel/node');
    await ov.fs.writeFile('/tmp/server.js', src);
    window.__srv = await ov.spawn('node', ['/tmp/server.js'], { cwd: '/tmp' });
  }, server);
  const frameEl = await page.waitForSelector('#preview iframe', { timeout: 20000 });
  const frame = await frameEl.contentFrame();
  await frame.waitForSelector('h1', { timeout: 20000 });
  const h1 = await frame.textContent('h1');
  const chunk = await frame.textContent('#chunk');
  const post = await frame.evaluate(async () => {
    const r = await fetch('/api', { method: 'POST', body: 'payload=1' });
    return { status: r.status, header: r.headers.get('x-ov'), json: await r.json() };
  });
  console.log('h1:', h1);
  console.log('chunk:', chunk);
  console.log('post:', JSON.stringify(post));
  failed = h1 !== 'Hello from ported Node' || chunk !== '70000' || post.status !== 201 || post.json.got !== 'payload=1' || post.header !== 'yes';
} catch (e) {
  failed = true;
  console.log('error:', e.message);
  console.log('server output:', await page.evaluate(() => window.__srv?.collected));
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
