// Inputs for internalBinding('icu').

const widthStrings = [
  '',
  'abc',
  '\x00\x1b[31m\x7f\x9f',
  '漢字かなカナ',
  'ｱｲｳ',
  'ＡＢＣ',
  '①②③αβγ←→',
  'é',
  'é',
  '­',
  '​‌‍⁠﻿',
  '😀',
  '👍🏽',
  '🏽',
  '👨‍👩‍👧‍👦',
  '🏳️‍🌈',
  '❤️',
  '❤',
  '☺',
  '☺️',
  '🇯🇵',
  '#️⃣',
  'a‍😀',
  '‍‍😀',
  '‍🏽',
  '‍́',
  '\ud800',
  '\udc00a',
  '\ud83d',
  'ﾞ',
  '한국어',
  '각',
  '　',
  '〜',
  '\u{20000}\u{2FFFD}\u{30000}',
  '\u{E0001}\u{E0100}',
  '\u{1F1E6}',
  'Ⅻ',
];

// Every code point in blocks of 128, so a per-code-point table error shows up in the block sums.
const sweep = [];
for (let cp = 0; cp < 0x110000; cp += 128) {
  let s = '';
  for (let c = cp; c < cp + 128; c++) s += String.fromCodePoint(c);
  sweep.push(s);
}

const transcodeInputs = [
  [0x41, 0x42],
  [0x80, 0x41],
  [0xff],
  [0xc3, 0xa9, 0x41],
  [0xe6, 0x97, 0xa5],
  [0xf0, 0x9f, 0x98, 0x80],
  [0xe6, 0x97],
  [0xc3],
  [0xed, 0xa0, 0x80],
  [0x41, 0x00, 0x42, 0x00],
  [0x41, 0x00, 0x42],
  [0x3d, 0xd8, 0x00, 0xde],
  [0x3d, 0xd8, 0x41, 0x00],
  [0x00, 0xde],
  [0xe5, 0x65, 0x2c, 0x67],
  [0xff, 0xfe, 0x41, 0x00],
  [0xef, 0xbb, 0xbf, 0x41],
  [...new TextEncoder().encode('\u200bA\u00ad\u034f\u2060\u3164\u{E0001}\u{1D173}B\u2028')],
  [0x0b, 0x20, 0xad, 0x00, 0x60, 0x20],
];
const transcodeEncodings = ['ascii', 'latin1', 'binary', 'utf8', 'utf-8', 'ucs2', 'utf16le', 'UTF8', 'base64', 'hex', 'buffer', 'nope'];

const converterLabels = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'iso-8859-2',
  'iso-8859-15',
  'windows-1251',
  'koi8-r',
  'ibm866',
  'macintosh',
  'shift_jis',
  'euc-jp',
  'iso-2022-jp',
  'gbk',
  'gb18030',
  'big5',
  'euc-kr',
  'windows-874',
];
const decodeInputs = {
  common: [[], [0x41, 0x42, 0x43], [0x00, 0x7f]],
  'utf-8': [[0xef, 0xbb, 0xbf, 0x41], [0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac], [0xc3], [0xff, 0x41]],
  'utf-16le': [[0xff, 0xfe, 0x41, 0x00], [0xe5, 0x65, 0x2c, 0x67], [0x3d, 0xd8, 0x00, 0xde], [0x3d, 0xd8], [0x41]],
  'utf-16be': [[0xfe, 0xff, 0x00, 0x41], [0x65, 0xe5, 0x67, 0x2c], [0xd8, 0x3d]],
  'windows-1252': [[0x80, 0x9f, 0xe9]],
  'iso-8859-2': [[0xa1, 0xb1, 0xe9]],
  'windows-1251': [[0xc0, 0xe0, 0xff]],
  'koi8-r': [[0xc1, 0xe1]],
  'shift_jis': [[0x82, 0xa0, 0x93, 0xfa, 0x96, 0x7b], [0xb1, 0xb2], [0x82]],
  'euc-jp': [[0xa4, 0xa2, 0xc6, 0xfc], [0xa4]],
  'iso-2022-jp': [[0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42, 0x41]],
  gbk: [[0xc4, 0xe3, 0xba, 0xc3]],
  big5: [[0xa7, 0x41, 0xa6, 0x6e]],
  'euc-kr': [[0xc7, 0xd1, 0xb1, 0xdb]],
};

function errOf(e) {
  return { threw: e?.constructor?.name, code: e?.code, message: e?.message };
}

export function run(binding) {
  const out = { width: [], sweep: [], icuErrName: [], transcode: [], hasConverter: [], decode: [] };
  for (const s of widthStrings) {
    for (const amb of [false, true]) {
      for (const expand of [undefined, true, false]) out.width.push({ args: [s, amb, expand], r: binding.getStringWidth(s, amb, expand) });
    }
  }
  sweep.forEach((s, i) => {
    out.sweep.push({ args: [i * 128], r: [binding.getStringWidth(s, false, true), binding.getStringWidth(s, true, true), binding.getStringWidth(s, true, false)] });
  });
  for (const code of [-129, -128, -120, -1, 0, 1, 10, 31, 32, 0x10000, 0x1001f, 0x10100, 0x10200, 0x10300, 0x10400, 0x10408, 0x10409, 0x10500, 0x10501, 0x10502, 99999]) {
    out.icuErrName.push({ args: [code], r: binding.icuErrName(code) });
  }
  for (const bytes of transcodeInputs) {
    for (const from of transcodeEncodings) {
      for (const to of transcodeEncodings) {
        const r = binding.transcode(Uint8Array.from(bytes), from, to);
        out.transcode.push({ args: [bytes, from, to], r: typeof r === 'number' ? r : [...r] });
      }
    }
  }
  for (const label of [...converterLabels, 'nope', 'utf8', 'latin1', 'x-user-defined', 'replacement', 'csshiftjis']) {
    out.hasConverter.push({ args: [label], r: binding.hasConverter(label) });
  }
  for (const label of converterLabels) {
    const inputs = [...decodeInputs.common, ...(decodeInputs[label] ?? [])];
    for (const flags of [0, 2, 4, 6]) {
      for (const bytes of inputs) {
        // whole, then split at every point (streaming then flushing)
        const results = [];
        for (let split = 0; split <= bytes.length; split++) {
          const conv = binding.getConverter(label, flags);
          const steps = [];
          for (const [part, fl] of [
            [bytes.slice(0, split), 0],
            [bytes.slice(split), 1],
          ]) {
            try {
              steps.push(binding.decode(conv, Uint8Array.from(part), fl, label));
            } catch (e) {
              steps.push(errOf(e));
            }
          }
          results.push(steps);
        }
        out.decode.push({ args: [label, flags, bytes], r: results });
      }
    }
  }
  return out;
}
