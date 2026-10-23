// internalBinding('serdes') — node_serdes.cc over a TypeScript port of V8's ValueSerializer /
// ValueDeserializer (src/objects/value-serializer.cc, wire format version 15 as V8 12.4 writes it).
//
// What the browser cannot tell us (V8 internals), and how it is approximated:
// - Smi vs HeapNumber: integers in int32 range (not -0) are written as Smis ('I'), the rest as doubles.
// - Elements kinds: an array with no holes is "packed" (dense format), else sparse; a packed array of
//   numbers with at least one non-Smi is PACKED_DOUBLE (every element written as a double).
// - One-byte vs two-byte strings: a string is one-byte when every code unit is <= 0xff.
// - Proxies and API (host) objects cannot be recognized; proxies are serialized through their traps.

import { NativeTextDecoder } from '../web.ts';
import { asBuffer, latin1 } from './buffer.ts';
import { fromShape } from './shape.ts';

const kLatestVersion = 15;
const kMinimumVersion = 13;

// Serialization tags
const T = {
  version: 0xff,
  padding: 0x00,
  verifyObjectCount: 0x3f, // ?
  theHole: 0x2d, // -
  undefined: 0x5f, // _
  null: 0x30, // 0
  true: 0x54, // T
  false: 0x46, // F
  int32: 0x49, // I
  uint32: 0x55, // U
  double: 0x4e, // N
  bigInt: 0x5a, // Z
  utf8String: 0x53, // S
  oneByteString: 0x22, // "
  twoByteString: 0x63, // c
  objectReference: 0x5e, // ^
  beginJSObject: 0x6f, // o
  endJSObject: 0x7b, // {
  beginSparseJSArray: 0x61, // a
  endSparseJSArray: 0x40, // @
  beginDenseJSArray: 0x41, // A
  endDenseJSArray: 0x24, // $
  date: 0x44, // D
  trueObject: 0x79, // y
  falseObject: 0x78, // x
  numberObject: 0x6e, // n
  bigIntObject: 0x7a, // z
  stringObject: 0x73, // s
  regExp: 0x52, // R
  beginJSMap: 0x3b, // ;
  endJSMap: 0x3a, // :
  beginJSSet: 0x27, // '
  endJSSet: 0x2c, // ,
  arrayBuffer: 0x42, // B
  resizableArrayBuffer: 0x7e, // ~
  arrayBufferTransfer: 0x74, // t
  arrayBufferView: 0x56, // V
  sharedArrayBuffer: 0x75, // u
  hostObject: 0x5c, // \
  error: 0x72, // r
} as const;

// Error sub-tags
const E = { eval: 0x45, range: 0x52, reference: 0x46, syntax: 0x53, type: 0x54, uri: 0x55, message: 0x6d, cause: 0x63, stack: 0x73, end: 0x2e };

// ArrayBufferView sub-tags, by the typed array's [[TypedArrayName]]
const VIEW_TAG: Record<string, number> = {
  Int8Array: 0x62, // b
  Uint8Array: 0x42, // B
  Uint8ClampedArray: 0x43, // C
  Int16Array: 0x77, // w
  Uint16Array: 0x57, // W
  Int32Array: 0x64, // d
  Uint32Array: 0x44, // D
  Float16Array: 0x68, // h
  Float32Array: 0x66, // f
  Float64Array: 0x46, // F
  BigInt64Array: 0x71, // q
  BigUint64Array: 0x51, // Q
  DataView: 0x3f, // ?
};
const g = globalThis as any;
const VIEW_CTOR: Record<number, any> = {};
for (const [name, tag] of Object.entries(VIEW_TAG)) if (g[name]) VIEW_CTOR[tag] = g[name];

// RegExp flag bits (JSRegExp::Flag)
const RE_FLAGS: [string, number][] = [
  ['global', 1],
  ['ignoreCase', 2],
  ['multiline', 4],
  ['sticky', 8],
  ['unicode', 16],
  ['dotAll', 32],
  ['hasIndices', 128],
  ['unicodeSets', 256],
];
const RE_FLAG_CHARS: [number, string][] = [
  [1, 'g'],
  [2, 'i'],
  [4, 'm'],
  [8, 'y'],
  [16, 'u'],
  [32, 's'],
  [128, 'd'],
  [256, 'v'],
];
const kRegExpFlagCount = 9;
const kRegExpLinear = 64;

// -----------------------------------------------------------------------------
// intrinsics, captured before Node's bootstrap or user code can replace them

