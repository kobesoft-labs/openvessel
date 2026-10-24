// internalBinding('url') — node_url.cc (ada::url_aggregator). Parsing is the URL Standard's
// (whatwg-url.ts, as ada does it; the browser's own URL class differs from the standard in places);
// what ada adds is the component offsets into the serialized href (url_components), recomputed
// from the parsed record.

import { fromShape } from './shape.ts';
import { guardFunctions } from '../intrinsics.ts';
import { punycodeToUnicode } from './encoding.ts';
import { type URLRecord, cloneRecord, get, origin, parse as parseURL, serialize, set } from './whatwg-url.ts';

/** The parts of a URL componentsOf reads. */
interface URLView {
  href: string;
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
}

function view(r: URLRecord): URLView {
  return {
    href: serialize(r),
    protocol: get.protocol(r),
    username: get.username(r),
    password: get.password(r),
    hostname: get.hostname(r),
    port: get.port(r),
    pathname: get.pathname(r),
  };
}

/** ada uses uint32_t(-1) for omitted components. */
const OMITTED = 4294967295;

// ada::scheme::type
const SCHEME_TYPE: Record<string, number> = { 'http:': 0, 'https:': 2, 'ws:': 3, 'ftp:': 4, 'wss:': 5, 'file:': 6 };
const NOT_SPECIAL = 1;

// internal/url.js updateActions
const enum Action {
  kProtocol = 0,
  kHost = 1,
  kHostname = 2,
  kPort = 3,
  kUsername = 4,
  kPassword = 5,
  kPathname = 6,
  kSearch = 7,
  kHash = 8,
  kHref = 9,
}

function invalidURL(input?: string, base?: string): TypeError {
  const e = new TypeError('Invalid URL') as TypeError & { code: string; input?: string; base?: string };
  e.code = 'ERR_INVALID_URL';
  if (input !== undefined) e.input = input;
  if (base !== undefined) e.base = base;
  return e;
}

function tryParse(input: string, base?: string): URLRecord | null {
  return parseURL(String(input), base === undefined ? undefined : String(base));
}

/** ada::url_components for a parsed URL: offsets into its href. */
export function componentsOf(u: URLView): number[] {
  const href = u.href;
  const protocolEnd = u.protocol.length;
  let usernameEnd: number;
  let hostStart: number;
  let hostEnd: number;
  let port = OMITTED;
  let pathnameStart: number;
  if (href.startsWith('//', protocolEnd)) {
    const i = protocolEnd + 2;
    const user = u.username;
    const pass = u.password;
    if (user || pass) {
      usernameEnd = i + user.length;
      // host_start points at the '@'
      hostStart = pass ? usernameEnd + 1 + pass.length : usernameEnd;
      hostEnd = hostStart + 1 + u.hostname.length;
    } else {
      usernameEnd = hostStart = i;
      hostEnd = i + u.hostname.length;
    }
    pathnameStart = hostEnd;
    if (u.port !== '') {
      port = Number(u.port);
      pathnameStart += 1 + u.port.length;
    }
  } else {
    usernameEnd = hostStart = hostEnd = pathnameStart = protocolEnd;
    // A host-less URL whose path starts with "//" is serialized with a "/." prefix.
    if (href.startsWith('/.', protocolEnd) && u.pathname.startsWith('//')) pathnameStart += 2;
  }
  let hashStart = href.indexOf('#');
  let searchStart = href.indexOf('?');
  if (searchStart !== -1 && hashStart !== -1 && searchStart > hashStart) searchStart = -1;
  if (hashStart === -1) hashStart = OMITTED;
  if (searchStart === -1) searchStart = OMITTED;
  return [protocolEnd, usernameEnd, hostStart, hostEnd, port, pathnameStart, searchStart, hashStart, SCHEME_TYPE[u.protocol] ?? NOT_SPECIAL];
}

/** Sets `hostname` on a special URL the way ada's set_hostname does; null on failure. */
function setHostname(input: string): string | null {
  const r = tryParse('ws://x')!;
  return set.hostname(r, String(input)) ? get.hostname(r) : null;
}

// RFC 1738 "unsafe" characters percent-encoded by pathToFileURL (node_url.cc lookup_table).
const PATH_ESCAPES: Record<number, string> = {
  0x00: '%00',
  0x09: '%09',
  0x0a: '%0A',
  0x0d: '%0D',
  0x20: '%20',
  0x22: '%22',
  0x23: '%23',
  0x25: '%25',
  0x3f: '%3F',
  0x5b: '%5B',
  0x5c: '%5C',
  0x5d: '%5D',
  0x5e: '%5E',
  0x7c: '%7C',
  0x7e: '%7E',
};

