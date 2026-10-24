// Asymmetric-key fixtures for test/unit/bindings-crypto-asym.test.ts, recorded from real Node.
// Run with: npx -y node@<version in src/node/version.ts> --expose-internals --no-warnings test/fixtures-gen/crypto-asym.mjs

import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = {};
const hex = (b) => Buffer.from(b).toString('hex');
const errOf = (e) => ({ error: { name: e.name, message: e.message, code: e.code, library: e.library, reason: e.reason } });
function attempt(f) {
  try {
    return f();
  } catch (e) {
    return errOf(e);
  }
}
const ser = (v) => (Buffer.isBuffer(v) ? { hex: hex(v) } : typeof v === 'bigint' ? { bigint: v.toString() } : v);
const serDetails = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, ser(v)]));

// -----------------------------------------------------------------------------
// keys: one pair per type, exported every way it can be

const specs = [
  ['ed25519', {}],
  ['x25519', {}],
  ['ed448', {}],
  ['x448', {}],
  ['ec', { namedCurve: 'P-256' }],
  ['ec', { namedCurve: 'prime256v1' }],
  ['ec', { namedCurve: 'secp384r1' }],
  ['ec', { namedCurve: 'secp521r1' }],
  ['ec', { namedCurve: 'secp256k1' }],
  ['rsa', { modulusLength: 1024 }],
  ['rsa', { modulusLength: 2048, publicExponent: 3 }],
  ['rsa', { modulusLength: 1025 }],
  ['rsa-pss', { modulusLength: 1024 }],
  ['rsa-pss', { modulusLength: 1024, hashAlgorithm: 'sha256', mgf1HashAlgorithm: 'sha1', saltLength: 20 }],
  ['rsa-pss', { modulusLength: 1024, hashAlgorithm: 'sha512' }],
  ['ec', { namedCurve: 'secp224r1' }],
  ['ec', { namedCurve: 'P-256', paramEncoding: 'explicit' }],
  ['ec', { namedCurve: 'secp384r1', paramEncoding: 'explicit' }],
  ['ec', { namedCurve: 'secp256k1', paramEncoding: 'explicit' }],
  ['dsa', { modulusLength: 1024 }],
  ['dsa', { modulusLength: 2048, divisorLength: 224 }],
  ['dh', { group: 'modp5' }],
  ['dh', { primeLength: 512 }],
];

const pubEncodings = [
  { format: 'pem', type: 'spki' },
  { format: 'der', type: 'spki' },
  { format: 'pem', type: 'pkcs1' },
  { format: 'der', type: 'pkcs1' },
  { format: 'jwk' },
];
const privEncodings = [
  { format: 'pem', type: 'pkcs8' },
  { format: 'der', type: 'pkcs8' },
  { format: 'pem', type: 'pkcs1' },
  { format: 'der', type: 'pkcs1' },
  { format: 'pem', type: 'sec1' },
  { format: 'der', type: 'sec1' },
  { format: 'jwk' },
];
const exp = (key, enc) => attempt(() => ser(key.export(enc)));

out.keys = [];
for (const [type, opts] of specs) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(type, opts);
  const entry = {
    type,
    opts,
    asymmetricKeyType: publicKey.asymmetricKeyType,
    publicDetails: serDetails(publicKey.asymmetricKeyDetails),
    privateDetails: serDetails(privateKey.asymmetricKeyDetails),
    public: pubEncodings.map((enc) => ({ enc, result: exp(publicKey, enc) })),
    private: privEncodings.map((enc) => ({ enc, result: exp(privateKey, enc) })),
    publicFromPrivate: hex(crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })),
    equals: publicKey.equals(crypto.createPublicKey(privateKey)),
  };
  out.keys.push(entry);
}

// passphrase-protected PKCS#8 (input only: our output is random, checked by round trip)
{
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  out.encrypted = [];
  for (const cipher of ['aes-256-cbc', 'aes-128-cbc', 'des-ede3-cbc']) {
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8', cipher, passphrase: 'top secret' });
    const der = privateKey.export({ format: 'der', type: 'pkcs8', cipher, passphrase: 'top secret' });
    out.encrypted.push({ cipher, pem, der: hex(der), plain: hex(privateKey.export({ format: 'der', type: 'pkcs8' })) });
  }
  const sec1 = privateKey.export({ format: 'pem', type: 'sec1', cipher: 'aes-128-cbc', passphrase: 'top secret' });
  out.encryptedLegacy = { pem: sec1, plain: hex(privateKey.export({ format: 'der', type: 'pkcs8' })) };
  out.encryptedErrors = {
    noPassphrase: attempt(() => crypto.createPrivateKey(out.encrypted[0].pem)),
    wrongPassphrase: attempt(() => crypto.createPrivateKey({ key: out.encrypted[0].pem, passphrase: 'wrong' })),
  };
}