const getter = (o: object, k: PropertyKey) => Object.getOwnPropertyDescriptor(o, k)?.get;
const call = Function.prototype.call.bind(Function.prototype.call) as (f: any, self: any, ...args: any[]) => any;
const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = getter(TypedArrayProto, Symbol.toStringTag)!;
const typedArrayBuffer = getter(TypedArrayProto, 'buffer')!;
const typedArrayByteOffset = getter(TypedArrayProto, 'byteOffset')!;
const typedArrayByteLength = getter(TypedArrayProto, 'byteLength')!;
const dataViewBuffer = getter(DataView.prototype, 'buffer')!;
const dataViewByteOffset = getter(DataView.prototype, 'byteOffset')!;
const dataViewByteLength = getter(DataView.prototype, 'byteLength')!;
const abByteLength = getter(ArrayBuffer.prototype, 'byteLength')!;
const abResizable = getter(ArrayBuffer.prototype, 'resizable');
const abMaxByteLength = getter(ArrayBuffer.prototype, 'maxByteLength');
const abDetached = getter(ArrayBuffer.prototype, 'detached');
const sabByteLength = typeof SharedArrayBuffer === 'function' ? getter(SharedArrayBuffer.prototype, 'byteLength') : undefined;
const sabGrowable = typeof SharedArrayBuffer === 'function' ? getter(SharedArrayBuffer.prototype, 'growable') : undefined;
const dateGetTime = Date.prototype.getTime;
const reGlobal = getter(RegExp.prototype, 'global')!;
const reSource = getter(RegExp.prototype, 'source')!;
const reFlagGetters = RE_FLAGS.map(([k, bit]) => [getter(RegExp.prototype, k), bit] as const).filter(([f]) => f);
const mapSize = getter(Map.prototype, 'size')!;
const setSize = getter(Set.prototype, 'size')!;
const mapEntries = Map.prototype.entries;
const mapSet = Map.prototype.set;
const setValues = Set.prototype.values;
const setAdd = Set.prototype.add;
const numberValueOf = Number.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
const symbolDescription = getter(Symbol.prototype, 'description')!;
const weakBrands: [any, any][] = [
  [WeakMap.prototype.has, {}],
  [WeakSet.prototype.has, {}],
  ...(typeof WeakRef === 'function' ? [[WeakRef.prototype.deref, undefined] as [any, any]] : []),
  ...(typeof FinalizationRegistry === 'function' ? [[FinalizationRegistry.prototype.unregister, {}] as [any, any]] : []),
];
const objectToString = Object.prototype.toString;
const errorToString = Error.prototype.toString;
const fnToString = Function.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const isError: (o: unknown) => boolean = typeof (Error as any).isError === 'function' ? (Error as any).isError : (o) => call(objectToString, o) === '[object Error]';
const NativeError = Error;
const NativeTypeError = TypeError;
const ERROR_CTORS: Record<number, ErrorConstructor> = {
  [E.eval]: EvalError,
  [E.range]: RangeError,
  [E.reference]: ReferenceError,
  [E.syntax]: SyntaxError,
  [E.type]: TypeError,
  [E.uri]: URIError,
};
const ERROR_TAG_BY_NAME: Record<string, number> = { EvalError: E.eval, RangeError: E.range, ReferenceError: E.reference, SyntaxError: E.syntax, TypeError: E.type, URIError: E.uri };
// Objects V8 refuses to clone that are still plain objects to JS: promises, generators, iterators.
const exoticProtos: object[] = (() => {
  const ps: object[] = [Promise.prototype];
  const add = (f: () => object) => {
    try {
      ps.push(f());
    } catch {}
  };
  const P = Object.getPrototypeOf;
  add(() => P(P((function* () {})())));
  add(() => P(P((async function* () {})())));
  add(() => P([][Symbol.iterator]()));
  add(() => P(new Map()[Symbol.iterator]()));
  add(() => P(new Set()[Symbol.iterator]()));
  add(() => P(''[Symbol.iterator]()));
  add(() => P(/a/[Symbol.matchAll]('a')));
  add(() => P((([] as any).values() as any).map((x: unknown) => x)));
  return ps;
})();
const utf8Decoder = new NativeTextDecoder();

function brand(fn: any, o: object, ...args: unknown[]): boolean {
  if (!fn) return false;
  try {
    call(fn, o, ...args);
    return true;
  } catch {
    return false;
  }
}

function nodeError(Ctor: ErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

// -----------------------------------------------------------------------------
// Object::NoSideEffectsToString, for "... could not be cloned." messages

function getDataProperty(o: any, key: PropertyKey): unknown {
  for (let p = o; p !== null && p !== undefined; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return 'value' in d ? d.value : undefined;
  }
  return undefined;
}

function noSideEffectsToString(v: unknown): string {
  if (typeof v === 'symbol') {
    const d = call(symbolDescription, v);
    return `Symbol(${d ?? ''})`;
  }
  if (typeof v === 'function') {
    let s: string;
    try {
      s = call(fnToString, v);
    } catch {
      s = 'function () { [native code] }';
    }
    return s.length > 128 ? `${s.slice(0, 111)}...<omitted>...${s.slice(-2)}` : s;
  }
  if (v === null || typeof v !== 'object') return String(v);
  const toString = getDataProperty(v, 'toString');
  if (isError(v) || toString === errorToString) {
    const name = getDataProperty(v, 'name');
    const msg = getDataProperty(v, 'message');
    const n = name === undefined ? 'Error' : String(name);
    const m = msg === undefined ? '' : String(msg);
    return !n ? m : !m ? n : `${n}: ${m}`;
  }
  if (toString === objectToString) {
    const ctor = getDataProperty(v, 'constructor');
    if (typeof ctor === 'function') {
      const name = Object.getOwnPropertyDescriptor(ctor, 'name')?.value;
      if (typeof name === 'string' && name) return `#<${name}>`;
    }
  }
  const tag = getDataProperty(v, Symbol.toStringTag);
  return `[object ${typeof tag === 'string' ? tag : className(v)}]`;
}

function className(v: object): string {
  if (ArrayBuffer.isView(v)) {
    const n = call(typedArrayName, v);
    return n ?? 'DataView';
  }
  if (Array.isArray(v)) return 'Array';
  return 'Object';
}

// -----------------------------------------------------------------------------
// classification of receivers (the instance types WriteJSReceiver switches on)

const enum K {
  Object,
  Array,
  Date,
  RegExp,
  Map,
  Set,
  ArrayBuffer,
  SharedArrayBuffer,
  View,
  Error,
  Wrapper,
  Unsupported,
}

function kindOf(o: object): K {
  if (Array.isArray(o)) return K.Array;
  if (ArrayBuffer.isView(o)) return K.View;
  if (brand(abByteLength, o)) return K.ArrayBuffer;
  if (brand(sabByteLength, o)) return K.SharedArrayBuffer;
  if (brand(dateGetTime, o)) return K.Date;
  try {
    if (typeof call(reGlobal, o) === 'boolean') return K.RegExp;
  } catch {}
  if (brand(mapSize, o)) return K.Map;
  if (brand(setSize, o)) return K.Set;
  if (brand(numberValueOf, o) || brand(booleanValueOf, o) || brand(stringValueOf, o) || brand(bigintValueOf, o) || brand(symbolValueOf, o)) return K.Wrapper;
  if (isError(o)) return K.Error;
  for (const [fn, arg] of weakBrands) if (brand(fn, o, arg)) return K.Unsupported;
  if (call(objectToString, o) === '[object Arguments]') return K.Unsupported;
  if (!exoticProtos.includes(o)) for (let p = Object.getPrototypeOf(o); p; p = Object.getPrototypeOf(p)) if (exoticProtos.includes(p)) return K.Unsupported;
  return K.Object;
}

const isSmi = (n: number) => (n | 0) === n && !Object.is(n, -0);

function isArrayIndex(k: string): boolean {
  if (k.length === 0 || k.length > 10) return false;
  const c = k.charCodeAt(0);
  if (c === 48) return k.length === 1;
  if (c < 49 || c > 57) return false;
  for (let i = 1; i < k.length; i++) {
    const d = k.charCodeAt(i);
    if (d < 48 || d > 57) return false;
  }
  return Number(k) <= 4294967294;
}

function isOneByte(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

function varintSize(n: number): number {
  let size = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 128);
    size++;
  }
  return size;
}

