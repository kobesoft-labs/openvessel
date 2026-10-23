// Node.js module resolution (CommonJS and ESM) over an abstract file system.

import * as path from './path.ts';

export interface ResolveHost {
  /** 'file' | 'dir' | null, following symlinks. */
  kind(p: string): 'file' | 'dir' | null;
  readText(p: string): string | null;
  realpath(p: string): string;
  /** Cache key for a file's current version (e.g. ino+mtime), used to cache package.json. */
  version?(p: string): string | null;
}

export interface PackageJson {
  name?: string;
  main?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
  module?: string;
  browser?: unknown;
  [k: string]: unknown;
}

export class ResolveError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const BUILTIN_MODULES = [
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server', '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform', '_stream_wrap', '_stream_writable', '_tls_common', '_tls_wrap',
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
];
const BUILTIN_SET = new Set(BUILTIN_MODULES);
const NODE_ONLY = new Set(['test', 'test/reporters', 'sqlite', 'sea']);

/** Returns the canonical builtin name for a specifier, or null. */
export function builtinName(spec: string): string | null {
  if (spec.startsWith('node:')) {
    const n = spec.slice(5);
    if (BUILTIN_SET.has(n) || NODE_ONLY.has(n)) return n;
    return null;
  }
  return BUILTIN_SET.has(spec) ? spec : null;
}

export const CJS_CONDITIONS = ['require', 'node', 'module-sync', 'default'];
export const ESM_CONDITIONS = ['import', 'node', 'module-sync', 'default'];

export class Resolver {
  private pkgCache = new Map<string, { v: string | null; pkg: PackageJson | null }>();
  constructor(public host: ResolveHost) {}

