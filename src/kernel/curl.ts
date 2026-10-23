// curl / wget over the policy-checked network proxy.

import * as path from '../shared/path.ts';
import type { Kernel, ProgramContext } from './kernel.ts';
import { getNetFetch } from './npm/cli.ts';

async function curl(ctx: ProgramContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let url = '';
  let method = 'GET';
  let output: string | null = null;
  let remoteName = false;
  let silent = false;
  let include = false;
  let headOnly = false;
  let fail = false;
  const headers: [string, string][] = [];
  let data: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--request') method = args[++i];
    else if (a === '-o' || a === '--output') output = args[++i];
    else if (a === '-O' || a === '--remote-name') remoteName = true;
    else if (a === '-H' || a === '--header') {
      const h = args[++i];
      const c = h.indexOf(':');
      headers.push([h.slice(0, c).trim(), h.slice(c + 1).trim()]);
    } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') {
      data = args[++i];
      if (method === 'GET') method = 'POST';
    } else if (a === '-I' || a === '--head') {
      headOnly = true;
      method = 'HEAD';
    } else if (a === '-i' || a === '--include') include = true;
    else if (a === '-f' || a === '--fail') fail = true;
    else if (/^-[sSLfk]+$/.test(a)) {
      if (a.includes('s')) silent = true;
      if (a.includes('f')) fail = true;
    } else if (a === '--silent') silent = true;
    else if (a === '-L' || a === '--location' || a === '-k' || a === '--insecure' || a === '--compressed') {
      // redirects are always followed
    } else if (!a.startsWith('-')) url = a;
  }
  if (!url) {
    ctx.err('curl: no URL specified!\n');
    return 2;
  }
  if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
  void silent;
  try {
    const res = await getNetFetch()(url, { method, headers, body: data ?? undefined });
    if (fail && res.status >= 400) {
      ctx.err(`curl: (22) The requested URL returned error: ${res.status}\n`);
      return 22;
    }
    if (include || headOnly) {
      ctx.out(`HTTP/1.1 ${res.status} ${res.statusText}\r\n`);
      for (const [k, v] of res.headers) if (!k.startsWith('x-ov-')) ctx.out(`${k}: ${v}\r\n`);
      ctx.out('\r\n');
    }
    if (headOnly) return 0;
    const body = new Uint8Array(await res.arrayBuffer());
    const target = output ?? (remoteName ? path.basename(new URL(url).pathname) || 'index.html' : null);
    if (target) ctx.vfs.writeFile(ctx.resolve(target), body);
    else ctx.out(body);
    return 0;
  } catch (e: any) {
    ctx.err(`curl: (7) ${e?.message ?? e}\n`);
    return 7;
  }
}

async function wget(ctx: ProgramContext): Promise<number> {
  const args = ctx.argv.slice(1);
  const out = args.indexOf('-O');
  const url = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-O');
  if (!url) {
    ctx.err('wget: missing URL\n');
    return 1;
  }
  const file = out >= 0 ? args[out + 1] : path.basename(new URL(url).pathname) || 'index.html';
  ctx.proc.argv = ['curl', '-fsSL', url, ...(file === '-' ? [] : ['-o', file])];
  return curl(ctx);
}

export function installCurl(kernel: Kernel) {
  kernel.registerProgram('curl', curl, ['/usr/bin']);
  kernel.registerProgram('wget', wget, ['/usr/bin']);
}
