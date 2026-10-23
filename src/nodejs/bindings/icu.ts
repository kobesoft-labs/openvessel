// internalBinding('icu') — node_i18n.cc without ICU: column widths from a table dumped out of
// Node's ICU, Buffer transcoding between Node's encodings, and legacy-encoding converters on top of
// the platform TextDecoder.

import { fromShape } from './shape.ts';
import { S } from '../state.ts';
import { bufferSourceBytes, decodable } from './encoding.ts';

// -----------------------------------------------------------------------------
// getStringWidth

let widthClass: Uint8Array | null = null;
let widthStarts: Uint32Array | null = null;

function loadWidthTable() {
  const runs = WIDTH_TABLE.match(/[0-9a-v]*[A-Z]/g)!;
  widthStarts = new Uint32Array(runs.length);
  widthClass = new Uint8Array(runs.length);
  let cp = 0;
  runs.forEach((r, i) => {
    cp += r.length > 1 ? parseInt(r.slice(0, -1), 32) : 0;
    widthStarts![i] = cp;
    widthClass![i] = r.charCodeAt(r.length - 1) - 65;
  });
}

/** w0 * 3 + w1 (+ 9 if skipped after a ZWJ); see test/fixtures-gen/icu-width-table.mjs. */
function classOf(cp: number): number {
  if (widthStarts === null) loadWidthTable();
  const starts = widthStarts!;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  return widthClass![lo];
}

export function getStringWidth(str: string, ambiguousAsFullWidth?: unknown, expandEmojiSequence?: unknown): number {
  const amb = ambiguousAsFullWidth === true;
  const expand = typeof expandEmojiSequence !== 'boolean' || expandEmojiSequence;
  let width = 0;
  let c = 0;
  for (let n = 0; n < str.length; ) {
    const p = c;
    // U16_NEXT: a lone surrogate is taken as its own code point
    c = str.charCodeAt(n++);
    if (c >= 0xd800 && c <= 0xdbff && n < str.length) {
      const d = str.charCodeAt(n);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
        n++;
      }
    }
    const k = classOf(c);
    if (!expand && p === 0x200d && k >= 9) continue;
    const w = k % 9;
    width += amb ? w % 3 : Math.trunc(w / 3);
  }
  return width;
}

// -----------------------------------------------------------------------------
// icuErrName

