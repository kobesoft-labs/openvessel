// crypto_random.cc: RandomBytesJob, RandomPrimeJob, CheckPrimeJob, plus the BigInt helpers they need.

import { cryptoError, err, fillRandom, jobClass, toArrayBuffer, view } from './util.ts';

// new RandomBytesJob(mode, buffer, offset, size)
export const RandomBytesJob = jobClass('RandomBytesJob', (_async, buffer: unknown, offset: number, size: number) => {
  const target = view(buffer);
  if (offset + size > target.length) throw new RangeError('RandomBytesJob: out of bounds');
  return () => {
    fillRandom(target.subarray(offset, offset + size));
    return undefined;
  };
});

// -----------------------------------------------------------------------------
// BigInt arithmetic

export function bytesToBigInt(b: Uint8Array): bigint {
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return hex ? BigInt('0x' + hex) : 0n;
}

export function bigIntToBytes(n: bigint, len?: number): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  if (n === 0n) hex = '';
  const size = len ?? hex.length / 2;
  const out = new Uint8Array(size);
  const off = size - hex.length / 2;
  for (let i = 0; i < hex.length / 2; i++) out[off + i] = parseInt(hex.substr(2 * i, 2), 16);
  return out;
}

export function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  base %= mod;
  if (base < 0n) base += mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

const SMALL_PRIMES: number[] = (() => {
  const out: number[] = [];
  const sieve = new Uint8Array(2048);
  for (let i = 2; i < 2048; i++) {
    if (sieve[i]) continue;
    out.push(i);
    for (let j = i * i; j < 2048; j += i) sieve[j] = 1;
  }
  return out;
})();

function randomBelow(n: bigint): bigint {
  // uniform in [2, n - 2]
  const bytes = new Uint8Array(Math.ceil(bitLength(n) / 8) + 8);
  fillRandom(bytes);
  return 2n + (bytesToBigInt(bytes) % (n - 3n));
}

/** BN_check_prime: trial division, then Miller-Rabin with random bases. */
export function isProbablePrime(n: bigint, checks = 0): boolean {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    const bp = BigInt(p);
    if (n === bp) return true;
    if (n % bp === 0n) return false;
  }
  const rounds = checks > 0 ? checks : bitLength(n) > 2048 ? 128 : 64;
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  outer: for (let i = 0; i < rounds; i++) {
    let x = modPow(randomBelow(n), d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let r = 1; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
      if (x === 1n) return false;
    }
    return false;
  }
  return true;
}

function randomBits(bits: number, topTwo: boolean): bigint {
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  fillRandom(bytes);
  let n = bytesToBigInt(bytes) & ((1n << BigInt(bits)) - 1n);
  n |= 1n << BigInt(bits - 1);
  if (topTwo && bits > 1) n |= 1n << BigInt(bits - 2);
  return n;
}

/**
 * Walks start, start + step, ... (at most `limit` candidates of exactly `bits` bits) and returns the
 * first (safe) prime. Candidates are sieved incrementally against the small primes — for safe primes
 * also (p - 1) / 2 — and pass a base-2 Fermat test before the full Miller-Rabin rounds.
 */
function sieveSearch(start: bigint, step: bigint, bits: number, safe: boolean, checks: number, limit: number): bigint | null {
  const n = SMALL_PRIMES.length;
  const res = new Int32Array(n);
  const inc = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const sp = BigInt(SMALL_PRIMES[i]);
    res[i] = Number(start % sp);
    inc[i] = Number(step % sp);
  }
  const max = 1n << BigInt(bits);
  const min = 1n << BigInt(bits - 1);
  let p = start;
  outer: for (let k = 0; k < limit; k++, p += step) {
    if (k) for (let i = 0; i < n; i++) res[i] = (res[i] + inc[i]) % SMALL_PRIMES[i];
    if (p >= max) return null;
    if (p < min) continue;
    for (let i = 0; i < n; i++) {
      // p divisible by a small prime, or (for safe primes) (p - 1) / 2 divisible by an odd one
      if (res[i] === 0 || (safe && i > 0 && res[i] === 1)) continue outer;
    }
    if (modPow(2n, p - 1n, p) !== 1n) continue;
    const q = (p - 1n) >> 1n;
    if (safe && modPow(2n, q - 1n, q) !== 1n) continue;
    if (isProbablePrime(p, checks) && (!safe || isProbablePrime(q, checks))) return p;
  }
  return null;
}

/** BN_generate_prime_ex2 */
export function generatePrime(bits: number, safe: boolean, add?: bigint, rem?: bigint, checks = 0): bigint {
  if (bits < 2 || (bits === 2 && safe)) throw cryptoError('error:01800076:bignum routines::bits too small');
  if (bits <= 16) {
    // small enough to try every candidate directly
    const check = (p: bigint) => isProbablePrime(p, checks) && (!safe || isProbablePrime((p - 1n) >> 1n, checks));
    for (;;) {
      let p = randomBits(bits, add === undefined);
      if (add !== undefined) p = p - (p % add) + (rem ?? (safe ? 3n : 1n));
      if (bitLength(p) === bits && check(p)) return p;
    }
  }
  for (;;) {
    let start: bigint;
    let step: bigint;
    if (add === undefined) {
      start = randomBits(bits, true) | 1n;
      step = 2n;
      if (safe) {
        start |= 3n; // a safe prime > 7 is 3 mod 4
        step = 4n;
      }
    } else {
      const r = rem ?? (safe ? 3n : 1n);
      start = randomBits(bits, false);
      start = start - (start % add) + r;
      step = add;
    }
    const p = sieveSearch(start, step, bits, safe, checks, 1 << 16);
    if (p !== null) return p;
  }
}

// new RandomPrimeJob(mode, bits, safe, add, rem) → ArrayBuffer (big-endian)
export const RandomPrimeJob = jobClass('RandomPrimeJob', (_async, size: number, safe: boolean, addBuf: unknown, remBuf: unknown) => {
  const add = addBuf === undefined ? undefined : bytesToBigInt(view(addBuf));
  const rem = remBuf === undefined ? undefined : bytesToBigInt(view(remBuf));
  if (add !== undefined) {
    if (bitLength(add) > size) throw err('ERR_OUT_OF_RANGE', 'invalid options.add');
    if (rem !== undefined && add <= rem) throw err('ERR_OUT_OF_RANGE', 'invalid options.rem');
  }
  return () => toArrayBuffer(bigIntToBytes(generatePrime(size, !!safe, add, rem)));
});

// new CheckPrimeJob(mode, candidate, checks) → boolean
export const CheckPrimeJob = jobClass('CheckPrimeJob', (async, candidate: unknown, checks: number) => {
  const n = bytesToBigInt(view(candidate));
  void async;
  return () => isProbablePrime(n, checks);
});

export function secureBuffer(len: number) {
  return new Uint8Array(len);
}

export function secureHeapUsed() {
  return undefined;
}
