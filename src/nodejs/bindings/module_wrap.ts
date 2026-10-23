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
import { S } from '../state.ts';
import { fromShape } from './shape.ts';

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
}

let nextId = 1;
const byId = new Map<string, ModuleWrap>();
let importMetaCallback: ((symbol: unknown, meta: object, wrap: ModuleWrap) => void) | null = null;
let dynamicImportCallback: ((symbol: unknown, specifier: string, attributes: Record<string, string>, referrerName: string) => Promise<unknown>) | null = null;

function moduleUrl(id: string) {
  return `${S.runtimeOrigin}/__ov/mw/${S.init.pid}/${id}.mjs`;
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
  #pendingExports = new Map<number, unknown>();
  #meta: object | null = null;

  constructor(url: string, context: unknown, sourceOrNames: string | string[], lineOffsetOrSteps?: number | (() => void), _columnOffset?: number, hostDefinedOption?: unknown) {
    void context;
    this.url = url;
    this.id = String(nextId++);
    byId.set(this.id, this);
    if (typeof sourceOrNames === 'string') {
      this.#source = sourceOrNames;
      this.#hostDefinedOption = hostDefinedOption;
      this.#analyze(sourceOrNames);
    } else {
      this.#exportNames = [...sourceOrNames];
      this.#evaluationSteps = lineOffsetOrSteps as () => void;
    }
  }

  #analyze(src: string) {
    let imports: any[];
    try {
      [imports] = parseEsm(src, this.url) as any;
    } catch (e: any) {
      // let V8 report the syntax error the way Node would: as a SyntaxError on construction
      const err = new SyntaxError(e?.message ?? 'Invalid or unexpected token');
      throw err;
    }
    const index = new Map<string, Request>();
    for (const imp of imports) {
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
        r = { specifier: imp.specifier, attributes, ranges: [] };
        index.set(key, r);
        this.#requests.push(r);
      }
      const [as, ae] = imp.attributesStart >= 0 ? attributeClause(src, imp.attributesStart) : [-1, -1];
      r.ranges.push({ start: imp.start, end: imp.end, attrStart: as, attrEnd: ae });
    }
    const sm = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(src.slice(-512));
    if (sm) this.sourceMapURL = sm[1];
    const su = /\/\/[#@] sourceURL=(\S+)\s*$/m.exec(src.slice(-1024));
    if (su) this.sourceURL = su[1];
  }

  getModuleRequests() {
    return this.#requests.map((r) => ({ specifier: r.specifier, attributes: r.attributes }));
  }

  link(specifiers: string[], modules: ModuleWrap[]) {
    if (this.#exportNames) return;
    for (let i = 0; i < this.#requests.length; i++) {
      if (specifiers[i] !== this.#requests[i].specifier) {
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
    for (const m of this.#metaRanges) edits.push({ s: m.start, e: m.end, text: '__ov$meta()' });
    for (const d of this.#dynamicRanges) edits.push({ s: d.kwStart, e: d.kwEnd, text: '__ov$import' });
    edits.sort((a, b) => a.s - b.s);
    let out = '';
    let last = 0;
    for (const ed of edits) {
      if (ed.s < last) continue;
      out += src.slice(last, ed.s) + ed.text;
      last = ed.e;
    }
    out += src.slice(last);
    const lit = JSON.stringify(this.id);
    let tail = '';
    if (this.#metaRanges.length) tail += `\nvar __ov$m;function __ov$meta(){return __ov$m||(__ov$m=globalThis.__ovImportMeta(${lit}))}`;
    if (this.#dynamicRanges.length) tail += `\nfunction __ov$import(s,o){return globalThis.__ovDynamicImport(${lit},s,o)}`;
    // keep source maps pointing at the original file
    return out + tail + `\n//# sourceURL=${this.url}`;
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

  servedUrl(): string {
    return moduleUrl(this.id);
  }

  #register(seen = new Set<ModuleWrap>()) {
    if (seen.has(this)) return;
    seen.add(this);
    if (!this.#registered) {
      sys('esmRegister', { id: this.id, source: this.#exportNames ? this.#syntheticSource() : this.#rewritten() });
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

  instantiate() {
    if (this.#status >= kInstantiated) return;
    this.#status = kInstantiating;
    try {
      this.#register();
    } catch (e) {
      this.#status = kErrored;
      this.#error = e;
      throw e;
    }
    this.#walk((m) => {
      if (m.#status < kInstantiated) m.#status = kInstantiated;
    });
  }

  instantiateSync() {
    this.instantiate();
    return this.isGraphAsync();
  }

  evaluate(_timeout?: number, _breakOnSigint?: boolean): Promise<unknown> {
    if (this.#evaluation) return this.#evaluation;
    if (this.#status === kErrored) return Promise.reject(this.#error);
    if (this.#status < kInstantiated) this.instantiate();
    this.#status = kEvaluating;
    const done = loop.startReq('ModuleEvaluation');
    this.#evaluation = import(/* @vite-ignore */ this.servedUrl()).then(
      (ns) => {
        done();
        this.#namespace = ns;
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

  /** require(esm) — the browser can't evaluate a module graph synchronously. */
  evaluateSync(): never {
    const e = new Error(`require() of ES module ${this.url} is not supported in OpenVessel yet; use import()`) as Error & { code: string };
    e.code = 'ERR_REQUIRE_ASYNC_MODULE';
    throw e;
  }

  getNamespace() {
    if (this.#namespace) return this.#namespace;
    const e = new Error(`cannot get namespace, module has not been evaluated: ${this.url}`) as Error & { code: string };
    e.code = 'ERR_MODULE_NOT_INSTANTIATED';
    throw e;
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
    if (!this.#source) return false;
    // cheap check: an await at statement level outside any function (good enough for warnings)
    return /(^|[;\n{}])\s*(for\s+)?await\b/.test(this.#source) && /^[^\n]*\bawait\b/m.test(this.#source);
  }

  setExport(name: string, value: unknown) {
    const i = this.#exportNames?.indexOf(name) ?? -1;
    if (i < 0) {
      const e = new ReferenceError(`Export '${name}' is not defined in module`);
      throw e;
    }
    if (this.#setters) this.#setters(i, value);
    else this.#pendingExports.set(i, value);
  }

  createCachedData() {
    return new Uint8Array(0);
  }

  /** @internal called from the generated synthetic module when the browser evaluates it */
  _bindSynthetic(setters: (i: number, v: unknown) => void) {
    this.#setters = setters;
    for (const [i, v] of this.#pendingExports) setters(i, v);
    this.#pendingExports.clear();
    if (this.#evaluationSteps) {
      const steps = this.#evaluationSteps;
      this.#evaluationSteps = null;
      steps.call(this);
    }
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
    __ovImportMeta: { value: (id: string) => byId.get(id)?._importMeta(), configurable: true },
    __ovDynamicImport: { value: (id: string, s: unknown, o?: any) => byId.get(id)!._dynamicImport(s, o), configurable: true },
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
