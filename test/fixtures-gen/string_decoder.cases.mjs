// Inputs for internalBinding('string_decoder'): byte sequences fed in chunks, per encoding. Records
// each decode()'s output, the state bytes after it, and the final flush().

const enc = new TextEncoder();
const u8 = (...a) => Uint8Array.from(a.flat());
const utf16 = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  return out;
};

const samples = [
  [],
  [...enc.encode('hello')],
  [...enc.encode('héllo wörld')],
  [...enc.encode('日本語テキスト')],
  [...enc.encode('😀👍🏽🇯🇵')],
  [...enc.encode('a€b𝄞c')],
  [0xe2, 0x82], // truncated 3-byte
  [0xf0, 0x9f, 0x98], // truncated 4-byte
  [0xe2, 0x41, 0x82, 0xac],
  [0xc3],
  [0x80, 0x80, 0x80, 0x80, 0x80],
  [0xf8, 0x88, 0x80, 0x80, 0x80],
  [0xff, 0xfe, 0xfd],
  [0xed, 0xa0, 0x80], // encoded surrogate
  [0xc0, 0xaf],
  [0xf4, 0x90, 0x80, 0x80],
  [0x61, 0xf0, 0x9f, 0x98, 0x80, 0xf0, 0x9f],
  utf16('ab'),
  utf16('日本'),
  utf16('😀x'),
  utf16('\ud83d'),
  utf16('\ude00\ud83d'),
  [0x41, 0x00, 0x42],
  [0x3d, 0xd8, 0x00, 0xde, 0x3d, 0xd8],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  [0xfb, 0xff, 0xbf, 0x00, 0x7f, 0x80, 0x81],
];

const encodings = ['utf8', 'utf16le', 'base64', 'base64url', 'hex', 'latin1', 'ascii'];

// Deterministic chunkings of a sequence: whole, every single split point, bytewise, and a few
// pseudo-random multi-splits.
function chunkings(len) {
  const out = [[len]];
  for (let i = 1; i < len; i++) out.push([i, len - i]);
  if (len > 1) out.push(Array(len).fill(1));
  let seed = len * 7919 + 1;
  const rnd = (n) => (seed = (seed * 48271) % 2147483647) % n;
  for (let k = 0; k < 3 && len > 2; k++) {
    const sizes = [];
    let left = len;
    while (left > 0) {
      const s = Math.min(left, rnd(4)); // zero-length chunks included
      sizes.push(s);
      left -= s;
    }
    out.push(sizes);
  }
  return out;
}

export function run(binding) {
  const out = { constants: [], decode: [] };
  const names = ['kIncompleteCharactersStart', 'kIncompleteCharactersEnd', 'kMissingBytes', 'kBufferedBytes', 'kEncodingField', 'kNumFields', 'kSize'];
  out.constants.push({ args: [], r: [names.map((n) => binding[n]), [...binding.encodings]] });
  for (const e of encodings) {
    const idx = binding.encodings.indexOf(e);
    for (const bytes of samples) {
      for (const sizes of chunkings(bytes.length)) {
        const state = new Uint8Array(binding.kSize);
        state[binding.kEncodingField] = idx;
        const steps = [];
        let pos = 0;
        for (const n of sizes) {
          const chunk = u8(bytes.slice(pos, pos + n));
          pos += n;
          const s = binding.decode(state, chunk);
          steps.push([s, [...state]]);
        }
        steps.push([binding.flush(state), [...state]]);
        out.decode.push({ args: [e, bytes, sizes], r: steps });
      }
    }
  }
  return out;
}