// -----------------------------------------------------------------------------
// ValueSerializer

class Writer {
  buf = new Uint8Array(64);
  len = 0;
  private dv = new DataView(this.buf.buffer);
  ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  varint(n: number) {
    // n is a uint32
    this.ensure(5);
    n >>>= 0;
    while (n >= 0x80) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    this.buf[this.len++] = n;
  }
  varint64(n: bigint) {
    this.ensure(10);
    n = BigInt.asUintN(64, n);
    while (n >= 0x80n) {
      this.buf[this.len++] = Number(n & 0x7fn) | 0x80;
      n >>= 7n;
    }
    this.buf[this.len++] = Number(n);
  }
  zigzag(n: number) {
    this.varint(((n << 1) ^ (n >> 31)) >>> 0);
  }
  double(d: number) {
    this.ensure(8);
    this.dv.setFloat64(this.len, d, true);
    this.len += 8;
  }
  raw(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  release(): Uint8Array {
    const out = this.buf.slice(0, this.len);
    this.buf = new Uint8Array(64);
    this.dv = new DataView(this.buf.buffer);
    this.len = 0;
    return out;
  }
}

type SerState = {
  w: Writer;
  ids: Map<object, number>;
  nextId: number;
  transfer: Map<object, number>;
  viewsAsHost: boolean;
  self: any;
};

const serStates = new WeakMap<object, SerState>();
function serState(self: object): SerState {
  const s = serStates.get(self);
  if (!s) throw new NativeTypeError('Illegal invocation');
  return s;
}

/** SerializerContext::ThrowDataCloneError: `_getDataCloneError(message)` is thrown. */
function throwDataCloneError(st: SerState, message: string): never {
  const f = st.self._getDataCloneError;
  throw typeof f === 'function' ? f.call(st.self, message) : new NativeError(message);
}
const cloneError = (st: SerState, v: unknown): never => throwDataCloneError(st, `${noSideEffectsToString(v)} could not be cloned.`);

function writeString(w: Writer, s: string) {
  if (isOneByte(s)) {
    w.byte(T.oneByteString);
    w.varint(s.length);
    w.ensure(s.length);
    for (let i = 0; i < s.length; i++) w.buf[w.len++] = s.charCodeAt(i);
    return;
  }
  const byteLength = s.length * 2;
  // The reading side expects two-byte strings to be aligned.
  if ((w.len + 1 + varintSize(byteLength)) & 1) w.byte(T.padding);
  w.byte(T.twoByteString);
  w.varint(byteLength);
  w.ensure(byteLength);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w.buf[w.len++] = c & 0xff;
    w.buf[w.len++] = c >> 8;
  }
}

function writeBigIntContents(w: Writer, v: bigint) {
  const sign = v < 0n;
  let mag = sign ? -v : v;
  const bytes: number[] = [];
  while (mag > 0n) {
    bytes.push(Number(mag & 0xffn));
    mag >>= 8n;
  }
  while (bytes.length % 8) bytes.push(0);
  w.varint((sign ? 1 : 0) | (bytes.length << 1));
  w.raw(Uint8Array.from(bytes));
}

function writeNumber(w: Writer, n: number) {
  if (isSmi(n)) {
    w.byte(T.int32);
    w.zigzag(n);
  } else {
    w.byte(T.double);
    w.double(n);
  }
}

function writeKey(st: SerState, k: string) {
  if (isArrayIndex(k)) writeNumber(st.w, Number(k));
  else writeString(st.w, k);
}

