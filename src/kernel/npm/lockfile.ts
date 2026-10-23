// Reads lockfiles of npm, yarn, pnpm and bun as version hints (name → versions).

export interface LockHints {
  versions: Map<string, Set<string>>;
  source: string | null;
}

function add(h: Map<string, Set<string>>, name: string, version: string) {
  if (!name || !/^\d+\.\d+\.\d+/.test(version)) return;
  let s = h.get(name);
  if (!s) h.set(name, (s = new Set()));
  s.add(version);
}

function nameFromNmPath(p: string): string {
  const i = p.lastIndexOf('node_modules/');
  return i === -1 ? p : p.slice(i + 13);
}

export function parsePackageLock(text: string, h: Map<string, Set<string>>) {
  const j = JSON.parse(text);
  if (j.packages) {
    for (const [k, v] of Object.entries<any>(j.packages)) {
      if (!k || !v?.version) continue;
      if (v.link) continue;
      add(h, v.name ?? nameFromNmPath(k), v.version);
    }
  } else if (j.dependencies) {
    const walk = (deps: Record<string, any>) => {
      for (const [name, v] of Object.entries<any>(deps)) {
        if (v?.version) add(h, name, String(v.version).replace(/^npm:.*@/, ''));
        if (v?.dependencies) walk(v.dependencies);
      }
    };
    walk(j.dependencies);
  }
}

export function parseYarnLock(text: string, h: Map<string, Set<string>>) {
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      names = line
        .replace(/:\s*$/, '')
        .split(/,\s*/)
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .map((spec) => {
          const at = spec.lastIndexOf('@');
          let name = at > 0 ? spec.slice(0, at) : spec;
          // aliases: "alias@npm:real@^1" → real package name
          const npm = spec.indexOf('@npm:');
          if (npm > 0) {
            const real = spec.slice(npm + 5);
            const at2 = real.lastIndexOf('@');
            name = at2 > 0 ? real.slice(0, at2) : real;
          }
          return name;
        });
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (m) for (const n of names) add(h, n, m[1]);
  }
}

export function parsePnpmLock(text: string, h: Map<string, Set<string>>) {
  let section = '';
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '');
      continue;
    }
    if (section !== 'packages' && section !== 'snapshots') continue;
    const m = /^ {2}'?\/?((?:@[^/@\s']+\/)?[^/@\s'(]+)[@/](\d+\.\d+\.\d+[^\s:'(]*)/.exec(line);
    if (m) add(h, m[1], m[2]);
  }
}

export function parseBunLock(text: string, h: Map<string, Set<string>>) {
  const re = /"((?:@[^"@/]+\/)?[^"@/]+)@(\d+\.\d+\.\d+[^"]*)"/g;
  let m;
  while ((m = re.exec(text))) add(h, m[1], m[2]);
}

export function readLockHints(read: (name: string) => string | null): LockHints {
  const versions = new Map<string, Set<string>>();
  const order: [string, (t: string, h: Map<string, Set<string>>) => void][] = [
    ['package-lock.json', parsePackageLock],
    ['npm-shrinkwrap.json', parsePackageLock],
    ['pnpm-lock.yaml', parsePnpmLock],
    ['yarn.lock', parseYarnLock],
    ['bun.lock', parseBunLock],
  ];
  for (const [file, fn] of order) {
    const t = read(file);
    if (t === null) continue;
    try {
      fn(t, versions);
      return { versions, source: file };
    } catch {}
  }
  return { versions, source: null };
}
