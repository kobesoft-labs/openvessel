// Semantic versioning (compatible with node-semver for ranges used in package.json).

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  raw: string;
}

const VERSION_RE = /^\s*[=v]*\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?\s*$/;

export function parse(v: string): SemVer | null {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    prerelease: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? +p : p)) : [],
    raw: v.trim().replace(/^[=v]+/, ''),
  };
}

export function valid(v: string): string | null {
  const p = parse(v);
  return p ? `${p.major}.${p.minor}.${p.patch}${p.prerelease.length ? '-' + p.prerelease.join('.') : ''}` : null;
}

function cmpPre(a: (string | number)[], b: (string | number)[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compare(a: SemVer | string, b: SemVer | string): number {
  const x = typeof a === 'string' ? parse(a)! : a;
  const y = typeof b === 'string' ? parse(b)! : b;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return cmpPre(x.prerelease, y.prerelease);
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}
type ComparatorSet = Comparator[]; // AND
export type Range = ComparatorSet[]; // OR

const ANY: ComparatorSet = [];

function partial(s: string): { major: number | null; minor: number | null; patch: number | null; pre: (string | number)[] } | null {
  const m = /^[=v]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/.exec(s.trim());
  if (!m) return null;
  const n = (x: string | undefined) => (x === undefined || /^[xX*]$/.test(x) ? null : +x);
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? +p : p)) : [] };
}

function ver(major: number, minor: number, patch: number, pre: (string | number)[] = []): SemVer {
  return { major, minor, patch, prerelease: pre, raw: `${major}.${minor}.${patch}${pre.length ? '-' + pre.join('.') : ''}` };
}

function expandComparator(tok: string): ComparatorSet | null {
  const m = /^(<=|>=|<|>|=|~>|~|\^)?\s*(.*)$/.exec(tok.trim());
  if (!m) return null;
  const op = m[1] ?? '';
  const p = partial(m[2]);
  if (!p) return null;
  const { major, minor, patch, pre } = p;
  if (op === '^') {
    if (major === null) return ANY;
    if (minor === null) return [{ op: '>=', v: ver(major, 0, 0) }, { op: '<', v: ver(major + 1, 0, 0, [0]) }];
    if (patch === null) {
      if (major === 0) return [{ op: '>=', v: ver(0, minor, 0) }, { op: '<', v: ver(0, minor + 1, 0, [0]) }];
      return [{ op: '>=', v: ver(major, minor, 0) }, { op: '<', v: ver(major + 1, 0, 0, [0]) }];
    }
    const lo = ver(major, minor, patch, pre);
    if (major > 0) return [{ op: '>=', v: lo }, { op: '<', v: ver(major + 1, 0, 0, [0]) }];
    if (minor > 0) return [{ op: '>=', v: lo }, { op: '<', v: ver(0, minor + 1, 0, [0]) }];
    return [{ op: '>=', v: lo }, { op: '<', v: ver(0, 0, patch + 1, [0]) }];
  }
  if (op === '~' || op === '~>') {
    if (major === null) return ANY;
    if (minor === null) return [{ op: '>=', v: ver(major, 0, 0) }, { op: '<', v: ver(major + 1, 0, 0, [0]) }];
    const lo = ver(major, minor, patch ?? 0, patch === null ? [] : pre);
    return [{ op: '>=', v: lo }, { op: '<', v: ver(major, minor + 1, 0, [0]) }];
  }
  if (op === '' || op === '=') {
    if (major === null) return ANY;
    if (minor === null) return [{ op: '>=', v: ver(major, 0, 0) }, { op: '<', v: ver(major + 1, 0, 0, [0]) }];
    if (patch === null) return [{ op: '>=', v: ver(major, minor, 0) }, { op: '<', v: ver(major, minor + 1, 0, [0]) }];
    return [{ op: '=', v: ver(major, minor, patch, pre) }];
  }
  // <, <=, >, >= with partials
  if (major === null) return op === '<' || op === '>' ? [{ op: '<', v: ver(0, 0, 0, [0]) }] : ANY;
  if (op === '>') {
    if (minor === null) return [{ op: '>=', v: ver(major + 1, 0, 0) }];
    if (patch === null) return [{ op: '>=', v: ver(major, minor + 1, 0) }];
    return [{ op: '>', v: ver(major, minor, patch, pre) }];
  }
  if (op === '>=') return [{ op: '>=', v: ver(major, minor ?? 0, patch ?? 0, pre) }];
  if (op === '<') {
    if (minor === null) return [{ op: '<', v: ver(major, 0, 0, [0]) }];
    if (patch === null) return [{ op: '<', v: ver(major, minor, 0, [0]) }];
    return [{ op: '<', v: ver(major, minor, patch, pre) }];
  }
  // <=
  if (minor === null) return [{ op: '<', v: ver(major + 1, 0, 0, [0]) }];
  if (patch === null) return [{ op: '<', v: ver(major, minor + 1, 0, [0]) }];
  return [{ op: '<=', v: ver(major, minor, patch, pre) }];
}

