// Interim internalBinding('url') so bootstrap can proceed; replaced by the full url.ts binding.

import { fromShape } from './shape.ts';
import { NativeURL } from '../web.ts';

const OMITTED = 0xffffffff;
const SCHEME: Record<string, number> = { 'http:': 0, 'https:': 2, 'ws:': 3, 'ftp:': 4, 'wss:': 5, 'file:': 6 };

function components(u: URL, out: Uint32Array) {
  const href = u.href;
  const protocolEnd = u.protocol.length;
  const hasAuthority = href.startsWith('//', protocolEnd);
  let usernameEnd = protocolEnd;
  let hostStart = protocolEnd;
  let hostEnd = protocolEnd;
  let pathnameStart = protocolEnd;
  if (hasAuthority) {
    const authStart = protocolEnd + 2;
    usernameEnd = authStart + u.username.length;
    hostStart = usernameEnd;
    if (u.password) hostStart = usernameEnd + 1 + u.password.length;
    if (u.username || u.password) {
      // host_start points at '@'
      hostStart = href.indexOf('@', authStart);
    }
    const hostBegin = hostStart < href.length && href[hostStart] === '@' ? hostStart + 1 : hostStart;
    hostEnd = hostBegin + u.hostname.length;
    pathnameStart = hostEnd + (u.port ? u.port.length + 1 : 0);
  }
  const q = href.indexOf('?', pathnameStart);
  const h = href.indexOf('#', pathnameStart);
  const searchStart = q >= 0 && (h < 0 || q < h) ? q : OMITTED;
  out[0] = protocolEnd;
  out[1] = usernameEnd;
  out[2] = hostStart;
  out[3] = hostEnd;
  out[4] = u.port ? Number(u.port) : OMITTED;
  out[5] = pathnameStart;
  out[6] = searchStart;
  out[7] = h >= 0 ? h : OMITTED;
  out[8] = SCHEME[u.protocol] ?? 1;
}

function invalidUrl(input: string, base?: string): never {
  const e = new TypeError('Invalid URL') as TypeError & { code: string; input: string; base?: string };
  e.code = 'ERR_INVALID_URL';
  e.input = input;
  if (base !== undefined) e.base = base;
  throw e;
}

export function createUrlInterim() {
  const b = fromShape('url');
  const out = b.urlComponents as Uint32Array;
  const setters = ['protocol', 'host', 'hostname', 'port', 'username', 'password', 'pathname', 'search', 'hash', 'href'] as const;
  return Object.assign(b, {
    parse(input: string, base: string | undefined, raise: boolean) {
      let u: URL;
      try {
        u = base === undefined ? new NativeURL(input) : new NativeURL(input, base);
      } catch {
        if (raise) invalidUrl(input, base);
        return undefined;
      }
      components(u, out);
      return u.href;
    },
    canParse: (input: string, base?: string) => NativeURL.canParse(input, base),
    update(href: string, action: number, value: string) {
      const u = new NativeURL(href);
      const key = setters[action];
      if (key === 'href') {
        try {
          const n = new NativeURL(value);
          components(n, out);
          return n.href;
        } catch {
          return false;
        }
      }
      (u as any)[key] = value;
      components(u, out);
      return u.href;
    },
    pathToFileURL(path: string, _windows: boolean, _hostname?: string) {
      const enc = path.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09').replace(/#/g, '%23').replace(/\?/g, '%3F');
      const u = new NativeURL(`file://${enc.startsWith('/') ? '' : '/'}${enc}`);
      components(u, out);
      return u.href;
    },
    format(href: string, fragment: boolean, _unicode: boolean, search: boolean, auth: boolean) {
      const u = new NativeURL(href);
      if (!fragment) u.hash = '';
      if (!search) u.search = '';
      if (!auth) {
        u.username = '';
        u.password = '';
      }
      return u.href;
    },
    getOrigin: (href: string) => new NativeURL(href).origin,
    domainToASCII(d: string) {
      try {
        return new NativeURL(`http://${d}`).hostname;
      } catch {
        return '';
      }
    },
    domainToUnicode: (d: string) => d,
  });
}
