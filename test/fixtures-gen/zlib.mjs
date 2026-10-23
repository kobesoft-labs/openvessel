// Records how real Node's internalBinding('zlib') behaves, for test/unit/bindings-zlib.test.ts.
//   npx -y node@<version in src/node/version.ts> --expose-internals --no-warnings test/fixtures-gen/zlib.mjs
// Writes test/unit/fixtures/zlib.json.

import { createRequire } from 'node:module';
import fs, { writeFileSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';
import { runSpec } from './zlib-driver.mjs';

const NODE_VERSION = /NODE_VERSION = '([^']+)'/.exec(fs.readFileSync(new URL('../../src/node/version.ts', import.meta.url), 'utf8'))[1];
if (process.version !== `v${NODE_VERSION}`) throw new Error(`run with Node v${NODE_VERSION} (got ${process.version})`);
const require = createRequire(import.meta.url);
const { internalBinding } = require('internal/test/binding');
const binding = internalBinding('zlib');
const C = zlib.constants;

// ---------------------------------------------------------------------------- inputs

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}
const words = 'the quick brown fox jumps over lazy dog zlib deflate inflate stream buffer chunk window level strategy'.split(' ');
function text(n, seed) {
  const r = rng(seed);
  let s = '';
  while (s.length < n) s += words[r() % words.length] + (r() % 13 === 0 ? '.\n' : ' ');
  return new Uint8Array(Buffer.from(s.slice(0, n)));
}
function random(n, seed) {
  const r = rng(seed);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = r() >>> 24;
  return a;
}
function mixed(n, seed) {
  const r = rng(seed);
  const a = text(n, seed + 1);
  for (let i = 0; i < n; i += 97) a[i] = r() >>> 24;
  return a;
}

const raw = {
  empty: new Uint8Array(0),
  small: new Uint8Array(Buffer.from('hello hello hello world\n')),
  text: text(60000, 1),
  text2: text(5000, 2),
  random: random(12000, 3),
  mixed: mixed(30000, 4),
  zeros: new Uint8Array(40000),
  dict: new Uint8Array(Buffer.from(words.join(' ') + ' ' + words.reverse().join(' '))),
  dict2: new Uint8Array(Buffer.from('something else entirely, not the dictionary used')),
};
const derived = {};
const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
derived.deflated = u8(zlib.deflateSync(raw.text2));
derived.deflatedText = u8(zlib.deflateSync(raw.text));
derived.gzipped = u8(zlib.gzipSync(raw.text2));
derived.gzippedMixed = u8(zlib.gzipSync(raw.mixed, { level: 9 }));
derived.rawDeflated = u8(zlib.deflateRawSync(raw.text2));
derived.deflatedDict = u8(zlib.deflateSync(raw.text2, { dictionary: raw.dict }));
derived.rawDeflatedDict = u8(zlib.deflateRawSync(raw.text2, { dictionary: raw.dict }));
derived.deflatedWb9 = u8(zlib.deflateSync(raw.text2, { windowBits: 9 }));
derived.multiGzip = u8(Buffer.concat([zlib.gzipSync(raw.small), zlib.gzipSync(raw.text2), zlib.gzipSync(raw.empty)]));
derived.gzipZeroPad = u8(Buffer.concat([zlib.gzipSync(raw.small), Buffer.alloc(10)]));
derived.gzipGarbage = u8(Buffer.concat([zlib.gzipSync(raw.small), Buffer.from('garbage!')]));
derived.deflateGarbage = u8(Buffer.concat([zlib.deflateSync(raw.small), Buffer.from('garbage!')]));
derived.truncated = derived.deflated.slice(0, derived.deflated.length - 20);
derived.truncatedGzip = derived.gzipped.slice(0, 30);
derived.badHeader = u8(Buffer.from('this is not compressed at all'));
derived.badBlock = new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0x00]);
derived.badCheck = (() => {
  const b = derived.deflated.slice();
  b[b.length - 1] ^= 0xff;
  return b;
})();
derived.badGzipCrc = (() => {
  const b = derived.gzipped.slice();
  b[b.length - 6] ^= 0xff;
  return b;
})();
derived.badDistance = new Uint8Array(Buffer.from('78da63600002e60000', 'hex'));
derived.brotli = u8(zlib.brotliCompressSync(raw.text));
derived.brotliQ11 = u8(zlib.brotliCompressSync(raw.mixed, { params: { [C.BROTLI_PARAM_QUALITY]: 11 } }));
derived.brotliQ1 = u8(zlib.brotliCompressSync(raw.random, { params: { [C.BROTLI_PARAM_QUALITY]: 1 } }));
derived.brotliLarge = u8(zlib.brotliCompressSync(raw.text2, { params: { [C.BROTLI_PARAM_LARGE_WINDOW]: 1, [C.BROTLI_PARAM_LGWIN]: 26 } }));
derived.brotliTrunc = derived.brotli.slice(0, derived.brotli.length >> 1);
derived.brotliBad = (() => {
  const b = derived.brotli.slice();
  for (let i = 10; i < 40; i++) b[i] ^= 0x5a;
  return b;
})();
derived.zstd = u8(zlib.zstdCompressSync(raw.text));
derived.zstdChecksum = u8(zlib.zstdCompressSync(raw.mixed, { params: { [C.ZSTD_c_checksumFlag]: 1, [C.ZSTD_c_compressionLevel]: 19 } }));
derived.zstdDict = u8(zlib.zstdCompressSync(raw.text2, { dictionary: raw.dict }));
derived.zstdTrunc = derived.zstd.slice(0, derived.zstd.length >> 1);
derived.zstdBadChecksum = (() => {
  const b = derived.zstdChecksum.slice();
  b[b.length - 1] ^= 0xff;
  return b;
})();
derived.zstdBad = (() => {
  const b = derived.zstd.slice();
  for (let i = 12; i < 60; i++) b[i] ^= 0x5a;
  return b;
})();

