// ChaCha20 block function (RFC 8439) with OpenSSL's 128-bit counter||nonce carry semantics.

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

/** One 64-byte keystream block for the 32-byte key and the four counter/nonce words. */
export function chachaBlock(key: Uint32Array, ctr: Uint32Array, out: Uint8Array) {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  s.set(key, 4);
  s.set(ctr, 12);
  const x = s.slice();
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] += x[b];
    x[d] = rotl(x[d] ^ x[a], 16);
    x[c] += x[d];
    x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b];
    x[d] = rotl(x[d] ^ x[a], 8);
    x[c] += x[d];
    x[b] = rotl(x[b] ^ x[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) {
    const v = (x[i] + s[i]) >>> 0;
    out[4 * i] = v;
    out[4 * i + 1] = v >>> 8;
    out[4 * i + 2] = v >>> 16;
    out[4 * i + 3] = v >>> 24;
  }
}

export function wordsLE(b: Uint8Array): Uint32Array {
  const w = new Uint32Array(b.length >> 2);
  for (let i = 0; i < w.length; i++) w[i] = b[4 * i] | (b[4 * i + 1] << 8) | (b[4 * i + 2] << 16) | (b[4 * i + 3] << 24);
  return w;
}

/** Streaming ChaCha20 keystream XOR. `ctr` is counter word + 3 nonce words; it carries like OpenSSL's. */
export class ChaChaStream {
  private key: Uint32Array;
  private ctr: Uint32Array;
  private ks = new Uint8Array(64);
  private pos = 64;
  constructor(key: Uint8Array, counterAndNonce: Uint8Array) {
    this.key = wordsLE(key);
    this.ctr = wordsLE(counterAndNonce);
  }
  xor(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.pos === 64) {
        chachaBlock(this.key, this.ctr, this.ks);
        for (let j = 0; j < 4; j++) {
          this.ctr[j] = (this.ctr[j] + 1) >>> 0;
          if (this.ctr[j] !== 0) break;
        }
        this.pos = 0;
      }
      out[i] = data[i] ^ this.ks[this.pos++];
    }
    return out;
  }
}
