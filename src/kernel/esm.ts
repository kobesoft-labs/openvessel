// Serves files from the VFS as browser ES modules for the process workers.
//
// URL layout (under the runtime's base, intercepted by the service worker):
//   /__ov/esm/<abs path>[?query]   a file as an ES module (ESM rewritten, CJS facade, JSON)
//   /__ov/builtin/<name>           a facade over a builtin module (node:fs etc.)
//   /__ov/esm-error?code&msg&names a module standing in for an import that can't be resolved
//   /__ov/mw/<pid>/<id>.mjs        a source registered by a process

import { init as initLexer, parse as parseEsm } from 'es-module-lexer';
// @ts-ignore - pure JS build, synchronous
import { parse as parseCjs } from 'cjs-module-lexer/lexer.js';
import builtinExports from '../shared/builtin-exports.json';
import * as path from '../shared/path.ts';
import { ESM_CONDITIONS, ResolveError, Resolver, builtinName, encodePathForUrl, pathToFileURLString } from '../shared/resolve.ts';
import { RUNTIME_BASE } from './base.ts';
import type { Kernel } from './kernel.ts';
import { isDir } from './vfs.ts';

export const ESM_PREFIX = '/__ov/esm';
export const BUILTIN_PREFIX = '/__ov/builtin/';
export const ERROR_PREFIX = '/__ov/esm-error';
/** Module sources registered by a process (the ported Node's ModuleWrap): /__ov/mw/<pid>/<id>.mjs */
export const MW_PREFIX = '/__ov/mw/';

const dec = new TextDecoder();
const ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false', 'arguments', 'eval']);

// The URLs written into generated modules are absolute and start with the runtime's base, which may
// be a sub-path (https://example.com/demo/runtime): a root-relative /__ov/… would miss the runtime.
export function esmUrlFor(p: string, query = ''): string {
  return RUNTIME_BASE + ESM_PREFIX + encodePathForUrl(p) + query;
}

export function builtinUrlFor(name: string): string {
  return RUNTIME_BASE + BUILTIN_PREFIX + encodeURIComponent(name);
}

/** A module that declares the imported names and throws the resolution error when it is evaluated. */
export function errorUrlFor(code: string, msg: string, names: string[]): string {
  return `${RUNTIME_BASE}${ERROR_PREFIX}?code=${encodeURIComponent(code)}&msg=${encodeURIComponent(msg)}&names=${encodeURIComponent(names.join(','))}`;
}

export interface ModuleResponse {
  status: number;
  body: string;
  type: string;
}

export function vfsResolveHost(kernel: Kernel) {
  const vfs = kernel.vfs;
  return {
    kind(p: string) {
      const n = vfs.tryLookup(p, true);
      if (!n) return null;
      return isDir(n) ? ('dir' as const) : ('file' as const);
    },
    readText(p: string) {
      try {
        return dec.decode(vfs.readFile(p));
      } catch {
        return null;
      }
    },
    realpath(p: string) {
      return vfs.realpath(p);
    },
    version(p: string) {
      const n = vfs.tryLookup(p, true);
      return n ? `${n.ino}:${n.mtimeMs}:${n.size}` : null;
    },
  };
}

export class EsmService {
  resolver: Resolver;
  private ready: Promise<void>;
  private cache = new Map<string, { v: string; body: string }>();
  /** Sources registered by processes, keyed by "<pid>/<id>". */
  registered = new Map<string, string>();

  register(pid: number, id: string, source: string) {
    this.registered.set(`${pid}/${id}`, source);
  }

  dropProcess(pid: number) {
    const prefix = `${pid}/`;
    for (const k of this.registered.keys()) if (k.startsWith(prefix)) this.registered.delete(k);
  }
  private sucrase?: typeof import('sucrase');

  constructor(public kernel: Kernel) {
    this.resolver = new Resolver(vfsResolveHost(kernel));
    this.ready = initLexer();
  }