const inputs = { ...raw, ...derived };

// ---------------------------------------------------------------------------- specs

const kMaxBrotliParam = Math.max(...Object.entries(C).map(([k, v]) => (k.startsWith('BROTLI_PARAM_') ? v : 0)));
const kMaxZstdCParam = Math.max(...Object.entries(C).map(([k, v]) => (k.startsWith('ZSTD_c_') ? v : 0)));
const kMaxZstdDParam = Math.max(...Object.entries(C).map(([k, v]) => (k.startsWith('ZSTD_d_') ? v : 0)));

const specs = [];
const add = (name, spec) => specs.push({ name, ...spec });
const Z = (mode, o = {}) => ({
  cls: 'Zlib',
  mode,
  init: { windowBits: o.windowBits ?? 15, level: o.level ?? -1, memLevel: o.memLevel ?? 8, strategy: o.strategy ?? 0, dictionary: o.dictionary },
});
const fin = (input, extra = {}) => ({ op: 'write', flush: C.Z_FINISH, input, ...extra });
const DEFLATES = { DEFLATE: C.DEFLATE, GZIP: C.GZIP, DEFLATERAW: C.DEFLATERAW };

// one-shot deflate across levels and strategies
for (const [mn, mode] of Object.entries(DEFLATES))
  for (const level of [-1, 0, 1, 2, 3, 4, 6, 9])
    for (const strategy of [0, 1, 2, 3, 4]) add(`${mn} level=${level} strategy=${strategy}`, { ...Z(mode, { level, strategy }), steps: [fin('text')] });
for (const [mn, mode] of Object.entries(DEFLATES))
  for (const windowBits of [9, 12, 15])
    for (const memLevel of [1, 5, 9])
      for (const input of ['mixed', 'random', 'empty', 'zeros'])
        add(`${mn} wb=${windowBits} mem=${memLevel} ${input}`, { ...Z(mode, { windowBits, memLevel, level: 7 }), steps: [fin(input)] });
add('DEFLATE windowBits=8', { ...Z(C.DEFLATE, { windowBits: 8 }), steps: [fin('text2')] });
add('DEFLATE small chunks', { ...Z(C.DEFLATE), chunkSize: 64, steps: [fin('text')] });
add('GZIP small chunks async', { ...Z(C.GZIP), chunkSize: 100, steps: [fin('mixed', { async: true })] });

