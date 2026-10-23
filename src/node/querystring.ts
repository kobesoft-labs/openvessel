// node:querystring

export function unescape(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

export function escape(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function parse(str: string, sep = '&', eq = '=', opts: { maxKeys?: number; decodeURIComponent?: (s: string) => string } = {}): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  if (typeof str !== 'string' || str.length === 0) return out;
  const decode = opts.decodeURIComponent ?? unescape;
  const maxKeys = opts.maxKeys ?? 1000;
  let parts = str.split(sep);
  if (maxKeys > 0) parts = parts.slice(0, maxKeys);
  for (const part of parts) {
    if (!part) continue;
    const idx = part.indexOf(eq);
    const k = decode((idx >= 0 ? part.slice(0, idx) : part).replace(/\+/g, ' '));
    const v = idx >= 0 ? decode(part.slice(idx + eq.length).replace(/\+/g, ' ')) : '';
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

function strOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return '';
}

export function stringify(obj: any, sep = '&', eq = '=', opts: { encodeURIComponent?: (s: string) => string } = {}): string {
  if (!obj || typeof obj !== 'object') return '';
  const encode = opts.encodeURIComponent ?? escape;
  const parts: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const ks = encode(strOf(k)) + eq;
    if (Array.isArray(v)) for (const x of v) parts.push(ks + encode(strOf(x)));
    else parts.push(ks + encode(strOf(v)));
  }
  return parts.join(sep);
}

export const decode = parse;
export const encode = stringify;

export default { parse, stringify, decode, encode, escape, unescape };
