// Shell arithmetic expansion: $(( ... )).

type Getter = (name: string) => string | undefined;
type Setter = (name: string, value: string) => void;

const TOKEN = /\s*(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*(?:#[0-9a-zA-Z@_]+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*=?|<<=|>>=|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%&|^]=|[-+*/%<>=!~&|^?:(),])/y;

export function evalArith(src: string, get: Getter, set: Setter): number {
  const toks: string[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`syntax error in expression (error token is "${src.slice(pos).trim()}")`);
    toks.push(m[1]);
    pos = TOKEN.lastIndex;
  }
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];

  const isName = (t: string | undefined) => !!t && /^[A-Za-z_]/.test(t);
  const valueOf = (name: string, depth = 0): number => {
    const v = get(name);
    if (v === undefined || v === '') return 0;
    const n = toNumber(v);
    if (Number.isNaN(n)) {
      if (depth < 8 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())) return valueOf(v.trim(), depth + 1);
      return evalArith(v, get, set);
    }
    return n;
  };

  type Ref = { v: number; name?: string };

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
      const nv = valueOf(name) + (t === '++' ? 1 : -1);
      set(name, String(nv));
      return { v: nv };
    }
    if (t === '+' || t === '-' || t === '!' || t === '~') {
      const r = unary();
      if (t === '-') return { v: -r.v };
      if (t === '!') return { v: r.v ? 0 : 1 };
      if (t === '~') return { v: ~r.v };
      return { v: r.v };
    }
    if (isName(t)) {
      if (peek() === '++' || peek() === '--') {
        const op = next();
        const old = valueOf(t);
        set(t, String(old + (op === '++' ? 1 : -1)));
        return { v: old };
      }
      return { v: valueOf(t), name: t };
    }
    const n = toNumber(t);
    if (Number.isNaN(n)) throw new Error(`invalid number: ${t}`);
    return { v: n };
  };
  const unary = primary;

  const BIN: Record<string, [number, (a: number, b: number) => number]> = {
    '**': [14, (a, b) => Math.trunc(a ** b)],
    '*': [13, (a, b) => Math.imul(a, b)],
    '/': [13, (a, b) => {
      if (b === 0) throw new Error('division by 0');
      return Math.trunc(a / b);
    }],
    '%': [13, (a, b) => {
      if (b === 0) throw new Error('division by 0');
      return a % b;
    }],
    '+': [12, (a, b) => a + b],
    '-': [12, (a, b) => a - b],
    '<<': [11, (a, b) => a << b],
    '>>': [11, (a, b) => a >> b],
    '<': [10, (a, b) => +(a < b)],
    '<=': [10, (a, b) => +(a <= b)],
    '>': [10, (a, b) => +(a > b)],
    '>=': [10, (a, b) => +(a >= b)],
    '==': [9, (a, b) => +(a === b)],
    '!=': [9, (a, b) => +(a !== b)],
    '&': [8, (a, b) => a & b],
    '^': [7, (a, b) => a ^ b],
    '|': [6, (a, b) => a | b],
  };

  const binary = (minPrec: number): Ref => {
    let left = unary();
    for (;;) {
      const op = peek();
      if (op === '&&' && minPrec <= 5) {
        next();
        const r = binary(6);
        left = { v: left.v && r.v ? 1 : 0 };
        continue;
      }
      if (op === '||' && minPrec <= 4) {
        next();
        const r = binary(5);
        left = { v: left.v || r.v ? 1 : 0 };
        continue;
      }
      const b = op !== undefined ? BIN[op] : undefined;
      if (!b || b[0] < minPrec) break;
      next();
      const right = binary(op === '**' ? b[0] : b[0] + 1);
      left = { v: b[1](left.v, right.v) };
    }
    return left;
  };

  const ternary = (): Ref => {
    const c = binary(4);
    if (peek() === '?') {
      next();
      const a = assign();
      if (next() !== ':') throw new Error("syntax error: ':' expected");
      const b = assign();
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
      if (op !== '=') {
        const bop = op.slice(0, -1);
        v = BIN[bop][1](valueOf(name), rhs);
      }
      set(name, String(v));
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

  if (toks.length === 0) return 0;
  const r = comma();
  if (i < toks.length) throw new Error(`syntax error in expression (error token is "${toks.slice(i).join(' ')}")`);
  return r.v;
}

function toNumber(t: string): number {
  t = t.trim();
  if (/^-?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^-?0[0-7]+$/.test(t)) return parseInt(t, 8);
  if (/^-?[0-9]+$/.test(t)) return parseInt(t, 10);
  const m = /^([0-9]+)#([0-9a-zA-Z]+)$/.exec(t);
  if (m) return parseInt(m[2], Number(m[1]));
  return NaN;
}
