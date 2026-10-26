// A fake npm registry for the package manager tests: packuments and (uncompressed) tarballs built in memory.
import { createHash } from 'node:crypto';
import { makeKernel, run } from './helpers.ts';
import { installNpm, setNpmFetch } from '../../src/kernel/npm/cli.ts';

export interface FakeVersion {
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  license?: string;
  description?: string;
  /** extra files: path → contents */
  files?: Record<string, string>;
}
export type FakePackages = Record<string, Record<string, FakeVersion>>;

const enc = new TextEncoder();

function tar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const field = (h: Uint8Array, off: number, len: number, s: string) => h.set(enc.encode(s).subarray(0, len), off);
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    field(h, 0, 100, `package/${name}`);
    field(h, 100, 8, (name.startsWith('bin/') ? '0000755' : '0000644') + '\0');
    field(h, 108, 8, '0000000\0');
    field(h, 116, 8, '0000000\0');
    field(h, 124, 12, data.length.toString(8).padStart(11, '0') + '\0');
    field(h, 136, 12, '00000000000\0');
    field(h, 148, 8, '        ');
    h[156] = 48;
    field(h, 257, 6, 'ustar\0');
    field(h, 263, 2, '00');
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h);
    const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
    body.set(data);
    blocks.push(body);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

export const REGISTRY = 'https://registry.npmjs.org/';

export function fakeRegistry(pkgs: FakePackages, tags: Record<string, Record<string, string>> = {}) {
  const tarballs = new Map<string, Uint8Array>();
  const docs = new Map<string, { abbreviated: any; full: any }>();
  for (const [name, versions] of Object.entries(pkgs)) {
    const abbreviated: any = { name, 'dist-tags': {}, versions: {} };
    const full: any = { name, 'dist-tags': {}, versions: {}, time: {}, maintainers: [{ name: 'someone', email: 'someone@example.com' }] };
    for (const [version, v] of Object.entries(versions)) {
      const manifest: any = { name, version, dependencies: v.dependencies, bin: v.bin };
      const files = { 'package.json': JSON.stringify({ name, version, dependencies: v.dependencies, bin: v.bin, license: v.license, description: v.description }), ...v.files };
      const bytes = tar(files);
      const url = `${REGISTRY}${name}/-/${name.replace(/^@[^/]+\//, '')}-${version}.tgz`;
      tarballs.set(url, bytes);
      manifest.dist = {
        tarball: url,
        shasum: createHash('sha1').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        unpackedSize: 1234,
      };
      abbreviated.versions[version] = manifest;
      full.versions[version] = { ...manifest, license: v.license, description: v.description };
      full.time[version] = '2024-05-01T12:00:00.000Z';
      abbreviated['dist-tags'].latest = version;
    }
    Object.assign(abbreviated['dist-tags'], tags[name]);
    full['dist-tags'] = abbreviated['dist-tags'];
    docs.set(name, { abbreviated, full });
  }
  const requests: string[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    requests.push(url);
    const tb = tarballs.get(url);
    if (tb) return new Response(tb as unknown as BodyInit, { status: 200 });
    const name = decodeURIComponent(url.slice(REGISTRY.length));
    const doc = docs.get(name);
    if (!doc) return new Response('{}', { status: 404, statusText: 'Not Found' });
    const accept = new Headers(init.headers).get('accept') ?? '';
    return new Response(JSON.stringify(accept.startsWith('application/vnd.npm.install-v1+json') ? doc.abbreviated : doc.full), { status: 200 });
  };
  return { fetch, requests };
}

/** A kernel with the package managers, talking to a fake registry. */
export function npmKernel(pkgs: FakePackages, tags?: Record<string, Record<string, string>>) {
  const k = makeKernel();
  installNpm(k);
  const reg = fakeRegistry(pkgs, tags);
  setNpmFetch(reg.fetch);
  k.vfs.mkdir('/home/user/app', 0o755, true);
  const sh = (cmd: string, cwd = '/home/user/app') => run(k, cmd, cwd);
  const write = (p: string, data: unknown) => {
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (parent && !k.vfs.exists(parent)) k.vfs.mkdir(parent, 0o755, true);
    k.vfs.writeFile(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  const read = (p: string) => new TextDecoder().decode(k.vfs.readFile(p));
  return { k, reg, sh, write, read };
}

/** A bin script that prints its arguments, one per line in brackets. */
export const ECHO_ARGS = '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n';
