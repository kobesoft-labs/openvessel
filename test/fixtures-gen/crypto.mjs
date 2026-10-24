// Records what real Node does for internalBinding('crypto') consumers, for test/unit/bindings-crypto.test.ts.
// Run with: npx -y node@<version in src/node/version.ts> --expose-internals --no-warnings test/fixtures-gen/crypto.mjs
//
// Cipher/hash/HMAC cases are "op scripts" (create, update, final, ...) executed here with the public
// crypto module; the unit test replays the same scripts against our binding through a copy of lib's
// thin wrappers and compares every result, including errors.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const binding = require('internal/test/binding').internalBinding('crypto');
const out = {};

// deterministic bytes
let seed = 0x12345678;
function bytes(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    b[i] = seed >>> 24;
  }
  return b;
}
const hex = (b) => Buffer.from(b).toString('hex');
const errOf = (e) => ({ error: { name: e.name, message: e.message, code: e.code, library: e.library, reason: e.reason } });
function attempt(f) {
  try {
    return f();
  } catch (e) {
    return errOf(e);
  }
}
const enc = (v) => (Buffer.isBuffer(v) ? { hex: hex(v) } : typeof v === 'string' ? { str: v } : v);

// -----------------------------------------------------------------------------
// lists

out.lists = {
  hashes: binding.getHashes(),
  ciphers: binding.getCiphers(),
  aliases: binding.getCachedAliases(),
  fips: binding.getFipsCrypto(),
  testFips: binding.testFipsCrypto(),
};

// -----------------------------------------------------------------------------
// HMAC

out.hmac = [];
const macNames = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'ripemd160', 'blake2b512', 'blake2s256', 'sm3', 'md5-sha1', 'RSA-SHA256', 'SHA-256', 'shake128', 'foo'];
for (const alg of macNames) {
  for (const klen of [0, 3, 64, 65, 129, 200]) {
    const key = hex(bytes(klen));
    const data = [['abc', 'utf8'], [hex(bytes(300)), 'hex']];
    const result = attempt(() => {
      const h = crypto.createHmac(alg, Buffer.from(key, 'hex'));
      for (const [d, e] of data) h.update(d, e);
      return { hex: h.digest('hex') };
    });
    out.hmac.push({ alg, key, data, result });
  }
}
out.hmac.push({ alg: 'sha256', key: 'string key é', keyIsString: true, data: [['abc', 'utf8']], result: { hex: crypto.createHmac('sha256', 'string key é').update('abc').digest('hex') } });
{
  const h = crypto.createHmac('sha256', 'k');
  out.hmacTwice = { first: h.digest('hex'), second: h.digest('hex'), update: attempt(() => h.update('x')) };
}

// -----------------------------------------------------------------------------
// hashes: { alg, xof?, chunks: [[hex|str, enc]], out } → result

const hashInputs = [
  [],
  [['abc', 'utf8']],
  [[hex(bytes(1000)), 'hex']],
  [[hex(bytes(63)), 'hex'], [hex(bytes(1)), 'hex'], [hex(bytes(200)), 'hex'], ['tail é', 'utf8']],
];
const hashNames = [...binding.getHashes(), 'SHA256', 'Sha-256', 'SHA2-256', 'sha-1', 'SHA-512/224', '2.16.840.1.101.3.4.2.1', 'RIPEMD-160', 'BLAKE2b512', 'SHAKE-128', 'MD5-SHA1', 'sha512/256', 'sha256 ', 'foo', ''];
function runHash(c) {
  return attempt(() => {
    const h = crypto.createHash(c.alg, c.xof === undefined ? undefined : { outputLength: c.xof });
    for (const [d, e] of c.chunks) h.update(e === 'buffer' ? Buffer.from(d, 'hex') : d, e === 'buffer' ? undefined : e);
    const r = h.digest(c.out);
    return enc(r);
  });
}
out.hash = [];
for (const alg of hashNames) for (const chunks of hashInputs) out.hash.push({ alg, chunks, out: 'hex' });
for (const xof of [0, 1, 16, 33, 100, 300]) for (const alg of ['shake128', 'shake256']) out.hash.push({ alg, xof, chunks: hashInputs[3], out: 'hex' });
for (const alg of ['sha256', 'md5', 'sha3-256']) for (const xof of [5, 32, 16]) out.hash.push({ alg, xof, chunks: hashInputs[1], out: 'hex' });
for (const o of ['base64', 'base64url', 'latin1', 'binary', 'ucs2', 'utf16le', 'utf8', 'ascii', 'buffer', undefined, 'foo', 'HEX', 'Base64'])
  out.hash.push({ alg: 'sha256', chunks: hashInputs[2], out: o });
