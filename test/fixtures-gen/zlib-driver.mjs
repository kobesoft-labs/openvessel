// Drives an internalBinding('zlib') object the way lib/zlib.js does and records a transcript.
// Used by test/fixtures-gen/zlib.mjs with real Node's binding (to make the fixture) and by
// test/unit/bindings-zlib.test.ts with OpenVessel's (to compare against it).
//
// A spec: { cls, mode, init: {...}, chunkSize, steps: [{ op: 'write', flush, input, async? }, { op: 'params', level, strategy }, { op: 'reset' }, { op: 'close' }] }
// `input` names an entry of the fixture's inputs (or is { b64 } / null).

import { createHash } from 'node:crypto';

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');

function concat(chunks) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function errInfo(e) {
  return { name: e?.constructor?.name, code: e?.code, message: e?.message };
}

function paramsArray(len, params) {
  const a = new Uint32Array(len).fill(-1);
  for (const [k, v] of Object.entries(params ?? {})) a[+k] = v;
  return a;
}

/** Output bytes: inline when small, else length + sha256 (keeps the fixture small). */
function outRecord(u8) {
  if (u8.length <= 512) return b64(u8);
  return `${u8.length}:sha256:${createHash('sha256').update(u8).digest('hex')}`;
}

/** Runs one spec; resolves to its transcript. */
export async function runSpec(binding, spec, inputs) {
  const getInput = (x) => (x === null ? null : typeof x === 'string' ? inputs[x] : new Uint8Array(Buffer.from(x.b64, 'base64')));
  const transcript = { init: null, steps: [] };
  const writeState = new Uint32Array(2);
  const errors = [];
  let pending = null;
  const callbackThis = [];

  function processCallback() {
    callbackThis.push(this === handle);
    const p = pending;
    pending = null;
    p?.();
  }

  let handle;
  try {
    switch (spec.cls) {
      case 'Zlib':
        handle = new binding.Zlib(spec.mode);
        break;
      case 'BrotliEncoder':
        handle = new binding.BrotliEncoder(spec.mode);
        break;
      case 'BrotliDecoder':
        handle = new binding.BrotliDecoder(spec.mode);
        break;
      case 'ZstdCompress':
        handle = new binding.ZstdCompress();
        break;
      case 'ZstdDecompress':
        handle = new binding.ZstdDecompress();
        break;
    }
    handle.onerror = function (message, errno, code) {
      errors.push({ message, errno, code, thisOk: this === handle });
      const p = pending;
      pending = null;
      p?.();
    };
    const i = spec.init;
    if (spec.cls === 'Zlib') {
      handle.init(i.windowBits, i.level, i.memLevel, i.strategy, writeState, processCallback, i.dictionary ? getInput(i.dictionary) : undefined);
    } else if (spec.cls.startsWith('Brotli')) {
      handle.init(paramsArray(i.paramsLength, i.params), writeState, processCallback);
    } else {
      const args = [paramsArray(i.paramsLength, i.params), i.pledgedSrcSize, writeState, processCallback];
      if ('dictionary' in i) args.push(typeof i.dictionary === 'string' ? getInput(i.dictionary) : i.dictionary);
      handle.init(...args);
    }
  } catch (e) {
    transcript.init = { threw: errInfo(e), errors: errors.splice(0) };
    return transcript;
  }
  if (errors.length) transcript.init = { errors: errors.splice(0) };

  const chunkSize = spec.chunkSize ?? 16384;
  // The gzip header's OS byte (offset 9) is the platform zlib was built for: 3 (Unix) on Linux,
  // 19 on macOS. OpenVessel presents itself as Linux, so recordings use 3 wherever they were made.
  const isGzip = spec.cls === 'Zlib' && spec.mode === 3;
  let totalOut = 0;
  let out = new Uint8Array(chunkSize);
  let outOff = 0;

  for (const step of spec.steps) {
    const rec = { op: step.op };
    transcript.steps.push(rec);
    if (step.op === 'params') {
      handle.params(step.level, step.strategy);
    } else if (step.op === 'reset') {
      handle.reset();
      totalOut = 0; // a new gzip member follows
    } else if (step.op === 'close') {
      handle.close();
    } else if (step.op === 'write') {
      const input = getInput(step.input);
      let inOff = 0;
      let availIn = input ? input.length : 0;
      const outs = [];
      const states = [];
      for (let guard = 0; guard < 1e6; guard++) {
        const availOutBefore = chunkSize - outOff;
        if (step.async) {
          const p = new Promise((r) => (pending = r));
          handle.write(step.flush, input, inOff, availIn, out, outOff, availOutBefore);
          // the callback must not run synchronously inside write()
          rec.syncCallback ||= pending === null;
          await p;
        } else {
          handle.writeSync(step.flush, input, inOff, availIn, out, outOff, availOutBefore);
        }
        if (errors.length) break;
        const availOutAfter = writeState[0];
        const availInAfter = writeState[1];
        states.push([availOutAfter, availInAfter]);
        const have = availOutBefore - availOutAfter;
        if (have > 0) {
          const chunk = out.slice(outOff, outOff + have);
          if (isGzip && totalOut <= 9 && 9 < totalOut + have) chunk[9 - totalOut] = 3;
          totalOut += have;
          outs.push(chunk);
        }
        outOff += have;
        const inDelta = availIn - availInAfter;
        if (availOutAfter === 0 || outOff >= chunkSize) {
          out = new Uint8Array(chunkSize);
          outOff = 0;
        }
        if (availOutAfter === 0) {
          inOff += inDelta;
          availIn = availInAfter;
        } else {
          break;
        }
      }
      rec.states = states;
      rec.out = outRecord(concat(outs));
    }
    if (errors.length) {
      rec.errors = errors.splice(0);
      break;
    }
  }
  transcript.callbackThis = callbackThis.every(Boolean);
  return transcript;
}
