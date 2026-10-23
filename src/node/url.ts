// node:url (WHATWG URL plus the legacy url.parse/format/resolve API)

import * as path from '../shared/path.ts';
import { encodePathForUrl } from '../shared/resolve.ts';
import * as qs from './querystring.ts';

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

function err(code: string, msg: string, Ctor: ErrorConstructor | TypeErrorConstructor = TypeError) {
  const e = new Ctor(msg) as Error & { code: string };
  e.code = code;
  return e;
}

export function fileURLToPath(u: string | URL, _opts?: unknown): string {
  let url: URL;
  if (typeof u === 'string') url = new URL(u);
  else if (u && typeof (u as URL).href === 'string') url = u as URL;
  else throw err('ERR_INVALID_ARG_TYPE', `The "path" argument must be of type string or an instance of URL. Received ${typeof u}`);
  if (url.protocol !== 'file:') throw err('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
  if (url.hostname !== '' && url.hostname !== 'localhost') throw err('ERR_INVALID_FILE_URL_HOST', `File URL host must be "localhost" or empty on linux`);
  const p = url.pathname;
  if (/%2f/i.test(p)) throw err('ERR_INVALID_FILE_URL_PATH', 'File URL path must not include encoded / characters');
  return decodeURIComponent(p);
}

export function pathToFileURL(p: string, _opts?: unknown): URL {
  const cwd = (globalThis as any).process?.cwd?.() ?? '/';
  let resolved = path.resolve(cwd, p);
  if (p.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
  return new URL('file://' + encodePathForUrl(resolved).replace(/\?/g, '%3F').replace(/#/g, '%23'));
}

export function urlToHttpOptions(url: URL) {
  const o: any = {
    protocol: url.protocol,
    hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ''}${url.search || ''}`,
    href: url.href,
  };
  if (url.port !== '') o.port = Number(url.port);
  if (url.username || url.password) o.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return o;
}

export function domainToASCII(d: string) {
  try {
    return new URL(`http://${d}`).hostname;
  } catch {
    return '';
  }
}
export function domainToUnicode(d: string) {
  return d;
}

// -----------------------------------------------------------------------------
// legacy API

export class Url {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  host: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  query: any = null;
  pathname: string | null = null;
  path: string | null = null;
  href = '';
  format() {
    return format(this);
  }
  resolve(rel: string) {
    return resolve(this.href, rel);
  }
}

const slashedProtocols = new Set(['http:', 'https:', 'ftp:', 'gopher:', 'file:', 'ws:', 'wss:']);

export function parse(input: string | Url, parseQuery = false, slashesDenoteHost = false): Url {
  if (input instanceof Url) return input;
  if (typeof input !== 'string') throw err('ERR_INVALID_ARG_TYPE', 'The "url" argument must be of type string');
  const u = new Url();
  let rest = input.trim();
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    u.hash = rest.slice(hashIdx);
    rest = rest.slice(0, hashIdx);
  }
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) {
    u.search = rest.slice(qIdx);
    u.query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  } else if (parseQuery) {
    u.search = '';
    u.query = {};
  }
  if (parseQuery && typeof u.query === 'string') u.query = qs.parse(u.query);
  const proto = /^([a-z0-9.+-]+:)/i.exec(rest);
  if (proto) {
    u.protocol = proto[1].toLowerCase();
    rest = rest.slice(proto[1].length);
  }
  if (slashesDenoteHost || proto || /^\/\/[^@/]+@[^@/]+/.test(rest)) {
    const slashes = rest.startsWith('//');
    if (slashes && !(u.protocol === 'javascript:')) {
      rest = rest.slice(2);
      u.slashes = true;
    }
  }
  if (u.slashes || (u.protocol && !slashedProtocols.has(u.protocol) && false)) {
    let end = rest.search(/[/\\]/);
    if (end === -1) end = rest.length;
    let hostPart = rest.slice(0, end);
    rest = rest.slice(end);
    const at = hostPart.lastIndexOf('@');
    if (at !== -1) {
      u.auth = decodeURIComponent(hostPart.slice(0, at));
      hostPart = hostPart.slice(at + 1);
    }
    const portM = /:(\d*)$/.exec(hostPart);
    if (portM) {
      if (portM[1]) u.port = portM[1];
      hostPart = hostPart.slice(0, portM.index);
    }
    u.hostname = hostPart.toLowerCase().replace(/^\[|\]$/g, '');
    u.host = (hostPart.toLowerCase()) + (u.port ? `:${u.port}` : '');
    if (u.protocol && slashedProtocols.has(u.protocol) && !rest) rest = '/';
  }
  u.pathname = rest || (u.slashes ? '/' : null);
  if (u.pathname === null && !u.search) u.pathname = rest || null;
  u.path = (u.pathname ?? '') + (u.search ?? '') || null;
  u.href = format(u);
  return u;
}

export function format(obj: any, opts?: { auth?: boolean; fragment?: boolean; search?: boolean; unicode?: boolean }): string {
  if (typeof obj === 'string') obj = parse(obj);
  if (obj instanceof URL) {
    const u = new URL(obj.href);
    if (opts?.auth === false) {
      u.username = '';
      u.password = '';
    }
    if (opts?.fragment === false) u.hash = '';
    if (opts?.search === false) u.search = '';
    return u.href;
  }
  let auth = obj.auth || '';
  if (auth) auth = encodeURIComponent(auth).replace(/%3A/i, ':') + '@';
  let protocol = obj.protocol || '';
  let pathname = obj.pathname || '';
  let hash = obj.hash || '';
  let host = '';
  let query = '';
  if (obj.host) host = auth + obj.host;
  else if (obj.hostname) {
    host = auth + (obj.hostname.includes(':') ? `[${obj.hostname}]` : obj.hostname);
    if (obj.port) host += ':' + obj.port;
  }
  if (obj.query && typeof obj.query === 'object' && Object.keys(obj.query).length) query = qs.stringify(obj.query);
  let search = obj.search || (query && '?' + query) || '';
  if (protocol && !protocol.endsWith(':')) protocol += ':';
  if (obj.slashes || ((!protocol || slashedProtocols.has(protocol)) && host !== '')) {
    host = '//' + (host || '');
    if (pathname && pathname[0] !== '/') pathname = '/' + pathname;
  } else if (!host) host = '';
  if (hash && hash[0] !== '#') hash = '#' + hash;
  if (search && search[0] !== '?') search = '?' + search;
  pathname = pathname.replace(/[?#]/g, (m: string) => encodeURIComponent(m));
  search = search.replace('#', '%23');
  return protocol + host + pathname + search + hash;
}

export function resolve(from: string, to: string): string {
  try {
    const base = new URL(from, 'resolve://');
    const r = new URL(to, base);
    if (r.protocol === 'resolve:') {
      const { pathname, search, hash } = r;
      return pathname + search + hash;
    }
    return r.href;
  } catch {
    return to;
  }
}

export function resolveObject(from: string, to: string) {
  return parse(resolve(from, to));
}

export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, urlToHttpOptions, domainToASCII, domainToUnicode, parse, format, resolve, resolveObject, Url };
