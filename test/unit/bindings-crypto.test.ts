// Differential tests for internalBinding('crypto'): fixtures recorded from real Node 22.20.0 by
// test/fixtures-gen/crypto.mjs, replayed here through copies of lib's thin wrappers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { StringDecoder } from 'node:string_decoder';
import { createCrypto } from '../../src/nodejs/bindings/crypto.ts';
import fixtures from './fixtures/crypto.json';

const fx: any = fixtures;
const b = createCrypto();
const kSync = b.kCryptoJobSync;
const kAsync = b.kCryptoJobAsync;

// The event loop's MessageChannel keeps the process alive; end the run explicitly.
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));

const hex = (v: any) => Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v).toString('hex');
const fromHex = (h: string) => Buffer.from(h, 'hex');
const errOf = (e: any) => ({ error: Object.fromEntries(Object.entries({ name: e.name, message: e.message, code: e.code, library: e.library, reason: e.reason }).filter(([, v]) => v !== undefined)) });
function attempt(f: () => any) {
  try {
    return f();
  } catch (e) {
    return errOf(e);
  }
}
const enc = (v: any) => (Buffer.isBuffer(v) ? { hex: hex(v) } : typeof v === 'string' ? { str: v } : v);
const libError = (code: string, message: string, Ctor: any = Error) => Object.assign(new Ctor(message), { code });
const invalidState = (op: string) => libError('ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${op}`);

// -----------------------------------------------------------------------------
// lib/internal/crypto/hash.js, reduced

const cache = b.getCachedAliases();
const cachedId = (alg: string) => cache[alg] ?? -1;

function createHash(alg: string, opts?: { outputLength?: number }) {
  const handle = new b.Hash(alg, opts?.outputLength, cachedId(alg), cache);
  return {
    handle,
    update(data: any, encoding?: string) {
      if (!handle.update(data, encoding)) throw libError('ERR_CRYPTO_HASH_UPDATE_FAILED', 'Hash update failed');
      return this;
    },
    digest: (o?: string) => handle.digest(o && `${o}`),
    copy() {
      const c = createHash.call(null, alg);
      return Object.assign(c, { handle: new b.Hash(handle, undefined, -1, cache) }, wrapHandle(new b.Hash(handle, undefined, -1, cache)));
    },
  };
}
function wrapHandle(handle: any) {
  return {
    update(data: any, encoding?: string) {
      handle.update(data, encoding);
      return this;
    },
    digest: (o?: string) => handle.digest(o && `${o}`),
  };
}

function createHmac(alg: string, key: Buffer) {
  const handle = new b.Hmac();
  handle.init(alg, key);
  let finalized = false;
  return {
    update(data: any, encoding?: string) {
      handle.update(data, encoding);
      return this;
    },
    digest(o?: string) {
      if (finalized) return o && o !== 'buffer' ? Buffer.from('').toString(o as BufferEncoding) : Buffer.from('');
      finalized = true;
      return handle.digest(o && `${o}`);
    },
  };
}

const encodingsMap: Record<string, number> = { ascii: 0, utf8: 1, base64: 2, utf16le: 3, latin1: 4, hex: 5, buffer: 6, base64url: 7 };
function oneShot(alg: string, input: any, o = 'hex') {
  let normalized = o;
  if (o !== 'hex') normalized = o === 'buffer' ? 'buffer' : (Buffer.isEncoding(o) ? ({ binary: 'latin1', ucs2: 'utf16le', 'utf-8': 'utf8' } as any)[o.toLowerCase()] ?? o.toLowerCase() : o);
  const lower = alg.toLowerCase();
  if (lower === 'shake128' || lower === 'shake256') return createHash(alg).update(input).digest(normalized);
  return b.oneShotDigest(alg, cachedId(alg), cache, input, normalized, encodingsMap[normalized]);
}

test('lists', () => {
  assert.deepEqual(b.getHashes(), fx.lists.hashes);
  const ours = b.getCiphers();
  assert.deepEqual(ours, fx.lists.ciphers.filter((n: string) => ours.includes(n)));
  assert.ok(ours.length >= 63);
  assert.deepEqual({ ...b.getCachedAliases() }, Object.fromEntries(Object.entries(fx.lists.aliases).filter(([k]) => k in cache)));
  assert.equal(b.getFipsCrypto(), fx.lists.fips);
  assert.equal(b.testFipsCrypto(), fx.lists.testFips);
  assert.equal(attempt(() => b.setFipsCrypto(true)), fx.lists.setFipsTrue);
  assert.equal(Object.getPrototypeOf(b.getCachedAliases()), null);
});

test('hashes', () => {
  for (const c of fx.hash) {
    const got = attempt(() => {
      const h = createHash(c.alg, c.xof === undefined ? undefined : { outputLength: c.xof });
      for (const [d, e] of c.chunks) h.update(e === 'buffer' ? fromHex(d) : d, e === 'buffer' ? undefined : e);
      return enc(h.digest(c.out));
    });
    assert.deepEqual(got, c.result, `${c.alg} xof=${c.xof} out=${c.out} ${JSON.stringify(c.chunks).slice(0, 80)}`);
  }
});

test('hash copy', () => {
  for (const c of fx.hashCopy) {
    const h = new b.Hash(c.alg, undefined, -1, cache);
    h.update('first part ');
    const d = new b.Hash(h, undefined, -1, cache);
    h.update('A');
    d.update('B');
    assert.equal(h.digest('hex'), c.a, c.alg);
    assert.equal(d.digest('hex'), c.b, c.alg);
  }
});

test('one-shot digest', () => {
  for (const c of fx.oneShot) {
    const input = typeof c.input === 'string' ? c.input : fromHex(c.input.hex);
    assert.deepEqual(attempt(() => enc(oneShot(c.alg, input, c.out))), c.result, c.alg);
  }
});

test('hmac', () => {
  for (const c of fx.hmac) {
    const key = c.keyIsString ? Buffer.from(c.key, 'utf8') : fromHex(c.key);
    const got = attempt(() => {
      const h = createHmac(c.alg, key);
      for (const [d, e] of c.data) h.update(d, e);
      return { hex: h.digest('hex') };
    });
    assert.deepEqual(got, c.result, `${c.alg} key=${c.key.length / 2}`);
  }
  const h = createHmac('sha256', Buffer.from('k'));
  assert.equal(h.digest('hex'), fx.hmacTwice.first);
  assert.equal(h.digest('hex'), fx.hmacTwice.second);
});

// -----------------------------------------------------------------------------
// KDFs (lib/internal/crypto/{pbkdf2,scrypt,hkdf}.js)

function runSync(job: any) {
  const [err, result] = job.run();
  if (err !== undefined) throw err;
  return result;
}

function runAsync(job: any): Promise<[any, any]> {
  return new Promise((resolve) => {
    const keepAlive = setTimeout(() => {}, 10000);
    job.ondone = (err: unknown, result: unknown) => {
      clearTimeout(keepAlive);
      resolve([err, result]);
    };
    assert.equal(job.run(), undefined);
  });
}

test('pbkdf2', async () => {
  for (const c of fx.pbkdf2) {
    const args = [fromHex(c.pass), fromHex(c.salt), c.iter, c.keylen, c.digest];
    const got = attempt(() => ({ hex: hex(runSync(new b.PBKDF2Job(kSync, ...args))) }));
    assert.deepEqual(got, c.result, JSON.stringify(c));
    if (!c.result.error) {
      const [err, res] = await runAsync(new b.PBKDF2Job(kAsync, ...args));
      assert.equal(err, undefined);
      assert.equal(hex(res), c.result.hex);
    }
  }
});

test('scrypt', async () => {
  for (const c of fx.scrypt) {
    let { N = 16384, r = 8, p = 1, maxmem = 32 << 20 } = c.opts;
    if (maxmem === 0) maxmem = 32 << 20;
    const args = [fromHex(c.pass), fromHex(c.salt), N, r, p, maxmem, c.keylen];
    const got = attempt(() => ({ hex: hex(runSync(new b.ScryptJob(kSync, ...args))) }));
    assert.deepEqual(got, c.result, JSON.stringify(c.opts));
    if (!c.result.error && N <= 1024) {
      const [err, res] = await runAsync(new b.ScryptJob(kAsync, ...args));
      assert.equal(err, undefined);
      assert.equal(hex(res), c.result.hex);
    }
  }
});

test('hkdf', async () => {
  const Native = b.createNativeKeyObjectClass((Base: any) => [class KeyObject extends Base {}])[0];
  for (const c of fx.hkdf) {
    const key = new b.KeyObjectHandle();
    key.init(0, fromHex(c.ikm));
    const keyObject = new Native(key);
    const got = attempt(() => ({ hex: hex(runSync(new b.HKDFJob(kSync, c.digest, keyObject, fromHex(c.salt), fromHex(c.info), c.len))) }));
    assert.deepEqual(got, c.result, JSON.stringify({ ...c, result: undefined }));
    if (!c.result.error) {
      const [err, res] = await runAsync(new b.HKDFJob(kAsync, c.digest, key, fromHex(c.salt), fromHex(c.info), c.len));
      assert.equal(err, undefined);
      assert.equal(hex(res), c.result.hex);
    }
  }
});

// -----------------------------------------------------------------------------
// ciphers (lib/internal/crypto/cipher.js, reduced)

function getUIntOption(options: any, key: string) {
  if (options && options[key] != null) return options[key];
  return -1;
}

function createCipherBase(encrypt: boolean, cipher: string, key: Buffer, iv: Buffer | null, options: any) {
  const handle = new b.CipherBase(encrypt);
  handle.initiv(cipher, key, iv, getUIntOption(options, 'authTagLength'));
  let decoder: StringDecoder | null = null;
  const getDecoder = (encoding: string) => {
    decoder ??= new StringDecoder(encoding as BufferEncoding);
    if ((decoder as any).encoding !== (new StringDecoder(encoding as BufferEncoding) as any).encoding) {
      const message = 'Cannot change encoding\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n';
      throw libError('ERR_INTERNAL_ASSERTION', message);
    }
    return decoder;
  };
  const self: any = {
    update(data: any, inputEncoding?: string, outputEncoding?: string) {
      const ret = handle.update(data, inputEncoding);
      if (outputEncoding && outputEncoding !== 'buffer') {
        return getDecoder(outputEncoding).write(ret);
      }
      return ret;
    },
    final(outputEncoding?: string) {
      const ret = handle.final();
      if (outputEncoding && outputEncoding !== 'buffer') {
        return getDecoder(outputEncoding).end(ret);
      }
      return ret;
    },
    setAutoPadding(ap: unknown) {
      if (!handle.setAutoPadding(!!ap)) throw invalidState('setAutoPadding');
      return self;
    },
    setAAD(aad: Buffer, options?: any) {
      if (!handle.setAAD(aad, getUIntOption(options, 'plaintextLength'))) throw invalidState('setAAD');
      return self;
    },
  };
  if (encrypt) {
    self.getAuthTag = () => {
      const ret = handle.getAuthTag();
      if (ret === undefined) throw invalidState('getAuthTag');
      return ret;
    };
  } else {
    self.setAuthTag = (tag: Buffer) => {
      if (!handle.setAuthTag(tag)) throw invalidState('setAuthTag');
      return self;
    };
  }
  return self;
}

function runScript(s: any) {
  const results: any[] = [];
  let c: any;
  const toB = (h: string | null) => (h === null ? null : fromHex(h));
  try {
    c = createCipherBase(!s.decrypt, s.cipher, toB(s.key)!, s.iv === null ? null : toB(s.iv), s.opts);
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
            return enc(c.update(fromHex(op[1])));
          case 'updateStr':
            return enc(c.update(op[1], op[2], op[3]));
          case 'zeros': {
            const r = c.update(Buffer.alloc(op[1]));
            const h = new b.Hash('sha256', undefined, -1, cache);
            h.update(r);
            return { sha256: h.digest('hex') };
          }
          case 'final':
            return enc(c.final(op[1]));
          case 'pad':
            c.setAutoPadding(op[1]);
            return 'ok';
          case 'aad':
            c.setAAD(fromHex(op[1]), op[2] === undefined ? undefined : { plaintextLength: op[2] });
            return 'ok';
          case 'tag':
            return enc(c.getAuthTag());
          case 'settag':
            c.setAuthTag(fromHex(op[1]));
            return 'ok';
        }
        throw new Error('bad op ' + op[0]);
      }),
    );
  }
  return results;
}

