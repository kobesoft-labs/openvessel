// node:module — CommonJS loader and the glue used by transformed ES modules.

import { init as initLexer, parse as parseEsm } from 'es-module-lexer';
import * as path from '../shared/path.ts';
import { BUILTIN_MODULES, builtinName, encodePathForUrl, fileURLToPathLoose, pathToFileURLString } from '../shared/resolve.ts';
import { track } from './loop.ts';
import { SysError, sys } from './sys.ts';

const dec = new TextDecoder();
export const ESM_PREFIX = '/__ov/esm';
export const BUILTIN_PREFIX = '/__ov/builtin/';
let lexerReady = false;
export const lexerInit = initLexer().then(() => {
  lexerReady = true;
});

type BuiltinGetter = (name: string) => any;
let getBuiltin: BuiltinGetter = () => {
  throw new Error('builtins not ready');
};
export function setBuiltinGetter(fn: BuiltinGetter) {
  getBuiltin = fn;
}

export let conditions: string[] = [];
export function setConditions(c: string[]) {
  conditions = c;
}

let runtimeOrigin = '';
export function setRuntimeOrigin(o: string) {
  runtimeOrigin = o;
}

function moduleNotFound(request: string, parent: Module | null, cause?: SysError): Error {
  const stack: string[] = [];
  for (let m = parent; m; m = m.parent ?? null) {
    if (m.filename) stack.push(m.filename);
    if (stack.length > 20) break;
  }
  let msg = cause?.message && !cause.message.startsWith('Cannot find module') ? cause.message : `Cannot find module '${request}'`;
  if (stack.length) msg += `\nRequire stack:\n- ${stack.join('\n- ')}`;
  const err = new Error(msg) as Error & { code: string; requireStack: string[] };
  err.code = cause?.code && cause.code !== 'ENOENT' ? cause.code : 'MODULE_NOT_FOUND';
  err.requireStack = stack;
  return err;
}

export function Module(this: any, id = '', parent?: any) {
  this.id = id;
  this.path = path.dirname(id);
  this.exports = {};
  this.filename = null;
  this.loaded = false;
  this.children = [];
  this.paths = [];
  this.parent = parent;
  if (parent && parent.children) parent.children.push(this);
}
interface Module {
  id: string;
  path: string;
  exports: any;
  filename: string | null;
  loaded: boolean;
  children: Module[];
  paths: string[];
  parent?: Module | null;
  require: (id: string) => any;
  load(filename: string): void;
  _compile(content: string, filename: string): any;
  [k: string]: any;
}

const M = Module as any;
M._cache = Object.create(null);
M._pathCache = Object.create(null);
M._extensions = Object.create(null);
M.globalPaths = ['/home/user/.node_modules', '/home/user/.node_libraries', '/usr/lib/node'];
M.builtinModules = BUILTIN_MODULES.filter((m) => !m.startsWith('_')).concat(BUILTIN_MODULES.filter((m) => m.startsWith('_')));
M.Module = Module;
M.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
M.wrap = (s: string) => M.wrapper[0] + s + M.wrapper[1];
M.isBuiltin = (s: string) => builtinName(s) !== null;
M._initPaths = () => {};
M._preloadModules = () => {};
M.syncBuiltinESMExports = () => {};
M.register = () => {};
M.registerHooks = () => ({ deregister() {} });
M.enableCompileCache = () => ({ status: 3 });
M.getCompileCacheDir = () => undefined;
M.flushCompileCache = () => {};
M.findSourceMap = () => undefined;
M.SourceMap = class SourceMap {
  constructor(public payload: unknown) {}
  findEntry() {
    return {};
  }
};
M.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } };
M.runMain = () => {};
M.stripTypeScriptTypes = (code: string) => stripTypesSync(code, 'x.ts');