const ERR_NAMES: Record<number, string> = {
  [-128]: 'U_USING_FALLBACK_WARNING',
  [-127]: 'U_USING_DEFAULT_WARNING',
  [-126]: 'U_SAFECLONE_ALLOCATED_WARNING',
  [-125]: 'U_STATE_OLD_WARNING',
  [-124]: 'U_STRING_NOT_TERMINATED_WARNING',
  [-123]: 'U_SORT_KEY_TOO_SHORT_WARNING',
  [-122]: 'U_AMBIGUOUS_ALIAS_WARNING',
  [-121]: 'U_DIFFERENT_UCA_VERSION',
  [-120]: 'U_PLUGIN_CHANGED_LEVEL_WARNING',
};
const ERR_BLOCKS: [number, string][] = [
  [
    0,
    'ZERO_ERROR ILLEGAL_ARGUMENT_ERROR MISSING_RESOURCE_ERROR INVALID_FORMAT_ERROR FILE_ACCESS_ERROR INTERNAL_PROGRAM_ERROR MESSAGE_PARSE_ERROR MEMORY_ALLOCATION_ERROR INDEX_OUTOFBOUNDS_ERROR PARSE_ERROR INVALID_CHAR_FOUND TRUNCATED_CHAR_FOUND ILLEGAL_CHAR_FOUND INVALID_TABLE_FORMAT INVALID_TABLE_FILE BUFFER_OVERFLOW_ERROR UNSUPPORTED_ERROR RESOURCE_TYPE_MISMATCH ILLEGAL_ESCAPE_SEQUENCE UNSUPPORTED_ESCAPE_SEQUENCE NO_SPACE_AVAILABLE CE_NOT_FOUND_ERROR PRIMARY_TOO_LONG_ERROR STATE_TOO_OLD_ERROR TOO_MANY_ALIASES_ERROR ENUM_OUT_OF_SYNC_ERROR INVARIANT_CONVERSION_ERROR INVALID_STATE_ERROR COLLATOR_VERSION_MISMATCH USELESS_COLLATOR_ERROR NO_WRITE_PERMISSION INPUT_TOO_LONG_ERROR',
  ],
  [
    0x10000,
    'BAD_VARIABLE_DEFINITION MALFORMED_RULE MALFORMED_SET MALFORMED_SYMBOL_REFERENCE MALFORMED_UNICODE_ESCAPE MALFORMED_VARIABLE_DEFINITION MALFORMED_VARIABLE_REFERENCE MISMATCHED_SEGMENT_DELIMITERS MISPLACED_ANCHOR_START MISPLACED_CURSOR_OFFSET MISPLACED_QUANTIFIER MISSING_OPERATOR MISSING_SEGMENT_CLOSE MULTIPLE_ANTE_CONTEXTS MULTIPLE_CURSORS MULTIPLE_POST_CONTEXTS TRAILING_BACKSLASH UNDEFINED_SEGMENT_REFERENCE UNDEFINED_VARIABLE UNQUOTED_SPECIAL UNTERMINATED_QUOTE RULE_MASK_ERROR MISPLACED_COMPOUND_FILTER MULTIPLE_COMPOUND_FILTERS INVALID_RBT_SYNTAX INVALID_PROPERTY_PATTERN MALFORMED_PRAGMA UNCLOSED_SEGMENT ILLEGAL_CHAR_IN_SEGMENT VARIABLE_RANGE_EXHAUSTED VARIABLE_RANGE_OVERLAP ILLEGAL_CHARACTER',
  ],
  [
    0x10100,
    'UNEXPECTED_TOKEN MULTIPLE_DECIMAL_SEPARATORS MULTIPLE_EXPONENTIAL_SYMBOLS MALFORMED_EXPONENTIAL_PATTERN MULTIPLE_PERCENT_SYMBOLS MULTIPLE_PERMILL_SYMBOLS MULTIPLE_PAD_SPECIFIERS PATTERN_SYNTAX_ERROR ILLEGAL_PAD_POSITION UNMATCHED_BRACES UNSUPPORTED_PROPERTY UNSUPPORTED_ATTRIBUTE ARGUMENT_TYPE_MISMATCH DUPLICATE_KEYWORD UNDEFINED_KEYWORD DEFAULT_KEYWORD_MISSING',
  ],
  [
    0x10200,
    'BRK_INTERNAL_ERROR BRK_HEX_DIGITS_EXPECTED BRK_SEMICOLON_EXPECTED BRK_RULE_SYNTAX BRK_UNCLOSED_SET BRK_ASSIGN_ERROR BRK_VARIABLE_REDFINITION BRK_MISMATCHED_PAREN BRK_NEW_LINE_IN_QUOTED_STRING BRK_UNDEFINED_VARIABLE BRK_INIT_ERROR BRK_RULE_EMPTY_SET BRK_UNRECOGNIZED_OPTION BRK_MALFORMED_RULE_TAG',
  ],
  [
    0x10300,
    'REGEX_INTERNAL_ERROR REGEX_RULE_SYNTAX REGEX_INVALID_STATE REGEX_BAD_ESCAPE_SEQUENCE REGEX_PROPERTY_SYNTAX REGEX_UNIMPLEMENTED REGEX_MISMATCHED_PAREN REGEX_NUMBER_TOO_BIG REGEX_BAD_INTERVAL REGEX_MAX_LT_MIN REGEX_INVALID_BACK_REF REGEX_INVALID_FLAG REGEX_LOOK_BEHIND_LIMIT REGEX_SET_CONTAINS_STRING REGEX_OCTAL_TOO_BIG REGEX_MISSING_CLOSE_BRACKET',
  ],
  [
    0x10400,
    'STRINGPREP_PROHIBITED_ERROR STRINGPREP_UNASSIGNED_ERROR STRINGPREP_CHECK_BIDI_ERROR IDNA_STD3_ASCII_RULES_ERROR IDNA_ACE_PREFIX_ERROR IDNA_VERIFICATION_ERROR IDNA_LABEL_TOO_LONG_ERROR IDNA_ZERO_LENGTH_LABEL_ERROR IDNA_DOMAIN_NAME_TOO_LONG_ERROR',
  ],
  [0x10500, 'PLUGIN_TOO_HIGH PLUGIN_DIDNT_SET_LEVEL'],
];
for (const [base, names] of ERR_BLOCKS) names.split(' ').forEach((n, i) => (ERR_NAMES[base + i] = `U_${n}`));

