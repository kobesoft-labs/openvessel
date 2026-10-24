// Dependency resolution and installation into a hoisted node_modules tree.

import * as path from '../../shared/path.ts';
import type { VFS } from '../vfs.ts';
import { isDir } from '../vfs.ts';
import type { LockHints } from './lockfile.ts';
import type { PackageVersion, Packument, Registry } from './registry.ts';
import * as semver from './semver.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export interface InstallOptions {
  root: string;
  vfs: VFS;
  registry: Registry;
  lock: LockHints;
  omitDev?: boolean;
  omitOptional?: boolean;
  omitPeer?: boolean;
  log: (s: string) => void;
  warn: (s: string) => void;
  progress?: (s: string) => void;
}

/** Native packages replaced by their WebAssembly builds (same version). */
const SUBSTITUTES: { name: string; to: string; when?: (v: string) => boolean }[] = [
  { name: 'esbuild', to: 'esbuild-wasm' },
  { name: 'rollup', to: '@rollup/wasm-node', when: (v) => (semver.parse(v)?.major ?? 0) >= 4 },
  { name: 'lightningcss', to: 'lightningcss-wasm' },
  { name: 'sass-embedded', to: 'sass' },
];

/** Compat packages (scripts/build-compat.mjs): stand-ins for packages that only ship native binaries. */
interface CompatEntry {
  range: string;
  file: string;
  integrity: string;
  pkg: Record<string, any>;
}
let compatIndex: Promise<Record<string, CompatEntry>> | null = null;
function compatOrigin(): string | null {
  return typeof location !== 'undefined' ? location.origin : null;
}
function loadCompat(): Promise<Record<string, CompatEntry>> {
  const origin = compatOrigin();
  compatIndex ??= origin
    ? fetch(`${origin}/compat/index.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
    : Promise.resolve({});
  return compatIndex;
}

/**
 * Dependencies of wasm builds pinned to what they were built against: their glue reaches into the
 * runtime's internals, so a later version that still satisfies the range breaks them.
 */
const DEP_PINS: { pkg: string; range: string; dep: string; spec: string }[] = [
  // emscripten + emnapi 1.1 glue; @emnapi/runtime 1.2+ changed the callback-info stack it uses
  { pkg: '@img/sharp-wasm32', range: '<0.34.0', dep: '@emnapi/runtime', spec: '1.1.1' },
];
function pinnedSpec(from: Node, dep: string, spec: string): string {
  const pin = DEP_PINS.find((p) => p.pkg === from.name && p.dep === dep && semver.satisfies(from.version, p.range));
  return pin ? pin.spec : spec;
}

/**
 * Old majors with only native builds, moved to the first line that has a wasm build (same API for
 * what the callers use). sharp before 0.33 bundled libvips as a .node addon.
 */
const UPGRADES: { name: string; range: string; to: string }[] = [{ name: 'sharp', range: '<0.33.0', to: '^0.34.0' }];

/** The `packages:` list of pnpm-workspace.yaml (other keys hold lists too: overrides, excludes…). */
function pnpmWorkspacePackages(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:/.test(line);
      const inline = /^packages\s*:\s*\[(.*)\]/.exec(line);
      if (inline) for (const p of inline[1].split(',')) out.push(p.trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const m = inPackages && /^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*(#.*)?$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out.filter(Boolean);
}

/** Packages that are never installed (native-only and optional at runtime). */
const SKIP = new Set(['fsevents', 'bufferutil', 'utf-8-validate', 'cpu-features', 'ssh2']);

interface Source {
  kind: 'registry' | 'tarball' | 'link';
  tarball?: string;
  integrity?: string;
  shasum?: string;
  linkTarget?: string;
  /** Install this package's contents under the node's name (wasm substitution / alias). */
  realName?: string;
}

export class Node {
  name: string;
  version: string;
  pkg: PackageVersion | Record<string, any>;
  parent: Node | null;
  /** Packages in this node's node_modules. */
  children = new Map<string, Node>();
  /** Absolute directory of this package. */
  dir: string;
  source: Source;
  dev = false;
  optional = false;
  isRoot = false;
  isWorkspace = false;
  constructor(name: string, version: string, pkg: any, parent: Node | null, dir: string, source: Source) {
    this.name = name;
    this.version = version;
    this.pkg = pkg;
    this.parent = parent;
    this.dir = dir;
    this.source = source;
  }
  get nodeModules() {
    return path.join(this.dir, 'node_modules');
  }
  /** Resolution chain: this node, its container, and so on up to the root. */
  *chain(): Generator<Node> {
    let n: Node | null = this;
    while (n) {
      yield n;
      n = n.parent;
    }
  }
}

interface Edge {
  from: Node;
  name: string;
  spec: string;
  target: Node;
}

/**
 * napi-rs packages list native bindings per platform as optional deps; when the
 * WebAssembly (wasm32-wasi) build is published but not listed, add it.
 */
function withWasiBinding(opt: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!opt) return opt;
  const names = Object.keys(opt);
  if (names.some((n) => n.includes('wasm32'))) return opt;
  const native = names.find((n) => /-(linux|darwin|win32|freebsd|android)-(x64|arm64|arm|ia32)(-gnu|-musl|-msvc|-gnueabihf|-eabi)?$/.test(n));
  if (!native) return opt;
  const base = native.replace(/-(linux|darwin|win32|freebsd|android)-(x64|arm64|arm|ia32)(-gnu|-musl|-msvc|-gnueabihf|-eabi)?$/, '');
  return { ...opt, [`${base}-wasm32-wasi`]: opt[native] };
}

/**
 * napi-rs wasm32-wasi bindings built with emnapi 1.x often don't list @emnapi/core and take
 * whatever @napi-rs/wasm-runtime's peer finds, which can be another binding's emnapi 2 (its wasm
 * imports napi_set_last_error, which 2.x dropped). Bindings built for emnapi 2 list it themselves.
 */
function withEmnapi(name: string, deps: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!name.endsWith('-wasm32-wasi') || deps?.['@emnapi/core']) return deps;
  return { '@emnapi/core': '^1.4.0', '@emnapi/runtime': '^1.4.0', ...deps };
}

function platformOk(pkg: { os?: string[]; cpu?: string[] }): boolean {
  const check = (list: string[] | undefined, want: string) => {
    if (!list || !list.length) return true;
    if (list.includes('!' + want)) return false;
    const pos = list.filter((x) => !x.startsWith('!'));
    return pos.length === 0 || pos.includes(want);
  };
  return check(pkg.os, 'linux') && check(pkg.cpu, 'wasm32');
}

function isRange(spec: string) {
  return semver.validRange(spec);
}

export class Installer {
  root!: Node;
  private edges = new Map<string, Edge[]>();
  private nodes: Node[] = [];
  private overrides: Record<string, string> = {};
  private warned = new Set<string>();
  private workspaces = new Map<string, Node>();

  constructor(private o: InstallOptions) {}

  private readJson(p: string): any | null {
    try {
      return JSON.parse(dec.decode(this.o.vfs.readFile(p)));
    } catch {
      return null;
    }
  }

  async run(): Promise<{ added: number; total: number; ms: number }> {
    const t0 = performance.now();
    const rootPkg = this.readJson(path.join(this.o.root, 'package.json'));
    if (!rootPkg) throw Object.assign(new Error(`Could not read package.json in ${this.o.root}`), { code: 'ENOENT' });
    this.root = new Node(rootPkg.name ?? path.basename(this.o.root), rootPkg.version ?? '0.0.0', rootPkg, null, this.o.root, { kind: 'link' });
    this.root.isRoot = true;
    this.collectOverrides(rootPkg);
    this.setupWorkspaces(rootPkg);

    // breadth-first resolution
    const queue: { from: Node; name: string; spec: string; dev: boolean; optional: boolean; peer: boolean }[] = [];
    const enqueueDeps = (n: Node, includeDev: boolean) => {
      const pkg = n.pkg as any;
      const add = (deps: Record<string, string> | undefined, dev: boolean, optional: boolean, peer: boolean) => {
        for (const [name, spec] of Object.entries(deps ?? {})) {
          if (SKIP.has(name)) continue;
          queue.push({ from: n, name, spec: String(spec), dev, optional, peer });
          // prefetch metadata
          if (!/^(file|link|workspace|git|github|https?):/.test(String(spec)) && !String(spec).includes('/') && !this.workspaces.has(name)) this.o.registry.packument(this.aliasTarget(name, String(spec))).catch(() => {});
        }
      };
      // (written into the package's own dependencies so peer-set checks see it too)
      if (!n.isRoot) pkg.dependencies = withEmnapi(n.name, pkg.dependencies);
      add(pkg.dependencies, n.dev, n.optional, false);
      if (!this.o.omitOptional) add(withWasiBinding(pkg.optionalDependencies), n.dev, true, false);
      if (includeDev && !this.o.omitDev) add(pkg.devDependencies, true, false, false);
      if (!this.o.omitPeer && !n.isRoot) {
        const meta = pkg.peerDependenciesMeta ?? {};
        const peers: Record<string, string> = {};
        for (const [k, v] of Object.entries<string>(pkg.peerDependencies ?? {})) if (!meta[k]?.optional) peers[k] = v;
        add(peers, n.dev, n.optional, true);
      }
    };
    enqueueDeps(this.root, true);
    for (const ws of this.workspaces.values()) enqueueDeps(ws, true);

    let processed = 0;
    while (queue.length) {
      const item = queue.shift()!;
      processed++;
      if (processed % 50 === 0) this.o.progress?.(`resolving… ${this.nodes.length} packages`);
      // optional deps already filtered/failed
      const placeFrom = item.peer ? (item.from.parent ?? item.from) : item.from;
      const spec = this.overrides[item.name] ?? pinnedSpec(item.from, item.name, item.spec);
      const visible = this.findVisible(placeFrom, item.name);
      if (visible && (visible.isWorkspace || (this.satisfiesNode(visible, spec) && this.peerSetOk(visible, item.from)))) {
        this.addEdge(item.from, item.name, spec, visible);
        if (!item.dev) this.clearDev(visible);
        if (!item.optional) this.clearOptional(visible);
        continue;
      }
      if (visible && item.peer) {
        this.warnOnce(`peer:${item.from.name}:${item.name}`, `npm warn ERESOLVE ${item.from.name}@${item.from.version} wants peer ${item.name}@"${spec}", found ${visible.version}`);
        this.addEdge(item.from, item.name, spec, visible);
        continue;
      }
      let resolved: { version: string; pkg: PackageVersion; source: Source } | null;
      try {
        resolved = await this.resolve(item.name, spec);
      } catch (e: any) {
        if (item.optional) {
          this.warnOnce(`opt:${item.name}`, `npm warn optional skipping ${item.name}@${spec}: ${e.message}`);
          continue;
        }
        throw e;
      }
      if (!resolved) continue;
      if (!platformOk(resolved.pkg)) {
        if (!item.optional) this.warnOnce(`plat:${item.name}`, `npm warn EBADPLATFORM skipping ${item.name}@${resolved.version} (needs ${[resolved.pkg.os, resolved.pkg.cpu].filter(Boolean).join(' / ')})`);
        continue;
      }
      if (resolved.pkg.deprecated) this.warnOnce(`dep:${item.name}@${resolved.version}`, `npm warn deprecated ${item.name}@${resolved.version}: ${resolved.pkg.deprecated}`);
      // a pinned dependency stays with its dependent, so nothing else picks up the old version
      const pinned = spec !== item.spec && this.overrides[item.name] === undefined;
      const level = pinned ? placeFrom : this.choosePlacement(placeFrom, item.name, resolved.version, resolved.pkg);
      const node = new Node(item.name, resolved.version, resolved.pkg, level, path.join(level.nodeModules, item.name), resolved.source);
      node.dev = item.dev;
      node.optional = item.optional;
      level.children.set(item.name, node);
      this.nodes.push(node);
      this.addEdge(item.from, item.name, spec, node);
      enqueueDeps(node, false);
    }

    this.o.progress?.(`fetching ${this.nodes.length} packages…`);
    const added = await this.materialize();
    this.linkBins();
    this.writeHiddenLock();
    return { added, total: this.nodes.length, ms: performance.now() - t0 };
  }

  private warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.o.warn(msg);
  }

  private collectOverrides(pkg: any) {
    const take = (o: any) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v !== 'string') continue;
        const name = k.replace(/^\*\*\//, '').replace(/@[^@/]+$/, (m) => (k.startsWith('@') && k.indexOf('@', 1) === -1 ? m : ''));
        if (name.includes('/') && !name.startsWith('@')) continue;
        this.overrides[name] = v.startsWith('$') ? (pkg.dependencies?.[v.slice(1)] ?? pkg.devDependencies?.[v.slice(1)] ?? '*') : v;
      }
    };
    take(pkg.overrides);
    take(pkg.resolutions);
    take(pkg.pnpm?.overrides);
  }

  private setupWorkspaces(pkg: any) {
    const patterns: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    let pnpmWs: string[] = [];
    try {
      const y = dec.decode(this.o.vfs.readFile(path.join(this.o.root, 'pnpm-workspace.yaml')));
      pnpmWs = pnpmWorkspacePackages(y);
    } catch {}
    for (const pat of [...patterns, ...pnpmWs]) {
      if (pat.startsWith('!')) continue;
      for (const dir of this.expandWorkspaceGlob(pat)) {
        const wpkg = this.readJson(path.join(dir, 'package.json'));
        if (!wpkg?.name || dir === this.o.root) continue;
        const n = new Node(wpkg.name, wpkg.version ?? '0.0.0', wpkg, this.root, dir, { kind: 'link', linkTarget: dir });
        n.isWorkspace = true;
        this.workspaces.set(wpkg.name, n);
        this.root.children.set(wpkg.name, n);
        this.nodes.push(n);
      }
    }
  }

  private expandWorkspaceGlob(pat: string): string[] {
    const parts = pat.replace(/\/$/, '').split('/');
    let bases = [this.o.root];
    for (const part of parts) {
      const next: string[] = [];
      for (const b of bases) {
        if (part === '*' || part === '**') {
          try {
            for (const [name, t] of this.o.vfs.readdirTypes(b)) if (t === 0o040000 && name !== 'node_modules' && !name.startsWith('.')) next.push(path.join(b, name));
          } catch {}
        } else if (part.includes('*')) {
          const re = new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
          try {
            for (const [name, t] of this.o.vfs.readdirTypes(b)) if (t === 0o040000 && re.test(name)) next.push(path.join(b, name));
          } catch {}
        } else next.push(path.join(b, part));
      }
      bases = next;
    }
    return bases.filter((d) => this.o.vfs.exists(path.join(d, 'package.json')));
  }

  private addEdge(from: Node, name: string, spec: string, target: Node) {
    let l = this.edges.get(name);
    if (!l) this.edges.set(name, (l = []));
    l.push({ from, name, spec, target });
  }

  private clearDev(n: Node) {
    n.dev = false;
  }
  private clearOptional(n: Node) {
    n.optional = false;
  }

  /** A reused package must see the same peer instances as the dependent that wants it. */
  private peerSetOk(n: Node, dependent: Node): boolean {
    const pkg = n.pkg as any;
    const peers = Object.keys(pkg.peerDependencies ?? {});
    if (!peers.length) return true;
    const deps = { ...(dependent.pkg as any).dependencies, ...(dependent.pkg as any).optionalDependencies } as Record<string, string>;
    for (const pn of peers) {
      const own = deps[pn];
      if (own === undefined) continue;
      const theirs = this.findVisible(n, pn);
      const mine = this.findVisible(dependent, pn);
      // the dependent's own copy may not be placed yet: what it sees now only counts if it fits its range
      if (theirs && !this.satisfiesNode(theirs, own)) return false;
      if (mine && theirs && mine !== theirs && this.satisfiesNode(mine, own)) return false;
    }
    return true;
  }

  private findVisible(from: Node, name: string): Node | null {
    for (const n of from.chain()) {
      const c = n.children.get(name);
      if (c) return c;
      if (n.isRoot && this.workspaces.has(name)) return this.workspaces.get(name)!;
    }
    return null;
  }

  private satisfiesNode(n: Node, spec: string): boolean {
    if (n.isWorkspace) return true;
    if (spec.startsWith('npm:')) {
      const at = spec.lastIndexOf('@');
      const range = at > 4 ? spec.slice(at + 1) : '*';
      return isRange(range) ? semver.satisfies(n.version, range, { includePrerelease: true }) : true;
    }
    if (/^(workspace|file|link|catalog):/.test(spec)) return true;
    if (/^(git|github:|https?:)|^[\w-]+\/[\w.-]+(#.*)?$/.test(spec)) return n.source.tarball !== undefined;
    if (!isRange(spec)) return true; // dist-tag: accept whatever is there
    return semver.satisfies(n.version, spec, { includePrerelease: semver.parse(n.version)?.prerelease.length ? true : false });
  }

  /** Highest level (container) where name@version can be placed without conflicts. */
  private choosePlacement(from: Node, name: string, version: string, pkg?: PackageVersion): Node {
    let target = from;
    let cur = from;
    const meta = (pkg?.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
    const peers = Object.entries(pkg?.peerDependencies ?? {}).filter(([k]) => !meta[k]?.optional);
    while (cur.parent) {
      const parent = cur.parent;
      if (parent.children.has(name)) break;
      if (this.wouldShadow(parent, name, version)) break;
      // don't hoist past a level where our peers would resolve to an incompatible version
      // ...and peers must be the same instance the dependent itself uses (npm's peer sets)
      const fromDeps = { ...(from.pkg as any).dependencies, ...(from.pkg as any).optionalDependencies, ...(from.isRoot ? (from.pkg as any).devDependencies : {}) } as Record<string, string>;
      if (peers.some(([pn, range]) => {
        const v = this.findVisible(parent, pn);
        const here = this.findVisible(cur, pn);
        if (v && v !== here && !this.satisfiesNode(v, String(range))) return true;
        const own = fromDeps[pn];
        if (own === undefined) return false;
        const mine = this.findVisible(from, pn);
        if (mine && this.satisfiesNode(mine, own)) return v !== mine;
        return !!v && !this.satisfiesNode(v, own);
      })) break;
      cur = parent;
      target = cur;
    }
    // the root may also be blocked by an existing root-level package of the same name
    if (target.children.has(name)) return from;
    return target;
  }

  private wouldShadow(level: Node, name: string, version: string): boolean {
    const edges = this.edges.get(name);
    if (!edges) return false;
    for (const e of edges) {
      if (e.target.version === version) continue;
      // does e.from's resolution chain pass through `level` before reaching e.target's container?
      let passes = false;
      for (const n of e.from.chain()) {
        if (n === level) {
          passes = true;
          break;
        }
        if (n.children.get(name) === e.target) break;
      }
      if (passes) return true;
    }
    return false;
  }

  private aliasTarget(name: string, spec: string) {
    if (spec.startsWith('npm:')) {
      const s = spec.slice(4);
      const at = s.lastIndexOf('@');
      return at > 0 ? s.slice(0, at) : s;
    }
    return name;
  }

  private pickVersion(p: Packument, name: string, range: string): string | null {
    const versions = Object.keys(p.versions ?? {});
    if (!isRange(range)) {
      const tagged = p['dist-tags']?.[range];
      return tagged && p.versions[tagged] ? tagged : null;
    }
    const hints = this.o.lock.versions.get(name);
    if (hints) {
      const ok = [...hints].filter((v) => p.versions[v] && semver.satisfies(v, range, { includePrerelease: true })).sort((a, b) => semver.compare(b, a));
      if (ok.length) return ok[0];
    }
    const latest = p['dist-tags']?.latest;
    if (latest && semver.satisfies(latest, range)) return latest;
    return semver.maxSatisfying(versions, range) ?? semver.maxSatisfying(versions, range, { includePrerelease: true });
  }

  private async resolve(name: string, spec: string): Promise<{ version: string; pkg: PackageVersion; source: Source } | null> {
    if (spec.startsWith('workspace:') || this.workspaces.has(name)) {
      const ws = this.workspaces.get(name);
      if (ws) return null;
      spec = spec.replace(/^workspace:/, '');
      if (spec === '*' || spec === '^' || spec === '~') spec = '*';
    }
    if (spec.startsWith('catalog:')) spec = '*';
    if (spec.startsWith('file:') || spec.startsWith('link:')) {
      const target = path.resolve(this.o.root, spec.replace(/^(file|link):/, ''));
      const pkg = this.readJson(path.join(target, 'package.json'));
      if (!pkg) throw Object.assign(new Error(`could not read ${target}/package.json`), { code: 'ENOENT' });
      return { version: pkg.version ?? '0.0.0', pkg, source: { kind: 'link', linkTarget: target } };
    }
    const gh = /^(?:github:|git\+https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com[:/]|https:\/\/github\.com\/|git:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.+))?$/.exec(spec);
    if (gh && !spec.startsWith('npm:') && !spec.startsWith('@') && (spec.includes('github') || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec))) {
      const ref = gh[3] ?? 'HEAD';
      const tarball = `https://codeload.github.com/${gh[1]}/${gh[2]}/tar.gz/${ref.replace(/^semver:/, '')}`;
      const entries = await this.o.registry.tarball(tarball);
      const pj = entries.find((e) => /^[^/]+\/package\.json$/.test(e.path));
      const pkg = pj ? JSON.parse(dec.decode(pj.data)) : { name, version: '0.0.0' };
      return { version: pkg.version ?? '0.0.0', pkg: { ...pkg, dist: { tarball } }, source: { kind: 'tarball', tarball } };
    }
    if (/^https?:\/\//.test(spec)) {
      const entries = await this.o.registry.tarball(spec);
      const pj = entries.find((e) => /^[^/]+\/package\.json$/.test(e.path));
      const pkg = pj ? JSON.parse(dec.decode(pj.data)) : { name, version: '0.0.0' };
      return { version: pkg.version ?? '0.0.0', pkg: { ...pkg, dist: { tarball: spec } }, source: { kind: 'tarball', tarball: spec } };
    }
    let realName = name;
    let range = spec || '*';
    if (spec.startsWith('npm:')) {
      const s = spec.slice(4);
      const at = s.lastIndexOf('@');
      if (at > 0) {
        realName = s.slice(0, at);
        range = s.slice(at + 1) || '*';
      } else {
        realName = s;
        range = '*';
      }
    }
    range = range.trim();
    const p = await this.o.registry.packument(realName);
    let version = this.pickVersion(p, realName, range);
    const up = version && UPGRADES.find((u) => u.name === realName && semver.satisfies(version!, u.range));
    if (up) version = this.pickVersion(p, realName, up.to);
    if (!version) throw Object.assign(new Error(`No matching version found for ${realName}@${range}.`), { code: 'ETARGET' });
    let pkg = p.versions[version];
    let source: Source = { kind: 'registry', tarball: pkg.dist.tarball, integrity: pkg.dist.integrity, shasum: pkg.dist.shasum, realName: realName !== name ? realName : undefined };
    // compat packages built by OpenVessel (a wasm build or a JS shim), under the requested name and version
    const compat = (await loadCompat())[realName];
    if (compat && semver.satisfies(version, compat.range, { includePrerelease: true })) {
      pkg = { ...compat.pkg, name: realName, version, dist: { tarball: `${compatOrigin()}/compat/${compat.file}`, integrity: compat.integrity } } as any;
      source = { kind: 'registry', tarball: `${compatOrigin()}/compat/${compat.file}`, integrity: compat.integrity, realName: compat.pkg.name };
      return { version, pkg, source };
    }
    // WebAssembly substitutes for native packages
    const sub = SUBSTITUTES.find((s) => s.name === realName && (!s.when || s.when(version)));
    if (sub) {
      try {
        const sp = await this.o.registry.packument(sub.to);
        const sv = sp.versions[version] ? version : semver.maxSatisfying(Object.keys(sp.versions), `~${version}`) ?? semver.maxSatisfying(Object.keys(sp.versions), `^${version}`);
        if (sv) {
          const spkg = sp.versions[sv];
          pkg = { ...spkg, name: realName, version, bin: spkg.bin ?? pkg.bin };
          source = { kind: 'registry', tarball: spkg.dist.tarball, integrity: spkg.dist.integrity, shasum: spkg.dist.shasum, realName: sub.to };
        }
      } catch {}
    }
    return { version, pkg, source };
  }

  // ---------------------------------------------------------------------------
  // writing files

  private readHiddenLock(): Record<string, { version: string; resolved?: string }> {
    const j = this.readJson(path.join(this.o.root, 'node_modules/.package-lock.json'));
    return j?.packages ?? {};
  }

  private rel(dir: string) {
    return path.relative(this.o.root, dir);
  }

  private async materialize(): Promise<number> {
    const vfs = this.o.vfs;
    const prev = this.readHiddenLock();
    const want = new Map<string, Node>();
    for (const n of this.nodes) if (!n.isWorkspace) want.set(this.rel(n.dir), n);
    // prune packages that are no longer in the tree
    for (const loc of Object.keys(prev)) {
      if (!loc.startsWith('node_modules/') && !loc.includes('/node_modules/')) continue;
      if (!want.has(loc)) vfs.rmrf(path.join(this.o.root, loc));
    }
    const made = new Set<string>();
    const mkdirp = (d: string) => {
      if (made.has(d)) return;
      if (!vfs.exists(d)) vfs.mkdir(d, 0o755, true);
      made.add(d);
    };
    let added = 0;
    let done = 0;
    const total = want.size;
    const jobs: Promise<void>[] = [];
    for (const [loc, n] of want) {
      const old = prev[loc];
      const pj = this.readJson(path.join(n.dir, 'package.json'));
      if (old && old.version === n.version && pj && pj.version === n.version && (old.resolved ?? '') === (n.source.tarball ?? n.source.linkTarget ?? '')) {
        done++;
        continue;
      }
      if (n.source.kind === 'link') {
        mkdirp(path.dirname(n.dir));
        vfs.rmrf(n.dir);
        vfs.symlink(path.relative(path.dirname(n.dir), n.source.linkTarget!), n.dir);
        added++;
        continue;
      }
      // clear the old copy now, before any extraction, and keep its node_modules: that holds the
      // packages nested in it, which may be up to date or extracted before it
      const existing = vfs.tryLookup(n.dir, false);
      if (existing && !isDir(existing)) vfs.rmrf(n.dir); // a symlink (an earlier link) or a file
      else if (existing) for (const name of vfs.readdir(n.dir)) if (name !== 'node_modules') vfs.rmrf(path.join(n.dir, name));
      jobs.push(
        (async () => {
          const entries = await this.o.registry.tarball(n.source.tarball!, n.source.integrity, n.source.shasum);
          mkdirp(n.dir);
          for (const e of entries) {
            const rel = e.path.replace(/^[^/]*\/?/, '');
            if (!rel || rel.includes('..')) continue;
            const target = path.join(n.dir, rel);
            if (e.type === 'dir') {
              mkdirp(target);
              continue;
            }
            mkdirp(path.dirname(target));
            if (e.type === 'symlink') {
              try {
                vfs.symlink(e.linkname, target);
              } catch {}
              continue;
            }
            if (e.type !== 'file') continue;
            let data = e.data;
            if (rel === 'package.json' && n.source.realName) {
              try {
                const j = JSON.parse(dec.decode(data));
                j.name = n.name;
                j.version = n.version;
                j._openvesselSource = `${n.source.realName}@${(n.pkg as any).version}`;
                data = enc.encode(JSON.stringify(j, null, 2));
              } catch {}
            }
            vfs.writeFile(target, data, e.mode & 0o111 ? 0o755 : 0o644);
            if (e.mode & 0o111) vfs.chmod(target, 0o755);
          }
          added++;
          done++;
          if (done % 25 === 0) this.o.progress?.(`extracting… ${done}/${total}`);
        })(),
      );
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length) throw failed[0].reason;
    return added;
  }

  private binsOf(n: Node): Record<string, string> {
    const pkg = n.pkg as any;
    let bin = pkg.bin;
    if (!bin) {
      // tarball manifests are authoritative
      const pj = this.readJson(path.join(n.dir, 'package.json'));
      bin = pj?.bin;
      if (!bin && pj?.directories?.bin) {
        const d = path.join(n.dir, pj.directories.bin);
        try {
          bin = Object.fromEntries(this.o.vfs.readdir(d).map((f) => [f, path.join(pj.directories.bin, f)]));
        } catch {}
      }
    }
    if (!bin) return {};
    if (typeof bin === 'string') return { [n.name.replace(/^@[^/]+\//, '')]: bin };
    return bin;
  }

  private linkBins() {
    const vfs = this.o.vfs;
    // containers in order: deeper first so root-level wins on conflicts
    const byContainer = new Map<Node, Node[]>();
    for (const n of this.nodes) {
      if (!n.parent) continue;
      let l = byContainer.get(n.parent);
      if (!l) byContainer.set(n.parent, (l = []));
      l.push(n);
    }
    for (const [container, list] of byContainer) {
      const binDir = path.join(container.nodeModules, '.bin');
      const direct = new Set(Object.keys({ ...(container.pkg as any).dependencies, ...(container.pkg as any).devDependencies, ...(container.pkg as any).optionalDependencies }));
      // direct deps last so they win
      list.sort((a, b) => Number(direct.has(a.name)) - Number(direct.has(b.name)));
      for (const n of list) {
        const bins = this.binsOf(n);
        for (const [bname, rel] of Object.entries(bins)) {
          if (!bname || bname.includes('/') || bname.includes('..')) continue;
          const target = path.join(n.isWorkspace ? n.dir : n.dir, rel);
          if (!vfs.exists(binDir)) vfs.mkdir(binDir, 0o755, true);
          const link = path.join(binDir, bname);
          try {
            if (vfs.tryLookup(link, false)) vfs.unlink(link);
            vfs.symlink(path.relative(binDir, target), link);
            if (vfs.exists(target)) vfs.chmod(target, 0o755);
          } catch {}
        }
      }
    }
  }

  private writeHiddenLock() {
    const packages: Record<string, any> = {};
    for (const n of this.nodes) {
      packages[this.rel(n.dir)] = { version: n.version, resolved: n.source.tarball ?? n.source.linkTarget, integrity: n.source.integrity, dev: n.dev || undefined, optional: n.optional || undefined, link: n.source.kind === 'link' || undefined };
    }
    const nm = path.join(this.o.root, 'node_modules');
    if (!this.o.vfs.exists(nm)) this.o.vfs.mkdir(nm, 0o755, true);
    this.o.vfs.writeFile(path.join(nm, '.package-lock.json'), JSON.stringify({ name: this.root.name, lockfileVersion: 3, requires: true, packages }, null, 2));
  }

  /** Flat list of installed packages (for `npm ls`). */
  listTop(): { name: string; version: string }[] {
    return [...this.root.children.values()].map((n) => ({ name: n.name, version: n.version }));
  }
}

export function readJsonFile(vfs: VFS, p: string): any | null {
  try {
    return JSON.parse(dec.decode(vfs.readFile(p)));
  } catch {
    return null;
  }
}

export function isDirectory(vfs: VFS, p: string) {
  const n = vfs.tryLookup(p);
  return !!n && isDir(n);
}