// flush sequences
for (const [mn, mode] of Object.entries(DEFLATES))
  for (const flush of [C.Z_NO_FLUSH, C.Z_PARTIAL_FLUSH, C.Z_SYNC_FLUSH, C.Z_FULL_FLUSH, C.Z_BLOCK])
    for (const async of [false, true])
      add(`${mn} flush=${flush} async=${async}`, {
        ...Z(mode),
        chunkSize: 1024,
        steps: [
          { op: 'write', flush, input: 'text2', async },
          { op: 'write', flush, input: 'small', async },
          { op: 'write', flush, input: 'random', async },
          { op: 'write', flush: C.Z_SYNC_FLUSH, input: null, async },
          { op: 'write', flush, input: 'empty', async },
          fin('empty', { async }),
        ],
      });

// params mid-stream (zlib.js flushes with Z_SYNC_FLUSH first), reset
for (const [mn, mode] of Object.entries(DEFLATES))
  for (const [level, strategy] of [
    [9, 0],
    [0, 0],
    [1, 1],
    [6, 2],
    [3, 3],
  ])
    add(`${mn} params(${level},${strategy})`, {
      ...Z(mode, { level: 4 }),
      steps: [
        { op: 'write', flush: C.Z_NO_FLUSH, input: 'text2' },
        { op: 'write', flush: C.Z_SYNC_FLUSH, input: 'empty' },
        { op: 'params', level, strategy },
        { op: 'write', flush: C.Z_NO_FLUSH, input: 'mixed' },
        { op: 'write', flush: C.Z_SYNC_FLUSH, input: 'empty' },
        { op: 'params', level: 6, strategy: 0 },
        fin('text2'),
      ],
    });
add('DEFLATE level 0 then params(9) after stored data', {
  ...Z(C.DEFLATE, { level: 0 }),
  steps: [{ op: 'write', flush: C.Z_SYNC_FLUSH, input: 'text' }, { op: 'params', level: 9, strategy: 0 }, fin('text')],
});
add('DEFLATE params without flush', {
  ...Z(C.DEFLATE),
  steps: [{ op: 'write', flush: C.Z_NO_FLUSH, input: 'text' }, { op: 'params', level: 1, strategy: 0 }, fin('text2')],
});
add('DEFLATE params before write', { ...Z(C.DEFLATE), steps: [{ op: 'params', level: 1, strategy: 0 }, fin('text2')] });
for (const [mn, mode] of Object.entries(DEFLATES))
  add(`${mn} reset`, {
    ...Z(mode),
    steps: [{ op: 'write', flush: C.Z_NO_FLUSH, input: 'text2' }, { op: 'reset' }, fin('small'), { op: 'reset' }, fin('text2')],
  });

// dictionaries
add('DEFLATE dict', { ...Z(C.DEFLATE, { dictionary: 'dict' }), steps: [fin('text2')] });
add('DEFLATERAW dict', { ...Z(C.DEFLATERAW, { dictionary: 'dict' }), steps: [fin('text2')] });
add('GZIP dict (ignored)', { ...Z(C.GZIP, { dictionary: 'dict' }), steps: [fin('text2')] });
add('DEFLATE dict reset', { ...Z(C.DEFLATE, { dictionary: 'dict' }), steps: [fin('small'), { op: 'reset' }, fin('text2')] });
add('INFLATE dict', { ...Z(C.INFLATE, { windowBits: 0, dictionary: 'dict' }), steps: [fin('deflatedDict')] });
add('INFLATE dict async', { ...Z(C.INFLATE, { windowBits: 0, dictionary: 'dict' }), steps: [fin('deflatedDict', { async: true })] });
add('INFLATE wrong dict', { ...Z(C.INFLATE, { windowBits: 0, dictionary: 'dict2' }), steps: [fin('deflatedDict')] });
add('INFLATE missing dict', { ...Z(C.INFLATE, { windowBits: 0 }), steps: [fin('deflatedDict')] });
add('INFLATE missing dict async', { ...Z(C.INFLATE, { windowBits: 0 }), steps: [fin('deflatedDict', { async: true })] });
add('INFLATERAW dict', { ...Z(C.INFLATERAW, { dictionary: 'dict' }), steps: [fin('rawDeflatedDict')] });
add('INFLATERAW wrong dict', { ...Z(C.INFLATERAW, { dictionary: 'dict2' }), steps: [fin('rawDeflatedDict')] });
add('UNZIP dict', { ...Z(C.UNZIP, { windowBits: 0, dictionary: 'dict' }), steps: [fin('deflatedDict')] });

