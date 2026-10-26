// Shell pattern matching. Patterns are strings where a backslash escapes the next char.

const cache = new Map<string, RegExp>();

export function patternToRegexSource(pat: string, opts: { pathname?: boolean } = {}): string {
  let re = '';
  const any = opts.pathname ? '[^/]' : '[\\s\\S]';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') {
      const n = pat[++i] ?? '\\';
      re += escapeRe(n);
    } else if (c === '*') {
      while (pat[i + 1] === '*') i++;
      re += `${any}*`;
    } else if (c === '?') {
      re += any;
    } else if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pat[j] === '!' || pat[j] === '^') {
        neg = true;
        j++;
      }
      let cls = '';
      let first = true;
      while (j < pat.length && (pat[j] !== ']' || first)) {
        first = false;
        const cj = pat[j];
        if (cj === '\\') {
          cls += escapeRe(pat[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (cj === '[' && pat[j + 1] === ':') {
          const end = pat.indexOf(':]', j + 2);
          if (end !== -1) {
            const name = pat.slice(j + 2, end);
            cls += POSIX_CLASSES[name] ?? '';
            j = end + 2;
            continue;
          }
        }
        cls += cj === '^' || cj === '\\' || cj === ']' ? '\\' + cj : cj;
        j++;
      }
      if (j >= pat.length) {
        re += '\\[';
        continue;
      }
      re += `[${neg ? '^' : ''}${cls}]`;
      i = j;
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9a-fA-F',
  word: '\\w',
};

function escapeRe(c: string) {
  return /[\\^$.*+?()[\]{}|/-]/.test(c) ? '\\' + c : c;
}

/**
 * A POSIX extended regular expression (with the GNU \w \W \s \S \b \B \< \> escapes) as JavaScript
 * regex source: bracket expressions with [:class:], a literal backslash inside brackets, `\x` for
 * any other x is that character, and a `{` that doesn't start an interval is literal.
 */
export function eregToRegexSource(re: string): string {
  let out = '';
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') {
      const n = re[++i];
      if (n === undefined) throw new Error('trailing backslash');
      if ('wWsSbB'.includes(n)) out += '\\' + n;
      else if (n === '<') out += '\\b(?=\\w)';
      else if (n === '>') out += '\\b(?<=\\w)';
      else if (/[1-9]/.test(n)) out += '\\' + n;
      else out += escapeRe(n);
    } else if (c === '[') {
      let j = i + 1;
      let cls = '';
      if (re[j] === '^') {
        cls += '^';
        j++;
      }
      // a `]` first in the list is literal
      if (re[j] === ']') {
        cls += '\\]';
        j++;
      }
      for (; j < re.length && re[j] !== ']'; j++) {
        const cj = re[j];
        if (cj === '[' && (re[j + 1] === ':' || re[j + 1] === '=' || re[j + 1] === '.')) {
          const close = re.indexOf(re[j + 1] + ']', j + 2);
          if (close === -1) throw new Error('unterminated bracket expression');
          const name = re.slice(j + 2, close);
          if (re[j + 1] === ':') {
            if (POSIX_CLASSES[name] === undefined) throw new Error(`invalid character class ${name}`);
            cls += POSIX_CLASSES[name];
          } else cls += name.replace(/[\\\]^-]/g, '\\$&');
          j = close + 1;
          continue;
        }
        cls += cj === '\\' || (cj === '^' && cls !== '' && cls !== '^') ? '\\' + cj : cj;
      }
      if (j >= re.length) throw new Error('unterminated bracket expression');
      out += `[${cls}]`;
      i = j;
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(re.slice(i));
      if (m && out !== '') {
        out += m[0];
        i += m[0].length - 1;
      } else out += '\\{';
    } else if (c === '}') out += '\\}';
    else if (c === '/') out += '\\/';
    else out += c;
  }
  return out;
}

export function matchPattern(pat: string, s: string): boolean {
  let re = cache.get(pat);
  if (!re) {
    re = new RegExp(`^${patternToRegexSource(pat)}$`);
    if (cache.size > 500) cache.clear();
    cache.set(pat, re);
  }
  return re.test(s);
}

export function hasGlobChars(pat: string): boolean {
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '*' || c === '?' || c === '[') return true;
  }
  return false;
}

export function unescapePattern(pat: string): string {
  return pat.replace(/\\([\s\S])/g, '$1');
}

/** Removes the shortest/longest prefix or suffix matching `pat`. */
export function removeMatch(s: string, pat: string, op: '#' | '##' | '%' | '%%'): string {
  const src = patternToRegexSource(pat);
  if (op === '#' || op === '##') {
    const re = new RegExp(`^${src}`);
    const lens: number[] = [];
    for (let i = 0; i <= s.length; i++) if (new RegExp(`^(?:${src})$`).test(s.slice(0, i))) lens.push(i);
    void re;
    if (!lens.length) return s;
    return s.slice(op === '#' ? lens[0] : lens[lens.length - 1]);
  }
  const starts: number[] = [];
  for (let i = s.length; i >= 0; i--) if (new RegExp(`^(?:${src})$`).test(s.slice(i))) starts.push(i);
  if (!starts.length) return s;
  return s.slice(0, op === '%' ? starts[0] : starts[starts.length - 1]);
}

export function replaceMatch(s: string, pat: string, rep: string, op: string): string {
  const src = patternToRegexSource(pat);
  if (!src) return s;
  if (op === '/#') return s.replace(new RegExp(`^(?:${src})`), () => rep);
  if (op === '/%') return s.replace(new RegExp(`(?:${src})$`), () => rep);
  // greedy longest match at each position, like bash
  return s.replace(new RegExp(src, op === '//' ? 'g' : ''), () => rep);
}
