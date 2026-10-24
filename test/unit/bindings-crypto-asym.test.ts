// Differential tests for the asymmetric half of internalBinding('crypto'): fixtures from
// test/fixtures-gen/crypto-asym.mjs (real Node (the pinned version)), driven the way lib/internal/crypto does.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCrypto } from '../../src/nodejs/bindings/crypto.ts';
import fixtures from './fixtures/crypto-asym.json';

const fx: any = fixtures;
const b = createCrypto();
const kSync = b.kCryptoJobSync;
const kAsync = b.kCryptoJobAsync;

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
const ser = (v: any) => (Buffer.isBuffer(v) ? { hex: hex(v) } : typeof v === 'bigint' ? { bigint: v.toString() } : v);

function runSync(job: any) {
  const [err, result] = job.run();
  if (err !== undefined) throw err;
  return result;
}
function runAsync(job: any): Promise<[any, any]> {
  return new Promise((resolve) => {
    const keepAlive = setTimeout(() => {}, 60000);
    job.ondone = (err: unknown, result: unknown) => {
      clearTimeout(keepAlive);
      resolve([err, result]);
    };
    job.run();
  });
}

// -----------------------------------------------------------------------------
// lib/internal/crypto/keys.js, reduced

const FORMAT: Record<string, number> = { der: 0, pem: 1, jwk: 2 };
const TYPE: Record<string, number> = { pkcs1: 0, pkcs8: 1, spki: 2, sec1: 3 };

function importKey(kind: 'public' | 'private', enc: any, value: any) {
  const h = new b.KeyObjectHandle();
  if (enc.format === 'jwk') {
    const jwk = value;
    const isPublic = kind === 'public';
    if (jwk.kty === 'OKP') {
      const data = Buffer.from(isPublic ? jwk.x : jwk.d, 'base64');
      assert.ok(h.initEDRaw(jwk.crv, data, isPublic ? 1 : 2));
      return h;
    }
    const pick: any = jwk.kty === 'EC' ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: jwk.kty, n: jwk.n, e: jwk.e };
    if (!isPublic) for (const f of jwk.kty === 'EC' ? ['d'] : ['d', 'p', 'q', 'dp', 'dq', 'qi']) pick[f] = jwk[f];
    assert.notEqual(h.initJwk(pick, jwk.crv), undefined);
    return h;
  }
  const data = typeof value === 'string' ? Buffer.from(value) : fromHex(value.hex);
  h.init(kind === 'public' ? 1 : 2, data, FORMAT[enc.format], enc.type === undefined ? undefined : TYPE[enc.type], undefined);
  return h;
}

function exportKey(h: any, kind: 'public' | 'private', enc: any) {
  if (enc.format === 'jwk') return h.exportJwk({}, false);
  return kind === 'public' ? h.export(FORMAT[enc.format], TYPE[enc.type]) : h.export(FORMAT[enc.format], TYPE[enc.type], undefined, undefined);
}

function details(h: any) {
  const t = h.getAsymmetricKeyType();
  if (!['rsa', 'rsa-pss', 'ec', 'dsa'].includes(t)) return {};
  const d = h.keyDetail({});
  if (d.publicExponent !== undefined) d.publicExponent = { bigint: BigInt('0x' + hex(d.publicExponent)).toString() };
  return d;
}