function writeObject(st: SerState, v: unknown): void {
  const w = st.w;
  switch (typeof v) {
    case 'undefined':
      return w.byte(T.undefined);
    case 'boolean':
      return w.byte(v ? T.true : T.false);
    case 'number':
      return writeNumber(w, v);
    case 'bigint':
      w.byte(T.bigInt);
      return writeBigIntContents(w, v);
    case 'string':
      return writeString(w, v);
    case 'symbol':
      return cloneError(st, v);
  }
  if (v === null) return w.byte(T.null);
  const o = v as object;
  // A view's buffer is serialized before the view (and before the view gets its id).
  if (ArrayBuffer.isView(o) && !st.ids.has(o) && !st.viewsAsHost) writeReceiver(st, viewBuffer(o));
  writeReceiver(st, o);
}

function viewBuffer(v: ArrayBufferView): object {
  try {
    return viewInfo(v).buffer;
  } catch {
    return v.buffer;
  }
}

function writeReceiver(st: SerState, o: object): void {
  const w = st.w;
  const known = st.ids.get(o);
  if (known !== undefined) {
    w.byte(T.objectReference);
    w.varint(known);
    return;
  }
  st.ids.set(o, st.nextId++);
  if (typeof o === 'function') return cloneError(st, o);
  switch (kindOf(o)) {
    case K.Array:
      return writeJSArray(st, o as unknown[]);
    case K.Object:
      return writeJSObject(st, o);
    case K.Date:
      w.byte(T.date);
      return w.double(call(dateGetTime, o));
    case K.Wrapper:
      return writePrimitiveWrapper(st, o);
    case K.RegExp: {
      w.byte(T.regExp);
      writeString(w, call(reSource, o));
      let flags = 0;
      for (const [f, bit] of reFlagGetters) if (call(f, o)) flags |= bit;
      return w.varint(flags);
    }
    case K.Map: {
      const entries: unknown[] = [];
      for (const [k, x] of call(mapEntries, o) as IterableIterator<[unknown, unknown]>) entries.push(k, x);
      w.byte(T.beginJSMap);
      for (const x of entries) writeObject(st, x);
      w.byte(T.endJSMap);
      return w.varint(entries.length);
    }
    case K.Set: {
      const values = [...(call(setValues, o) as IterableIterator<unknown>)];
      w.byte(T.beginJSSet);
      for (const x of values) writeObject(st, x);
      w.byte(T.endJSSet);
      return w.varint(values.length);
    }
    case K.ArrayBuffer:
      return writeArrayBuffer(st, o as ArrayBuffer);
    case K.SharedArrayBuffer: {
      const f = st.self._getSharedArrayBufferId;
      if (typeof f !== 'function') throw new NativeError(`${noSideEffectsToString(o)} could not be cloned.`);
      const id = f.call(st.self, o);
      w.byte(T.sharedArrayBuffer);
      return w.varint(Number(id) >>> 0);
    }
    case K.View:
      return st.viewsAsHost ? writeHostObject(st, o) : writeArrayBufferView(st, o as ArrayBufferView);
    case K.Error:
      return writeJSError(st, o as Error);
    default:
      return cloneError(st, o);
  }
}

function writeJSObject(st: SerState, o: object) {
  const w = st.w;
  w.byte(T.beginJSObject);
  const n = writeProperties(st, o, Object.keys(o));
  w.byte(T.endJSObject);
  w.varint(n);
}

function writeProperties(st: SerState, o: any, keys: string[]): number {
  let n = 0;
  for (const k of keys) {
    // A getter may have deleted a property listed before; skip those.
    if (!call(hasOwn, o, k)) continue;
    const value = o[k];
    writeKey(st, k);
    writeObject(st, value);
    n++;
  }
  return n;
}

function isPacked(a: unknown[], length: number): boolean {
  if (length > 1 << 20) {
    let count = 0;
    for (const k of Object.keys(a)) if (isArrayIndex(k)) count++;
    return count === length;
  }
  for (let i = 0; i < length; i++) if (!call(hasOwn, a, i)) return false;
  return true;
}

function writeJSArray(st: SerState, a: unknown[]) {
  const w = st.w;
  const length = a.length;
  if (isPacked(a, length)) {
    w.byte(T.beginDenseJSArray);
    w.varint(length);
    let allNumbers = true;
    let anyDouble = false;
    for (let i = 0; i < length && allNumbers; i++) {
      const x = a[i];
      if (typeof x !== 'number') allNumbers = false;
      else if (!isSmi(x)) anyDouble = true;
    }
    if (allNumbers && anyDouble) {
      // PACKED_DOUBLE_ELEMENTS: every element is written as a double
      for (let i = 0; i < length; i++) {
        w.byte(T.double);
        w.double(a[i] as number);
      }
    } else {
      for (let i = 0; i < length; i++) {
        if (!call(hasOwn, a, i)) {
          w.byte(T.theHole);
          continue;
        }
        writeObject(st, a[i]);
      }
    }
    const n = writeProperties(
      st,
      a,
      Object.keys(a).filter((k) => !isArrayIndex(k)),
    );
    w.byte(T.endDenseJSArray);
    w.varint(n);
    w.varint(length);
  } else {
    w.byte(T.beginSparseJSArray);
    w.varint(length);
    const n = writeProperties(st, a, Object.keys(a));
    w.byte(T.endSparseJSArray);
    w.varint(n);
    w.varint(length);
  }
}

function writePrimitiveWrapper(st: SerState, o: object) {
  const w = st.w;
  if (brand(booleanValueOf, o)) return w.byte(call(booleanValueOf, o) ? T.trueObject : T.falseObject);
  if (brand(numberValueOf, o)) {
    w.byte(T.numberObject);
    return w.double(call(numberValueOf, o));
  }
  if (brand(bigintValueOf, o)) {
    w.byte(T.bigIntObject);
    return writeBigIntContents(w, call(bigintValueOf, o));
  }
  if (brand(stringValueOf, o)) {
    w.byte(T.stringObject);
    return writeString(w, call(stringValueOf, o));
  }
  return cloneError(st, o);
}

