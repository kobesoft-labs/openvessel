// Network access policy for outgoing requests.

export type NetworkMode = 'ask' | 'allowlist' | 'allow-all';

export interface NetworkPolicy {
  /** ask: prompt for hosts outside the lists; allowlist: deny them; allow-all: allow everything. */
  mode: NetworkMode;
  /** Built-in sets of hosts to allow. */
  presets: PresetName[];
  /** Extra allowed hosts. Supports `*.example.com`, `example.com:8080` and `[::1]:8080`. */
  allow: string[];
  /** Always denied (wins over everything). */
  deny: string[];
}

export const PRESETS = {
  npm: ['registry.npmjs.org', 'registry.npmjs.com', 'registry.yarnpkg.com', 'registry.npmmirror.com'],
  fonts: ['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.bunny.net', 'api.fontshare.com', 'cdn.fontshare.com', 'api.fontsource.org', 'use.typekit.net', 'p.typekit.net', 'rsms.me'],
  icons: ['api.iconify.design', 'api.simplesvg.com', 'api.unisvg.com', 'code.iconify.design', 'kit.fontawesome.com', 'ka-f.fontawesome.com'],
  cdn: ['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.skypack.dev', 'ga.jspm.io'],
  github: ['github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'api.github.com', 'gist.githubusercontent.com'],
} as const;
export type PresetName = keyof typeof PRESETS;

export const DEFAULT_POLICY: NetworkPolicy = {
  mode: 'ask',
  presets: ['npm', 'fonts', 'icons', 'cdn'],
  allow: [],
  deny: [],
};

export type Decision = 'allow' | 'deny' | 'ask';

/** A host name as the URL parser writes it, without brackets for IPv6 (`::1`, `127.0.0.1`, `example.com`). */
function canonicalHost(h: string): string | null {
  try {
    return new URL(`http://${h.includes(':') ? `[${h}]` : h}/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** Splits a pattern into host and port: `example.com:8080`, `[::1]:8080`, `::1`, `*.example.com`. */
function parsePattern(pattern: string): { host: string; port: string | null } | null {
  const p = pattern.trim().toLowerCase();
  if (!p) return null;
  if (p.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(p);
    if (!m) return null;
    const host = canonicalHost(m[1]);
    return host === null ? null : { host, port: m[2] ?? null };
  }
  // more than one colon: an IPv6 address without brackets, which can't carry a port
  if (p.indexOf(':') !== p.lastIndexOf(':')) {
    const host = canonicalHost(p);
    return host === null ? null : { host, port: null };
  }
  const m = /^(.*):(\d+)$/.exec(p);
  const host = m ? m[1] : p;
  // IP addresses in other spellings (127.1, 0x7f.0.0.1) are compared as the URL parser writes them
  const canon = host.includes('*') ? host : canonicalHost(host);
  return canon === null ? null : { host: canon, port: m ? m[2] : null };
}

function matches(pattern: string, host: string, port: string): boolean {
  const p = parsePattern(pattern);
  if (!p) return false;
  if (p.port && p.port !== port) return false;
  if (p.host === '*') return true;
  if (p.host.startsWith('*.')) {
    const base = p.host.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === p.host;
}

/** `host` is the URL's host name without brackets (`::1`, not `[::1]`). */
export function hostOf(url: string): { host: string; port: string; origin: string } {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : u.protocol === 'http:' || u.protocol === 'ws:' ? '80' : '');
  return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port, origin: u.origin };
}

/**
 * Host names that mean "this machine": localhost and its subdomains, 127.0.0.0/8, ::1, the unspecified
 * addresses and IPv4-mapped loopback. Inside OpenVessel they are the kernel's virtual ports; the gate
 * never lets a request reach the user's real machine through them.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = canonicalHost(hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''));
  if (h === null) return false;
  return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '0.0.0.0' || h === '::1' || h === '::' || /^::ffff:7f[0-9a-f]{2}:/.test(h);
}

export function decide(policy: NetworkPolicy, url: string, sessionAllow: Set<string>, sessionDeny: Set<string>): Decision {
  let h: ReturnType<typeof hostOf>;
  let u: URL;
  try {
    h = hostOf(url);
    u = new URL(url);
  } catch {
    return 'deny';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'deny';
  // the user's own machine is never reachable, whatever the policy says
  if (isLoopbackHost(h.host)) return 'deny';
  for (const d of policy.deny) if (matches(d, h.host, h.port)) return 'deny';
  if (sessionDeny.has(h.host)) return 'deny';
  if (policy.mode === 'allow-all') return 'allow';
  if (sessionAllow.has(h.host)) return 'allow';
  for (const name of policy.presets) for (const p of PRESETS[name]) if (matches(p, h.host, h.port)) return 'allow';
  for (const a of policy.allow) if (matches(a, h.host, h.port)) return 'allow';
  return policy.mode === 'ask' ? 'ask' : 'deny';
}

export function normalizePolicy(p: Partial<NetworkPolicy> | undefined): NetworkPolicy {
  return {
    mode: p?.mode ?? DEFAULT_POLICY.mode,
    // own properties only: inherited names such as "toString" are not presets
    presets: [...(p?.presets ?? DEFAULT_POLICY.presets)].filter((x): x is PresetName => typeof x === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, x)),
    allow: [...(p?.allow ?? [])].filter((x) => typeof x === 'string'),
    deny: [...(p?.deny ?? [])].filter((x) => typeof x === 'string'),
  };
}
