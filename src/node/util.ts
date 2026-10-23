// node:util

import { Buffer } from 'buffer';

export const custom = Symbol.for('nodejs.util.inspect.custom');
const kPromisify = Symbol.for('nodejs.util.promisify.custom');

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  showHidden?: boolean;
  compact?: boolean | number;
  breakLength?: number;
  maxArrayLength?: number | null;
  maxStringLength?: number | null;
  sorted?: boolean | ((a: string, b: string) => number);
  getters?: boolean;
  customInspect?: boolean;
  numericSeparator?: boolean;
  stylize?: (s: string, style: string) => string;
}

const STYLES: Record<string, [number, number]> = {
  bold: [1, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  white: [37, 39],
  grey: [90, 39],
  gray: [90, 39],
  black: [30, 39],
  blue: [34, 39],
  cyan: [36, 39],
  green: [32, 39],
  magenta: [35, 39],
  red: [31, 39],
  yellow: [33, 39],
  dim: [2, 22],
  strikethrough: [9, 29],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  bgBlack: [40, 49],
  blackBright: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  reset: [0, 0],
};
const STYLE_FOR: Record<string, string> = {
  special: 'cyan',
  number: 'yellow',
  bigint: 'yellow',
  boolean: 'yellow',
  undefined: 'grey',
  null: 'bold',
  string: 'green',
  symbol: 'green',
  date: 'magenta',
  regexp: 'red',
  module: 'underline',
};

export function inspect(value: unknown, opts?: InspectOptions | boolean, depthArg?: number, colorsArg?: boolean): string {
  let o: InspectOptions;
  if (typeof opts === 'boolean') o = { showHidden: opts, depth: depthArg, colors: colorsArg };
  else o = { ...(opts ?? {}) };
  const ctx = {
    depth: o.depth === undefined ? 2 : o.depth === null ? Infinity : o.depth,
    colors: !!o.colors,
    showHidden: !!o.showHidden,
    breakLength: o.breakLength ?? 80,
    compact: o.compact ?? 3,
    maxArrayLength: o.maxArrayLength === null ? Infinity : (o.maxArrayLength ?? 100),
    maxStringLength: o.maxStringLength === null ? Infinity : (o.maxStringLength ?? 10000),
    sorted: o.sorted,
    customInspect: o.customInspect !== false,
    getters: !!o.getters,
    seen: [] as unknown[],
    circular: new Map<unknown, number>(),
  };
  const stylize = (s: string, type: string) => {
    if (!ctx.colors) return s;
    const st = STYLES[STYLE_FOR[type] ?? type];
    return st ? `\x1b[${st[0]}m${s}\x1b[${st[1]}m` : s;
  };
  return formatValue(value, 0);

  function formatValue(v: unknown, level: number, inObject = false): string {
    if (v === null) return stylize('null', 'null');
    if (v === undefined) return stylize('undefined', 'undefined');
    switch (typeof v) {
      case 'string':
        return stylize(quote(v.length > ctx.maxStringLength ? v.slice(0, ctx.maxStringLength) + `... ${v.length - ctx.maxStringLength} more characters` : v, inObject || level > 0), 'string');
      case 'number':
        return stylize(Object.is(v, -0) ? '-0' : String(v), 'number');
      case 'bigint':
        return stylize(`${v}n`, 'bigint');
      case 'boolean':
        return stylize(String(v), 'boolean');
      case 'symbol':
        return stylize(v.toString(), 'symbol');
      case 'function':
      case 'object':
        break;
      default:
        return String(v);
    }
    const obj = v as any;
    if (ctx.customInspect) {
      const fn = obj[custom];
      if (typeof fn === 'function' && fn !== inspect) {
        const r = fn.call(obj, ctx.depth - level, { ...o, stylize, depth: ctx.depth - level }, inspect);
        if (r !== obj) return typeof r === 'string' ? r : formatValue(r, level);
      }
    }
    if (ctx.seen.includes(obj)) {
      let idx = ctx.circular.get(obj);
      if (idx === undefined) {
        idx = ctx.circular.size + 1;
        ctx.circular.set(obj, idx);
      }
      return stylize(`[Circular *${idx}]`, 'special');
    }
    return formatRaw(obj, level);
  }

  function keysOf(obj: any): (string | symbol)[] {
    let keys: (string | symbol)[] = ctx.showHidden ? Reflect.ownKeys(obj) : Object.keys(obj);
    if (!ctx.showHidden) {
      for (const s of Object.getOwnPropertySymbols(obj)) if (Object.getOwnPropertyDescriptor(obj, s)?.enumerable) keys.push(s);
    }
    if (ctx.sorted) keys = [...keys].sort(typeof ctx.sorted === 'function' ? (ctx.sorted as any) : undefined);
    return keys;
  }

  function formatProp(obj: any, key: string | symbol, level: number, arrayLike: boolean): string {
    const desc = Object.getOwnPropertyDescriptor(obj, key) ?? { value: obj[key as any], enumerable: true };
    let str: string;
    if (desc.get || desc.set) {
      if (desc.get && ctx.getters) {
        try {
          str = `[Getter: ${formatValue(desc.get.call(obj), level + 1, true)}]`;
        } catch (e) {
          str = `[Getter: <Inspection threw (${(e as Error).message})>]`;
        }
      } else str = stylize(desc.get && desc.set ? '[Getter/Setter]' : desc.get ? '[Getter]' : '[Setter]', 'special');
    } else {
      str = formatValue(desc.value, level + 1, true);
    }
    if (arrayLike) return str;
    let name: string;
    if (typeof key === 'symbol') name = `[${stylize(key.toString(), 'symbol')}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) name = key;
    else name = stylize(quote(key, true), 'string');
    if (!desc.enumerable) name = `[${name}]`;
    return `${name}: ${str}`;
  }

  function formatRaw(obj: any, level: number): string {
    let braces: [string, string] = ['{', '}'];
    let prefix = '';
    let entries: string[] = [];
    let keys = keysOf(obj);
    let base = '';
    const ctorName = getCtorName(obj);
    const tag = obj[Symbol.toStringTag];

    if (typeof obj === 'function') {
      const name = obj.name ? `: ${obj.name}` : ' (anonymous)';
      const isClass = Function.prototype.toString.call(obj).startsWith('class');
      base = stylize(`[${isClass ? 'class' : obj.constructor?.name === 'AsyncFunction' ? 'AsyncFunction' : obj.constructor?.name === 'GeneratorFunction' ? 'GeneratorFunction' : 'Function'}${name}]`, 'special');
      keys = keys.filter((k) => k !== 'prototype');
      if (!keys.length) return base;
    } else if (obj instanceof RegExp) {
      base = stylize(RegExp.prototype.toString.call(obj), 'regexp');
      if (!keys.length) return base;
    } else if (obj instanceof Date) {
      base = stylize(isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString(), 'date');
      if (!keys.length) return base;
    } else if (obj instanceof Error) {
      base = formatError(obj);
      keys = keys.filter((k) => k !== 'stack' && k !== 'message');
      if (!keys.length) return base;
    } else if (Array.isArray(obj)) {
      braces = ['[', ']'];
      if (ctorName !== 'Array') prefix = `${ctorName}(${obj.length}) `;
    } else if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      braces = ['[', ']'];
      prefix = `${ctorName}(${(obj as any).length}) `;
    } else if (obj instanceof Map) {
      prefix = `Map(${obj.size}) `;
    } else if (obj instanceof Set) {
      prefix = `Set(${obj.size}) `;
    } else if (obj instanceof Promise) {
      prefix = 'Promise ';
    } else if (obj instanceof WeakMap || obj instanceof WeakSet) {
      return `${ctorName} { ${stylize('<items unknown>', 'special')} }`;
    } else if (obj instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && obj instanceof SharedArrayBuffer)) {
      const bytes = new Uint8Array(obj as ArrayBuffer);
      const hex = [...bytes.subarray(0, 50)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `${ctorName} { [Uint8Contents]: <${hex}${bytes.length > 50 ? ` ... ${bytes.length - 50} more bytes` : ''}>, byteLength: ${bytes.length} }`;
    } else if (typeof obj[Symbol.iterator] === 'function' && /Iterator$/.test(tag ?? '')) {
      return `Object [${tag}] {}`;
    } else {
      if (ctorName === null) prefix = '[Object: null prototype] ';
      else if (ctorName !== 'Object') prefix = `${ctorName} `;
      if (tag && tag !== ctorName) prefix = `${ctorName ?? 'Object'} [${tag}] `;
      if (obj instanceof Number || obj instanceof String || obj instanceof Boolean) {
        base = `[${ctorName}: ${formatValue(obj.valueOf(), level)}]`;
        if (obj instanceof String) keys = keys.filter((k) => !/^\d+$/.test(String(k)) && k !== 'length');
        if (!keys.length) return base;
      }
    }

    if (level > ctx.depth) {
      if (Array.isArray(obj)) return stylize('[Array]', 'special');
      return stylize(`[${ctorName ?? 'Object'}]`, 'special');
    }

    ctx.seen.push(obj);
    try {
      if (Array.isArray(obj) || (ArrayBuffer.isView(obj) && !(obj instanceof DataView))) {
        const arr = obj as any;
        const n = Math.min(arr.length, ctx.maxArrayLength);
        let holes = 0;
        for (let i = 0; i < n; i++) {
          if (Array.isArray(arr) && !Object.prototype.hasOwnProperty.call(arr, i)) {
            holes++;
            continue;
          }
          if (holes) {
            entries.push(stylize(`<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'));
            holes = 0;
          }
          entries.push(formatValue(arr[i], level + 1, true));
        }
        if (holes) entries.push(stylize(`<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'));
        if (arr.length > n) entries.push(`... ${arr.length - n} more item${arr.length - n > 1 ? 's' : ''}`);
        keys = keys.filter((k) => typeof k === 'symbol' || !/^\d+$/.test(k));
        if (ArrayBuffer.isView(obj)) keys = keys.filter((k) => k !== 'length');
      } else if (obj instanceof Map) {
        let i = 0;
        for (const [k, val] of obj) {
          if (i++ >= ctx.maxArrayLength) {
            entries.push(`... ${obj.size - ctx.maxArrayLength} more items`);
            break;
          }
          entries.push(`${formatValue(k, level + 1, true)} => ${formatValue(val, level + 1, true)}`);
        }
      } else if (obj instanceof Set) {
        let i = 0;
        for (const val of obj) {
          if (i++ >= ctx.maxArrayLength) {
            entries.push(`... ${obj.size - ctx.maxArrayLength} more items`);
            break;
          }
          entries.push(formatValue(val, level + 1, true));
        }
      } else if (obj instanceof Promise) {
        entries.push(stylize('<pending>', 'special'));
      }
      for (const k of keys) entries.push(formatProp(obj, k, level, false));
    } finally {
      ctx.seen.pop();
    }
    const idx = ctx.circular.get(obj);
    if (idx !== undefined) prefix = stylize(`<ref *${idx}>`, 'special') + ' ' + prefix;
    if (base) {
      if (!entries.length) return base;
      return `${prefix}${base} ${braces[0]} ${entries.join(', ')} ${braces[1]}`;
    }
    if (!entries.length) {
      if (obj instanceof Map || obj instanceof Set) return `${prefix}{}`;
      return `${prefix}${braces[0]}${braces[1]}`;
    }
    const start = prefix + braces[0];
    const totalLen = entries.reduce((a, e) => a + e.length + 2, start.length);
    const multiline = entries.some((e) => e.includes('\n'));
    if (ctx.compact !== false && !multiline && totalLen + level * 2 <= ctx.breakLength) {
      return `${start} ${entries.join(', ')} ${braces[1]}`;
    }
    // group short array items in columns like node
    const indent = '  '.repeat(level + 1);
    if (braces[0] === '[' && entries.length > 6 && entries.every((e) => e.length <= 16 && !e.includes('\n'))) {
      const width = Math.max(...entries.map((e) => stripVTControlCharacters(e).length)) + 2;
      const cols = Math.max(1, Math.min(16, Math.floor((ctx.breakLength - indent.length) / width), Math.round(Math.sqrt(2.5 * width * entries.length) / width)));
      const rows: string[] = [];
      for (let i = 0; i < entries.length; i += cols) rows.push(entries.slice(i, i + cols).map((e, j, a) => (j < a.length - 1 ? (e + ',').padEnd(width) : e)).join(''));
      return `${start}\n${indent}${rows.join(',\n' + indent)}\n${'  '.repeat(level)}${braces[1]}`;
    }
    return `${start}\n${indent}${entries.join(`,\n${indent}`)}\n${'  '.repeat(level)}${braces[1]}`;
  }

  function formatError(err: Error): string {
    let stack = err.stack || `${err.name}: ${err.message}`;
    if (!stack.includes(err.message) && err.message) stack = `${err.name}: ${err.message}\n${stack}`;
    const cause = (err as any).cause;
    if (cause !== undefined && !ctx.seen.includes(cause)) {
      ctx.seen.push(err);
      stack += `\n  [cause]: ${formatValue(cause, 1, true)}`;
      ctx.seen.pop();
    }
    if (err instanceof AggregateError && err.errors?.length) {
      stack += ` {\n  [errors]: ${formatValue(err.errors, 1, true)}\n}`;
    }
    return stack;
  }
}

inspect.custom = custom;
inspect.defaultOptions = { depth: 2, colors: false } as InspectOptions;
inspect.colors = Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v]));
inspect.styles = { ...STYLE_FOR };

function quote(s: string, quoted: boolean): string {
  if (!quoted) return s;
  let q = "'";
  if (s.includes("'")) q = !s.includes('"') ? '"' : !s.includes('`') && !s.includes('${') ? '`' : "'";
  const esc = s.replace(/[\\\n\t\r\b\f\v\x00-\x1f\x7f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '\n':
        return '\\n';
      case '\t':
        return '\\t';
      case '\r':
        return '\\r';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\v':
        return '\\v';
      default:
        return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
    }
  });
  return q + (q === "'" ? esc.replace(/'/g, "\\'") : esc) + q;
}

function getCtorName(obj: any): string | null {
  let o = obj;
  const seen = new Set();
  while (o && !seen.has(o)) {
    seen.add(o);
    const d = Object.getOwnPropertyDescriptor(o, 'constructor');
    if (d && typeof d.value === 'function' && d.value.name) return d.value.name;
    o = Object.getPrototypeOf(o);
  }
  return o === null && Object.getPrototypeOf(obj) === null ? null : 'Object';
}

export function format(fmt?: unknown, ...args: unknown[]): string {
  return formatWithOptions({}, fmt, ...args);
}

export function formatWithOptions(opts: InspectOptions, fmt?: unknown, ...args: unknown[]): string {
  if (typeof fmt !== 'string') {
    return [fmt, ...args].map((a) => (typeof a === 'string' ? a : inspect(a, { ...opts, depth: opts.depth ?? 2 }))).join(' ');
  }
  let i = 0;
  let out = '';
  let last = 0;
  for (let j = 0; j < fmt.length - 1; j++) {
    if (fmt[j] !== '%') continue;
    const c = fmt[j + 1];
    if (c === '%') {
      out += fmt.slice(last, j) + '%';
      last = j + 2;
      j++;
      continue;
    }
    if (i >= args.length) continue;
    let rep: string | null = null;
    const a = args[i];
    switch (c) {
      case 's':
        rep = typeof a === 'string' ? a : typeof a === 'bigint' ? `${a}n` : typeof a === 'object' && a !== null ? inspect(a, { ...opts, depth: 0 }) : String(a);
        break;
      case 'd':
      case 'i':
        rep = typeof a === 'bigint' ? `${a}n` : typeof a === 'object' && a !== null ? 'NaN' : String(c === 'i' ? parseInt(String(a)) : Number(a));
        break;
      case 'f':
        rep = String(parseFloat(String(a)));
        break;
      case 'j':
        try {
          rep = JSON.stringify(a);
        } catch {
          rep = '[Circular]';
        }
        break;
      case 'o':
        rep = inspect(a, { ...opts, showHidden: true, depth: 4 });
        break;
      case 'O':
        rep = inspect(a, opts);
        break;
      case 'c':
        rep = '';
        break;
    }
    if (rep === null) continue;
    out += fmt.slice(last, j) + rep;
    last = j + 2;
    j++;
    i++;
  }
  out += fmt.slice(last);
  for (; i < args.length; i++) {
    const a = args[i];
    out += ' ' + (typeof a === 'string' ? a : inspect(a, opts));
  }
  return out;
}

export function inherits(ctor: any, superCtor: any) {
  if (ctor === undefined || ctor === null) throw new TypeError('The "ctor" argument must be of type function');
  if (superCtor === undefined || superCtor === null) throw new TypeError('The "superCtor" argument must be of type function');
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export function promisify(fn: any): any {
  if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type Function');
  if (fn[kPromisify]) {
    const f = fn[kPromisify];
    return f;
  }
  const customArgs: string[] | undefined = fn[Symbol.for('nodejs.util.promisify.customArgs')];
  function promisified(this: unknown, ...args: any[]) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err: any, ...values: any[]) => {
        if (err) return reject(err);
        if (customArgs && values.length > 1) {
          const obj: any = {};
          customArgs.forEach((k, i) => (obj[k] = values[i]));
          resolve(obj);
        } else resolve(values[0]);
      });
    });
  }
  Object.setPrototypeOf(promisified, Object.getPrototypeOf(fn));
  Object.defineProperty(promisified, kPromisify, { value: promisified });
  return Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(fn));
}
promisify.custom = kPromisify;

export function callbackify(fn: (...a: any[]) => Promise<any>) {
  return function (this: unknown, ...args: any[]) {
    const cb = args.pop();
    fn.apply(this, args).then(
      (v) => queueMicrotask(() => cb(null, v)),
      (e) => queueMicrotask(() => cb(e ?? new Error('Promise was rejected with a falsy value'))),
    );
  };
}

const warned = new Set<string>();
export function deprecate<T extends (...a: any[]) => any>(fn: T, msg: string, code?: string): T {
  return function (this: unknown, ...args: any[]) {
    const key = code ?? msg;
    if (!warned.has(key)) {
      warned.add(key);
      (globalThis as any).process?.emitWarning?.(msg, 'DeprecationWarning', code);
    }
    return fn.apply(this, args);
  } as T;
}

const debugEnv = () => String((globalThis as any).process?.env?.NODE_DEBUG ?? '');
export function debuglog(section: string, cb?: (fn: any) => void) {
  let enabled: boolean | undefined;
  const fn: any = (...args: any[]) => {
    if (enabled === undefined) {
      const env = debugEnv();
      enabled = env.split(/[\s,]+/).some((s) => s === '*' || s.toLowerCase() === section.toLowerCase() || (s.endsWith('*') && section.toLowerCase().startsWith(s.slice(0, -1).toLowerCase())));
    }
    if (enabled) (globalThis as any).process?.stderr?.write(`${section.toUpperCase()} ${(globalThis as any).process?.pid}: ${format(...args)}\n`);
  };
  Object.defineProperty(fn, 'enabled', { get: () => debugEnv().includes(section) });
  cb?.(fn);
  return fn;
}
export const debug = debuglog;

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a, b, true, new Map());
}

export function deepEqual(a: any, b: any, strict: boolean, memo: Map<any, any>): boolean {
  if (strict ? Object.is(a, b) : a == b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ta = Object.prototype.toString.call(a);
  if (ta !== Object.prototype.toString.call(b)) return false;
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (a instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
  if (ArrayBuffer.isView(a)) {
    if ((a as any).length !== (b as any).length || a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  if (memo.get(a) === b) return true;
  memo.set(a, b);
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k), strict, memo)) return false;
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    outer: for (const v of a) {
      if (b.has(v)) continue;
      if (typeof v === 'object') for (const w of b) if (deepEqual(v, w, strict, memo)) continue outer;
      return false;
    }
    return true;
  }
  if (a instanceof Number || a instanceof String || a instanceof Boolean) {
    if (!Object.is(a.valueOf(), b.valueOf())) return false;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k], strict, memo)) return false;
  }
  if (strict) {
    const sa = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s));
    const sb = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s));
    if (sa.length !== sb.length) return false;
    for (const s of sa) if (!deepEqual(a[s], b[s], strict, memo)) return false;
  }
  return true;
}

export function stripVTControlCharacters(s: string): string {
  return s.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

export function styleText(format: string | string[], text: string, opts?: { validateStream?: boolean; stream?: any }): string {
  const formats = Array.isArray(format) ? format : [format];
  const stream = opts?.stream ?? (globalThis as any).process?.stdout;
  if (opts?.validateStream !== false && stream && !stream.isTTY && !(globalThis as any).process?.env?.FORCE_COLOR) return text;
  let out = text;
  for (const f of formats) {
    const st = STYLES[f];
    if (!st) {
      const e = new TypeError(`The argument 'format' must be one of: ${Object.keys(STYLES).join(', ')}. Received '${f}'`) as TypeError & { code: string };
      e.code = 'ERR_INVALID_ARG_VALUE';
      throw e;
    }
    out = `\x1b[${st[0]}m${out}\x1b[${st[1]}m`;
  }
  return out;
}

export function toUSVString(s: string) {
  return String(s).toWellFormed?.() ?? s;
}

export function getSystemErrorName(n: number) {
  const names: Record<number, string> = { [-2]: 'ENOENT', [-13]: 'EACCES', [-17]: 'EEXIST', [-20]: 'ENOTDIR', [-21]: 'EISDIR', [-22]: 'EINVAL', [-39]: 'ENOTEMPTY', [-98]: 'EADDRINUSE', [-111]: 'ECONNREFUSED' };
  return names[n] ?? `Unknown system error ${n}`;
}

export function getSystemErrorMap() {
  return new Map([[-2, ['ENOENT', 'no such file or directory']]]);
}

export function aborted(signal: AbortSignal, _resource: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export function parseArgs(config: { args?: string[]; options?: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: unknown }>; strict?: boolean; allowPositionals?: boolean; tokens?: boolean; allowNegative?: boolean } = {}) {
  const args = config.args ?? (globalThis as any).process?.argv?.slice(2) ?? [];
  const options = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const values: Record<string, any> = Object.create(null);
  const positionals: string[] = [];
  const tokens: any[] = [];
  const shortMap: Record<string, string> = {};
  for (const [name, o] of Object.entries(options)) if (o.short) shortMap[o.short] = name;
  const store = (name: string, value: any, index: number, raw: string, inline?: boolean) => {
    const o = options[name];
    if (!o && strict) {
      const e = new TypeError(`Unknown option '${raw}'`) as TypeError & { code: string };
      e.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
      throw e;
    }
    if (o?.multiple) (values[name] ??= []).push(value);
    else values[name] = value;
    tokens.push({ kind: 'option', name, rawName: raw, index, value: o?.type === 'string' ? value : undefined, inlineValue: inline });
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (config.allowNegative && name.startsWith('no-') && options[name.slice(3)]?.type === 'boolean') {
        store(name.slice(3), false, i, a);
        continue;
      }
      const o = options[name];
      if (o?.type === 'string') store(name, eq === -1 ? args[++i] : a.slice(eq + 1), i, `--${name}`, eq !== -1);
      else store(name, eq === -1 ? true : a.slice(eq + 1), i, `--${name}`);
      void name;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const name = shortMap[a[j]] ?? a[j];
        const o = options[name];
        if (o?.type === 'string') {
          store(name, a.slice(j + 1) || args[++i], i, `-${a[j]}`);
          break;
        }
        store(name, true, i, `-${a[j]}`);
      }
      continue;
    }
    if (!allowPositionals && strict) {
      const e = new TypeError(`Unexpected argument '${a}'. This command does not take positional arguments`) as TypeError & { code: string };
      e.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
      throw e;
    }
    positionals.push(a);
    tokens.push({ kind: 'positional', index: i, value: a });
  }
  for (const [name, o] of Object.entries(options)) if (values[name] === undefined && o.default !== undefined) values[name] = o.default;
  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}

export function getCallSite() {
  return [];
}
export const getCallSites = getCallSite;

export class MIMEType {
  type: string;
  subtype: string;
  params: URLSearchParams;
  constructor(s: string) {
    const [main, ...rest] = String(s).split(';');
    const [t, st] = main.trim().toLowerCase().split('/');
    this.type = t;
    this.subtype = st ?? '';
    this.params = new URLSearchParams(rest.map((r) => r.trim()).join('&'));
  }
  get essence() {
    return `${this.type}/${this.subtype}`;
  }
  toString() {
    const p = [...this.params].map(([k, v]) => `;${k}=${v}`).join('');
    return this.essence + p;
  }
}

// -----------------------------------------------------------------------------
// util.types

const toStr = (v: unknown) => Object.prototype.toString.call(v);
export const types = {
  isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v: unknown) => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isArgumentsObject: (v: unknown) => toStr(v) === '[object Arguments]',
  isAsyncFunction: (v: unknown) => typeof v === 'function' && toStr(v) === '[object AsyncFunction]',
  isGeneratorFunction: (v: unknown) => typeof v === 'function' && /GeneratorFunction\]$/.test(toStr(v)),
  isGeneratorObject: (v: unknown) => toStr(v) === '[object Generator]',
  isBigInt64Array: (v: unknown) => v instanceof BigInt64Array,
  isBigUint64Array: (v: unknown) => v instanceof BigUint64Array,
  isBooleanObject: (v: unknown) => v instanceof Boolean,
  isNumberObject: (v: unknown) => v instanceof Number,
  isStringObject: (v: unknown) => v instanceof String,
  isSymbolObject: (v: unknown) => typeof v === 'object' && toStr(v) === '[object Symbol]',
  isBigIntObject: (v: unknown) => typeof v === 'object' && toStr(v) === '[object BigInt]',
  isBoxedPrimitive: (v: unknown) => v instanceof Boolean || v instanceof Number || v instanceof String || (typeof v === 'object' && /\[object (Symbol|BigInt)\]/.test(toStr(v))),
  isDataView: (v: unknown) => v instanceof DataView,
  isDate: (v: unknown) => v instanceof Date,
  isExternal: (_v: unknown) => false,
  isFloat32Array: (v: unknown) => v instanceof Float32Array,
  isFloat64Array: (v: unknown) => v instanceof Float64Array,
  isInt8Array: (v: unknown) => v instanceof Int8Array,
  isInt16Array: (v: unknown) => v instanceof Int16Array,
  isInt32Array: (v: unknown) => v instanceof Int32Array,
  isMap: (v: unknown) => v instanceof Map,
  isMapIterator: (v: unknown) => toStr(v) === '[object Map Iterator]',
  isModuleNamespaceObject: (v: unknown) => !!v && typeof v === 'object' && (v as any)[Symbol.toStringTag] === 'Module',
  isNativeError: (v: unknown) => v instanceof Error,
  isPromise: (v: unknown) => v instanceof Promise,
  isProxy: (_v: unknown) => false,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isSet: (v: unknown) => v instanceof Set,
  isSetIterator: (v: unknown) => toStr(v) === '[object Set Iterator]',
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isUint8ClampedArray: (v: unknown) => v instanceof Uint8ClampedArray,
  isUint16Array: (v: unknown) => v instanceof Uint16Array,
  isUint32Array: (v: unknown) => v instanceof Uint32Array,
  isWeakMap: (v: unknown) => v instanceof WeakMap,
  isWeakSet: (v: unknown) => v instanceof WeakSet,
  isKeyObject: (v: unknown) => !!v && (v as any)[Symbol.toStringTag] === 'KeyObject',
  isCryptoKey: (v: unknown) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey,
};

// legacy helpers
export const isArray = Array.isArray;
export const isBoolean = (v: unknown) => typeof v === 'boolean';
export const isNull = (v: unknown) => v === null;
export const isNullOrUndefined = (v: unknown) => v == null;
export const isNumber = (v: unknown) => typeof v === 'number';
export const isString = (v: unknown) => typeof v === 'string';
export const isSymbol = (v: unknown) => typeof v === 'symbol';
export const isUndefined = (v: unknown) => v === undefined;
export const isRegExp = types.isRegExp;
export const isObject = (v: unknown) => v !== null && typeof v === 'object';
export const isDate = types.isDate;
export const isError = (v: unknown) => v instanceof Error;
export const isFunction = (v: unknown) => typeof v === 'function';
export const isPrimitive = (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function');
export const isBuffer = (v: unknown) => Buffer.isBuffer(v);

export function _extend(target: any, source: any) {
  return Object.assign(target, source);
}

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

export default {
  inspect, format, formatWithOptions, inherits, promisify, callbackify, deprecate, debuglog, debug, isDeepStrictEqual, stripVTControlCharacters, styleText, toUSVString,
  getSystemErrorName, getSystemErrorMap, aborted, parseArgs, getCallSite, getCallSites, MIMEType, MIMEParams: URLSearchParams, types, TextEncoder, TextDecoder,
  isArray, isBoolean, isNull, isNullOrUndefined, isNumber, isString, isSymbol, isUndefined, isRegExp, isObject, isDate, isError, isFunction, isPrimitive, isBuffer, _extend,
};