function writeArrayBuffer(st: SerState, ab: ArrayBuffer) {
  const w = st.w;
  const transferId = st.transfer.get(ab);
  if (transferId !== undefined) {
    w.byte(T.arrayBufferTransfer);
    return w.varint(transferId);
  }
  if (abDetached && call(abDetached, ab)) return throwDataCloneError(st, 'An ArrayBuffer is detached and could not be cloned.');
  const byteLength: number = call(abByteLength, ab);
  if (byteLength > 0xffffffff) return cloneError(st, ab);
  if (abResizable && call(abResizable, ab)) {
    w.byte(T.resizableArrayBuffer);
    w.varint(byteLength);
    w.varint(call(abMaxByteLength, ab));
  } else {
    w.byte(T.arrayBuffer);
    w.varint(byteLength);
  }
  w.raw(new Uint8Array(ab, 0, byteLength));
}

function viewInfo(v: ArrayBufferView): { tag: number; offset: number; length: number; buffer: ArrayBufferLike } {
  const name = brand(typedArrayName, v) ? call(typedArrayName, v) : undefined;
  if (name) return { tag: VIEW_TAG[name], offset: call(typedArrayByteOffset, v), length: call(typedArrayByteLength, v), buffer: call(typedArrayBuffer, v) };
  return { tag: VIEW_TAG.DataView, offset: call(dataViewByteOffset, v), length: call(dataViewByteLength, v), buffer: call(dataViewBuffer, v) };
}

function writeArrayBufferView(st: SerState, v: ArrayBufferView) {
  const w = st.w;
  let info;
  try {
    info = viewInfo(v);
  } catch {
    return cloneError(st, v); // out of bounds
  }
  w.byte(T.arrayBufferView);
  w.varint(info.tag);
  w.varint(info.offset);
  // JsArrayBufferViewIsLengthTracking (bit 0) / JsArrayBufferViewIsBackedByRab (bit 1). Length
  // tracking is not observable; a view reaching the end of a resizable buffer is assumed to track.
  // A length-tracking view's stored byte length is 0.
  let flags = 0;
  const rab = abResizable && brand(abResizable, info.buffer) && call(abResizable, info.buffer);
  const gsab = sabGrowable && brand(sabGrowable, info.buffer) && call(sabGrowable, info.buffer);
  if (rab || gsab) {
    if (info.offset + info.length === (rab ? call(abByteLength, info.buffer) : call(sabByteLength!, info.buffer))) flags |= 1;
    if (rab) flags |= 2;
  }
  w.varint(flags & 1 ? 0 : info.length);
  w.varint(flags);
}

function writeHostObject(st: SerState, o: object) {
  st.w.byte(T.hostObject);
  const f = st.self._writeHostObject;
  if (typeof f !== 'function') throw new NativeError(`${noSideEffectsToString(o)} could not be cloned.`);
  f.call(st.self, o);
}

function writeJSError(st: SerState, e: Error) {
  const w = st.w;
  const messageDesc = Object.getOwnPropertyDescriptor(e, 'message');
  const causeDesc = Object.getOwnPropertyDescriptor(e, 'cause');
  w.byte(T.error);
  const name = String((e as any).name);
  const tag = ERROR_TAG_BY_NAME[name];
  if (tag !== undefined) w.varint(tag);
  if (messageDesc && 'value' in messageDesc) {
    const message = String(messageDesc.value);
    w.varint(E.message);
    writeString(w, message);
  }
  const stack = (e as any).stack;
  if (typeof stack === 'string') {
    w.varint(E.stack);
    writeString(w, stack);
  }
  if (causeDesc && 'value' in causeDesc) {
    w.varint(E.cause);
    writeObject(st, causeDesc.value);
  }
  w.varint(E.end);
}

// -----------------------------------------------------------------------------
// ValueDeserializer

/** Thrown internally for malformed data; becomes "Unable to deserialize cloned data." */
const FAIL = Symbol('fail');
const fail = (): never => {
  throw FAIL;
};

type DesState = {
  data: Uint8Array;
  pos: number;
  version: number;
  ids: Map<number, unknown>;
  nextId: number;
  transfer: Map<number, ArrayBufferLike>;
  broken13: boolean;
  self: any;
};

const desStates = new WeakMap<object, DesState>();
function desState(self: object): DesState {
  const s = desStates.get(self);
  if (!s) throw new NativeTypeError('Illegal invocation');
  return s;
}

function readTag(d: DesState): number {
  let t;
  do {
    if (d.pos >= d.data.length) fail();
    t = d.data[d.pos++];
  } while (t === T.padding);
  return t;
}

function peekTag(d: DesState): number {
  let p = d.pos;
  let t;
  do {
    if (p >= d.data.length) fail();
    t = d.data[p++];
  } while (t === T.padding);
  return t;
}

function readVarint(d: DesState, bits = 32): number {
  let value = 0;
  let shift = 0;
  let b;
  do {
    if (d.pos >= d.data.length) fail();
    b = d.data[d.pos++];
    if (shift < bits) {
      value |= (b & 0x7f) << shift;
      shift += 7;
    }
  } while (b & 0x80);
  return bits === 8 ? value & 0xff : value >>> 0;
}

function readVarint64(d: DesState): bigint {
  let value = 0n;
  let shift = 0n;
  let b;
  do {
    if (d.pos >= d.data.length) fail();
    b = d.data[d.pos++];
    if (shift < 64n) {
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    }
  } while (b & 0x80);
  return BigInt.asUintN(64, value);
}