test('key import / export round trips', () => {
  for (const k of fx.keys) {
    const label = `${k.type} ${JSON.stringify(k.opts)}`;
    for (const kind of ['public', 'private'] as const) {
      const list = kind === 'public' ? k.public : k.private;
      for (const src of list) {
        if (src.result.error) continue;
        // a JWK names its curve: the key it makes is no longer the explicit-parameters one
        if (src.enc.format === 'jwk' && k.opts.paramEncoding === 'explicit') continue;
        const h = importKey(kind, src.enc, src.result);
        assert.equal(h.getAsymmetricKeyType(), k.asymmetricKeyType, label);
        assert.deepEqual(details(h), kind === 'public' ? k.publicDetails : k.privateDetails, label);
        for (const dst of list) {
          // errors raised by lib's option parsing never reach the binding
          if (dst.result.error && !dst.result.error.message.startsWith('Unsupported JWK')) continue;
          const got = attempt(() => ser(exportKey(h, kind, dst.enc)));
          assert.deepEqual(got, dst.result, `${label} ${kind} ${JSON.stringify(src.enc)} -> ${JSON.stringify(dst.enc)}`);
        }
      }
    }
    const priv = importKey('private', k.private[1].enc, k.private[1].result);
    const pub = new b.KeyObjectHandle();
    pub.init(1, fromHex(k.private[1].result.hex), 0, 1, undefined);
    assert.equal(hex(pub.export(0, 2)), k.publicFromPrivate, label);
    const pub2 = importKey('public', k.public[1].enc, k.public[1].result);
    assert.equal(pub2.equals(pub), k.equals);
    assert.ok(priv.equals(importKey('private', k.private[0].enc, k.private[0].result)));
  }
});

test('encrypted private keys', () => {
  for (const e of fx.encrypted) {
    for (const [value, format] of [[e.pem, 1], [fromHex(e.der), 0]] as const) {
      const h = new b.KeyObjectHandle();
      h.init(2, typeof value === 'string' ? Buffer.from(value) : value, format, 1, Buffer.from('top secret'));
      assert.equal(hex(h.export(0, 1, undefined, undefined)), e.plain, e.cipher);
    }
    // our own encryption round-trips
    const h = new b.KeyObjectHandle();
    h.init(2, fromHex(e.plain), 0, 1, undefined);
    for (const format of [0, 1]) {
      const out = h.export(format, 1, e.cipher, Buffer.from('pw'));
      if (format === 1) assert.match(out, /^-----BEGIN ENCRYPTED PRIVATE KEY-----\n/);
      const back = new b.KeyObjectHandle();
      back.init(2, typeof out === 'string' ? Buffer.from(out) : out, format, 1, Buffer.from('pw'));
      assert.equal(hex(back.export(0, 1, undefined, undefined)), e.plain);
    }
  }
  {
    const h = new b.KeyObjectHandle();
    h.init(2, Buffer.from(fx.encryptedLegacy.pem), 1, undefined, Buffer.from('top secret'));
    assert.equal(hex(h.export(0, 1, undefined, undefined)), fx.encryptedLegacy.plain);
    const pem = h.export(1, 3, 'aes-256-cbc', Buffer.from('pw'));
    assert.match(pem, /Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,[0-9A-F]{32}\n\n/);
    const back = new b.KeyObjectHandle();
    back.init(2, Buffer.from(pem), 1, undefined, Buffer.from('pw'));
    assert.equal(hex(back.export(0, 1, undefined, undefined)), fx.encryptedLegacy.plain);
  }
  assert.deepEqual(attempt(() => new b.KeyObjectHandle().init(2, Buffer.from(fx.encrypted[0].pem), 1, undefined, undefined)), fx.encryptedErrors.noPassphrase);
  assert.deepEqual(attempt(() => new b.KeyObjectHandle().init(2, Buffer.from(fx.encrypted[0].pem), 1, undefined, Buffer.from('wrong'))), fx.encryptedErrors.wrongPassphrase);
});

test('key parse errors', () => {
  for (const c of fx.parseErrors) {
    const h = new b.KeyObjectHandle();
    const got = attempt(() => {
      if (c.kind === 'public') h.init(1, Buffer.from(c.input), 1, undefined, undefined);
      else if (c.kind === 'private') h.init(2, Buffer.from(c.input), 1, undefined, undefined);
      else if (c.kind === 'publicDer') h.init(1, fromHex(c.input), 0, 2, undefined);
      else h.init(2, fromHex(c.input), 0, 1, undefined);
      return h.getAsymmetricKeyType();
    });
    assert.deepEqual(got, c.result, `${c.kind} ${c.input}`);
  }
});

// -----------------------------------------------------------------------------
// signatures (lib/internal/crypto/sig.js)

function privHandleFor(type: string, opts: any) {
  const k = fx.keys.find((x: any) => x.type === type && JSON.stringify(x.opts) === JSON.stringify(opts));
  const h = new b.KeyObjectHandle();
  h.init(2, fromHex(k.private[1].result.hex), 0, 1, undefined);
  return h;
}

