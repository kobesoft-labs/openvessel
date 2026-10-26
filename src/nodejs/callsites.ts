// V8's stack trace API for engines without it (Firefox). Node's lib/ and many packages rely on
// Error.prepareStackTrace receiving CallSite objects and on "Error: message\n    at …" stacks;
// SpiderMonkey has Error.captureStackTrace and Error.stackTraceLimit but formats stacks as
// "name@file:line:col" and never calls Error.prepareStackTrace. Here the stack string is parsed
// into CallSite-like frames and formatted the way V8 does, on first access as V8 does too.
// Nothing is installed when the engine already calls Error.prepareStackTrace (Chrome).

const { defineProperty, getOwnPropertyDescriptor } = Object;
const FRAME = /^(?:(.*?)\*)?(.*?)@(.*?)(?::(\d+))?(?::(\d+))?$/;
const EVAL_FILE = / line (\d+) > (?:eval|Function)$/;
const REAL_URL = /^(?:https?|blob|file|data):/;
const errorToString = Error.prototype.toString;

class CallSite {
  #name: string | null;
  #file: string;
  #line: number | null;
  #column: number | null;
  #async: boolean;
  constructor(name: string | null, file: string, line: number | null, column: number | null, async: boolean) {
    this.#name = name;
    this.#file = file;
    this.#line = line;
    this.#column = column;
    this.#async = async;
  }
  getThis() {
    return undefined;
  }
  getTypeName() {
    return null;
  }
  getFunction() {
    return undefined;
  }
  getFunctionName() {
    return this.#name;
  }
  getMethodName() {
    return null;
  }
  getFileName() {
    return this.#scriptName();
  }
  getLineNumber() {
    return this.#line;
  }
  getColumnNumber() {
    return this.#column;
  }
  getEnclosingLineNumber() {
    return null;
  }
  getEnclosingColumnNumber() {
    return null;
  }
  // (not through getFileName, which boot.ts wraps with a call back to this one)
  getScriptNameOrSourceURL() {
    return this.#scriptName();
  }
  #scriptName() {
    return EVAL_FILE.test(this.#file) ? undefined : this.#file || undefined;
  }
  getScriptHash() {
    return '';
  }
  getPosition() {
    return 0;
  }
  getEvalOrigin() {
    const m = EVAL_FILE.exec(this.#file);
    return m ? `${this.#file.slice(0, m.index)}:${m[1]}` : undefined;
  }
  /** Code compiled with eval or new Function: under a sourceURL that isn't a URL (node:…, a path, [eval]) or none at all. */
  isEval() {
    return EVAL_FILE.test(this.#file) || !REAL_URL.test(this.#file);
  }
  isNative() {
    return false;
  }
  isToplevel() {
    return this.#name === null;
  }
  isConstructor() {
    return false;
  }
  isAsync() {
    return this.#async;
  }
  isPromiseAll() {
    return false;
  }
  getPromiseIndex() {
    return null;
  }
  toString() {
    const loc = this.#file ? (this.#line === null ? this.#file : `${this.#file}:${this.#line}:${this.#column}`) : '<anonymous>';
    const text = this.#name ? `${this.#name} (${loc})` : loc;
    return this.#async ? `async ${text}` : text;
  }
}

/** Frames of a SpiderMonkey stack string. Names of closures ("outer/<", "outer/inner<") are dropped, as V8 shows them anonymous. */
export function parseStack(stack: string): CallSite[] {
  const out: CallSite[] = [];
  const lines = stack.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = FRAME.exec(lines[i]);
    if (!lines[i] || !m) continue;
    let name: string | null = m[2];
    if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1);
    if (!name || name.endsWith('<')) name = null;
    out.push(new CallSite(name, m[3], m[4] ? Number(m[4]) : null, m[5] ? Number(m[5]) : null, m[1] === 'async'));
  }
  return out;
}

function header(error: unknown): string {
  try {
    return errorToString.call(error);
  } catch {
    return '<error>';
  }
}

/** Whether the engine calls Error.prepareStackTrace (V8). */
export const hasV8StackApi = (() => {
  const E = Error as any;
  const saved = getOwnPropertyDescriptor(E, 'prepareStackTrace');
  E.prepareStackTrace = (_e: unknown, s: unknown) => s;
  const probe: unknown = new Error().stack;
  if (saved) defineProperty(E, 'prepareStackTrace', saved);
  else delete E.prepareStackTrace;
  return typeof probe !== 'string';
})();

export function installCallSites() {
  if (hasV8StackApi) return;
  const E = Error as any;
  const nativeStack = getOwnPropertyDescriptor(Error.prototype, 'stack');
  const nativeCapture = E.captureStackTrace;
  if (!nativeStack?.get || typeof nativeCapture !== 'function') return;
  const nativeGet = nativeStack.get;
  const formatting = new WeakSet<object>();

  function format(error: object, raw: string) {
    const frames = parseStack(raw);
    if (typeof E.prepareStackTrace !== 'function') {
      let s = header(error);
      for (let i = 0; i < frames.length; i++) s += `\n    at ${frames[i]}`;
      return s;
    }
    formatting.add(error);
    try {
      return E.prepareStackTrace(error, frames);
    } finally {
      formatting.delete(error);
    }
  }
  const own = (obj: object, value: unknown) => defineProperty(obj, 'stack', { value, writable: true, enumerable: false, configurable: true });

  // the formatted stack replaces the accessor on the error itself, as V8 keeps it as an own property
  defineProperty(Error.prototype, 'stack', {
    get() {
      const raw = nativeGet.call(this);
      // read again from inside Error.prepareStackTrace: the engine's own string
      if (typeof raw !== 'string' || this === Error.prototype || formatting.has(this)) return raw;
      const value = format(this, raw);
      own(this, value);
      return value;
    },
    set(value) {
      own(this, value);
    },
    enumerable: false,
    configurable: true,
  });

  function captureStackTrace(obj: object, fn?: Function) {
    nativeCapture(obj, typeof fn === 'function' ? fn : captureStackTrace);
    const raw = (obj as any).stack;
    if (typeof raw !== 'string') return;
    let value: unknown;
    let done = false;
    defineProperty(obj, 'stack', {
      get() {
        if (!done) {
          done = true;
          value = format(obj, raw);
        }
        return value;
      },
      set(v) {
        done = true;
        value = v;
      },
      enumerable: false,
      configurable: true,
    });
  }
  defineProperty(E, 'captureStackTrace', { value: captureStackTrace, writable: true, enumerable: false, configurable: true });
}