function readDouble(d: DesState): number {
  if (d.data.length - d.pos < 8) fail();
  const v = new DataView(d.data.buffer, d.data.byteOffset + d.pos, 8).getFloat64(0, true);
  d.pos += 8;
  return v;
}

function readRaw(d: DesState, n: number): Uint8Array {
  if (n > d.data.length - d.pos) fail();
  const b = d.data.subarray(d.pos, d.pos + n);
  d.pos += n;
  return b;
}

function utf16(b: Uint8Array): string {
  let out = '';
  const n = b.length >> 1;
  const units = new Uint16Array(Math.min(n, 8192));
  for (let i = 0; i < n; i += 8192) {
    const m = Math.min(8192, n - i);
    for (let j = 0; j < m; j++) units[j] = b[2 * (i + j)] | (b[2 * (i + j) + 1] << 8);
    out += String.fromCharCode.apply(null, units.subarray(0, m) as unknown as number[]);
  }
  return out;
}

function readBigInt(d: DesState): bigint {
  const bitfield = readVarint(d);
  const byteLength = (bitfield >>> 1) & 0x3fffffff;
  const sign = bitfield & 1;
  const bytes = readRaw(d, byteLength);
  if (byteLength === 0 && sign) fail(); // there is no -0n
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return sign ? -v : v;
}

function readString(d: DesState): string {
  const v = readObject(d);
  if (typeof v !== 'string') fail();
  return v as string;
}

function addId(d: DesState, id: number, v: unknown) {
  d.ids.set(id, v);
}

function readObject(d: DesState): unknown {
  let v = readObjectInternal(d);
  // An ArrayBufferView consumes the ArrayBuffer before it.
  if (v !== null && typeof v === 'object' && (brand(abByteLength, v) || brand(sabByteLength, v)) && d.pos < d.data.length && peekTagOrNull(d) === T.arrayBufferView) {
    readTag(d);
    v = readArrayBufferView(d, v as ArrayBufferLike);
  }
  return v;
}

function peekTagOrNull(d: DesState): number | null {
  try {
    return peekTag(d);
  } catch {
    return null;
  }
}

function readObjectInternal(d: DesState): unknown {
  const tag = readTag(d);
  switch (tag) {
    case T.verifyObjectCount:
      readVarint(d);
      return readObject(d);
    case T.undefined:
      return undefined;
    case T.null:
      return null;
    case T.true:
      return true;
    case T.false:
      return false;
    case T.int32: {
      const z = readVarint(d);
      return (z >>> 1) ^ -(z & 1);
    }
    case T.uint32:
      return readVarint(d);
    case T.double:
      return readDouble(d);
    case T.bigInt:
      return readBigInt(d);
    case T.utf8String:
      return utf8Decoder.decode(readRaw(d, readVarint(d)));
    case T.oneByteString: {
      const b = readRaw(d, readVarint(d));
      return latin1(b);
    }
    case T.twoByteString: {
      const n = readVarint(d);
      if (n & 1) fail();
      return utf16(readRaw(d, n));
    }
    case T.objectReference: {
      const id = readVarint(d);
      if (!d.ids.has(id)) fail();
      return d.ids.get(id);
    }
    case T.beginJSObject: {
      const id = d.nextId++;
      const o = {};
      addId(d, id, o);
      const n = readProperties(d, o, T.endJSObject);
      if (readVarint(d) !== n) fail();
      return o;
    }
    case T.beginSparseJSArray: {
      const length = readVarint(d);
      const id = d.nextId++;
      const a: unknown[] = [];
      a.length = length;
      addId(d, id, a);
      const n = readProperties(d, a, T.endSparseJSArray);
      if (readVarint(d) !== n || readVarint(d) !== length) fail();
      return a;
    }
    case T.beginDenseJSArray: {
      const length = readVarint(d);
      if (length > d.data.length - d.pos) fail();
      const id = d.nextId++;
      const a: unknown[] = new Array(length);
      addId(d, id, a);
      for (let i = 0; i < length; i++) {
        if (peekTag(d) === T.theHole) {
          readTag(d);
          continue;
        }
        const el = readObject(d);
        if (d.version < 11 && el === undefined) continue;
        a[i] = el;
      }
      const n = readProperties(d, a, T.endDenseJSArray);
      if (readVarint(d) !== n || readVarint(d) !== length) fail();
      return a;
    }
    case T.date: {
      const t = readDouble(d);
      const date = new Date(t);
      addId(d, d.nextId++, date);
      return date;
    }
    case T.trueObject:
    case T.falseObject:
    case T.numberObject:
    case T.bigIntObject:
    case T.stringObject: {
      const id = d.nextId++;
      let w: object;
      if (tag === T.trueObject) w = Object(true);
      else if (tag === T.falseObject) w = Object(false);
      else if (tag === T.numberObject) w = Object(readDouble(d));
      else if (tag === T.bigIntObject) w = Object(readBigInt(d));
      else w = Object(readString(d));
      addId(d, id, w);
      return w;
    }
    case T.regExp: {
      const id = d.nextId++;
      const pattern = readString(d);
      const raw = readVarint(d);
      const bad = (0xffffffff << kRegExpFlagCount) | kRegExpLinear;
      if (raw & bad) fail();
      let flags = '';
      for (const [bit, ch] of RE_FLAG_CHARS) if (raw & bit) flags += ch;
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch {
        return fail();
      }
      addId(d, id, re);
      return re;
    }
    case T.beginJSMap: {
      const id = d.nextId++;
      const m = new Map();
      addId(d, id, m);
      let length = 0;
      for (;;) {
        if (peekTag(d) === T.endJSMap) {
          readTag(d);
          break;
        }
        const k = readObject(d);
        const v = readObject(d);
        call(mapSet, m, k, v);
        length += 2;
      }
      if (readVarint(d) !== length) fail();
      return m;
    }
    case T.beginJSSet: {
      const id = d.nextId++;
      const s = new Set();
      addId(d, id, s);
      let length = 0;
      for (;;) {
        if (peekTag(d) === T.endJSSet) {
          readTag(d);
          break;
        }
        call(setAdd, s, readObject(d));
        length++;
      }
      if (readVarint(d) !== length) fail();
      return s;
    }
    case T.arrayBuffer:
    case T.resizableArrayBuffer: {
      const id = d.nextId++;
      const byteLength = readVarint(d);
      let max = byteLength;
      if (tag === T.resizableArrayBuffer) {
        max = readVarint(d);
        if (byteLength > max) fail();
      }
      const bytes = readRaw(d, byteLength);
      const ab = tag === T.resizableArrayBuffer ? new (ArrayBuffer as any)(byteLength, { maxByteLength: max }) : new ArrayBuffer(byteLength);
      new Uint8Array(ab).set(bytes);
      addId(d, id, ab);
      return ab;
    }
    case T.arrayBufferTransfer: {
      const id = d.nextId++;
      const tid = readVarint(d);
      const ab = d.transfer.get(tid);
      if (!ab) fail();
      addId(d, id, ab);
      return ab;
    }
    case T.sharedArrayBuffer:
      // Node's deserializer delegate does not provide SharedArrayBuffers by id.
      d.nextId++;
      readVarint(d);
      return fail();
    case T.error:
      return readJSError(d);
    case T.hostObject:
      return readHostObject(d);
    default:
      return fail();
  }
}