const sigArgs = (o: any) => [o.saltLength, o.padding, o.dsaEncoding === 'ieee-p1363' ? 1 : 0];

function signOneShot(alg: string | null, data: Buffer, key: any, o: any) {
  const [salt, padding, dsa] = sigArgs(o);
  return hex(runSync(new b.SignJob(kSync, b.kSignJobModeSign, key, undefined, undefined, undefined, data, alg ?? undefined, salt, padding, dsa)));
}
function verifyOneShot(alg: string | null, data: Buffer, key: any, o: any, sig: Buffer) {
  const [salt, padding, dsa] = sigArgs(o);
  return runSync(new b.SignJob(kSync, b.kSignJobModeVerify, key, undefined, undefined, undefined, data, alg ?? undefined, salt, padding, dsa, sig));
}

const message = Buffer.from('The quick brown fox jumps over the lazy dog');

test('signatures', async () => {
  for (const s of fx.signatures) {
    const label = `${s.type} ${JSON.stringify(s.opts)} ${s.alg} ${JSON.stringify(s.sigOpts)}`;
    const key = privHandleFor(s.type, s.opts);
    const deterministic = s.type.startsWith('ed') || (s.type === 'rsa' && s.sigOpts.padding === undefined);
    const ours = attempt(() => signOneShot(s.alg, message, key, s.sigOpts));
    if (s.sig.error) {
      assert.deepEqual(ours, s.sig, label);
      continue;
    }
    if (deterministic) assert.equal(ours, s.sig, label);
    assert.equal(verifyOneShot(s.alg, message, key, s.sigOpts, fromHex(s.sig)), true, label + ' (verify Node signature)');
    assert.equal(verifyOneShot(s.alg, message, key, s.sigOpts, fromHex(ours)), true, label + ' (verify own signature)');
    assert.equal(verifyOneShot(s.alg, Buffer.from('other'), key, s.sigOpts, fromHex(s.sig)), false, label + ' (wrong message)');
    if (s.streamSig !== undefined) {
      const [salt, padding, dsa] = sigArgs(s.sigOpts);
      const signer = new b.Sign();
      signer.init(s.alg);
      signer.update(message.subarray(0, 5));
      signer.update(message.subarray(5));
      const got = attempt(() => hex(signer.sign(key, undefined, undefined, undefined, padding, salt, dsa)));
      if (s.streamSig.error) assert.deepEqual(got, s.streamSig, label + ' stream');
      else {
        if (deterministic) assert.equal(got, s.streamSig, label + ' stream');
        const v = new b.Verify();
        v.init(s.alg);
        v.update(message);
        assert.equal(v.verify(key, undefined, undefined, undefined, fromHex(s.streamSig), padding, salt, dsa), true, label + ' stream verify');
      }
    }
  }
  const ed = privHandleFor('ed25519', {});
  const [err, sig] = await runAsync(new b.SignJob(kAsync, 0, ed, undefined, undefined, undefined, message, undefined, undefined, undefined, 0));
  assert.equal(err, undefined);
  assert.equal(sig.byteLength, 64);
  const signer = new b.Sign();
  signer.init('sha256');
  signer.update('x');
  assert.deepEqual(attempt(() => signer.sign(ed, undefined, undefined, undefined, undefined, undefined, 0)), fx.signErrors.edStream);
  assert.deepEqual(attempt(() => new b.Sign().init('nope')), fx.signErrors.unknownDigest);
  assert.deepEqual(attempt(() => new b.SignJob(kSync, 0, ed, undefined, undefined, undefined, message, 'nope', undefined, undefined, 0)), fx.signErrors.oneShotUnknownDigest);
  const ec = privHandleFor('ec', { namedCurve: 'P-256' });
  assert.equal(verifyOneShot('sha256', message, ec, { dsaEncoding: 'ieee-p1363' }, Buffer.alloc(10)), fx.signErrors.p1363Malformed);
});

// -----------------------------------------------------------------------------
// ECDH and stateless DH (lib/internal/crypto/diffiehellman.js)