for (const e of ['hex', 'base64', 'base64url', 'latin1', 'binary', 'utf16le', 'ascii', 'utf8', 'buffer'])
  out.hash.push({ alg: 'sha1', chunks: [[e === 'hex' ? 'deadbeef' : e === 'buffer' ? 'deadbeef' : e.startsWith('base64') ? 'SGVsbG8_/+w' : 'Héllo wörld 😀', e]], out: 'hex' });
for (const c of out.hash) c.result = runHash(c);

// copy()
out.hashCopy = [];
for (const alg of ['sha256', 'sha512', 'sha3-256', 'md5', 'shake256', 'blake2b512', 'sm3', 'md5-sha1']) {
  const h = crypto.createHash(alg).update('first part ');
  const c = h.copy();
  h.update('A');
  c.update('B');
  out.hashCopy.push({ alg, a: h.digest('hex'), b: c.digest('hex') });
}
// one-shot crypto.hash()
out.oneShot = [];
for (const [alg, input, o] of [
  ['sha256', 'abc', undefined], ['md5', 'héllo', 'base64'], ['sha1', { hex: '00ff10' }, 'buffer'], ['SHA-512', 'x', 'latin1'],
  ['sha3-256', '', 'hex'], ['shake128', 'abc', 'hex'], ['foo', 'abc', 'hex'], ['RSA-SHA256', 'abc', 'base64url'], ['blake2s256', 'abc', undefined],
]) {
  const i = typeof input === 'string' ? input : Buffer.from(input.hex, 'hex');
  out.oneShot.push({ alg, input, out: o, result: attempt(() => enc(crypto.hash(alg, i, o))) });
}

// -----------------------------------------------------------------------------
// KDFs