  async load(pathname: string, search: string): Promise<ModuleResponse> {
    await this.ready;
    if (pathname === ERROR_PREFIX) {
      const q = new URLSearchParams(search);
      // each name once: `import { a, a as b }` lists a twice, and a duplicate export is a SyntaxError
      const names = [...new Set((q.get('names') ?? '').split(',').filter(Boolean))];
      let body = throwingModule(q.get('code') ?? 'ERR_MODULE_NOT_FOUND', q.get('msg') ?? 'module not found');
      const ids = names.filter((n) => n !== 'default');
      if (ids.length) body += `let ${ids.map((n, i) => `__x${i}`).join(', ')};\nexport { ${ids.map((n, i) => `__x${i} as ${ID.test(n) && !RESERVED.has(n) ? n : JSON.stringify(n)}`).join(', ')} };\n`;
      if (names.includes('default')) body += 'export default undefined;\n';
      return { status: 200, type: 'text/javascript', body };
    }
    if (pathname.startsWith(MW_PREFIX)) {
      const key = pathname.slice(MW_PREFIX.length).replace(/\.mjs$/, '');
      const body = this.registered.get(key);
      if (body === undefined) return { status: 200, type: 'text/javascript', body: throwingModule('ERR_INTERNAL_ASSERTION', `module ${key} is not registered`) };
      return { status: 200, type: 'text/javascript', body };
    }
    if (pathname.startsWith(BUILTIN_PREFIX)) {
      const name = decodeURIComponent(pathname.slice(BUILTIN_PREFIX.length)).replace(/\.mjs$/, '');
      return { status: 200, type: 'text/javascript', body: builtinFacade(name) };
    }
    if (!pathname.startsWith(ESM_PREFIX + '/')) return { status: 404, type: 'text/plain', body: 'not found' };
    let file: string;
    try {
      file = decodeURIComponent(pathname.slice(ESM_PREFIX.length));
    } catch {
      file = pathname.slice(ESM_PREFIX.length);
    }
    try {
      return { status: 200, type: 'text/javascript', body: await this.moduleSource(file, search) };
    } catch (e: any) {
      return { status: 200, type: 'text/javascript', body: throwingModule(e?.code ?? 'ERR_MODULE_NOT_FOUND', e?.message ?? String(e)) };
    }
  }

  private async moduleSource(file: string, search: string): Promise<string> {
    const vfs = this.kernel.vfs;
    const node = vfs.tryLookup(file, true);
    if (!node) throw new ResolveError('ERR_MODULE_NOT_FOUND', `Cannot find module '${file}'`);
    if (isDir(node)) throw new ResolveError('ERR_UNSUPPORTED_DIR_IMPORT', `Directory import '${file}' is not supported`);
    const params = new URLSearchParams(search);
    const forceJson = params.has('ov-json');
    const version = `${node.ino}:${node.mtimeMs}:${node.size}:${forceJson}`;
    const key = file;
    const hit = this.cache.get(key);
    if (hit && hit.v === version) return hit.body;
    const src = dec.decode(vfs.readFile(file));
    let format = forceJson ? 'json' : this.resolver.formatOf(file);
    let body: string;
    switch (format) {
      case 'json':
        body = `export default JSON.parse(${JSON.stringify(src)});\n`;
        break;
      case 'addon':
        throw new ResolveError('ERR_DLOPEN_FAILED', `Native addons are not supported in OpenVessel: ${file}`);
      case 'wasm':
        throw new ResolveError('ERR_UNKNOWN_FILE_EXTENSION', `WebAssembly ES module integration is not supported: ${file}`);
      case 'commonjs':
      case 'commonjs-typescript':
        body = this.cjsFacade(file, src);
        break;
      case 'module-typescript':
        body = await this.rewriteEsm(file, await this.stripTypes(src, file));
        break;
      case 'module':
        body = await this.rewriteEsm(file, src);
        break;
      default: {
        // syntax detection (no "type" field)
        let isEsm = false;
        try {
          const r = parseEsm(src);
          isEsm = !!r[3];
        } catch {
          isEsm = false;
        }
        format = isEsm ? 'module' : 'commonjs';
        body = isEsm ? await this.rewriteEsm(file, src) : this.cjsFacade(file, src);
      }
    }
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(key, { v: version, body });
    return body;
  }

