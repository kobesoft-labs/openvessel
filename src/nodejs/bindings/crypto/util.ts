// Shared helpers for internalBinding('crypto'): errors shaped like the C++ ones, byte sources,
// encodings, Buffer creation and the CryptoJob protocol (sync run() → [err, result], async ondone).

import { Enc, encode, decode } from '../buffer.ts';
import { macrotask, scope, startReq } from '../../loop.ts';
import { S } from '../../state.ts';

export const kCryptoJobAsync = 0;
export const kCryptoJobSync = 1;

// -----------------------------------------------------------------------------
// errors

type ErrCtor = ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor;

/** THROW_ERR_* from node_errors.h: a plain V8 error with an own `code`. */
export function nodeError(code: string, Ctor: ErrCtor, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

const DEFAULTS: Record<string, [ErrCtor, string]> = {
  ERR_CRYPTO_INVALID_AUTH_TAG: [TypeError, 'Invalid authentication tag'],
  ERR_CRYPTO_INVALID_CURVE: [TypeError, 'Invalid EC curve name'],
  ERR_CRYPTO_INVALID_DIGEST: [TypeError, 'Invalid digest'],
  ERR_CRYPTO_INVALID_IV: [TypeError, 'Invalid initialization vector'],
  ERR_CRYPTO_INVALID_JWK: [TypeError, 'Invalid JWK format'],
  ERR_CRYPTO_INVALID_KEYLEN: [RangeError, 'Invalid key length'],
  ERR_CRYPTO_INVALID_KEYPAIR: [RangeError, 'Invalid key pair'],
  ERR_CRYPTO_INVALID_KEYTYPE: [RangeError, 'Invalid key type'],
  ERR_CRYPTO_INVALID_MESSAGELEN: [RangeError, 'Invalid message length'],
  ERR_CRYPTO_INVALID_SCRYPT_PARAMS: [RangeError, 'Invalid scrypt params'],
  ERR_CRYPTO_INVALID_STATE: [Error, 'Invalid state'],
  ERR_CRYPTO_INVALID_TAG_LENGTH: [RangeError, 'Invalid taglength'],
  ERR_CRYPTO_JWK_UNSUPPORTED_CURVE: [Error, 'Unsupported JWK EC curve'],
  ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE: [Error, 'Unsupported JWK Key Type.'],
  ERR_CRYPTO_OPERATION_FAILED: [Error, 'Operation failed'],
  ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH: [RangeError, 'Input buffers must have the same byte length'],
  ERR_CRYPTO_UNKNOWN_CIPHER: [Error, 'Unknown cipher'],
  ERR_CRYPTO_UNKNOWN_DH_GROUP: [Error, 'Unknown DH group'],
  ERR_CRYPTO_UNSUPPORTED_OPERATION: [Error, 'Unsupported crypto operation'],
  ERR_CRYPTO_JOB_INIT_FAILED: [Error, 'Failed to initialize crypto job config'],
  ERR_INVALID_ARG_TYPE: [TypeError, 'Invalid argument type'],
  ERR_INVALID_ARG_VALUE: [TypeError, 'Invalid argument value'],
  ERR_MISSING_ARGS: [TypeError, 'Missing arguments'],
  ERR_MISSING_PASSPHRASE: [TypeError, 'Passphrase required for encrypted key'],
  ERR_OUT_OF_RANGE: [RangeError, 'Out of range'],
  ERR_OSSL_EVP_INVALID_DIGEST: [Error, 'Invalid digest used'],
};

/** THROW_ERR_<code>(env[, message]) */
export function err(code: string, message?: string): Error {
  const [Ctor, def] = DEFAULTS[code] ?? [Error, code];
  return nodeError(code, Ctor, message ?? def);
}

/** An error decorated from the OpenSSL error queue (ThrowCryptoError with a queued error). */
export function osslError(packed: string, library: string, reason: string, code: string): Error {
  const e = new Error(`error:${packed}:${library}::${reason}`) as Error & Record<string, string>;
  e.library = library;
  e.reason = reason;
  e.code = code;
  return e;
}

/** ThrowCryptoError without a queued OpenSSL error: a plain Error carrying the default message. */
export function cryptoError(message: string): Error {
  return new Error(message);
}

export const OSSL = {
  badDecrypt: () => osslError('1C800064', 'Provider routines', 'bad decrypt', 'ERR_OSSL_BAD_DECRYPT'),
  wrongFinalBlockLength: () => osslError('1C80006B', 'Provider routines', 'wrong final block length', 'ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH'),
  tagNotSet: () => osslError('1C800077', 'Provider routines', 'tag not set', 'ERR_OSSL_TAG_NOT_SET'),
  notXof: () => osslError('030000B2', 'digital envelope routines', 'not XOF or invalid length', 'ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH'),
};

// -----------------------------------------------------------------------------
// bytes

export function isAnyBufferSource(v: unknown): boolean {
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer) || Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

/**
 * A plain Uint8Array view over an ArrayBuffer, SharedArrayBuffer or any ArrayBufferView (no copy).
 * Always a fresh plain Uint8Array, never a Buffer: Buffer#slice() does not copy.
 */
export function view(v: any): Uint8Array {
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v == null) return new Uint8Array(0);
  return new Uint8Array(v as ArrayBuffer);
}

