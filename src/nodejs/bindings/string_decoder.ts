// internalBinding('string_decoder') — string_decoder.cc. The decoder state lives in a kSize-byte
// Buffer owned by lib/string_decoder.js: up to 4 bytes of an incomplete character, the number of
// bytes still missing, the number buffered, and the encoding.

import { fromShape } from './shape.ts';
import { decode, Enc } from './buffer.ts';

// StringDecoder field offsets (string_decoder.h)
const kIncompleteCharactersStart = 0;
const kIncompleteCharactersEnd = 4;
const kMissingBytes = 4;
const kBufferedBytes = 5;
const kEncodingField = 6;

function makeString(b: Uint8Array, enc: Enc): string {
  return decode(b, enc);
}

function viewBytes(v: ArrayBufferView): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function decodeData(state: Uint8Array, chunk: ArrayBufferView): string {
  const enc = state[kEncodingField] as Enc;
  let data = viewBytes(chunk);
  if (enc !== Enc.UTF8 && enc !== Enc.UCS2 && enc !== Enc.BASE64 && enc !== Enc.BASE64URL) {
    return makeString(data, enc);
  }
  const incomplete = state.subarray(kIncompleteCharactersStart, kIncompleteCharactersEnd);
  let prepend: string | null = null;

  // Finish a character left incomplete by the previous chunk.
  if (state[kMissingBytes] > 0) {
    if (enc === Enc.UTF8) {
      // Align with V8's decoder: a non-continuation byte ends the incomplete character early; the
      // bytes collected so far are decoded as they are.
      for (let i = 0; i < data.length && i < state[kMissingBytes]; i++) {
        if ((data[i] & 0xc0) !== 0x80) {
          state[kMissingBytes] = 0;
          incomplete.set(data.subarray(0, i), state[kBufferedBytes]);
          state[kBufferedBytes] += i;
          data = data.subarray(i);
          break;
        }
      }
    }
    const found = Math.min(data.length, state[kMissingBytes]);
    incomplete.set(data.subarray(0, found), state[kBufferedBytes]);
    data = data.subarray(found);
    state[kMissingBytes] -= found;
    state[kBufferedBytes] += found;
    if (state[kMissingBytes] === 0) {
      prepend = makeString(incomplete.subarray(0, state[kBufferedBytes]), enc);
      state[kBufferedBytes] = 0;
    }
  }

  let body: string;
  const nread0 = data.length;
  if (nread0 === 0) {
    body = prepend ?? '';
    prepend = null;
  } else {
    // See whether the chunk ends inside a character that the next chunk must finish.
    if (enc === Enc.UTF8 && data[nread0 - 1] & 0x80) {
      for (let i = nread0 - 1; ; i--) {
        state[kBufferedBytes]++;
        if ((data[i] & 0xc0) === 0x80) {
          // A trailing byte. Too many of them, or no lead byte in this chunk: invalid UTF-8,
          // leave it to the decoder.
          if (state[kBufferedBytes] >= 4 || i === 0) {
            state[kBufferedBytes] = 0;
            break;
          }
        } else {
          if ((data[i] & 0xe0) === 0xc0) state[kMissingBytes] = 2;
          else if ((data[i] & 0xf0) === 0xe0) state[kMissingBytes] = 3;
          else if ((data[i] & 0xf8) === 0xf0) state[kMissingBytes] = 4;
          else {
            state[kBufferedBytes] = 0;
            break;
          }
          if (state[kBufferedBytes] >= state[kMissingBytes]) {
            state[kMissingBytes] = 0;
            state[kBufferedBytes] = 0;
          }
          state[kMissingBytes] -= state[kBufferedBytes];
          break;
        }
      }
    } else if (enc === Enc.UCS2) {
      if (nread0 % 2 === 1) {
        state[kBufferedBytes] = 1;
        state[kMissingBytes] = 1;
      } else if ((data[nread0 - 1] & 0xfc) === 0xd8) {
        state[kBufferedBytes] = 2;
        state[kMissingBytes] = 2;
      }
    } else if (enc === Enc.BASE64 || enc === Enc.BASE64URL) {
      state[kBufferedBytes] = nread0 % 3;
      if (state[kBufferedBytes] > 0) state[kMissingBytes] = 3 - state[kBufferedBytes];
    }

    let nread = nread0;
    const buffered = state[kBufferedBytes];
    if (buffered > 0) {
      nread -= buffered;
      incomplete.set(data.subarray(nread, nread + buffered));
    }
    body = nread > 0 ? makeString(data.subarray(0, nread), enc) : '';
  }
  return prepend === null ? body : prepend + body;
}

export function flushData(state: Uint8Array): string {
  const enc = state[kEncodingField] as Enc;
  if (enc === Enc.UCS2 && state[kBufferedBytes] % 2 === 1) {
    // Ignore a single trailing byte, like the JS decoder does.
    state[kMissingBytes]--;
    state[kBufferedBytes]--;
  }
  if (state[kBufferedBytes] === 0) return '';
  const ret = makeString(state.subarray(kIncompleteCharactersStart, kIncompleteCharactersStart + state[kBufferedBytes]), enc);
  state[kMissingBytes] = 0;
  state[kBufferedBytes] = 0;
  return ret;
}

export function createStringDecoder() {
  const b = fromShape('string_decoder');
  return Object.assign(b, {
    decode(state: Uint8Array, chunk: ArrayBufferView) {
      if (!ArrayBuffer.isView(chunk)) throw new TypeError('string_decoder.decode: chunk must be an ArrayBufferView');
      return decodeData(state, chunk);
    },
    flush(state: Uint8Array) {
      return flushData(state);
    },
  });
}
