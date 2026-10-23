// Network access policy for outgoing requests.

export type NetworkMode = 'ask' | 'allowlist' | 'allow-all';

export interface NetworkPolicy {
  /** ask: prompt for hosts outside the lists; allowlist: deny them; allow-all: allow everything. */
  mode: NetworkMode;
  /** Built-in sets of hosts to allow. */
  presets: PresetName[];
  /** Extra allowed hosts. Supports `*.example.com` and `example.com:8080`. */
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

function matches(pattern: string, host: string, port: string): boolean {
  let p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  let pPort: string | null = null;
  const m = /^(.*):(\d+)$/.exec(p);
  if (m && !p.startsWith('[')) {
    p = m[1];
    pPort = m[2];
  }
  if (pPort && pPort !== port) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === p;
}

export function hostOf(url: string): { host: string; port: string; origin: string } {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
  return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port, origin: u.origin };
}

export function decide(policy: NetworkPolicy, url: string, sessionAllow: Set<string>, sessionDeny: Set<string>): Decision {
  let h: ReturnType<typeof hostOf>;
  try {
    h = hostOf(url);
  } catch {
    return 'deny';
  }
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'deny';
  for (const d of policy.deny) if (matches(d, h.host, h.port)) return 'deny';
  if (sessionDeny.has(h.host)) return 'deny';
  if (policy.mode === 'allow-all') return 'allow';
  if (sessionAllow.has(h.host)) return 'allow';
  for (const name of policy.presets) for (const p of PRESETS[name] ?? []) if (matches(p, h.host, h.port)) return 'allow';
  for (const a of policy.allow) if (matches(a, h.host, h.port)) return 'allow';
  return policy.mode === 'ask' ? 'ask' : 'deny';
}

export function normalizePolicy(p: Partial<NetworkPolicy> | undefined): NetworkPolicy {
  return {
    mode: p?.mode ?? DEFAULT_POLICY.mode,
    presets: (p?.presets ?? DEFAULT_POLICY.presets).filter((x): x is PresetName => x in PRESETS),
    allow: [...(p?.allow ?? [])],
    deny: [...(p?.deny ?? [])],
  };
}
