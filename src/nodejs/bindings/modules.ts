// internalBinding('modules') — node_modules.cc: package.json lookup for the CJS and ESM loaders.
// A package.json is returned as [name, main, type, imports, exports, filePath], with imports/exports
// kept as JSON text (the lib parses them lazily).

import { SysError, sys } from '../../node/sys.ts';
import { lib } from '../state.ts';
import { NativeURL } from '../web.ts';
import { Enc, decode } from './buffer.ts';
import { fromShape } from './shape.ts';

type Tuple = [string | undefined, string | undefined, string, string | undefined, string | undefined, string | undefined];

const cache = new Map<string, Tuple | null>();

function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function read(path: string, isESM?: boolean, base?: string, specifier?: string): Tuple | undefined {
  const hit = cache.get(path);
  if (hit !== undefined) return hit ?? undefined;
  let text: string;
  try {
    text = decode(sys<Uint8Array>('readFile', { p: path }), Enc.UTF8);
  } catch (e) {
    if (e instanceof SysError) {
      cache.set(path, null);
      return undefined;
    }
    throw e;
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e: any) {
    const { codes } = lib('internal/errors');
    let msg = `Invalid package config ${path}`;
    if (isESM && specifier) msg += ` while importing "${specifier}" from ${base}`;
    throw new codes.ERR_INVALID_PACKAGE_CONFIG(path, isESM && base ? base : undefined, e?.message);
    void msg;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const raw = (v: unknown) => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : JSON.stringify(v));
  // the file's own keys only (not what Object.prototype may have gained)
  const field = (k: string) => (json !== null && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, k) ? json[k] : undefined);
  const type = field('type');
  const t: Tuple = [
    str(field('name')),
    str(field('main')),
    type === 'module' || type === 'commonjs' ? type : 'none',
    raw(field('imports')),
    raw(field('exports')),
    path,
  ];
  cache.set(path, t);
  return t;
}

/** Nearest package.json above checkPath, not crossing a node_modules boundary. */
function nearest(checkPath: string): Tuple | undefined {
  let dir = dirname(checkPath);
  for (;;) {
    if (dir.endsWith('/node_modules')) return undefined;
    const t = read(dir === '/' ? '/package.json' : `${dir}/package.json`);
    if (t) return t;
    if (dir === '/') return undefined;
    dir = dirname(dir);
  }
}

function scope(resolved: string): Tuple | string {
  let url = new NativeURL('./package.json', resolved);
  for (;;) {
    const p = decodeURIComponent(url.pathname);
    if (p.endsWith('/node_modules/package.json')) break;
    const t = read(p);
    if (t) return t;
    const parent = new NativeURL('../package.json', url);
    if (parent.pathname === url.pathname) break;
    url = parent;
  }
  return decodeURIComponent(url.pathname);
}

export function createModules() {
  const b = fromShape('modules');
  return Object.assign(b, {
    readPackageJSON: (path: string, isESM?: boolean, base?: string, specifier?: string) => read(path, isESM, base, specifier),
    getNearestParentPackageJSON: (checkPath: string) => nearest(checkPath),
    getNearestParentPackageJSONType: (checkPath: string) => nearest(checkPath)?.[2] ?? 'none',
    getPackageScopeConfig: (resolved: string) => scope(resolved),
    getPackageType(url: string) {
      const r = scope(url);
      return Array.isArray(r) ? r[2] : undefined;
    },
    enableCompileCache: () => [3 /* DISABLED */, 'the compile cache is not available in OpenVessel', undefined],
    getCompileCacheDir: () => undefined,
    flushCompileCache: () => {},
    setLazyPathHelpers: () => {},
  });
}

/** Drops cached package.json data (the VFS changed under it). */
export function clearPackageJsonCache() {
  cache.clear();
}
