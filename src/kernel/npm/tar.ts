// gzip + tar (ustar/pax/gnu) extraction for npm tarballs.

export interface TarEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  mode: number;
  data: Uint8Array;
  linkname: string;
  mtime: number;
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const dec = new TextDecoder();

function str(b: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(off, end));
}

function octal(b: Uint8Array, off: number, len: number): number {
  // GNU base-256 encoding for large values
  if (b[off] & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i];
    return v;
  }
  const s = str(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(dec.decode(data.subarray(i, sp)), 10);
    if (!len) break;
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function untar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let paxNext: Record<string, string> | null = null;
  let paxGlobal: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let name = str(h, 0, 100);
    const mode = octal(h, 100, 8);
    const size = octal(h, 124, 12);
    const mtime = octal(h, 136, 12);
    const typeflag = String.fromCharCode(h[156] || 48);
    let linkname = str(h, 157, 100);
    const magic = str(h, 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = str(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === 'x') {
      paxNext = parsePax(data);
      continue;
    }
    if (typeflag === 'g') {
      paxGlobal = { ...paxGlobal, ...parsePax(data) };
      continue;
    }
    if (typeflag === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (typeflag === 'K') {
      longLink = str(data, 0, data.length);
      continue;
    }
    const pax = { ...paxGlobal, ...(paxNext ?? {}) };
    if (pax.path) name = pax.path;
    if (pax.linkpath) linkname = pax.linkpath;
    if (longName) name = longName;
    if (longLink) linkname = longLink;
    paxNext = null;
    longName = null;
    longLink = null;
    const type = typeflag === '0' || typeflag === '\0' || typeflag === '7' ? 'file' : typeflag === '5' ? 'dir' : typeflag === '2' ? 'symlink' : typeflag === '1' ? 'hardlink' : 'other';
    out.push({ path: name, type, mode, data, linkname, mtime });
  }
  return out;
}