const U_ILLEGAL_ARGUMENT_ERROR = 1;
const U_INVALID_CHAR_FOUND = 10;

// -----------------------------------------------------------------------------
// transcode

const enum TEnc {
  ASCII,
  LATIN1,
  UCS2,
  UTF8,
  OTHER,
}

// ParseEncoding (node's api/encoding.cc), reduced to the encodings transcode supports.
function parseEncoding(v: unknown): TEnc {
  if (typeof v !== 'string') return TEnc.OTHER;
  switch (v.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return TEnc.UTF8;
    case 'ascii':
      return TEnc.ASCII;
    case 'latin1':
    case 'binary':
      return TEnc.LATIN1;
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return TEnc.UCS2;
    default:
      return TEnc.OTHER;
  }
}

// Captured at load: Node's bootstrap replaces the TextDecoder global with its own (which calls back
// into this binding).
const NativeTextDecoder: typeof TextDecoder = globalThis.TextDecoder;

const utf8Lenient = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf16Lenient = new TextDecoder('utf-16le', { ignoreBOM: true });
const utf8Enc = new TextEncoder();

function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 * i] = c & 0xff;
    out[2 * i + 1] = c >> 8;
  }
  return out;
}

function hasLoneSurrogate(s: string): boolean {
  return typeof (s as any).isWellFormed === 'function' ? !(s as any).isWellFormed() : /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Code points encoded to a single-byte charset. ICU's substitute callback writes '?' for anything
 * outside it, but skips unmappable default-ignorable code points (BOM, ZWSP, ...).
 */
function singleByte(s: string, max: number): Uint8Array {
  const out = new Uint8Array(s.length);
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= max) out[n++] = cp;
    else if (!DEFAULT_IGNORABLE.test(ch)) out[n++] = 0x3f;
  }
  return out.subarray(0, n);
}

/** Source bytes decoded the way ICU's converters do (illegal sequences become U+FFFD). */
function lenientDecode(src: Uint8Array, enc: TEnc): string {
  switch (enc) {
    case TEnc.UTF8:
      return utf8Lenient.decode(src);
    case TEnc.UCS2:
      return utf16Lenient.decode(src);
    case TEnc.LATIN1: {
      let s = '';
      for (let i = 0; i < src.length; i += 8192) s += String.fromCharCode.apply(null, src.subarray(i, i + 8192) as unknown as number[]);
      return s;
    }
    default: {
      let s = '';
      for (let i = 0; i < src.length; i++) s += src[i] < 0x80 ? String.fromCharCode(src[i]) : '�';
      return s;
    }
  }
}

function encodeTo(s: string, enc: TEnc): Uint8Array {
  switch (enc) {
    case TEnc.UTF8:
      return utf8Enc.encode(s);
    case TEnc.UCS2:
      return utf16leBytes(s);
    case TEnc.LATIN1:
      return singleByte(s, 0xff);
    default:
      return singleByte(s, 0x7f);
  }
}

