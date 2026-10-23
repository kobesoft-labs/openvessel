// crypto_dh.cc: DiffieHellman and DiffieHellmanGroup (finite-field DH on BigInt).

import { DH_GROUPS } from './tables.ts';
import { bigIntToBytes, bitLength, bytesToBigInt, generatePrime, isProbablePrime, modPow } from './random.ts';
import { err, fillRandom, isAnyBufferSource, osslError, toBuffer, view } from './util.ts';

const dhErr = {
  modulusTooSmall: () => osslError('0280007E', 'Diffie-Hellman routines', 'modulus too small', 'ERR_OSSL_DH_MODULUS_TOO_SMALL'),
  badGenerator: () => osslError('02800065', 'Diffie-Hellman routines', 'bad generator', 'ERR_OSSL_DH_BAD_GENERATOR'),
};

const GROUPS = new Map(Object.entries(DH_GROUPS).map(([name, hex]) => [name, BigInt('0x' + hex)]));
const GROUP_PRIMES = new Set(GROUPS.values());

// DH_check flags
const DH_CHECK_P_NOT_PRIME = 0x01;
const DH_CHECK_P_NOT_SAFE_PRIME = 0x02;
const DH_NOT_SUITABLE_GENERATOR = 0x08;
const DH_MODULUS_TOO_SMALL = 0x80;
const DH_MODULUS_TOO_LARGE = 0x100;

/** DH_check: named groups are trusted, everything else is tested. */
function dhCheck(p: bigint, g: bigint): number {
  if (g === 2n && GROUP_PRIMES.has(p)) return 0;
  const bits = bitLength(p);
  if (bits > 32768) return DH_MODULUS_TOO_LARGE | DH_CHECK_P_NOT_PRIME;
  let flags = 0;
  if ((p & 1n) === 0n) flags |= DH_CHECK_P_NOT_PRIME;
  if (g <= 1n || g >= p - 1n) flags |= DH_NOT_SUITABLE_GENERATOR;
  if (bits < 512) flags |= DH_MODULUS_TOO_SMALL;
  if (bits > 10000) flags |= DH_MODULUS_TOO_LARGE;
  if (!isProbablePrime(p)) flags |= DH_CHECK_P_NOT_PRIME;
  else if (!isProbablePrime(p >> 1n)) flags |= DH_CHECK_P_NOT_SAFE_PRIME;
  return flags;
}

class DHBase {
  protected p: bigint;
  protected g: bigint;
  protected pub: bigint | undefined;
  protected priv: bigint | undefined;
  protected checked: number | undefined;

  constructor(p: bigint, g: bigint) {
    this.p = p;
    this.g = g;
  }

  get verifyError() {
    return (this.checked ??= dhCheck(this.p, this.g));
  }

  generateKeys() {
    if (this.priv === undefined) {
      const bytes = new Uint8Array(Math.ceil(bitLength(this.p) / 8) + 8);
      fillRandom(bytes);
      this.priv = (bytesToBigInt(bytes) % (this.p - 3n)) + 2n;
    }
    this.pub = modPow(this.g, this.priv, this.p);
    return toBuffer(bigIntToBytes(this.pub));
  }

  computeSecret(key: unknown) {
    const peer = bytesToBigInt(view(key));
    if (peer <= 1n) throw err('ERR_CRYPTO_INVALID_KEYLEN', 'Supplied key is too small');
    // ncrypto reports DH_CHECK_PUBKEY_TOO_LARGE as an unspecified error
    if (peer >= this.p - 1n) throw err('ERR_CRYPTO_INVALID_KEYTYPE', 'Unspecified validation error');
    if (this.priv === undefined) return toBuffer(new Uint8Array(0));
    return toBuffer(bigIntToBytes(modPow(peer, this.priv, this.p), Math.ceil(bitLength(this.p) / 8)));
  }

  getPrime() {
    return toBuffer(bigIntToBytes(this.p));
  }

  getGenerator() {
    return toBuffer(bigIntToBytes(this.g));
  }

  getPublicKey() {
    if (this.pub === undefined) throw err('ERR_CRYPTO_INVALID_STATE', 'No public key - did you forget to generate one?');
    return toBuffer(bigIntToBytes(this.pub));
  }

  getPrivateKey() {
    if (this.priv === undefined) throw err('ERR_CRYPTO_INVALID_STATE', 'No private key - did you forget to generate one?');
    return toBuffer(bigIntToBytes(this.priv));
  }

  setPublicKey(key: unknown) {
    this.pub = bytesToBigInt(view(key));
  }

  setPrivateKey(key: unknown) {
    this.priv = bytesToBigInt(view(key));
  }
}

// new DiffieHellman(primeLength | prime, generator)
export class DiffieHellman extends DHBase {
  constructor(...args: any[]) {
    if (args.length !== 2) throw err('ERR_MISSING_ARGS', 'Constructor must have two arguments');
    const [a, b] = args;
    if (typeof a === 'number' && Number.isInteger(a)) {
      if (a < 2) throw dhErr.modulusTooSmall();
      if (typeof b !== 'number' || !Number.isInteger(b)) throw err('ERR_INVALID_ARG_TYPE', 'Second argument must be an int32');
      if (b < 2) throw dhErr.badGenerator();
      // DH_generate_parameters_ex refuses moduli under 512 bits
      if (a < 512) throw err('ERR_INVALID_ARG_VALUE', 'Invalid DH parameters');
      const [add, rem] = b === 2 ? [24n, 23n] : b === 5 ? [60n, 59n] : [12n, 11n];
      super(generatePrime(a, true, add, rem), BigInt(b));
      this.checked = 0; // a freshly generated safe prime passes DH_check
      return;
    }
    const p = bytesToBigInt(view(a));
    let g: bigint;
    if (typeof b === 'number') {
      if (b < 2) throw dhErr.badGenerator();
      g = BigInt(b);
    } else {
      if (!isAnyBufferSource(b)) throw err('ERR_INVALID_ARG_TYPE', 'generator must be a buffer');
      g = bytesToBigInt(view(b));
      if (g < 2n) throw dhErr.badGenerator();
    }
    super(p, g);
  }
}

// new DiffieHellmanGroup(name)
export class DiffieHellmanGroup extends DHBase {
  constructor(name: unknown) {
    if (typeof name !== 'string') throw err('ERR_INVALID_ARG_TYPE', 'Group name must be a string');
    const p = GROUPS.get(name.toLowerCase());
    if (!p) throw err('ERR_CRYPTO_UNKNOWN_DH_GROUP');
    super(p, 2n);
  }
}