M._nodeModulePaths = (from: string) => {
  const out: string[] = [];
  let dir = path.resolve(from);
  for (;;) {
    if (path.basename(dir) !== 'node_modules') out.push(path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
};

M._resolveLookupPaths = (request: string, parent: Module | null) => {
  if (builtinName(request)) return null;
  if (request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..') return [parent?.filename ? path.dirname(parent.filename) : process_cwd()];
  return [...(parent?.paths ?? M._nodeModulePaths(process_cwd())), ...M.globalPaths];
};

function process_cwd(): string {
  return (globalThis as any).process?.cwd?.() ?? '/';
}

M._findPath = (request: string, paths: string[]) => {
  for (const p of paths) {
    try {
      return sys<string>('resolve', { spec: path.isAbsolute(request) ? request : path.join(p, request), from: p, kind: 'cjs', exts: Object.keys(M._extensions) });
    } catch {}
  }
  return false;
};

M._resolveFilename = function (request: string, parent: Module | null, _isMain?: boolean, options?: { paths?: string[] }): string {
  if (typeof request !== 'string') {
    const e = new TypeError(`The "id" argument must be of type string. Received ${typeof request}`) as TypeError & { code: string };
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  const b = builtinName(request);
  if (b && (request.startsWith('node:') || !request.includes('/') || BUILTIN_MODULES.includes(request))) return request.startsWith('node:') ? request : b;
  const from = parent?.filename ? path.dirname(parent.filename) : parent?.id && parent.id !== '.' && parent.id !== '<repl>' ? parent.path : process_cwd();
  const exts = Object.keys(M._extensions);
  let paths: string[] | undefined;
  if (options?.paths) {
    paths = [];
    for (const p of options.paths) paths.push(...M._nodeModulePaths(path.resolve(from, p)));
    if (request.startsWith('.')) {
      for (const p of options.paths) {
        try {
          return sys<string>('resolve', { spec: request, from: path.resolve(from, p), kind: 'cjs', exts, conditions });
        } catch {}
      }
    }
  }
  const cacheKey = `${from}\0${request}`;
  if (!paths) {
    const hit = M._pathCache[cacheKey];
    if (hit) return hit;
  }
  try {
    const r = sys<string>('resolve', { spec: request, from, kind: 'cjs', exts, conditions, paths });
    const out = r.startsWith('node:') ? r.slice(5) : r;
    if (!paths) M._pathCache[cacheKey] = out;
    return out;
  } catch (e) {
    if (e instanceof SysError) throw moduleNotFound(request, parent, e);
    throw e;
  }
};

M._load = function (request: string, parent: Module | null, isMain: boolean) {
  const b = builtinName(request);
  if (b && (request.startsWith('node:') || !M._cache[request])) {
    if (request.startsWith('node:') || BUILTIN_MODULES.includes(request)) return getBuiltin(b);
  }
  const filename = M._resolveFilename(request, parent, isMain);
  const bb = builtinName(filename);
  if (bb && !filename.startsWith('/')) return getBuiltin(bb);
  return loadFile(filename, parent, isMain);
};

export function loadFile(filename: string, parent: Module | null, isMain = false): any {
  const cached = M._cache[filename];
  if (cached) {
    if (parent && !parent.children.includes(cached)) parent.children.push(cached);
    return cached.exports;
  }
  const module: Module = new M(filename, parent);
  if (isMain) {
    module.id = '.';
    (globalThis as any).process.mainModule = module;
    M._mainModule = module;
  }
  M._cache[filename] = module;
  let threw = true;
  try {
    module.load(filename);
    threw = false;
  } finally {
    if (threw) {
      delete M._cache[filename];
      if (parent) {
        const i = parent.children.indexOf(module);
        if (i !== -1) parent.children.splice(i, 1);
      }
    }
  }
  return module.exports;
}

M.prototype.load = function (this: Module, filename: string) {
  this.filename = filename;
  this.paths = M._nodeModulePaths(path.dirname(filename));
  const ext = findExtension(filename);
  M._extensions[ext](this, filename);
  this.loaded = true;
};

function findExtension(filename: string): string {
  const name = path.basename(filename);
  let idx = 0;
  for (;;) {
    idx = name.indexOf('.', idx + 1);
    if (idx === -1) break;
    const ext = name.slice(idx);
    if (M._extensions[ext]) return ext;
  }
  return '.js';
}

M.prototype.require = function (this: Module, id: string) {
  if (typeof id !== 'string') {
    const e = new TypeError(`The "id" argument must be of type string. Received ${typeof id}`) as TypeError & { code: string };
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  if (id === '') {
    const e = new TypeError("The argument 'id' must be a non-empty string. Received ''") as TypeError & { code: string };
    e.code = 'ERR_INVALID_ARG_VALUE';
    throw e;
  }
  return M._load(id, this, false);
};

function makeRequire(mod: Module) {
  const require: any = function require(id: string) {
    return mod.require(id);
  };
  require.resolve = function resolve(request: string, opts?: { paths?: string[] }) {
    const r = M._resolveFilename(request, mod, false, opts);
    return r;
  };
  require.resolve.paths = (request: string) => M._resolveLookupPaths(request, mod);
  require.main = M._mainModule;
  require.extensions = M._extensions;
  require.cache = M._cache;
  return require;
}

/** Compiles a CommonJS module body. */
M.prototype._compile = function (this: Module, content: string, filename: string) {
  let src = content;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (src.startsWith('#!')) src = '//' + src.slice(2);
  src = rewriteDynamicImports(src, filename);
  const wrapped = `(function (exports, require, module, __filename, __dirname, __ov_di) {${src}\n})\n//# sourceURL=${filename}`;
  let fn: Function;
  try {
    fn = (0, eval)(wrapped);
  } catch (e) {
    if (e instanceof SyntaxError && looksLikeEsm(content)) {
      // ESM syntax in a CommonJS context: Node's syntax detection would load it as ESM
      return requireEsm(this, content, filename);
    }
    if (e instanceof SyntaxError) e.message = `${e.message} (in ${filename})`;
    throw e;
  }
  const require = makeRequire(this);
  const fileUrl = pathToFileURLString(filename);
  const di = (spec: string, opts?: unknown) => dimport(spec, opts, fileUrl);
  return fn.call(this.exports, this.exports, require, this, filename, path.dirname(filename), di);
};

function looksLikeEsm(src: string) {
  if (!lexerReady) return /^\s*(import|export)\s/m.test(src);
  try {
    return !!(parseEsm(src) as any)[3];
  } catch {
    return false;
  }
}

/** Replaces dynamic `import(` with `__ov_di(` so specifiers resolve against the VFS. */
function rewriteDynamicImports(src: string, _filename: string): string {
  if (!src.includes('import(') && !src.includes('import (')) return src;
  if (!lexerReady) return src.replace(/(^|[^.\w$])import\s*\(/g, '$1__ov_di(');
  let imports: any[];
  try {
    [imports] = parseEsm(src) as any;
  } catch {
    return src.replace(/(^|[^.\w$])import\s*\(/g, '$1__ov_di(');
  }
  let out = '';
  let last = 0;
  for (const imp of imports) {
    if (imp.type !== 'dynamic') continue;
    const kw = src.lastIndexOf('import', imp.dynamicStart ?? imp.start);
    if (kw < last || kw < imp.importStart) continue;
    out += src.slice(last, kw) + '__ov_di';
    last = kw + 6;
  }
  return out + src.slice(last);
}

const readText = (filename: string) => dec.decode(sys<Uint8Array>('readFile', { p: filename }));

M._extensions['.js'] = function (module: Module, filename: string) {
  const content = readText(filename);
  const fmt = sys<string | null>('moduleFormat', { p: filename });
  if (fmt === 'module' || filename.endsWith('.mjs')) {
    requireEsm(module, content, filename);
    return;
  }
  module._compile(content, filename);
};
M._extensions['.json'] = function (module: Module, filename: string) {
  const content = readText(filename);
  try {
    module.exports = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch (e) {
    (e as Error).message = `${filename}: ${(e as Error).message}`;
    throw e;
  }
};
M._extensions['.node'] = function (_module: Module, filename: string) {
  const e = new Error(`Native addons are not supported in OpenVessel (tried to load ${filename}). Use the WebAssembly build of this package.`) as Error & { code: string };
  e.code = 'ERR_DLOPEN_FAILED';
  throw e;
};
const tsLoader = function (module: Module, filename: string) {
  const content = readText(filename);
  const fmt = sys<string | null>('moduleFormat', { p: filename });
  const js = stripTypesSync(content, filename);
  if (fmt === 'module-typescript' && looksLikeEsm(js)) {
    requireEsm(module, js, filename);
    return;
  }
  module._compile(js, filename);
};
M._extensions['.ts'] = tsLoader;
M._extensions['.cts'] = tsLoader;
M._extensions['.mts'] = tsLoader;

// --- TypeScript stripping and ESM → CJS (for require(esm)) via sucrase, loaded on demand
let sucrase: any = null;
export async function preloadSucrase() {
  sucrase ??= await import('sucrase');
}
function needSucrase() {
  if (!sucrase) {
    const e = new Error('internal: transformer not loaded') as Error & { code: string };
    e.code = 'ERR_INTERNAL';
    throw e;
  }
  return sucrase;
}
function stripTypesSync(code: string, filename: string): string {
  return needSucrase().transform(code, { transforms: ['typescript'], filePath: filename, disableESTransforms: true, keepUnusedImports: true }).code;
}

/** require() of an ES module: transform to CommonJS (Node 22 `require(esm)`). */
function requireEsm(module: Module, content: string, filename: string) {
  if (/(^|[^\w$.])await\s/.test(content) && hasTopLevelAwait(content)) {
    const e = new Error(`require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\n  From ${filename}`) as Error & { code: string };
    e.code = 'ERR_REQUIRE_ASYNC_MODULE';
    throw e;
  }
  const s = needSucrase();
  let js: string;
  try {
    js = s.transform(content, { transforms: ['imports'], filePath: filename, disableESTransforms: true, preserveDynamicImport: true, injectCreateRequireForImportRequire: false }).code;
  } catch (e) {
    throw e;
  }
  js = js.replace(/\bimport\.meta\b/g, '__ov_import_meta');
  const prelude = `var __ov_import_meta = globalThis.__ov.meta(${JSON.stringify(pathToFileURLString(filename))});`;
  module._compile(prelude + js, filename);
  const ex = module.exports;
  if (ex && typeof ex === 'object' && Object.prototype.hasOwnProperty.call(ex, 'module.exports')) module.exports = ex['module.exports'];
  else if (ex && typeof ex === 'object' && !Object.prototype.hasOwnProperty.call(ex, '__esModule')) Object.defineProperty(ex, '__esModule', { value: true });
}

function hasTopLevelAwait(src: string): boolean {
  // cheap check: an `await` at brace depth 0
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    else if (depth === 0 && c === 'a' && src.startsWith('await', i) && !/[\w$]/.test(src[i - 1] ?? ' ') && !/[\w$]/.test(src[i + 5] ?? ' ')) return true;
    i++;
  }
  return false;
}

M.createRequire = function createRequire(filename: string | URL) {
  let f = typeof filename === 'string' ? filename : filename.href;
  if (f.startsWith('file:')) f = fileURLToPathLoose(f);
  const mod: Module = new M(f, null);
  mod.filename = f;
  mod.paths = M._nodeModulePaths(path.dirname(f));
  if (f.endsWith('/')) {
    mod.filename = path.join(f, 'noop.js');
  }
  return makeRequire(mod);
};

M.findPackageJSON = function (spec: string, base?: string) {
  let start = spec;
  if (spec.startsWith('file:')) start = fileURLToPathLoose(spec);
  else if (!spec.startsWith('/') && base) start = M._resolveFilename(spec, { filename: base.startsWith('file:') ? fileURLToPathLoose(base) : base, paths: [] } as any);
  let dir = path.dirname(start);
  for (;;) {
    const pj = path.join(dir, 'package.json');
    try {
      sys('stat', { p: pj });
      return pj;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

// -----------------------------------------------------------------------------
// ESM glue (globalThis.__ov)

export function esmUrl(p: string, query = ''): string {
  return runtimeOrigin + ESM_PREFIX + encodePathForUrl(p) + query;
}

export function builtinUrl(name: string): string {
  return runtimeOrigin + BUILTIN_PREFIX + encodeURIComponent(name);
}

export function resolveEsmUrl(spec: string, parentUrl: string): string {
  const b = builtinName(spec);
  if (b) return builtinUrl(b);
  if (spec.startsWith('data:') || spec.startsWith('blob:')) return spec;
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    const e = new Error(`Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol '${new URL(spec).protocol}'`) as Error & { code: string };
    e.code = 'ERR_UNSUPPORTED_ESM_URL_SCHEME';
    throw e;
  }
  const parent = parentUrl.startsWith('file:') ? fileURLToPathLoose(parentUrl) : parentUrl.startsWith('/') ? parentUrl : process_cwd() + '/';
  let r: { path: string; query: string };
  try {
    r = sys('resolve', { spec, from: parent, kind: 'esm', conditions });
  } catch (e) {
    if (e instanceof SysError) {
      const err = new Error(e.message) as Error & { code: string };
      err.code = e.code === 'ENOENT' || e.code === 'MODULE_NOT_FOUND' ? 'ERR_MODULE_NOT_FOUND' : e.code;
      throw err;
    }
    throw e;
  }
  if (r.path.startsWith('node:')) return builtinUrl(r.path.slice(5));
  return esmUrl(r.path, r.query);
}

/** import() from transformed code. */
export function dimport(spec: unknown, _opts: unknown, parentUrl: string): Promise<any> {
  let s: string;
  if (spec instanceof URL) s = spec.href;
  else s = String(spec);
  let url: string;
  try {
    url = resolveEsmUrl(s, parentUrl);
  } catch (e) {
    return Promise.reject(e);
  }
  return track(import(/* @vite-ignore */ url));
}

export function metaFor(fileUrl: string) {
  const filename = fileURLToPathLoose(fileUrl);
  return {
    url: fileUrl,
    filename,
    dirname: path.dirname(filename),
    main: false,
    resolve(spec: string, parent?: string | URL) {
      const p = parent ? String(parent) : fileUrl;
      const b = builtinName(spec);
      if (b) return 'node:' + b;
      const r = sys<{ path: string; query: string }>('resolve', { spec, from: p.startsWith('file:') ? fileURLToPathLoose(p) : p, kind: 'esm', conditions });
      if (r.path.startsWith('node:')) return r.path;
      return pathToFileURLString(r.path) + r.query;
    },
  };
}

/** Maps runtime URLs in stack traces back to file paths. */
export function installStackMapping() {
  const E = Error as any;
  if (typeof E.captureStackTrace !== 'function') return;
  const esmBase = runtimeOrigin + ESM_PREFIX;
  const mapName = (name: string | null | undefined) => {
    if (!name) return name;
    if (name.startsWith(esmBase)) {
      const q = name.search(/[?#]/);
      const p = q === -1 ? name.slice(esmBase.length) : name.slice(esmBase.length, q);
      return 'file://' + p;
    }
    if (name.startsWith(runtimeOrigin + '/')) return 'node:internal/' + name.slice(runtimeOrigin.length + 1).replace(/\?.*$/, '');
    return name;
  };
  E.prepareStackTrace = (err: Error, frames: any[]) => {
    const head = errorHeader(err);
    if (!frames.length) return head;
    const lines = frames.map((f) => {
      try {
        return '    at ' + formatFrame(f, mapName);
      } catch {
        return '    at <unknown>';
      }
    });
    return head + '\n' + lines.join('\n');
  };
}

function errorHeader(err: Error) {
  let name = 'Error';
  let message = '';
  try {
    name = err?.name ?? 'Error';
    message = err?.message ?? '';
  } catch {}
  return message ? `${name}: ${message}` : String(name);
}

function formatFrame(f: any, mapName: (n: string) => string | null | undefined): string {
  const file = mapName(f.getScriptNameOrSourceURL?.() ?? f.getFileName?.()) ?? '<anonymous>';
  const line = f.getLineNumber?.();
  const col = f.getColumnNumber?.();
  const loc = f.isNative?.() ? 'native' : `${file}${line != null ? `:${line}` : ''}${col != null ? `:${col}` : ''}`;
  const fn = f.getFunctionName?.();
  const isTop = f.isToplevel?.();
  const isCtor = f.isConstructor?.();
  const isAsync = f.isAsync?.();
  const isPromiseAll = f.isPromiseAll?.();
  let typeName: string | null = null;
  try {
    typeName = isTop ? null : f.getTypeName?.();
  } catch {}
  const method = f.getMethodName?.();
  let name: string;
  if (isPromiseAll) return `async Promise.all (index ${f.getPromiseIndex?.()})`;
  if (isCtor) name = `new ${fn ?? '<anonymous>'}`;
  else if (isTop || !typeName) name = fn ?? '';
  else {
    name = fn ? (fn.startsWith(typeName + '.') ? fn : `${typeName}.${fn}`) : `${typeName}.${method ?? '<anonymous>'}`;
    if (method && fn && !fn.endsWith(method)) name += ` [as ${method}]`;
  }
  const prefix = isAsync ? 'async ' : '';
  return name ? `${prefix}${name} (${loc})` : `${prefix}${loc}`;
}

export { M as ModuleCtor };
export default M;