/** Returns the transcoded bytes, or an ICU error code. */
export function transcodeBytes(src: Uint8Array, fromEnc: unknown, toEnc: unknown): Uint8Array | number {
  const from = parseEncoding(fromEnc);
  const to = parseEncoding(toEnc);
  if (from === TEnc.OTHER || to === TEnc.OTHER) return U_ILLEGAL_ARGUMENT_ERROR;
  // The simdutf fast paths fail on invalid input (and, like the C++, on empty input).
  if ((from === TEnc.ASCII || from === TEnc.LATIN1) && to === TEnc.UCS2) {
    if (src.length === 0) return U_INVALID_CHAR_FOUND;
    const out = new Uint8Array(src.length * 2);
    for (let i = 0; i < src.length; i++) out[2 * i] = src[i];
    return out;
  }
  if (from === TEnc.UTF8 && to === TEnc.UCS2) {
    let s: string;
    try {
      s = utf8Strict.decode(src);
    } catch {
      return U_INVALID_CHAR_FOUND;
    }
    return s.length === 0 ? U_INVALID_CHAR_FOUND : utf16leBytes(s);
  }
  if (from === TEnc.UCS2 && to === TEnc.UTF8) {
    const units = src.length >> 1;
    let s = '';
    for (let i = 0; i < units; i++) s += String.fromCharCode(src[2 * i] | (src[2 * i + 1] << 8));
    if (s.length === 0 || hasLoneSurrogate(s)) return U_INVALID_CHAR_FOUND;
    return utf8Enc.encode(s);
  }
  if (from === TEnc.UCS2 && to !== TEnc.UCS2) {
    // ucnv_fromUChars over whole UTF-16 units: an odd trailing byte is dropped, lone surrogates
    // become the substitution character.
    const units = src.length >> 1;
    let s = '';
    for (let i = 0; i < units; i++) s += String.fromCharCode(src[2 * i] | (src[2 * i + 1] << 8));
    return encodeTo(s, to);
  }
  // ucnv_convertEx through UTF-16 with '?' substitution.
  return encodeTo(lenientDecode(src, from), to);
}

