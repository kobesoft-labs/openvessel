// Hooks for the vendored Node.js path implementation (node-path.ts).

let cwdProvider: () => string = () => '/';
export function setCwdProvider(fn: () => string) {
  cwdProvider = fn;
}
export const __cwd = () => cwdProvider();
/** win32.resolve looks up per-drive cwds (`=C:`); there are none here. */
export const __env: Record<string, string | undefined> = {};

export function describeReceived(v: unknown): string {
  if (v == null) return ` Received ${v}`;
  if (typeof v === 'function') return ` Received function ${(v as Function).name || '<anonymous>'}`;
  if (typeof v === 'object') {
    const name = (v as object).constructor?.name;
    return name ? ` Received an instance of ${name}` : ` Received ${String(v)}`;
  }
  let shown = typeof v === 'string' ? `'${v.length > 25 ? v.slice(0, 25) + '...' : v}'` : typeof v === 'bigint' ? `${v}n` : String(v);
  return ` Received type ${typeof v} (${shown})`;
}

function invalidArgType(name: string, expected: string, v: unknown): TypeError {
  const e = new TypeError(`The "${name}" argument must be ${expected}.${describeReceived(v)}`) as TypeError & { code: string };
  e.code = 'ERR_INVALID_ARG_TYPE';
  Object.defineProperty(e, 'name', { value: 'TypeError', enumerable: false });
  return e;
}

export function validateString(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string') throw invalidArgType(name, 'of type string', v);
}

export function validateObject(v: unknown, name: string) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw invalidArgType(name, 'of type object', v);
}

/** Minimal glob → RegExp (supports **, *, ?, {a,b}, [abc]). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevSlash = i === 0 || glob[i - 1] === '/';
        i++;
        if (glob[i + 1] === '/' && prevSlash) {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) re += '\\[';
      else {
        let cls = glob.slice(i + 1, close);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if ('.+^$()|\\/'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function __glob(path: string, pattern: string, windows: boolean): boolean {
  if (windows) {
    path = path.replace(/\\/g, '/');
    pattern = pattern.replace(/\\/g, '/');
    return globToRegExp(pattern.toLowerCase()).test(path.toLowerCase());
  }
  return globToRegExp(pattern).test(path);
}