test('cipher scripts', () => {
  let failures = 0;
  const unsupported = new Set(['aes-128-xts', 'aes-128-ocb']);
  for (const s of fx.cipher) {
    if (unsupported.has(s.cipher)) continue;
    const got = runScript(s);
    try {
      assert.deepEqual(got, s.results);
    } catch (e) {
      if (++failures <= 10) console.log(JSON.stringify({ cipher: s.cipher, decrypt: !!s.decrypt, iv: s.iv, opts: s.opts, ops: s.ops.map((o: any) => [o[0], String(o[1] ?? '').slice(0, 40), o[2]]) }), '\n got ', JSON.stringify(got).slice(0, 600), '\n want', JSON.stringify(s.results).slice(0, 600));
    }
  }
  assert.equal(failures, 0, `${failures} cipher scripts differ`);
});

test('getCipherInfo', () => {
  for (const c of fx.cipherInfo) {
    if (c.name === 'aes-128-xts') continue;
    const ret = b.getCipherInfo({}, c.name, c.opts?.keyLength, c.opts?.ivLength);
    if (ret) {
      ret.name &&= ret.name.toLowerCase();
    }
    assert.deepEqual(ret ?? null, c.result, `${c.name} ${JSON.stringify(c.opts)}`);
  }
});

// -----------------------------------------------------------------------------
// misc