function toBuffer(bytes: Uint8Array): Uint8Array {
  // C++ hands back a Buffer (FastBuffer); without Node's lib loaded, a plain Uint8Array.
  const FastBuffer = S.requireBuiltin ? S.requireBuiltin('internal/buffer')?.FastBuffer : undefined;
  return FastBuffer ? new FastBuffer(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
}

// -----------------------------------------------------------------------------
// converters (TextDecoder for non-UTF-8 encodings)

const CONVERTER_FLAGS_FLUSH = 0x1;
const CONVERTER_FLAGS_FATAL = 0x2;
const CONVERTER_FLAGS_IGNORE_BOM = 0x4;

class Converter {
  decoder: TextDecoder;
  constructor(
    readonly label: string,
    readonly flags: number,
  ) {
    this.decoder = this.fresh();
  }
  fresh() {
    return new NativeTextDecoder(this.label, { fatal: (this.flags & CONVERTER_FLAGS_FATAL) !== 0, ignoreBOM: (this.flags & CONVERTER_FLAGS_IGNORE_BOM) !== 0 });
  }
}
Object.defineProperty(Converter, 'name', { value: 'Converter' });

function nodeError(Ctor: ErrorConstructor | TypeErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

function hasConverter(label: unknown): boolean {
  // WHATWG-only encodings ICU has no converter for
  if (String(label).toLowerCase() === 'x-user-defined') return false;
  try {
    new NativeTextDecoder(String(label));
    return true;
  } catch {
    return false;
  }
}

export function createIcu() {
  const b = fromShape('icu');
  return Object.assign(b, {
    getStringWidth,

    icuErrName(code: number) {
      return ERR_NAMES[code] ?? '[BOGUS UErrorCode]';
    },

    transcode(source: ArrayBufferView, fromEncoding: unknown, toEncoding: unknown) {
      const src = bufferSourceBytes(source) ?? new Uint8Array(0);
      const r = transcodeBytes(decodable(src), fromEncoding, toEncoding);
      return typeof r === 'number' ? r : toBuffer(r);
    },

    hasConverter,

    getConverter(label: unknown, flags: unknown) {
      if (!hasConverter(label)) return undefined;
      return new Converter(String(label), Number(flags) >>> 0);
    },

    decode(converter: Converter, input: unknown, flags: unknown, fromEncoding: string) {
      const data = bufferSourceBytes(input);
      if (data === null) {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "input" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
      }
      const flush = ((Number(flags) >>> 0) & CONVERTER_FLAGS_FLUSH) !== 0;
      try {
        return converter.decoder.decode(decodable(data), { stream: !flush });
      } catch {
        if (flush) converter.decoder = converter.fresh();
        throw nodeError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', `The encoded data was not valid for encoding ${fromEncoding}`);
      }
    },
  });
}

// prettier-ignore
// <width-table>
// Generated by test/fixtures-gen/icu-width-table.mjs from Node v22.20.0 (ICU 77.1, Unicode 16.0).
const WIDTH_TABLE =
  '0A10E2vA11E1F1E2F1E2F2E1F1E2F2E1F5E1F5E1F4E6F1E9F1E6F2E5F4E4F1E1F3E1F2E2F1E1F2E3F4E1F1E1F1E2F1EfF1E1F1E7F1EaF2E3F1E5F3E4' +
  'F1E6F4E1F1E3F4E1F1E4F2EiF2E3F1E32F1E1F1E1F1E1F1E1F1E1F1E1F1E1F1E3kF1EfF1E32F1E2F1E1F3E1F1E2F1E7F4E1F1E1F1E10C3gE11FhE1F7' +
  'E7FhE1F7E1nF1EeF20E1F1E1hA7E87A1dE1A1E1A2E1A2E1A1E1oA6EaAbE1A1E1eAlEgA1E35A8E1A6E2A2E1A4E11A1E1A1EuArE2rAbE1qA9E9A1EoA4E' +
  '1A9E1A3E1A5E1bA3E1kA2E5A9E1aA1pE1nA1E1A1E4A8E4A1E3A7EaA2EtA1E1qA1E4A4E8A1EkA2EqA1E2A2E1pA1E4A2E4A2E2A3E3A1EuA2E3A1EbA2E1' +
  'pA1E4A5E1A2E4A1EkA2EmA6E1A1E1qA1E2A1E1A4E8A1E7A2EbA2EuA1E1tA1EcA1E1iA1E3A1E1nA1E1A3E5A3E1A4E7A2EbA2EtA1E1qA1E2A1E6A1E5A2' +
  'EkA2EsA2E1pA2E4A4E8A1EkA2EtA1E28A1E7A3E1A1E2qA1E2A7EcA8E32A1E2A9EbA7E29A2ErA1E1A1E1A1E1nAeE1A5E1A2E5AbE1A14E9A1E36A4E1A6' +
  'E1A2E2A2EpA2E4A3EgA4EdA1E2A2E6A1EfA1E32I30EftA3EtiA3EtA2EuA2EuA2E20A2E1A7E8A1E2AbE9A1E1dA5E3lA2E12A1E3mA3E4A2E9A1E6A3E6r' +
  'A2E2A1E1qA1E1A7E1A1E1A1E2A8E6AaE2A1E1gAvE1hA4E1gA1E1A5E1A1E5A1E18A9EcA2E10A4E2A2E1A3E1oA1E1A2E3A1E1A3E1qA8E2A2E4oA3E1AdE' +
  '1A7E4A1E6A1E3A2E66A20EgbA5F1E2F4E1F2E2F2E2F3E1F4E2A5E1F1E1F2E1F1E5F1E2F1E11A5E1AaE4F1EaF1E1F4E17F1E13A11EiF1E1F1E3F1E9F1' +
  'E2F1EaF2E3F1E4F1E17F2E6F4E1FcE4FaEfF1E6FaEuF2EoF1E1F1EiF1EoF1E1F2E3F2E2F1E3F1E1F1E3F1E4F1E2F4E2F1E1F1E1F6E1F1E5F4E4F2EaF' +
  '1E3F1E5F1EdF2E2F4E2F2E2F2EiF2E2F2EdF1E3F1EbF1EpF1E2iF1E7R2EdI2E5uR4E3R1E2R1E3cF4aE1F31E4F14EcFgE2F4EaF2E1F7E8F2E2F2E4F2E' +
  '2F2E4F3E2F1E2F4EgF4E9F1EdR2E6F2E2F1E4F2E4R2E6F1E1F1EhI8E8F1E1F1E5RcEcF2E1F3E1F4E1F2E1F1EfR1EaI6E3R1EaF2E1R1E8R2EhR2F1E4R' +
  '2F8R1F5R1FdE1F1E4F2R1F7R2F1R1F4R1F2R1F2E5R1E4R2EsR1EkF1EeR1E1R1E4R3E1R1EuFaElR3EoR1EeR1EqrR2E1jR1E4R1F4EclA3E4dA1E30A10E' +
  '40IqE1I2pEcI6mEqI2fE2I2mE2I37E5I1bE1I2uE1I2mE9I1gE1I18F8IshtE3I1nEd8A4E1AaE10A2E2gA2E8gA1E3A1E4A1EpA2E5A1E4nA2EqAiEdA1E1' +
  '6A8EpAbEeItE3A3E1gA1E2A4E2A2E17A1E23A6E2A2E2A2EcA1E8A1E1fA1E1jA1E1A3E2A2E5A2E1A1E1aA2E8A1E7eA1E2A1E4A1EiIat4E22sF680Ig0E' +
  'uA1En1CgIaE6AgI13E1IjE1I4E4jA1E1I30E3vI7EiA3E1F1EfvA1E72A1E4lA5E1k6A3E1A2E5A4E18A3E4A1E55A2EhtA4E21A5E9tA2E2fA4E26AbE1hA' +
  '4E3rA1E1mAfE19A1E2A2EaA3E1hA4E2A2E2A1E4A1EaA1E1iA3E14A5E1A8E1uA1EcA2E1kA9EaA4E2A1E2vA3E2A1E1A2E6A1E2A1E4tA1E3A8ElA2E1pA2' +
  'E3A1E15A7E3A5E26A6EdA1E1A1E1A1EeA2E2lA8E2A3E1A1EnA1E2kA6E1A1E4A2E1A2E7eA4E6A2E1A2ErA2E2lA8E2A1E1A2E3aA1E1A1E2A6E1A1E35A1' +
  'E1A1E2A4E1A5E83A9E1A2E80A2E1A1E4A1E4gA4E2A2E4A1E10AaE18A6E2A4E8A1E9A6E2A3E1eAdE1A2EcmA7E1A6E1A1E2iAmE2A7E1A2E1A2E3qA6E3A' +
  '1E1A2E1A7E1A1E28A2E3A1E1A1EarA2EbA2E1kA5E5A1E1A1EnA1E56lAhE6AfEb68AcE3A3E2e0A5E1rA7E10oA1E1vA4E2dI5EbI2EeI5voE8I16mE19Ia' +
  'E8n7I4E1I7E1I2E1I93EfI1EtI3E2I1EeI4E8IccE2d1A2E1A4E4isA1eE2AnEh0A3E9AgE2A7EuA4E4kA3E5rI2nE9InE1k9A1nE4A1iE8A1EeA1EmA5E1A' +
  'fE1agA7E1AhE2A7E1A2E1A5E34A1E50A7EbnA1E1tA4EfsA4E7uA2En0A7E3dA7E1lpR1E6aR1E1gFbE5FuE2F1qE6FuR1F2RaFiE1pRqI1R1I1EdIaR1IkR' +
  '1I2R5I1R3I1E4I9E7R2EeI6E4qR11EcR9E1R26E1RmEcR1bE4R5EcRhE3R1E3R27E1R1E1R5rE2R1vEdR4E1RoEiR1EqR2EdR1E2mR2lE1gR26E6R1E3R3E2' +
  'R3E4R4EbR2E7R9E73RcE4R1E8rR1fE1RaE1R5pE3gRdE3RaE5R1oE7RfE2RbE6R9E187I1vvuE2I1vvuEk003A1EuA30E40C7gE1vggF1vvuE2F1vvuE';
// </width-table>
