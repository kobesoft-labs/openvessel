// internalBinding('url') — node_url.cc (ada::url_aggregator) on top of the platform's WHATWG URL.
//
// The platform URL parser is spec-equivalent to ada; what ada adds is the component offsets into the
// serialized href (url_components), which we recompute from the parsed record. The native URL class
// is captured at module load, before Node's bootstrap installs its own URL (which calls back here).

import { fromShape } from './shape.ts';
import { punycodeToUnicode } from './encoding.ts';

const NativeURL: typeof URL = globalThis.URL;

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

function tryParse(input: string, base?: string): URL | null {
  try {
    return base === undefined ? new NativeURL(input) : new NativeURL(input, base);
  } catch {
    return null;
  }
}

/** ada::url_components for a parsed URL: offsets into its href. */
export function componentsOf(u: URL): number[] {
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
  const a = new NativeURL('ws://x');
  a.hostname = input;
  if (a.hostname !== 'x') return a.hostname;
  // Unchanged: either the input really is "x" (or maps to it), or the setter failed.
  const b = new NativeURL('ws://y');
  b.hostname = input;
  return b.hostname === 'x' ? 'x' : null;
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

  function publish(u: URL): string {
    urlComponents.set(componentsOf(u));
    return u.href;
  }

  return Object.assign(b, {
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
      let u = tryParse(href);
      if (u === null) throw new Error(`url.update: unparsable href ${href}`);
      // The platform setters silently ignore invalid values where ada returns false; either way the
      // URL is unchanged, so returning the unchanged href is equivalent for internal/url.js.
      switch (action >>> 0) {
        case Action.kHref: {
          const n = tryParse(value);
          if (n === null) return false;
          u = n;
          break;
        }
        case Action.kProtocol:
          u.protocol = value;
          break;
        case Action.kHost:
          u.host = value;
          break;
        case Action.kHostname:
          u.hostname = value;
          break;
        case Action.kPort:
          u.port = value;
          break;
        case Action.kUsername:
          u.username = value;
          break;
        case Action.kPassword:
          u.password = value;
          break;
        case Action.kPathname:
          u.pathname = value;
          break;
        case Action.kSearch:
          u.search = value;
          break;
        case Action.kHash:
          u.hash = value;
          break;
        default:
          throw new Error('Unsupported URL update action');
      }
      return publish(u);
    },

    format(href: string, hash: boolean, unicode: boolean, search: boolean, auth: boolean) {
      const u = tryParse(href);
      if (u === null) throw new Error(`url.format: unparsable href ${href}`);
      if (hash !== true) u.hash = '';
      if (search !== true) u.search = '';
      if (auth !== true) {
        u.username = '';
        u.password = '';
      }
      const out = u.href;
      if (unicode === true && u.hostname !== '') {
        const c = componentsOf(u);
        const start = out[c[2]] === '@' ? c[2] + 1 : c[2];
        return out.slice(0, start) + toUnicode(u.hostname) + out.slice(c[3]);
      }
      return out;
    },

    getOrigin(input: string) {
      const u = tryParse(input);
      if (u === null) throw invalidURL();
      return u.origin;
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
      const u = tryParse(encodePathChars(input, windows === true));
      if (u === null) throw invalidURL(input);
      if (windows === true && hostname !== undefined) u.hostname = hostname;
      return publish(u);
    },
  });
}

/** ada::idna::to_unicode on an already-ASCII host. */
function toUnicode(host: string): string {
  return punycodeToUnicode(host);
}