out.pbkdf2 = [];
for (const [digest, plen, slen, iter, keylen] of [
  ['sha1', 8, 8, 1, 20], ['sha1', 8, 8, 2, 20], ['sha256', 0, 0, 1, 32], ['sha256', 11, 16, 1000, 64], ['sha512', 32, 32, 10, 100],
  ['md5', 5, 5, 3, 7], ['sha3-256', 5, 5, 3, 50], ['sm3', 4, 4, 5, 40], ['md5-sha1', 4, 4, 2, 50], ['ripemd160', 4, 4, 2, 21], ['sha256', 4, 4, 1, 0],
  ['foo', 4, 4, 1, 10], ['SHA-256', 4, 4, 2, 10], ['shake128', 4, 4, 1, 10],
]) {
  const pass = hex(bytes(plen));
  const salt = hex(bytes(slen));
  out.pbkdf2.push({ digest, pass, salt, iter, keylen, result: attempt(() => ({ hex: hex(crypto.pbkdf2Sync(Buffer.from(pass, 'hex'), Buffer.from(salt, 'hex'), iter, keylen, digest)) })) });
}
out.scrypt = [];
for (const [plen, slen, keylen, opts] of [
  [3, 3, 3, { N: 3 }], [8, 8, 64, { N: 16, r: 1, p: 1 }], [0, 0, 64, { N: 16, r: 1, p: 1 }], [8, 4, 32, {}], [8, 4, 16, { N: 1024, r: 8, p: 2 }],
  [3, 3, 0, {}], [3, 3, 10, { N: 2 ** 20 }], [3, 3, 10, { N: 2 ** 15, maxmem: 2 ** 26 }], [3, 3, 10, { r: 2 ** 20, p: 2 ** 10 }], [3, 3, 10, { N: 16, r: 1, p: 1, maxmem: 2000 }], [3, 3, 10, { N: 65536, r: 1 }],
]) {
  const pass = hex(bytes(plen));
  const salt = hex(bytes(slen));
  const result = attempt(() => ({ hex: hex(crypto.scryptSync(Buffer.from(pass, 'hex'), Buffer.from(salt, 'hex'), keylen, opts)) }));
  out.scrypt.push({ pass, salt, keylen, opts, result });
}
out.hkdf = [];
for (const [digest, klen, slen, ilen, len] of [
  ['sha256', 22, 13, 10, 42], ['sha256', 80, 80, 80, 82], ['sha1', 22, 0, 0, 42], ['sha512', 16, 16, 16, 255 * 64], ['sha256', 16, 0, 0, 255 * 32 + 1],
  ['md5', 16, 4, 4, 100], ['sha3-512', 10, 10, 10, 10], ['foo', 1, 1, 1, 1], ['sha256', 4, 4, 4, 0], ['sha256', 0, 0, 0, 16],
]) {
  const ikm = hex(bytes(klen));
  const salt = hex(bytes(slen));
  const info = hex(bytes(ilen));
  out.hkdf.push({ digest, ikm, salt, info, len, result: attempt(() => ({ hex: hex(crypto.hkdfSync(digest, Buffer.from(ikm, 'hex'), Buffer.from(salt, 'hex'), Buffer.from(info, 'hex'), len)) })) });
}

// -----------------------------------------------------------------------------
// ciphers: op scripts

