import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { OpenVessel } from '../src/host/index.ts';

const RUNTIME = `${location.protocol}//${location.hostname}:${Number(location.port) + 1}/`;
const PREVIEW = `${location.protocol}//${location.hostname}:${Number(location.port) + 2}/`;
const APP = '/home/user/app';

const SAMPLE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'ov-sample', type: 'module', version: '0.0.1', private: true, scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' }, dependencies: { astro: '^5.18.0' } }, null, 2),
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n",
  'src/pages/index.astro': `---
const items = ['Kernel', 'Shell', 'npm', 'Astro'];
const now = new Date().toISOString();
---
<html lang="ja">
  <head><meta charset="utf-8" /><title>OpenVessel sample</title></head>
  <body>
    <h1>Hello from OpenVessel</h1>
    <ul>{items.map((i) => <li>{i}</li>)}</ul>
    <p>built at {now}</p>
  </body>
</html>
`,
  'src/pages/about.astro': '---\n---\n<h1>About</h1><a href="/">home</a>\n',
};

const term = new Terminal({ fontSize: 13, convertEol: false, cursorBlink: true, theme: { background: '#1e1e1e' } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term')!);
fit.fit();
term.writeln('OpenVessel を起動しています…');

const ready = (async () => {
  const vessel = await OpenVessel.boot({ runtimeUrl: RUNTIME, previewUrl: PREVIEW, network: { mode: 'ask' } });
  (window as any).ov = vessel;
  vessel.on('error', ({ message, fatal }) => term.writeln(`\r\n\x1b[31m${message}${fatal ? '（停止しました）' : ''}\x1b[0m`));
  await vessel.mount(SAMPLE, { path: APP });
  const shell = await vessel.spawn('/bin/sh', ['-i'], { cwd: APP, terminal: { cols: term.cols, rows: term.rows } });
  (async () => {
    const reader = shell.output.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      term.write(value);
    }
    term.writeln('\r\n[shell exited]');
  })();
  term.onData((d) => shell.write(d));
  const onResize = () => {
    fit.fit();
    shell.resize(term.cols, term.rows);
  };
  window.addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe(document.getElementById('left')!);

  const ports = document.getElementById('ports')!;
  const previewBox = document.getElementById('preview')!;
  let current = 0;
  const show = async (port: number) => {
    current = port;
    previewBox.innerHTML = '';
    await vessel.createPreview(port, { container: previewBox });
    renderPorts();
  };
  const live = new Set<number>();
  const renderPorts = () => {
    ports.innerHTML = '';
    if (!live.size) ports.textContent = 'サーバーなし';
    for (const p of live) {
      const b = document.createElement('button');
      b.textContent = `:${p}${p === current ? ' ●' : ''}`;
      b.onclick = () => show(p);
      ports.appendChild(b);
    }
  };
  vessel.on('server-ready', ({ port }) => {
    live.add(port);
    // automated runs (test/node-compat) set this: a preview would send requests to test servers
    if ((window as any).ovNoAutoPreview) return renderPorts();
    show(port);
  });
  vessel.on('port-closed', ({ port }) => {
    live.delete(port);
    renderPorts();
  });
  document.getElementById('reload')!.onclick = () => current && show(current);
  document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
    b.onclick = () => {
      shell.write(b.dataset.cmd + '\r');
      term.focus();
    };
  });
  document.getElementById('sample')!.onclick = async () => {
    await vessel.mount(SAMPLE, { path: APP });
    term.focus();
  };
  const folder = document.getElementById('folder') as HTMLInputElement;
  folder.onchange = async () => {
    const files: Record<string, Uint8Array> = {};
    for (const f of Array.from(folder.files ?? [])) {
      const rel = (f as any).webkitRelativePath.split('/').slice(1).join('/');
      if (!rel || rel.startsWith('node_modules/') || rel.includes('/node_modules/') || rel.startsWith('.git/')) continue;
      files[rel] = new Uint8Array(await f.arrayBuffer());
    }
    await vessel.fs.rm(APP, { recursive: true, force: true });
    await vessel.mount(files, { path: APP });
    shell.write(`cd ${APP} && ls\r`);
  };
  const mode = document.getElementById('mode') as HTMLSelectElement;
  mode.onchange = () => vessel.network.setPolicy({ mode: mode.value as any, presets: ['npm', 'fonts', 'icons', 'cdn'] });
  term.focus();
  return vessel;
})();
(window as any).ovReady = ready;
ready.catch((e) => term.writeln(`\x1b[31m起動に失敗しました: ${e.message}\x1b[0m`));