const rangeCache = new Map<string, Range | null>();

export function parseRange(range: string): Range | null {
  const key = range;
  if (rangeCache.has(key)) return rangeCache.get(key)!;
  const out: Range = [];
  for (let part of range.split('||')) {
    part = part.trim();
    if (part === '' || part === '*' || part === 'x' || part === 'X' || part === 'latest') {
      out.push(ANY);
      continue;
    }
    // hyphen range
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(part);
    if (hy) {
      const a = partial(hy[1]);
      const b = partial(hy[2]);
      if (!a || !b) {
        rangeCache.set(key, null);
        return null;
      }
      const set: ComparatorSet = [];
      if (a.major !== null) set.push({ op: '>=', v: ver(a.major, a.minor ?? 0, a.patch ?? 0, a.pre) });
      if (b.major !== null) {
        if (b.minor === null) set.push({ op: '<', v: ver(b.major + 1, 0, 0, [0]) });
        else if (b.patch === null) set.push({ op: '<', v: ver(b.major, b.minor + 1, 0, [0]) });
        else set.push({ op: '<=', v: ver(b.major, b.minor, b.patch, b.pre) });
      }
      out.push(set);
      continue;
    }
    // normalise "> 1.2" → ">1.2"
    const toks = part.replace(/(<=|>=|<|>|=|~>|~|\^)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const set: ComparatorSet = [];
    for (const t of toks) {
      const c = expandComparator(t);
      if (!c) {
        rangeCache.set(key, null);
        return null;
      }
      set.push(...c);
    }
    out.push(set);
  }
  rangeCache.set(key, out);
  return out;
}

function testSet(set: ComparatorSet, v: SemVer, includePrerelease: boolean): boolean {
  for (const c of set) {
    const r = compare(v, c.v);
    switch (c.op) {
      case '<':
        if (!(r < 0)) return false;
        break;
      case '<=':
        if (!(r <= 0)) return false;
        break;
      case '>':
        if (!(r > 0)) return false;
        break;
      case '>=':
        if (!(r >= 0)) return false;
        break;
      case '=':
        if (r !== 0) return false;
        break;
    }
  }
  if (v.prerelease.length && !includePrerelease) {
    // a prerelease only matches if some comparator has the same [major, minor, patch] with a prerelease
    for (const c of set) {
      if (c.v.prerelease.length && c.v.prerelease[0] !== 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch) return true;
      if (c.v.prerelease.length && c.v.prerelease.length && !(c.v.prerelease.length === 1 && c.v.prerelease[0] === 0) && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch) return true;
    }
    return false;
  }
  return true;
}

export function satisfies(version: string | SemVer, range: string, opts: { includePrerelease?: boolean } = {}): boolean {
  const v = typeof version === 'string' ? parse(version) : version;
  if (!v) return false;
  const r = parseRange(range);
  if (!r) return false;
  return r.some((set) => testSet(set, v, !!opts.includePrerelease));
}

export function maxSatisfying(versions: string[], range: string, opts: { includePrerelease?: boolean } = {}): string | null {
  let best: SemVer | null = null;
  const r = parseRange(range);
  if (!r) return null;
  for (const s of versions) {
    const v = parse(s);
    if (!v) continue;
    if (!r.some((set) => testSet(set, v, !!opts.includePrerelease))) continue;
    if (!best || compare(v, best) > 0) best = v;
  }
  return best ? best.raw : null;
}

export function validRange(range: string): boolean {
  return parseRange(range) !== null;
}

export function rsort(versions: string[]): string[] {
  return versions.filter((v) => parse(v)).sort((a, b) => compare(b, a));
}

/** Smallest version that could satisfy a range (used for ordering heuristics). */
export function minVersion(range: string): string | null {
  const r = parseRange(range);
  if (!r) return null;
  let best: SemVer | null = null;
  for (const set of r) {
    let lo = ver(0, 0, 0);
    for (const c of set) if ((c.op === '>=' || c.op === '=') && compare(c.v, lo) > 0) lo = c.v;
    if (!best || compare(lo, best) < 0) best = lo;
  }
  return best?.raw ?? null;
}
