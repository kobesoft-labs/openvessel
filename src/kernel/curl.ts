// curl / wget over the policy-checked network proxy.

import * as path from '../shared/path.ts';
import type { Kernel, ProgramContext } from './kernel.ts';
import { getNetFetch } from './npm/cli.ts';

/** Reason phrases for when the response has none (HTTP/2 has none at all). */
const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 418: "I'm a teapot", 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** Short options that take a value (also when attached: -oFILE, -XPOST). */
const WITH_VALUE: Record<string, string> = { o: 'output', X: 'request', H: 'header', d: 'data', A: 'user-agent', e: 'referer', u: 'user', w: 'write-out', D: 'dump-header', m: 'max-time' };
const SHORT_FLAGS: Record<string, string> = { O: 'remote-name', s: 'silent', S: 'show-error', L: 'location', f: 'fail', k: 'insecure', i: 'include', I: 'head', v: 'verbose', G: 'get' };

async function curl(ctx: ProgramContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let url = '';
  // set from the option callback, so TypeScript can't narrow them
  let method = null as string | null;
  let output = null as string | null;
  let dumpHeader = null as string | null;
  let writeOut = null as string | null;
  let maxTime = 0;
  const set = new Set<string>();
  const headers: [string, string][] = [];
  const data: string[] = [];
  const option = (name: string, value: string) => {
    if (name === 'output') output = value;
    else if (name === 'request') method = value;
    else if (name === 'header') {
      const c = value.indexOf(':');
      headers.push([value.slice(0, c).trim(), value.slice(c + 1).trim()]);
    } else if (name === 'data' || name === 'data-raw' || name === 'data-binary' || name === 'data-ascii') {
      // -d @file reads the file (not --data-raw); -d strips its newlines, --data-binary doesn't
      let v = value;
      if (name !== 'data-raw' && v.startsWith('@')) v = new TextDecoder().decode(v === '@-' ? new Uint8Array(0) : ctx.vfs.readFile(ctx.resolve(v.slice(1))));
      if (name === 'data' || name === 'data-ascii') v = v.replace(/[\r\n]/g, '');
      data.push(v);
    } else if (name === 'user-agent') headers.push(['User-Agent', value]);
    else if (name === 'referer') headers.push(['Referer', value]);
    else if (name === 'user') headers.push(['Authorization', `Basic ${btoa(value)}`]);
    else if (name === 'write-out') writeOut = value;
    else if (name === 'dump-header') dumpHeader = value;
    else if (name === 'max-time') maxTime = Number(value);
    else if (name === 'url') url = value;
  };
  const LONG_VALUE = new Set([...Object.values(WITH_VALUE), 'data-raw', 'data-binary', 'data-ascii', 'url', 'connect-timeout', 'retry']);
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (LONG_VALUE.has(name)) option(name, eq > 0 ? a.slice(eq + 1) : (args[++i] ?? ''));
        else set.add(name);
      } else if (a.startsWith('-') && a.length > 1) {
        for (let k = 1; k < a.length; k++) {
          const c = a[k];
          if (WITH_VALUE[c]) {
            option(WITH_VALUE[c], k + 1 < a.length ? a.slice(k + 1) : (args[++i] ?? ''));
            break;
          }
          if (!SHORT_FLAGS[c]) throw Object.assign(new Error(`option -${c}: is unknown`), { curl: 2 });
          set.add(SHORT_FLAGS[c]);
        }
      } else url = a;
    }
  } catch (e: any) {
    ctx.err(`curl: ${e.curl ? e.message : `(26) ${e.message}`}\n`);
    return e.curl ?? 26;
  }
  const silent = set.has('silent') && !set.has('show-error');
  if (!url) {
    ctx.err('curl: no URL specified!\n');
    return 2;
  }
  if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
  const headOnly = set.has('head');
  let body: string | undefined;
  if (data.length && set.has('get')) url += (url.includes('?') ? '&' : '?') + data.join('&');
  else if (data.length) {
    body = data.join('&');
    if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  }
  const verb: string = method ?? (headOnly ? 'HEAD' : body !== undefined ? 'POST' : 'GET');
  const abort = new AbortController();
  const timer = maxTime > 0 ? setTimeout(() => abort.abort(), maxTime * 1000) : undefined;
  try {
    const res = await getNetFetch()(url, { method: verb, headers, body, signal: abort.signal });
    // through the proxy, the origin's status line and headers travel in x-ov-* headers
    const rh = res.headers.get('x-ov-rh');
    const resHeaders: [string, string][] = rh ? JSON.parse(decodeURIComponent(rh)) : [...res.headers];
    const status = Number(res.headers.get('x-ov-status') ?? res.status);
    const statusText = (res.headers.has('x-ov-status-text') ? decodeURIComponent(res.headers.get('x-ov-status-text')!) : res.statusText) || REASONS[status] || '';
    const effective = res.headers.has('x-ov-url') ? decodeURIComponent(res.headers.get('x-ov-url')!) : url;
    if (set.has('fail') && status >= 400) {
      if (!silent) ctx.err(`curl: (22) The requested URL returned error: ${status}\n`);
      return 22;
    }
    const head = `HTTP/1.1 ${status}${statusText ? ' ' + statusText : ''}\r\n${resHeaders.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
    if (dumpHeader !== null) {
      if (dumpHeader === '-') ctx.out(head);
      else ctx.vfs.writeFile(ctx.resolve(dumpHeader), head);
    }
    const bytes = headOnly ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
    const target = output ?? (set.has('remote-name') ? path.basename(new URL(url).pathname) || 'index.html' : null);
    const toStdout = target === null || target === '-';
    const headBytes = (set.has('include') || headOnly) && dumpHeader !== '-' ? new TextEncoder().encode(head) : new Uint8Array(0);
    const all = new Uint8Array(headBytes.length + bytes.length);
    all.set(headBytes);
    all.set(bytes, headBytes.length);
    if (toStdout) ctx.out(all);
    else ctx.vfs.writeFile(ctx.resolve(target!), all);
    if (writeOut !== null) {
      const contentType = resHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      const vars: Record<string, string> = { http_code: String(status).padStart(3, '0'), response_code: String(status), url_effective: effective, content_type: contentType, size_download: String(bytes.length), method: verb };
      ctx.out(writeOut.replace(/%\{(\w+)\}/g, (m, k) => vars[k] ?? m).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r'));
    }
    return 0;
  } catch (e: any) {
    if (abort.signal.aborted) {
      if (!silent) ctx.err(`curl: (28) Operation timed out after ${Math.round(maxTime * 1000)} milliseconds\n`);
      return 28;
    }
    if (!silent) ctx.err(`curl: (7) ${e?.message ?? e}\n`);
    return 7;
  } finally {
    clearTimeout(timer);
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
