// Local dev server: host (5170), runtime (5171) and preview (5172) on separate origins.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../dist', import.meta.url).pathname;
// OV_PORT_BASE moves all three (base, base+1, base+2), so several test runs can share a machine
const BASE = Number(process.env.OV_PORT_BASE ?? 5170);
const HOST = Number(process.env.OV_HOST_PORT ?? BASE);
const RUNTIME = Number(process.env.OV_RUNTIME_PORT ?? BASE + 1);
const PREVIEW = Number(process.env.OV_PREVIEW_PORT ?? BASE + 2);
const hostOrigin = `http://localhost:${HOST}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

const sites = [
  { port: HOST, dir: 'playground', headers: { ...isolation, 'cross-origin-resource-policy': 'same-origin' } },
  {
    port: RUNTIME,
    dir: 'runtime',
    headers: {
      ...isolation,
      'cross-origin-resource-policy': 'cross-origin',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
        "connect-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        `frame-ancestors ${hostOrigin}`,
      ].join('; '),
    },
  },
  { port: PREVIEW, dir: 'preview', headers: { ...isolation, 'cross-origin-resource-policy': 'cross-origin' } },
];

for (const site of sites) {
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const file = join(root, site.dir, p);
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...site.headers };
      // the runtime service worker is the single gate to the network: it must not inherit connect-src 'self'
      if (site.dir === 'runtime' && p === '/sw.js') delete headers['content-security-policy'];
      // the preview service worker passes no-cors loads (images, classic scripts) through: under
      // credentialless they go out without credentials and need no CORP from the other server
      if (site.dir === 'preview' && p === '/__ov-sw.js') headers['cross-origin-embedder-policy'] = 'credentialless';
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', ...site.headers });
      res.end('not found');
    }
  }).listen(site.port, '127.0.0.1', () => console.log(`${site.dir}: http://localhost:${site.port}/`));
}
