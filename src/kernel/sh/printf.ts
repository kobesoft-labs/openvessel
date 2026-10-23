// printf(1) formatting.

function unescape(s: string): { s: string; stop: boolean } {
  let stop = false;
  const out = s.replace(/\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[abcefnrtv\\"'])/g, (_m, e: string) => {
    if (e === 'c') {
      stop = true;
      return '';
    }
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" } as Record<string, string>)[e];
  });
  if (stop) {
    const idx = out.indexOf('\u0000STOP');
    void idx;
  }
  return { s: out, stop };
}

function toNum(a: string | undefined): number {
  if (a === undefined || a === '') return 0;
  if (/^['"]/.test(a)) return a.charCodeAt(1) || 0;
  const n = Number(a.trim());
  if (Number.isNaN(n)) {
    const p = parseFloat(a);
    return Number.isNaN(p) ? 0 : p;
  }
  return n;
}

export function formatPrintf(fmt: string, args: string[]): string {
  let out = '';
  let ai = 0;
  let first = true;
  while (first || (ai < args.length && ai > 0)) {
    first = false;
    const startAi = ai;
    let i = 0;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c === '\\') {
        const m = /^\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[abcefnrtv\\"'])/.exec(fmt.slice(i));
        if (m) {
          const u = unescape(m[0]);
          if (u.stop) return out;
          out += u.s;
          i += m[0].length;
          continue;
        }
        out += c;
        i++;
        continue;
      }
      if (c !== '%') {
        out += c;
        i++;
        continue;
      }
      if (fmt[i + 1] === '%') {
        out += '%';
        i += 2;
        continue;
      }
      const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+))?([diouxXeEfFgGcsbq])/.exec(fmt.slice(i));
      if (!m) {
        out += c;
        i++;
        continue;
      }
      i += m[0].length;
      const flags = m[1];
      let width = m[2] === '*' ? toNum(args[ai++]) : m[2] ? Number(m[2]) : 0;
      let prec: number | undefined = m[3] === '*' ? toNum(args[ai++]) : m[3] !== undefined ? Number(m[3]) : undefined;
      const conv = m[4];
      const arg = args[ai++];
      let s: string;
      switch (conv) {
        case 'd':
        case 'i':
          s = String(Math.trunc(toNum(arg)));
          if (flags.includes('+') && !s.startsWith('-')) s = '+' + s;
          else if (flags.includes(' ') && !s.startsWith('-')) s = ' ' + s;
          break;
        case 'u':
          s = String(Math.abs(Math.trunc(toNum(arg))));
          break;
        case 'o':
          s = Math.trunc(toNum(arg)).toString(8);
          break;
        case 'x':
          s = Math.trunc(toNum(arg)).toString(16);
          if (flags.includes('#') && s !== '0') s = '0x' + s;
          break;
        case 'X':
          s = Math.trunc(toNum(arg)).toString(16).toUpperCase();
          break;
        case 'e':
        case 'E':
          s = toNum(arg).toExponential(prec ?? 6);
          if (conv === 'E') s = s.toUpperCase();
          prec = undefined;
          break;
        case 'f':
        case 'F':
          s = toNum(arg).toFixed(prec ?? 6);
          prec = undefined;
          break;
        case 'g':
        case 'G':
          s = String(Number(toNum(arg).toPrecision(prec || 6)));
          prec = undefined;
          break;
        case 'c':
          s = (arg ?? '').slice(0, 1);
          break;
        case 'b':
          s = unescape(arg ?? '').s;
          break;
        case 'q':
          s = /^[A-Za-z0-9_./=:@%+-]+$/.test(arg ?? '') ? (arg ?? "''") : `'${(arg ?? '').replace(/'/g, "'\\''")}'`;
          break;
        default:
          s = arg ?? '';
      }
      if (prec !== undefined && (conv === 's' || conv === 'b')) s = s.slice(0, prec);
      if (width && s.length < width) {
        if (flags.includes('-')) s = s.padEnd(width);
        else if (flags.includes('0') && /[diouxXeEfFgG]/.test(conv)) {
          const neg = s.startsWith('-') || s.startsWith('+');
          s = neg ? s[0] + s.slice(1).padStart(width - 1, '0') : s.padStart(width, '0');
        } else s = s.padStart(width);
      }
      void width;
      out += s;
    }
    if (ai === startAi) break;
  }
  return out;
}