const utf8 = new TextEncoder();

/** ByteSource::FromStringOrBuffer: strings are UTF-8. */
export function stringOrBuffer(v: unknown): Uint8Array {
  if (typeof v === 'string') return utf8.encode(v);
  return view(v);
}

export function copy(u: Uint8Array): Uint8Array {
  return u.slice();
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// The platform CSPRNG, captured before Node's bootstrap replaces globalThis.crypto with its own
// webcrypto (whose getRandomValues calls back into this binding).
const nativeGetRandomValues: (u: Uint8Array) => unknown = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

/** ncrypto::CSPRNG */
export function fillRandom(u: Uint8Array) {
  // the browser refuses views of a SharedArrayBuffer: fill a private chunk and copy it over
  const shared = !(u.buffer instanceof ArrayBuffer);
  const tmp = shared ? new Uint8Array(Math.min(u.length, 65536)) : null;
  for (let i = 0; i < u.length; i += 65536) {
    const part = u.subarray(i, Math.min(u.length, i + 65536));
    if (!tmp) {
      nativeGetRandomValues(part);
      continue;
    }
    const t = tmp.subarray(0, part.length);
    nativeGetRandomValues(t);
    part.set(t);
  }
}

// -----------------------------------------------------------------------------
// encodings (ParseEncoding / StringBytes)

const ENCODINGS: Record<string, Enc> = {
  utf8: Enc.UTF8,
  'utf-8': Enc.UTF8,
  ucs2: Enc.UCS2,
  'ucs-2': Enc.UCS2,
  utf16le: Enc.UCS2,
  'utf-16le': Enc.UCS2,
  latin1: Enc.LATIN1,
  binary: Enc.LATIN1,
  base64: Enc.BASE64,
  base64url: Enc.BASE64URL,
  hex: Enc.HEX,
  ascii: Enc.ASCII,
  buffer: Enc.BUFFER,
};

/** node::ParseEncoding: case-insensitive, falling back to `def` for anything unknown. */
export function parseEncoding(v: unknown, def: Enc): Enc {
  if (typeof v !== 'string') return def;
  return ENCODINGS[v] ?? ENCODINGS[v.toLowerCase()] ?? def;
}

/** The `Decode<T>` helper: (data, encoding) → bytes. */
export function decodeInput(data: unknown, encoding: unknown): Uint8Array {
  if (typeof data === 'string') {
    const enc = parseEncoding(encoding, Enc.UTF8);
    return encode(data, enc === Enc.BUFFER ? Enc.UTF8 : enc);
  }
  return view(data);
}

/** StringBytes::Encode: a Buffer for BUFFER, a string otherwise. */
export function encodeOutput(bytes: Uint8Array, enc: Enc): Uint8Array | string {
  if (enc === Enc.BUFFER) return toBuffer(bytes);
  return decode(bytes, enc);
}

// -----------------------------------------------------------------------------
// Buffer creation (Buffer::New / Buffer::Copy)

let bufferProto: object | null = null;

/** Lets the buffer binding hand over the prototype it receives from setBufferPrototype(). */
export function setBufferPrototype(proto: object) {
  bufferProto = proto;
}

function getBufferProto(): object | null {
  if (bufferProto) return bufferProto;
  try {
    if (S.requireBuiltin) {
      bufferProto = S.requireBuiltin('internal/buffer').FastBuffer.prototype;
      return bufferProto;
    }
  } catch {
    // not bootstrapped yet
  }
  return (globalThis as any).Buffer?.prototype ?? null;
}

/** Turns a fresh Uint8Array (that owns its whole ArrayBuffer) into a Buffer. */
export function toBuffer(u: Uint8Array): Uint8Array {
  const p = getBufferProto();
  if (p) Object.setPrototypeOf(u, p);
  return u;
}

/** An ArrayBuffer holding exactly these bytes. */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength && u.buffer instanceof ArrayBuffer) return u.buffer;
  return u.slice().buffer;
}

