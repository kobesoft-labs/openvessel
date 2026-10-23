// Raw block ciphers for the mode implementations in cipher.ts: AES (via @noble/ciphers' single-block
// primitives) and DES / Triple-DES (FIPS 46-3, written out here because no audited small library covers it).

import { unsafe } from '@noble/ciphers/aes.js';

export interface BlockCipher {
  blockSize: number;
  /** Encrypts one block from src[so..] into dst[d..] (may alias). */
  encrypt(src: Uint8Array, so: number, dst: Uint8Array, d: number): void;
  decrypt(src: Uint8Array, so: number, dst: Uint8Array, d: number): void;
}

const rd = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function wr(b: Uint8Array, o: number, v: number) {
  b[o] = v;
  b[o + 1] = v >>> 8;
  b[o + 2] = v >>> 16;
  b[o + 3] = v >>> 24;
}

export function aes(key: Uint8Array): BlockCipher {
  const k = key.slice();
  const ek = unsafe.expandKeyLE(k);
  let dk: Uint32Array | null = null;
  const run = (fn: typeof unsafe.encrypt, xk: Uint32Array, src: Uint8Array, so: number, dst: Uint8Array, d: number) => {
    const r = fn(xk, rd(src, so), rd(src, so + 4), rd(src, so + 8), rd(src, so + 12));
    wr(dst, d, r.s0);
    wr(dst, d + 4, r.s1);
    wr(dst, d + 8, r.s2);
    wr(dst, d + 12, r.s3);
  };
  return {
    blockSize: 16,
    encrypt: (src, so, dst, d) => run(unsafe.encrypt, ek, src, so, dst, d),
    decrypt: (src, so, dst, d) => run(unsafe.decrypt, (dk ??= unsafe.expandKeyDecLE(k)), src, so, dst, d),
  };
}

// -----------------------------------------------------------------------------
// DES

// prettier-ignore
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
// prettier-ignore
const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
// prettier-ignore
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
// prettier-ignore
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
// prettier-ignore
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
// prettier-ignore
const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

// SP[j][v]: S-box j applied to the 6-bit value v, followed by the P permutation, as a 32-bit word.
const SP: Uint32Array[] = SBOX.map((box, j) => {
  const t = new Uint32Array(64);
  for (let v = 0; v < 64; v++) {
    const row = ((v >> 4) & 2) | (v & 1);
    const col = (v >> 1) & 15;
    const s = box[row * 16 + col] << (28 - 4 * j); // 4 bits at positions 4j+1..4j+4 (1 = MSB)
    let out = 0;
    for (let i = 0; i < 32; i++) if ((s >>> (32 - P[i])) & 1) out |= 1 << (31 - i);
    t[v] = out >>> 0;
  }
  return t;
});

/** Permutes a 64-bit value given as [hi, lo] words; table entries are 1-based bit positions (1 = MSB). */
function permute64(hi: number, lo: number, table: number[], outBits: number): [number, number] {
  let oh = 0;
  let ol = 0;
  for (let i = 0; i < outBits; i++) {
    const p = table[i] - 1;
    const bit = p < 32 ? (hi >>> (31 - p)) & 1 : (lo >>> (63 - p)) & 1;
    if (i < 32) oh |= bit << (31 - i);
    else ol |= bit << (63 - i);
  }
  return [oh >>> 0, ol >>> 0];
}

const FP: number[] = (() => {
  const fp = new Array(64);
  for (let i = 0; i < 64; i++) fp[IP[i] - 1] = i + 1;
  return fp;
})();

/** 16 round keys, each as eight 6-bit values. */
function desSubkeys(key: Uint8Array, off: number): Uint8Array[] {
  const hi = ((key[off] << 24) | (key[off + 1] << 16) | (key[off + 2] << 8) | key[off + 3]) >>> 0;
  const lo = ((key[off + 4] << 24) | (key[off + 5] << 16) | (key[off + 6] << 8) | key[off + 7]) >>> 0;
  // 56 bits: C = first 28, D = last 28
  const [ph, pl] = permute64(hi, lo, PC1, 56);
  let c = ph >>> 4;
  let d = ((ph & 0xf) << 24) | (pl >>> 8);
  const keys: Uint8Array[] = [];
  for (let r = 0; r < 16; r++) {
    for (let s = 0; s < SHIFTS[r]; s++) {
      c = ((c << 1) | (c >>> 27)) & 0xfffffff;
      d = ((d << 1) | (d >>> 27)) & 0xfffffff;
    }
    const k = new Uint8Array(8);
    for (let i = 0; i < 48; i++) {
      const p = PC2[i] - 1; // 0..55
      const bit = p < 28 ? (c >>> (27 - p)) & 1 : (d >>> (55 - p)) & 1;
      k[(i / 6) | 0] |= bit << (5 - (i % 6));
    }
    keys.push(k);
  }
  return keys;
}

function feistel(r: number, k: Uint8Array): number {
  let out = 0;
  for (let j = 0; j < 8; j++) {
    let v = 0;
    for (let b = 0; b < 6; b++) v = (v << 1) | ((r >>> (32 - E[j * 6 + b])) & 1);
    out |= SP[j][v ^ k[j]];
  }
  return out >>> 0;
}

function desBlock(keys: Uint8Array[], decrypt: boolean, hi: number, lo: number): [number, number] {
  let [l, r] = permute64(hi, lo, IP, 64);
  for (let i = 0; i < 16; i++) {
    const t = r;
    r = (l ^ feistel(r, keys[decrypt ? 15 - i : i])) >>> 0;
    l = t;
  }
  return permute64(r, l, FP, 64);
}

/** Triple-DES EDE with a 16-byte (K1 K2 K1) or 24-byte key. */
export function desEde(key: Uint8Array): BlockCipher {
  const k1 = desSubkeys(key, 0);
  const k2 = desSubkeys(key, 8);
  const k3 = key.length >= 24 ? desSubkeys(key, 16) : k1;
  const read = (b: Uint8Array, o: number): [number, number] => [
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0,
    ((b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]) >>> 0,
  ];
  const write = (b: Uint8Array, o: number, [h, l]: [number, number]) => {
    b[o] = h >>> 24;
    b[o + 1] = h >>> 16;
    b[o + 2] = h >>> 8;
    b[o + 3] = h;
    b[o + 4] = l >>> 24;
    b[o + 5] = l >>> 16;
    b[o + 6] = l >>> 8;
    b[o + 7] = l;
  };
  return {
    blockSize: 8,
    encrypt(src, so, dst, d) {
      let [h, l] = read(src, so);
      [h, l] = desBlock(k1, false, h, l);
      [h, l] = desBlock(k2, true, h, l);
      write(dst, d, desBlock(k3, false, h, l));
    },
    decrypt(src, so, dst, d) {
      let [h, l] = read(src, so);
      [h, l] = desBlock(k3, true, h, l);
      [h, l] = desBlock(k2, false, h, l);
      write(dst, d, desBlock(k1, true, h, l));
    },
  };
}

/** Single DES, used only by tests against the FIPS vectors. */
export function des(key: Uint8Array): BlockCipher {
  return desEde(new Uint8Array([...key.subarray(0, 8), ...key.subarray(0, 8), ...key.subarray(0, 8)]));
}
