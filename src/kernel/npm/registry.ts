// npm registry access from the kernel (through the runtime's network proxy).

import { gunzip, untar, type TarEntry } from './tar.ts';

export interface PackageVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  directories?: { bin?: string };
  os?: string[];
  cpu?: string[];
  libc?: string[];
  engines?: Record<string, string>;
  deprecated?: string;
  hasInstallScript?: boolean;
  scripts?: Record<string, string>;
  dist: { tarball: string; integrity?: string; shasum?: string; fileCount?: number; unpackedSize?: number };
  [k: string]: unknown;
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackageVersion>;
  time?: Record<string, string>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetch through the runtime service worker's policy-checked proxy. */
export function proxiedFetch(origin: string): FetchFn {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const pairs: [string, string][] = [...headers];
    const res = await fetch(`${origin}/__ov/net?url=${encodeURIComponent(url)}`, {
      method: init.method === 'GET' || !init.method || init.method === 'HEAD' ? (init.method ?? 'GET') : 'POST',
      headers: { 'x-ov-h': encodeURIComponent(JSON.stringify(pairs)), 'x-ov-by': encodeURIComponent('npm'), 'x-ov-method': init.method ?? 'GET' },
      body: init.body,
      signal: init.signal,
    });
    const err = res.headers.get('x-ov-error');
    if (err) {
      const msg = decodeURIComponent(res.headers.get('x-ov-message') ?? err);
      throw Object.assign(new Error(msg), { code: err === 'denied' ? 'EACCES' : 'ECONNREFUSED' });
    }
    const status = Number(res.headers.get('x-ov-status') ?? res.status);
    return new Response(res.body, { status, statusText: res.statusText, headers: res.headers });
  };
}

export class Registry {
  private packuments = new Map<string, Promise<Packument>>();
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(
    private fetchFn: FetchFn,
    public registryUrl = 'https://registry.npmjs.org/',
    public scopes: Record<string, string> = {},
    private cacheName = 'openvessel-npm-v1',
    private maxConcurrency = 16,
  ) {
    if (!this.registryUrl.endsWith('/')) this.registryUrl += '/';
  }

  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  registryFor(name: string) {
    if (name.startsWith('@')) {
      const scope = name.split('/')[0];
      const r = this.scopes[scope];
      if (r) return r.endsWith('/') ? r : r + '/';
    }
    return this.registryUrl;
  }

  packument(name: string): Promise<Packument> {
    let p = this.packuments.get(name);
    if (!p) {
      p = this.limit(() => this.fetchPackument(name));
      this.packuments.set(name, p);
      p.catch(() => this.packuments.delete(name));
    }
    return p;
  }

  private async fetchPackument(name: string): Promise<Packument> {
    const url = this.registryFor(name) + name.replace('/', '%2f');
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(url, { headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*' } });
        if (res.status === 404) throw Object.assign(new Error(`404 Not Found - GET ${url} - '${name}' is not in this registry.`), { code: 'E404' });
        if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} - GET ${url}`), { code: 'E' + res.status });
        return (await res.json()) as Packument;
      } catch (e: any) {
        lastErr = e;
        if (e?.code === 'E404' || e?.code === 'EACCES') throw e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /** Downloads and unpacks a tarball (with integrity verification and caching). */
  async tarball(url: string, integrity?: string, shasum?: string): Promise<TarEntry[]> {
    const bytes = await this.limit(() => this.fetchTarball(url, integrity, shasum));
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
    return untar(raw);
  }

  private async fetchTarball(url: string, integrity?: string, shasum?: string): Promise<Uint8Array> {
    const cache = typeof caches !== 'undefined' ? await caches.open(this.cacheName).catch(() => null) : null;
    if (cache) {
      const hit = await cache.match(url).catch(() => undefined);
      if (hit) {
        const b = new Uint8Array(await hit.arrayBuffer());
        if (await verify(b, integrity, shasum)) return b;
        await cache.delete(url).catch(() => {});
      }
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // OpenVessel's own compat packages come from this origin, not through the network policy
        const own = typeof location !== 'undefined' && url.startsWith(`${location.origin}/compat/`);
        const res = own ? await fetch(url) : await this.fetchFn(url);
        if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} - GET ${url}`), { code: 'E' + res.status });
        const b = new Uint8Array(await res.arrayBuffer());
        if (!(await verify(b, integrity, shasum))) throw Object.assign(new Error(`integrity checksum failed for ${url}`), { code: 'EINTEGRITY' });
        if (cache) await cache.put(url, new Response(b as unknown as BodyInit, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
        return b;
      } catch (e: any) {
        lastErr = e;
        if (e?.code === 'EACCES' || e?.code === 'E404') throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Verifies Subresource-Integrity strings (sha512/sha384/sha256/sha1) or a hex sha1 shasum. */
export async function verify(data: Uint8Array, integrity?: string, shasum?: string): Promise<boolean> {
  if (integrity) {
    for (const part of integrity.split(/\s+/)) {
      const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(part);
      if (!m) continue;
      const algo = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]]!;
      const digest = new Uint8Array(await crypto.subtle.digest(algo, data as unknown as BufferSource));
      if (b64(digest) === m[2]) return true;
    }
    return false;
  }
  if (shasum) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data as unknown as BufferSource));
    return [...digest].map((x) => x.toString(16).padStart(2, '0')).join('') === shasum;
  }
  return true;
}