function readProperties(d: DesState, o: object, endTag: number): number {
  let n = 0;
  for (;;) {
    if (peekTag(d) === endTag) {
      readTag(d);
      return n;
    }
    const key = readObject(d);
    if (typeof key !== 'string' && typeof key !== 'number') fail();
    const value = readObject(d);
    Object.defineProperty(o, key as PropertyKey, { value, writable: true, enumerable: true, configurable: true });
    n++;
  }
}

function readArrayBufferView(d: DesState, buffer: ArrayBufferLike): ArrayBufferView {
  const bufferByteLength: number = brand(abByteLength, buffer) ? call(abByteLength, buffer) : call(sabByteLength!, buffer);
  const tag = readVarint(d, 8);
  const byteOffset = readVarint(d);
  const byteLength = readVarint(d);
  if (byteOffset > bufferByteLength || byteLength > bufferByteLength - byteOffset) fail();
  let flags = 0;
  if (d.version >= 14 || d.broken13) flags = readVarint(d);
  const id = d.nextId++;
  const isLengthTracking = !!(flags & 1);
  const isBackedByRab = !!(flags & 2);
  const resizable = !!(abResizable && brand(abResizable, buffer) && call(abResizable, buffer));
  const growable = !!(sabGrowable && brand(sabGrowable, buffer) && call(sabGrowable, buffer));
  // ValidateJSArrayBufferViewFlags
  if (isBackedByRab ? !resizable : resizable) fail();
  if (isLengthTracking && !(resizable || growable)) fail();
  const C = VIEW_CTOR[tag];
  if (!C) fail();
  let view: ArrayBufferView;
  if (C === DataView) {
    view = isLengthTracking ? new DataView(buffer as ArrayBuffer, byteOffset) : new DataView(buffer as ArrayBuffer, byteOffset, byteLength);
  } else {
    const size = C.BYTES_PER_ELEMENT;
    if (byteOffset % size !== 0 || byteLength % size !== 0) fail();
    view = isLengthTracking ? new C(buffer, byteOffset) : new C(buffer, byteOffset, byteLength / size);
  }
  addId(d, id, view);
  return view;
}

function readJSError(d: DesState): Error {
  // The error exists (with its id) before its properties are read, so a cause can refer to it.
  const id = d.nextId++;
  const e = new NativeError();
  addId(d, id, e);
  let stack: string | undefined;
  const define = (k: string, value: unknown) => Object.defineProperty(e, k, { value, writable: true, enumerable: false, configurable: true });
  for (let done = false; !done; ) {
    const tag = readVarint(d, 8);
    switch (tag) {
      case E.eval:
      case E.range:
      case E.reference:
      case E.syntax:
      case E.type:
      case E.uri:
        Object.setPrototypeOf(e, ERROR_CTORS[tag].prototype);
        break;
      case E.message:
        define('message', readString(d));
        break;
      case E.stack:
        stack = readString(d);
        break;
      case E.cause:
        define('cause', readObject(d));
        break;
      case E.end:
        done = true;
        break;
      default:
        fail();
    }
  }
  define('stack', stack);
  return e;
}

function readHostObject(d: DesState): object {
  const id = d.nextId++;
  const f = d.self._readHostObject;
  if (typeof f !== 'function') return fail();
  const o = f.call(d.self);
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) throw new NativeTypeError('readHostObject must return an object');
  addId(d, id, o);
  return o;
}

// -----------------------------------------------------------------------------
// the binding classes (SerializerContext / DeserializerContext)

function constructCallRequired(name: string): never {
  throw nodeError(NativeTypeError, 'ERR_CONSTRUCT_CALL_REQUIRED', `Class constructor ${name} cannot be invoked without 'new'`);
}