  async stripTypes(src: string, file: string): Promise<string> {
    this.sucrase ??= await import('sucrase');
    return this.sucrase.transform(src, { transforms: ['typescript'], filePath: file, disableESTransforms: true, keepUnusedImports: true }).code;
  }

  /** Rewrites import specifiers, import.meta and dynamic import(). */
  async rewriteEsm(file: string, src: string): Promise<string> {
    const fileUrl = pathToFileURLString(file);
    let imports: any[];
    try {
      [imports] = parseEsm(src, file) as any;
    } catch (e: any) {
      // let the browser report the syntax error
      return src;
    }
    let out = '';
    let last = 0;
    let usesMeta = false;
    let usesDyn = false;
    if (src.startsWith('#!')) {
      out = '//';
      last = 2;
    }
    const edits: { s: number; e: number; text: string }[] = [];
    for (const imp of imports) {
      if (imp.type === 'import-meta') {
        edits.push({ s: imp.start, e: imp.end, text: '__ov_m()' });
        usesMeta = true;
        continue;
      }
      if (imp.type === 'dynamic') {
        // replace the `import` keyword before `(`
        const kw = src.lastIndexOf('import', imp.dynamicStart ?? imp.start);
        if (kw >= 0 && kw >= imp.importStart) {
          edits.push({ s: kw, e: kw + 6, text: '__ov_di' });
          usesDyn = true;
        }
        continue;
      }
      if (imp.specifier == null) continue;
      const spec: string = imp.specifier;
      let url: string;
      const isJsonAttr = Array.isArray(imp.attributes) && imp.attributes.some(([k, v]: [string, string]) => k === 'type' && v === 'json');
      try {
        url = this.resolveToUrl(spec, file, isJsonAttr);
      } catch (e: any) {
        // keep linking intact: point at an error module that declares the imported names and throws when evaluated
        const names = importedNames(src.slice(imp.importStart, imp.start));
        const msg = `${e?.message ?? e}`;
        url = errorUrlFor(e?.code ?? 'ERR_MODULE_NOT_FOUND', msg, names);
      }
      edits.push({ s: imp.start, e: imp.end, text: url.replace(/['"\\\n]/g, (c) => '\\' + c) });
      if (imp.attributesStart != null && imp.attributesStart >= 0) {
        // drop `with { ... }` / `assert { ... }`
        const open = src.indexOf('{', imp.attributesStart);
        const close = src.indexOf('}', open);
        const kwPos = Math.max(src.lastIndexOf('with', imp.attributesStart), src.lastIndexOf('assert', imp.attributesStart));
        if (open !== -1 && close !== -1 && kwPos > imp.end) edits.push({ s: kwPos, e: close + 1, text: '' });
      }
    }
    edits.sort((a, b) => a.s - b.s);
    for (const ed of edits) {
      if (ed.s < last) continue;
      out += src.slice(last, ed.s) + ed.text;
      last = ed.e;
    }
    out += src.slice(last);
    const lit = JSON.stringify(fileUrl);
    let tail = '';
    if (usesMeta) tail += `\nvar __ov_mo;function __ov_m(){return __ov_mo||(__ov_mo=globalThis.__ov.meta(${lit}))}`;
    if (usesDyn) tail += `\nfunction __ov_di(s,o){return globalThis.__ov.dimport(s,o,${lit})}`;
    // keep a trailing sourceMappingURL comment last
    if (tail) {
      const m = /\n\/\/# sourceMappingURL=[^\n]*\s*$/.exec(out);
      if (m) out = out.slice(0, m.index) + tail + m[0];
      else out += tail;
    }
    out += `\n//# sourceURL=${fileUrl}`;
    return out;
  }

  resolveToUrl(spec: string, parentFile: string, json = false): string {
    const b = builtinName(spec);
    if (b) return builtinUrlFor(b);
    const r = this.resolver.resolveEsm(spec, parentFile, ESM_CONDITIONS);
    if (r.path.startsWith('node:')) return builtinUrlFor(r.path.slice(5));
    if (r.path.startsWith('data:')) return r.path;
    let q = r.query;
    if (json && !r.path.endsWith('.json')) q += (q ? '&' : '?') + 'ov-json';
    return esmUrlFor(r.path, q);
  }

  /** ES module facade over a CommonJS module (named exports via cjs-module-lexer). */
  cjsFacade(file: string, src: string): string {
    const names = new Set<string>();
    this.collectCjsExports(file, src, names, new Set(), 0);
    names.delete('default');
    const lit = JSON.stringify(file);
    let body = `const __m = globalThis.__ov.requireForImport(${lit});\nexport default __m;\nexport { __m as "module.exports" };\n`;
    const list = [...names].filter((n) => n !== 'module.exports');
    if (list.length) {
      const binds = list.map((n, i) => `${JSON.stringify(n)}: __e${i}`).join(', ');
      body += `const { ${binds} } = (__m !== null && (typeof __m === 'object' || typeof __m === 'function')) ? __m : {};\n`;
      body += `export { ${list.map((n, i) => `__e${i} as ${ID.test(n) && !RESERVED.has(n) ? n : JSON.stringify(n)}`).join(', ')} };\n`;
    }
    return body;
  }

  private collectCjsExports(file: string, src: string, names: Set<string>, seen: Set<string>, depth: number) {
    if (seen.has(file) || depth > 8) return;
    seen.add(file);
    let res: { exports: string[]; reexports: string[] };
    try {
      res = parseCjs(src);
    } catch {
      return;
    }
    for (const n of res.exports) names.add(n);
    for (const re of res.reexports) {
      if (builtinName(re)) continue;
      try {
        const target = this.resolver.resolveCjs(re, path.dirname(file));
        if (target.startsWith('node:')) continue;
        if (!/\.(c?js|json)$/.test(target) && path.extname(target) !== '') continue;
        const tsrc = dec.decode(this.kernel.vfs.readFile(target));
        this.collectCjsExports(target, tsrc, names, seen, depth + 1);
      } catch {}
    }
  }
}

function builtinFacade(name: string): string {
  const lit = JSON.stringify(name);
  const names = ((builtinExports as Record<string, string[]>)[name] ?? []).filter((n) => !RESERVED.has(n));
  let body = `const m = globalThis.__ov.builtin(${lit});\nexport default m;\n`;
  if (names.length) body += `export const { ${names.join(', ')} } = m;\n`;
  return body;
}

/** Names bound by an import/export-from clause (text between the keyword and the specifier). */
function importedNames(clause: string): string[] {
  const names: string[] = [];
  const c = clause.replace(/^\s*(import|export)\s+/, '').replace(/\s+from\s*['"]?$/, '').replace(/\btype\s+/g, '');
  const brace = /\{([^}]*)\}/.exec(c);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = /^("[^"]+"|'[^']+'|[\w$]+)(?:\s+as\s+.+)?$/.exec(p);
      if (m) names.push(m[1].replace(/^["']|["']$/g, ''));
    }
  }
  const before = brace ? c.slice(0, brace.index) : c;
  const def = /^\s*([\w$]+)\s*(,|$)/.exec(before);
  if (def && def[1] !== 'from' && !c.trimStart().startsWith('*') && !/^\s*export/.test(clause)) names.push('default');
  return names;
}

function throwingModule(code: string, message: string): string {
  return `const e = new Error(${JSON.stringify(message)}); e.code = ${JSON.stringify(code)}; throw e;\nexport {};\n`;
}