test('timingSafeEqual', () => {
  const v = (x: any) => (x && x.hex !== undefined ? fromHex(x.hex) : x);
  for (const c of fx.timingSafeEqual) assert.deepEqual(attempt(() => b.timingSafeEqual(v(c.a), v(c.b))), c.result);
});

function bigToBuf(n: bigint) {
  const h = n.toString(16);
  return Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
}

test('checkPrime / generatePrime', async () => {
  for (const c of fx.checkPrime) {
    assert.equal(runSync(new b.CheckPrimeJob(kSync, bigToBuf(BigInt(c.n)), 0)), c.result, c.n);
  }
  const [err, res] = await runAsync(new b.CheckPrimeJob(kAsync, bigToBuf(2n ** 127n - 1n), 0));
  assert.deepEqual([err, res], [undefined, true]);
  for (const c of fx.generatePrimeErrors) {
    const o = JSON.parse(c.opts, (_k, v) => (typeof v === 'string' && v.endsWith('n') ? BigInt(v.slice(0, -1)) : v));
    const got = attempt(() => runSync(new b.RandomPrimeJob(kSync, c.size, !!o.safe, o.add === undefined ? undefined : bigToBuf(o.add), o.rem === undefined ? undefined : bigToBuf(o.rem))));
    if (c.result.error) assert.deepEqual(got, c.result, c.opts);
    else assert.ok(got instanceof ArrayBuffer, c.opts);
  }
  for (const [bits, safe, add, rem] of [[16, false], [64, false], [64, true], [256, false], [32, false, 12n, 5n], [32, true, 12n, 11n]] as [number, boolean, bigint?, bigint?][]) {
    const p = BigInt('0x' + hex(runSync(new b.RandomPrimeJob(kSync, bits, safe, add && bigToBuf(add), rem && bigToBuf(rem)))));
    assert.equal(p.toString(2).length, bits);
    assert.ok(runSync(new b.CheckPrimeJob(kSync, bigToBuf(p), 0)));
    if (safe) assert.ok(runSync(new b.CheckPrimeJob(kSync, bigToBuf((p - 1n) / 2n), 0)));
    if (add) assert.equal(p % add, rem);
  }
});