function runScript(s) {
  const results = [];
  let c;
  const toB = (h) => (h === null ? null : Buffer.from(h, 'hex'));
  try {
    c = (s.decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(s.cipher, toB(s.key), s.iv === null ? null : toB(s.iv), s.opts);
    results.push('ok');
  } catch (e) {
    results.push(errOf(e));
    return results;
  }
  for (const op of s.ops) {
    results.push(
      attempt(() => {
        switch (op[0]) {
          case 'update':
            return enc(c.update(Buffer.from(op[1], 'hex')));
          case 'updateStr':
            return enc(c.update(op[1], op[2], op[3]));
          case 'zeros': {
            // a large update, recorded by digest to keep the fixture small
            const r = c.update(Buffer.alloc(op[1]));
            return { sha256: crypto.createHash('sha256').update(r).digest('hex') };
          }
          case 'final':
            return enc(c.final(op[1]));
          case 'pad':
            c.setAutoPadding(op[1]);
            return 'ok';
          case 'aad':
            c.setAAD(Buffer.from(op[1], 'hex'), op[2] === undefined ? undefined : { plaintextLength: op[2] });
            return 'ok';
          case 'tag':
            return enc(c.getAuthTag());
          case 'settag':
            c.setAuthTag(Buffer.from(op[1], 'hex'));
            return 'ok';
        }
        throw new Error('bad op ' + op[0]);
      }),
    );
  }
  return results;
}

const scripts = [];
const add = (s) => scripts.push(s);
// the same selection as crypto-tables.cjs
const ciphersSupported = binding
  .getCiphers()
  .filter((n) => !/xts|aria|camellia|sm4/i.test(n) && /^(aes|id-aes|chacha20|des-ede|des3|id-smime-alg-cms3deswrap)/i.test(n))
  .map((n) => n.toLowerCase());
const splitOps = (data, sizes) => {
  const ops = [];
  let i = 0;
  for (const n of sizes) {
    if (i >= data.length) break;
    ops.push(['update', hex(data.subarray(i, i + n))]);
    i += n;
  }
  if (i < data.length) ops.push(['update', hex(data.subarray(i))]);
  return ops;
};
// encrypt then decrypt: decrypt ciphertext comes from real Node
function roundTrip(cipher, key, iv, opts, pt, sizes, extra = {}) {
  const pre = extra.pre ?? [];
  const enc1 = { cipher, key: hex(key), iv: iv === null ? null : hex(iv), opts, decrypt: false, ops: [...pre, ...splitOps(pt, sizes), ['final'], ...(extra.tag ? [['tag']] : [])] };
  add(enc1);
  const r = runScript(enc1);
  if (r[0] !== 'ok' || r.some((x) => x && x.error)) return;
  const ct = Buffer.concat(r.slice(1 + pre.length).filter((x) => x && x.hex !== undefined).slice(0, extra.tag ? -1 : undefined).map((x) => Buffer.from(x.hex, 'hex')));
  const tag = extra.tag ? r[r.length - 1].hex : null;
  const dpre = [...(tag && !extra.tagAfter ? [['settag', tag]] : []), ...(extra.dpre ?? pre)];
  add({ cipher, key: hex(key), iv: iv === null ? null : hex(iv), opts, decrypt: true, ops: [...dpre, ...splitOps(ct, sizes.slice().reverse()), ...(tag && extra.tagAfter ? [['settag', tag]] : []), ['final']] });
  if (tag) {
    const bad = Buffer.from(tag, 'hex');
    bad[0] ^= 1;
    add({ cipher, key: hex(key), iv: iv === null ? null : hex(iv), opts, decrypt: true, ops: [['settag', hex(bad)], ...(extra.dpre ?? pre), ...splitOps(ct, [ct.length || 1]), ['final']] });
  }
}

for (const name of ciphersSupported) {
  const info = crypto.getCipherInfo(name);
  const key = bytes(info.keyLength);
  const mode = info.mode;
  // aliases of ciphers covered under their main name: one round trip each
  if (/^id-aes\d+-(gcm|ccm)$|^aes\d+$|^des3$|^des-ede3$|^des-ede$/.test(name)) {
    const aead = mode === 'gcm' || mode === 'ccm';
    roundTrip(name, key, info.ivLength ? bytes(info.ivLength) : null, mode === 'ccm' ? { authTagLength: 16 } : undefined, bytes(33), aead && mode === 'ccm' ? [33] : [10, 23], { tag: aead });
    continue;
  }
  if (info.nid === 246) {
    // 3DES key wrap draws a random IV: only unwrapping real Node's output is deterministic
    if (name !== 'des3-wrap') continue;
    for (const n of [8, 16, 40]) {
      const c = crypto.createCipheriv(name, key, Buffer.alloc(0));
      const ct = Buffer.concat([c.update(bytes(n)), c.final()]);
      add({ cipher: name, key: hex(key), iv: '', decrypt: true, ops: [['update', hex(ct)], ['final']] });
      const bad = Buffer.from(ct);
      bad[bad.length - 1] ^= 1;
      add({ cipher: name, key: hex(key), iv: '', decrypt: true, ops: [['update', hex(bad)], ['final']] });
    }
    add({ cipher: name, key: hex(key), iv: '', decrypt: true, ops: [['update', hex(bytes(16))], ['final']] });
    add({ cipher: name, key: hex(key), iv: '', ops: [['update', hex(bytes(12))], ['final']] });
    continue;
  }
  if (mode === 'ocb') {
    for (const ivl of [12, 1, 15]) {
      for (const tl of [16, 8, 1]) {
        const iv = bytes(ivl);
        for (const [ptl, aadl] of [[0, 0], [1, 0], [16, 5], [70, 33], [48, 32]]) {
          const pre = aadl ? [['aad', hex(bytes(aadl))]] : [];
          roundTrip(name, key, iv, { authTagLength: tl }, bytes(ptl), [7, 16, 1], { tag: true, pre });
        }
      }
    }
    const iv = bytes(12);
    roundTrip(name, key, iv, { authTagLength: 16 }, bytes(33), [5, 20], { tag: true, pre: [['aad', hex(bytes(16))], ['aad', hex(bytes(20))]] });
    add({ cipher: name, key: hex(key), iv: hex(iv), ops: [] });
    add({ cipher: name, key: hex(key), iv: hex(bytes(16)), opts: { authTagLength: 16 }, ops: [] });
    add({ cipher: name, key: hex(key), iv: hex(iv), opts: { authTagLength: 17 }, ops: [] });
    continue;
  }
  if (mode === 'wrap') {
    const iv = bytes(info.ivLength);
    for (const n of name.includes('pad') ? [1, 5, 8, 9, 16, 20, 40] : [16, 24, 40, 15, 8]) {
      roundTrip(name, key, iv, undefined, bytes(n), [n]);
    }
    add({ cipher: name, key: hex(key), iv: hex(iv), decrypt: true, ops: [['update', hex(bytes(name.includes('pad') ? 24 : 32))], ['final']] });
    add({ cipher: name, key: hex(key), iv: hex(iv), decrypt: false, ops: [['update', hex(bytes(16))], ['update', hex(bytes(24))], ['update', ''], ['final']] });
    add({ cipher: name, key: hex(key), iv: hex(Buffer.from('a6a6a6a6a6a6a6a6', 'hex').subarray(0, info.ivLength)), decrypt: false, ops: [['update', hex(bytes(24))], ['final']] });
    continue;
  }
  if (mode === 'gcm' || mode === 'ccm' || name === 'chacha20-poly1305') {
    const ivs = mode === 'gcm' ? [12, 1, 60] : mode === 'ccm' ? [7, 12, 13] : [12];
    const tagLens = mode === 'gcm' ? [undefined, 4, 13] : mode === 'ccm' ? [4, 16] : [undefined, 1, 16];
    for (const ivl of ivs) {
      for (const tl of tagLens) {
        const iv = bytes(ivl);
        const opts = tl === undefined ? undefined : { authTagLength: tl };
        for (const [ptl, aadl] of [[0, 0], [1, 0], [16, 5], [70, 33]]) {
          const pt = bytes(ptl);
          const aad = hex(bytes(aadl));
          const pre = aadl ? [mode === 'ccm' ? ['aad', aad, ptl] : ['aad', aad]] : [];
          roundTrip(name, key, iv, opts, pt, mode === 'ccm' ? [ptl] : [7, 16, 1], { tag: true, pre });
        }
      }
    }
    // tag set after update (gcm/chacha); multiple AAD chunks; AAD after data
    const iv = bytes(mode === 'ccm' ? 12 : 12);
    const opts = mode === 'ccm' ? { authTagLength: 16 } : undefined;
    if (mode !== 'ccm') {
      roundTrip(name, key, iv, opts, bytes(33), [5, 20], { tag: true, pre: [['aad', hex(bytes(3))], ['aad', hex(bytes(20))]], tagAfter: true });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['update', '0011'], ['aad', '00'], ['update', ''], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['update', ''], ['aad', '00'], ['update', '00'], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['tag'], ['final'], ['tag'], ['final'], ['update', '00']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, decrypt: true, ops: [['update', '0102'], ['final']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, decrypt: true, ops: [['settag', hex(bytes(16))], ['settag', hex(bytes(16))]] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, decrypt: true, ops: [['settag', hex(bytes(12))], ['update', '00'], ['final']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['settag', hex(bytes(16))], ['pad', false], ['update', '00'], ['final'], ['tag']] });
    } else {
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['aad', '00']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['update', '0011'], ['update', '22'], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['aad', '0011', 3], ['update', '22'], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['aad', '0011', 3], ['aad', '0011', 3], ['update', '223344'], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, ops: [['update', ''], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, decrypt: true, ops: [['update', '0102'], ['final']] });
      add({ cipher: name, key: hex(key), iv: hex(iv), opts, decrypt: true, ops: [['final']] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(13)), opts, ops: [['zeros', 65536], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(13)), opts, ops: [['zeros', 65535], ['final'], ['tag']] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(13)), opts, ops: [['aad', '00', 65536]] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(12)), opts: { authTagLength: 5 }, ops: [] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(12)), ops: [] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(6)), opts, ops: [] });
      add({ cipher: name, key: hex(key), iv: hex(bytes(14)), opts, ops: [] });
    }
    add({ cipher: name, key: hex(key), iv: '', opts, ops: [] });
    add({ cipher: name, key: hex(bytes(info.keyLength + 1)), iv: hex(iv), opts, ops: [] });
    add({ cipher: name, key: hex(key), iv: hex(iv), opts: { authTagLength: 17 }, ops: [] });
    add({ cipher: name, key: hex(key), iv: hex(iv), opts: { authTagLength: 3 }, ops: [] });
    if (name === 'chacha20-poly1305') for (const l of [8, 11, 13]) add({ cipher: name, key: hex(key), iv: hex(bytes(l)), ops: [] });
    continue;
  }
  const iv = info.ivLength ? bytes(info.ivLength) : null;
  const block = mode === 'ecb' || mode === 'cbc';
  for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 100]) {
    roundTrip(name, key, iv, undefined, bytes(n), [1, 15, 16, 17, 3]);
    if (n % (info.blockSize || 1) === 0) roundTrip(name, key, iv, undefined, bytes(n), [5, 40], { pre: [['pad', false]] });
  }
  if (block) {
    const k = hex(key);
    const v = iv === null ? null : hex(iv);
    add({ cipher: name, key: k, iv: v, ops: [['pad', false], ['update', hex(bytes(info.blockSize + 3))], ['final']] });
    add({ cipher: name, key: k, iv: v, decrypt: true, ops: [['update', hex(bytes(info.blockSize * 2))], ['final']] });
    add({ cipher: name, key: k, iv: v, decrypt: true, ops: [['update', hex(bytes(info.blockSize + 1))], ['final']] });
    add({ cipher: name, key: k, iv: v, decrypt: true, ops: [['final']] });
    add({ cipher: name, key: k, iv: v, decrypt: true, ops: [['pad', false], ['final']] });
    add({ cipher: name, key: k, iv: v, decrypt: true, ops: [['pad', false], ['update', hex(bytes(3))], ['final']] });
    // a valid ciphertext of a block of 0x02 bytes → padding byte 2 → every possible bad-padding branch
    for (const fill of [0, 2, info.blockSize, info.blockSize + 1]) {
      const raw = crypto.createCipheriv(name, key, iv);
      raw.setAutoPadding(false);
      const pt = Buffer.alloc(info.blockSize, fill);
      if (fill === 2) pt[info.blockSize - 2] = 3;
      const ct = Buffer.concat([raw.update(pt), raw.final()]);
      add({ cipher: name, key: k, iv: v, decrypt: true, ops: [['update', hex(ct)], ['final']] });
    }
  }
  add({ cipher: name, key: hex(key), iv: iv === null ? null : hex(iv), ops: [['final'], ['final'], ['update', '00'], ['pad', false], ['tag'], ['aad', '00']] });
  add({ cipher: name, key: hex(bytes(info.keyLength - 1)), iv: iv === null ? null : hex(iv), ops: [] });
  add({ cipher: name, key: hex(key), iv: hex(bytes((info.ivLength || 0) + 1)), ops: [] });
  if (iv) add({ cipher: name, key: hex(key), iv: null, ops: [] });
  add({ cipher: name, key: hex(key), iv: iv === null ? null : hex(iv), ops: [['aad', '00'], ['update', '00'], ['settag', '00']] });
}
// names and strings
for (const name of ['AES-128-CBC', 'aes128', 'Aes-256-Ctr', 'id-aes128-GCM', 'ID-AES256-CCM', 'des3', 'DES-EDE3-CBC', 'foo', 'aes-128-xts', 'aes-128-ocb']) {
  const info = crypto.getCipherInfo(name);
  const key = bytes(info ? info.keyLength : 16);
  const iv = info?.ivLength ? bytes(info.ivLength) : null;
  add({ cipher: name, key: hex(key), iv: iv === null ? null : hex(iv), opts: info && /ccm/.test(info.mode) ? { authTagLength: 16 } : undefined, ops: [['update', hex(bytes(20))], ['final']] });
}
{
  const key = hex(bytes(16));
  const iv = hex(bytes(16));
  add({ cipher: 'aes-128-cbc', key, iv, ops: [['updateStr', 'héllo wörld, quite a long string', 'utf8', 'base64'], ['final', 'base64']] });
  add({ cipher: 'aes-128-cbc', key, iv, ops: [['updateStr', 'deadbeef00', 'hex', 'hex'], ['updateStr', 'abc', 'latin1', 'latin1'], ['final', 'hex']] });
  add({ cipher: 'aes-128-ctr', key, iv, ops: [['updateStr', 'abc', 'utf8', 'utf8'], ['updateStr', 'déf', undefined, 'utf8'], ['final', 'utf8']] });
}
out.cipher = scripts.map((s) => ({ ...s, results: runScript(s) }));

