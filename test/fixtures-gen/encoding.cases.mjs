// Inputs for internalBinding('encoding_binding').

const strings = [
  '',
  'hello',
  'héllo',
  '日本語',
  '😀',
  'a😀b',
  '\ud800',
  'a\udc00b',
  '😀\ud83d',
  '\0\x7f\x80߿ࠀ￿',
  '﻿bom',
  'x'.repeat(40) + '€',
];

const byteSeqs = [
  [],
  [0x68, 0x69],
  [0xef, 0xbb, 0xbf],
  [0xef, 0xbb, 0xbf, 0x41],
  [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41],
  [0xef, 0xbb],
  [0xc3, 0xa9],
  [0xc3],
  [0xe2, 0x82],
  [0xe2, 0x82, 0xac, 0xff],
  [0xed, 0xa0, 0x80],
  [0xf0, 0x9f, 0x98, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xc0, 0x80],
  [0x80],
  [0xff, 0xfe, 0x41, 0x00],
  [0xff],
  [0xff, 0x41],
  [0x00, 0x7f, 0x80, 0x9f, 0xa0, 0xff],
  // every byte Windows-1252 maps differently from latin1
  Array.from({ length: 32 }, (_, i) => 0x80 + i),
];

const domains = [
  '',
  'example.com',
  'EXAMPLE.COM',
  'ñ.com',
  'Ñ.COM',
  'bücher.de',
  'xn--bcher-kva.de',
  'XN--BCHER-KVA.DE',
  'xn--',
  'xn--a',
  'xn--a-',
  'xn---',
  'xn--zz',
  'xn--4ca',
  'xn--4CA',
  'xn--Bcher-kva.de',
  'xn--ida',
  'xn--nxasmq6b',
  '日本語.jp',
  'ＥＸＡＭＰＬＥ．ｃｏｍ',
  'a。b',
  'a．b｡c',
  'faß.de',
  '‍.com',
  'a‍b.com',
  'a b.com',
  'ä b.com',
  'a%41.com',
  'ä%41.com',
  '0x7f.1',
  'ä.1',
  '1.2.3.4',
  '-a.com',
  'a-.com',
  'ab--c.com',
  'a..b',
  '.',
  '..',
  'a.',
  '.a',
  'ä.',
  'ـ.com',
  'ab́.com',
  '́a.com',
  '\ud800.com',
  '\u{1F600}.com',
  'א.com',
  'aא.com',
  'ä_b.com',
  'a_b.com',
  'a­b.com',
  'ä.xn--4ca',
  'ä.xn--a',
  'ä.XN--4CA',
  'xn--mnchen-3ya.de',
  'münchen.de',
  'ñ'.repeat(70) + '.com',
];

export function run(binding) {
  const out = { encodeInto: [], encodeUtf8String: [], decodeUTF8: [], decodeWindows1252: [], toASCII: [], toUnicode: [], errors: [] };
  for (const s of strings) {
    out.encodeUtf8String.push({ args: [s], r: [...binding.encodeUtf8String(s)] });
    for (const size of [0, 1, 2, 3, 4, 5, 8, 64]) {
      const dest = new Uint8Array(size + 2).fill(0xaa);
      binding.encodeInto(s, dest.subarray(1, 1 + size));
      out.encodeInto.push({ args: [s, size], r: [[...binding.encodeIntoResults], [...dest]] });
    }
  }
  for (const bytes of byteSeqs) {
    for (const ignoreBOM of [false, true]) {
      for (const fatal of [false, true]) {
        const call = (f) => {
          try {
            return f();
          } catch (e) {
            return { threw: e.constructor.name, code: e.code, message: e.message };
          }
        };
        out.decodeUTF8.push({ args: [bytes, ignoreBOM, fatal], r: call(() => binding.decodeUTF8(Uint8Array.from(bytes), ignoreBOM, fatal)) });
        out.decodeWindows1252.push({ args: [bytes, ignoreBOM, fatal], r: call(() => binding.decodeWindows1252(Uint8Array.from(bytes), ignoreBOM, fatal)) });
      }
    }
    // other buffer sources
    out.decodeUTF8.push({ args: [bytes, 'ArrayBuffer'], r: binding.decodeUTF8(Uint8Array.from(bytes).buffer, false, false) });
    out.decodeUTF8.push({ args: [bytes, 'DataView'], r: binding.decodeUTF8(new DataView(Uint8Array.from([0x41, ...bytes]).buffer, 1), false, false) });
    const sab = new SharedArrayBuffer(bytes.length);
    new Uint8Array(sab).set(bytes);
    out.decodeWindows1252.push({ args: [bytes, 'SharedArrayBuffer'], r: binding.decodeWindows1252(sab, false, false) });
  }
  for (const [name, f] of [
    ['decodeUTF8', () => binding.decodeUTF8('str')],
    ['decodeUTF8', () => binding.decodeUTF8(null)],
    ['decodeWindows1252', () => binding.decodeWindows1252({})],
  ]) {
    try {
      f();
      out.errors.push({ args: [name], r: null });
    } catch (e) {
      out.errors.push({ args: [name], r: { threw: e.constructor.name, code: e.code, message: e.message } });
    }
  }
  for (const d of domains) {
    out.toASCII.push({ args: [d], r: binding.toASCII(d) });
    out.toUnicode.push({ args: [d], r: binding.toUnicode(d) });
  }
  return out;
}
