// internalBinding('contextify') — compiling CommonJS modules, vm.Script and vm.compileFunction.
// Code is compiled with an indirect eval (global scope, with a sourceURL so stacks name the file);
// dynamic import() inside it is routed to Node's importModuleDynamically callback.
// New contexts (vm.createContext) can't be made inside a Worker; see makeContext.

import { parse as parseEsm } from 'es-module-lexer/js';
import { S } from '../state.ts';
import { importFromScript } from './module_wrap.ts';
import { fromShape } from './shape.ts';

const indirectEval = eval;
let nextScript = 1;
const referrers = new Map<number, { symbol: unknown; name: string }>();

(globalThis as any).__ovScriptImport = undefined;
Object.defineProperty(globalThis, '__ovScriptImport', {
  value: (id: number, specifier: unknown, options?: any) => {
    const r = referrers.get(id);
    return importFromScript(r?.symbol, r?.name ?? '', specifier, options);
  },
  configurable: true,
  enumerable: false,
});

/** Rewrites `import(` to the dynamic-import router; leaves code alone when the lexer can't parse it. */
function routeDynamicImport(code: string, symbol: unknown, name: string): string {
  if (!code.includes('import')) return code;
  let imports: any[];
  try {
    [imports] = parseEsm(code) as any;
  } catch {
    return code;
  }
  const dyn = imports.filter((i) => i.type === 'dynamic' && i.dynamicStart >= 0);
  if (!dyn.length) return code;
  const id = nextScript++;
  referrers.set(id, { symbol, name });
  let out = '';
  let last = 0;
  for (const d of dyn) {
    out += code.slice(last, d.importStart) + `globalThis.__ovScriptImport(${id},`;
    // skip "import(" (and whitespace) up to the opening paren
    last = d.dynamicStart + 1;
  }
  return out + code.slice(last);
}

/** Whether code that failed to compile as CommonJS is ES module syntax. */
function looksLikeModule(code: string): boolean {
  try {
    const r = parseEsm(code) as any;
    return !!r[3];
  } catch {
    return false;
  }
}

const ESM_SYNTAX_ERRORS = [/Cannot use import statement outside a module/, /Unexpected token 'export'/, /Cannot use 'import\.meta' outside a module/, /await is only valid in async functions/, /Unexpected reserved word/, /Unexpected identifier 'await'/];

function isEsmSyntaxError(e: unknown): boolean {
  return e instanceof SyntaxError && ESM_SYNTAX_ERRORS.some((re) => re.test(e.message));
}

function sourceMapInfo(code: string) {
  const tail = code.slice(-1024);
  const sm = /\/\/[#@] sourceMappingURL=(\S+)\s*$/m.exec(tail);
  const su = /\/\/[#@] sourceURL=(\S+)\s*$/m.exec(tail);
  return { sourceMapURL: sm?.[1], sourceURL: su?.[1] };
}

/** How many columns the wrapper adds to line 1 of a compiled file (stack traces subtract it). */
export const lineOneOffset = new Map<string, number>();

function compileWrapper(code: string, filename: string, params: string[], symbol: unknown): Function {
  // V8 accepts a hashbang only at the very start of a script, not inside the wrapper
  if (code.startsWith('#!')) code = '//' + code.slice(2);
  const body = routeDynamicImport(code, symbol, filename);
  // keep the code on the wrapper's first line so line numbers match the file
  const head = `(function (${params.join(', ')}) {`;
  lineOneOffset.set(filename, head.length);
  return indirectEval(`${head}${body}\n})\n//# sourceURL=${filename}`);
}

const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

export function createContextify() {
  const b = fromShape('contextify');
  const hostSymbol = () => S.privateSymbols.host_defined_option_symbol;

  class ContextifyScript {
    cachedDataRejected = false;
    sourceMapURL: string | undefined;
    #code: string;
    #filename: string;
    constructor(code: string, filename: string, _lineOffset?: number, _columnOffset?: number, _cachedData?: unknown, _produce?: boolean, _parsingContext?: unknown, hostDefinedOptionId?: unknown) {
      this.#filename = filename;
      this.sourceMapURL = sourceMapInfo(code).sourceMapURL;
      (this as any)[hostSymbol()] = hostDefinedOptionId;
      this.#code = routeDynamicImport(code, hostDefinedOptionId, filename);
      // V8 compiles on construction, so syntax errors surface here
      try {
        new Function(this.#code);
      } catch (e) {
        if (e instanceof SyntaxError && !/Illegal return statement/.test(e.message)) throw e;
      }
    }
    runInContext(contextified: unknown, _timeout?: number, _displayErrors?: boolean, _breakOnSigint?: boolean, _breakOnFirstLine?: boolean) {
      if (contextified !== null && contextified !== undefined) return runInSandbox(this.#code, this.#filename, contextified as object);
      return indirectEval(`${this.#code}\n//# sourceURL=${this.#filename}`);
    }
    createCachedData() {
      return new Uint8Array(0);
    }
  }

  function runInSandbox(code: string, filename: string, sandbox: object) {
    // No new realm in a Worker: evaluate with the sandbox's properties in scope.
    const fn = indirectEval(`(function (__ovSandbox) { with (__ovSandbox) { return eval(${JSON.stringify(code + `\n//# sourceURL=${filename}`)}); } })`);
    return fn.call(sandbox, sandbox);
  }

  return Object.assign(b, {
    ContextifyScript,
    compileFunctionForCJSLoader(content: string, filename: string, _isSeaMain: boolean, shouldDetectModule: boolean) {
      const info = sourceMapInfo(content);
      try {
        const fn = compileWrapper(content, filename, CJS_PARAMS, S.perIsolateSymbols.vm_dynamic_import_default_internal);
        return { cachedDataRejected: false, sourceMapURL: info.sourceMapURL, sourceURL: info.sourceURL, function: fn, canParseAsESM: false };
      } catch (e) {
        if (shouldDetectModule && isEsmSyntaxError(e) && looksLikeModule(content)) {
          return { cachedDataRejected: false, sourceMapURL: info.sourceMapURL, sourceURL: info.sourceURL, function: undefined, canParseAsESM: true };
        }
        throw e;
      }
    },
    compileFunction(code: string, filename: string, _lineOffset: number, _columnOffset: number, _cachedData: unknown, _produce: boolean, _parsingContext: unknown, _contextExtensions: unknown[], params: string[] | undefined, hostDefinedOptionId: unknown) {
      const fn = compileWrapper(code, filename, params ?? [], hostDefinedOptionId);
      (fn as any)[hostSymbol()] = hostDefinedOptionId;
      return { function: fn, cachedDataRejected: false, ...sourceMapInfo(code) };
    },
    containsModuleSyntax(code: string, _filename: string) {
      try {
        new Function(...CJS_PARAMS, code);
        return false;
      } catch (e) {
        return isEsmSyntaxError(e) && looksLikeModule(code);
      }
    },
    makeContext(contextObject: object) {
      // contexts are approximated: the object itself is the global used by runInContext
      (contextObject as any)[S.privateSymbols.contextify_context_private_symbol] = contextObject;
    },
    startSigintWatchdog: () => {},
    stopSigintWatchdog: () => false,
    watchdogHasPendingSigint: () => false,
    measureMemory: () => Promise.resolve({}),
  });
}