function encodePathChars(input: string, windows: boolean): string {
  let out = 'file://';
  let last = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c > 0x7e) continue;
    let rep: string | undefined;
    if (windows && c === 0x5c) rep = '/';
    else rep = PATH_ESCAPES[c];
    if (rep === undefined) continue;
    out += input.slice(last, i) + rep;
    last = i + 1;
  }
  return out + input.slice(last);
}

export function createUrl() {
  const b = fromShape('url');
  const urlComponents: Uint32Array = b.urlComponents instanceof Uint32Array ? b.urlComponents : new Uint32Array(9);

  function publish(r: URLRecord): string {
    const v = view(r);
    urlComponents.set(componentsOf(v));
    return v.href;
  }

  // (a program may have deleted array iteration; see intrinsics.ts)
  return guardFunctions(Object.assign(b, {
    urlComponents,

    parse(input: string, base?: string, raiseException?: boolean) {
      const raise = raiseException === true;
      const hasBase = typeof base === 'string';
      if (hasBase && tryParse(base) === null) {
        if (raise) throw invalidURL(input, base);
        return undefined;
      }
      const u = tryParse(input, hasBase ? base : undefined);
      if (u === null) {
        if (raise) throw invalidURL(input, hasBase ? base : undefined);
        return undefined;
      }
      return publish(u);
    },

    canParse(input: string, base?: string) {
      if (typeof base === 'string') return tryParse(base) !== null && tryParse(input, base) !== null;
      return tryParse(input) !== null;
    },

    update(href: string, action: number, value: string) {
      const parsed = tryParse(href);
      if (parsed === null) throw new Error(`url.update: unparsable href ${href}`);
      let u = cloneRecord(parsed);
      value = String(value);
      // a rejected value can still have changed part of the URL (a host before an invalid port)
      switch (action >>> 0) {
        case Action.kHref: {
          const n = tryParse(value);
          if (n === null) return false;
          u = n;
          break;
        }
        case Action.kProtocol:
          set.protocol(u, value);
          break;
        case Action.kHost:
          set.host(u, value);
          break;
        case Action.kHostname:
          set.hostname(u, value);
          break;
        case Action.kPort:
          set.port(u, value);
          break;
        case Action.kUsername:
          set.username(u, value);
          break;
        case Action.kPassword:
          set.password(u, value);
          break;
        case Action.kPathname:
          set.pathname(u, value);
          break;
        case Action.kSearch:
          set.search(u, value);
          break;
        case Action.kHash:
          set.hash(u, value);
          break;
        default:
          throw new Error('Unsupported URL update action');
      }
      return publish(u);
    },

    format(href: string, hash: boolean, unicode: boolean, search: boolean, auth: boolean) {
      const parsed = tryParse(href);
      if (parsed === null) throw new Error(`url.format: unparsable href ${href}`);
      const u = cloneRecord(parsed);
      if (hash !== true) u.fragment = null;
      if (search !== true) u.query = null;
      if (auth !== true) {
        u.username = '';
        u.password = '';
      }
      const v = view(u);
      const out = v.href;
      if (unicode === true && v.hostname !== '') {
        const c = componentsOf(v);
        const start = out[c[2]] === '@' ? c[2] + 1 : c[2];
        return out.slice(0, start) + toUnicode(v.hostname) + out.slice(c[3]);
      }
      return out;
    },

    getOrigin(input: string) {
      const u = tryParse(input);
      if (u === null) throw invalidURL();
      return origin(u);
    },

    domainToASCII(input: string) {
      if (input === '') return '';
      return setHostname(input) ?? '';
    },

    domainToUnicode(input: string) {
      if (input === '') return '';
      const host = setHostname(input);
      return host === null ? '' : toUnicode(host);
    },

    pathToFileURL(input: string, windows: boolean, hostname?: string) {
      const parsed = tryParse(encodePathChars(input, windows === true));
      if (parsed === null) throw invalidURL(input);
      const u = cloneRecord(parsed);
      if (windows === true && hostname !== undefined && !set.hostname(u, hostname)) throw invalidURL(input);
      return publish(u);
    },
  }));
}

/** ada::idna::to_unicode on an already-ASCII host. */
function toUnicode(host: string): string {
  return punycodeToUnicode(host);
}