// parse errors
out.parseErrors = [
  ['public', 'garbage'],
  ['private', 'garbage'],
  ['public', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'],
  ['private', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'],
  ['publicDer', '3000'],
  ['privateDer', '3000'],
].map(([kind, input]) => ({
  kind,
  input,
  result: attempt(() => {
    if (kind === 'public') return crypto.createPublicKey(input).asymmetricKeyType;
    if (kind === 'private') return crypto.createPrivateKey(input).asymmetricKeyType;
    if (kind === 'publicDer') return crypto.createPublicKey({ key: Buffer.from(input, 'hex'), format: 'der', type: 'spki' }).asymmetricKeyType;
    return crypto.createPrivateKey({ key: Buffer.from(input, 'hex'), format: 'der', type: 'pkcs8' }).asymmetricKeyType;
  }),
}));

// -----------------------------------------------------------------------------
// signatures: deterministic ones compare exactly, the rest are verified

const message = Buffer.from('The quick brown fox jumps over the lazy dog');
out.signatures = [];
const sigKeys = out.keys.filter((k) => !k.type.startsWith('x') && k.type !== 'dh');
for (const k of sigKeys) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(k.private[1].result.hex, 'hex'), format: 'der', type: 'pkcs8' });
  const isEd = k.type.startsWith('ed');
  const algs = isEd ? [null] : k.type === 'ec' || k.type === 'dsa' ? ['sha256', 'sha1', 'sha512', 'sha3-256', null] : ['sha256', 'sha1', 'sha512', 'md5', null];
  for (const alg of algs) {
    const optsList = k.type === 'ec' || k.type === 'dsa' ? [{}, { dsaEncoding: 'ieee-p1363' }] : k.type === 'rsa' ? [{}, { padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 0 }, { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: -1 }] : [{}];
    for (const o of optsList) {
      const sig = attempt(() => hex(crypto.sign(alg, message, { key: priv, ...o })));
      const streamSig = isEd || alg === null ? undefined : attempt(() => hex(crypto.createSign(alg).update(message).sign({ key: priv, ...o })));
      out.signatures.push({ type: k.type, opts: k.opts, alg, sigOpts: o, sig, streamSig });
    }
  }
}
// streaming Sign on Ed25519 is unsupported; unknown digest
{
  const ed = crypto.generateKeyPairSync('ed25519').privateKey;
  out.signErrors = {
    edStream: attempt(() => crypto.createSign('sha256').update('x').sign(ed)),
    unknownDigest: attempt(() => crypto.createSign('nope')),
    oneShotUnknownDigest: attempt(() => crypto.sign('nope', message, ed)),
    p1363Malformed: attempt(() => crypto.verify('sha256', message, { key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.alloc(10))),
  };
}

// -----------------------------------------------------------------------------
// ECDH / X25519 / diffieHellman

out.ecdh = [];
for (const curve of ['prime256v1', 'secp384r1', 'secp521r1', 'secp256k1', 'secp224r1']) {
  const a = crypto.createECDH(curve);
  a.generateKeys();
  const b = crypto.createECDH(curve);
  b.generateKeys();
  out.ecdh.push({
    curve,
    aPriv: hex(a.getPrivateKey()),
    bPriv: hex(b.getPrivateKey()),
    aPub: hex(a.getPublicKey()),
    aPubCompressed: hex(a.getPublicKey(null, 'compressed')),
    aPubHybrid: hex(a.getPublicKey(null, 'hybrid')),
    bPub: hex(b.getPublicKey()),
    secret: hex(a.computeSecret(b.getPublicKey())),
    convert: hex(crypto.ECDH.convertKey(a.getPublicKey(null, 'compressed'), curve, null, null, 'uncompressed')),
    badPoint: attempt(() => a.computeSecret(Buffer.from('04' + '11'.repeat(a.getPublicKey().length - 1), 'hex'))),
  });
}
out.ecdhErrors = {
  badCurve: attempt(() => crypto.createECDH('nope')),
  badPrivate: attempt(() => crypto.createECDH('prime256v1').setPrivateKey(Buffer.alloc(32))),
};
out.dh = [];
for (const type of ['x25519', 'x448', 'ec', 'dh']) {
  const opts = type === 'ec' ? { namedCurve: 'P-384' } : type === 'dh' ? { group: 'modp14' } : {};
  const a = crypto.generateKeyPairSync(type, opts);
  const b = crypto.generateKeyPairSync(type, opts);
  out.dh.push({
    type,
    aPriv: hex(a.privateKey.export({ format: 'der', type: 'pkcs8' })),
    bPub: hex(b.publicKey.export({ format: 'der', type: 'spki' })),
    secret: hex(crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey })),
  });
}