test('ECDH', () => {
  for (const c of fx.ecdh) {
    const a = new b.ECDH(c.curve);
    a.setPrivateKey(fromHex(c.aPriv));
    assert.equal(hex(a.getPrivateKey()), c.aPriv);
    assert.equal(hex(a.getPublicKey(4)), c.aPub);
    assert.equal(hex(a.getPublicKey(2)), c.aPubCompressed);
    assert.equal(hex(a.getPublicKey(6)), c.aPubHybrid);
    assert.equal(hex(a.computeSecret(fromHex(c.bPub))), c.secret);
    assert.equal(hex(a.computeSecret(fromHex(c.aPubHybrid.replace(/^0[67]/, '04')))), hex(a.computeSecret(fromHex(c.aPub))));
    assert.equal(hex(b.ECDHConvertKey(fromHex(c.aPubCompressed), c.curve, 4)), c.convert);
    const bad = a.computeSecret(fromHex('04' + '11'.repeat(fromHex(c.aPub).length - 1)));
    assert.equal(bad, 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY');
    const g = new b.ECDH(c.curve);
    g.generateKeys();
    const peer = new b.ECDH(c.curve);
    peer.setPrivateKey(fromHex(c.bPriv));
    assert.equal(hex(g.computeSecret(peer.getPublicKey(4))), hex(peer.computeSecret(g.getPublicKey(2))));
  }
  assert.deepEqual(attempt(() => new b.ECDH('nope')), fx.ecdhErrors.badCurve);
  assert.deepEqual(attempt(() => new b.ECDH('prime256v1').setPrivateKey(Buffer.alloc(32))), fx.ecdhErrors.badPrivate);
  assert.throws(() => new b.ECDH('prime256v1').getPublicKey(4), { code: 'ERR_CRYPTO_OPERATION_FAILED' });
});

test('stateless DH', () => {
  for (const c of fx.dh) {
    const priv = new b.KeyObjectHandle();
    priv.init(2, fromHex(c.aPriv), 0, 1, undefined);
    const pub = new b.KeyObjectHandle();
    pub.init(1, fromHex(c.bPub), 0, 2, undefined);
    assert.equal(hex(b.statelessDH(priv, pub)), c.secret, c.type);
  }
});

// -----------------------------------------------------------------------------
// RSA encryption (lib/internal/crypto/cipher.js rsaFunctionFor)

test('RSA public-key ciphers', () => {
  const r = fx.rsaEnc;
  const key = new b.KeyObjectHandle();
  key.init(2, fromHex(r.key), 0, 1, undefined);
  const pub = new b.KeyObjectHandle();
  pub.init(1, fromHex(r.key), 0, 1, undefined);
  const call = (fn: any, k: any, buf: Buffer, o: any) => fn(k, undefined, undefined, undefined, buf, o.padding, o.oaepHash, o.oaepLabel === undefined ? undefined : fromHex(o.oaepLabel));
  for (const c of r.cases) {
    assert.deepEqual(attempt(() => hex(call(b.privateDecrypt, key, fromHex(c.ct), c.opts))), c.decrypted, JSON.stringify(c.opts));
    const ours = call(b.publicEncrypt, pub, message, c.opts);
    assert.equal(hex(call(b.privateDecrypt, key, ours, c.opts)), hex(message));
  }
  assert.equal(hex(b.privateEncrypt(key, undefined, undefined, undefined, message, 1)), r.privateEncrypt);
  assert.equal(hex(b.publicDecrypt(pub, undefined, undefined, undefined, fromHex(r.privateEncrypt), 1)), hex(message));
  assert.equal(hex(b.privateEncrypt(key, undefined, undefined, undefined, Buffer.alloc(128, 7), 3)), r.privateEncryptNoPad);
  assert.deepEqual(attempt(() => b.publicDecrypt(pub, undefined, undefined, undefined, Buffer.alloc(128, 1), 1)), r.publicDecryptBad);
  assert.deepEqual(attempt(() => b.publicEncrypt(pub, undefined, undefined, undefined, Buffer.alloc(100), 4)), r.oaepTooLong);
  assert.deepEqual(attempt(() => b.privateDecrypt(key, undefined, undefined, undefined, Buffer.alloc(128, 1), 4)), r.privateDecryptBad);
});

// -----------------------------------------------------------------------------
// key pair generation (lib/internal/crypto/keygen.js)

test('key pair generation', async () => {
  const pemEnc = [1, 2, 1, 1, undefined, undefined];
  for (const [Job, args] of [
    [b.NidKeyPairGenJob, [b.EVP_PKEY_ED25519]],
    [b.NidKeyPairGenJob, [b.EVP_PKEY_X25519]],
    [b.NidKeyPairGenJob, [b.EVP_PKEY_ED448]],
    [b.NidKeyPairGenJob, [b.EVP_PKEY_X448]],
    [b.EcKeyPairGenJob, ['P-256', 1]],
    [b.EcKeyPairGenJob, ['secp384r1', 1]],
    [b.EcKeyPairGenJob, ['secp256k1', 1]],
    [b.RsaKeyPairGenJob, [0, 1024, 0x10001]],
    [b.RsaKeyPairGenJob, [1, 1024, 3, 'sha256', undefined, undefined]],
  ] as [any, any[]][]) {
    const [pubH, privH] = runSync(new Job(kSync, ...args, undefined, undefined, undefined, undefined, undefined, undefined));
    assert.ok(pubH instanceof b.KeyObjectHandle && privH instanceof b.KeyObjectHandle);
    const derived = new b.KeyObjectHandle();
    derived.init(1, privH.export(0, 1, undefined, undefined), 0, 1, undefined);
    assert.ok(derived.equals(pubH));
    const [err, pair] = await runAsync(new Job(kAsync, ...args, ...pemEnc));
    assert.equal(err, undefined, `${Job.name} ${args}`);
    const [pubPem, privPem] = pair;
    assert.match(pubPem, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.match(privPem, /^-----BEGIN PRIVATE KEY-----\n/);
    const reread = new b.KeyObjectHandle();
    reread.init(2, Buffer.from(privPem), 1, undefined, undefined);
    const t = reread.getAsymmetricKeyType();
    if (t !== 'x25519' && t !== 'x448') {
      const sig = signOneShot(t.startsWith('ed') ? null : 'sha256', message, reread, {});
      const pk = new b.KeyObjectHandle();
      pk.init(1, Buffer.from(pubPem), 1, undefined, undefined);
      assert.equal(verifyOneShot(t.startsWith('ed') ? null : 'sha256', message, pk, {}, fromHex(sig)), true, t);
    }
  }
  const [, rsaPss] = runSync(new b.RsaKeyPairGenJob(kSync, 1, 1024, 0x10001, 'sha512', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined));
  assert.deepEqual(details(rsaPss), { modulusLength: 1024, publicExponent: { bigint: '65537' }, hashAlgorithm: 'sha512', mgf1HashAlgorithm: 'sha512', saltLength: 64 });
  assert.throws(() => new b.EcKeyPairGenJob(kSync, 'nope', 1), { code: 'ERR_CRYPTO_INVALID_CURVE' });
  assert.throws(() => new b.RsaKeyPairGenJob(kSync, 1, 1024, 3, 'nope', undefined, undefined), { code: 'ERR_CRYPTO_INVALID_DIGEST', message: 'Invalid digest: nope' });
  // JWK output
  const [jwkPub, jwkPriv] = runSync(new b.NidKeyPairGenJob(kSync, b.EVP_PKEY_ED25519, 2, undefined, 2, undefined, undefined, undefined));
  assert.equal(jwkPub.kty, 'OKP');
  assert.equal(typeof jwkPriv.d, 'string');
});

test('DiffieHellman', () => {
  for (const g of fx.dhGroups) {
    const grp = new b.DiffieHellmanGroup(g.group);
    assert.equal(grp.verifyError, g.verifyError);
    assert.equal(hex(grp.getGenerator()), g.gen);
    assert.equal(hex(grp.getPrime()).slice(0, 16), g.prime);
    const a = new b.DiffieHellman(grp.getPrime(), 2);
    a.setPrivateKey(fromHex(g.priv));
    assert.equal(hex(a.generateKeys()), g.pub, g.group);
    assert.equal(a.verifyError, g.customVerifyError);
    const r1 = new b.DiffieHellmanGroup(g.group);
    const r2 = new b.DiffieHellmanGroup(g.group);
    if (g.group === 'modp1' || g.group === 'modp14') assert.equal(hex(r1.computeSecret(r2.generateKeys().length ? (r1.generateKeys(), r2.getPublicKey()) : null)), hex(r2.computeSecret(r1.getPublicKey())));
  }
  for (const c of fx.dhCustom) {
    const got = attempt(() => {
      const d = new b.DiffieHellman(fromHex(c.p), typeof c.g === 'string' ? fromHex(c.g) : c.g);
      return { verifyError: d.verifyError, gen: hex(d.getGenerator()), prime: hex(d.getPrime()) };
    });
    assert.deepEqual(got, c.result, `${c.p.slice(0, 8)} ${c.g}`);
  }
  const e = fx.dhErrors;
  const modp1 = new b.DiffieHellmanGroup('modp1').getPrime();
  assert.deepEqual(attempt(() => new b.DiffieHellmanGroup('nope')), e.unknownGroup);
  assert.deepEqual(attempt(() => new b.DiffieHellman(1, 2)), e.smallPrime);
  assert.deepEqual(attempt(() => new b.DiffieHellman(100, 2)), e.smallPrime2);
  assert.deepEqual(attempt(() => new b.DiffieHellman(modp1, 1)), e.badGenerator);
  assert.deepEqual(attempt(() => new b.DiffieHellman(modp1, fromHex('01'))), e.badGeneratorBuf);
  assert.deepEqual(attempt(() => new b.DiffieHellmanGroup('modp1').getPublicKey()), e.noPublic);
  assert.deepEqual(attempt(() => new b.DiffieHellmanGroup('modp1').getPrivateKey()), e.noPrivate);
  const g = new b.DiffieHellman(modp1, 2);
  g.setPrivateKey(Buffer.from('0123456789abcdef'.repeat(4), 'hex'));
  g.generateKeys();
  const p = BigInt('0x' + hex(modp1));
  const big = (n: bigint) => Buffer.from(n.toString(16).padStart(192, '0'), 'hex');
  assert.deepEqual(attempt(() => g.computeSecret(big(1n))), e.secretOne);
  assert.deepEqual(attempt(() => g.computeSecret(big(p - 1n))), e.secretPm1);
  assert.deepEqual(attempt(() => g.computeSecret(big(p))), e.secretP);
  assert.equal(hex(g.computeSecret(big(2n))), e.secretSmall);
  const gen = new b.DiffieHellman(512, 2);
  assert.equal(gen.getPrime().length, 64);
  assert.equal(gen.verifyError, 0);
});

test('WebCrypto jobs', async () => {
  const w = fx.webcrypto;
  const secret = (h: string) => {
    const k = new b.KeyObjectHandle();
    k.init(0, fromHex(h));
    return k;
  };
  const data = Buffer.from('webcrypto test data, a bit longer than one block');
  const variant = (mode: string, bits: number) => b[`kKeyVariantAES_${mode}_${bits}`];
  const job = async (J: any, ...args: any[]) => {
    const [err, res] = await runAsync(new J(kAsync, ...args));
    if (err) throw err;
    return res;
  };
  for (const g of w.gcm) {
    const key = secret(g.key);
    const bits = g.key.length * 4;
    const aad = g.aad === null ? undefined : Buffer.from(g.aad);
    const ct = await job(b.AESCipherJob, 0, key, data, variant('GCM', bits), fromHex(g.iv), g.tagLength / 8, aad);
    assert.equal(hex(ct), g.ct);
    const full = fromHex(g.ct);
    const tl = g.tagLength / 8;
    const pt = await job(b.AESCipherJob, 1, key, full.subarray(0, -tl), variant('GCM', bits), fromHex(g.iv), full.subarray(-tl), aad);
    assert.equal(Buffer.from(pt).toString(), data.toString());
    const bad = Buffer.from(full.subarray(-tl));
    bad[0] ^= 1;
    await assert.rejects(job(b.AESCipherJob, 1, key, full.subarray(0, -tl), variant('GCM', bits), fromHex(g.iv), bad, aad), { message: 'Cipher job failed' });
  }
  const k16 = '000102030405060708090a0b0c0d0e0f';
  const iv16 = fromHex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
  assert.equal(hex(await job(b.AESCipherJob, 0, secret(k16 + k16), data, variant('CBC', 256), iv16)), w.cbc);
  assert.equal(Buffer.from(await job(b.AESCipherJob, 1, secret(k16 + k16), fromHex(w.cbc), variant('CBC', 256), iv16)).toString(), data.toString());
  for (const c of w.ctr) {
    const got = await job(b.AESCipherJob, 0, secret(k16), data.subarray(0, 48), variant('CTR', 128), fromHex(c.counter), c.length).then(hex, () => ({ error: 'OperationError' }));
    assert.deepEqual(got, c.ct, `ctr length ${c.length}`);
  }
  assert.equal(hex(await job(b.AESCipherJob, 0, secret(k16), fromHex(k16 + k16), variant('KW', 128))), w.kw);
  assert.equal(hex(await job(b.AESCipherJob, 1, secret(k16), fromHex(w.kw), variant('KW', 128))), k16 + k16);
  // ECDH / X25519
  const ecA = fx.dh.find((d: any) => d.type === 'ec');
  const xA = fx.dh.find((d: any) => d.type === 'x25519');
  const imp = (der: string, type: number) => {
    const h = new b.KeyObjectHandle();
    h.init(type === 2 ? 1 : 2, fromHex(der), 0, type, undefined);
    return h;
  };
  assert.equal(hex(await job(b.ECDHBitsJob, imp(ecA.bPub, 2), imp(ecA.aPriv, 1))), w.ecdh);
  assert.equal(hex(await job(b.ECDHBitsJob, imp(xA.bPub, 2), imp(xA.aPriv, 1))), w.x25519);
  assert.equal(hex(await job(b.ECKeyExportJob, 0, imp(ecA.bPub, 2))), w.ecRaw);
  assert.equal(hex(await job(b.ECKeyExportJob, 2, imp(ecA.bPub, 2))), ecA.bPub);
  assert.equal(hex(await job(b.ECKeyExportJob, 1, imp(ecA.aPriv, 1))), ecA.aPriv);
  // RSA-OAEP and RSA exports
  const rsaK = fx.keys.find((x: any) => x.type === 'rsa' && x.opts.modulusLength === 1024);
  const rsaPriv = imp(rsaK.private[1].result.hex, 1);
  assert.equal(Buffer.from(await job(b.RSACipherJob, 1, rsaPriv, fromHex(w.oaep), b.kKeyVariantRSA_OAEP, 'sha256', Buffer.from('L'))).toString(), data.toString());
  const ours = await job(b.RSACipherJob, 0, imp(rsaK.public[1].result.hex, 2), data, b.kKeyVariantRSA_OAEP, 'sha256', Buffer.from('L'));
  assert.equal(Buffer.from(await job(b.RSACipherJob, 1, rsaPriv, ours, b.kKeyVariantRSA_OAEP, 'sha256', Buffer.from('L'))).toString(), data.toString());
  assert.equal(hex(await job(b.RSAKeyExportJob, 2, imp(rsaK.public[1].result.hex, 2), 2)), w.rsaSpki);
  assert.equal(hex(await job(b.RSAKeyExportJob, 1, rsaPriv, 2)), w.rsaPkcs8);
});

test('createNativeKeyObjectClass', () => {
  const [KeyObject] = b.createNativeKeyObjectClass((Native: any) => {
    class KeyObject extends Native {
      constructor(handle: any) {
        super(handle);
      }
    }
    return [KeyObject, class {}, class {}, class {}];
  });
  const h = new b.KeyObjectHandle();
  h.init(0, Buffer.from('k'));
  assert.ok(new KeyObject(h));
  assert.throws(() => new KeyObject({}));
  assert.deepEqual(b.getCurves(), ['secp224r1', 'secp256k1', 'secp384r1', 'secp521r1', 'prime256v1']);
});