test('random bytes', async () => {
  const buf = new Uint8Array(100);
  assert.deepEqual(new b.RandomBytesJob(kSync, buf, 10, 50).run(), [undefined, undefined]);
  assert.ok(buf.subarray(10, 60).some((x) => x !== 0));
  assert.ok(buf.subarray(0, 10).every((x) => x === 0) && buf.subarray(60).every((x) => x === 0));
  const ab = new ArrayBuffer(70000);
  const [err] = await runAsync(new b.RandomBytesJob(kAsync, ab, 0, 70000));
  assert.equal(err, undefined);
  assert.ok(new Uint8Array(ab).subarray(65530).some((x) => x !== 0));
  const sb = b.secureBuffer(16);
  assert.ok(sb instanceof Uint8Array && sb.length === 16);
  assert.equal(b.secureHeapUsed(), undefined);
});

test('secret keys', async () => {
  const h = new b.KeyObjectHandle();
  h.init(0, Buffer.from('secret!'));
  assert.equal(h.getSymmetricKeySize(), 7);
  assert.equal(hex(h.export()), Buffer.from('secret!').toString('hex'));
  assert.ok(Buffer.isBuffer(h.export()));
  assert.deepEqual(h.exportJwk({}, false), { kty: 'oct', k: 'c2VjcmV0IQ' });
  assert.deepEqual(h.keyDetail({}), { length: 56 });
  const j = new b.KeyObjectHandle();
  assert.equal(j.initJwk({ kty: 'oct', k: 'c2VjcmV0IQ' }), 0);
  assert.ok(h.equals(j));
  assert.throws(() => new b.KeyObjectHandle().initJwk({ kty: 'oct' }), { code: 'ERR_CRYPTO_INVALID_JWK', message: 'Invalid JWK secret key format' });
  const [err, key] = await runAsync(new b.SecretKeyGenJob(kAsync, 256));
  assert.equal(err, undefined);
  assert.equal(key.getSymmetricKeySize(), 32);
  // a KeyObjectHandle works as a cipher / hmac key
  const c = createCipherBase(true, 'aes-256-ecb', key, null, undefined);
  assert.equal(Buffer.concat([c.update(Buffer.alloc(16)), c.final()]).length, 32);
  const m = new b.Hmac();
  m.init('sha256', key);
  assert.equal(m.digest().length, 32);
});

test('webcrypto jobs: HashJob / HmacJob', async () => {
  const [e1, d] = await runAsync(new b.HashJob(kAsync, 'sha256', Buffer.from('abc')));
  assert.equal(e1, undefined);
  assert.equal(hex(d), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(runSync(new b.HashJob(kSync, 'shake256', Buffer.from(''), 64))), '46b9dd2b0ba88d13');
  assert.throws(() => new b.HashJob(kSync, 'sha256', Buffer.from(''), 64), { code: 'ERR_CRYPTO_INVALID_DIGEST', message: 'Digest method not supported' });
  const key = new b.KeyObjectHandle();
  key.init(0, Buffer.from('key'));
  const mac = runSync(new b.HmacJob(kSync, 0, 'sha256', key, Buffer.from('The quick brown fox jumps over the lazy dog')));
  assert.equal(hex(mac), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.equal(runSync(new b.HmacJob(kSync, 1, 'sha256', key, Buffer.from('The quick brown fox jumps over the lazy dog'), mac)), true);
  assert.equal(runSync(new b.HmacJob(kSync, 1, 'sha256', key, Buffer.from('x'), mac)), false);
});