// -----------------------------------------------------------------------------
// CryptoJob

type Work = () => unknown;

/**
 * Builds a CryptoJob class. `configure(async, ...args)` validates the arguments (throwing like
 * AdditionalConfig does) and returns the work to run; the work returns the result or throws the
 * job error. Async jobs copy their inputs in `configure` (Node's ToCopy) when `async` is true.
 */
export function jobClass(name: string, configure: (async: boolean, ...args: any[]) => Work): any {
  // the AsyncWrap provider, e.g. PBKDF2Job → PBKDF2REQUEST
  const provider = name.replace(/Job$/, '').toUpperCase() + 'REQUEST';
  const C = class {
    #mode: number;
    #work: Work;
    #asyncId = 0;
    #triggerId = 0;
    ondone?: (err: unknown, result: unknown) => void;
    constructor(mode: number, ...args: any[]) {
      this.#mode = mode;
      this.#work = configure(mode === kCryptoJobAsync, ...args);
      if (mode === kCryptoJobAsync) {
        // AsyncWrap: an async id and the init hook (domains and async_hooks see the request)
        const hooks = asyncHooks();
        if (hooks) {
          this.#asyncId = hooks.newAsyncId();
          this.#triggerId = hooks.getDefaultTriggerAsyncId();
          hooks.emitInit(this.#asyncId, provider, this.#triggerId, this);
        }
      }
    }
    run() {
      const work = this.#work;
      if (this.#mode !== kCryptoJobAsync) {
        try {
          return [undefined, work()];
        } catch (e) {
          return [e, undefined];
        }
      }
      const done = startReq('CRYPTO');
      macrotask(() => {
        let error: unknown;
        let result: unknown;
        try {
          result = work();
        } catch (e) {
          error = e;
          result = undefined;
        }
        done();
        const hooks = this.#asyncId ? asyncHooks() : null;
        if (hooks) hooks.emitBefore(this.#asyncId, this.#triggerId, this);
        if (typeof this.ondone === 'function') scope(this.ondone, this, error, result);
        if (hooks) {
          // a handled uncaught exception has already emitted the after hooks
          if (hooks.executionAsyncId() === this.#asyncId) hooks.emitAfter(this.#asyncId);
          hooks.emitDestroy(this.#asyncId);
        }
      });
      return undefined;
    }
  };
  Object.defineProperty(C, 'name', { value: name });
  return C;
}

let asyncHooksModule: any;
function asyncHooks(): any {
  if (asyncHooksModule === undefined) {
    if (!S.requireBuiltin) return null; // before the bootstrap
    try {
      asyncHooksModule = S.requireBuiltin('internal/async_hooks');
    } catch {
      asyncHooksModule = null;
    }
  }
  return asyncHooksModule;
}

/** CryptoErrorStore with DERIVING_BITS_FAILED. */
export function derivingBitsFailed(): Error {
  return cryptoError('Deriving bits failed');
}