  readPackageJson(file: string): PackageJson | null {
    const v = this.host.version ? this.host.version(file) : null;
    const hit = this.pkgCache.get(file);
    if (hit && (hit.v === v || !this.host.version) && v !== null) return hit.pkg;
    const text = this.host.readText(file);
    let pkg: PackageJson | null = null;
    if (text !== null) {
      try {
        pkg = JSON.parse(text);
      } catch {
        throw new ResolveError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${file}.`);
      }
    }
    if (this.pkgCache.size > 5000) this.pkgCache.clear();
    this.pkgCache.set(file, { v, pkg });
    return pkg;
  }

  /** Finds the nearest package.json scope for a file. */
  findPackageScope(file: string): { dir: string; pkg: PackageJson } | null {
    let dir = path.dirname(file);
    for (;;) {
      if (path.basename(dir) === 'node_modules') return null;
      const pj = path.join(dir, 'package.json');
      if (this.host.kind(pj) === 'file') {
        const pkg = this.readPackageJson(pj);
        if (pkg) return { dir, pkg };
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /** Module format for a file path: 'module' | 'commonjs' | 'json' | 'wasm' | 'addon' | 'typescript' | null (detect). */
  formatOf(file: string): 'module' | 'commonjs' | 'json' | 'wasm' | 'addon' | 'module-typescript' | 'commonjs-typescript' | null {
    const ext = path.extname(file);
    switch (ext) {
      case '.mjs':
        return 'module';
      case '.cjs':
        return 'commonjs';
      case '.json':
        return 'json';
      case '.wasm':
        return 'wasm';
      case '.node':
        return 'addon';
      case '.mts':
        return 'module-typescript';
      case '.cts':
        return 'commonjs-typescript';
    }
    const scope = this.findPackageScope(file);
    const type = scope?.pkg.type;
    if (ext === '.ts') return type === 'module' ? 'module-typescript' : type === 'commonjs' ? 'commonjs-typescript' : 'module-typescript';
    if (type === 'module') return 'module';
    if (type === 'commonjs') return 'commonjs';
    return null; // no explicit type: syntax detection
  }

  // ---------------------------------------------------------------------------
  // CommonJS

  resolveCjs(spec: string, fromDir: string, opts: { extensions?: string[]; conditions?: string[]; paths?: string[] } = {}): string {
    const exts = opts.extensions ?? ['.js', '.json', '.node'];
    const conditions = opts.conditions ?? CJS_CONDITIONS;
    const b = builtinName(spec);
    if (b && (spec.startsWith('node:') || !this.isShadowed(spec))) return 'node:' + b;
    if (spec.startsWith('node:')) throw new ResolveError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${spec}`);
    let file: string | null = null;
    if (spec.startsWith('file://')) spec = fileURLToPathLoose(spec);
    if (spec.startsWith('/') || spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      const abs = path.resolve(fromDir, spec);
      file = this.loadAsFile(abs, exts) ?? this.loadAsDirectory(abs, exts);
      if (!file && spec.endsWith('/')) file = this.loadAsDirectory(abs, exts);
    } else if (spec.startsWith('#')) {
      file = this.packageImports(spec, fromDir, conditions, true, exts);
    } else {
      file = this.packageSelf(spec, fromDir, conditions, true, exts);
      if (!file) {
        const dirs = opts.paths ?? this.nodeModulesPaths(fromDir);
        for (const dir of dirs) {
          file = this.loadNodeModule(spec, dir, conditions, exts);
          if (file) break;
        }
      }
    }
    if (!file) {
      const err = new ResolveError('MODULE_NOT_FOUND', `Cannot find module '${spec}'`);
      throw err;
    }
    return this.real(file);
  }

  private isShadowed(_spec: string) {
    return false;
  }

  private real(p: string) {
    try {
      return this.host.realpath(p);
    } catch {
      return p;
    }
  }

  nodeModulesPaths(fromDir: string): string[] {
    const out: string[] = [];
    let dir = path.resolve(fromDir);
    for (;;) {
      if (path.basename(dir) !== 'node_modules') out.push(path.join(dir, 'node_modules'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    out.push('/home/user/.node_modules', '/home/user/.node_libraries', '/usr/lib/node');
    return out;
  }

  private loadAsFile(p: string, exts: string[]): string | null {
    if (this.host.kind(p) === 'file') return p;
    for (const e of exts) if (this.host.kind(p + e) === 'file') return p + e;
    return null;
  }

  private loadIndex(p: string, exts: string[]): string | null {
    for (const e of exts) {
      const f = path.join(p, 'index' + e);
      if (this.host.kind(f) === 'file') return f;
    }
    return null;
  }

  private loadAsDirectory(p: string, exts: string[]): string | null {
    if (this.host.kind(p) !== 'dir') return null;
    const pj = path.join(p, 'package.json');
    if (this.host.kind(pj) === 'file') {
      const pkg = this.readPackageJson(pj);
      if (pkg && typeof pkg.main === 'string' && pkg.main) {
        const m = path.resolve(p, pkg.main);
        const f = this.loadAsFile(m, exts) ?? this.loadIndex(m, exts);
        if (f) return f;
      }
    }
    return this.loadIndex(p, exts);
  }

  private splitSpec(spec: string): { name: string; sub: string } {
    let name: string;
    if (spec.startsWith('@')) {
      const i = spec.indexOf('/');
      const j = i === -1 ? -1 : spec.indexOf('/', i + 1);
      name = j === -1 ? spec : spec.slice(0, j);
    } else {
      const i = spec.indexOf('/');
      name = i === -1 ? spec : spec.slice(0, i);
    }
    return { name, sub: '.' + spec.slice(name.length) };
  }

  private loadNodeModule(spec: string, nmDir: string, conditions: string[], exts: string[]): string | null {
    const { name, sub } = this.splitSpec(spec);
    const pkgDir = path.join(nmDir, name);
    if (this.host.kind(pkgDir) !== 'dir') return null;
    const pkg = this.readPackageJson(path.join(pkgDir, 'package.json'));
    if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
      const r = this.packageExportsResolve(pkgDir, sub, pkg.exports, conditions, spec);
      return this.host.kind(r) === 'file' ? r : this.notFoundExport(r, spec);
    }
    const abs = path.join(nmDir, spec);
    return this.loadAsFile(abs, exts) ?? this.loadAsDirectory(abs, exts);
  }

  private notFoundExport(r: string, spec: string): never {
    throw new ResolveError('MODULE_NOT_FOUND', `Cannot find module '${r}' (resolved from '${spec}')`);
  }

  private packageSelf(spec: string, fromDir: string, conditions: string[], cjs: boolean, exts: string[]): string | null {
    const scope = this.findPackageScope(path.join(fromDir, 'x'));
    if (!scope || !scope.pkg.name || scope.pkg.exports === undefined || scope.pkg.exports === null) return null;
    const { name, sub } = this.splitSpec(spec);
    if (name !== scope.pkg.name) return null;
    const r = this.packageExportsResolve(scope.dir, sub, scope.pkg.exports, conditions, spec);
    void cjs;
    void exts;
    return this.host.kind(r) === 'file' ? r : null;
  }

  // ---------------------------------------------------------------------------
  // exports / imports (shared by CJS and ESM)

  packageExportsResolve(pkgDir: string, sub: string, exports: unknown, conditions: string[], spec: string): string {
    let map = exports;
    if (typeof exports === 'string' || Array.isArray(exports) || (exports && typeof exports === 'object' && !Object.keys(exports).some((k) => k.startsWith('.')))) {
      map = { '.': exports };
    }
    const obj = map as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, sub) && !sub.includes('*')) {
      const r = this.targetResolve(pkgDir, obj[sub], '', false, false, conditions);
      if (r) return r;
      throw this.notExported(sub, pkgDir, spec);
    }
    let bestKey = '';
    let bestSub = '';
    for (const key of Object.keys(obj)) {
      const star = key.indexOf('*');
      if (star === -1) {
        // legacy trailing-slash folder mappings
        if (key.endsWith('/') && sub.startsWith(key) && key.length > bestKey.length) {
          bestKey = key;
          bestSub = sub.slice(key.length);
        }
        continue;
      }
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (sub.startsWith(prefix) && sub !== prefix && (suffix === '' || (sub.endsWith(suffix) && sub.length >= key.length))) {
        if (patternKeyCompare(bestKey, key) === 1) {
          bestKey = key;
          bestSub = sub.slice(prefix.length, sub.length - suffix.length);
        }
      }
    }
    if (bestKey) {
      const r = this.targetResolve(pkgDir, obj[bestKey], bestSub, bestKey.includes('*'), !bestKey.includes('*'), conditions);
      if (r) return r;
    }
    throw this.notExported(sub, pkgDir, spec);
  }

  private notExported(sub: string, pkgDir: string, spec: string) {
    if (sub === '.') return new ResolveError('ERR_PACKAGE_PATH_NOT_EXPORTED', `No "exports" main defined in ${pkgDir}/package.json (resolving '${spec}')`);
    return new ResolveError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${sub}' is not defined by "exports" in ${pkgDir}/package.json (resolving '${spec}')`);
  }

  private targetResolve(pkgDir: string, target: unknown, subpath: string, pattern: boolean, folder: boolean, conditions: string[], internal = false): string | null {
    if (typeof target === 'string') {
      if (!target.startsWith('./')) {
        if (internal && !target.startsWith('../') && !target.startsWith('/')) {
          // imports may map to bare package specifiers
          return 'bare:' + (pattern ? target.split('*').join(subpath) : target + subpath);
        }
        return null;
      }
      const resolved = pattern ? target.split('*').join(subpath) : target + (folder ? subpath : '');
      return path.join(pkgDir, resolved);
    }
    if (Array.isArray(target)) {
      for (const t of target) {
        try {
          const r = this.targetResolve(pkgDir, t, subpath, pattern, folder, conditions, internal);
          if (r) return r;
        } catch {}
      }
      return null;
    }
    if (target && typeof target === 'object') {
      for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
        if (k === 'default' || conditions.includes(k)) {
          const r = this.targetResolve(pkgDir, v, subpath, pattern, folder, conditions, internal);
          if (r) return r;
          if (r === null && v === null) return null;
        }
      }
      return null;
    }
    return null;
  }

