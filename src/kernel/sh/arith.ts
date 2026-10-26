// Shell arithmetic expansion: $(( ... )). Values are 64-bit signed integers that wrap on
// overflow, like bash's intmax_t arithmetic.

type Getter = (name: string) => string | undefined;
type Setter = (name: string, value: string) => void;

const TOKEN = /\s*([0-9][0-9a-zA-Z@_]*(?:#[0-9a-zA-Z@_]+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*=?|<<=|>>=|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%&|^]=|[-+*/%<>=!~&|^?:(),])/y;

/** Wraps to a 64-bit signed integer. */
const wrap = (v: bigint) => BigInt.asIntN(64, v);

export function evalArith(src: string, get: Getter, set: Setter): bigint {
  const toks: string[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`syntax error: invalid arithmetic operator (error token is "${src.slice(pos).trim()}")`);
    toks.push(m[1]);
    pos = TOKEN.lastIndex;
  }
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  // && || and ?: don't evaluate (or assign in) the side that isn't taken
  let skip = 0;

  const isName = (t: string | undefined) => !!t && /^[A-Za-z_]/.test(t);
  const valueOf = (name: string, depth = 0): bigint => {
    if (skip) return 0n;
    const v = get(name);
    if (v === undefined || v.trim() === '') return 0n;
    const t = v.trim();
    if (/^[-+]?[0-9]/.test(t) && /^[-+]?[0-9][0-9a-zA-Z@_#]*$/.test(t)) {
      const neg = t.startsWith('-');
      const n = toNumber(t.replace(/^[-+]/, ''));
      return wrap(neg ? -n : n);
    }
    if (depth < 8 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return valueOf(t, depth + 1);
    return evalArith(v, get, set);
  };
  const assignVar = (name: string, v: bigint) => {
    if (!skip) set(name, String(v));
  };

  type Ref = { v: bigint; name?: string };

  const primary = (): Ref => {
    const t = next();
    if (t === undefined) throw new Error('syntax error: operand expected');
    if (t === '(') {
      const v = comma();
      if (next() !== ')') throw new Error("syntax error: ')' expected");
      return { v: v.v };
    }
    if (t === '++' || t === '--') {
      const name = next();
      if (!isName(name)) throw new Error('syntax error: variable expected');
      const nv = wrap(valueOf(name) + (t === '++' ? 1n : -1n));
      assignVar(name, nv);
      return { v: nv };
    }
    if (t === '+' || t === '-' || t === '!' || t === '~') {
      const r = unary();
      if (t === '-') return { v: wrap(-r.v) };
      if (t === '!') return { v: r.v ? 0n : 1n };
      if (t === '~') return { v: ~r.v };
      return { v: r.v };
    }
    if (isName(t)) {
      if (peek() === '++' || peek() === '--') {
        const op = next();
        const old = valueOf(t);
        assignVar(t, wrap(old + (op === '++' ? 1n : -1n)));
        return { v: old };
      }
      return { v: valueOf(t), name: t };
    }
    return { v: toNumber(t) };
  };
  const unary = primary;

  const BIN: Record<string, [number, (a: bigint, b: bigint) => bigint]> = {
    '**': [14, (a, b) => {
      if (b < 0n) throw new Error('exponent less than 0');
      // square-and-multiply, wrapping at each step
      let r = 1n;
      let base = a;
      let e = b;
      while (e > 0n) {
        if (e & 1n) r = wrap(r * base);
        base = wrap(base * base);
        e >>= 1n;
      }
      return r;
    }],
    '*': [13, (a, b) => wrap(a * b)],
    '/': [13, (a, b) => {
      if (b === 0n) throw new Error('division by 0');
      return wrap(a / b);
    }],
    '%': [13, (a, b) => {
      if (b === 0n) throw new Error('division by 0');
      return wrap(a % b);
    }],
    '+': [12, (a, b) => wrap(a + b)],
    '-': [12, (a, b) => wrap(a - b)],
    // the shift count is taken modulo 64, as the x86-64 build of bash does
    '<<': [11, (a, b) => wrap(a << BigInt.asUintN(6, b))],
    '>>': [11, (a, b) => a >> BigInt.asUintN(6, b)],
    '<': [10, (a, b) => (a < b ? 1n : 0n)],
    '<=': [10, (a, b) => (a <= b ? 1n : 0n)],
    '>': [10, (a, b) => (a > b ? 1n : 0n)],
    '>=': [10, (a, b) => (a >= b ? 1n : 0n)],
    '==': [9, (a, b) => (a === b ? 1n : 0n)],
    '!=': [9, (a, b) => (a !== b ? 1n : 0n)],
    '&': [8, (a, b) => a & b],
    '^': [7, (a, b) => a ^ b],
    '|': [6, (a, b) => a | b],
  };
  const apply = (op: string, a: bigint, b: bigint) => {
    // a skipped branch must not fail on division by zero
    if (skip && (op === '/' || op === '%' || op === '**')) return 0n;
    return BIN[op][1](a, b);
  };

  const binary = (minPrec: number): Ref => {
    let left = unary();
    for (;;) {
      const op = peek();
      if (op === '&&' && minPrec <= 5) {
        next();
        if (!left.v) skip++;
        const r = binary(6);
        if (!left.v) skip--;
        left = { v: left.v && r.v ? 1n : 0n };
        continue;
      }
      if (op === '||' && minPrec <= 4) {
        next();
        if (left.v) skip++;
        const r = binary(5);
        if (left.v) skip--;
        left = { v: left.v || r.v ? 1n : 0n };
        continue;
      }
      const b = op !== undefined ? BIN[op] : undefined;
      if (!b || b[0] < minPrec) break;
      next();
      const right = binary(op === '**' ? b[0] : b[0] + 1);
      left = { v: apply(op!, left.v, right.v) };
    }
    return left;
  };

  const ternary = (): Ref => {
    const c = binary(4);
    if (peek() === '?') {
      next();
      if (!c.v) skip++;
      const a = assign();
      if (!c.v) skip--;
      if (next() !== ':') throw new Error("syntax error: ':' expected");
      if (c.v) skip++;
      const b = ternary();
      if (c.v) skip--;
      return c.v ? a : b;
    }
    return c;
  };

  const assign = (): Ref => {
    if (isName(toks[i]) && toks[i + 1] && /^([-+*/%&|^]|<<|>>|\*\*)?=$/.test(toks[i + 1]) && toks[i + 1] !== '==') {
      const name = next();
      const op = next();
      const rhs = assign().v;
      let v = rhs;
      if (op !== '=') v = apply(op.slice(0, -1), valueOf(name), rhs);
      assignVar(name, v);
      return { v };
    }
    return ternary();
  };

  const comma = (): Ref => {
    let r = assign();
    while (peek() === ',') {
      next();
      r = assign();
    }
    return r;
  };

  if (toks.length === 0) return 0n;
  const r = comma();
  if (i < toks.length) throw new Error(`syntax error in expression (error token is "${toks.slice(i).join(' ')}")`);
  return r.v;
}

/** An integer constant: decimal, 0octal, 0xhex or base#digits (bases 2 to 64). */
function toNumber(t: string): bigint {
  let base = 10;
  let digits = t;
  const hash = t.indexOf('#');
  if (hash !== -1) {
    base = Number(t.slice(0, hash));
    digits = t.slice(hash + 1);
    if (!/^[0-9]+$/.test(t.slice(0, hash)) || base < 2 || base > 64) throw new Error(`invalid arithmetic base (error token is "${t}")`);
  } else if (/^0[xX]/.test(t)) {
    base = 16;
    digits = t.slice(2);
  } else if (t.length > 1 && t[0] === '0') {
    base = 8;
    digits = t.slice(1);
  }
  if (!digits) throw new Error(`invalid number (error token is "${t}")`);
  let v = 0n;
  const b = BigInt(base);
  for (const c of digits) {
    let d: number;
    if (c >= '0' && c <= '9') d = c.charCodeAt(0) - 48;
    else if (c >= 'a' && c <= 'z') d = c.charCodeAt(0) - 97 + 10;
    else if (c >= 'A' && c <= 'Z') d = c.charCodeAt(0) - 65 + (base <= 36 ? 10 : 36);
    else if (c === '@') d = 62;
    else if (c === '_') d = 63;
    else d = 99;
    if (d >= base) throw new Error(`value too great for base (error token is "${t}")`);
    v = BigInt.asIntN(64, v * b + BigInt(d));
  }
  return v;
}