const isArrayBuffer = (v: unknown) => v !== null && typeof v === 'object' && brand(abByteLength, v);
const isSharedArrayBuffer = (v: unknown) => v !== null && typeof v === 'object' && brand(sabByteLength, v);
const viewBytes = (v: ArrayBufferView) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

export const Serializer = function Serializer(this: any) {
  if (!new.target) constructCallRequired('Serializer');
  serStates.set(this, { w: new Writer(), ids: new Map(), nextId: 0, transfer: new Map(), viewsAsHost: false, self: this });
} as unknown as { new (): any; prototype: any };

Object.assign(Serializer.prototype, {
  writeHeader(this: object) {
    const w = serState(this).w;
    w.byte(T.version);
    w.varint(kLatestVersion);
  },
  writeValue(this: object, v: unknown) {
    writeObject(serState(this), v);
    return true;
  },
  releaseBuffer(this: object) {
    return asBuffer(serState(this).w.release());
  },
  transferArrayBuffer(this: object, id: unknown, ab: unknown) {
    const st = serState(this);
    const n = Number(id) >>> 0;
    if (!isArrayBuffer(ab)) throw nodeError(NativeTypeError, 'ERR_INVALID_ARG_TYPE', 'arrayBuffer must be an ArrayBuffer');
    st.transfer.set(ab as object, n);
  },
  writeUint32(this: object, v: unknown) {
    const st = serState(this);
    st.w.varint(Number(v) >>> 0);
  },
  writeUint64(this: object, hi: unknown, lo: unknown) {
    const st = serState(this);
    const h = Number(hi) >>> 0;
    const l = Number(lo) >>> 0;
    st.w.varint64((BigInt(h) << 32n) | BigInt(l));
  },
  writeDouble(this: object, v: unknown) {
    const st = serState(this);
    st.w.double(Number(v));
  },
  writeRawBytes(this: object, v: unknown) {
    const st = serState(this);
    if (!ArrayBuffer.isView(v)) throw nodeError(NativeTypeError, 'ERR_INVALID_ARG_TYPE', 'source must be a TypedArray or a DataView');
    st.w.raw(viewBytes(v));
  },
  _setTreatArrayBufferViewsAsHostObjects(this: object, v: unknown) {
    serState(this).viewsAsHost = !!v;
  },
});

export const Deserializer = function Deserializer(this: any, buffer: unknown) {
  if (!new.target) constructCallRequired('Deserializer');
  if (!ArrayBuffer.isView(buffer)) throw nodeError(NativeTypeError, 'ERR_INVALID_ARG_TYPE', 'buffer must be a TypedArray or a DataView');
  desStates.set(this, { data: viewBytes(buffer), pos: 0, version: 0, ids: new Map(), nextId: 0, transfer: new Map(), broken13: false, self: this });
  this.buffer = buffer;
} as unknown as { new (buffer: ArrayBufferView): any; prototype: any };

function versionError(): Error {
  return new NativeError('Unable to deserialize cloned data due to invalid or unsupported version.');
}

Object.assign(Deserializer.prototype, {
  readHeader(this: object) {
    const d = desState(this);
    if (d.pos < d.data.length && d.data[d.pos] === T.version) {
      d.pos++;
      try {
        d.version = readVarint(d);
      } catch {
        throw versionError();
      }
    }
    if (d.version > kLatestVersion || d.version < kMinimumVersion) throw versionError();
    return true;
  },
  readValue(this: object) {
    const d = desState(this);
    const start = d.pos;
    try {
      return readObject(d);
    } catch (e) {
      if (e !== FAIL) throw e;
    }
    // V8 once wrote broken version 13 data (crbug.com/1284506): retry reading it that way.
    if (d.version === 13) {
      d.broken13 = true;
      d.pos = start;
      try {
        return readObject(d);
      } catch (e) {
        if (e !== FAIL) throw e;
      }
    }
    throw new NativeError('Unable to deserialize cloned data.');
  },
  getWireFormatVersion(this: object) {
    return desState(this).version;
  },
  transferArrayBuffer(this: object, id: unknown, ab: unknown) {
    const d = desState(this);
    const n = Number(id) >>> 0;
    if (!isArrayBuffer(ab) && !isSharedArrayBuffer(ab)) throw nodeError(NativeTypeError, 'ERR_INVALID_ARG_TYPE', 'arrayBuffer must be an ArrayBuffer or SharedArrayBuffer');
    d.transfer.set(n, ab as ArrayBufferLike);
  },
  readUint32(this: object) {
    const d = desState(this);
    try {
      return readVarint(d);
    } catch (e) {
      if (e === FAIL) throw new NativeError('ReadUint32() failed');
      throw e;
    }
  },
  readUint64(this: object) {
    const d = desState(this);
    let v: bigint;
    try {
      v = readVarint64(d);
    } catch (e) {
      if (e === FAIL) throw new NativeError('ReadUint64() failed');
      throw e;
    }
    return [Number(v >> 32n), Number(v & 0xffffffffn)];
  },
  readDouble(this: object) {
    const d = desState(this);
    try {
      return readDouble(d);
    } catch (e) {
      if (e === FAIL) throw new NativeError('ReadDouble() failed');
      throw e;
    }
  },
  _readRawBytes(this: object, length: unknown) {
    const d = desState(this);
    const n = Math.trunc(Number(length)) || 0;
    if (n < 0 || n > d.data.length - d.pos) throw new NativeError('ReadRawBytes() failed');
    const offset = d.pos;
    d.pos += n;
    return offset;
  },
});

export function createSerdes() {
  return Object.assign(fromShape('serdes'), { Serializer, Deserializer });
}
