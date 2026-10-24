// internalBinding('module_wrap') — V8's module records, carried out by the browser.
//
// A source-text ModuleWrap keeps the module's code; on instantiate its static import specifiers
// are rewritten to the URLs of the ModuleWraps they were linked to, and the result is registered
// with the kernel, which the runtime's Service Worker serves at /__ov/mw/<pid>/<id>.mjs. Evaluating
// the root is a native import() of its URL, so linking, cycles, live bindings and top-level await
// are the browser's. Synthetic modules (builtins, CommonJS, JSON) are generated modules whose
// exports are `var`s assigned through setExport().

import { parse as parseEsm } from 'es-module-lexer/js';
import { sys } from '../../node/sys.ts';
import * as loop from '../loop.ts';
import { S, lib } from '../state.ts';
import { fromShape } from './shape.ts';
import { sucrase } from '../typescript.ts';
import { cachedDataMatches, contextScope, makeCachedData, setPrivate } from './contextify.ts';
import { fulfilledPromise, rejectedPromise } from './util.ts';

const kUninstantiated = 0;
const kInstantiating = 1;
const kInstantiated = 2;
const kEvaluating = 3;
const kEvaluated = 4;
const kErrored = 5;

interface Request {
  specifier: string;
  attributes: Record<string, string>;
  /** source ranges of every occurrence of this request's specifier text */
  ranges: { start: number; end: number; attrStart: number; attrEnd: number }[];
  /** `export * from` this request */
  star: boolean;
  /** names the module imports or re-exports from this request by name ('default' for a default import) */
  names: Set<string>;
}

function bindingNames(p: any, out: Set<string>) {
  if (!p) return;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) bindingNames(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements) bindingNames(q, out);
  else if (p.type === 'RestElement') bindingNames(p.argument, out);
  else if (p.type === 'AssignmentPattern') bindingNames(p.left, out);
}

function linkFailure(message: string) {
  const e = new Error(message) as Error & { code: string };
  e.code = 'ERR_VM_MODULE_LINK_FAILURE';
  return e;
}