// inflate family
const INF = (mode, windowBits = 0) => Z(mode, { windowBits });
for (const chunkSize of [64, 16384])
  for (const async of [false, true]) {
    const sfx = ` chunk=${chunkSize} async=${async}`;
    add('INFLATE' + sfx, { ...INF(C.INFLATE), chunkSize, steps: [fin('deflatedText', { async })] });
    add('GUNZIP' + sfx, { ...INF(C.GUNZIP), chunkSize, steps: [fin('gzippedMixed', { async })] });
    add('INFLATERAW' + sfx, { ...INF(C.INFLATERAW, 15), chunkSize, steps: [fin('rawDeflated', { async })] });
    add('UNZIP gzip' + sfx, { ...INF(C.UNZIP), chunkSize, steps: [fin('gzipped', { async })] });
    add('UNZIP deflate' + sfx, { ...INF(C.UNZIP), chunkSize, steps: [fin('deflated', { async })] });
    add('GUNZIP multi-member' + sfx, { ...INF(C.GUNZIP), chunkSize, steps: [fin('multiGzip', { async })] });
  }
add('INFLATE windowBits=15', { ...INF(C.INFLATE, 15), steps: [fin('deflated')] });
add('INFLATE windowBits=9 too small', { ...INF(C.INFLATE, 9), steps: [fin('deflated')] });
add('INFLATE windowBits=9 ok', { ...INF(C.INFLATE, 9), steps: [fin('deflatedWb9')] });
add('INFLATE sync flush pieces', {
  ...INF(C.INFLATE),
  chunkSize: 256,
  steps: [
    { op: 'write', flush: C.Z_SYNC_FLUSH, input: { b64: Buffer.from(derived.deflated.slice(0, 1)).toString('base64') } },
    { op: 'write', flush: C.Z_SYNC_FLUSH, input: { b64: Buffer.from(derived.deflated.slice(1, 100)).toString('base64') } },
    { op: 'write', flush: C.Z_SYNC_FLUSH, input: { b64: Buffer.from(derived.deflated.slice(100)).toString('base64') } },
    fin('empty'),
  ],
});
for (const [name, data] of [
  ['gzip', derived.gzipped],
  ['deflate', derived.deflated],
])
  for (const split of [1, 2, 3])
    add(`UNZIP ${name} split at ${split}`, {
      ...INF(C.UNZIP),
      steps: [
        { op: 'write', flush: C.Z_NO_FLUSH, input: { b64: Buffer.from(data.slice(0, split)).toString('base64') } },
        { op: 'write', flush: C.Z_NO_FLUSH, input: { b64: Buffer.from(data.slice(split, split)).toString('base64') } },
        fin({ b64: Buffer.from(data.slice(split)).toString('base64') }),
      ],
    });
add('UNZIP reset', { ...INF(C.UNZIP), steps: [fin('gzipped'), { op: 'reset' }, fin('gzipped')] });
add('INFLATE reset', { ...INF(C.INFLATE), steps: [fin('deflated'), { op: 'reset' }, fin('deflated')] });
add('GUNZIP zero padding', { ...INF(C.GUNZIP), steps: [fin('gzipZeroPad')] });
add('GUNZIP trailing garbage', { ...INF(C.GUNZIP), steps: [fin('gzipGarbage')] });
add('UNZIP trailing garbage', { ...INF(C.UNZIP), steps: [fin('gzipGarbage')] });
add('INFLATE trailing garbage', { ...INF(C.INFLATE), steps: [fin('deflateGarbage')] });
for (const async of [false, true]) {
  const s = async ? ' async' : '';
  add('INFLATE truncated' + s, { ...INF(C.INFLATE), steps: [fin('truncated', { async })] });
  add('INFLATE truncated no finish' + s, { ...INF(C.INFLATE), steps: [{ op: 'write', flush: C.Z_SYNC_FLUSH, input: 'truncated', async }] });
  add('GUNZIP truncated' + s, { ...INF(C.GUNZIP), steps: [fin('truncatedGzip', { async })] });
  add('INFLATE bad header' + s, { ...INF(C.INFLATE), steps: [fin('badHeader', { async })] });
  add('GUNZIP bad header' + s, { ...INF(C.GUNZIP), steps: [fin('badHeader', { async })] });
  add('UNZIP bad header' + s, { ...INF(C.UNZIP), steps: [fin('badHeader', { async })] });
  add('INFLATE bad block' + s, { ...INF(C.INFLATE), steps: [fin('badBlock', { async })] });
  add('INFLATE bad check' + s, { ...INF(C.INFLATE), steps: [fin('badCheck', { async })] });
  add('GUNZIP bad crc' + s, { ...INF(C.GUNZIP), steps: [fin('badGzipCrc', { async })] });
  add('INFLATE bad distance' + s, { ...INF(C.INFLATE), steps: [fin('badDistance', { async })] });
  add('INFLATE empty input finish' + s, { ...INF(C.INFLATE), steps: [fin('empty', { async })] });
  add('INFLATERAW random' + s, { ...INF(C.INFLATERAW, 15), steps: [fin('random', { async })] });
}
add('INFLATE close then nothing', { ...INF(C.INFLATE), steps: [fin('deflated'), { op: 'close' }] });
add('DEFLATE close before write', { ...Z(C.DEFLATE), steps: [{ op: 'close' }] });