// getCipherInfo
out.cipherInfo = [];
for (const name of [...ciphersSupported, 'AES-128-CBC', 'foo', 419, 895, 1018, 44, 99999]) {
  for (const opts of [undefined, { keyLength: 16 }, { ivLength: 12 }, { ivLength: 7 }, { ivLength: 16 }, { ivLength: 1 }, { keyLength: 24, ivLength: 8 }]) {
    const r = crypto.getCipherInfo(name, opts);
    out.cipherInfo.push({ name, opts, result: r === undefined ? null : r });
  }
}

// -----------------------------------------------------------------------------
// misc

out.timingSafeEqual = [
  [{ hex: '0102' }, { hex: '0102' }], [{ hex: '0102' }, { hex: '0103' }], [{ hex: '' }, { hex: '' }], [{ hex: '01' }, { hex: '0102' }], ['ab', { hex: '0102' }], [{ hex: '0102' }, 5],
].map(([a, b]) => {
  const v = (x) => (x && x.hex !== undefined ? Buffer.from(x.hex, 'hex') : x);
  return { a, b, result: attempt(() => crypto.timingSafeEqual(v(a), v(b))) };
});

out.checkPrime = [];
for (const n of [0n, 1n, 2n, 3n, 4n, 17n, 561n, 7919n, 2n ** 61n - 1n, 2n ** 61n + 1n, 2n ** 127n - 1n, (2n ** 127n - 1n) * 3n, 2n ** 521n - 1n, 2n ** 521n + 1n, 1000000007n * 998244353n]) {
  out.checkPrime.push({ n: n.toString(), result: crypto.checkPrimeSync(n) });
}
out.generatePrimeErrors = [
  [1, {}], [2, { safe: true }], [10, { add: 2n ** 20n }], [10, { add: 12n, rem: 12n }], [10, { add: 12n, rem: 13n }],
].map(([size, opts]) => ({ size, opts: JSON.stringify(opts, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)), result: attempt(() => crypto.generatePrimeSync(size, opts).toString('hex')) }));

// last: a failed attempt to enable FIPS leaves OpenSSL unable to fetch some algorithms
out.lists.setFipsTrue = attempt(() => binding.setFipsCrypto(true));

writeFileSync(new URL('../unit/fixtures/crypto.json', import.meta.url), JSON.stringify(out));
console.log('hash', out.hash.length, 'hmac', out.hmac.length, 'cipher scripts', out.cipher.length);