/** The names a static import/re-export statement takes from its module (statement text up to the specifier). */
function importedNames(head: string, out: Set<string>) {
  const isExport = /^export\b/.test(head);
  if (!isExport) {
    const d = /^import\s+([\w$]+)\s*(?:,|from\b)/.exec(head);
    if (d && d[1] !== 'from') out.add('default');
  }
  const braces = /\{([^}]*)\}/.exec(head);
  if (!braces) return;
  for (const part of braces[1].split(',')) {
    const name = part.trim().split(/\s+as\s+/)[0]?.trim();
    if (!name) continue;
    out.add(/^['"]/.test(name) ? name.slice(1, -1) : name.replace(/^type\s+/, ''));
  }
}

let nextId = 1;
const byId = new Map<string, ModuleWrap>();
let importMetaCallback: ((symbol: unknown, meta: object, wrap: ModuleWrap) => void) | null = null;
let dynamicImportCallback: ((symbol: unknown, specifier: string, attributes: Record<string, string>, referrerName: string) => Promise<unknown>) | null = null;

function moduleUrl(id: string) {
  return `${S.runtimeBase}/__ov/mw/${S.init.pid}/${id}.mjs`;
}

/** The `with { … }` / `assert { … }` clause that starts before attrStart, as [start, end). */
function attributeClause(src: string, attrStart: number): [number, number] {
  let end = src.indexOf('}', attrStart);
  if (end < 0) return [attrStart, attrStart];
  end++;
  const before = src.slice(Math.max(0, attrStart - 16), attrStart);
  const m = /(with|assert)\s*$/.exec(before);
  const start = m ? attrStart - before.length + m.index : attrStart;
  return [start, end];
}

function attributesOf(list: [string, string][] | null): Record<string, string> {
  const o: Record<string, string> = { __proto__: null } as any;
  for (const [k, v] of list ?? []) o[k] = v;
  return o;
}

const ID_RE = /^[A-Za-z_$][\w$]*$/;

export class ModuleWrap {
  url: string;
  sourceMapURL?: string;
  sourceURL?: string;
  readonly id: string;
  #source: string | null = null;
  #exportNames: string[] | null = null;
  #evaluationSteps: (() => void) | null = null;
  #hostDefinedOption: unknown;
  #requests: Request[] = [];
  #dynamicRanges: { kwStart: number; kwEnd: number }[] = [];
  #metaRanges: { start: number; end: number }[] = [];
  #linked: (ModuleWrap | undefined)[] = [];
  #status = kUninstantiated;
  #error: unknown = undefined;
  #namespace: object | null = null;
  #registered = false;
  #evaluation: Promise<unknown> | null = null;
  #setters: ((i: number, v: unknown) => void) | null = null;
  /** synthetic export values, by index (also feeds the namespace made by evaluateSync) */
  #values: unknown[] = [];
  /** set while/after the module was evaluated synchronously (require(esm)) */
  #syncExports: Record<string, unknown> | null = null;
  #tla: boolean | undefined;
  #meta: object | null = null;
  /** created by vm.SourceTextModule (no id symbol of the default loader) */
  #isVm = false;
  #context: unknown;
  #linkCalled = false;
  #localExports: string[] = [];
  /** the namespace handed to lib before (or instead of) the browser's */
  #facade: object | null = null;
  #realNs: object | null = null;
  /** `export * from` statements, up to the specifier's quote */
  #starRanges: { s: number; e: number }[] = [];
  /** an async (top-level await) evaluation has settled */
  #asyncSettled = false;

  constructor(url: string, context: unknown, sourceOrNames: string | string[], lineOffsetOrSteps?: number | (() => void), _columnOffset?: number, hostDefinedOption?: unknown) {
    this.#context = context;
    this.url = url;
    this.id = String(nextId++);
    byId.set(this.id, this);
    // like V8's ModuleWrap::New: the 6th argument is the id symbol when it is one (otherwise
    // cachedData), and every wrap gets an id symbol — vm.Module registers its callbacks under it
    this.#hostDefinedOption = typeof hostDefinedOption === 'symbol' ? hostDefinedOption : Symbol(url);
    setPrivate(this, S.privateSymbols.host_defined_option_symbol, this.#hostDefinedOption);
    if (typeof sourceOrNames === 'string') {
      this.#isVm = typeof hostDefinedOption !== 'symbol';
      if (ArrayBuffer.isView(hostDefinedOption) && !cachedDataMatches(hostDefinedOption, sourceOrNames)) {
        const e = new Error('cachedData buffer was rejected') as Error & { code: string };
        e.code = 'ERR_VM_MODULE_CACHED_DATA_REJECTED';
        throw e;
      }
      this.#source = sourceOrNames;
      this.#analyze(sourceOrNames);
    } else {
      this.#exportNames = [...sourceOrNames];
      this.#evaluationSteps = lineOffsetOrSteps as () => void;
    }
  }

  #analyze(src: string) {
    let imports: any[];
    let exports: any[];
    try {
      [imports, exports] = parseEsm(src, this.url) as any;
    } catch (e: any) {
      // let V8 report the syntax error the way Node would: as a SyntaxError on construction
      const err = new SyntaxError(e?.message ?? 'Invalid or unexpected token');
      throw err;
    }
    this.#localExports = exports.filter((e: any) => e.type !== 'reexport-all' && typeof e.name === 'string').map((e: any) => e.name);
    const index = new Map<string, Request>();
    for (const imp of imports) {
      // es-module-lexer reports import.meta either as its own type or as a "dynamic" import at -2
      if (imp.type === 'import-meta') {
        this.#metaRanges.push({ start: imp.start, end: imp.end });
        continue;
      }
      if (imp.type === 'dynamic') {
        if (imp.dynamicStart === -2) this.#metaRanges.push({ start: imp.start, end: imp.end });
        else if (imp.dynamicStart >= 0) this.#dynamicRanges.push({ kwStart: imp.importStart, kwEnd: imp.importStart + 6 });
        continue;
      }
      if (imp.specifier == null) continue;
      const attributes = attributesOf(imp.attributes);
      const key = imp.specifier + '\0' + JSON.stringify(attributes);
      let r = index.get(key);
      if (!r) {
        r = { specifier: imp.specifier, attributes: Object.freeze(attributes), ranges: [], star: false, names: new Set() };
        index.set(key, r);
        this.#requests.push(r);
      }
      const [as, ae] = imp.attributesStart >= 0 ? attributeClause(src, imp.attributesStart) : [-1, -1];
      r.ranges.push({ start: imp.start, end: imp.end, attrStart: as, attrEnd: ae });
      if (imp.type === 'reexport-star') {
        r.star = true;
        this.#starRanges.push({ s: imp.importStart, e: imp.start - 1 });
      }
      else if (imp.importStart >= 0 && imp.start > imp.importStart) {
        importedNames(src.slice(imp.importStart, imp.start), r.names);
      }
    }
    const sm = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(src.slice(-512));
    if (sm) this.sourceMapURL = sm[1];
    const su = /\/\/[#@] sourceURL=(\S+)\s*$/m.exec(src.slice(-1024));
    if (su) this.sourceURL = su[1];
  }

  getModuleRequests() {
    return this.#requests.map((r) => ({ specifier: r.specifier, attributes: r.attributes }));
  }

  /** link(modules) since Node 22.23; link(specifiers, modules) before. Aligned with getModuleRequests(). */
  link(...args: [ModuleWrap[]] | [string[], ModuleWrap[]]) {
    this.#linkCalled = true;
    if (this.#exportNames) return;
    const modules = (args.length === 1 ? args[0] : args[1]) as ModuleWrap[];
    const specifiers = args.length === 1 ? null : (args[0] as string[]);
    for (let i = 0; i < this.#requests.length; i++) {
      if (specifiers && specifiers[i] !== this.#requests[i].specifier) {
        const e = new Error(`linking mismatch for ${this.url}: ${specifiers[i]} != ${this.#requests[i].specifier}`) as Error & { code: string };
        e.code = 'ERR_VM_MODULE_LINK_FAILURE';
        throw e;
      }
      this.#linked[i] = modules[i];
    }
  }

  /** The source served to the browser. */
  #rewritten(): string {
    const src = this.#source!;
    const edits: { s: number; e: number; text: string }[] = [];
    this.#requests.forEach((r, i) => {
      const target = this.#linked[i];
      if (!target) throw new Error(`module ${this.url} is not linked (${r.specifier})`);
      for (const range of r.ranges) {
        edits.push({ s: range.start, e: range.end, text: target.servedUrl() });
        // the target is always served as JavaScript, so import attributes would make the browser reject it
        if (range.attrStart >= 0) edits.push({ s: range.attrStart, e: range.attrEnd, text: '' });
      }
    });
    // through globalThis rather than module-local helpers: code that stringifies a function and
    // evaluates it elsewhere (vite's CSS preprocessor workers via artichokie) keeps working
    const lit = JSON.stringify(this.id);
    for (const m of this.#metaRanges) edits.push({ s: m.start, e: m.end, text: `globalThis.__ovImportMeta(${lit})` });
    for (const d of this.#dynamicRanges) edits.push({ s: d.kwStart, e: d.kwEnd, text: `globalThis.__ovDynamicImport.bind(null,${lit})` });
    edits.sort((a, b) => a.s - b.s);
    let out = '';
    let last = 0;
    for (const ed of edits) {
      if (ed.s < last) continue;
      out += src.slice(last, ed.s) + ed.text;
      last = ed.e;
    }
    out += src.slice(last);
    // keep source maps pointing at the original file
    return out + `\n//# sourceURL=${this.url}`;
  }

  #syntheticSource(): string {
    const names = this.#exportNames!;
    const vars = names.map((_, i) => `$ov${i}`);
    const exportList = names.map((n, i) => `${vars[i]} as ${n === 'default' || ID_RE.test(n) ? n : JSON.stringify(n)}`);
    const cases = vars.map((v, i) => `case ${i}:${v}=v;break;`).join('');
    return (
      `var ${vars.length ? vars.join(',') : '$ov_'};\n` +
      (exportList.length ? `export { ${exportList.join(', ')} };\n` : '') +
      `globalThis.__ovSynthetic(${JSON.stringify(this.id)},(i,v)=>{switch(i){${cases}}});\n`
    );
  }

  /** A module that re-exports what evaluateSync produced, so the browser doesn't run the code twice. */
  #facadeSource(): string {
    const names = Object.keys(this.#syncExports!).filter((n) => n !== '__esModule');
    const lit = JSON.stringify(this.id);
    let out = `const $ov = globalThis.__ovSyncNamespace(${lit});\n`;
    names.forEach((n, i) => {
      out += `const $ov${i} = $ov[${JSON.stringify(n)}];\nexport { $ov${i} as ${n === 'default' || ID_RE.test(n) ? n : JSON.stringify(n)} };\n`;
    });
    return out;
  }

  servedUrl(): string {
    return moduleUrl(this.id);
  }

  #register(seen = new Set<ModuleWrap>()) {
    if (seen.has(this)) return;
    seen.add(this);
    if (!this.#registered) {
      const source = this.#syncExports ? this.#facadeSource() : this.#exportNames ? this.#syntheticSource() : this.#rewritten();
      sys('esmRegister', { id: this.id, source });
      this.#registered = true;
    }
    for (const m of this.#linked) if (m) m.#register(seen);
  }

  #walk(fn: (m: ModuleWrap) => void, seen = new Set<ModuleWrap>()) {
    if (seen.has(this)) return;
    seen.add(this);
    fn(this);
    for (const m of this.#linked) if (m) m.#walk(fn, seen);
  }

  /** Export names, as the namespace lists them (star exports resolved through the links). */
  #allExportNames(seen = new Set<ModuleWrap>()): Set<string> {
    if (this.#exportNames) return new Set(this.#exportNames);
    const out = new Set(this.#localExports);
    if (seen.has(this)) return out;
    seen.add(this);
    this.#requests.forEach((r, i) => {
      const t = this.#linked[i];
      if (r.star && t) for (const n of t.#allExportNames(seen)) if (n !== 'default') out.add(n);
    });
    return out;
  }

  /** What V8 checks while instantiating a vm module graph: every request linked, every imported name exported. */
  #checkLinks() {
    this.#walk((m) => {
      if (!m.#isVm || m.#exportNames || m.#status >= kInstantiated) return;
      // a module without requests needn't be linked, unless it's the one being instantiated
      if (!m.#linkCalled && (m === this || m.#requests.length)) throw linkFailure(`module ${m.url} is not linked`);
      m.#requests.forEach((r, i) => {
        const t = m.#linked[i];
        if (!t) throw linkFailure(`request for '${r.specifier}' is not resolved`);
        if (!r.names.size) return;
        const names = t.#allExportNames();
        for (const n of r.names) {
          if (!names.has(n)) throw new SyntaxError(`The requested module '${r.specifier}' does not provide an export named '${n}'`);
        }
      });
    });
  }

  instantiate() {
    if (this.#status >= kInstantiated) return;
    this.#checkLinks();
    this.#status = kInstantiating;
    this.#walk((m) => {
      if (m.#status < kInstantiated) m.#status = kInstantiated;
    });
  }

  instantiateSync() {
    this.instantiate();
    return this.isGraphAsync();
  }

  evaluate(_timeout?: number, _breakOnSigint?: boolean): Promise<unknown> {
    // once settled, V8 hands out an already settled promise
    if (this.#asyncSettled) return this.#status === kErrored ? rejectedPromise(this.#error) : fulfilledPromise(undefined);
    if (this.#evaluation) return this.#evaluation;
    if (this.#status === kErrored) return Promise.reject(this.#error);
    if (this.#status < kInstantiated) this.instantiate();
    if (this.#syncExports) {
      this.#evaluation = fulfilledPromise(undefined);
      return this.#evaluation;
    }
    // V8 runs synthetic modules, and module graphs without top-level await, synchronously: the
    // promise is already settled and the namespace readable when evaluate() returns
    if (this.#exportNames) {
      this.#status = kEvaluating;
      try {
        this.#runSyntheticSteps();
        this.#status = kEvaluated;
        return (this.#evaluation = fulfilledPromise(undefined));
      } catch (e) {
        this.#status = kErrored;
        this.#error = e;
        return (this.#evaluation = rejectedPromise(e));
      }
    }
    if (this.#isVm && this.isGraphAsync()) {
      // dependencies first, awaiting the ones with top-level await; doesn't hold the event loop
      // (like V8, a module waiting on nothing leaves its promise pending)
      this.#status = kEvaluating;
      this.#evaluation = this.#evaluateAsyncGraph().then(
        () => {
          this.#walk((m) => {
            if (m.#status < kEvaluated) m.#status = kEvaluated;
          });
          this.#asyncSettled = true;
          return undefined;
        },
        (e) => {
          this.#status = kErrored;
          this.#error = e;
          this.#asyncSettled = true;
          throw e;
        },
      );
      return this.#evaluation;
    }
    if (this.#isVm) {
      this.#status = kEvaluating;
      try {
        this.#evaluateSyncGraph();
        this.#walk((m) => {
          if (m.#status < kEvaluated) m.#status = kEvaluated;
        });
        return (this.#evaluation = fulfilledPromise(undefined));
      } catch (e) {
        this.#status = kErrored;
        this.#error = e;
        return (this.#evaluation = rejectedPromise(e));
      }
    }
    try {
      this.#register();
    } catch (e) {
      this.#status = kErrored;
      this.#error = e;
      return Promise.reject(e);
    }
    this.#status = kEvaluating;
    const done = loop.startReq('ModuleEvaluation');
    this.#evaluation = import(/* @vite-ignore */ this.servedUrl()).then(
      (ns) => {
        done();
        this.#realNs = ns;
        if (!this.#isVm) this.#namespace = ns;
        this.#walk((m) => {
          if (m.#status < kEvaluated) m.#status = kEvaluated;
        });
        return undefined;
      },
      (e) => {
        done();
        this.#status = kErrored;
        this.#error = e;
        throw e;
      },
    );
    return this.#evaluation;
  }

  /**
   * require(esm). The browser can't evaluate a module graph synchronously, so the graph's source
   * modules run as CommonJS-shaped functions (sucrase's imports transform) and synthetic modules
   * run their evaluation steps directly.
   */
  evaluateSync(_filename?: string, _parentFilename?: string): object {
    if (this.#status === kErrored) throw this.#error;
    try {
      const ns = this.#evaluateSyncGraph();
      this.#walk((m) => {
        if (m.#status < kEvaluated && (m.#syncExports || m.#namespace)) m.#status = kEvaluated;
      });
      return ns;
    } catch (e) {
      this.#status = kErrored;
      this.#error = e;
      throw e;
    }
  }

  #evaluateSyncGraph(): any {
    if (this.#namespace) return this.#namespace;
    if (this.#syncExports) return this.#syncExports;
    if (this.#exportNames) {
      const exportsObj: Record<string, unknown> = Object.create(null);
      this.#syncExports = exportsObj;
      this.#exportNames.forEach((n, i) => Object.defineProperty(exportsObj, n, { enumerable: true, get: () => this.#values[i] }));
      Object.defineProperty(exportsObj, '__esModule', { value: true });
      if (this.#evaluationSteps) {
        const steps = this.#evaluationSteps;
        this.#evaluationSteps = null;
        steps.call(this);
      }
      this.#namespace = exportsObj;
      return exportsObj;
    }
    if (this.#status === kErrored) throw this.#error;
    return this.#runSource(false);
  }

  #asyncStarted = false;
  #asyncEvaluation: Promise<void> | null = null;

  /** A vm module graph with top-level await: dependencies in order (awaiting the async ones), then this. */
  #evaluateAsyncGraph(): Promise<void> {
    if (this.#asyncEvaluation) return this.#asyncEvaluation;
    // a cycle back to a module already running: don't wait for it
    if (this.#asyncStarted) return Promise.resolve();
    this.#asyncStarted = true;
    return (this.#asyncEvaluation = (async () => {
      if (this.#exportNames || this.#syncExports || this.#namespace) {
        this.#evaluateSyncGraph();
        return;
      }
      if (this.#status === kErrored) throw this.#error;
      for (const dep of this.#linked) {
        if (!dep) continue;
        if (dep.isGraphAsync()) await dep.#evaluateAsyncGraph();
        else dep.#evaluateSyncGraph();
      }
      await this.#runSource(this.hasTopLevelAwait());
    })());
  }

  /**
   * Runs a source module as a CommonJS-shaped function (sucrase's imports transform; an async
   * function when it has top-level await). Its links are already evaluated, or are evaluated on
   * require.
   */
  #runSource(async: boolean): any {
    const exportsObj: Record<string, unknown> = {};
    this.#syncExports = exportsObj;
    if (this.#status < kEvaluating) this.#status = kEvaluating;
    // import.meta and import() go through our hooks first; then ESM syntax becomes require/exports
    const prepared = this.#rewrittenForSync();
    const code = sucrase().transform(prepared, { transforms: ['imports'], keepUnusedImports: true, filePath: this.url }).code;
    const requireLinked = (spec: string) => {
      const i = this.#requests.findIndex((r) => r.specifier === spec);
      const target = i >= 0 ? this.#linked[i] : undefined;
      if (!target) throw new Error(`module ${this.url} is not linked (${spec})`);
      const ns = target.#evaluateSyncGraph();
      // vm modules see real namespaces: static `export *`, live and uninitialized bindings
      return this.#isVm ? target.#facadeNs() : ns;
    };
    const module = { exports: exportsObj };
    const scope = contextScope(this.#context);
    const head = `${async ? 'async ' : ''}function (exports, require, module) {`;
    const fn = scope
      ? (0, eval)(`(function (__ov$s) { with (__ov$s) return ${head}${code}\n} })\n//# sourceURL=${this.url}`)(scope)
      : (0, eval)(`(${head}${code}\n})\n//# sourceURL=${this.url}`);
    const fail = (e: unknown) => {
      this.#status = kErrored;
      this.#error = e;
      throw e;
    };
    const finish = () => {
      if (module.exports !== exportsObj) Object.assign(exportsObj, module.exports);
      Object.defineProperty(exportsObj, Symbol.toStringTag, { value: 'Module' });
      this.#namespace = exportsObj;
      return exportsObj;
    };
    let ret: unknown;
    try {
      ret = fn.call(undefined, exportsObj, requireLinked, module);
    } catch (e) {
      fail(e);
    }
    return async ? (ret as Promise<unknown>).then(finish, fail) : finish();
  }

  #rewrittenForSync(): string {
    const src = this.#source!;
    const edits: { s: number; e: number; text: string }[] = [];
    // bare names (not globalThis.…): a module run in a vm context resolves globalThis to the context
    for (const m of this.#metaRanges) edits.push({ s: m.start, e: m.end, text: `__ov$importMeta(${JSON.stringify(this.id)})` });
    for (const d of this.#dynamicRanges) edits.push({ s: d.kwStart, e: d.kwEnd, text: `__ov$dynamicImport.bind(null, ${JSON.stringify(this.id)})` });
    // vm modules resolve `export *` statically (#readExport); sucrase's copy of the keys at require
    // time would read uninitialized bindings in a cycle. Keep the import for evaluation order.
    if (this.#isVm) for (const r of this.#starRanges) edits.push({ s: r.s, e: r.e, text: 'import ' });
    // sucrase exports only the first name of `export const a = 1, b = 2`: split off an export list
    if (/\bexport\s+(?:const|let|var)\s[^;]*,/.test(src)) {
      try {
        const acorn = lib('internal/deps/acorn/acorn/dist/acorn');
        const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
        for (const st of ast.body) {
          const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : null;
          if (decl?.type !== 'VariableDeclaration' || decl.declarations.length < 2) continue;
          const names = new Set<string>();
          for (const d of decl.declarations) bindingNames(d.id, names);
          edits.push({ s: st.start, e: decl.start, text: '' });
          edits.push({ s: st.end, e: st.end, text: `;export { ${[...names].join(', ')} };` });
        }
      } catch {}
    }
    edits.sort((a, b) => a.s - b.s);
    let out = '';
    let last = 0;
    for (const ed of edits) {
      out += src.slice(last, ed.s) + ed.text;
      last = ed.e;
    }
    return out + src.slice(last);
  }

  getNamespace() {
    if (this.#isVm || (this.#exportNames && !this.#namespace)) {
      if (this.#status >= kInstantiated) return this.#facadeNs();
    } else if (this.#namespace) return this.#namespace;
    const e = new Error(`cannot get namespace, module has not been evaluated: ${this.url}`) as Error & { code: string };
    e.code = 'ERR_MODULE_NOT_INSTANTIATED';
    throw e;
  }

  /**
   * A module namespace object for lib: sealed, null prototype, sorted names, data properties
   * whose values are read live (synthetic values, the sync exports, or the browser's namespace).
   */
  #makeFacade(): object {
    const names = [...this.#allExportNames()].sort();
    const target = Object.create(null);
    for (const n of names) Object.defineProperty(target, n, { value: undefined, writable: true, enumerable: true, configurable: false });
    Object.defineProperty(target, Symbol.toStringTag, { value: 'Module' });
    Object.preventExtensions(target);
    const has = new Set(names);
    const read = (k: string) => this.#readExport(k, new Set());
    return new Proxy(target, {
      // so sucrase's interop helpers (vm modules run as CommonJS) use it as it is
      get: (t, k) => (typeof k === 'string' && has.has(k) ? read(k) : k === '__esModule' ? true : Reflect.get(t, k)),
      getOwnPropertyDescriptor: (t, k) => {
        const d = Reflect.getOwnPropertyDescriptor(t, k);
        if (d && typeof k === 'string') d.value = read(k);
        return d;
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: (t, k) => !Reflect.has(t, k),
    });
  }

  /** An export's current value; ReferenceError while it is uninitialized (as V8's TDZ). */
  #readExport(k: string, seen: Set<ModuleWrap>): unknown {
    if (this.#exportNames) return this.#values[this.#exportNames.indexOf(k)];
    if (this.#realNs) return (this.#realNs as any)[k];
    const ex = this.#syncExports;
    if (ex && Object.prototype.hasOwnProperty.call(ex, k)) return ex[k];
    // `export *` is resolved statically, as V8 does (sucrase copies whatever exists at require time)
    if (!seen.has(this)) {
      seen.add(this);
      for (let i = 0; i < this.#requests.length; i++) {
        const t = this.#linked[i];
        if (this.#requests[i].star && t && k !== 'default' && t.#allExportNames().has(k)) return t.#readExport(k, seen);
      }
    }
    if (ex && this.#status === kEvaluated) return undefined;
    throw new ReferenceError(`${k} is not defined`);
  }

  #facadeNs(): object {
    return (this.#facade ??= this.#makeFacade());
  }

  getNamespaceSync() {
    return this.getNamespace();
  }

  getStatus() {
    return this.#status;
  }

  getError() {
    return this.#error;
  }

  isGraphAsync() {
    let async = false;
    this.#walk((m) => {
      if (m.hasTopLevelAwait()) async = true;
    });
    return async;
  }

  hasTopLevelAwait(): boolean {
    if (this.#tla !== undefined) return this.#tla;
    if (!this.#source || !/\bawait\b/.test(this.#source)) return (this.#tla = false);
    try {
      const acorn = lib('internal/deps/acorn/acorn/dist/acorn');
      const walk = lib('internal/deps/acorn/acorn-walk/dist/walk');
      const ast = acorn.parse(this.#source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
      let found = false;
      walk.recursive(ast, null, {
        Function() {},
        AwaitExpression() {
          found = true;
        },
        ForOfStatement(node: any, st: unknown, c: (n: unknown, s: unknown) => void) {
          if (node.await) found = true;
          c(node.left, st);
          c(node.right, st);
          c(node.body, st);
        },
      });
      return (this.#tla = found);
    } catch {
      return (this.#tla = false);
    }
  }

  setExport(name: string, value: unknown) {
    const i = this.#exportNames?.indexOf(name) ?? -1;
    if (i < 0) {
      const e = new ReferenceError(`Export '${name}' is not defined in module`);
      throw e;
    }
    this.#values[i] = value;
    if (this.#setters) this.#setters(i, value);
  }

  createCachedData() {
    return makeCachedData(this.#source ?? '');
  }

  #runSyntheticSteps() {
    if (!this.#evaluationSteps) return;
    const steps = this.#evaluationSteps;
    this.#evaluationSteps = null;
    steps.call(this);
  }

  /** @internal called from the generated synthetic module when the browser evaluates it */
  _bindSynthetic(setters: (i: number, v: unknown) => void) {
    this.#setters = setters;
    this.#values.forEach((v, i) => setters(i, v));
    this.#runSyntheticSteps();
  }

  /** @internal */
  _syncNamespace() {
    return this.#syncExports;
  }

  /** @internal */
  _importMeta(): object {
    if (!this.#meta) {
      this.#meta = Object.create(null);
      importMetaCallback?.(this.#hostDefinedOption, this.#meta!, this);
    }
    return this.#meta!;
  }

  /** @internal */
  _dynamicImport(specifier: unknown, options?: { with?: Record<string, string>; assert?: Record<string, string> }) {
    const attributes = attributesOf(Object.entries(options?.with ?? options?.assert ?? {}) as [string, string][]);
    if (!dynamicImportCallback) return Promise.reject(new Error('dynamic import callback not set'));
    return dynamicImportCallback(this.#hostDefinedOption, String(specifier), attributes, this.url);
  }
}

/** import() in code evaluated away from its module (another thread): resolved from the cwd. */
function importFromCwd(specifier: unknown, options?: { with?: Record<string, string> }) {
  const { getOrInitializeCascadedLoader } = S.requireBuiltin('internal/modules/esm/loader');
  const { pathToFileURL } = S.requireBuiltin('internal/url');
  const parent = pathToFileURL(`${S.process.cwd()}/`).href;
  return getOrInitializeCascadedLoader().import(String(specifier), parent, options?.with ?? {});
}

/** The module URL (file://…) for a URL the runtime served the module at, if it is one. */
export function moduleUrlForServed(url: string): string | undefined {
  const m = /\/__ov\/mw\/\d+\/(\d+)\.mjs$/.exec(url);
  return m ? byId.get(m[1])?.url : undefined;
}

/** Dynamic import from a CommonJS module or a script (compiled by contextify). */
export function importFromScript(referrerSymbol: unknown, referrerName: string, specifier: unknown, options?: { with?: Record<string, string> }) {
  const attributes = attributesOf(Object.entries(options?.with ?? {}) as [string, string][]);
  if (!dynamicImportCallback) return Promise.reject(new Error('dynamic import callback not set'));
  return dynamicImportCallback(referrerSymbol, String(specifier), attributes, referrerName);
}

export function createModuleWrap() {
  const b = fromShape('module_wrap');
  const g = globalThis as any;
  Object.defineProperties(g, {
    __ovSynthetic: { value: (id: string, setters: (i: number, v: unknown) => void) => byId.get(id)?._bindSynthetic(setters), configurable: true },
    __ovImportMeta: { value: (id: string) => byId.get(id)?._importMeta() ?? {}, configurable: true },
    __ovDynamicImport: { value: (id: string, s: unknown, o?: any) => byId.get(id)?._dynamicImport(s, o) ?? importFromCwd(s, o), configurable: true },
    __ovSyncNamespace: { value: (id: string) => byId.get(id)?._syncNamespace(), configurable: true },
    __ov$importMeta: { value: (id: string) => byId.get(id)?._importMeta(), configurable: true },
    __ov$dynamicImport: { value: (id: string, s: unknown, o?: any) => byId.get(id)!._dynamicImport(s, o), configurable: true },
  });
  return Object.assign(b, {
    ModuleWrap,
    kUninstantiated,
    kInstantiating,
    kInstantiated,
    kEvaluating,
    kEvaluated,
    kErrored,
    setImportModuleDynamicallyCallback(fn: typeof dynamicImportCallback) {
      dynamicImportCallback = fn;
    },
    setInitializeImportMetaObjectCallback(fn: typeof importMetaCallback) {
      importMetaCallback = fn;
    },
    createRequiredModuleFacade(wrap: ModuleWrap) {
      return wrap.getNamespace();
    },
    throwIfPromiseRejected: () => {},
  });
}