  packageImports(spec: string, fromDir: string, conditions: string[], cjs: boolean, exts: string[]): string {
    const scope = this.findPackageScope(path.join(fromDir, 'x'));
    if (!scope || !scope.pkg.imports || typeof scope.pkg.imports !== 'object') {
      throw new ResolveError(cjs ? 'MODULE_NOT_FOUND' : 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${spec}" is not defined`);
    }
    const obj = scope.pkg.imports as Record<string, unknown>;
    let r: string | null = null;
    if (Object.prototype.hasOwnProperty.call(obj, spec) && !spec.includes('*')) {
      r = this.targetResolve(scope.dir, obj[spec], '', false, false, conditions, true);
    } else {
      let bestKey = '';
      let bestSub = '';
      for (const key of Object.keys(obj)) {
        const star = key.indexOf('*');
        if (star === -1) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (spec.startsWith(prefix) && spec !== prefix && (suffix === '' || spec.endsWith(suffix))) {
          if (patternKeyCompare(bestKey, key) === 1) {
            bestKey = key;
            bestSub = spec.slice(prefix.length, spec.length - suffix.length);
          }
        }
      }
      if (bestKey) r = this.targetResolve(scope.dir, obj[bestKey], bestSub, true, false, conditions, true);
    }
    if (!r) throw new ResolveError(cjs ? 'MODULE_NOT_FOUND' : 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${spec}" is not defined in ${scope.dir}/package.json`);
    if (r.startsWith('bare:')) {
      const bare = r.slice(5);
      return cjs ? this.resolveCjs(bare, scope.dir, { conditions, extensions: exts }) : this.resolveEsm(bare, scope.dir + '/package.json', conditions).path;
    }
    return r;
  }

  // ---------------------------------------------------------------------------
  // ESM

  /** Resolves an ESM specifier from a parent file path. Returns a path or `node:x`. */
  resolveEsm(spec: string, parentFile: string, conditions = ESM_CONDITIONS): { path: string; query: string } {
    const b = builtinName(spec);
    if (b) return { path: 'node:' + b, query: '' };
    if (spec.startsWith('node:')) throw new ResolveError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${spec}`);
    const parentDir = path.dirname(parentFile);
    let query = '';
    const cut = (s: string) => {
      const q = s.startsWith('#') ? s.indexOf('?') : s.search(/[?#]/);
      if (q !== -1) {
        query = s.slice(q);
        return s.slice(0, q);
      }
      return s;
    };
    let file: string;
    if (spec.startsWith('file:')) {
      file = fileURLToPathLoose(cut(spec));
    } else if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      file = path.resolve(parentDir, safeDecode(cut(spec)));
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      if (spec.startsWith('data:')) return { path: spec, query: '' };
      throw new ResolveError('ERR_UNSUPPORTED_ESM_URL_SCHEME', `Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol '${spec.split(':')[0]}:'`);
    } else if (spec.startsWith('#')) {
      file = this.packageImports(cut(spec), parentDir, conditions, false, []);
    } else {
      file = this.packageResolve(cut(spec), parentDir, conditions);
    }
    const kind = this.host.kind(file);
    if (kind === 'dir') {
      // Node rejects directory imports; tolerate a few common legacy cases
      const idx = this.loadIndex(file, ['.js', '.mjs', '.json']);
      if (idx) return { path: this.real(idx), query };
      throw new ResolveError('ERR_UNSUPPORTED_DIR_IMPORT', `Directory import '${file}' is not supported resolving ES modules imported from ${parentFile}`);
    }
    if (kind !== 'file') {
      // Be lenient like many bundlers when the extension was omitted
      const alt = this.loadAsFile(file, ['.js', '.mjs', '.cjs', '.json']);
      if (alt && !spec.startsWith('.') && !spec.startsWith('/')) return { path: this.real(alt), query };
      if (alt) return { path: this.real(alt), query };
      throw new ResolveError('ERR_MODULE_NOT_FOUND', `Cannot find module '${file}' imported from ${parentFile}`);
    }
    return { path: this.real(file), query };
  }

  private packageResolve(spec: string, parentDir: string, conditions: string[]): string {
    const { name, sub } = this.splitSpec(spec);
    if (!name || name.startsWith('.') || name.includes('\\') || name.includes('%')) {
      throw new ResolveError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${spec}"`);
    }
    const self = this.packageSelf(spec, parentDir, conditions, false, []);
    if (self) return self;
    for (const nm of this.nodeModulesPaths(parentDir)) {
      const pkgDir = path.join(nm, name);
      if (this.host.kind(pkgDir) !== 'dir') continue;
      const pkg = this.readPackageJson(path.join(pkgDir, 'package.json'));
      if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
        return this.packageExportsResolve(pkgDir, sub, pkg.exports, conditions, spec);
      }
      if (sub === '.') {
        const main = this.legacyMain(pkgDir, pkg);
        if (main) return main;
        throw new ResolveError('ERR_MODULE_NOT_FOUND', `Cannot find package '${pkgDir}' imported from ${parentDir}`);
      }
      return path.join(pkgDir, sub);
    }
    throw new ResolveError('ERR_MODULE_NOT_FOUND', `Cannot find package '${name}' imported from ${parentDir}/`);
  }

  private legacyMain(pkgDir: string, pkg: PackageJson | null): string | null {
    const exts = ['.js', '.json', '.node'];
    if (pkg && typeof pkg.main === 'string' && pkg.main) {
      const m = path.resolve(pkgDir, pkg.main);
      const f = this.loadAsFile(m, exts) ?? this.loadIndex(m, exts);
      if (f) return f;
    }
    return this.loadIndex(pkgDir, exts);
  }
}

function patternKeyCompare(a: string, b: string): number {
  if (!a) return 1;
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const baseA = aStar === -1 ? a.length : aStar + 1;
  const baseB = bStar === -1 ? b.length : bStar + 1;
  if (baseA > baseB) return -1;
  if (baseB > baseA) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** file:///a/b%20c → /a/b c (tolerates host and missing slashes). */
export function fileURLToPathLoose(u: string): string {
  let s = u.replace(/^file:\/\/[^/]*/, '').replace(/^file:/, '');
  const q = s.search(/[?#]/);
  if (q !== -1) s = s.slice(0, q);
  return safeDecode(s) || '/';
}

export function pathToFileURLString(p: string): string {
  return 'file://' + encodePathForUrl(p);
}

export function encodePathForUrl(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%40/g, '@').replace(/%2B/g, '+').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%3D/g, '=').replace(/%24/g, '$').replace(/%26/g, '&').replace(/%21/g, '!').replace(/%27/g, "'").replace(/%28/g, '(').replace(/%29/g, ')').replace(/%2A/g, '*').replace(/%7E/g, '~'))
    .join('/');
}
