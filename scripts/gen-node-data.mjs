// Extracts what OpenVessel needs from a real Node.js of the pinned version:
//   vendor/node/natives.json   every builtin's source (lib/ and deps/), exactly as Node embeds them
//   src/node/data/bindings.json  constants and the API shape (functions, classes, methods) of each internalBinding
//   src/node/data/process.json   process.versions/release/features/config, option defaults
// The data comes from the official linux/amd64 image (OpenVessel reports itself as Linux x64), so
// errno, signal and O_* values match what the kernel uses. Needs Docker.
// Usage: node scripts/gen-node-data.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const version = /NODE_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/node/version.ts'), 'utf8'))[1];

const dumper = String.raw`
const { internalBinding } = require('internal/test/binding');
const names = ${JSON.stringify([
  'async_wrap', 'blob', 'block_list', 'buffer', 'builtins', 'cares_wrap', 'config', 'constants', 'contextify', 'credentials', 'crypto',
  'encoding_binding', 'errors', 'fs', 'fs_dir', 'fs_event_wrap', 'heap_utils', 'http_parser', 'icu', 'inspector', 'js_stream', 'js_udp_wrap', 'messaging',
  'mksnapshot', 'module_wrap', 'modules', 'options', 'os', 'performance', 'permission', 'pipe_wrap', 'process_methods', 'process_wrap', 'report',
  'serdes', 'signal_wrap', 'spawn_sync', 'stream_pipe', 'stream_wrap', 'string_decoder', 'symbols', 'task_queue', 'tcp_wrap', 'timers', 'tls_wrap',
  'trace_events', 'tty_wrap', 'types', 'udp_wrap', 'url', 'url_pattern', 'util', 'uv', 'v8', 'wasi', 'wasm_web_api', 'watchdog', 'worker', 'zlib',
  'sea', 'profiler', 'internal_only_v8', 'async_context_frame', 'webstorage', 'locks', 'http2', 'quic', 'sqlite', 'fs_event_wrap', 'signal_wrap',
])};
function shape(v, depth, seen) {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { __num: String(v) };
  if (typeof v === 'bigint') return { __bigint: String(v) };
  if (typeof v === 'symbol') return { __symbol: v.description };
  if (typeof v === 'function') {
    const proto = v.prototype && Object.getOwnPropertyNames(v.prototype).filter((k) => k !== 'constructor');
    const statics = Object.getOwnPropertyNames(v).filter((k) => !['length', 'name', 'prototype', 'arguments', 'caller'].includes(k));
    const out = { __fn: v.name || true };
    if (proto && proto.length) out.proto = proto;
    if (statics.length && depth < 3) out.statics = Object.fromEntries(statics.map((k) => [k, shape(v[k], depth + 1, seen)]));
    return out;
  }
  if (seen.has(v)) return { __ref: true };
  seen.add(v);
  if (ArrayBuffer.isView(v)) return { __typed: v.constructor.name, length: v.length, values: v.length <= 64 ? Array.from(v, (x) => (typeof x === 'bigint' ? String(x) : x)) : undefined };
  if (v instanceof Map) return { __map: depth < 4 ? [...v].map(([k, x]) => [shape(k, depth + 1, seen), shape(x, depth + 1, seen)]) : v.size };
  if (v instanceof Set) return { __set: [...v].map((x) => shape(x, depth + 1, seen)) };
  if (Array.isArray(v)) return depth < 6 ? v.map((x) => shape(x, depth + 1, seen)) : { __array: v.length };
  if (depth > 6) return { __object: true };
  const o = {};
  for (const k of Reflect.ownKeys(v)) {
    const key = typeof k === 'symbol' ? '@@' + k.description : k;
    try {
      o[key] = shape(v[k], depth + 1, seen);
    } catch (e) {
      o[key] = { __throws: String(e.message) };
    }
  }
  return o;
}
const bindings = {};
for (const n of names) {
  try {
    const b = internalBinding(n);
    bindings[n] = n === 'builtins' ? { ...shape({ ...b, natives: undefined }, 0, new Set()) } : shape(b, 0, new Set());
  } catch (e) {
    bindings[n] = { __missing: String(e.message) };
  }
}
const uv = internalBinding('uv');
bindings.uv.__errmap = [...uv.getErrorMap()];
const natives = internalBinding('builtins').natives;
const opts = internalBinding('options');
const info = opts.getCLIOptionsInfo();
const proc = {
  versions: process.versions, release: process.release, features: process.features, config: process.config,
  optionValues: opts.getCLIOptionsValues(),
  optionInfo: { options: [...info.options].map(([k, v]) => [k, v]), aliases: [...info.aliases] },
  embedderOptions: opts.getEmbedderOptions(),
  envSettings: opts.envSettings, types: opts.types,
  builtinCategories: internalBinding('builtins').builtinCategories,
};
process.stdout.write(JSON.stringify({ bindings, natives, proc }));
`;
const raw = execFileSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '--hostname', 'openvessel', '-e', 'HOME=/home/user', `node:${version}-bookworm-slim`, 'node', '--expose-internals', '--no-warnings', '-e', dumper], { maxBuffer: 1 << 30, encoding: 'utf8' });
const { bindings, natives, proc } = JSON.parse(raw);
mkdirSync(join(root, 'vendor/node'), { recursive: true });
mkdirSync(join(root, 'src/node/data'), { recursive: true });
writeFileSync(join(root, 'vendor/node/natives.json'), JSON.stringify(natives));
writeFileSync(join(root, 'src/node/data/bindings.json'), JSON.stringify(bindings, null, 1));
writeFileSync(join(root, 'src/node/data/process.json'), JSON.stringify(proc, null, 1));
const license = execFileSync('curl', ['-fsSL', `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`], { maxBuffer: 1 << 26, encoding: 'utf8' });
writeFileSync(join(root, 'vendor/node/LICENSE'), license);
console.log(`node v${version}: ${Object.keys(natives).length} builtins, ${Object.keys(bindings).length} bindings`);