// -----------------------------------------------------------------------------
// RSA encryption

{
  const k = out.keys.find((x) => x.type === 'rsa' && x.opts.modulusLength === 1024);
  const priv = crypto.createPrivateKey({ key: Buffer.from(k.private[1].result.hex, 'hex'), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const C = crypto.constants;
  out.rsaEnc = {
    key: k.private[1].result.hex,
    cases: [
      { padding: C.RSA_PKCS1_OAEP_PADDING },
      { padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      { padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha224', oaepLabel: '6c6162656c' },
      { padding: C.RSA_PKCS1_PADDING },
    ].map((o) => {
      const opts = { ...o, oaepLabel: o.oaepLabel && Buffer.from(o.oaepLabel, 'hex') };
      const ct = crypto.publicEncrypt({ key: pub, ...opts }, message);
      return { opts: o, ct: hex(ct), decrypted: attempt(() => hex(crypto.privateDecrypt({ key: priv, ...opts }, ct))) };
    }),
    privateEncrypt: hex(crypto.privateEncrypt(priv, message)),
    privateEncryptNoPad: hex(crypto.privateEncrypt({ key: priv, padding: C.RSA_NO_PADDING }, Buffer.alloc(128, 7))),
    publicDecryptBad: attempt(() => crypto.publicDecrypt(pub, Buffer.alloc(128, 1))),
    oaepTooLong: attempt(() => crypto.publicEncrypt(pub, Buffer.alloc(100))),
    privateDecryptBad: attempt(() => crypto.privateDecrypt(priv, Buffer.alloc(128, 1))),
  };
}

// -----------------------------------------------------------------------------
// classic Diffie-Hellman

{
  const priv = (n) => Buffer.from('0123456789abcdef'.repeat(n), 'hex');
  out.dhGroups = ['modp1', 'modp2', 'modp5', 'modp14', 'modp15', 'modp16', 'modp17', 'modp18'].map((g) => {
    const grp = crypto.getDiffieHellman(g);
    const a = crypto.createDiffieHellman(grp.getPrime(), 2);
    a.setPrivateKey(priv(4));
    const pub = a.generateKeys();
    const peer = crypto.createDiffieHellman(grp.getPrime(), 2);
    peer.setPrivateKey(priv(3));
    peer.generateKeys();
    return { group: g, pub: hex(pub), priv: hex(a.getPrivateKey()), secret: hex(a.computeSecret(peer.getPublicKey())), verifyError: grp.verifyError, customVerifyError: a.verifyError, gen: hex(grp.getGenerator()), prime: hex(grp.getPrime()).slice(0, 16) };
  });
  const modp1 = crypto.getDiffieHellman('modp1').getPrime();
  const notSafe = Buffer.from('f'.repeat(127) + '1', 'hex');
  out.dhCustom = [
    [hex(modp1), 2], [hex(modp1), 5], [hex(modp1), 3], [hex(modp1), '02'], [hex(notSafe), 2], ['0b', 2], ['0c', 2], [hex(modp1), 'ff'.repeat(96)],
  ].map(([p, g]) => {
    const r = attempt(() => {
      const d = crypto.createDiffieHellman(Buffer.from(p, 'hex'), typeof g === 'string' ? Buffer.from(g, 'hex') : g);
      return { verifyError: d.verifyError, gen: hex(d.getGenerator()), prime: hex(d.getPrime()) };
    });
    return { p, g, result: r };
  });
  const g = crypto.createDiffieHellman(modp1, 2);
  g.setPrivateKey(priv(4));
  g.generateKeys();
  const p = BigInt('0x' + hex(modp1));
  const big = (n) => Buffer.from(n.toString(16).padStart(192, '0'), 'hex');
  out.dhErrors = {
    // first: later cases leave stale errors in OpenSSL's queue that would be reported instead
    badGenerator: attempt(() => crypto.createDiffieHellman(modp1, 1)),
    badGeneratorBuf: attempt(() => crypto.createDiffieHellman(modp1, Buffer.from('01', 'hex'))),
    unknownGroup: attempt(() => crypto.getDiffieHellman('nope')),
    smallPrime: attempt(() => crypto.createDiffieHellman(1)),
    smallPrime2: attempt(() => crypto.createDiffieHellman(100)),
    noPublic: attempt(() => crypto.getDiffieHellman('modp1').getPublicKey()),
    noPrivate: attempt(() => crypto.getDiffieHellman('modp1').getPrivateKey()),
    secretOne: attempt(() => g.computeSecret(big(1n))),
    secretPm1: attempt(() => g.computeSecret(big(p - 1n))),
    secretP: attempt(() => g.computeSecret(big(p))),
    secretSmall: attempt(() => hex(g.computeSecret(big(2n)))),
  };
}

// -----------------------------------------------------------------------------
// WebCrypto (crypto.subtle) jobs

{
  const { subtle } = crypto.webcrypto;
  const k16 = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const k32 = Buffer.concat([k16, k16]);
  const data = Buffer.from('webcrypto test data, a bit longer than one block');
  const w = (out.webcrypto = {});
  const aesKey = (raw, name) => subtle.importKey('raw', raw, name, true, ['encrypt', 'decrypt']);
  const iv16 = Buffer.from('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', 'hex');
  w.gcm = [];
  for (const [raw, iv, tagLength, aad] of [[k16, iv16.subarray(0, 12), 128, null], [k32, iv16, 96, 'aad!'], [k16, Buffer.concat([iv16, iv16, iv16]), 32, '']]) {
    const alg = { name: 'AES-GCM', iv, tagLength, ...(aad === null ? {} : { additionalData: Buffer.from(aad) }) };
    w.gcm.push({ key: hex(raw), iv: hex(iv), tagLength, aad, ct: hex(await subtle.encrypt(alg, await aesKey(raw, 'AES-GCM'), data)) });
  }
  w.cbc = hex(await subtle.encrypt({ name: 'AES-CBC', iv: iv16 }, await aesKey(k32, 'AES-CBC'), data));
  w.ctr = [];
  for (const length of [128, 64, 2]) {
    const counter = Buffer.from('000102030405060708090a0b0c0d0eff', 'hex');
    w.ctr.push({ length, counter: hex(counter), ct: await subtle.encrypt({ name: 'AES-CTR', counter, length }, await aesKey(k16, 'AES-CTR'), data.subarray(0, 48)).then(hex, (e) => ({ error: e.name })) });
  }
  const kek = await subtle.importKey('raw', k16, 'AES-KW', true, ['wrapKey', 'unwrapKey']);
  const toWrap = await subtle.importKey('raw', k32, 'AES-GCM', true, ['encrypt']);
  w.kw = hex(await subtle.wrapKey('raw', toWrap, kek, 'AES-KW'));
  // ECDH / X25519 deriveBits and exports
  const ecA = out.dh.find((d) => d.type === 'ec');
  const xA = out.dh.find((d) => d.type === 'x25519');
  const imp = async (der, fmt, alg, usages) => subtle.importKey(fmt, Buffer.from(der, 'hex'), alg, true, usages);
  w.ecdh = hex(await subtle.deriveBits({ name: 'ECDH', public: await imp(ecA.bPub, 'spki', { name: 'ECDH', namedCurve: 'P-384' }, []) }, await imp(ecA.aPriv, 'pkcs8', { name: 'ECDH', namedCurve: 'P-384' }, ['deriveBits']), 384));
  w.x25519 = hex(await subtle.deriveBits({ name: 'X25519', public: await imp(xA.bPub, 'spki', { name: 'X25519' }, []) }, await imp(xA.aPriv, 'pkcs8', { name: 'X25519' }, ['deriveBits']), 256));
  const ecPub = await imp(ecA.bPub, 'spki', { name: 'ECDH', namedCurve: 'P-384' }, []);
  w.ecRaw = hex(await subtle.exportKey('raw', ecPub));
  const rsaK = out.keys.find((x) => x.type === 'rsa' && x.opts.modulusLength === 1024);
  const rsaPriv = await imp(rsaK.private[1].result.hex, 'pkcs8', { name: 'RSA-OAEP', hash: 'SHA-256' }, ['decrypt']);
  const rsaPub = await imp(rsaK.public[1].result.hex, 'spki', { name: 'RSA-OAEP', hash: 'SHA-256' }, ['encrypt']);
  w.oaep = hex(await subtle.encrypt({ name: 'RSA-OAEP', label: Buffer.from('L') }, rsaPub, data));
  w.rsaSpki = hex(await subtle.exportKey('spki', rsaPub));
  w.rsaPkcs8 = hex(await subtle.exportKey('pkcs8', rsaPriv));
}

writeFileSync(new URL('../unit/fixtures/crypto-asym.json', import.meta.url), JSON.stringify(out, null, 0));
console.log('keys', out.keys.length, 'signatures', out.signatures.length);