// brotli
const BE = (params = {}) => ({ cls: 'BrotliEncoder', mode: C.BROTLI_ENCODE, init: { paramsLength: kMaxBrotliParam + 1, params } });
const BD = (params = {}) => ({ cls: 'BrotliDecoder', mode: C.BROTLI_DECODE, init: { paramsLength: kMaxBrotliParam + 1, params } });
const bfin = (input, extra = {}) => ({ op: 'write', flush: C.BROTLI_OPERATION_FINISH, input, ...extra });
for (const q of [0, 1, 2, 5, 9, 11])
  for (const input of ['text', 'random', 'empty', 'zeros']) add(`BROTLI q=${q} ${input}`, { ...BE({ [C.BROTLI_PARAM_QUALITY]: q }), steps: [bfin(input)] });
add('BROTLI default async small chunks', { ...BE(), chunkSize: 64, steps: [bfin('mixed', { async: true })] });
add('BROTLI lgwin=10', { ...BE({ [C.BROTLI_PARAM_LGWIN]: 10 }), steps: [bfin('mixed')] });
add('BROTLI lgwin=24 lgblock=16', { ...BE({ [C.BROTLI_PARAM_LGWIN]: 24, [C.BROTLI_PARAM_LGBLOCK]: 16 }), steps: [bfin('mixed')] });
add('BROTLI mode text', { ...BE({ [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_TEXT }), steps: [bfin('text')] });
add('BROTLI mode font', { ...BE({ [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_FONT, [C.BROTLI_PARAM_QUALITY]: 6 }), steps: [bfin('mixed')] });
add('BROTLI size hint', { ...BE({ [C.BROTLI_PARAM_SIZE_HINT]: 30000 }), steps: [bfin('mixed')] });
add('BROTLI large window', { ...BE({ [C.BROTLI_PARAM_LARGE_WINDOW]: 1, [C.BROTLI_PARAM_LGWIN]: 26 }), steps: [bfin('text2')] });
add('BROTLI npostfix/ndirect', { ...BE({ [C.BROTLI_PARAM_NPOSTFIX]: 1, [C.BROTLI_PARAM_NDIRECT]: 12, [C.BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING]: 1 }), steps: [bfin('mixed')] });
add('BROTLI invalid quality', { ...BE({ [C.BROTLI_PARAM_QUALITY]: 12 }), steps: [bfin('text2')] });
add('BROTLI unknown param', { ...BE({ 0: 5 }), steps: [bfin('text2')] });
add('BROTLI decoder with encoder param', { ...BD({ [C.BROTLI_PARAM_QUALITY]: 5 }), steps: [] });
for (const async of [false, true])
  add(`BROTLI flushes async=${async}`, {
    ...BE(),
    chunkSize: 512,
    steps: [
      { op: 'write', flush: C.BROTLI_OPERATION_PROCESS, input: 'text2', async },
      { op: 'write', flush: C.BROTLI_OPERATION_FLUSH, input: 'small', async },
      { op: 'write', flush: C.BROTLI_OPERATION_EMIT_METADATA, input: 'empty', async },
      { op: 'write', flush: C.BROTLI_OPERATION_PROCESS, input: 'random', async },
      { op: 'write', flush: C.BROTLI_OPERATION_FLUSH, input: 'empty', async },
      bfin('text2', { async }),
    ],
  });
add('BROTLI reset', { ...BE({ [C.BROTLI_PARAM_QUALITY]: 3 }), steps: [{ op: 'write', flush: 0, input: 'text2' }, { op: 'reset' }, bfin('small')] });
for (const chunkSize of [64, 16384])
  for (const async of [false, true]) {
    const sfx = ` chunk=${chunkSize} async=${async}`;
    add('UNBROTLI' + sfx, { ...BD(), chunkSize, steps: [bfin('brotli', { async })] });
    add('UNBROTLI q11' + sfx, { ...BD(), chunkSize, steps: [bfin('brotliQ11', { async })] });
  }
add('UNBROTLI q1', { ...BD(), steps: [bfin('brotliQ1')] });
add('UNBROTLI large window', { ...BD({ [C.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 }), steps: [bfin('brotliLarge')] });
add('UNBROTLI large window not enabled', { ...BD(), steps: [bfin('brotliLarge')] });
add('UNBROTLI ring buffer param', { ...BD({ [C.BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION]: 1 }), steps: [bfin('brotli')] });
for (const async of [false, true]) {
  const s = async ? ' async' : '';
  add('UNBROTLI truncated' + s, { ...BD(), steps: [bfin('brotliTrunc', { async })] });
  add('UNBROTLI truncated process' + s, { ...BD(), steps: [{ op: 'write', flush: C.BROTLI_OPERATION_PROCESS, input: 'brotliTrunc', async }] });
  add('UNBROTLI corrupt' + s, { ...BD(), steps: [bfin('brotliBad', { async })] });
  add('UNBROTLI not brotli' + s, { ...BD(), steps: [bfin('text2', { async })] });
}
add('UNBROTLI pieces', {
  ...BD(),
  chunkSize: 1000,
  steps: [
    { op: 'write', flush: 0, input: { b64: Buffer.from(derived.brotli.slice(0, 5)).toString('base64') } },
    { op: 'write', flush: 0, input: { b64: Buffer.from(derived.brotli.slice(5, 500)).toString('base64') } },
    bfin({ b64: Buffer.from(derived.brotli.slice(500)).toString('base64') }),
  ],
});
add('UNBROTLI reset', { ...BD(), steps: [bfin('brotli'), { op: 'reset' }, bfin('brotliQ1')] });

// zstd
const ZC = (params = {}, extra = {}) => ({ cls: 'ZstdCompress', init: { paramsLength: kMaxZstdCParam + 1, params, pledgedSrcSize: undefined, ...extra } });
const ZD = (params = {}, extra = {}) => ({ cls: 'ZstdDecompress', init: { paramsLength: kMaxZstdDParam + 1, params, pledgedSrcSize: undefined, ...extra } });
const zfin = (input, extra = {}) => ({ op: 'write', flush: C.ZSTD_e_end, input, ...extra });
for (const level of [1, 3, 9, 19, -5])
  for (const input of ['text', 'random', 'empty'])
    add(`ZSTD level=${level} ${input}`, { ...ZC({ [C.ZSTD_c_compressionLevel]: level >>> 0 }), steps: [zfin(input)] });
add('ZSTD checksum', { ...ZC({ [C.ZSTD_c_checksumFlag]: 1 }), steps: [zfin('mixed')] });
add('ZSTD strategy/windowLog', { ...ZC({ [C.ZSTD_c_strategy]: C.ZSTD_btopt, [C.ZSTD_c_windowLog]: 12 }), steps: [zfin('mixed')] });
add('ZSTD long distance', { ...ZC({ [C.ZSTD_c_enableLongDistanceMatching]: 1 }), steps: [zfin('text')] });
add('ZSTD pledged', { ...ZC({}, { pledgedSrcSize: raw.text2.length }), steps: [zfin('text2')] });
add('ZSTD pledged wrong', { ...ZC({}, { pledgedSrcSize: 10 }), steps: [zfin('text2')] });
add('ZSTD pledged negative', { ...ZC({}, { pledgedSrcSize: -1 }), steps: [] });
add('ZSTD dictionary', { ...ZC({}, { dictionary: 'dict' }), steps: [zfin('text2')] });
add('ZSTD dictionary bad type', { ...ZC({}, { dictionary: 42 }), steps: [] });
add('ZSTD bad param value', { ...ZC({ [C.ZSTD_c_windowLog]: 99 }), steps: [] });
add('ZSTD nbWorkers', { ...ZC({ [C.ZSTD_c_nbWorkers]: 2 }), steps: [zfin('text2')] });
add('ZSTD small chunks async', { ...ZC(), chunkSize: 64, steps: [zfin('mixed', { async: true })] });
for (const async of [false, true])
  add(`ZSTD flushes async=${async}`, {
    ...ZC(),
    chunkSize: 512,
    steps: [
      { op: 'write', flush: C.ZSTD_e_continue, input: 'text2', async },
      { op: 'write', flush: C.ZSTD_e_flush, input: 'small', async },
      { op: 'write', flush: C.ZSTD_e_continue, input: 'random', async },
      zfin('text2', { async }),
    ],
  });
add('ZSTD reset', { ...ZC({ [C.ZSTD_c_checksumFlag]: 1 }, { dictionary: 'dict' }), steps: [{ op: 'write', flush: 0, input: 'text2' }, { op: 'reset' }, zfin('small')] });
for (const chunkSize of [64, 16384])
  for (const async of [false, true]) {
    const sfx = ` chunk=${chunkSize} async=${async}`;
    add('UNZSTD' + sfx, { ...ZD(), chunkSize, steps: [zfin('zstd', { async })] });
    add('UNZSTD checksum' + sfx, { ...ZD(), chunkSize, steps: [zfin('zstdChecksum', { async })] });
  }
add('UNZSTD dictionary', { ...ZD({}, { dictionary: 'dict' }), steps: [zfin('zstdDict')] });
add('UNZSTD missing dictionary', { ...ZD(), steps: [zfin('zstdDict')] });
add('UNZSTD wrong dictionary', { ...ZD({}, { dictionary: 'dict2' }), steps: [zfin('zstdDict')] });
add('UNZSTD windowLogMax', { ...ZD({ [C.ZSTD_d_windowLogMax]: 10 }), steps: [zfin('zstd')] });
for (const async of [false, true]) {
  const s = async ? ' async' : '';
  add('UNZSTD truncated' + s, { ...ZD(), steps: [zfin('zstdTrunc', { async })] });
  add('UNZSTD corrupt' + s, { ...ZD(), steps: [zfin('zstdBad', { async })] });
  add('UNZSTD bad checksum' + s, { ...ZD(), steps: [zfin('zstdBadChecksum', { async })] });
  add('UNZSTD not zstd' + s, { ...ZD(), steps: [zfin('text2', { async })] });
}
add('UNZSTD reset', { ...ZD(), steps: [zfin('zstd'), { op: 'reset' }, zfin('zstdChecksum')] });

// ---------------------------------------------------------------------------- run

const results = [];
for (const spec of specs) results.push({ spec, transcript: await runSpec(binding, spec, inputs) });

const crcCases = [
  { data: '', value: 0 },
  { data: 'hello', value: 0 },
  { data: 'hello', value: 12345 },
  { data: 'héllo wörld ✓ 𝄞', value: 0 },
  { data: 'lone \ud800 surrogate', value: 0 },
  { data: { b64: Buffer.from(raw.text2).toString('base64') }, value: 0 },
  { data: { b64: Buffer.from(raw.random).toString('base64') }, value: 0xffffffff },
  { data: { b64: Buffer.from(raw.small.subarray(3, 7)).toString('base64') }, value: 0xdeadbeef },
];
for (const c of crcCases) c.expected = binding.crc32(typeof c.data === 'string' ? c.data : Buffer.from(c.data.b64, 'base64'), c.value);

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const out = {
  node: process.version,
  versions: { zlib: process.versions.zlib, brotli: process.versions.brotli, zstd: process.versions.zstd },
  ZLIB_VERSION: binding.ZLIB_VERSION,
  inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, b64(v)])),
  results,
  crc32: crcCases,
};
const dest = new URL('../unit/fixtures/zlib.json', import.meta.url);
mkdirSync(new URL('.', dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out));
console.log(`${results.length} specs, ${crcCases.length} crc32 cases -> ${dest.pathname}`);
// Node (seen on 22.20.0) asserts at teardown on Zstd handles whose init() threw before InitStream
// ("close before init"); the fixture is already written, so skip environment cleanup.
process.reallyExit(0);
